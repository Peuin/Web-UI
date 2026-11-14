import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.112.4";

const DEFAULT_BUCKET = "BAartworkShopify";
const DEFAULT_ROOT_PATH = "google-drive/01_New_Product_Raw";
const DEFAULT_DRIVE_SYNC_ROOT_FOLDER_ID = "1cMsSZ66rvnFvbf4ZRsV1QcpYeOzp0Inq";
const FOLDER_CACHE_TTL_SECONDS = 600;
// raw_payload-scale fields are excluded; the UI only needs these columns.
const DRIVE_ITEM_COLUMNS =
  "id,connection_id,drive_item_id,parent_drive_item_id,name,mime_type,item_type,size_bytes,thumbnail_url,web_view_link,modified_time,sync_status,cached_storage_path,cached_at,created_at,updated_at";
const MAX_ANCESTOR_DEPTH = 20;

type StorageObject = {
  id?: string | null;
  name: string;
  metadata?: {
    mimetype?: string | null;
    size?: number | null;
  } | null;
  created_at?: string | null;
  updated_at?: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200, timing?: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      ...(timing ? { "Server-Timing": timing } : {}),
    },
  });
}

/** Server-Timing helper: `t.mark("auth")` then `t.header()` → "auth;dur=12.3,total;dur=…". */
function createTiming() {
  const start = performance.now();
  const marks: [string, number][] = [];
  return {
    mark(name: string) {
      marks.push([name, performance.now() - start]);
    },
    header() {
      const parts = marks.map(([name, at], i) => {
        const prev = i === 0 ? 0 : marks[i - 1][1];
        return `${name};dur=${(at - prev).toFixed(1)}`;
      });
      parts.push(`total;dur=${(performance.now() - start).toFixed(1)}`);
      return parts.join(", ");
    },
  };
}

function apiError(code: string, message: string, status = 400) {
  return json({
    success: false,
    error: { code, message },
    request_id: crypto.randomUUID(),
  }, status);
}

function readPublishableKey() {
  const keys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (keys) {
    const parsed = JSON.parse(keys) as Record<string, string>;
    return parsed.default ?? Object.values(parsed)[0];
  }
  return Deno.env.get("SUPABASE_ANON_KEY");
}

