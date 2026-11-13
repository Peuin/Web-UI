import { createClient } from "jsr:@supabase/supabase-js@2.112.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_DRIVE_SYNC_ROOT_FOLDER_ID = "1cMsSZ66rvnFvbf4ZRsV1QcpYeOzp0Inq";

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

function toItemType(mimeType: string | null | undefined) {
  if (mimeType === "application/vnd.google-apps.folder") return "FOLDER";
  if (mimeType?.startsWith("image/")) return "IMAGE";
  if (mimeType?.startsWith("video/")) return "VIDEO";
  if (
    mimeType?.includes("document") ||
    mimeType?.includes("pdf") ||
    mimeType?.includes("text")
  ) {
    return "DOCUMENT";
  }
  return "OTHER";
}

function normalizeDriveRootFolderId(value: unknown) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === "/") return null;
  if (trimmed === "root") return "root";

  if (trimmed.includes("/")) return null;

  return trimmed;
}

function redisConfig() {
  const url = Deno.env.get("REDIS_REST_URL")?.replace(/\/+$/, "");
  const token = Deno.env.get("REDIS_REST_TOKEN");
  return url && token ? { url, token } : null;
}

async function redisCommand<T>(command: unknown[]): Promise<T | null> {
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

async function invalidateFolderListCache(
  connectionId: string,
  parentIds: Iterable<string>,
) {
  if (!redisConfig()) return;

  for (const parentId of new Set(parentIds)) {
    if (!parentId) continue;
    const indexKey = `drive:list:index:${connectionId}:${parentId}`;
    const keys = await redisCommand<string[]>(["SMEMBERS", indexKey]) ?? [];
    if (keys.length > 0) {
      await redisCommand(["DEL", ...keys]);
    }
    await redisCommand(["DEL", indexKey]);
  }
}

// Drive thumbnailLink URLs expire within hours and are only fetchable while fresh,
// so the callback copies them into private Storage. drive_items.thumbnail_url then
// holds this marker; drive-list-folder turns it into a signed URL.
const THUMBNAIL_BUCKET = "drive-thumbnails";
const THUMBNAIL_MARKER_PREFIX = `supabase-storage://${THUMBNAIL_BUCKET}/`;
const THUMBNAIL_SIZE = "s400";
const THUMBNAIL_CONCURRENCY = 5;
const THUMBNAIL_FETCH_TIMEOUT_MS = 10_000;

type ThumbnailRow = {
  drive_item_id: string;
  item_type: string;
  thumbnail_url: string | null;
  modified_time: string | null;
};

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

/**
 * Replaces fresh Drive thumbnail links with cached Storage markers. Unchanged files
 * (same modified_time, already cached) are not downloaded again. A failed download
 * keeps the Drive link so the next sync retries it.
 */
// deno-lint-ignore no-explicit-any
async function cacheThumbnails(admin: any, connectionId: string, rows: ThumbnailRow[]) {
  const candidates = rows.filter((row) =>
    (row.item_type === "IMAGE" || row.item_type === "VIDEO") && isFreshDriveThumbnail(row.thumbnail_url)
  );
  if (candidates.length === 0) return { cached: 0, reused: 0, failed: 0 };

  const existing = new Map<string, { thumbnail_url: string | null; modified_time: string | null }>();
  const ids = candidates.map((row) => row.drive_item_id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin
      .from("drive_items")
      .select("drive_item_id, thumbnail_url, modified_time")
      .eq("connection_id", connectionId)
      .in("drive_item_id", ids.slice(i, i + 200));
    if (error) throw error;
    for (const row of data ?? []) existing.set(row.drive_item_id, row);
  }

  let cached = 0, reused = 0, failed = 0;
  const toDownload: ThumbnailRow[] = [];
  for (const row of candidates) {
    const previous = existing.get(row.drive_item_id);
    if (
      previous?.thumbnail_url?.startsWith(THUMBNAIL_MARKER_PREFIX) &&
      previous.modified_time === row.modified_time
    ) {
      row.thumbnail_url = previous.thumbnail_url;
      reused += 1;
    } else {
      toDownload.push(row);
    }
  }

  for (let i = 0; i < toDownload.length; i += THUMBNAIL_CONCURRENCY) {
    await Promise.all(toDownload.slice(i, i + THUMBNAIL_CONCURRENCY).map(async (row) => {
      try {
        const source = row.thumbnail_url!.replace(/=s\d+$/, "") + `=${THUMBNAIL_SIZE}`;
        const response = await fetch(source, { signal: AbortSignal.timeout(THUMBNAIL_FETCH_TIMEOUT_MS) });
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !contentType.startsWith("image/")) {
          throw new Error(`HTTP ${response.status} ${contentType}`);
        }
        const path = `${connectionId}/${row.drive_item_id}.jpg`;
        await uploadThumbnail(admin, path, new Uint8Array(await response.arrayBuffer()), contentType);
        row.thumbnail_url = THUMBNAIL_MARKER_PREFIX + path;
        cached += 1;
      } catch (error) {
        failed += 1;
        console.error(`Thumbnail cache failed for ${row.drive_item_id}:`, error);
      }
    }));
  }
  return { cached, reused, failed };
}

