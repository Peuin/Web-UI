import { createClient } from "jsr:@supabase/supabase-js@2.112.4";

const FINAL_FILES_WEBHOOK_URL = "https://automation.oxmode.ai/webhook/final-files";
// Generated output root (output_config.folder_id → "02_AI_PROCESSING").
const FINAL_FILES_FOLDER_ID = "1fa_BesuUdYOlqRUnV5eVS3p9FZKfqLzh";
const FINAL_LIST_LIMIT = 1000;
const MAX_ITEMS = 5000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

type FinalItem = {
  drive_item_id: string;
  parent_drive_item_id: string | null;
  name: string;
  mime_type: string | null;
  item_type: "FOLDER" | "IMAGE" | "VIDEO" | "DOCUMENT" | "OTHER";
  size_bytes: number | null;
  thumbnail_url: string | null;
  web_view_link: string | null;
  modified_time: string;
  source_folder_id: string;
  raw_payload: Record<string, unknown>;
};

type FinalItemRow = FinalItem & {
  created_at: string;
  updated_at: string;
};

type FinalFilesRequest = {
  action?: string;
  folder_id?: string;
  folderId?: string;
  root_folder_id?: string;
  rootFolderId?: string;
  parent_drive_item_id?: string;
  from_date?: string | null;
  to_date?: string | null;
  run_id?: string;
  limit?: number;
  items?: unknown;
};

// Same cache as drive-sync: Drive thumbnailLink expires within hours, so the
// callback copies it into private Storage and stores this marker in thumbnail_url.
const THUMBNAIL_BUCKET = "drive-thumbnails";
const THUMBNAIL_MARKER_PREFIX = `supabase-storage://${THUMBNAIL_BUCKET}/`;
const THUMBNAIL_PATH_PREFIX = "final";
const THUMBNAIL_SIZE = "s400";
const THUMBNAIL_CONCURRENCY = 5;
const THUMBNAIL_FETCH_TIMEOUT_MS = 10_000;
const THUMBNAIL_SIGNED_URL_TTL = 3600;

function isFreshDriveThumbnail(url: string | null): url is string {
  if (!url) return false;
  try {
    const { hostname, pathname } = new URL(url);
    return hostname.endsWith(".googleusercontent.com") && pathname.startsWith("/drive-storage/");
  } catch {
    return false;
  }
}

// deno-lint-ignore no-explicit-any
async function uploadThumbnail(admin: any, path: string, bytes: Uint8Array, contentType: string) {
  const upload = () =>
    admin.storage.from(THUMBNAIL_BUCKET).upload(path, bytes, { contentType, upsert: true });
  let { error } = await upload();
  if (error && /bucket not found/i.test(error.message)) {
    const { error: createError } = await admin.storage.createBucket(THUMBNAIL_BUCKET, { public: false });
    if (createError && !/already exists/i.test(createError.message)) throw createError;
    ({ error } = await upload());
  }
  if (error) throw error;
}

/** Replaces fresh Drive thumbnail links with cached Storage markers; unchanged files are reused. */
// deno-lint-ignore no-explicit-any
async function cacheThumbnails(admin: any, items: FinalItem[]) {
  const candidates = items.filter((item) =>
    (item.item_type === "IMAGE" || item.item_type === "VIDEO") && isFreshDriveThumbnail(item.thumbnail_url)
  );
  if (candidates.length === 0) return { cached: 0, reused: 0, failed: 0 };

  const existing = new Map<string, { thumbnail_url: string | null; modified_time: string | null }>();
  const ids = candidates.map((item) => item.drive_item_id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin
      .from("final_items")
      .select("drive_item_id, thumbnail_url, modified_time")
      .in("drive_item_id", ids.slice(i, i + 200));
    if (error) throw error;
    for (const row of data ?? []) existing.set(row.drive_item_id, row);
  }

  let cached = 0, reused = 0, failed = 0;
  const toDownload: FinalItem[] = [];
  for (const item of candidates) {
    const previous = existing.get(item.drive_item_id);
    if (
      previous?.thumbnail_url?.startsWith(THUMBNAIL_MARKER_PREFIX) &&
      previous.modified_time && Date.parse(previous.modified_time) === Date.parse(item.modified_time)
    ) {
      item.thumbnail_url = previous.thumbnail_url;
      reused += 1;
    } else {
      toDownload.push(item);
    }
  }

  for (let i = 0; i < toDownload.length; i += THUMBNAIL_CONCURRENCY) {
    await Promise.all(toDownload.slice(i, i + THUMBNAIL_CONCURRENCY).map(async (item) => {
      try {
        const source = item.thumbnail_url!.replace(/=s\d+$/, "") + `=${THUMBNAIL_SIZE}`;
        const response = await fetch(source, { signal: AbortSignal.timeout(THUMBNAIL_FETCH_TIMEOUT_MS) });
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !contentType.startsWith("image/")) {
          throw new Error(`HTTP ${response.status} ${contentType}`);
        }
        const path = `${THUMBNAIL_PATH_PREFIX}/${item.drive_item_id}.jpg`;
        await uploadThumbnail(admin, path, new Uint8Array(await response.arrayBuffer()), contentType);
        item.thumbnail_url = THUMBNAIL_MARKER_PREFIX + path;
        cached += 1;
      } catch (error) {
        failed += 1;
        console.error(`Thumbnail cache failed for ${item.drive_item_id}:`, error);
      }
    }));
  }
  return { cached, reused, failed };
}