function readSecretKey() {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    const parsed = JSON.parse(keys) as Record<string, string>;
    return parsed.default ?? Object.values(parsed)[0];
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

function normalizePath(path: string | null | undefined) {
  return (path ?? "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function parentPath(path: string) {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : null;
}

function basename(path: string) {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function normalizeDriveId(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "." || trimmed === "/") return null;
  return trimmed;
}

function mimeToItemType(mimeType: string | null | undefined) {
  if (mimeType?.startsWith("image/")) return "IMAGE";
  if (mimeType?.startsWith("video/")) return "VIDEO";
  if (
    mimeType?.includes("pdf") ||
    mimeType?.includes("text") ||
    mimeType?.includes("document")
  ) {
    return "DOCUMENT";
  }
  return "OTHER";
}

function extensionToMimeType(name: string) {
  const ext = name.toLowerCase().split(".").pop();
  if (["jpg", "jpeg"].includes(ext ?? "")) return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "mp4") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  if (ext === "pdf") return "application/pdf";
  if (ext === "txt") return "text/plain";
  return "application/octet-stream";
}

function storageObjectToDriveItem({
  bucket,
  path,
  object,
  signedUrl,
}: {
  bucket: string;
  path: string;
  object: StorageObject;
  signedUrl?: string | null;
}) {
  const isFolder = !object.id && !object.metadata;
  const mimeType = isFolder
    ? "application/vnd.google-apps.folder"
    : object.metadata?.mimetype ?? extensionToMimeType(object.name);
  const itemType = isFolder ? "FOLDER" : mimeToItemType(mimeType);

  return {
    id: `${bucket}:${path}`,
    connection_id: "storage",
    drive_item_id: path,
    parent_drive_item_id: parentPath(path),
    name: object.name,
    mime_type: mimeType,
    item_type: itemType,
    size_bytes: isFolder ? null : object.metadata?.size ?? null,
    thumbnail_url: itemType === "IMAGE" ? signedUrl ?? null : null,
    web_view_link: signedUrl ?? null,
    modified_time: object.updated_at ?? object.created_at ?? null,
    sync_status: "SYNCED",
    cached_storage_path: path,
    created_at: object.created_at ?? new Date().toISOString(),
    updated_at: object.updated_at ?? object.created_at ??
      new Date().toISOString(),
  };
}

function exposeDriveItem(item: Record<string, unknown>) {
  return item;
}

// Set by drive-sync when it caches a Drive thumbnail into private Storage.
const THUMBNAIL_MARKER_PREFIX = "supabase-storage://drive-thumbnails/";
const THUMBNAIL_SIGNED_URL_TTL = 3600;
// Re-serve one signed URL until this margin before expiry so the browser can
// cache the image by URL instead of refetching every list request.
const SIGNED_URL_CACHE_MARGIN_SECONDS = 300;
const signedUrlMemoryCache = new Map<string, { url: string; expiresAt: number }>();

/**
 * Signed URLs keyed by storage path, cached in Redis (or in-isolate memory) so
 * every list response returns the identical URL until it nears expiry. That
 * makes thumbnails browser-cacheable; a fresh token is only minted inside the
 * last SIGNED_URL_CACHE_MARGIN_SECONDS of the previous URL's life.
 */
async function cachedSignedUrls(
  storageClient: SupabaseClient["storage"],
  bucket: string,
  paths: string[],
  ttlSeconds: number,
): Promise<Map<string, string>> {
  const now = Date.now();
  const refreshAfter = now + SIGNED_URL_CACHE_MARGIN_SECONDS * 1000;
  const result = new Map<string, string>();
  const misses: string[] = [];

  for (const path of paths) {
    const hit = signedUrlMemoryCache.get(path);
    if (hit && hit.expiresAt > refreshAfter) {
      result.set(path, hit.url);
    } else {
      misses.push(path);
    }
  }

  if (misses.length > 0 && redisConfig()) {
    try {
      const keys = misses.map((path) => `thumb:url:${bucket}:${path}`);
      const cached = await redisCommand<(string | null)[]>(["MGET", ...keys]);
      const stillMissing: string[] = [];
      misses.forEach((path, index) => {
        // Stored as {url, expiresAt} so a hit keeps the URL's real expiry.
        let hit: { url?: unknown; expiresAt?: unknown } | null = null;
        try {
          hit = cached?.[index] ? JSON.parse(cached[index]!) : null;
        } catch {
          hit = null;
        }
        if (hit && typeof hit.url === "string" && typeof hit.expiresAt === "number" && hit.expiresAt > refreshAfter) {
          result.set(path, hit.url);
          signedUrlMemoryCache.set(path, { url: hit.url, expiresAt: hit.expiresAt });
        } else {
          stillMissing.push(path);
        }
      });
      misses.length = 0;
      misses.push(...stillMissing);
    } catch (error) {
      console.error("Redis signed-URL cache read failed:", error);
    }
  }

  if (misses.length > 0) {
    try {
      const { data, error } = await storageClient
        .from(bucket)
        .createSignedUrls(misses, ttlSeconds);
      if (error) throw error;
      const writes: Promise<unknown>[] = [];
      for (const entry of data ?? []) {
        if (!entry.path || !entry.signedUrl) continue;
        const expiresAt = now + ttlSeconds * 1000;
        result.set(entry.path, entry.signedUrl);
        signedUrlMemoryCache.set(entry.path, { url: entry.signedUrl, expiresAt });
        if (redisConfig()) {
          writes.push(redisCommand([
            "SET",
            `thumb:url:${bucket}:${entry.path}`,
            JSON.stringify({ url: entry.signedUrl, expiresAt }),
            "EX",
            ttlSeconds - SIGNED_URL_CACHE_MARGIN_SECONDS,
          ]).catch((error: unknown) => {
            console.error("Redis signed-URL cache write failed:", error);
          }));
        }
      }
      await Promise.all(writes);
    } catch (error) {
      console.error("Thumbnail signing failed:", error);
    }
  }

  return result;
}

/** Signs cached-thumbnail markers per response; Redis keeps the unsigned markers. */
async function signThumbnails(
  admin: SupabaseClient,
  items: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const paths = items
    .map((item) => item.thumbnail_url)
    .filter((url): url is string => typeof url === "string" && url.startsWith(THUMBNAIL_MARKER_PREFIX))
    .map((url) => url.slice(THUMBNAIL_MARKER_PREFIX.length));
  if (paths.length === 0) return items;

  const signedByPath = await cachedSignedUrls(
    admin.storage,
    "drive-thumbnails",
    paths,
    THUMBNAIL_SIGNED_URL_TTL,
  );

  return items.map((item) => {
    const url = item.thumbnail_url;
    if (typeof url !== "string" || !url.startsWith(THUMBNAIL_MARKER_PREFIX)) return item;
    return { ...item, thumbnail_url: signedByPath.get(url.slice(THUMBNAIL_MARKER_PREFIX.length)) ?? null };
  });
}

type CacheStatus = "HIT" | "MISS" | "DISABLED";

function redisConfig() {
  const url = Deno.env.get("REDIS_REST_URL")?.replace(/\/+$/, "");
  const token = Deno.env.get("REDIS_REST_TOKEN");
  return url && token ? { url, token } : null;
}

async function redisCommand<T>(
  command: unknown[],
): Promise<T | null> {
  const config = redisConfig();
  if (!config) return null;

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    throw new Error(`Redis command failed with HTTP ${response.status}`);
  }

  const body = await response.json();
  if (body?.error) {
    throw new Error(String(body.error));
  }
  return body?.result as T;
}

