"use client";

import {
  Activity,
  BellRing,
  Check,
  ChevronRight,
  CircleAlert,
  Cloud,
  Database,
  Download,
  File,
  FileImage,
  FileText,
  Film,
  Folder,
  FolderSync,
  Grid2X2,
  HardDrive,
  KeyRound,
  Link,
  List,
  Loader2,
  Lock,
  LogIn,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
  ImageIcon,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  normalizeDriveItem,
  normalizeWorkflowJob,
  platformApi,
} from "@/lib/api/edge-functions";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { formatBytes, formatDate } from "@/lib/utils/format";
import type {
  ApiDriveItem,
  DriveItem,
  DriveItemType,
  FinalDateFilter,
  FinalFile,
  FinalRun,
  WorkflowJob,
  WorkflowStatus,
} from "@/types/domain";

type ViewMode = "grid" | "list";
type WorkspaceTab = "browser" | "jobs" | "final" | "settings";
type FolderCrumb = {
  driveFileId: string | null;
  name: string;
};

const DEFAULT_CONNECTION_ID = "00000000-0000-0000-0000-000000000000";

const typeIcon: Record<DriveItemType, typeof File> = {
  FOLDER: Folder,
  IMAGE: FileImage,
  VIDEO: Film,
  DOCUMENT: FileText,
  OTHER: File,
};

const statusVariant: Record<WorkflowStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  QUEUED: "neutral",
  PROCESSING: "info",
  WAITING_EXTERNAL: "warning",
  COMPLETED: "success",
  FAILED: "danger",
  CANCELLED: "neutral",
};

function isHiddenDrivePlaceholder(item: { name: string }): boolean {
  return item.name === ".emptyFolderPlaceholder";
}

function stripMarkdownLink(value: string | null): string | null {
  if (!value) return null;
  // Convert [label](url) to url
  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/;
  const match = value.match(markdownLinkRegex);
  if (match) {
    return match[2]; // Return the URL part
  }
  return value;
}

function isValidStoragePrefix(value: string): boolean {
  // Reject if it contains URL patterns or corruption markers
  const invalidPatterns = [
    '](http',
    'http://',
    'https://',
    '?token=',
    'selected_items',
    'parameters',
  ];
  return !invalidPatterns.some(pattern => value.includes(pattern));
}

