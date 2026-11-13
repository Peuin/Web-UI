import { createClient } from "jsr:@supabase/supabase-js@2.112.4";

// Model reference library on Google Drive, served by n8n workflow
// Production_07 model library workflow (webhook POST /model-references).
const MODEL_LIBRARY_WEBHOOK_URL = "https://automation.oxmode.ai/webhook/model-references";
const DEFAULT_MODEL_FOLDER_ID = "1lyx87c6tZPE74wHnahta2ByvxR8u52l-";
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ModelLibraryRequest = {
  action?: string;
  folder_id?: string;
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  content_base64?: string;
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

type LibraryItem = {
  id: string;
  name: string;
  mime_type: string | null;
  item_type: "FOLDER" | "IMAGE" | "OTHER";
  size_bytes: number | null;
  thumbnail_url: string | null;
  web_view_link: string | null;
  modified_time: string | null;
  public_url: string | null;
};

function toRow(item: LibraryItem, folderId: string, shared: boolean) {
  return {
    drive_file_id: item.id,
    folder_id: folderId,
    name: item.name,
    mime_type: item.mime_type,
    item_type: item.item_type,
    size_bytes: item.size_bytes,
    thumbnail_url: item.thumbnail_url,
    web_view_link: item.web_view_link,
    public_url: item.public_url,
    modified_time: item.modified_time,
    is_active: true,
    ...(shared ? { is_public: true, shared_at: new Date().toISOString() } : {}),
  };
}

/** Mirrors n8n results into public.model_references (Drive stays the source of truth). */
async function saveToModelTable(
  supabaseUrl: string,
  action: string,
  requestedFolderId: string,
  data: { folder_id?: string; items?: LibraryItem[]; item?: LibraryItem },
) {
  const secretKey = readSecretKey();
  if (!secretKey) throw new Error("Missing Supabase secret key.");
  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const folderId = data.folder_id ?? requestedFolderId;

  if (action === "list") {
    const items = data.items ?? [];
    if (items.length > 0) {
      const { error } = await admin
        .from("model_references")
        .upsert(items.map((item) => toRow(item, folderId, false)), { onConflict: "drive_file_id" });
      if (error) throw error;
    }
    // Drive is the source of truth: rows for files deleted from this folder are removed.
    let stale = admin
      .from("model_references")
      .delete()
      .eq("folder_id", folderId);
    if (items.length > 0) {
      stale = stale.not("drive_file_id", "in", `(${items.map((item) => `"${item.id}"`).join(",")})`);
    }
    const { data: removed, error: staleError } = await stale.select("drive_file_id");
    if (staleError) throw staleError;
    return { removed: removed?.length ?? 0 };
  }

  if (data.item) {
    const { error } = await admin
      .from("model_references")
      .upsert(toRow(data.item, folderId, true), { onConflict: "drive_file_id" });
    if (error) throw error;
  }
  return { removed: 0 };
}

async function removeModelRow(supabaseUrl: string, driveFileId: string) {
  const secretKey = readSecretKey();
  if (!secretKey) throw new Error("Missing Supabase secret key.");
  const admin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await admin.from("model_references").delete().eq("drive_file_id", driveFileId);
  if (error) throw error;
}

function optionalDriveId(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" && DRIVE_ID_RE.test(value.trim()) ? value.trim() : null;
}

/** Validates the request and returns the payload forwarded to n8n. */
function buildN8nPayload(body: ModelLibraryRequest): { payload?: Record<string, unknown>; error?: string } {
  const action = String(body.action ?? "list").trim().toLowerCase();
  const folderId = optionalDriveId(body.folder_id);
  if (folderId === null) return { error: "folder_id is not a valid Drive ID" };
  const payload: Record<string, unknown> = { action };
  if (folderId) payload.folder_id = folderId;

  if (action === "list") return { payload };

  if (action === "share") {
    const fileId = optionalDriveId(body.file_id);
    if (!fileId) return { error: "file_id is required" };
    return { payload: { ...payload, file_id: fileId } };
  }

  if (action === "upload") {
    const fileName = String(body.file_name ?? "").trim();
    const mimeType = String(body.mime_type ?? "").trim().toLowerCase();
    const content = String(body.content_base64 ?? "").replace(/^data:[^,]*,/, "");
    if (!fileName) return { error: "file_name is required" };
    if (!IMAGE_TYPES.includes(mimeType)) return { error: "Only JPEG, PNG, or WebP images can be uploaded" };
    // base64 length * 3/4 ≈ decoded bytes
    if (!content || content.length * 0.75 > MAX_UPLOAD_BYTES) {
      return { error: "Image must be between 1 byte and 15 MB" };
    }
    return { payload: { ...payload, file_name: fileName, mime_type: mimeType, content_base64: content } };
  }

  return { error: "action must be list, share, or upload" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return apiError("INVALID_METHOD", "Use POST.", 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return apiError("UNAUTHORIZED", "Missing Authorization header.", 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = readPublishableKey();
  const librarySecret = Deno.env.get("MODEL_LIBRARY_SECRET");
  if (!supabaseUrl || !publishableKey || !librarySecret) {
    return apiError(
      "SERVER_NOT_CONFIGURED",
      "Missing Supabase URL, publishable key, or MODEL_LIBRARY_SECRET.",
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

  let body: ModelLibraryRequest;
  try {
    body = await req.json();
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON.");
  }

  const { payload, error } = buildN8nPayload(body);
  if (!payload) return apiError("INVALID_INPUT", error ?? "Invalid request.");

  const webhookUrl = Deno.env.get("MODEL_LIBRARY_WEBHOOK_URL") ?? MODEL_LIBRARY_WEBHOOK_URL;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Model-Library-Secret": librarySecret,
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    const result = data as { success?: boolean; data?: unknown; message?: string } | null;
    if (!response.ok || !result?.success) {
      const message = result?.message ?? (text.slice(0, 300) || `n8n returned HTTP ${response.status}`);
      console.error("model-library n8n error:", response.status, message);
      // The file was deleted from Drive after the list was loaded: drop it from the table too.
      if (payload.action === "share" && /not ?found|404/i.test(message)) {
        await removeModelRow(supabaseUrl, String(payload.file_id)).catch((removeError) =>
          console.error("model-library remove error:", removeError)
        );
        return apiError("MODEL_NOT_FOUND", "This image no longer exists on Google Drive. The list has been refreshed.", 404);
      }
      return apiError("N8N_ERROR", message, 502);
    }

    try {
      await saveToModelTable(
        supabaseUrl,
        String(payload.action),
        String(payload.folder_id ?? DEFAULT_MODEL_FOLDER_ID),
        result.data as { folder_id?: string; items?: LibraryItem[]; item?: LibraryItem },
      );
    } catch (saveError: unknown) {
      // The Drive operation already succeeded; keep the response usable.
      console.error("model-library save error:", saveError);
    }

    return json({ success: true, data: result.data, request_id: crypto.randomUUID() });
  } catch (fetchError: unknown) {
    console.error("model-library fetch error:", fetchError);
    return apiError(
      "N8N_UNAVAILABLE",
      fetchError instanceof Error ? fetchError.message : "Failed to reach the model library workflow.",
      502,
    );
  }
});