async function readFolderCache<T>(key: string): Promise<T | null> {
  if (!redisConfig()) return null;
  const value = await redisCommand<string>(["GET", key]);
  return value ? JSON.parse(value) as T : null;
}

async function writeFolderCache({
  key,
  indexKey,
  value,
}: {
  key: string;
  indexKey: string;
  value: unknown;
}) {
  if (!redisConfig()) return;
  await redisCommand([
    "SET",
    key,
    JSON.stringify(value),
    "EX",
    FOLDER_CACHE_TTL_SECONDS,
  ]);
  await redisCommand(["SADD", indexKey, key]);
  await redisCommand(["EXPIRE", indexKey, FOLDER_CACHE_TTL_SECONDS + 60]);
}

function buildFolderCacheKeys({
  connectionId,
  folderId,
  page,
  pageSize,
  sort,
  search,
}: {
  connectionId: string;
  folderId: string;
  page: number;
  pageSize: number;
  sort: string;
  search: string;
}) {
  const normalizedSearch = search.trim().toLowerCase();
  const parentKey = `drive:list:${connectionId}:${folderId}`;
  return {
    key: `${parentKey}:${page}:${pageSize}:${sort}:${normalizedSearch}`,
    indexKey: `drive:list:index:${connectionId}:${folderId}`,
  };
}

async function resolveRootFolderId({
  admin,
  connectionId,
  requestedRootFolderId,
}: {
  // deno-lint-ignore no-explicit-any
  admin: any;
  connectionId: string;
  requestedRootFolderId: string | null;
}) {
  if (requestedRootFolderId) return requestedRootFolderId;

  const { data } = await admin
    .from("drive_connections")
    .select("root_folder_id")
    .eq("id", connectionId)
    .maybeSingle();

  return normalizeDriveId(data?.root_folder_id) ??
    normalizeDriveId(Deno.env.get("DRIVE_SYNC_ROOT_FOLDER_ID")) ??
    DEFAULT_DRIVE_SYNC_ROOT_FOLDER_ID;
}

