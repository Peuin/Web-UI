import { createClient } from "jsr:@supabase/supabase-js@2.112.4";

// SKU retry (Production_08 webhook workflow-jobs-retry).
// POST { request_id, job_ids }      → queue retries, returns accepted/skipped per SKU.
// GET  ?request_id=&job_ids=a,b     → retry progress for polling (3–5 s).
// The browser never calls the n8n webhook directly: this function authenticates
// the user, checks each job and dedups by Drive folder before forwarding.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function apiError(code: string, message: string, status = 400, requestId?: string) {
  return json({
    success: false,
    error: { code, message },
    request_id: requestId ?? crypto.randomUUID(),
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

// deno-lint-ignore no-explicit-any
function adminClient(supabaseUrl: string, secretKey: string): any {
  return createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JOBS_PER_REQUEST = 100;
const TERMINAL_RETRY_STATUSES = new Set(["completed", "failed"]);

const STATUS_COLUMNS = [
  "job_id",
  "batch_id",
  "source_drive_folder_id",
  "source_name",
  "source_path",
  "status",
  "last_step",
  "retry_count",
  "last_retry_status",
  "last_retry_at",
  "last_retry_error",
  "completed_via",
  "last_retry_request_id",
  "last_retry_execution_id",
  "retry_mode",
].join(", ");

type RetryStatusRow = {
  job_id: string;
  batch_id: string;
  source_drive_folder_id: string;
  source_name: string | null;
  source_path: string | null;
  status: string;
  last_step: string | null;
  retry_count: number | null;
  last_retry_status: "queued" | "processing" | "completed" | "failed" | null;
  last_retry_at: string | null;
  last_retry_error: unknown;
  completed_via: "initial" | "retry" | null;
  last_retry_request_id: string | null;
  last_retry_execution_id: string | null;
  retry_mode: "finalize" | "regenerate" | null;
};

type Skipped = { job_id: string; reason: string };

function parseJobIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_JOBS_PER_REQUEST) return null;
  if (!value.every((id) => typeof id === "string" && UUID_RE.test(id))) return null;
  return [...new Set(value.map((id) => id.toLowerCase()))];
}

/**
 * Maps requested job IDs to the job currently shown for each Drive folder
 * (folder_processing_latest), one job per folder. Unknown IDs are skipped here
 * so n8n only receives jobs this backend has checked.
 */
async function resolveRetryJobs(admin: ReturnType<typeof adminClient>, jobIds: string[]) {
  const { data: rows, error } = await admin
    .from("folder_processing")
    .select("job_id, source_drive_folder_id")
    .in("job_id", jobIds);
  if (error) throw error;
  const folderByJob = new Map<string, string>(
    ((rows ?? []) as { job_id: string; source_drive_folder_id: string }[])
      .map((row) => [row.job_id, row.source_drive_folder_id]),
  );

  const skipped: Skipped[] = jobIds
    .filter((id) => !folderByJob.has(id))
    .map((id) => ({ job_id: id, reason: "job_not_found" }));

  const folderIds = [...new Set(folderByJob.values())];
  const latestByFolder = new Map<string, string>();
  if (folderIds.length > 0) {
    const { data: latest, error: latestError } = await admin
      .from("folder_processing_latest")
      .select("job_id, source_drive_folder_id")
      .in("source_drive_folder_id", folderIds);
    if (latestError) throw latestError;
    for (const row of (latest ?? []) as { job_id: string; source_drive_folder_id: string }[]) {
      latestByFolder.set(row.source_drive_folder_id, row.job_id);
    }
  }

  const forward: string[] = [];
  const resolved: { requested_job_id: string; job_id: string }[] = [];
  for (const [jobId, folderId] of folderByJob) {
    const target = latestByFolder.get(folderId) ?? jobId;
    if (target !== jobId) resolved.push({ requested_job_id: jobId, job_id: target });
    if (forward.includes(target)) {
      skipped.push({ job_id: jobId, reason: "duplicate_request" });
    } else {
      forward.push(target);
    }
  }
  return { forward, skipped, resolved };
}

async function postRetryToN8n(requestId: string, jobIds: string[], internalSecret: string) {
  const url = Deno.env.get("N8N_WORKFLOW_JOBS_RETRY_WEBHOOK_URL") ??
    "https://automation.oxmode.ai/webhook/workflow-jobs-retry";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": internalSecret,
      },
      body: JSON.stringify({ request_id: requestId, job_ids: jobIds }),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } catch (error: unknown) {
    // Network error/timeout: n8n may still have queued it. Caller keeps request_id.
    return { status: 0, body: error instanceof Error ? error.message : String(error) };
  }
}