export default function Home() {
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("browser");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DriveItem[]>([]);
  const [currentFolder, setCurrentFolder] = useState<DriveItem | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<FolderCrumb[]>([{ driveFileId: null, name: "Root folder" }]);
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);
  const [selectedItem, setSelectedItem] = useState<DriveItem | null>(null);
  const [previewItem, setPreviewItem] = useState<DriveItem | null>(null);
  const [activeJob, setActiveJob] = useState<WorkflowJob | null>(null);
  const [loadingDrive, setLoadingDrive] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Generation form state
  const [productType, setProductType] = useState("cape");
  const [productDescription, setProductDescription] = useState("");
  const [productAttributes, setProductAttributes] = useState("");
  const [sourceStoragePrefix, setSourceStoragePrefix] = useState("google-drive/01_New_Product_Raw/ARTIC WIDE LAPEL");
  const [modelReferenceUrl, setModelReferenceUrl] = useState("");
  const [imageCount, setImageCount] = useState("4");
  const [videoSeconds, setVideoSeconds] = useState("8");
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [videoResolution, setVideoResolution] = useState("480p");

  // Final files state
  const [finalFiles, setFinalFiles] = useState<FinalFile[]>([]);
  const [finalRuns, setFinalRuns] = useState<FinalRun[]>([]);
  const [finalLoading, setFinalLoading] = useState(false);
  const [finalError, setFinalError] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<FinalDateFilter>("all");
  const [customFromDate, setCustomFromDate] = useState("");
  const [customToDate, setCustomToDate] = useState("");

  const folders = useMemo(() => items.filter((i) => i.itemType === "FOLDER" && !isHiddenDrivePlaceholder(i)), [items]);

  const filteredItems = useMemo(() => {
    const result = items.filter((item) => !isHiddenDrivePlaceholder(item));
    const normalized = query.trim().toLowerCase();
    if (!normalized) return result;
    return result.filter((item) => item.name.toLowerCase().includes(normalized));
  }, [items, query]);

  const loadDrive = useCallback(async (token: string, folderDriveId: string | null = null) => {
    setLoadingDrive(true);
    setAppError(null);

    const allItems: ApiDriveItem[] = [];
    let folder: ApiDriveItem | null = null;
    let page = 1;
    let response: Awaited<ReturnType<typeof platformApi.listFolder>> | null = null;

    do {
      const params = new URLSearchParams({
        connection_id: DEFAULT_CONNECTION_ID,
        page: String(page),
        page_size: "500",
        sort: "modified_desc",
      });
      if (folderDriveId) params.set("folder_id", folderDriveId);

      response = await platformApi.listFolder(token, params);
      if (!response.success || !response.data) break;

      allItems.push(...response.data.items);
      folder ??= response.data.folder;
      page += 1;
    } while (
      response.data.pagination &&
      typeof response.data.pagination === "object" &&
      "has_more" in response.data.pagination &&
      response.data.pagination.has_more === true
    );

    setLoadingDrive(false);

    if (!response?.success || !response.data) {
      setItems([]);
      setPreviewItem(null);
      setSelectedItem(null);
      setAppError(response.error?.message ?? "Could not load Google Drive metadata from Supabase.");
      return;
    }

    const normalizedItems = allItems.filter((item) => !isHiddenDrivePlaceholder(item)).map(normalizeDriveItem);
    const normalizedFolder = folder && !isHiddenDrivePlaceholder(folder) ? normalizeDriveItem(folder) : null;
    setItems(normalizedItems);
    setCurrentFolder(normalizedFolder);
    setPreviewItem(normalizedItems[0] ?? null);
    setSelectedItem(null);
  }, []);

  const loadJobs = useCallback(async (token: string) => {
    setLoadingJobs(true);
    const response = await platformApi.listJobs(token);
    setLoadingJobs(false);

    if (!response.success || !response.data) {
      setJobs([]);
      setActiveJob(null);
      return;
    }

    const normalizedJobs = response.data.jobs.map(normalizeWorkflowJob);
    setJobs(normalizedJobs);
    setActiveJob(normalizedJobs[0] ?? null);
  }, []);

  const loadFinalFiles = useCallback(async (token: string) => {
    setFinalLoading(true);
    setFinalError(null);

    const filters: {
      from_date?: string;
      to_date?: string;
      limit?: number;
    } = {};
    if (dateFilter === "today") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      filters.from_date = today.toISOString();
    } else if (dateFilter === "7days") {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      filters.from_date = weekAgo.toISOString();
    } else if (dateFilter === "30days") {
      const monthAgo = new Date();
      monthAgo.setDate(monthAgo.getDate() - 30);
      filters.from_date = monthAgo.toISOString();
    } else if (dateFilter === "custom") {
      if (customFromDate) {
        filters.from_date = new Date(`${customFromDate}T00:00:00`).toISOString();
      }
      if (customToDate) {
        filters.to_date = new Date(`${customToDate}T23:59:59.999`).toISOString();
      }
    }

    const response = await platformApi.listFinalFiles(token, filters);
    setFinalLoading(false);

    if (!response.success || !response.data) {
      setFinalFiles([]);
      setFinalRuns([]);
      setFinalError(response.error?.message ?? "Could not load generated files.");
      return;
    }

    setFinalFiles(response.data.files);
    setFinalRuns(response.data.runs);
  }, [customFromDate, customToDate, dateFilter]);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token ?? null;
      setAccessToken(token);
      setIsSignedIn(Boolean(token));
      if (token) {
        void loadDrive(token);
        void loadJobs(token);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const token = session?.access_token ?? null;
      setAccessToken(token);
      setIsSignedIn(Boolean(token));
      if (token) {
        void loadDrive(token);
        void loadJobs(token);
      }
    });

    return () => listener.subscription.unsubscribe();
  }, [loadDrive, loadJobs]);

  useEffect(() => {
    if (activeTab === "final" && accessToken) {
      void Promise.resolve().then(() => loadFinalFiles(accessToken));
    }
  }, [activeTab, accessToken, loadFinalFiles]);

  function toggleSelected(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    setSelectedItem((current) => (current?.id === id ? null : item));
  }

  function getDescendantFiles(folderId: string): DriveItem[] {
    const folder = items.find((item) => item.id === folderId);
    if (!folder || folder.itemType !== "FOLDER") return [];

    const descendants: DriveItem[] = [];
    const queue = [folder];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = items.filter((item) => item.parentDriveFileId === current.driveFileId && !isHiddenDrivePlaceholder(item));
      for (const child of children) {
        if (child.itemType === "FOLDER") {
          queue.push(child);
        } else {
          descendants.push(child);
        }
      }
    }

    return descendants;
  }

  function openFolder(folder: DriveItem) {
    const driveFileId = folder.driveFileId;
    if (!accessToken || !driveFileId) return;
    setQuery("");
    setBreadcrumbs((current) => {
      const existingIndex = current.findIndex((crumb) => crumb.driveFileId === driveFileId);
      if (existingIndex >= 0) return current.slice(0, existingIndex + 1);
      return [...current, { driveFileId, name: folder.name }];
    });
    void loadDrive(accessToken, driveFileId);
  }

  function selectBreadcrumb(index: number) {
    if (!accessToken) return;
    const crumb = breadcrumbs[index];
    setQuery("");
    setBreadcrumbs(breadcrumbs.slice(0, index + 1));
    void loadDrive(accessToken, crumb.driveFileId);
  }

  async function openDriveItem(item: DriveItem) {
    if (item.itemType === "FOLDER") {
      openFolder(item);
      return;
    }
    setPreviewItem(item);
  }

  async function syncDrive() {
    if (!accessToken) return;
    setSyncing(true);
    setAppError(null);

    const syncBody: {
      connection_id: string;
      root_folder_id: string;
      sync_mode: string;
      recursive: boolean;
      max_folders: number;
    } = {
      connection_id: DEFAULT_CONNECTION_ID,
      root_folder_id: "1vP62rBKIsfZGPZy7TXHsRwQLdO7pJ4W2",
      sync_mode: "FULL",
      recursive: true,
      max_folders: 500,
    };

    const response = await platformApi.syncDrive(accessToken, syncBody);

    setSyncing(false);
    if (!response.success) {
      setAppError(response.error?.message ?? "Could not trigger Drive Sync.");
      return;
    }
    await loadDrive(accessToken, currentFolder?.driveFileId ?? null);
  }

  async function submitWorkflow() {
    if (!accessToken || !selectedItem) return;

    let selectedItems: DriveItem[] = [];
    if (selectedItem.itemType === "FOLDER") {
      selectedItems = getDescendantFiles(selectedItem.id);
      if (selectedItems.length === 0) {
        setAppError("Selected folder has no descendant files.");
        return;
      }
    } else {
      selectedItems = [selectedItem];
    }

    // Filter out any placeholder items from submission
    selectedItems = selectedItems.filter((item) => !isHiddenDrivePlaceholder(item));

    if (selectedItems.length === 0) {
      setAppError("No valid files to process after filtering placeholders.");
      return;
    }

    // Validate source_storage_prefix is not corrupted
    if (!isValidStoragePrefix(sourceStoragePrefix)) {
      setAppError("Invalid source_storage_prefix. It appears to be corrupted with URL data.");
      return;
    }

    setSubmitting(true);
    setAppError(null);

    // Sanitize URLs to remove Markdown links
    const sanitizedModelReferenceUrl = stripMarkdownLink(modelReferenceUrl);

    // Debug logging (sanitized, no sensitive data)
    console.log("Submitting workflow:", {
      selected_items_count: selectedItems.length,
      selected_item_id: selectedItem.id,
      parameters_keys: Object.keys({
        product_type: productType,
        product_description: productDescription,
        product_attributes: productAttributes,
        source_storage_prefix: sourceStoragePrefix,
        model_reference_url: sanitizedModelReferenceUrl,
        image_count: parseInt(imageCount, 10),
        video_seconds: parseInt(videoSeconds, 10),
        aspect_ratio: aspectRatio,
        video_resolution: videoResolution,
      }),
    });

    const response = await platformApi.submitMediaGenerationWorkflow(accessToken, {
      workflow_type: "media_generation",
      workflow_id: "vcxyqTKCJW29xmWQ",
      connection_id: DEFAULT_CONNECTION_ID,
      root_folder_id: "1vP62rBKIsfZGPZy7TXHsRwQLdO7pJ4W2",
      selected_item: {
        id: selectedItem.id,
        drive_file_id: selectedItem.driveFileId ?? "",
        name: selectedItem.name,
        item_type: selectedItem.itemType,
        mime_type: selectedItem.mimeType,
        parent_drive_file_id: selectedItem.parentDriveFileId,
        web_view_link: stripMarkdownLink(selectedItem.webViewLink) ?? null,
      },
      selected_items: selectedItems.map((item) => ({
        id: item.id,
        drive_file_id: item.driveFileId ?? "",
        name: item.name,
        item_type: item.itemType,
        mime_type: item.mimeType,
        web_view_link: stripMarkdownLink(item.webViewLink) ?? null,
      })),
      parameters: {
        product_type: productType,
        product_description: productDescription,
        product_attributes: productAttributes,
        source_storage_prefix: sourceStoragePrefix,
        model_reference_url: sanitizedModelReferenceUrl ?? "",
        image_count: parseInt(imageCount, 10),
        video_seconds: parseInt(videoSeconds, 10),
        aspect_ratio: aspectRatio,
        video_resolution: videoResolution,
      },
    });

    setSubmitting(false);
    if (!response.success) {
      setAppError(response.error?.message ?? "Could not submit workflow.");
      return;
    }

    // Show success message with job ID
    if (response.data?.job_id) {
      setAppError(null);
      // Optionally show a success toast or message
      console.log("Workflow submitted successfully:", response.data.job_id);
    }

    await loadJobs(accessToken);
    setActiveTab("jobs");
  }

  if (!isSignedIn) {
    return <LoginScreen />;
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen grid-cols-[260px_minmax(0,1fr)]">
        <AppSidebar activeTab={activeTab} onTabChange={setActiveTab} />
        <section className="flex min-w-0 flex-col">
          <TopBar
            selectedItem={selectedItem}
            onRunWorkflow={submitWorkflow}
          />

          {activeTab === "browser" ? (
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0 border-r border-border">
                <DriveToolbar
                  query={query}
                  setQuery={setQuery}
                  viewMode={viewMode}
                  setViewMode={setViewMode}
                  syncing={syncing}
                  onSync={syncDrive}
                  breadcrumbs={breadcrumbs}
                  onBreadcrumbSelect={selectBreadcrumb}
                  onRefresh={() => accessToken ? void loadDrive(accessToken, currentFolder?.driveFileId ?? null) : undefined}
                />
                <div className="grid min-h-[calc(100vh-137px)] grid-cols-[240px_minmax(0,1fr)]">
                  <FolderTree
                    activeFolderDriveId={currentFolder?.driveFileId ?? null}
                    folders={folders}
                    onRootSelect={() => selectBreadcrumb(0)}
                    onFolderSelect={openFolder}
                  />
                  <DriveContent
                    items={filteredItems}
                    selectedItem={selectedItem}
                    onSelect={toggleSelected}
                    onPreview={setPreviewItem}
                    onOpen={openDriveItem}
                    viewMode={viewMode}
                    loading={loadingDrive}
                    error={appError}
                  />
                </div>
              </div>
              <PreviewDrawer
                item={previewItem}
                selectedItem={selectedItem}
                productType={productType}
                setProductType={setProductType}
                productDescription={productDescription}
                setProductDescription={setProductDescription}
                productAttributes={productAttributes}
                setProductAttributes={setProductAttributes}
                sourceStoragePrefix={sourceStoragePrefix}
                setSourceStoragePrefix={setSourceStoragePrefix}
                modelReferenceUrl={modelReferenceUrl}
                setModelReferenceUrl={setModelReferenceUrl}
                imageCount={imageCount}
                setImageCount={setImageCount}
                videoSeconds={videoSeconds}
                setVideoSeconds={setVideoSeconds}
                aspectRatio={aspectRatio}
                setAspectRatio={setAspectRatio}
                videoResolution={videoResolution}
                setVideoResolution={setVideoResolution}
                submitting={submitting}
                onSubmit={submitWorkflow}
                onAccessUrl={async (fileId) => {
                  if (!accessToken) return;
                  const item = items.find((candidate) => candidate.id === fileId);
                  if (item?.webViewLink) {
                    window.open(item.webViewLink, "_blank", "noopener,noreferrer");
                    return;
                  }
                  const response = await platformApi.getAccessUrl(accessToken, fileId);
                  if (!response.success) {
                    setAppError(response.error?.message ?? "Could not create signed URL.");
                    return;
                  }
                  if (response.data?.url) {
                    window.open(response.data.url, "_blank", "noopener,noreferrer");
                  } else {
                    setAppError("File must be materialized before a temporary URL can be created.");
                  }
                }}
                onMaterialize={async (fileId) => {
                  if (!accessToken) return;
                  const response = await platformApi.materializeFile(accessToken, fileId);
                  if (!response.success) {
                    setAppError(response.error?.message ?? "Could not queue materialization.");
                  }
                }}
              />
            </div>
          ) : null}

          {activeTab === "jobs" ? (
            <JobsPage
              activeJob={activeJob}
              jobs={jobs}
              loading={loadingJobs}
              onSelectJob={setActiveJob}
            />
          ) : null}

          {activeTab === "final" ? (
            <FinalPage
              files={finalFiles}
              runs={finalRuns}
              loading={finalLoading}
              error={finalError}
              dateFilter={dateFilter}
              setDateFilter={setDateFilter}
              customFromDate={customFromDate}
              setCustomFromDate={setCustomFromDate}
              customToDate={customToDate}
              setCustomToDate={setCustomToDate}
              onRefresh={() => accessToken ? void loadFinalFiles(accessToken) : undefined}
            />
          ) : null}

          {activeTab === "settings" ? <SettingsPage /> : null}
        </section>
      </div>
    </main>
  );
}

