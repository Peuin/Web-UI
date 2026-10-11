export type DriveItemType = "FOLDER" | "IMAGE" | "VIDEO" | "DOCUMENT" | "OTHER";
export type DriveSyncStatus = "SYNCED" | "PENDING" | "STALE" | "ERROR";
export type CacheStatus = "NOT_CACHED" | "CACHED" | "MATERIALIZING" | "EXPIRED";

export type DriveConnection = {
  id: string;
  name: string;
  connectionType: "MY_DRIVE" | "SHARED_DRIVE";
  rootFolderId: string;
  status: "ACTIVE" | "INACTIVE" | "ERROR";
  lastSyncAt: string | null;
};

export type DriveItem = {
  id: string;
  connectionId: string;
  driveItemId: string;
  parentDriveItemId: string | null;
  name: string;
  mimeType: string;
  itemType: DriveItemType;
  sizeBytes: number | null;
  thumbnailUrl: string | null;
  webViewLink: string | null;
  modifiedTime: string;
  syncedAt: string;
  syncStatus: DriveSyncStatus;
  cacheStatus: CacheStatus;
  /** Path of this item in Supabase Storage (drive_items.cached_storage_path). */
  storagePath: string | null;
  treeDepth?: number;
  treePath?: string[];
};

export type ApiDriveItem = {
  id: string;
  connection_id: string;
  drive_item_id: string;
  parent_drive_item_id: string | null;
  name: string;
  mime_type: string | null;
  item_type: DriveItemType;
  size_bytes: number | null;
  thumbnail_url: string | null;
  web_view_link: string | null;
  modified_time: string | null;
  created_at?: string;
  updated_at?: string;
  sync_status: string | null;
  cached_storage_path?: string | null;
  cached_at?: string | null;
  tree_depth?: number;
  tree_path?: string[];
};

/** Image or folder in the Google Drive model library (n8n Production_07). */
export type ModelLibraryItem = {
  id: string;
  name: string;
  mime_type: string;
  item_type: "FOLDER" | "IMAGE" | "OTHER";
  size_bytes: number | null;
  thumbnail_url: string | null;
  web_view_link: string | null;
  modified_time: string | null;
  /** Direct "anyone with the link" URL; only valid after the file is shared. */
  public_url: string | null;
};

export type WorkflowStatus =
  | "QUEUED"
  | "PROCESSING"
  | "WAITING_EXTERNAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** One Drive folder inside a batch's scan tree (n8n_run kind = 'folder'). */
export type JobFolderRun = {
  runId: string;
  parentRunId: string | null;
  depth: number;
  name: string;
  sourcePath: string | null;
  driveFolderId: string;
  status: WorkflowStatus;
  rawStatus: string;
  imageCount: number | null;
  childFolderCount: number | null;
  files: { id: string; name: string | null }[];
  attempt: number | null;
  retryAction: string | null;
  canRetry: boolean;
  errorMessage?: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
};

export type WorkflowJob = {
  id: string;
  workflowType: string;
  status: WorkflowStatus;
  rawStatus?: string;
  progress: number;
  inputFiles: number;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage?: string;
  productType?: string | null;
  sourceName?: string | null;
  selectedName?: string | null;
  selectedType?: string | null;
  canRetry?: boolean;
  folders: JobFolderRun[];
};

export type ApiJobFolderRun = {
  run_id: string;
  parent_run_id: string | null;
  depth: number;
  name: string;
  source_path: string | null;
  drive_folder_id: string;
  status: WorkflowStatus;
  raw_status: string;
  image_count: number | null;
  child_folder_count: number | null;
  files?: { id: string; name: string | null }[];
  attempt: number | null;
  retry_action: string | null;
  can_retry: boolean;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
};

export type ApiWorkflowJob = {
  id: string;
  workflow_type: string;
  status: WorkflowStatus;
  progress: number;
  input?: unknown;
  output?: unknown;
  error_message: string | null;
  n8n_execution_id: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  workflow_job_files?: { id: string }[];
  raw_status?: string;
  product_type?: string | null;
  source_name?: string | null;
  selected_name?: string | null;
  selected_type?: string | null;
  can_retry?: boolean;
  folders?: ApiJobFolderRun[];
};

// ─── Supabase Storage (Model tab) ─────────────────────────────────────────────

export type StorageItemType = "folder" | "file";

export type StorageItem = {
  /** Unique key within current directory — equals `name` */
  id: string;
  name: string;
  /** Full storage path, e.g. google-drive/Model/WINTER CAPE 1/image.jpg */
  path: string;
  type: StorageItemType;
  mimeType: string | null;
  sizeBytes: number | null;
  updatedAt: string | null;
  metadata: Record<string, unknown> | null;
  /** Public URL for image files (null for folders and non-image files) */
  thumbnailUrl: string | null;
};

export type StorageBreadcrumb = {
  label: string;
  /** Full storage path for this crumb, e.g. google-drive/Model/WINTER CAPE 1 */
  path: string;
};

// ─── Final output ──────────────────────────────────────────────────────────────

export type FinalDateFilter = "all" | "today" | "7days" | "30days" | "custom";

export type FinalFile = {
  run_id: string;
  name: string;
  path: string;
  mime_type: string;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
  signed_url: string | null;
};

export type FinalRun = {
  run_id: string;
  path: string;
  file_count: number;
  latest_updated_at: string;
};

export type FinalFilesResponse = {
  total_files: number;
  total_runs: number;
  runs: FinalRun[];
  files: FinalFile[];
};

export type ApiResult<T> = {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
  request_id: string;
};

export type AuthProfile = {
  id: string;
  username: string;
  email: string;
  role: "admin" | "user";
  display_name: string | null;
};

export type AuthSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
  user: unknown;
};