async function handleSubmit(admin: ReturnType<typeof adminClient>, req: Request) {
  const internalSecret = Deno.env.get("N8N_INTERNAL_SECRET");
  if (!internalSecret) {
    return apiError("SERVER_NOT_CONFIGURED", "N8N_INTERNAL_SECRET is required.", 500);
  }

  let body: { request_id?: unknown; job_ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON.");
  }

  // The browser creates request_id per click and resends the same one after a timeout.
  const requestId = typeof body.request_id === "string" ? body.request_id.toLowerCase() : "";
  if (!UUID_RE.test(requestId)) {
    return apiError("INVALID_INPUT", "request_id must be a UUID.");
  }
  const jobIds = parseJobIds(body.job_ids);
  if (!jobIds) {
    return apiError(
      "INVALID_INPUT",
      `job_ids must be 1–${MAX_JOBS_PER_REQUEST} folder_processing.job_id UUIDs.`,
      400,
      requestId,
    );
  }

  const { forward, skipped, resolved } = await resolveRetryJobs(admin, jobIds);
  if (forward.length === 0) {
    return json({
      success: true,
      data: { request_id: requestId, accepted: [], skipped, resolved },
      request_id: requestId,
    }, 202);
  }

  const n8n = await postRetryToN8n(requestId, forward, internalSecret);
  if (n8n.status === 202 || n8n.status === 200) {
    const result = (n8n.body ?? {}) as { accepted?: unknown[]; skipped?: Skipped[] };
    return json({
      success: true,
      data: {
        request_id: requestId,
        accepted: result.accepted ?? [],
        skipped: [...skipped, ...(result.skipped ?? [])],
        resolved,
      },
      request_id: requestId,
    }, 202);
  }
  if (n8n.status === 400) {
    console.error("workflow-jobs-retry n8n rejected:", n8n.body);
    return apiError("INVALID_INPUT", "n8n rejected the retry request.", 400, requestId);
  }
  // 503, 5xx, network error or timeout: acceptance is unknown.
  console.error("workflow-jobs-retry n8n unavailable:", n8n.status, n8n.body);
  return apiError(
    "RETRY_QUEUE_UNAVAILABLE",
    "Retry was not confirmed. Check job status, then resend with the same request_id.",
    503,
    requestId,
  );
}

async function handleStatus(admin: ReturnType<typeof adminClient>, url: URL) {
  const requestId = (url.searchParams.get("request_id") ?? "").toLowerCase();
  if (requestId && !UUID_RE.test(requestId)) {
    return apiError("INVALID_INPUT", "request_id must be a UUID.");
  }
  const jobIds = parseJobIds(
    (url.searchParams.get("job_ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
  );
  if (!jobIds) {
    return apiError("INVALID_INPUT", `job_ids must be 1–${MAX_JOBS_PER_REQUEST} comma-separated UUIDs.`);
  }

  const { data, error } = await admin
    .from("folder_processing")
    .select(STATUS_COLUMNS)
    .in("job_id", jobIds);
  if (error) throw error;

  const counts = { queued: 0, processing: 0, completed: 0, failed: 0, pending: 0 };
  const jobs = ((data ?? []) as RetryStatusRow[]).map((row) => {
    // A completed/failed row from an older request must not answer this one.
    const matched = !requestId || row.last_retry_request_id === requestId;
    const retryStatus = matched ? row.last_retry_status : null;
    if (retryStatus) counts[retryStatus] += 1;
    else counts.pending += 1;
    return {
      ...row,
      request_matched: matched,
      is_terminal: matched && TERMINAL_RETRY_STATUSES.has(row.last_retry_status ?? ""),
    };
  });

  return json({
    success: true,
    data: {
      request_id: requestId || null,
      jobs,
      counts,
      all_terminal: jobs.length > 0 && jobs.every((job) => job.is_terminal),
    },
    request_id: crypto.randomUUID(),
  });
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
    return apiError("SERVER_NOT_CONFIGURED", "Missing Supabase URL or keys.", 500);
  }

  const supabase = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return apiError("UNAUTHORIZED", "Invalid session.", 401);
  }

  const admin = adminClient(supabaseUrl, secretKey);
  try {
    return req.method === "GET"
      ? await handleStatus(admin, new URL(req.url))
      : await handleSubmit(admin, req);
  } catch (error: unknown) {
    console.error("workflow-jobs-retry error:", error);
    return apiError(
      "SUPABASE_ERROR",
      error instanceof Error ? error.message : "Failed to process retry request.",
      500,
    );
  }
});
