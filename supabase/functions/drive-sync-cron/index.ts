import { createClient } from "jsr:@supabase/supabase-js@2.112.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_CONNECTION_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_DRIVE_SYNC_ROOT_FOLDER_ID = "1cMsSZ66rvnFvbf4ZRsV1QcpYeOzp0Inq";
const DEFAULT_MAX_FOLDERS_PER_RUN = 500;
const DEFAULT_SKIP_RECENT_MINUTES = 10;
const DEFAULT_CONCURRENCY = 4;

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

function readSecretKey() {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    const parsed = JSON.parse(keys) as Record<string, string>;
    return parsed.default ?? Object.values(parsed)[0];
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

function internalSecret() {
  return Deno.env.get("CRON_INTERNAL_SECRET") ??
    Deno.env.get("N8N_INTERNAL_SECRET");
}

function normalizeDriveRootFolderId(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === "/") return null;
  if (trimmed === "root") return "root";
  return trimmed.includes("/") ? null : trimmed;
}

function numberFromBodyOrEnv({
  bodyValue,
  envName,
  fallback,
  min,
  max,
}: {
  bodyValue: unknown;
  envName: string;
  fallback: number;
  min: number;
  max: number;
}) {
  const value = typeof bodyValue === "number"
    ? bodyValue
    : Number(Deno.env.get(envName) ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

type CronRequest = {
  connection_id?: string;
  max_folders?: number;
  concurrency?: number;
  skip_recent_minutes?: number;
};

type FolderCandidate = {
  connection_id: string;
  drive_item_id: string;
  name: string;
  updated_at: string | null;
  source: "root" | "folder";
};

async function triggerN8nFolderSync({
  n8nWebhookUrl,
  secret,
  folder,
}: {
  n8nWebhookUrl: string;
  secret: string;
  folder: FolderCandidate;
}) {
  const response = await fetch(n8nWebhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": secret,
    },
    body: JSON.stringify({
      connection_id: folder.connection_id,
      root_folder_id: folder.drive_item_id,
      parent_drive_item_id: folder.drive_item_id,
      sync_mode: "INCREMENTAL",
      recursive: false,
      max_folders: 1,
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

async function processInBatches<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  for (let index = 0; index < items.length; index += concurrency) {
    const batch = items.slice(index, index + concurrency);
    await Promise.all(batch.map(worker));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return apiError("INVALID_METHOD", "Use POST.", 405);
  }

  const secret = internalSecret();
  if (!secret || req.headers.get("X-Internal-Secret") !== secret) {
    return apiError("UNAUTHORIZED", "Invalid internal secret.", 401);
  }

  let body: CronRequest = {};
  try {
    body = await req.json();
  } catch {
    body = {};
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

  const maxFolders = numberFromBodyOrEnv({
    bodyValue: body.max_folders,
    envName: "DRIVE_SYNC_CRON_MAX_FOLDERS",
    fallback: DEFAULT_MAX_FOLDERS_PER_RUN,
    min: 1,
    max: 1000,
  });
  const concurrency = numberFromBodyOrEnv({
    bodyValue: body.concurrency,
    envName: "DRIVE_SYNC_CRON_CONCURRENCY",
    fallback: DEFAULT_CONCURRENCY,
    min: 1,
    max: 5,
  });
  const skipRecentMinutes = numberFromBodyOrEnv({
    bodyValue: body.skip_recent_minutes,
    envName: "DRIVE_SYNC_CRON_SKIP_RECENT_MINUTES",
    fallback: DEFAULT_SKIP_RECENT_MINUTES,
    min: 0,
    max: 120,
  });

  const connectionId = body.connection_id ?? DEFAULT_CONNECTION_ID;
  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: connection, error: connectionError } = await admin
    .from("drive_connections")
    .select("id, root_folder_id")
    .eq("id", connectionId)
    .maybeSingle();

  if (connectionError) {
    return apiError("SUPABASE_ERROR", connectionError.message, 500);
  }

  const { data: folderRows, error: folderError } = await admin
    .from("drive_items")
    .select("connection_id, drive_item_id, name, updated_at")
    .eq("connection_id", connectionId)
    .eq("item_type", "FOLDER")
    .neq("name", ".emptyFolderPlaceholder")
    .order("updated_at", { ascending: true, nullsFirst: true })
    .limit(maxFolders);

  if (folderError) {
    return apiError("SUPABASE_ERROR", folderError.message, 500);
  }

  const rootFolderId = normalizeDriveRootFolderId(connection?.root_folder_id) ??
    normalizeDriveRootFolderId(Deno.env.get("DRIVE_SYNC_ROOT_FOLDER_ID")) ??
    DEFAULT_DRIVE_SYNC_ROOT_FOLDER_ID;
  const candidates = new Map<string, FolderCandidate>();
  candidates.set(`${connectionId}:${rootFolderId}`, {
    connection_id: connectionId,
    drive_item_id: rootFolderId,
    name: "Root folder",
    updated_at: null,
    source: "root",
  });

  for (const folder of folderRows ?? []) {
    candidates.set(`${folder.connection_id}:${folder.drive_item_id}`, {
      connection_id: String(folder.connection_id),
      drive_item_id: String(folder.drive_item_id),
      name: String(folder.name),
      updated_at: folder.updated_at ? String(folder.updated_at) : null,
      source: "folder",
    });
  }

  const cutoff = Date.now() - skipRecentMinutes * 60_000;
  const considered = Array.from(candidates.values()).slice(0, maxFolders);
  const toSync = considered.filter((folder) => {
    if (folder.source === "root" || skipRecentMinutes === 0) return true;
    if (!folder.updated_at) return true;
    return new Date(folder.updated_at).getTime() < cutoff;
  });
  const errors: Array<{ drive_item_id: string; message: string }> = [];
  let syncTriggered = 0;
  const n8nWebhookUrl = Deno.env.get("N8N_WEBHOOK_URL") ??
    "https://n8n.oxmode.ai/webhook-test/drive-sync";

  await processInBatches(toSync, concurrency, async (folder) => {
    try {
      await triggerN8nFolderSync({
        n8nWebhookUrl,
        secret,
        folder,
      });
      syncTriggered += 1;
    } catch (error) {
      errors.push({
        drive_item_id: folder.drive_item_id,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  return json({
    success: errors.length === 0,
    data: {
      folders_considered: considered.length,
      skipped_recent: considered.length - toSync.length,
      sync_triggered: syncTriggered,
      failed: errors.length,
      errors,
    },
    request_id: crypto.randomUUID(),
  }, errors.length > 0 ? 207 : 200);
});
