import type {
  ApiDriveItem,
  ApiResult,
  ApiWorkflowJob,
  AuthProfile,
  AuthSession,
  DriveItem,
  FinalFilesResponse,
  WorkflowJob,
  ModelLibraryItem,
  SkuRetryStatusResponse,
  SkuRetrySubmitResponse,
} from "@/types/domain";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function callEdgeFunction<T>(
  name: string,
  accessToken: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  if (!supabaseUrl || !supabasePublicKey) {
    return {
      success: false,
      request_id: crypto.randomUUID(),
      error: {
        code: "MISSING_SUPABASE_CONFIG",
        message:
          "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required.",
      },
    };
  }

  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        apikey: supabasePublicKey,
        Authorization: `Bearer ${accessToken}`,
        ...init?.headers,
      },
    });
  } catch (error) {
    return {
      success: false,
      request_id: crypto.randomUUID(),
      error: {
        code: "NETWORK_ERROR",
        message: error instanceof Error ? error.message : "Could not reach Supabase Edge Functions.",
      },
    };
  }

  const text = await response.text();
  let body: ApiResult<T> | null = null;

  try {
    body = text ? JSON.parse(text) as ApiResult<T> : null;
  } catch {
    body = null;
  }

  if (body) return body;

  return {
    success: false,
    request_id: crypto.randomUUID(),
    error: {
      code: response.ok ? "INVALID_RESPONSE" : `HTTP_${response.status}`,
      message: text || response.statusText || "Supabase Edge Function returned an empty response.",
    },
  };
}

async function callPublicEdgeFunction<T>(
  name: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  if (!supabaseUrl || !supabasePublicKey) {
    return {
      success: false,
      request_id: crypto.randomUUID(),
      error: {
        code: "MISSING_SUPABASE_CONFIG",
        message:
          "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are required.",
      },
    };
  }

  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        apikey: supabasePublicKey,
        Authorization: `Bearer ${supabasePublicKey}`,
        ...init?.headers,
      },
    });
  } catch (error) {
    return {
      success: false,
      request_id: crypto.randomUUID(),
      error: {
        code: "NETWORK_ERROR",
        message: error instanceof Error ? error.message : "Could not reach Supabase Edge Functions.",
      },
    };
  }

  const text = await response.text();
  let body: ApiResult<T> | null = null;

  try {
    body = text ? JSON.parse(text) as ApiResult<T> : null;
  } catch {
    body = null;
  }

  if (body) return body;

  return {
    success: false,
    request_id: crypto.randomUUID(),
    error: {
      code: response.ok ? "INVALID_RESPONSE" : `HTTP_${response.status}`,
      message: text || response.statusText || "Supabase Edge Function returned an empty response.",
    },
  };
}

