import { createClient } from "jsr:@supabase/supabase-js@2.112.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// n8n_run.status → Web UI WorkflowStatus
const RUN_STATUS_MAP: Record<string, string> = {
  queued_scan: "QUEUED",
  scanning: "PROCESSING",
  ready: "QUEUED",
  processing: "PROCESSING",
  completed: "COMPLETED",
  skipped: "CANCELLED",
  failed: "FAILED",
  partial_failed: "FAILED",
  canceled: "CANCELLED",
};
const RETRYABLE_STATUSES = new Set(["failed", "partial_failed"]);
const BATCH_LIST_LIMIT = 30;
const MAX_FILES_PER_FOLDER = 50;

type BatchRow = {
  id: string;
  status: string;
  root_drive_folder_id: string | null;
  product_type: string | null;
  selected_name: string | null;
  selected_type: string | null;
  retry_of_batch_id: string | null;
  retry_of_batch_id_body: string | null;
  n8n_execution_id: string | null;
  error_json: Record<string, unknown> | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string | null;
};

type FolderRunRow = {
  id: string;
  batch_id: string;
  status: string;
  depth: number | null;
  source_path: string | null;
  source_drive_folder_id: string;
  parent_drive_folder_id: string | null;
  source_name: string | null;
  direct_image_count: string | null;
  direct_child_folder_count: string | null;
  direct_image_ids: unknown;
  attempt: number | null;
  worker_execution_id: string | null;
  error_json: Record<string, unknown> | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
};

type RetryInfoRow = {
  job_id: string;
  retry_action: string | null;
  retry_count: number | null;
  last_retry_status: string | null;
  last_retry_at: string | null;
  last_retry_error: Record<string, unknown> | null;
  last_retry_request_id: string | null;
  retry_mode: string | null;
  completed_via: string | null;
};

const ACTIVE_RETRY_STATUSES = new Set(["queued", "processing"]);

function errorMessageFrom(errorJson: Record<string, unknown> | null): string | null {
  if (!errorJson) return null;
  const message = errorJson.message ?? errorJson.error ?? errorJson.reason;
  return typeof message === "string" ? message : JSON.stringify(errorJson);
}