function LoginScreen() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function signIn() {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) {
      setErrorMessage(
        "Missing NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/NEXT_PUBLIC_SUPABASE_ANON_KEY.",
      );
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    const response = await platformApi.login(identifier, password);

    if (!response.success || !response.data?.session) {
      setLoading(false);
      setErrorMessage(response.error?.message ?? "Could not sign in.");
      return;
    }

    const { error } = await supabase.auth.setSession({
      access_token: response.data.session.access_token,
      refresh_token: response.data.session.refresh_token,
    });
    setLoading(false);

    if (error) {
      setErrorMessage(error.message);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <section className="w-full max-w-[420px] rounded-lg border border-border bg-card p-6 shadow-soft">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <HardDrive className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Google Drive Media Workflow</h1>
            <p className="text-sm text-muted-foreground">Supabase + n8n backend</p>
          </div>
        </div>
        <div className="space-y-3">
          <Input
            placeholder="Username or email"
            type="text"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
          />
          <Input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {errorMessage ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {errorMessage}
            </div>
          ) : null}
          <Button className="w-full" disabled={loading || !identifier || !password} onClick={signIn}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            Sign in
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Development admin: admin / admin</p>
        <div className="mt-6 grid gap-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Google credentials stay in backend
          </div>
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-primary" />
            Frontend only talks to Supabase
          </div>
        </div>
      </section>
    </main>
  );
}

