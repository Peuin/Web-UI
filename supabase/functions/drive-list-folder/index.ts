import { createClient } from "jsr:@supabase/supabase-js@2.112.4";

const DEFAULT_BUCKET = "BAartworkShopify";
const DEFAULT_ROOT_PATH = "google-drive/01_New_Product_Raw";
const DEFAULT_DRIVE_SYNC_ROOT_FOLDER_ID = "1cMsSZ66rvnFvbf4ZRsV1QcpYeOzp0Inq";
const FOLDER_CACHE_TTL_SECONDS = 600;

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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

/** Signs cached-thumbnail markers per response; Redis keeps the unsigned markers. */
async function signThumbnails(
  // deno-lint-ignore no-explicit-any
  admin: any,
  items: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const paths = items
    .map((item) => item.thumbnail_url)
    .filter((url): url is string => typeof url === "string" && url.startsWith(THUMBNAIL_MARKER_PREFIX))
    .map((url) => url.slice(THUMBNAIL_MARKER_PREFIX.length));
  if (paths.length === 0) return items;

  const signedByPath = new Map<string, string>();
  try {
    const { data, error } = await admin.storage
      .from("drive-thumbnails")
      .createSignedUrls(paths, THUMBNAIL_SIGNED_URL_TTL);
    if (error) throw error;
    for (const entry of data ?? []) {
      if (entry.path && entry.signedUrl) signedByPath.set(entry.path, entry.signedUrl);
    }
  } catch (error) {
    console.error("Thumbnail signing failed:", error);
  }

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

async function listDriveMetadataFolder({
  admin,
  connectionId,
  folderId,
  search,
  from,
  to,
  sort,
}: {
  // deno-lint-ignore no-explicit-any
  admin: any;
  connectionId: string;
  folderId: string;
  search?: string;
  from: number;
  to: number;
  sort: string;
}) {
  let query = admin
    .from("drive_items")
    .select("*", { count: "exact" })
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

  query = query.range(from, to - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  const { data: folder, error: folderError } = await admin
    .from("drive_items")
    .select("*")
    .eq("connection_id", connectionId)
    .eq("drive_item_id", folderId)
    .is("deleted_at", null)
    .neq("sync_status", "DELETED")
    .maybeSingle();

  if (folderError) throw folderError;

  return {
    folder: folder ? exposeDriveItem(folder) : null,
    items: (data ?? []).map(exposeDriveItem),
    total: count ?? data?.length ?? 0,
  };
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
  const rows = [];

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

    let signedUrl: string | null = null;
    const isFolder = !object.id && !object.metadata;
    if (!isFolder) {
      const { data: signed } = await storage
        .from(bucket)
        .createSignedUrl(itemPath, signedUrlTtl);
      signedUrl = signed?.signedUrl ?? null;
    }

    rows.push(storageObjectToDriveItem({
      bucket,
      path: itemPath,
      object,
      signedUrl,
    }));
  }

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

  const supabase = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return apiError("UNAUTHORIZED", "Invalid session.", 401);
  }

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
          return json({
            success: true,
            data: {
              ...cached,
              items: Array.isArray(cached.items)
                ? await signThumbnails(admin, cached.items as Record<string, unknown>[])
                : cached.items,
              cache: "HIT",
            },
            request_id: crypto.randomUUID(),
          });
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
        to,
        sort,
      });

    if (
      metadata &&
      (metadata.items.length > 0 || requestedFolderId || requestedRootFolderId)
    ) {
      const responseData = {
        folder: metadata.folder,
        items: metadata.items,
        pagination: {
          page,
          page_size: pageSize,
          total: metadata.total,
          has_more: metadata.total > to,
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
          items: await signThumbnails(admin, responseData.items),
          cache,
        },
        request_id: crypto.randomUUID(),
      });
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
    });
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