function toIntOrNull(value: string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// deno-lint-ignore no-explicit-any
function adminClient(supabaseUrl: string, secretKey: string): any {
  return createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Batches (one per Web UI submission) with their folder scan tree from n8n_run.
 * Folders link to their parent through parent_drive_folder_id within a batch.
 */
async function listRunJobs(supabaseUrl: string, secretKey: string) {
  const admin = adminClient(supabaseUrl, secretKey);
  const { data: batchData, error: batchError } = await admin
    .from("n8n_run")
    .select(
      "id, status, root_drive_folder_id, product_type:input_json->>product_type, selected_name:input_json->body->selected_drive_item->>name, selected_type:input_json->body->selected_drive_item->>item_type, retry_of_batch_id:input_json->>retry_of_batch_id, retry_of_batch_id_body:input_json->body->>retry_of_batch_id, n8n_execution_id, error_json, started_at, finished_at, created_at, updated_at",
    )
    .eq("kind", "batch")
    .order("created_at", { ascending: false })
    .limit(BATCH_LIST_LIMIT);
  if (batchError) throw batchError;
  // Batches created by the old retry (re-submit to Production_01) are hidden: SKU retry
  // now updates the original folder row instead of creating a batch.
  const batches = ((batchData ?? []) as BatchRow[]).filter((batch) =>
    !batch.retry_of_batch_id && !batch.retry_of_batch_id_body
  );
  if (batches.length === 0) return [];

  const { data: folderData, error: folderError } = await admin
    .from("n8n_run")
    .select(
      "id, batch_id, status, depth, source_path, source_drive_folder_id, parent_drive_folder_id, source_name:result_json->>source_name, direct_image_count:result_json->>direct_image_count, direct_child_folder_count:result_json->>direct_child_folder_count, direct_image_ids:result_json->direct_image_ids, attempt, worker_execution_id, error_json, started_at, finished_at, updated_at",
    )
    .eq("kind", "folder")
    .in("batch_id", batches.map((batch) => batch.id))
    .order("depth", { ascending: true })
    .order("source_path", { ascending: true });
  if (folderError) throw folderError;
  const folders = (folderData ?? []) as FolderRunRow[];

  // retry_action and SKU retry metadata live on folder_processing (job_id = n8n_run.id).
  const retryInfo = new Map<string, RetryInfoRow>();
  if (folders.length > 0) {
    const { data: processingData, error: processingError } = await admin
      .from("folder_processing")
      .select(
        "job_id, retry_action, retry_count, last_retry_status, last_retry_at, last_retry_error, last_retry_request_id, retry_mode, completed_via",
      )
      .in("job_id", folders.map((folder) => folder.id));
    if (processingError) throw processingError;
    for (const row of (processingData ?? []) as RetryInfoRow[]) {
      retryInfo.set(row.job_id, row);
    }
  }

  // Resolve image file names from synced Drive metadata (n8n stores IDs only).
  const imageIdsByRun = new Map<string, string[]>();
  for (const folder of folders) {
    const ids = Array.isArray(folder.direct_image_ids)
      ? (folder.direct_image_ids as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
    imageIdsByRun.set(folder.id, ids.slice(0, MAX_FILES_PER_FOLDER));
  }
  const allImageIds = [...new Set([...imageIdsByRun.values()].flat())];
  const fileNames = new Map<string, string>();
  for (let i = 0; i < allImageIds.length; i += 200) {
    const { data: fileData, error: fileError } = await admin
      .from("drive_items")
      .select("drive_item_id, name")
      .in("drive_item_id", allImageIds.slice(i, i + 200));
    if (fileError) throw fileError;
    for (const row of (fileData ?? []) as { drive_item_id: string; name: string }[]) {
      fileNames.set(row.drive_item_id, row.name);
    }
  }

  const foldersByBatch = new Map<string, FolderRunRow[]>();
  for (const folder of folders) {
    const list = foldersByBatch.get(folder.batch_id) ?? [];
    list.push(folder);
    foldersByBatch.set(folder.batch_id, list);
  }

  return batches.map((batch) => {
    const batchFolders = foldersByBatch.get(batch.id) ?? [];
    const runIdByDriveId = new Map(batchFolders.map((folder) => [folder.source_drive_folder_id, folder.id]));
    const finished = batchFolders.filter((folder) =>
      ["completed", "skipped", "failed", "canceled"].includes(folder.status)
    ).length;
    const status = RUN_STATUS_MAP[batch.status] ?? "QUEUED";
    const progress = status === "COMPLETED"
      ? 100
      : batchFolders.length > 0
      ? Math.round((finished / batchFolders.length) * 100)
      : 0;
    const rootName = batchFolders.find((folder) => (folder.depth ?? 0) === 0)?.source_name ?? null;

    const job = {
      id: batch.id,
      workflow_type: "media_generation",
      status,
      raw_status: batch.status,
      progress,
      product_type: batch.product_type,
      source_name: rootName,
      selected_name: batch.selected_name,
      selected_type: batch.selected_type,
      root_drive_folder_id: batch.root_drive_folder_id,
      can_retry: RETRYABLE_STATUSES.has(batch.status),
      error_message: errorMessageFrom(batch.error_json),
      n8n_execution_id: batch.n8n_execution_id,
      created_by: null,
      created_at: batch.created_at,
      started_at: batch.started_at,
      completed_at: batch.finished_at,
      updated_at: batch.updated_at,
      folders: batchFolders.map((folder) => {
        const retry = retryInfo.get(folder.id);
        const retryActive = ACTIVE_RETRY_STATUSES.has(retry?.last_retry_status ?? "");
        return {
        run_id: folder.id,
        parent_run_id: folder.parent_drive_folder_id
          ? runIdByDriveId.get(folder.parent_drive_folder_id) ?? null
          : null,
        depth: folder.depth ?? 0,
        name: folder.source_name ?? folder.source_path ?? folder.source_drive_folder_id,
        source_path: folder.source_path,
        drive_folder_id: folder.source_drive_folder_id,
        status: RUN_STATUS_MAP[folder.status] ?? "QUEUED",
        raw_status: folder.status,
        image_count: toIntOrNull(folder.direct_image_count),
        child_folder_count: toIntOrNull(folder.direct_child_folder_count),
        files: (imageIdsByRun.get(folder.id) ?? []).map((id) => ({ id, name: fileNames.get(id) ?? null })),
        attempt: folder.attempt,
        retry_action: retry?.retry_action ?? null,
        retry_count: retry?.retry_count ?? 0,
        last_retry_status: retry?.last_retry_status ?? null,
        last_retry_at: retry?.last_retry_at ?? null,
        last_retry_error: errorMessageFrom(retry?.last_retry_error ?? null),
        last_retry_request_id: retry?.last_retry_request_id ?? null,
        retry_mode: retry?.retry_mode ?? null,
        completed_via: retry?.completed_via ?? null,
        // Only SKU jobs (folder_processing rows) go through workflow-jobs-retry.
        can_retry: Boolean(retry) && !retryActive && RETRYABLE_STATUSES.has(folder.status),
        error_message: errorMessageFrom(folder.error_json),
        worker_execution_id: folder.worker_execution_id,
        started_at: folder.started_at,
        finished_at: folder.finished_at,
        updated_at: folder.updated_at,
      };
      }),
    };
    // Batch Retry = Retry All of its retryable SKU folders.
    job.can_retry = job.can_retry && job.folders.some((folder) => folder.can_retry);
    return job;
  });
}

function isHiddenDrivePlaceholder(name: string | undefined): boolean {
  return name === ".emptyFolderPlaceholder";
}

function isValidStoragePrefix(value: string): boolean {
  // Reject if it contains URL patterns or corruption markers
  const invalidPatterns = [
    "](http",
    "http://",
    "https://",
    "?token=",
    "selected_items",
    "parameters",
  ];
  return !invalidPatterns.some((pattern) => value.includes(pattern));
}

const MAX_SAMPLE_PROMPT_LENGTH = 8000;
const MAX_TEXT_URL_LENGTH = 2048;

/** Reference images must be direct, publicly readable HTTPS image URLs. */
function referenceUrlError(field: string, value: string | null): string | null {
  if (!value) return null;
  if (value.length > MAX_TEXT_URL_LENGTH) {
    return `${field} must be at most ${MAX_TEXT_URL_LENGTH} characters`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${field} must be a valid URL`;
  }
  if (url.protocol !== "https:") return `${field} must be a public HTTPS URL`;
  const isDriveDirectLink = url.hostname === "drive.google.com" && url.pathname === "/uc" &&
    url.searchParams.has("id");
  if (/(^|\.)(drive|docs)\.google\.com$/.test(url.hostname) && !isDriveDirectLink) {
    return `${field} must point directly to an image, not a Google Drive preview link`;
  }
  return null;
}

function looksLikeDriveId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{10,}$/.test(value);
}

/**
 * Workflow 01 scans a Drive *folder*. Contract priority:
 * selected_item.drive_item_id → selected_item.web_view_link → root_folder_id.
 * A selected file is mapped to its parent folder.
 */
function resolveSourceFolder(body: WorkflowPayload): {
  drive_item_id?: string;
  web_view_link?: string;
} | null {
  const item = body.selected_item;
  if (item) {
    const isFolder = item.item_type === "FOLDER";
    const folderId = isFolder ? item.drive_item_id : item.parent_drive_item_id;
    if (looksLikeDriveId(folderId)) return { drive_item_id: folderId };
    if (isFolder && item.web_view_link) return { web_view_link: item.web_view_link };
  }
  if (looksLikeDriveId(body.root_folder_id)) return { drive_item_id: body.root_folder_id };
  return null;
}

function stripMarkdownLink(value: string | null | undefined): string | null {
  if (!value) return null;
  // Convert [label](url) to url
  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/;
  const match = value.match(markdownLinkRegex);
  if (match) {
    return match[2]; // Return the URL part
  }
  return value;
}

type WorkflowParameters = {
  product_type?: string;
  product_description?: string;
  sample_prompt?: string;
  /** Legacy input key accepted for existing clients. */
  product_attributes?: string;
  source_storage_prefix?: string;
  model_reference_url?: string | null;
  style_reference_url?: string | null;
  output_type?: string;
  image_count?: number;
  video_seconds?: number;
  aspect_ratio?: string;
  video_resolution?: string;
  formMode?: string;
};

type DriveItem = {
  drive_item_id?: string;
  parent_drive_item_id?: string | null;
  item_type?: string;
  name?: string;
  web_view_link?: string | null;
  [key: string]: unknown;
};

type WorkflowPayload = {
  workflow_type?: string;
  workflow_id?: string;
  connection_id?: string;
  root_folder_id?: string;
  selected_item?: DriveItem;
  selected_items?: DriveItem[];
  parameters?: WorkflowParameters;
};

function validatePayload(
  body: WorkflowPayload,
): { valid: boolean; error?: string } {
  if (!body) {
    return { valid: false, error: "Request body is required" };
  }

  // Check for specific corruption patterns in source_storage_prefix
  if (body.parameters?.source_storage_prefix) {
    if (!isValidStoragePrefix(body.parameters.source_storage_prefix)) {
      return {
        valid: false,
        error: "source_storage_prefix appears to be corrupted with URL data",
      };
    }
  }

  if (body.workflow_type !== "media_generation") {
    return { valid: false, error: "workflow_type must be 'media_generation'" };
  }

  if (body.workflow_id !== "vcxyqTKCJW29xmWQ") {
    return { valid: false, error: "Invalid workflow_id" };
  }

  if (!body.connection_id || typeof body.connection_id !== "string") {
    return { valid: false, error: "connection_id is required" };
  }

  if (!body.root_folder_id || typeof body.root_folder_id !== "string") {
    return { valid: false, error: "root_folder_id is required" };
  }

  if (!body.selected_item || typeof body.selected_item !== "object") {
    return { valid: false, error: "selected_item is required" };
  }

  if (!Array.isArray(body.selected_items)) {
    return { valid: false, error: "selected_items must be an array" };
  }

  if (body.selected_items.length === 0 && body.selected_item.item_type !== "FOLDER") {
    return { valid: false, error: "selected_items must be a non-empty array when a file is selected" };
  }

  // Check for folders in selected_items
  for (const item of body.selected_items) {
    if (item.item_type === "FOLDER") {
      return { valid: false, error: "selected_items must not include folders" };
    }
    if (isHiddenDrivePlaceholder(item.name)) {
      return {
        valid: false,
        error: "selected_items must not include placeholder files",
      };
    }
    // Sanitize web_view_link to remove Markdown
    if (item.web_view_link) {
      item.web_view_link = stripMarkdownLink(item.web_view_link);
    }
  }

  // Sanitize selected_item.web_view_link
  if (body.selected_item?.web_view_link) {
    body.selected_item.web_view_link = stripMarkdownLink(
      body.selected_item.web_view_link,
    );
  }

  // Validate parameters
  if (!body.parameters || typeof body.parameters !== "object") {
    return { valid: false, error: "parameters is required" };
  }

  if (typeof body.parameters.product_type === "string") {
    body.parameters.product_type = body.parameters.product_type.trim().toLowerCase();
  }
  const validProductTypes = ["hat", "shawl", "umbrella", "cape"];
  if (
    !body.parameters.product_type ||
    !validProductTypes.includes(body.parameters.product_type)
  ) {
    return {
      valid: false,
      error: "product_type must be one of: hat, shawl, umbrella, cape",
    };
  }

  if (
    typeof body.parameters.source_storage_prefix !== "string" ||
    !body.parameters.source_storage_prefix.trim()
  ) {
    return { valid: false, error: "source_storage_prefix is required" };
  }

  if (!isValidStoragePrefix(body.parameters.source_storage_prefix)) {
    return {
      valid: false,
      error: "source_storage_prefix appears to be corrupted with URL data",
    };
  }

  if (body.parameters.source_storage_prefix.length > MAX_TEXT_URL_LENGTH) {
    return {
      valid: false,
      error: `source_storage_prefix must be at most ${MAX_TEXT_URL_LENGTH} characters`,
    };
  }

  const samplePrompt = body.parameters.sample_prompt ?? body.parameters.product_attributes ?? "";
  if (samplePrompt.length > MAX_SAMPLE_PROMPT_LENGTH) {
    return {
      valid: false,
      error: `sample_prompt must be at most ${MAX_SAMPLE_PROMPT_LENGTH} characters`,
    };
  }

  // Normalize optional reference URLs (strip Markdown, empty → "")
  body.parameters.model_reference_url =
    stripMarkdownLink(body.parameters.model_reference_url?.trim()) ?? "";
  body.parameters.style_reference_url =
    stripMarkdownLink(body.parameters.style_reference_url?.trim()) ?? "";
  const urlError =
    referenceUrlError("model_reference_url", body.parameters.model_reference_url) ??
    referenceUrlError("style_reference_url", body.parameters.style_reference_url);
  if (urlError) return { valid: false, error: urlError };

  if (!resolveSourceFolder(body)) {
    return {
      valid: false,
      error: "A Google Drive source folder is required (selected_item or root_folder_id)",
    };
  }

  const validOutputTypes = ["image", "video", "both"];
  body.parameters.output_type = (body.parameters.output_type ?? "both").trim().toLowerCase();
  if (!validOutputTypes.includes(body.parameters.output_type)) {
    return { valid: false, error: "output_type must be image, video, or both" };
  }

  const validImageCounts = [2, 3, 4];
  if (!validImageCounts.includes(body.parameters.image_count ?? 0)) {
    return { valid: false, error: "image_count must be 2, 3, or 4" };
  }

  const validVideoSeconds = [5, 8, 10];
  if (!validVideoSeconds.includes(body.parameters.video_seconds ?? 0)) {
    return { valid: false, error: "video_seconds must be 5, 8, or 10" };
  }

  const validAspectRatios = ["9:16", "1:1", "16:9"];
  if (!validAspectRatios.includes(body.parameters.aspect_ratio ?? "")) {
    return {
      valid: false,
      error: "aspect_ratio must be one of: 9:16, 1:1, 16:9",
    };
  }

  const validVideoResolutions = ["480p", "720p"];
  if (!validVideoResolutions.includes(body.parameters.video_resolution ?? "")) {
    return { valid: false, error: "video_resolution must be 480p or 720p" };
  }

  return { valid: true };
}

function buildN8nPayload(body: WorkflowPayload): Record<string, unknown> {
  const params = body.parameters ?? {};
  const samplePrompt = params.sample_prompt ?? params.product_attributes ?? "";
  const sourceFolder = resolveSourceFolder(body)!;

  // Flat JSON object per the Web UI → n8n contract (Production_01 webhook).
  const n8nPayload: Record<string, unknown> = {
    selected_item: sourceFolder,
    root_folder_id: body.root_folder_id,
    source_storage_prefix: params.source_storage_prefix,
    product_type: params.product_type,
    product_description: params.product_description ?? "",
    sample_prompt: samplePrompt,
    output_type: params.output_type ?? "both",
    image_count: params.image_count,
    video_seconds: params.video_seconds,
    aspect_ratio: params.aspect_ratio,
    video_resolution: params.video_resolution,
    // Context for traceability; the workflow ignores unknown keys.
    connection_id: body.connection_id,
    selected_drive_item: body.selected_item,
    submitted_at: new Date().toISOString(),
  };
  // Omit reference URLs when unused, as the contract asks.
  if (params.model_reference_url) n8nPayload.model_reference_url = params.model_reference_url;
  if (params.style_reference_url) n8nPayload.style_reference_url = params.style_reference_url;
  return n8nPayload;
}

async function postToN8n(
  n8nPayload: Record<string, unknown>,
  internalSecret: string,
): Promise<{ success: boolean; response?: unknown; error?: string }> {
  const n8nWebhookUrl = Deno.env.get("N8N_WORKFLOW_JOBS_WEBHOOK_URL") ??
    "https://automation.oxmode.ai/webhook/workflow-jobs";

  try {
    const response = await fetch(n8nWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": internalSecret,
      },
      body: JSON.stringify(n8nPayload),
    });

    const responseText = await response.text();
    if (!response.ok) {
      return {
        success: false,
        error: `n8n returned HTTP ${response.status}: ${
          responseText || response.statusText
        }`,
      };
    }

    let responseData;
    try {
      responseData = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseData = responseText;
    }

    return { success: true, response: responseData };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error
        ? error.message
        : "Failed to call n8n webhook",
    };
  }
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
  if (!supabaseUrl || !publishableKey) {
    return apiError(
      "SERVER_NOT_CONFIGURED",
      "Missing Supabase URL or publishable key.",
      500,
    );
  }

  const supabase = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return apiError("UNAUTHORIZED", "Invalid session.", 401);
  }

  if (req.method === "GET") {
    const secretKey = readSecretKey();
    if (!secretKey) {
      return apiError("SERVER_NOT_CONFIGURED", "Missing Supabase secret key.", 500);
    }
    try {
      const jobs = await listRunJobs(supabaseUrl, secretKey);
      return json({ success: true, data: { jobs }, request_id: crypto.randomUUID() });
    } catch (error: unknown) {
      console.error("workflow-jobs list error:", error);
      return apiError(
        "SUPABASE_ERROR",
        error instanceof Error ? error.message : "Failed to load workflow runs.",
        500,
      );
    }
  }

  const internalSecret = Deno.env.get("N8N_INTERNAL_SECRET");
  if (!internalSecret) {
    return apiError(
      "SERVER_NOT_CONFIGURED",
      "N8N_INTERNAL_SECRET is required.",
      500,
    );
  }

  let body: WorkflowPayload & { action?: string; run_id?: string };
  try {
    body = await req.json();
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON.");
  }

  if (body.action === "retry") {
    // Old retry re-submitted the folder to Production_01 as a new batch. SKU retry
    // now goes through workflow-jobs-retry (Production_08) and updates the same row.
    return apiError("RETRY_MOVED", "Use the workflow-jobs-retry endpoint to retry SKU jobs.", 410);
  }

  const validation = validatePayload(body);
  if (!validation.valid) {
    return apiError("INVALID_INPUT", validation.error ?? "Invalid payload.");
  }

  const n8nResult = await postToN8n(buildN8nPayload(body), internalSecret);
  if (!n8nResult.success) {
    console.error("workflow-jobs n8n error:", n8nResult.error);
    return apiError(
      "N8N_ERROR",
      n8nResult.error ?? "Failed to forward to n8n.",
      502,
    );
  }

  // n8n acknowledges receipt only ("Workflow got started."): no batch/job ID,
  // no completion or validation result. Report it as submitted.
  return json({
    success: true,
    data: {
      status: "SUBMITTED",
      source_folder: resolveSourceFolder(body),
      n8n_response: n8nResult.response,
    },
    request_id: crypto.randomUUID(),
  });
});