/** Signs cached-thumbnail markers in `field` for one response. */
async function signThumbnailField<T extends Record<string, unknown>>(
  // deno-lint-ignore no-explicit-any
  admin: any,
  items: T[],
  field: keyof T & string,
): Promise<T[]> {
  const paths = items
    .map((item) => item[field])
    .filter((url): url is string & T[typeof field] =>
      typeof url === "string" && url.startsWith(THUMBNAIL_MARKER_PREFIX)
    )
    .map((url) => url.slice(THUMBNAIL_MARKER_PREFIX.length));
  if (paths.length === 0) return items;

  const signedByPath = new Map<string, string>();
  try {
    const { data, error } = await admin.storage
      .from(THUMBNAIL_BUCKET)
      .createSignedUrls(paths, THUMBNAIL_SIGNED_URL_TTL);
    if (error) throw error;
    for (const entry of data ?? []) {
      if (entry.path && entry.signedUrl) signedByPath.set(entry.path, entry.signedUrl);
    }
  } catch (error) {
    console.error("Thumbnail signing failed:", error);
  }

  return items.map((item) => {
    const url = item[field];
    if (typeof url !== "string" || !url.startsWith(THUMBNAIL_MARKER_PREFIX)) return item;
    return { ...item, [field]: signedByPath.get(url.slice(THUMBNAIL_MARKER_PREFIX.length)) ?? null };
  });
}

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