type N8nDriveItem = {
  id?: unknown;
  name?: unknown;
  parents?: unknown;
  parent_drive_item_id?: unknown;
  [key: string]: unknown;
  mimeType?: unknown;
  size?: unknown;
  thumbnailLink?: unknown;
  webViewLink?: unknown;
  modifiedTime?: unknown;
};

type DriveSyncRequest = {
  action?: string;
  connection_id?: string;
  root_folder_id?: unknown;
  parent_drive_item_id?: unknown;
  sync_mode?: string;
  recursive?: boolean;
  max_folders?: number;
  items?: unknown;
};

function resolveCallbackParentId(body: DriveSyncRequest) {
  const parentFolderId = normalizeDriveRootFolderId(body.parent_drive_item_id);
  if (parentFolderId && parentFolderId !== "root") return parentFolderId;

  const rootFolderId = normalizeDriveRootFolderId(body.root_folder_id);
  if (rootFolderId && rootFolderId !== "root") return rootFolderId;

  return null;
}

async function handleN8nCallback(req: Request, body: DriveSyncRequest) {
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

  const connectionId = body.connection_id ??
    "00000000-0000-0000-0000-000000000000";
  const syncedParentId = resolveCallbackParentId(body);
  const sourceItems = Array.isArray(body.items)
    ? body.items.filter((item): item is N8nDriveItem =>
      typeof item === "object" && item !== null
    )
    : [];
  if (sourceItems.length === 0 && !syncedParentId) {
    return json({
      success: true,
      data: { received: 0, mapped: 0, upserted: 0, deleted: 0 },
      request_id: crypto.randomUUID(),
    });
  }

  const rows = sourceItems
    .filter((item) => item.id && item.name)
    .map((item) => {
      const legacyParentKey = `parent_${"drive"}_${"file"}_id`;
      const parentId = Array.isArray(item.parents) && item.parents[0]
        ? item.parents[0]
        : item.parent_drive_item_id ?? item[legacyParentKey];

      const driveItemId = String(item.id);
      const resolvedParentId = parentId ? String(parentId) : syncedParentId;

      return {
        connection_id: connectionId,
        drive_item_id: driveItemId,
        // The synced folder itself may come back in items without parents;
        // never let an item be its own parent (it creates a folder cycle).
        parent_drive_item_id: resolvedParentId === driveItemId
          ? null
          : resolvedParentId,
        name: String(item.name),
        mime_type: item.mimeType ? String(item.mimeType) : null,
        item_type: toItemType(item.mimeType ? String(item.mimeType) : null),
        size_bytes: item.size ? Number(item.size) : null,
        thumbnail_url: item.thumbnailLink ? String(item.thumbnailLink) : null,
        web_view_link: item.webViewLink ? String(item.webViewLink) : null,
        modified_time: item.modifiedTime ? String(item.modifiedTime) : null,
        sync_status: "SYNCED",
        deleted_at: null,
      };
    });

  if (sourceItems.length > 0 && rows.length === 0) {
    return json({
      success: false,
      data: {
        received: sourceItems.length,
        mapped: 0,
        upserted: 0,
        deleted: 0,
      },
      error: {
        code: "INVALID_ITEMS",
        message: "Callback items were present but none had both id and name.",
      },
      request_id: crypto.randomUUID(),
    }, 400);
  }

  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let thumbnails = { cached: 0, reused: 0, failed: 0 };
  try {
    thumbnails = await cacheThumbnails(admin, connectionId, rows);
  } catch (thumbnailError) {
    // Thumbnail caching must never fail the metadata sync.
    console.error("Thumbnail cache error:", thumbnailError);
  }

  if (rows.length > 0) {
    const { error } = await admin
      .from("drive_items")
      .upsert(rows, { onConflict: "connection_id,drive_item_id" });

    if (error) return apiError("SUPABASE_ERROR", error.message, 500);
  }

  let deletedCount = 0;
  if (syncedParentId) {
    const incomingIds = rows.map((row) => row.drive_item_id);
    let deleteQuery = admin
      .from("drive_items")
      .update({
        deleted_at: new Date().toISOString(),
        sync_status: "DELETED",
      })
      .eq("connection_id", connectionId)
      .eq("parent_drive_item_id", syncedParentId)
      .is("deleted_at", null);

    if (incomingIds.length > 0) {
      deleteQuery = deleteQuery.not(
        "drive_item_id",
        "in",
        `(${
          incomingIds.map((id) => `"${id.replaceAll('"', '""')}"`).join(",")
        })`,
      );
    }

    const { data: deletedRows, error: deleteError } = await deleteQuery
      .select("drive_item_id,item_type");

    if (deleteError) {
      return apiError("SUPABASE_ERROR", deleteError.message, 500);
    }
    deletedCount = deletedRows?.length ?? 0;

    let deletedFolderIds = (deletedRows ?? [])
      .filter((row) => row.item_type === "FOLDER")
      .map((row) => String(row.drive_item_id));
    const deletedDescendantParentIds: string[] = [];
    for (let depth = 0; deletedFolderIds.length > 0 && depth < 20; depth += 1) {
      const { data: descendantRows, error: descendantError } = await admin
        .from("drive_items")
        .update({
          deleted_at: new Date().toISOString(),
          sync_status: "DELETED",
        })
        .eq("connection_id", connectionId)
        .in("parent_drive_item_id", deletedFolderIds)
        .is("deleted_at", null)
        .select("drive_item_id,item_type,parent_drive_item_id");

      if (descendantError) {
        return apiError("SUPABASE_ERROR", descendantError.message, 500);
      }

      deletedCount += descendantRows?.length ?? 0;
      deletedDescendantParentIds.push(...deletedFolderIds);
      deletedFolderIds = (descendantRows ?? [])
        .filter((row) => row.item_type === "FOLDER")
        .map((row) => String(row.drive_item_id));
    }

    if (deletedDescendantParentIds.length > 0) {
      try {
        await invalidateFolderListCache(
          connectionId,
          deletedDescendantParentIds,
        );
      } catch (cacheError) {
        console.error(
          "Redis descendant cache invalidation failed:",
          cacheError,
        );
      }
    }
  }

  const affectedParentIds = rows
    .map((row) => row.parent_drive_item_id)
    .filter((value): value is string => typeof value === "string");
  const callbackRootFolderId = normalizeDriveRootFolderId(body.root_folder_id);
  const callbackParentFolderId = normalizeDriveRootFolderId(
    body.parent_drive_item_id,
  );
  try {
    await invalidateFolderListCache(connectionId, [
      ...affectedParentIds,
      ...(syncedParentId ? [syncedParentId] : []),
      ...(callbackRootFolderId && callbackRootFolderId !== "root"
        ? [callbackRootFolderId]
        : []),
      ...(callbackParentFolderId && callbackParentFolderId !== "root"
        ? [callbackParentFolderId]
        : []),
    ]);
  } catch (cacheError) {
    console.error("Redis cache invalidation failed:", cacheError);
  }

  const { error: connectionError } = await admin
    .from("drive_connections")
    .update({ last_sync_at: new Date().toISOString(), status: "ACTIVE" })
    .eq("id", connectionId);

  if (connectionError) {
    return apiError("SUPABASE_ERROR", connectionError.message, 500);
  }

  return json({
    success: true,
    data: {
      received: sourceItems.length,
      mapped: rows.length,
      upserted: rows.length,
      deleted: deletedCount,
      thumbnails,
      reconciled_parent_drive_item_id: syncedParentId,
    },
    request_id: crypto.randomUUID(),
  });
}

async function triggerN8nFolderSync({
  n8nWebhookUrl,
  internalSecret,
  connectionId,
  rootFolderId,
  syncMode,
  recursive,
  maxFolders,
  parentDriveItemId,
  userId,
}: {
  n8nWebhookUrl: string;
  internalSecret: string;
  connectionId: string;
  rootFolderId: string;
  syncMode: string;
  recursive: boolean;
  maxFolders?: number;
  parentDriveItemId?: string;
  userId: string;
}) {
  const response = await fetch(n8nWebhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": internalSecret,
    },
    body: JSON.stringify({
      connection_id: connectionId,
      root_folder_id: rootFolderId,
      sync_mode: syncMode,
      recursive,
      max_folders: maxFolders,
      parent_drive_item_id: parentDriveItemId,
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
  if (req.method !== "POST") {
    return apiError("INVALID_METHOD", "Use POST.", 405);
  }

  let body: DriveSyncRequest;
  try {
    body = await req.json();
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON.");
  }

  if (body.action === "upsert-items") {
    return handleN8nCallback(req, body);
  }

  // UI-triggered sync requires an authorized Supabase user.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return apiError("UNAUTHORIZED", "Missing Authorization header.", 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = readPublishableKey();
  if (!supabaseUrl || !publishableKey) {
    return apiError(
      "SERVER_NOT_CONFIGURED",
      "Missing Supabase URL or publishable key.",
      500,
    );
  }

  const supabase = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return apiError("UNAUTHORIZED", "Invalid session.", 401);
  }

  const connection_id = body.connection_id ??
    "00000000-0000-0000-0000-000000000000";
  const sync_mode = body.sync_mode ?? "FULL";
  const recursive = body.recursive === true;
  const max_folders = typeof body.max_folders === "number"
    ? body.max_folders
    : undefined;

  const { data: connection, error: connectionError } = await supabase
    .from("drive_connections")
    .select("root_folder_id")
    .eq("id", connection_id)
    .maybeSingle();

  if (connectionError) {
    return apiError("SUPABASE_ERROR", connectionError.message, 500);
  }

  const requestedRootFolderId = normalizeDriveRootFolderId(body.root_folder_id);
  const connectionRootFolderId = normalizeDriveRootFolderId(
    connection?.root_folder_id,
  );
  const envRootFolderId = normalizeDriveRootFolderId(
    Deno.env.get("DRIVE_SYNC_ROOT_FOLDER_ID"),
  );
  const requestedExplicitFolderId = requestedRootFolderId === "root"
    ? null
    : requestedRootFolderId;
  const root_folder_id = requestedExplicitFolderId ??
    (connectionRootFolderId === "root" ? null : connectionRootFolderId) ??
    (envRootFolderId === "root" ? null : envRootFolderId) ??
    requestedRootFolderId ??
    DEFAULT_DRIVE_SYNC_ROOT_FOLDER_ID;

  try {
    const n8nWebhookUrl = Deno.env.get("N8N_WEBHOOK_URL") ??
      "https://n8n.oxmode.ai/webhook-test/drive-sync";
    const internalSecret = Deno.env.get("N8N_INTERNAL_SECRET");
    if (!internalSecret) {
      return apiError(
        "SERVER_NOT_CONFIGURED",
        "N8N_INTERNAL_SECRET is required.",
        500,
      );
    }

    console.log("Triggering n8n drive sync", {
      connection_id,
      root_folder_id,
      sync_mode,
      recursive,
      max_folders,
    });

    const n8nResponse = await triggerN8nFolderSync({
      n8nWebhookUrl,
      internalSecret,
      connectionId: connection_id,
      rootFolderId: root_folder_id,
      syncMode: sync_mode,
      recursive,
      maxFolders: max_folders,
      parentDriveItemId: root_folder_id,
      userId: user.id,
    });

    return json({
      success: true,
      data: {
        sync_request_id: crypto.randomUUID(),
        status: "QUEUED",
        sync_source: "n8n",
        root_folder_id,
        recursive,
        n8n_response: n8nResponse,
      },
      request_id: crypto.randomUUID(),
    });
  } catch (error: unknown) {
    console.error("n8n Webhook Error:", error);
    return apiError(
      "N8N_UNAVAILABLE",
      error instanceof Error
        ? error.message
        : "Failed to trigger n8n drive sync workflow.",
      502,
    );
  }
});