export const platformApi = {
  login(identifier: string, password: string) {
    return callPublicEdgeFunction<{
      session: AuthSession;
      user: unknown;
      profile: AuthProfile | null;
    }>("auth", {
      method: "POST",
      body: JSON.stringify({ action: "login", identifier, password }),
    });
  },
  me(accessToken: string) {
    return callEdgeFunction<{
      user: unknown;
      profile: AuthProfile | null;
    }>("auth", accessToken, {
      method: "POST",
      body: JSON.stringify({ action: "me" }),
    });
  },
  listFolder(accessToken: string, params: URLSearchParams) {
    return callEdgeFunction<{
      folder: ApiDriveItem | null;
      items: ApiDriveItem[];
      pagination: unknown;
      cache?: "HIT" | "MISS" | "DISABLED";
    }>(
      `drive-list-folder?${params.toString()}`,
      accessToken,
      { method: "POST" },
    );
  },
  createWorkflow(
    accessToken: string,
    body: { workflow_type: string; file_ids: string[]; parameters: unknown },
  ) {
    return callEdgeFunction<{ job_id: string; status: string }>(
      "workflow-create",
      accessToken,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
  syncDrive(
    accessToken: string,
    body: { connection_id: string; root_folder_id?: string; sync_mode: string; recursive?: boolean; max_folders?: number },
  ) {
    return callEdgeFunction<{
      sync_request_id: string;
      status: string;
      n8n_status?: number;
      n8n_response?: unknown;
      recursive?: boolean;
      folders_synced?: number;
      items_discovered?: number;
    }>("drive-sync", accessToken, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  listJobs(accessToken: string) {
    return callEdgeFunction<{ jobs: ApiWorkflowJob[] }>("workflow-jobs", accessToken);
  },
  /**
   * SKU retry via Production_08. Create requestId with crypto.randomUUID() once per
   * click and reuse it only when resending the same job_ids after a timeout/503.
   */
  retrySkuJobs(accessToken: string, requestId: string, jobIds: string[]) {
    return callEdgeFunction<SkuRetrySubmitResponse>("workflow-jobs-retry", accessToken, {
      method: "POST",
      body: JSON.stringify({ request_id: requestId, job_ids: jobIds }),
    });
  },
  /** Poll every 3–5 s until data.all_terminal. */
  getSkuRetryStatus(accessToken: string, requestId: string, jobIds: string[]) {
    const params = new URLSearchParams({ request_id: requestId, job_ids: jobIds.join(",") });
    return callEdgeFunction<SkuRetryStatusResponse>(`workflow-jobs-retry?${params.toString()}`, accessToken);
  },
  getWorkflowDetail(accessToken: string, jobId: string) {
    return callEdgeFunction<ApiWorkflowJob>(`workflow-detail?job_id=${encodeURIComponent(jobId)}`, accessToken);
  },
  getAccessUrl(accessToken: string, fileId: string) {
    return callEdgeFunction<{ file_id: string; url?: string; expires_in?: number; status?: string }>(
      "file-access-url",
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({ file_id: fileId }),
      },
    );
  },
  materializeFile(accessToken: string, fileId: string) {
    return callEdgeFunction<{ file_id: string; status: string }>("file-materialize", accessToken, {
      method: "POST",
      body: JSON.stringify({ file_id: fileId }),
    });
  },
  listFinalFiles(
    accessToken: string,
    filters?: {
      from_date?: string;
      to_date?: string;
      run_id?: string;
      limit?: number;
    },
  ) {
    return callEdgeFunction<FinalFilesResponse>("final-files", accessToken, {
      method: "POST",
      body: JSON.stringify(filters || {}),
    });
  },
  /** Model library on Google Drive (via n8n Production_07). */
  listModelLibrary(accessToken: string, folderId?: string) {
    return callEdgeFunction<{ folder_id: string; items: ModelLibraryItem[] }>("model-library", accessToken, {
      method: "POST",
      body: JSON.stringify({ action: "list", folder_id: folderId }),
    });
  },
  /** Makes one library image readable by "anyone with the link" and returns it. */
  shareModelImage(accessToken: string, fileId: string, folderId: string) {
    return callEdgeFunction<{ item: ModelLibraryItem }>("model-library", accessToken, {
      method: "POST",
      body: JSON.stringify({ action: "share", file_id: fileId, folder_id: folderId }),
    });
  },
  uploadModelImage(
    accessToken: string,
    file: { fileName: string; mimeType: string; contentBase64: string; folderId: string },
  ) {
    return callEdgeFunction<{ item: ModelLibraryItem }>("model-library", accessToken, {
      method: "POST",
      body: JSON.stringify({
        action: "upload",
        folder_id: file.folderId,
        file_name: file.fileName,
        mime_type: file.mimeType,
        content_base64: file.contentBase64,
      }),
    });
  },
  /** Final Output tab: one folder's children from final_items. */
  listFinalFolder(accessToken: string, folderId: string) {
    return callEdgeFunction<{ folder_id: string; folder: ApiDriveItem | null; items: ApiDriveItem[] }>(
      "final-files",
      accessToken,
      { method: "POST", body: JSON.stringify({ action: "list", folder_id: folderId }) },
    );
  },
  /** Ask n8n (Production_05) to re-list one output folder into final_items. */
  syncFinalFolder(accessToken: string, folderId: string) {
    return callEdgeFunction<{ status: string; folder_id: string; n8n_response?: unknown }>(
      "final-files",
      accessToken,
      { method: "POST", body: JSON.stringify({ action: "sync", folder_id: folderId }) },
    );
  },
  submitMediaGenerationWorkflow(
    accessToken: string,
    body: {
      workflow_type: string;
      workflow_id: string;
      connection_id: string;
      root_folder_id?: string;
      selected_item: {
        id: string;
        drive_item_id: string;
        name: string;
        item_type: string;
        mime_type: string;
        parent_drive_item_id: string | null;
        web_view_link: string | null;
      };
      selected_items: Array<{
        id: string;
        drive_item_id: string;
        name: string;
        item_type: string;
        mime_type: string;
        web_view_link: string | null;
      }>;
      parameters: {
        product_type: string;
        product_description: string;
        sample_prompt: string;
        source_storage_prefix: string;
        model_reference_url: string | null;
        style_reference_url?: string;
        output_type: "image" | "video" | "both";
        image_count: number;
        video_seconds: number;
        aspect_ratio: string;
        video_resolution: string;
      };
    },
  ) {
    return callEdgeFunction<{
      status: string;
      source_folder?: { drive_item_id?: string; web_view_link?: string } | null;
      n8n_response?: unknown;
    }>(
      "workflow-jobs",
      accessToken,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  },
};

// Drive API thumbnailLink (lh3…/drive-storage/…) expires within hours, but sync stores it.
// Build a stable Drive thumbnail URL from the file ID instead; the browser's Google session authorizes it.
function stableThumbnailUrl(url: string | null | undefined, driveItemId: string): string | null {
  if (!url) return null;
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname.endsWith(".googleusercontent.com") && pathname.startsWith("/drive-storage/")) {
      return `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveItemId)}&sz=w400`;
    }
  } catch {
    return url;
  }
  return url;
}

export function normalizeDriveItem(item: ApiDriveItem): DriveItem {
  const driveItemId = item.drive_item_id ?? item.id;

  return {
    id: item.id,
    connectionId: item.connection_id,
    driveItemId,
    parentDriveItemId: item.parent_drive_item_id,
    name: item.name,
    mimeType: item.mime_type ?? "application/octet-stream",
    itemType: item.item_type,
    sizeBytes: item.size_bytes,
    thumbnailUrl: stableThumbnailUrl(item.thumbnail_url, driveItemId),
    webViewLink: item.web_view_link,
    modifiedTime: item.modified_time ?? item.updated_at ?? item.created_at ?? new Date().toISOString(),
    syncedAt: item.updated_at ?? item.created_at ?? new Date().toISOString(),
    syncStatus: item.sync_status === "ERROR" ? "ERROR" : item.sync_status === "STALE" ? "STALE" : "SYNCED",
    cacheStatus: item.cached_storage_path ? "CACHED" : "NOT_CACHED",
    storagePath: item.cached_storage_path ?? null,
    treeDepth: item.tree_depth,
    treePath: item.tree_path,
  };
}

export function normalizeWorkflowJob(job: ApiWorkflowJob): WorkflowJob {
  return {
    id: job.id,
    workflowType: job.workflow_type,
    status: job.status,
    progress: job.progress,
    inputFiles: job.workflow_job_files?.length ?? 0,
    createdBy: job.created_by ?? "system",
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    errorMessage: job.error_message ?? undefined,
    rawStatus: job.raw_status,
    productType: job.product_type ?? null,
    sourceName: job.source_name ?? null,
    selectedName: job.selected_name ?? null,
    selectedType: job.selected_type ?? null,
    canRetry: job.can_retry ?? false,
    folders: (job.folders ?? []).map((folder) => ({
      runId: folder.run_id,
      parentRunId: folder.parent_run_id,
      depth: folder.depth,
      name: folder.name,
      sourcePath: folder.source_path,
      driveFolderId: folder.drive_folder_id,
      status: folder.status,
      rawStatus: folder.raw_status,
      imageCount: folder.image_count,
      childFolderCount: folder.child_folder_count,
      files: folder.files ?? [],
      attempt: folder.attempt,
      retryAction: folder.retry_action,
      retryCount: folder.retry_count ?? 0,
      lastRetryStatus: folder.last_retry_status ?? null,
      lastRetryAt: folder.last_retry_at ?? null,
      lastRetryError: folder.last_retry_error ?? null,
      retryMode: folder.retry_mode ?? null,
      canRetry: folder.can_retry,
      errorMessage: folder.error_message ?? undefined,
      startedAt: folder.started_at,
      finishedAt: folder.finished_at,
      updatedAt: folder.updated_at,
    })),
  };
}