function AppSidebar({
  activeTab,
  onTabChange,
}: {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
}) {
  const nav = [
    { id: "browser" as const, label: "Drive Browser", icon: HardDrive },
    { id: "jobs" as const, label: "Workflow Jobs", icon: Workflow },
    { id: "final" as const, label: "Final Output", icon: ImageIcon },
  ];

  return (
    <aside className="border-r border-border bg-card">
      <div className="flex h-16 items-center gap-3 border-b border-border px-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Cloud className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">Media Workflow</div>
          <div className="truncate text-xs text-muted-foreground">Supabase + n8n backend</div>
        </div>
      </div>
      <nav className="space-y-1 p-3">
        {nav.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={cn(
                "flex h-10 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors",
                activeTab === item.id
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
              onClick={() => onTabChange(item.id)}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function TopBar({
  selectedItem,
  onRunWorkflow,
}: {
  selectedItem: DriveItem | null;
  onRunWorkflow: () => void;
}) {
  return (
    <header className="flex h-16 items-center justify-between border-b border-border bg-card px-5">
      <div>
        <h2 className="text-base font-semibold">Creative source media</h2>
        <p className="text-xs text-muted-foreground">
          {selectedItem ? `${selectedItem.itemType === 'FOLDER' ? 'Folder' : 'File'} selected: ${selectedItem.name}` : 'Select a file or folder to generate media'}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm">
          <BellRing className="h-4 w-4" />
          Events
        </Button>
        <Button size="sm" disabled={!selectedItem} onClick={onRunWorkflow}>
          <Sparkles className="h-4 w-4" />
          Generate Media
        </Button>
      </div>
    </header>
  );
}

function DriveToolbar({
  query,
  setQuery,
  viewMode,
  setViewMode,
  syncing,
  onSync,
  breadcrumbs,
  onBreadcrumbSelect,
  onRefresh,
}: {
  query: string;
  setQuery: (value: string) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  syncing: boolean;
  onSync: () => void;
  breadcrumbs: FolderCrumb[];
  onBreadcrumbSelect: (index: number) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-[72px] items-center justify-between border-b border-border px-5">
      <div className="min-w-0">
        <div className="flex max-w-[460px] items-center gap-1 overflow-hidden text-sm text-muted-foreground">
          {breadcrumbs.map((crumb, index) => (
            <div key={`${crumb.driveFileId ?? "root"}-${index}`} className="flex min-w-0 items-center gap-1">
              {index > 0 ? <ChevronRight className="h-3 w-3 shrink-0" /> : null}
              <button
                className={cn(
                  "truncate rounded-sm px-1 py-0.5 hover:bg-secondary hover:text-foreground",
                  index === breadcrumbs.length - 1 && "font-medium text-foreground",
                )}
                onClick={() => onBreadcrumbSelect(index)}
              >
                {crumb.name}
              </button>
            </div>
          ))}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">Folders open in-place · files preview on the right</div>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative w-[280px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search files"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button variant="outline" size="icon" onClick={onSync} title="Sync Drive">
          {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderSync className="h-4 w-4" />}
        </Button>
        <Button variant="outline" size="icon" title="Refresh" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" />
        </Button>
        <div className="flex rounded-md border border-border bg-background p-0.5">
          <Button
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            size="icon"
            onClick={() => setViewMode("grid")}
            title="Grid view"
          >
            <Grid2X2 className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "list" ? "secondary" : "ghost"}
            size="icon"
            onClick={() => setViewMode("list")}
            title="List view"
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function FolderTree({
  activeFolderDriveId,
  folders,
  onRootSelect,
  onFolderSelect,
}: {
  activeFolderDriveId: string | null;
  folders: DriveItem[];
  onRootSelect: () => void;
  onFolderSelect: (folder: DriveItem) => void;
}) {
  return (
    <aside className="border-r border-border bg-secondary/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-muted-foreground">Folders</span>
      </div>
      <button
        onClick={onRootSelect}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-background",
          activeFolderDriveId === null ? "bg-background font-medium text-primary" : "",
        )}
        style={{ paddingLeft: 8 }}
      >
        <Folder className="h-4 w-4 text-amber-600" />
        <span className="truncate">Root folder</span>
      </button>
      {folders.map((folder) => (
        <button
          key={folder.id}
          onClick={() => onFolderSelect(folder)}
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-background",
            activeFolderDriveId === folder.driveFileId ? "bg-background font-medium text-primary" : "",
          )}
          style={{ paddingLeft: 8 + 14 }}
        >
          <Folder className="h-4 w-4 text-amber-600" />
          <span className="truncate">{folder.name}</span>
        </button>
      ))}
    </aside>
  );
}

function DriveContent({
  items,
  selectedItem,
  onSelect,
  onPreview,
  onOpen,
  viewMode,
  loading,
  error,
}: {
  items: DriveItem[];
  selectedItem: DriveItem | null;
  onSelect: (id: string) => void;
  onPreview: (item: DriveItem) => void;
  onOpen: (item: DriveItem) => void;
  viewMode: ViewMode;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <section className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4 p-5">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="h-[250px] animate-pulse rounded-md border border-border bg-card">
            <div className="h-36 bg-muted" />
            <div className="space-y-3 p-3">
              <div className="h-4 rounded-sm bg-muted" />
              <div className="h-4 w-2/3 rounded-sm bg-muted" />
              <div className="h-6 rounded-sm bg-muted" />
            </div>
          </div>
        ))}
      </section>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center p-10">
        <div className="max-w-md rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <CircleAlert className="mb-2 h-4 w-4" />
          {error}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex items-center justify-center p-10">
        <div className="max-w-md rounded-md border border-dashed border-border p-6 text-center">
          <FolderSync className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <div className="font-medium">No Drive metadata yet</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Run Drive Sync to load Google Drive metadata into Supabase.
          </p>
        </div>
      </div>
    );
  }

  return (
    <section className="min-w-0 p-5">
      {viewMode === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
          {items.map((item) => (
            <MediaCard
              key={item.id}
              item={item}
              selected={selectedItem?.id === item.id}
              onSelect={() => onSelect(item.id)}
              onPreview={() => onPreview(item)}
              onOpen={() => onOpen(item)}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          {items.map((item) => (
            <MediaRow
              key={item.id}
              item={item}
              selected={selectedItem?.id === item.id}
              onSelect={() => onSelect(item.id)}
              onPreview={() => onPreview(item)}
              onOpen={() => onOpen(item)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MediaCard({
  item,
  selected,
  onSelect,
  onPreview,
  onOpen,
}: {
  item: DriveItem;
  selected: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onOpen: () => void;
}) {
  const Icon = typeIcon[item.itemType];

  return (
    <article className={cn("relative overflow-hidden rounded-md border border-border bg-card shadow-sm", selected && "ring-2 ring-primary")}>
      <button className="relative block aspect-[4/3] w-full bg-secondary" onClick={onOpen}>
        {item.thumbnailUrl ? (
          <Image src={item.thumbnailUrl} alt="" fill sizes="260px" className="object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Icon className="h-10 w-10 text-muted-foreground" />
          </div>
        )}
      </button>
      <button
        className={cn(
          "absolute left-3 top-3 flex h-5 w-5 items-center justify-center rounded-sm border bg-card",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        title={item.itemType === "FOLDER" ? "Select folder" : "Select file"}
      >
        {selected ? <Check className="h-3.5 w-3.5" /> : null}
      </button>
      <div className="space-y-3 p-3">
        <button className="line-clamp-2 min-h-10 text-left text-sm font-medium" onClick={onOpen}>
          {item.name}
        </button>
        {item.treePath && item.treePath.length > 1 ? (
          <div className="truncate text-xs text-muted-foreground" title={item.treePath.join(" / ")}>
            {item.treePath.slice(0, -1).join(" / ")}
          </div>
        ) : null}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{formatBytes(item.sizeBytes)}</span>
          <Badge variant={item.cacheStatus === "CACHED" ? "success" : "neutral"}>{item.cacheStatus}</Badge>
        </div>
        <div className="flex items-center justify-between">
          <Badge variant={item.syncStatus === "STALE" ? "warning" : "success"}>{item.syncStatus}</Badge>
          <Button variant="ghost" size="icon" title="Preview metadata" onClick={onPreview}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </article>
  );
}

function MediaRow(props: {
  item: DriveItem;
  selected: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onOpen: () => void;
}) {
  const Icon = typeIcon[props.item.itemType];

  return (
    <div className={cn("grid grid-cols-[40px_minmax(0,1fr)_130px_120px_120px_44px] items-center border-b border-border px-3 py-2.5 last:border-b-0", props.selected && "bg-primary/5")}>
      <button
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded-sm border",
          props.selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
        onClick={(e) => {
          e.stopPropagation();
          props.onSelect();
        }}
        title={props.item.itemType === "FOLDER" ? "Select folder" : "Select file"}
      >
        {props.selected ? <Check className="h-3.5 w-3.5" /> : null}
      </button>
      <button
        className="flex min-w-0 items-center gap-3 text-left"
        onClick={props.onOpen}
        style={{ paddingLeft: Math.min(props.item.treeDepth ?? 0, 8) * 14 }}
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{props.item.name}</span>
          {props.item.treePath && props.item.treePath.length > 1 ? (
            <span className="block truncate text-xs text-muted-foreground">
              {props.item.treePath.slice(0, -1).join(" / ")}
            </span>
          ) : null}
        </span>
      </button>
      <span className="text-xs text-muted-foreground">{props.item.itemType}</span>
      <span className="text-xs text-muted-foreground">{formatBytes(props.item.sizeBytes)}</span>
      <span className="text-xs text-muted-foreground">{formatDate(props.item.modifiedTime)}</span>
      <Button variant="ghost" size="icon" title="Preview metadata" onClick={props.onPreview}>
        <MoreHorizontal className="h-4 w-4" />
      </Button>
    </div>
  );
}

function PreviewDrawer({
  item,
  selectedItem,
  productType,
  setProductType,
  productDescription,
  setProductDescription,
  productAttributes,
  setProductAttributes,
  sourceStoragePrefix,
  setSourceStoragePrefix,
  modelReferenceUrl,
  setModelReferenceUrl,
  imageCount,
  setImageCount,
  videoSeconds,
  setVideoSeconds,
  aspectRatio,
  setAspectRatio,
  videoResolution,
  setVideoResolution,
  submitting,
  onSubmit,
  onAccessUrl,
  onMaterialize,
}: {
  item: DriveItem | null;
  selectedItem: DriveItem | null;
  productType: string;
  setProductType: (value: string) => void;
  productDescription: string;
  setProductDescription: (value: string) => void;
  productAttributes: string;
  setProductAttributes: (value: string) => void;
  sourceStoragePrefix: string;
  setSourceStoragePrefix: (value: string) => void;
  modelReferenceUrl: string;
  setModelReferenceUrl: (value: string) => void;
  imageCount: string;
  setImageCount: (value: string) => void;
  videoSeconds: string;
  setVideoSeconds: (value: string) => void;
  aspectRatio: string;
  setAspectRatio: (value: string) => void;
  videoResolution: string;
  setVideoResolution: (value: string) => void;
  submitting: boolean;
  onSubmit: () => void;
  onAccessUrl: (fileId: string) => void;
  onMaterialize: (fileId: string) => void;
}) {
  if (!selectedItem) {
    return (
      <aside className="bg-card p-5">
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          Select a file or folder to configure media generation.
        </div>
      </aside>
    );
  }

  return (
    <aside className="overflow-auto bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {selectedItem.itemType === "FOLDER" ? "Folder Selection" : "File Selection"}
        </h3>
        <Button variant="ghost" size="icon" title="Close preview">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Selected Item Info */}
      <div className="mb-4 rounded-md border border-border p-3">
        <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Selected Item</div>
        <div className="font-medium">{selectedItem.name}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {selectedItem.itemType === "FOLDER" ? "Folder" : selectedItem.itemType} · {selectedItem.itemType === "FOLDER" ? "Contains all descendant files" : "Single file"}
        </div>
      </div>

      {/* Generation Form */}
      <div className="space-y-4">
        <div>
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4" />
            Media Generation Parameters
          </div>

          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Product Type *</label>
              <Select value={productType} onChange={(e) => setProductType(e.target.value)}>
                <option value="hat">Hat</option>
                <option value="shawl">Shawl</option>
                <option value="umbrella">Umbrella</option>
                <option value="cape">Cape</option>
              </Select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Product Description</label>
              <Textarea
                placeholder="Optional product description..."
                value={productDescription}
                onChange={(e) => setProductDescription(e.target.value)}
                rows={2}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Product Attributes</label>
              <Textarea
                placeholder="Optional product attributes..."
                value={productAttributes}
                onChange={(e) => setProductAttributes(e.target.value)}
                rows={2}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Source Storage Prefix *</label>
              <Input
                value={sourceStoragePrefix}
                onChange={(e) => setSourceStoragePrefix(e.target.value)}
                placeholder="google-drive/01_New_Product_Raw/..."
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Model Reference URL</label>
              <Input
                value={modelReferenceUrl}
                onChange={(e) => setModelReferenceUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Image Count *</label>
                <Select value={imageCount} onChange={(e) => setImageCount(e.target.value)}>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                </Select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Video Seconds *</label>
                <Select value={videoSeconds} onChange={(e) => setVideoSeconds(e.target.value)}>
                  <option value="5">5</option>
                  <option value="8">8</option>
                  <option value="10">10</option>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Aspect Ratio *</label>
                <Select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
                  <option value="9:16">9:16</option>
                  <option value="1:1">1:1</option>
                  <option value="16:9">16:9</option>
                </Select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Video Resolution *</label>
                <Select value={videoResolution} onChange={(e) => setVideoResolution(e.target.value)}>
                  <option value="480p">480p</option>
                  <option value="720p">720p</option>
                </Select>
              </div>
            </div>
          </div>
        </div>

        <Button className="w-full" disabled={submitting} onClick={onSubmit}>
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          {submitting ? "Submitting..." : "Generate Media"}
        </Button>

        {/* File Preview (if a file is selected) */}
        {item && item.itemType !== "FOLDER" ? (
          <>
            <div className="border-t border-border pt-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <File className="h-4 w-4" />
                File Preview
              </div>
              <div className="relative mb-4 aspect-video overflow-hidden rounded-md bg-secondary">
                {item.thumbnailUrl ? (
                  <Image src={item.thumbnailUrl} alt="" fill sizes="360px" className="object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <File className="h-10 w-10 text-muted-foreground" />
                  </div>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <div className="text-base font-semibold">{item.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{item.mimeType}</div>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Info label="Size" value={formatBytes(item.sizeBytes)} />
                  <Info label="Type" value={item.itemType} />
                  <Info label="Drive modified" value={formatDate(item.modifiedTime)} />
                  <Info label="Synced" value={formatDate(item.syncedAt)} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={() => onAccessUrl(item.id)}>
                    <Link className="h-4 w-4" />
                    Temp URL
                  </Button>
                  <Button variant="outline" onClick={() => onMaterialize(item.id)}>
                    <Download className="h-4 w-4" />
                    Materialize
                  </Button>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-medium">{value}</div>
    </div>
  );
}

function JobsPage({
  activeJob,
  jobs,
  loading,
  onSelectJob,
}: {
  activeJob: WorkflowJob | null;
  jobs: WorkflowJob[];
  loading: boolean;
  onSelectJob: (job: WorkflowJob) => void;
}) {
  return (
    <div className="grid flex-1 grid-cols-[minmax(0,1fr)_360px]">
      <section className="min-w-0 p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Workflow Jobs</h2>
            <p className="text-sm text-muted-foreground">Realtime-ready status tracking from Supabase</p>
          </div>
          <Badge variant="info">
            <Activity className="mr-1 h-3.5 w-3.5" />
            Subscribed
          </Badge>
        </div>
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <div className="grid grid-cols-[110px_160px_150px_140px_120px_120px] border-b border-border px-4 py-3 text-xs font-semibold uppercase text-muted-foreground">
            <span>Job ID</span>
            <span>Workflow</span>
            <span>Status</span>
            <span>Progress</span>
            <span>Files</span>
            <span>Created</span>
          </div>
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading workflow jobs...</div>
          ) : null}
          {!loading && jobs.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No workflow jobs yet. Select files in Drive Browser and run a workflow.
            </div>
          ) : null}
          {jobs.map((job) => (
            <button
              key={job.id}
              className={cn(
                "grid w-full grid-cols-[110px_160px_150px_140px_120px_120px] items-center border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-secondary",
                activeJob?.id === job.id && "bg-primary/5",
              )}
              onClick={() => onSelectJob(job)}
            >
              <span className="font-mono text-xs">{job.id}</span>
              <span className="truncate text-sm font-medium">{job.workflowType}</span>
              <Badge variant={statusVariant[job.status]}>{job.status}</Badge>
              <div className="pr-4">
                <Progress value={job.progress} />
              </div>
              <span className="text-sm text-muted-foreground">{job.inputFiles}</span>
              <span className="text-xs text-muted-foreground">{formatDate(job.createdAt)}</span>
            </button>
          ))}
        </div>
      </section>
      <JobDetail job={activeJob} />
    </div>
  );
}

function JobDetail({ job }: { job: WorkflowJob | null }) {
  if (!job) {
    return (
      <aside className="border-l border-border bg-card p-5">
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          Select a workflow job to inspect its timeline.
        </div>
      </aside>
    );
  }

  const steps: WorkflowStatus[] = ["QUEUED", "PROCESSING", "WAITING_EXTERNAL", "COMPLETED"];

  return (
    <aside className="border-l border-border bg-card p-5">
      <div className="mb-4">
        <Badge variant={statusVariant[job.status]}>{job.status}</Badge>
        <h3 className="mt-3 text-lg font-semibold">{job.workflowType}</h3>
        <p className="font-mono text-xs text-muted-foreground">{job.id}</p>
      </div>
      <Progress value={job.progress} className="mb-5" />
      <div className="space-y-4">
        {steps.map((step) => (
          <div key={step} className="flex items-center gap-3">
            <div
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full border",
                step === job.status || job.status === "COMPLETED"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground",
              )}
            >
              <Check className="h-3.5 w-3.5" />
            </div>
            <div>
              <div className="text-sm font-medium">{step}</div>
              <div className="text-xs text-muted-foreground">Async n8n workflow checkpoint</div>
            </div>
          </div>
        ))}
      </div>
      {job.status === "FAILED" ? (
        <div className="mt-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <CircleAlert className="mb-2 h-4 w-4" />
          {job.errorMessage}
        </div>
      ) : null}
    </aside>
  );
}

function FinalPage({
  files,
  runs,
  loading,
  error,
  dateFilter,
  setDateFilter,
  customFromDate,
  setCustomFromDate,
  customToDate,
  setCustomToDate,
  onRefresh,
}: {
  files: FinalFile[];
  runs: FinalRun[];
  loading: boolean;
  error: string | null;
  dateFilter: FinalDateFilter;
  setDateFilter: (filter: FinalDateFilter) => void;
  customFromDate: string;
  setCustomFromDate: (value: string) => void;
  customToDate: string;
  setCustomToDate: (value: string) => void;
  onRefresh: () => void;
}) {
  const latestRun = runs[0];
  const filterOptions: Array<{ id: FinalDateFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "today", label: "Today" },
    { id: "7days", label: "Last 7 days" },
    { id: "30days", label: "Last 30 days" },
    { id: "custom", label: "Custom" },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-auto p-5">
      <div className="mb-5">
        <h2 className="text-lg font-semibold">Final</h2>
        <p className="text-sm text-muted-foreground">Generated files in BAartworkShopify / baartwork / runs</p>
      </div>

      <div className="mb-5 grid grid-cols-3 gap-4">
        <div className="rounded-md border border-border bg-card p-4">
          <div className="text-2xl font-semibold">{files.length}</div>
          <div className="text-xs text-muted-foreground">Total files</div>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <div className="text-2xl font-semibold">{runs.length}</div>
          <div className="text-xs text-muted-foreground">Total runs</div>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <div className="truncate text-2xl font-semibold" title={latestRun?.run_id}>
            {latestRun ? latestRun.run_id.slice(0, 8) : "-"}
          </div>
          <div className="text-xs text-muted-foreground">
            {latestRun ? `${latestRun.file_count} latest run files` : "Latest run"}
          </div>
        </div>
      </div>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Date</span>
          <div className="flex rounded-md border border-border bg-background p-0.5">
            {filterOptions.map((filter) => (
              <button
                key={filter.id}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  dateFilter === filter.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-secondary",
                )}
                onClick={() => setDateFilter(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          {dateFilter === "custom" ? (
            <div className="flex items-center gap-2">
              <Input
                className="w-[150px]"
                type="date"
                value={customFromDate}
                onChange={(event) => setCustomFromDate(event.target.value)}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                className="w-[150px]"
                type="date"
                value={customToDate}
                onChange={(event) => setCustomToDate(event.target.value)}
              />
            </div>
          ) : null}
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>

      {error ? (
        <div className="flex items-center justify-center p-10">
          <div className="max-w-md rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <CircleAlert className="mb-2 h-4 w-4" />
            {error}
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-[200px] animate-pulse rounded-md border border-border bg-card">
              <div className="h-28 bg-muted" />
              <div className="space-y-2 p-3">
                <div className="h-4 rounded-sm bg-muted" />
                <div className="h-4 w-2/3 rounded-sm bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {!loading && !error && files.length === 0 ? (
        <div className="flex items-center justify-center p-10">
          <div className="max-w-md rounded-md border border-dashed border-border p-6 text-center">
            <ImageIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <div className="font-medium">No generated files yet</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Run media generation workflows to create output files in Supabase Storage.
            </p>
          </div>
        </div>
      ) : null}

      {!loading && !error && files.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <div className="grid grid-cols-[82px_minmax(180px,1.4fr)_minmax(180px,1fr)_140px_120px_96px] border-b border-border bg-secondary/60 px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
            <span>Preview</span>
            <span>Name</span>
            <span>Run</span>
            <span>Updated</span>
            <span>Size</span>
            <span>Action</span>
          </div>
          {files.map((file) => (
            <FinalFileRow
              key={file.path}
              file={file}
              onOpen={() => {
                if (file.signed_url) {
                  window.open(file.signed_url, "_blank", "noopener,noreferrer");
                }
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FinalFileRow({ file, onOpen }: { file: FinalFile; onOpen: () => void }) {
  const isImage = file.mime_type?.startsWith("image/");
  const isVideo = file.mime_type?.startsWith("video/");

  return (
    <div className="grid grid-cols-[82px_minmax(180px,1.4fr)_minmax(180px,1fr)_140px_120px_96px] items-center border-b border-border px-3 py-2.5 last:border-b-0">
      <button className="relative block h-14 w-14 overflow-hidden rounded-md bg-secondary" onClick={onOpen}>
        {isImage && file.signed_url ? (
          <Image src={file.signed_url} alt="" fill sizes="56px" className="object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            {isVideo ? <Film className="h-5 w-5 text-muted-foreground" /> : <ImageIcon className="h-5 w-5 text-muted-foreground" />}
          </div>
        )}
      </button>
      <div className="min-w-0 pr-3">
        <button className="block truncate text-left text-sm font-medium hover:text-primary" onClick={onOpen} title={file.name}>
          {file.name}
        </button>
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={file.path}>
          {file.path}
        </div>
      </div>
      <div className="min-w-0 pr-3">
        <div className="truncate font-mono text-xs" title={file.run_id}>
          {file.run_id}
        </div>
      </div>
      <span className="text-xs text-muted-foreground">{formatDate(file.updated_at)}</span>
      <span className="text-xs text-muted-foreground">{formatBytes(file.size_bytes)}</span>
      <Button variant="outline" size="sm" onClick={onOpen} disabled={!file.signed_url}>
        <Download className="h-4 w-4" />
        Open
      </Button>
    </div>
  );
}

function SettingsPage() {
  return (
    <section className="flex-1 overflow-auto p-5">
      <div className="mb-5">
        <h2 className="text-lg font-semibold">Integration Settings</h2>
        <p className="text-sm text-muted-foreground">Server-side credentials and webhook contracts</p>
      </div>
      <div className="grid max-w-5xl grid-cols-2 gap-4">
        <SettingPanel
          icon={Database}
          title="Supabase API Gateway"
          rows={[
            ["Auth", "Supabase Auth"],
            ["Realtime", "workflow_jobs updates"],
            ["Storage bucket", "temp-media private"],
          ]}
        />
        <SettingPanel
          icon={Workflow}
          title="n8n Workflows"
          rows={[
            ["Drive sync", "drive-sync workflow"],
            ["Media generation", "vcxyqTKCJW29xmWQ"],
            ["Orchestration", "Supabase Edge Functions"],
          ]}
        />
        <SettingPanel
          icon={KeyRound}
          title="Private Credentials"
          rows={[
            ["n8n callback auth", "Server only"],
            ["Supabase admin key", "Edge Functions only"],
            ["Google OAuth", "n8n only"],
          ]}
        />
        <SettingPanel
          icon={ShieldCheck}
          title="External API"
          rows={[
            ["File metadata", "GET /files/{file_id}"],
            ["Access URL", "POST /files/{file_id}/access-url"],
            ["Signed URL TTL", "600 seconds"],
          ]}
        />
      </div>
    </section>
  );
}

function SettingPanel({
  icon: Icon,
  title,
  rows,
}: {
  icon: typeof Database;
  title: string;
  rows: [string, string][];
}) {
  return (
    <article className="rounded-md border border-border bg-card p-4">
      <div className="mb-4 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="font-semibold">{title}</h3>
      </div>
      <div className="space-y-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="truncate font-medium">{value}</span>
          </div>
        ))}
      </div>
    </article>
  );
}