/** Fetches one extra row to derive has_more without a separate count query. */
async function listDriveMetadataFolder({
  admin,
  connectionId,
  folderId,
  search,
  from,
  limit,
  sort,
}: {
  // deno-lint-ignore no-explicit-any
  admin: any;
  connectionId: string;
  folderId: string;
  search?: string;
  from: number;
  limit: number;
  sort: string;
}) {
  let query = admin
    .from("drive_items")
    .select(DRIVE_ITEM_COLUMNS)
    .eq("connection_id", connectionId)
    .eq("parent_drive_item_id", folderId)
    .neq("drive_item_id", folderId)
    .is("deleted_at", null)
    .neq("sync_status", "DELETED")
    .neq("name", ".emptyFolderPlaceholder");

  if (search) {
    query = query.ilike("name", `%${search}%`);
  }

  query = query.order("item_type", { ascending: true });
  if (sort === "modified_asc") {
    query = query.order("modified_time", {
      ascending: true,
      nullsFirst: false,
    });
  } else if (sort === "name_asc") {
    query = query.order("name", { ascending: true });
  } else if (sort === "name_desc") {
    query = query.order("name", { ascending: false });
  } else {
    query = query.order("modified_time", {
      ascending: false,
      nullsFirst: false,
    })
      .order("name", { ascending: true });
  }

  query = query.range(from, from + limit - 1);

  // The list and the parent-folder lookup are independent — run them together.
  const [listResult, folderResult] = await Promise.all([
    query,
    admin
      .from("drive_items")
      .select(DRIVE_ITEM_COLUMNS)
      .eq("connection_id", connectionId)
      .eq("drive_item_id", folderId)
      .is("deleted_at", null)
      .neq("sync_status", "DELETED")
      .maybeSingle(),
  ]);

  if (listResult.error) throw listResult.error;
  if (folderResult.error) throw folderResult.error;

  const rows = listResult.data ?? [];
  return {
    folder: folderResult.data ? exposeDriveItem(folderResult.data) : null,
    items: rows.slice(0, limit - 1).map(exposeDriveItem),
    hasMore: rows.length >= limit,
  };
}

/** Walks parent_drive_item_id up to the root so a deep link can rebuild breadcrumbs. */
async function loadAncestors({
  admin,
  connectionId,
  folderId,
  parentId,
}: {
  // deno-lint-ignore no-explicit-any
  admin: any;
  connectionId: string;
  folderId: string;
  parentId: string | null;
}) {
  const ancestors: { drive_item_id: string; name: string }[] = [];
  const seen = new Set<string>([folderId]);
  let cursor = parentId;

  for (let depth = 0; cursor && depth < MAX_ANCESTOR_DEPTH && !seen.has(cursor); depth++) {
    seen.add(cursor);
    const { data, error } = await admin
      .from("drive_items")
      .select("drive_item_id,name,parent_drive_item_id")
      .eq("connection_id", connectionId)
      .eq("drive_item_id", cursor)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!data) break;
    ancestors.unshift({ drive_item_id: data.drive_item_id, name: data.name });
    cursor = data.parent_drive_item_id;
  }

  return ancestors;
}