function parseDateFilter(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function setDateFilter(
  filters: { from_date?: Date; to_date?: Date },
  key: "from_date" | "to_date",
  value: string | null,
): void {
  const parsed = parseDateFilter(value);
  if (parsed) filters[key] = parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function mimeToItemType(mimeType: string | null, fallback?: string | null): FinalItem["item_type"] {
  const normalizedFallback = fallback?.toUpperCase();
  if (["FOLDER", "IMAGE", "VIDEO", "DOCUMENT", "OTHER"].includes(normalizedFallback ?? "")) {
    return normalizedFallback as FinalItem["item_type"];
  }
  if (mimeType === "application/vnd.google-apps.folder") return "FOLDER";
  if (mimeType?.startsWith("image/")) return "IMAGE";
  if (mimeType?.startsWith("video/")) return "VIDEO";
  if (mimeType?.includes("pdf") || mimeType?.includes("text") || mimeType?.includes("document")) {
    return "DOCUMENT";
  }
  return "OTHER";
}

function extensionToMimeType(name: string): string {
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

function extractWebhookItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.map(asRecord);
  const record = asRecord(payload);
  for (const key of ["items", "files", "data"]) {
    const value = record[key];
    if (Array.isArray(value)) return value.map(asRecord);
    const nested = asRecord(value);
    if (Array.isArray(nested.items)) return nested.items.map(asRecord);
    if (Array.isArray(nested.files)) return nested.files.map(asRecord);
  }
  return [];
}

function normalizeFinalItem(item: Record<string, unknown>, sourceFolderId: string): FinalItem | null {
  const id = stringValue(
    item.drive_item_id,
    item.driveItemId,
    item.file_id,
    item.fileId,
    item.id,
  );
  const name = stringValue(item.name, item.file_name, item.filename, item.title);
  if (!id || !name) return null;

  const mimeType = stringValue(item.mime_type, item.mimeType) ?? extensionToMimeType(name);
  const modifiedTime = stringValue(
    item.modified_time,
    item.modifiedTime,
    item.updated_at,
    item.updatedAt,
    item.created_at,
    item.createdAt,
  ) ?? new Date().toISOString();

  return {
    drive_item_id: id,
    parent_drive_item_id: stringValue(
      item.parent_drive_item_id,
      item.parentDriveItemId,
      item.parent_id,
      item.parentId,
      Array.isArray(item.parents) ? item.parents[0] : undefined,
    ),
    name,
    mime_type: mimeType,
    item_type: mimeToItemType(mimeType, stringValue(item.item_type, item.itemType, item.type)),
    size_bytes: numberValue(item.size_bytes, item.sizeBytes, item.size),
    thumbnail_url: stringValue(item.thumbnail_url, item.thumbnailUrl, item.thumbnailLink, item.thumbnail_link, item.thumbnail, item.iconLink),
    web_view_link: stringValue(item.web_view_link, item.webViewLink, item.web_url, item.webUrl, item.url),
    modified_time: modifiedTime,
    source_folder_id: sourceFolderId,
    raw_payload: item,
  };
}

function runIdForItem(item: { parent_drive_item_id?: string | null; drive_item_id?: string; item_type?: string }) {
  return item.parent_drive_item_id || (item.item_type === "FOLDER" ? item.drive_item_id : "") || "";
}

function resolveSourceFolderId(body: FinalFilesRequest) {
  return stringValue(
    body.folder_id,
    body.folderId,
    body.root_folder_id,
    body.rootFolderId,
    body.parent_drive_item_id,
  ) ?? Deno.env.get("FINAL_FILES_FOLDER_ID") ?? FINAL_FILES_FOLDER_ID;
}

async function listFinalFiles({
  admin,
  sourceFolderId,
  filters,
}: {
  // deno-lint-ignore no-explicit-any
  admin: any;
  sourceFolderId: string;
  filters: {
    from_date?: Date;
    to_date?: Date;
    run_id?: string;
    limit?: number;
  };
}) {
  let query = admin
    .from("final_items")
    .select("*")
    .eq("source_folder_id", sourceFolderId)
    .neq("item_type", "FOLDER");

  if (filters.from_date) {
    query = query.gte("modified_time", filters.from_date.toISOString());
  }
  if (filters.to_date) {
    query = query.lte("modified_time", filters.to_date.toISOString());
  }
  if (filters.run_id) {
    query = query.eq("parent_drive_item_id", filters.run_id);
  }

  query = query.order("modified_time", { ascending: false, nullsFirst: false });
  if (filters.limit) {
    query = query.limit(filters.limit);
  }

  const { data: rows, error: listError } = await query;
  if (listError) throw listError;

  const files = ((rows ?? []) as FinalItemRow[]).map((item) => ({
    run_id: runIdForItem(item),
    name: item.name,
    path: item.drive_item_id,
    mime_type: item.mime_type ?? "application/octet-stream",
    size_bytes: item.size_bytes,
    created_at: item.created_at,
    updated_at: item.modified_time ?? item.updated_at,
    signed_url: item.thumbnail_url ?? item.web_view_link,
  }));

  const runsMap = new Map<string, {
    run_id: string;
    path: string;
    file_count: number;
    latest_updated_at: string;
  }>();

  for (const file of files) {
    const runId = file.run_id || sourceFolderId;
    if (!runsMap.has(runId)) {
      runsMap.set(runId, {
        run_id: runId,
        path: runId,
        file_count: 0,
        latest_updated_at: file.updated_at,
      });
    }
    const run = runsMap.get(runId)!;
    run.file_count++;
    if (new Date(file.updated_at) > new Date(run.latest_updated_at)) {
      run.latest_updated_at = file.updated_at;
    }
  }

  const runs = Array.from(runsMap.values()).sort((a, b) => {
    return new Date(b.latest_updated_at).getTime() - new Date(a.latest_updated_at).getTime();
  });

  return {
    total_files: files.length,
    total_runs: runs.length,
    runs,
    files: await signThumbnailField(admin, files, "signed_url"),
  };
}

async function handleN8nCallback(req: Request, body: FinalFilesRequest) {
  const internalSecret = Deno.env.get("N8N_INTERNAL_SECRET");
  if (
    !internalSecret || req.headers.get("X-Internal-Secret") !== internalSecret
  ) {
    return apiError("UNAUTHORIZED", "Invalid internal secret.", 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = readSecretKey();
  if (!supabaseUrl || !secretKey) {
    return apiError(
      "SERVER_NOT_CONFIGURED",
      "Missing Supabase URL or secret key.",
      500,
    );
  }

  // Production_05 lists one folder's direct children and does not echo the
  // folder ID, so each item's Drive parent is the folder it was listed from.
  const explicitFolderId = stringValue(
    body.folder_id,
    body.folderId,
    body.root_folder_id,
    body.rootFolderId,
    body.parent_drive_item_id,
  );
  const sourceFolderId = resolveSourceFolderId(body);
  const sourceItems = Array.isArray(body.items)
    ? body.items.map(asRecord)
    : extractWebhookItems(body);
  const normalizedItems = sourceItems
    .map((item) => {
      const parentId = Array.isArray(item.parents) ? stringValue(item.parents[0]) : null;
      return normalizeFinalItem(item, explicitFolderId ?? parentId ?? sourceFolderId);
    })
    .filter((item): item is FinalItem => Boolean(item))
    .slice(0, MAX_ITEMS);

  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let thumbnails = { cached: 0, reused: 0, failed: 0 };
  try {
    thumbnails = await cacheThumbnails(admin, normalizedItems);
  } catch (thumbnailError) {
    // Thumbnail caching must never fail the metadata sync.
    console.error("Thumbnail cache error:", thumbnailError);
  }

  if (normalizedItems.length > 0) {
    const { error } = await admin
      .from("final_items")
      .upsert(normalizedItems, { onConflict: "drive_item_id" });
    if (error) return apiError("SUPABASE_ERROR", error.message, 500);
  }

  // Reconcile the listed folder: drop rows Drive no longer returns.
  const parentIds = new Set(normalizedItems.map((item) => item.parent_drive_item_id));
  const reconciledFolderId = explicitFolderId ??
    (parentIds.size === 1 ? [...parentIds][0] : null);
  let removed = 0;
  if (reconciledFolderId && normalizedItems.length > 0) {
    const keepIds = normalizedItems.map((item) => `"${item.drive_item_id.replaceAll('"', '""')}"`).join(",");
    const { data: removedRows, error: removeError } = await admin
      .from("final_items")
      .delete()
      .eq("parent_drive_item_id", reconciledFolderId)
      .not("drive_item_id", "in", `(${keepIds})`)
      .select("drive_item_id");
    if (removeError) return apiError("SUPABASE_ERROR", removeError.message, 500);
    removed = removedRows?.length ?? 0;
  }

  return json({
    success: true,
    data: {
      received: sourceItems.length,
      mapped: normalizedItems.length,
      upserted: normalizedItems.length,
      removed,
      thumbnails,
      source_folder_id: reconciledFolderId ?? sourceFolderId,
    },
    request_id: crypto.randomUUID(),
  });
}

/** Direct children of one output folder, shaped like drive-list-folder items. */
async function listFinalFolder({
  admin,
  folderId,
}: {
  // deno-lint-ignore no-explicit-any
  admin: any;
  folderId: string;
}) {
  const { data: rows, error } = await admin
    .from("final_items")
    .select("*")
    .eq("parent_drive_item_id", folderId)
    .neq("drive_item_id", folderId)
    .order("item_type", { ascending: true })
    .order("modified_time", { ascending: false, nullsFirst: false })
    .limit(FINAL_LIST_LIMIT);
  if (error) throw error;

  const { data: folder, error: folderError } = await admin
    .from("final_items")
    .select("*")
    .eq("drive_item_id", folderId)
    .maybeSingle();
  if (folderError) throw folderError;

  const toDriveItem = (row: FinalItemRow & { id: string }) => ({
    id: row.id,
    connection_id: "final",
    drive_item_id: row.drive_item_id,
    parent_drive_item_id: row.parent_drive_item_id,
    name: row.name,
    mime_type: row.mime_type,
    item_type: row.item_type,
    size_bytes: row.size_bytes,
    thumbnail_url: row.thumbnail_url,
    web_view_link: row.web_view_link,
    modified_time: row.modified_time,
    created_at: row.created_at,
    updated_at: row.updated_at,
    sync_status: "SYNCED",
  });

  return {
    folder_id: folderId,
    folder: folder ? toDriveItem(folder) : null,
    items: await signThumbnailField(admin, (rows ?? []).map(toDriveItem), "thumbnail_url"),
  };
}

async function triggerN8nFinalFiles({
  n8nWebhookUrl,
  internalSecret,
  sourceFolderId,
  userId,
}: {
  n8nWebhookUrl: string;
  internalSecret: string;
  sourceFolderId: string;
  userId: string;
}) {
  const response = await fetch(n8nWebhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": internalSecret,
    },
    body: JSON.stringify({
      root_folder_id: sourceFolderId,
      folder_id: sourceFolderId,
      recursive: true,
      max_items: MAX_ITEMS,
      user_id: userId,
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `n8n returned HTTP ${response.status}: ${
        responseText || response.statusText
      }`,
    );
  }

  try {
    return responseText ? JSON.parse(responseText) : null;
  } catch {
    return responseText;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return apiError("INVALID_METHOD", "Use POST or GET.", 405);
  }

  let body: FinalFilesRequest = {};
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      return apiError("INVALID_JSON", "Request body must be valid JSON.");
    }
  }

  if (body.action === "upsert-items") {
    return handleN8nCallback(req, body);
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

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return apiError("UNAUTHORIZED", "Missing Authorization header.", 401);
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

  const filters: {
    from_date?: Date;
    to_date?: Date;
    run_id?: string;
    limit?: number;
  } = {};

  if (req.method === "POST") {
    setDateFilter(filters, "from_date", body.from_date ?? null);
    setDateFilter(filters, "to_date", body.to_date ?? null);
    filters.run_id = typeof body.run_id === "string" ? body.run_id : undefined;
    filters.limit = body.limit ? Math.min(Math.max(Number(body.limit), 1), 1000) : undefined;
  } else {
    const url = new URL(req.url);
    setDateFilter(filters, "from_date", url.searchParams.get("from_date"));
    setDateFilter(filters, "to_date", url.searchParams.get("to_date"));
    filters.run_id = url.searchParams.get("run_id") || undefined;
    filters.limit = url.searchParams.get("limit") ? Math.min(Math.max(Number(url.searchParams.get("limit")), 1), 1000) : undefined;
  }

  const sourceFolderId = resolveSourceFolderId(body);
  const webhookUrl = Deno.env.get("FINAL_FILES_WEBHOOK_URL") ?? FINAL_FILES_WEBHOOK_URL;

  // Folder browsing for the Final Output tab, backed by final_items.
  if (body.action === "list") {
    try {
      const data = await listFinalFolder({ admin, folderId: sourceFolderId });
      return json({ success: true, data, request_id: crypto.randomUUID() });
    } catch (error: unknown) {
      console.error("Final files list error:", error);
      return apiError(
        "FINAL_FILES_ERROR",
        error instanceof Error ? error.message : "Failed to list final files.",
        500,
      );
    }
  }

  if (body.action === "sync") {
    const internalSecret = Deno.env.get("N8N_INTERNAL_SECRET");
    if (!internalSecret) {
      return apiError("SERVER_NOT_CONFIGURED", "N8N_INTERNAL_SECRET is required.", 500);
    }
    try {
      const n8nResponse = await triggerN8nFinalFiles({
        n8nWebhookUrl: webhookUrl,
        internalSecret,
        sourceFolderId,
        userId: user.id,
      });
      return json({
        success: true,
        data: { status: "SUBMITTED", folder_id: sourceFolderId, n8n_response: n8nResponse },
        request_id: crypto.randomUUID(),
      });
    } catch (error: unknown) {
      console.error("Final files sync error:", error);
      return apiError(
        "N8N_UNAVAILABLE",
        error instanceof Error ? error.message : "Failed to trigger final files sync.",
        502,
      );
    }
  }

  try {
    const internalSecret = Deno.env.get("N8N_INTERNAL_SECRET");
    if (!internalSecret) {
      return apiError(
        "SERVER_NOT_CONFIGURED",
        "N8N_INTERNAL_SECRET is required.",
        500,
      );
    }

    console.log("Triggering n8n final files sync", {
      source_folder_id: sourceFolderId,
    });
    const n8nResponse = await triggerN8nFinalFiles({
      n8nWebhookUrl: webhookUrl,
      internalSecret,
      sourceFolderId,
      userId: user.id,
    });
    const data = await listFinalFiles({ admin, sourceFolderId, filters });

    return json({
      success: true,
      data: {
        ...data,
        sync_request_id: crypto.randomUUID(),
        status: "QUEUED",
        sync_source: "n8n",
        source_folder_id: sourceFolderId,
        n8n_response: n8nResponse,
      },
      request_id: crypto.randomUUID(),
    });
  } catch (error: unknown) {
    console.error("Final files error:", error);
    return apiError(
      "FINAL_FILES_ERROR",
      error instanceof Error ? error.message : "Failed to refresh final files.",
      500,
    );
  }
});