async function listStoragePath({
  storage,
  bucket,
  path,
  search,
  signedUrlTtl,
}: {
  // deno-lint-ignore no-explicit-any
  storage: any;
  bucket: string;
  path: string;
  search?: string;
  signedUrlTtl: number;
}) {
  const { data, error } = await storage
    .from(bucket)
    .list(path, {
      limit: 1000,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    });

  if (error) throw error;

  const normalizedSearch = search?.toLowerCase();
  const candidates: { itemPath: string; object: StorageObject; isFolder: boolean }[] = [];

  for (const object of data ?? []) {
    const itemPath = normalizePath(
      path ? `${path}/${object.name}` : object.name,
    );
    if (
      normalizedSearch &&
      !object.name.toLowerCase().includes(normalizedSearch) &&
      !itemPath.toLowerCase().includes(normalizedSearch)
    ) {
      continue;
    }
    candidates.push({ itemPath, object, isFolder: !object.id && !object.metadata });
  }

  // One batch sign for every file; cached URLs keep the browser's image cache hot.
  const signedByPath = await cachedSignedUrls(
    storage,
    bucket,
    candidates.filter((entry) => !entry.isFolder).map((entry) => entry.itemPath),
    signedUrlTtl,
  );

  const rows = candidates.map(({ itemPath, object, isFolder }) =>
    storageObjectToDriveItem({
      bucket,
      path: itemPath,
      object,
      signedUrl: isFolder ? null : signedByPath.get(itemPath) ?? null,
    })
  );

  rows.sort((a, b) => {
    if (a.item_type === "FOLDER" && b.item_type !== "FOLDER") return -1;
    if (a.item_type !== "FOLDER" && b.item_type === "FOLDER") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return rows;
}

async function listStoragePathRecursive({
  storage,
  bucket,
  rootPath,
  search,
  signedUrlTtl,
}: {
  // deno-lint-ignore no-explicit-any
  storage: any;
  bucket: string;
  rootPath: string;
  search?: string;
  signedUrlTtl: number;
}) {
  const queue = [{ path: rootPath, depth: 0, treePath: [] as string[] }];
  const rows = [];
  const seen = new Set<string>();

  while (queue.length > 0 && seen.size < 2000) {
    const current = queue.shift()!;
    if (seen.has(current.path)) continue;
    seen.add(current.path);

    const children = await listStoragePath({
      storage,
      bucket,
      path: current.path,
      search,
      signedUrlTtl,
    });

    for (const child of children) {
      const childTreePath = [...current.treePath, child.name];
      rows.push({
        ...child,
        tree_depth: current.depth,
        tree_path: childTreePath,
      });

      if (child.item_type === "FOLDER") {
        queue.push({
          path: child.drive_item_id,
          depth: current.depth + 1,
          treePath: childTreePath,
        });
      }
    }
  }

  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return apiError("INVALID_METHOD", "Use GET or POST.", 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return apiError("UNAUTHORIZED", "Missing Authorization header.", 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = readPublishableKey();
  const secretKey = readSecretKey();
  if (!supabaseUrl || !publishableKey || !secretKey) {
    return apiError(
      "SERVER_NOT_CONFIGURED",
      "Missing Supabase URL, publishable key, or secret key.",
      500,
    );
  }

  const timing = createTiming();
  const supabase = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify the JWT locally via JWKS; fall back to an Auth round-trip when the
  // project can't do claims verification (e.g. legacy HS256 without JWKS).
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  let user: { id: string } | null = null;
  try {
    const { data, error } = await supabase.auth.getClaims(jwt);
    if (!error && data?.claims?.sub) user = { id: String(data.claims.sub) };
  } catch {
    // getClaims not usable in this environment; getUser below decides.
  }
  if (!user) {
    const { data: { user: fetched }, error: authError } = await supabase.auth.getUser();
    if (authError || !fetched) {
      return apiError("UNAUTHORIZED", "Invalid session.", 401);
    }
    user = fetched;
  }
  timing.mark("auth");

  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      body = {};
    }
  }

  const paramValue = (name: string) => {
    const queryValue = url.searchParams.get(name);
    if (queryValue !== null) return queryValue;
    const bodyValue = body[name];
    return typeof bodyValue === "string" ? bodyValue : null;
  };

  const bucket = Deno.env.get("DRIVE_STORAGE_BUCKET") ?? DEFAULT_BUCKET;
  const rootPath = normalizePath(
    Deno.env.get("DRIVE_STORAGE_ROOT_PATH") ?? DEFAULT_ROOT_PATH,
  );
  const connectionId = paramValue("connection_id") ??
    "00000000-0000-0000-0000-000000000000";
  const requestedFolderId = normalizeDriveId(paramValue("folder_id")) ??
    normalizeDriveId(paramValue("parent_drive_item_id"));
  const requestedRootFolderId = normalizeDriveId(paramValue("root_folder_id"));
  const requestedStoragePath = normalizePath(paramValue("storage_path"));
  const recursive = url.searchParams.get("recursive") === "true" ||
    body.recursive === true;
  const withAncestors = url.searchParams.get("ancestors") === "true" ||
    body.ancestors === true;
  const search = url.searchParams.get("search")?.trim();
  const sort = url.searchParams.get("sort")?.trim() || "modified_desc";
  const page = Math.max(Number(url.searchParams.get("page") ?? "1"), 1);
  const pageSize = Math.min(
    Math.max(Number(url.searchParams.get("page_size") ?? "200"), 1),
    500,
  );
  const signedUrlTtl = Math.min(
    Math.max(Number(Deno.env.get("DRIVE_STORAGE_SIGNED_URL_TTL") ?? "600"), 60),
    3600,
  );
  const from = (page - 1) * pageSize;
  const to = from + pageSize;

  try {
    const folderId = requestedStoragePath || await resolveRootFolderId({
      admin,
      connectionId,
      requestedRootFolderId: requestedFolderId ?? requestedRootFolderId,
    });
    const cacheKeys = buildFolderCacheKeys({
      connectionId,
      folderId,
      page,
      pageSize,
      sort,
      search: search ?? "",
    });

    let cache: CacheStatus = redisConfig() ? "MISS" : "DISABLED";
    if (cache !== "DISABLED") {
      try {
        const cached = await readFolderCache<Record<string, unknown>>(cacheKeys.key);
        if (cached) {
          timing.mark("cache");
          const signedCached = Array.isArray(cached.items)
            ? await signThumbnails(admin, cached.items as Record<string, unknown>[])
            : cached.items;
          timing.mark("sign");
          return json({
            success: true,
            data: {
              ...cached,
              items: signedCached,
              cache: "HIT",
            },
            request_id: crypto.randomUUID(),
          }, 200, timing.header());
        }
      } catch (error) {
        console.error("Redis cache read failed:", error);
        cache = "DISABLED";
      }
    }

    const metadata = requestedStoragePath
      ? null
      : await listDriveMetadataFolder({
        admin,
        connectionId,
        folderId,
        search,
        from,
        limit: pageSize + 1,
        sort,
      });
    timing.mark("db");

    if (
      metadata &&
      (metadata.items.length > 0 || requestedFolderId || requestedRootFolderId)
    ) {
      const ancestors = withAncestors && metadata.folder
        ? await loadAncestors({
          admin,
          connectionId,
          folderId,
          parentId: metadata.folder.parent_drive_item_id as string | null,
        })
        : undefined;
      const responseData = {
        folder: metadata.folder,
        items: metadata.items,
        ancestors,
        pagination: {
          page,
          page_size: pageSize,
          total: null,
          has_more: metadata.hasMore,
        },
      };

      if (cache !== "DISABLED") {
        try {
          await writeFolderCache({
            key: cacheKeys.key,
            indexKey: cacheKeys.indexKey,
            value: responseData,
          });
        } catch (error) {
          console.error("Redis cache write failed:", error);
          cache = "DISABLED";
        }
      }

      const signedItems = await signThumbnails(admin, responseData.items);
      timing.mark("sign");
      return json({
        success: true,
        data: {
          ...responseData,
          items: signedItems,
          cache,
        },
        request_id: crypto.randomUUID(),
      }, 200, timing.header());
    }

    const storageFolderId = requestedStoragePath ||
      normalizePath(requestedFolderId) || rootPath;
    const items = recursive
      ? await listStoragePathRecursive({
        storage: admin.storage,
        bucket,
        rootPath: storageFolderId,
        search,
        signedUrlTtl,
      })
      : await listStoragePath({
        storage: admin.storage,
        bucket,
        path: storageFolderId,
        search,
        signedUrlTtl,
      });

    timing.mark("storage");
    const pageItems = items.slice(from, to);
    const folder = storageFolderId === rootPath ? null : {
      id: `${bucket}:${storageFolderId}`,
      connection_id: "storage",
      drive_item_id: storageFolderId,
      parent_drive_item_id: parentPath(storageFolderId),
      name: basename(storageFolderId),
      mime_type: "application/vnd.google-apps.folder",
      item_type: "FOLDER",
      size_bytes: null,
      thumbnail_url: null,
      web_view_link: null,
      modified_time: null,
      sync_status: "SYNCED",
      cached_storage_path: storageFolderId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const responseData = {
      folder,
      items: pageItems.map(exposeDriveItem),
      // Storage paths are self-describing: ancestors are just the path segments.
      ancestors: withAncestors
        ? normalizePath(storageFolderId).split("/").filter(Boolean)
          .slice(0, -1)
          .map((_, index, segments) => ({
            drive_item_id: segments.slice(0, index + 1).join("/"),
            name: segments[index],
          }))
        : undefined,
      pagination: {
        page,
        page_size: pageSize,
        total: items.length,
        has_more: items.length > to,
      },
    };

    if (cache !== "DISABLED") {
      try {
        await writeFolderCache({
          key: cacheKeys.key,
          indexKey: cacheKeys.indexKey,
          value: responseData,
        });
      } catch (error) {
        console.error("Redis cache write failed:", error);
        cache = "DISABLED";
      }
    }

    return json({
      success: true,
      data: {
        ...responseData,
        cache,
      },
      request_id: crypto.randomUUID(),
    }, 200, timing.header());
  } catch (error: unknown) {
    console.error("Storage Error:", error);
    return apiError(
      "STORAGE_ERROR",
      error instanceof Error
        ? error.message
        : "Failed to list Supabase Storage folder.",
      500,
    );
  }
});
