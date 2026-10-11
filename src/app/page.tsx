"use client";

import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Database,
  Download,
  File,
  FileImage,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Home as HomeIcon,
  FolderSync,
  Grid2X2,
  HardDrive,
  KeyRound,
  Link,
  List,
  Loader2,
  LogOut,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RefreshCw,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Workflow,
  X,
  ImageIcon,
} from "lucide-react";
import Image from "next/image";
import { workflowErrorMessage } from "@/lib/utils/workflow-error";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoginScreen } from "@/components/auth/login-screen";
import { FolderGlyph } from "@/components/ui/folder-glyph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkflowProgress, WorkflowStatusBadge } from "@/components/ui/workflow-status";
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
  JobFolderRun,
  WorkflowJob,
  ModelLibraryItem,
} from "@/types/domain";

type ViewMode = "grid" | "list";
type WorkspaceTab = "browser" | "model" | "jobs" | "final" | "settings";
type FolderCrumb = {
  driveItemId: string | null;
  storagePath?: string | null;
  name: string;
  key?: string;
};

type FolderMeta = {
  name: string;
  driveItemId: string | null;
  storagePath?: string | null;
};

const DEFAULT_CONNECTION_ID = "00000000-0000-0000-0000-000000000000";
const DRIVE_ROOT_FOLDER_ID = "1vP62rBKIsfZGPZy7TXHsRwQLdO7pJ4W2";
// Generated output root (output_config.folder_id → "02_AI_PROCESSING").
const FINAL_ROOT_FOLDER_ID = "1RFEes48Mrjcxq5axaifu-i-OmChch6Bb";
const FINAL_ROOT_FOLDER_NAME = "02_AI_PROCESSING";
// Model reference library on Google Drive (n8n Production_07).
const MODEL_LIBRARY_ROOT_ID = "1lyx87c6tZPE74wHnahta2ByvxR8u52l-";
const MODEL_LIBRARY_MAX_BYTES = 15 * 1024 * 1024;

// Model tab — Supabase Storage constants
// Storage folder mirroring the Drive root (see drive-list-folder DEFAULT_ROOT_PATH)
const DRIVE_STORAGE_ROOT = "google-drive/01_New_Product_Raw";

const typeIcon: Record<DriveItemType, typeof File> = {
  FOLDER: Folder,
  IMAGE: FileImage,
  VIDEO: Film,
  DOCUMENT: FileText,
  OTHER: File,
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

const PREVIEW_PANEL_STORAGE_KEY = "drive.previewPanel";

type OutputType = "image" | "video" | "both";

// The n8n contract (BR-19) still always produces images + a video, so only
// "both" is selectable until the workflow honours output_type.
const OUTPUT_TYPE_OPTIONS: { value: OutputType; label: string; available: boolean }[] = [
  { value: "image", label: "Image", available: false },
  { value: "video", label: "Video", available: false },
  { value: "both", label: "Both", available: true },
];

/** Reference images must be direct public HTTPS image URLs the provider can fetch. */
function validateReferenceImageUrl(label: string, value: string | null): string | null {
  if (!value) return null;
  if (value.length > 2048) return `${label} must be at most 2048 characters.`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${label} must be a valid URL.`;
  }
  if (url.protocol !== "https:") return `${label} must be a public HTTPS link.`;
  // Drive direct links (uc?export=view&id=…) from the model library are fine; preview pages are not.
  const isDriveDirectLink = url.hostname === "drive.google.com" && url.pathname === "/uc" && url.searchParams.has("id");
  if (/(^|\.)(drive|docs)\.google\.com$/.test(url.hostname) && !isDriveDirectLink) {
    return `${label} must link directly to an image, not a Google Drive preview.`;
  }
  return null;
}

type ProductTypeOption = { value: string; label: string; category?: string };

// Fallback until baartwork_segformer_profiles loads (or if it cannot be read).
const DEFAULT_PRODUCT_TYPE_OPTIONS: ProductTypeOption[] = ["cape", "hat", "shawl", "umbrella"].map((value) => ({
  value,
  label: formatProductTypeLabel(value),
}));

function formatProductTypeLabel(productType: string): string {
  return productType
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getFolderKeyFromItem(item: DriveItem): string {
  return item.connectionId === "storage" ? item.driveItemId ?? item.id : item.driveItemId ?? item.id;
}

function getFolderKey(folderDriveId: string | null = null, storagePath: string | null = null): string {
  return storagePath ?? folderDriveId ?? "root";
}

/** Single click previews, double click (or Enter) opens. */
function previewOpenHandlers(onPreview: () => void, onOpen: () => void) {
  return {
    onClick: onPreview,
    onDoubleClick: onOpen,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onOpen();
      }
    },
  };
}

export default function Home() {
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("browser");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DriveItem[]>([]);
  const [currentFolder, setCurrentFolder] = useState<DriveItem | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<FolderCrumb[]>([{ driveItemId: null, name: "Root folder" }]);
  const [currentFolderKey, setCurrentFolderKey] = useState("root");
  const currentFolderKeyRef = useRef("root");
  const driveRequestIdRef = useRef(0);
  const [folderChildren, setFolderChildren] = useState<Record<string, DriveItem[]>>({});
  const [folderParent, setFolderParent] = useState<Record<string, string>>({});
  const [folderMeta, setFolderMeta] = useState<Record<string, FolderMeta>>({
    root: { name: "Root folder", driveItemId: null, storagePath: null },
  });
  const folderParentRef = useRef<Record<string, string>>({});
  const folderMetaRef = useRef<Record<string, FolderMeta>>({
    root: { name: "Root folder", driveItemId: null, storagePath: null },
  });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["root"]));
  const [loadingFolderKeys, setLoadingFolderKeys] = useState<Set<string>>(() => new Set());
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);
  const [selectedItem, setSelectedItem] = useState<DriveItem | null>(null);
  const [previewItem, setPreviewItem] = useState<DriveItem | null>(null);
  const [activeJob, setActiveJob] = useState<WorkflowJob | null>(null);
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [jobsNotice, setJobsNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [loadingDrive, setLoadingDrive] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);

  // Model Reference picker (Google Drive model library via n8n)
  const [driveModelPickerOpen, setDriveModelPickerOpen] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Generation form state
  const syncedFolderIdsRef = useRef(new Set<string>());
  const [previewPanelOpen, setPreviewPanelOpen] = useState(true);
  const [productType, setProductType] = useState("cape");
  const [productTypeOptions, setProductTypeOptions] = useState<ProductTypeOption[]>(DEFAULT_PRODUCT_TYPE_OPTIONS);
  const [productDescription, setProductDescription] = useState("");
  const [sample_prompt, setSamplePrompt] = useState("");
  const [sourceStoragePrefix, setSourceStoragePrefix] = useState("google-drive/01_New_Product_Raw/ARTIC WIDE LAPEL");
  const [modelReferenceUrl, setModelReferenceUrl] = useState("");
  const [styleReferenceUrl, setStyleReferenceUrl] = useState("");
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const [outputType, setOutputType] = useState<OutputType>("both");
  const [imageCount, setImageCount] = useState("4");
  const [videoSeconds, setVideoSeconds] = useState("8");
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [videoResolution, setVideoResolution] = useState("480p");

  // Final files state

  const folders = useMemo(() => items.filter((i) => i.itemType === "FOLDER" && !isHiddenDrivePlaceholder(i)), [items]);

  const filteredItems = useMemo(() => {
    const result = items.filter((item) => !isHiddenDrivePlaceholder(item));
    const normalized = query.trim().toLowerCase();
    if (!normalized) return result;
    return result.filter((item) => item.name.toLowerCase().includes(normalized));
  }, [items, query]);

  const driveSummary = useMemo(() => {
    const folderCount = filteredItems.filter((item) => item.itemType === "FOLDER").length;
    const fileCount = filteredItems.length - folderCount;
    return `${folderCount} ${folderCount === 1 ? "folder" : "folders"} · ${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  }, [filteredItems]);

  const listDriveFolder = useCallback(async (
    token: string,
    folderDriveId: string | null,
    storagePath: string | null,
  ) => {
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
      if (storagePath) {
        params.set("storage_path", storagePath);
      } else if (folderDriveId) {
        params.set("folder_id", folderDriveId);
      }

      response = await platformApi.listFolder(token, params);
      if (!response.success || !response.data) {
        return { response, items: [] as DriveItem[], folder: null as DriveItem | null };
      }

      allItems.push(...response.data.items);
      folder ??= response.data.folder;
      page += 1;
    } while (
      response.data.pagination &&
      typeof response.data.pagination === "object" &&
      "has_more" in response.data.pagination &&
      response.data.pagination.has_more === true
    );

    return {
      response,
      items: allItems.filter((item) => !isHiddenDrivePlaceholder(item)).map(normalizeDriveItem),
      folder: folder && !isHiddenDrivePlaceholder(folder) ? normalizeDriveItem(folder) : null,
    };
  }, []);

  const fetchDriveFolder = useCallback(async (
    token: string,
    folderDriveId: string | null,
    storagePath: string | null,
  ) => {
    const result = await listDriveFolder(token, folderDriveId, storagePath);
    if (
      !folderDriveId ||
      storagePath ||
      !result.response?.success ||
      result.items.length > 0 ||
      syncedFolderIdsRef.current.has(folderDriveId)
    ) {
      return result;
    }

    // Drive metadata is synced one folder level at a time; pull this folder's
    // children on first open instead of waiting for the cron to reach it.
    syncedFolderIdsRef.current.add(folderDriveId);
    const sync = await platformApi.syncDrive(token, {
      connection_id: DEFAULT_CONNECTION_ID,
      root_folder_id: folderDriveId,
      sync_mode: "INCREMENTAL",
      recursive: false,
      max_folders: 1,
    });
    if (!sync.success) return result;

    // n8n may acknowledge the webhook before its callback has stored the items.
    for (const delayMs of [0, 2000, 4000]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const refreshed = await listDriveFolder(token, folderDriveId, storagePath);
      if (!refreshed.response?.success || refreshed.items.length > 0) return refreshed;
    }
    return result;
  }, [listDriveFolder]);

  const storeFolderChildren = useCallback((key: string, children: DriveItem[], parentName?: string) => {
    // Synced items can reference the parent folder itself; drop them to avoid tree cycles.
    const foldersOnly = children.filter((item) => item.itemType === "FOLDER" && getFolderKeyFromItem(item) !== key);
    setFolderChildren((current) => ({ ...current, [key]: foldersOnly }));
    setFolderParent((current) => {
      const next = { ...current };
      for (const child of foldersOnly) {
        next[getFolderKeyFromItem(child)] = key;
      }
      return next;
    });
    setFolderMeta((current) => {
      const next: Record<string, FolderMeta> = {
        ...current,
        root: { name: "Root folder", driveItemId: null, storagePath: null },
      };
      if (parentName || key === "root") {
        next[key] ??= { name: parentName ?? "Root folder", driveItemId: key === "root" ? null : key };
      }
      for (const child of foldersOnly) {
        const childKey = getFolderKeyFromItem(child);
        next[childKey] = {
          name: child.name,
          driveItemId: child.connectionId === "storage" ? null : child.driveItemId,
          storagePath: child.connectionId === "storage" ? child.driveItemId : null,
        };
      }
      return next;
    });
  }, []);

  useEffect(() => {
    folderParentRef.current = folderParent;
  }, [folderParent]);

  useEffect(() => {
    folderMetaRef.current = folderMeta;
  }, [folderMeta]);

  const buildCrumbs = useCallback((key: string): FolderCrumb[] => {
    const lineage: string[] = [];
    let cursor = key;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      lineage.unshift(cursor);
      if (cursor === "root") break;
      seen.add(cursor);
      cursor = folderParentRef.current[cursor] ?? "root";
    }
    if (lineage[0] !== "root") lineage.unshift("root");
    return lineage.map((crumbKey) => {
      const meta = folderMetaRef.current[crumbKey] ?? { name: crumbKey, driveItemId: crumbKey };
      return {
        key: crumbKey,
        driveItemId: meta.driveItemId,
        storagePath: meta.storagePath,
        name: meta.name,
      };
    });
  }, []);

  const expandAncestors = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      let cursor = key;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        next.add(cursor);
        if (cursor === "root") break;
        seen.add(cursor);
        cursor = folderParentRef.current[cursor] ?? "root";
      }
      next.add("root");
      return next;
    });
  }, []);

  const loadDrive = useCallback(async (
    token: string,
    folderDriveId: string | null = null,
    storagePath: string | null = null,
  ) => {
    const requestId = ++driveRequestIdRef.current;
    setLoadingDrive(true);
    setAppError(null);
    const key = getFolderKey(folderDriveId, storagePath);
    const { response, items: normalizedItems, folder: normalizedFolder } = await fetchDriveFolder(token, folderDriveId, storagePath);

    // A slower request must not send the user back to a previous folder.
    if (requestId !== driveRequestIdRef.current) return;
    setLoadingDrive(false);

    if (!response?.success || !response.data) {
      setAppError(response.error?.message ?? "Could not load Google Drive metadata from Supabase.");
      return;
    }

    const sameFolder = currentFolderKeyRef.current === key;
    currentFolderKeyRef.current = key;
    storeFolderChildren(key, normalizedItems, normalizedFolder?.name);
    setItems(normalizedItems);
    setCurrentFolder(normalizedFolder);
    setCurrentFolderKey(key);
    setBreadcrumbs(buildCrumbs(key));
    expandAncestors(key);
    setPreviewItem((current) => sameFolder && current
      ? normalizedItems.find((candidate) => candidate.id === current.id) ?? null
      : normalizedItems[0] ?? null);
    setSelectedItem((current) => sameFolder && current
      ? normalizedItems.find((candidate) => candidate.id === current.id) ?? null
      : null);
  }, [buildCrumbs, expandAncestors, fetchDriveFolder, storeFolderChildren]);



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
    // Keep the inspected batch selected across refreshes.
    setActiveJob((current) => normalizedJobs.find((job) => job.id === current?.id) ?? normalizedJobs[0] ?? null);
  }, []);


  useEffect(() => {
    try {
      if (localStorage.getItem(PREVIEW_PANEL_STORAGE_KEY) === "closed") {
        queueMicrotask(() => setPreviewPanelOpen(false));
      }
    } catch {
      // Storage unavailable (private mode etc.); keep the default.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PREVIEW_PANEL_STORAGE_KEY, previewPanelOpen ? "open" : "closed");
    } catch {
      // Ignore storage failures; the panel state is a convenience only.
    }
  }, [previewPanelOpen]);


  useEffect(() => {
    if (!isSignedIn) return;
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;

    supabase
      .from("baartwork_segformer_profiles")
      .select("product_type, category_name")
      .eq("enabled", true)
      .order("product_type")
      .then(({ data, error }) => {
        if (error || !data?.length) {
          if (error) console.error("Failed to load product types:", error.message);
          return;
        }
        const options = (data as { product_type: string; category_name: string }[]).map((row) => ({
          value: row.product_type,
          label: formatProductTypeLabel(row.product_type),
          category: row.category_name,
        }));
        setProductTypeOptions(options);
        setProductType((current) => (options.some((option) => option.value === current) ? current : options[0].value));
      });
  }, [isSignedIn]);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;

    let workspaceUserId: string | null = null;
    let initialLoadTimer: ReturnType<typeof setTimeout> | undefined;
    // INITIAL_SESSION provides the existing session too. Avoid a second,
    // competing getSession load and leave the workspace alone on token refresh.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const token = session?.access_token ?? null;
      const userId = session?.user.id ?? null;
      setAccessToken(token);
      setUserEmail(session?.user.email ?? null);
      setIsSignedIn(Boolean(token));
      if (workspaceUserId === userId) return;
      workspaceUserId = userId;
      clearTimeout(initialLoadTimer);
      ++driveRequestIdRef.current;
      currentFolderKeyRef.current = "root";
      if (!token) return;

      // Start requests after the auth callback releases the session lock.
      initialLoadTimer = setTimeout(() => {
        void loadDrive(token);
        void loadJobs(token);
      }, 0);
    });

    return () => {
      clearTimeout(initialLoadTimer);
      ++driveRequestIdRef.current;
      listener.subscription.unsubscribe();
    };
  }, [loadDrive, loadJobs]);


  // Storage path of a selected folder, used to prefill "Source Storage Prefix".
  // Prefer the path stored in DB; otherwise derive it from the open folder path.
  function folderStoragePrefix(folder: DriveItem): string {
    if (folder.storagePath) return folder.storagePath;
    const parents = breadcrumbs.slice(1).map((crumb) => crumb.name);
    return [DRIVE_STORAGE_ROOT, ...parents, folder.name].join("/");
  }

  function applySelection(item: DriveItem) {
    setSelectedItem(item);
    if (item.itemType === "FOLDER") setSourceStoragePrefix(folderStoragePrefix(item));
  }

  function toggleSelected(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    if (selectedItem?.id === id) {
      setSelectedItem(null);
      return;
    }
    applySelection(item);
  }

  // Single click on a card/row: select it (not toggle, so a double-click
  // doesn't select-then-deselect) and show it in the right panel.
  function selectAndPreview(item: DriveItem) {
    applySelection(item);
    setPreviewItem(item);
    setPreviewPanelOpen(true);
  }

  function getDescendantFiles(folderId: string): DriveItem[] {
    const folder = items.find((item) => item.id === folderId);
    if (!folder || folder.itemType !== "FOLDER") return [];

    const descendants: DriveItem[] = [];
    const queue = [folder];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = items.filter((item) => item.parentDriveItemId === current.driveItemId && !isHiddenDrivePlaceholder(item));
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
    const driveItemId = folder.driveItemId;
    if (!accessToken || !driveItemId) return;
    const storagePath = folder.connectionId === "storage" ? driveItemId : null;
    const key = getFolderKeyFromItem(folder);
    setQuery("");
    setFolderParent((current) => ({ ...current, [key]: currentFolderKey }));
    setFolderMeta((current) => ({
      ...current,
      [key]: {
        name: folder.name,
        driveItemId: folder.connectionId === "storage" ? null : driveItemId,
        storagePath,
      },
    }));
    setExpanded((current) => {
      const next = new Set(current);
      next.add(currentFolderKey);
      next.add(key);
      return next;
    });
    void loadDrive(accessToken, storagePath ? null : driveItemId, storagePath);
  }

  async function loadFolderChildren(key: string) {
    if (!accessToken || loadingFolderKeys.has(key) || folderChildren[key]) return;
    const meta = folderMeta[key];
    if (!meta) return;
    setLoadingFolderKeys((current) => new Set(current).add(key));
    const { response, items: normalizedItems } = await fetchDriveFolder(
      accessToken,
      meta.storagePath ? null : meta.driveItemId,
      meta.storagePath ?? null,
    );
    setLoadingFolderKeys((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    if (response?.success) {
      storeFolderChildren(key, normalizedItems, meta.name);
    }
  }

  function navigateFolderKey(key: string) {
    if (!accessToken) return;
    const meta = folderMeta[key];
    if (!meta) return;
    setQuery("");
    setExpanded((current) => new Set(current).add(key));
    void loadDrive(accessToken, meta.storagePath ? null : meta.driveItemId, meta.storagePath ?? null);
  }

  function toggleFolderKey(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        void loadFolderChildren(key);
      }
      next.add("root");
      return next;
    });
  }

  async function signOut() {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;

    setSigningOut(true);
    await supabase.auth.signOut();
    setSigningOut(false);

    // Clear the previous user's workspace so the next sign-in starts clean.
    setAccessToken(null);
    setUserEmail(null);
    setIsSignedIn(false);
    setActiveTab("browser");
    setViewMode("grid");
    setQuery("");
    setItems([]);
    setJobs([]);
    setCurrentFolder(null);
    setBreadcrumbs([{ driveItemId: null, name: "Root folder" }]);
    setCurrentFolderKey("root");
    setFolderChildren({});
    setFolderParent({});
    setFolderMeta({ root: { name: "Root folder", driveItemId: null, storagePath: null } });
    setExpanded(new Set(["root"]));
    setSelectedItem(null);
    setPreviewItem(null);
    setActiveJob(null);
    setAppError(null);
  }

  function switchTab(tab: WorkspaceTab) {
    setActiveTab(tab);
    // Returning to Drive Browser preserves its folder, selection and form.
  }





  function selectBreadcrumb(index: number) {
    if (!accessToken) return;
    const crumb = breadcrumbs[index];
    setQuery("");
    navigateFolderKey(crumb.key ?? getFolderKey(crumb.driveItemId, crumb.storagePath ?? null));
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
    if (currentFolder?.connectionId === "storage") {
      setFolderChildren({});
      setFolderParent({});
      setFolderMeta({ root: { name: "Root folder", driveItemId: null, storagePath: null } });
      setExpanded(new Set(["root"]));
      await loadDrive(accessToken, null, currentFolder.driveItemId);
      return;
    }
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
      root_folder_id: currentFolder?.driveItemId ?? DRIVE_ROOT_FOLDER_ID,
      sync_mode: "INCREMENTAL",
      recursive: false,
      max_folders: 1,
    };

    const response = await platformApi.syncDrive(accessToken, syncBody);

    setSyncing(false);
    if (!response.success) {
      setAppError(response.error?.message ?? "Could not trigger Drive Sync.");
      return;
    }
    setFolderChildren({});
    setFolderParent({});
    setFolderMeta({ root: { name: "Root folder", driveItemId: null, storagePath: null } });
    setExpanded(new Set(["root"]));
    await loadDrive(
      accessToken,
      currentFolder?.connectionId === "storage" ? null : currentFolder?.driveItemId ?? null,
      currentFolder?.connectionId === "storage" ? currentFolder.driveItemId : null,
    );
  }

  // Poll while the Jobs tab is open and something is still running.
  const hasActiveJobs = jobs.some((job) => job.status === "QUEUED" || job.status === "PROCESSING");
  useEffect(() => {
    if (activeTab !== "jobs" || !accessToken) return;
    if (!hasActiveJobs) return;
    const timer = setInterval(() => void loadJobs(accessToken), JOBS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [activeTab, accessToken, hasActiveJobs, loadJobs]);

  async function retryRun(runId: string, label: string) {
    if (!accessToken || retryingRunId) return;
    const confirmed = window.confirm(
      `Retry "${label}"?\n\nThis starts a new batch with the original settings and generates the images/video again (uses AI credits). Only confirm if you are sure the previous run failed.`,
    );
    if (!confirmed) return;

    setRetryingRunId(runId);
    setJobsNotice(null);
    const response = await platformApi.retryJob(accessToken, runId);
    setRetryingRunId(null);
    if (!response.success) {
      setJobsNotice({ tone: "error", text: response.error?.message ?? "Could not retry this run." });
      return;
    }
    setJobsNotice({
      tone: "success",
      text: `Retry sent for "${label}". The new batch will appear in the list in a few seconds.`,
    });
    void loadJobs(accessToken);
  }

  async function submitWorkflow() {
    if (!accessToken || !selectedItem) return;
    setSubmitNotice(null);

    // n8n needs a real Google Drive folder/file ID; Storage fallback items only carry a path.
    if (selectedItem.connectionId === "storage") {
      setAppError("Select a synced Google Drive folder or file. Storage paths cannot be sent to the workflow.");
      return;
    }

    let selectedItems: DriveItem[] = [];
    if (selectedItem.itemType === "FOLDER") {
      selectedItems = getDescendantFiles(selectedItem.id);
      // We allow submitting a folder even if we haven't loaded its descendants in the UI yet.
      // The backend workflow can fetch the descendants if needed.
    } else {
      selectedItems = [selectedItem];
    }

    // Filter out any placeholder items from submission
    selectedItems = selectedItems.filter((item) => !isHiddenDrivePlaceholder(item));

    if (selectedItems.length === 0 && selectedItem.itemType !== "FOLDER") {
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
    const sanitizedModelReferenceUrl = stripMarkdownLink(modelReferenceUrl.trim());
    const sanitizedStyleReferenceUrl = stripMarkdownLink(styleReferenceUrl.trim());
    const referenceError =
      validateReferenceImageUrl("Model Reference URL", sanitizedModelReferenceUrl) ??
      validateReferenceImageUrl("Style Reference URL", sanitizedStyleReferenceUrl);
    if (referenceError) {
      setAppError(referenceError);
      return;
    }

    // Debug logging (sanitized, no sensitive data)
    console.log("Submitting workflow:", {
      selected_items_count: selectedItems.length,
      selected_item_id: selectedItem.id,
      parameters_keys: Object.keys({
        product_type: productType,
        product_description: productDescription,
        sample_prompt: sample_prompt,
        source_storage_prefix: sourceStoragePrefix,
        model_reference_url: sanitizedModelReferenceUrl,
        output_type: outputType,
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
      root_folder_id: DRIVE_ROOT_FOLDER_ID,
      selected_item: {
        id: selectedItem.id,
        drive_item_id: selectedItem.driveItemId,
        name: selectedItem.name,
        item_type: selectedItem.itemType,
        mime_type: selectedItem.mimeType,
        parent_drive_item_id: selectedItem.parentDriveItemId,
        web_view_link: stripMarkdownLink(selectedItem.webViewLink) ?? null,
      },
      selected_items: selectedItems.map((item) => ({
        id: item.id,
        drive_item_id: item.driveItemId,
        name: item.name,
        item_type: item.itemType,
        mime_type: item.mimeType,
        web_view_link: stripMarkdownLink(item.webViewLink) ?? null,
      })),
      parameters: {
        product_type: productType,
        product_description: productDescription,
        sample_prompt: sample_prompt,
        source_storage_prefix: sourceStoragePrefix,
        model_reference_url: sanitizedModelReferenceUrl ?? "",
        style_reference_url: sanitizedStyleReferenceUrl ?? "",
        output_type: outputType,
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

    // n8n only acknowledges receipt ("Workflow got started."); it does not
    // return a job ID or wait for validation, so this is "sent", not "done".
    // Do not auto-retry: there is no idempotency key yet.
    setAppError(null);
    setSubmitNotice(
      "Sent to n8n. The workflow runs in the background — results will appear in Final Output when it finishes. Don't submit again unless you're sure the previous run failed.",
    );
    void loadJobs(accessToken);
  }

  if (!isSignedIn) {
    return <LoginScreen />;
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen grid-cols-[260px_minmax(0,1fr)]">
        <AppSidebar
          activeTab={activeTab}
          onTabChange={switchTab}
          userEmail={userEmail}
          signingOut={signingOut}
          onSignOut={() => void signOut()}
        />
        <section className="flex min-w-0 flex-col">
          <TopBar
            modelLibrary={activeTab === "model"}
            selectedItem={selectedItem}
          />

          {/* ── Drive Browser tab ─────────────────────────────────────── */}
          {activeTab === "browser" ? (
            <div
              className={cn(
                "grid min-h-0 min-w-0 flex-1",
                previewPanelOpen ? "grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_360px]" : "grid-cols-[minmax(0,1fr)]",
              )}
            >
              <div className={cn("min-w-0", previewPanelOpen && "border-r border-border")}>
                <DriveToolbar
                  previewPanelOpen={previewPanelOpen}
                  onTogglePreviewPanel={() => setPreviewPanelOpen((open) => !open)}
                  query={query}
                  setQuery={setQuery}
                  viewMode={viewMode}
                  setViewMode={setViewMode}
                  syncing={syncing}
                  onSync={syncDrive}
                  breadcrumbs={breadcrumbs}
                  summary={loadingDrive ? "Loading…" : driveSummary}
                  onBreadcrumbSelect={selectBreadcrumb}
                  onRefresh={() =>
                    accessToken
                      ? (setFolderChildren({}),
                        setFolderParent({}),
                        setFolderMeta({ root: { name: "Root folder", driveItemId: null, storagePath: null } }),
                        setExpanded(new Set(["root"])),
                        void loadDrive(
                          accessToken,
                          currentFolder?.connectionId === "storage"
                            ? null
                            : currentFolder?.driveItemId ?? null,
                          currentFolder?.connectionId === "storage"
                            ? currentFolder.driveItemId
                            : null,
                        ))
                      : undefined}
                />
                <div className="grid min-h-[calc(100vh-137px)] grid-cols-[240px_minmax(0,1fr)]">
                  <FolderTree
                    rootChildren={folderChildren.root ?? folders}
                    folderChildren={folderChildren}
                    expanded={expanded}
                    currentKey={currentFolderKey}
                    loadingKeys={loadingFolderKeys}
                    onNavigate={navigateFolderKey}
                    onToggle={toggleFolderKey}
                  />
                  <DriveContent
                    items={filteredItems}
                    selectedItem={selectedItem}
                    previewItem={previewItem}
                    onSelect={toggleSelected}
                    onPreview={selectAndPreview}
                    onOpen={openDriveItem}
                    viewMode={viewMode}
                    loading={loadingDrive}
                    error={appError}
                    query={query}
                    isRootFolder={breadcrumbs.length <= 1}
                    onBack={() => selectBreadcrumb(breadcrumbs.length - 2)}
                    onSync={syncDrive}
                  />
                </div>
              </div>
              {previewPanelOpen ? (
              <PreviewDrawer
                onClose={() => setPreviewPanelOpen(false)}
                item={previewItem}
                selectedItem={selectedItem}
                productType={productType}
                setProductType={setProductType}
                productTypeOptions={productTypeOptions}
                productDescription={productDescription}
                setProductDescription={setProductDescription}
                sample_prompt={sample_prompt}
                setSamplePrompt={setSamplePrompt}
                sourceStoragePrefix={sourceStoragePrefix}
                setSourceStoragePrefix={setSourceStoragePrefix}
                modelReferenceUrl={modelReferenceUrl}
                setModelReferenceUrl={setModelReferenceUrl}
                styleReferenceUrl={styleReferenceUrl}
                setStyleReferenceUrl={setStyleReferenceUrl}
                submitNotice={submitNotice}
                onOpenModelPicker={() => setDriveModelPickerOpen(true)}
                outputType={outputType}
                setOutputType={setOutputType}
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
                onOpenFolder={openFolder}
              />
              ) : null}
            </div>
          ) : null}

          {/* ── Model tab: model reference library on Google Drive (via n8n) ─ */}
          {activeTab === "model" && accessToken ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <ModelLibraryPanel accessToken={accessToken} mode="page" />
            </div>
          ) : null}

          {activeTab === "jobs" ? (
            <JobsPage
              activeJob={activeJob}
              jobs={jobs}
              loading={loadingJobs}
              onSelectJob={setActiveJob}
              onRetry={retryRun}
              retryingRunId={retryingRunId}
              notice={jobsNotice}
              onRefresh={() => accessToken && void loadJobs(accessToken)}
            />
          ) : null}

          {activeTab === "final" && accessToken ? <FinalBrowser accessToken={accessToken} /> : null}

          {activeTab === "settings" ? <SettingsPage /> : null}
        </section>
      </div>

      {/* ── Model Picker dialog ── */}
      {driveModelPickerOpen && accessToken ? (
        <DriveModelPickerDialog
          accessToken={accessToken}
          onPick={(url) => {
            setModelReferenceUrl(url);
            setDriveModelPickerOpen(false);
          }}
          onCancel={() => setDriveModelPickerOpen(false)}
        />
      ) : null}

    </main>
  );
}

function AppSidebar({
  activeTab,
  onTabChange,
  userEmail,
  signingOut,
  onSignOut,
}: {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  userEmail: string | null;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const nav = [
    { id: "browser" as const, label: "Drive Browser", icon: HardDrive },
    { id: "model" as const, label: "Model", icon: Folder },
    { id: "jobs" as const, label: "Workflow Jobs", icon: Workflow },
    { id: "final" as const, label: "Final Output", icon: ImageIcon },
  ];
  const userLabel = userEmail ?? "Signed in";

  return (
    <aside className="sticky top-0 flex h-screen flex-col border-r border-border bg-brand-cream">
      <div className="flex h-16 items-center gap-3 border-b border-border px-5">
        <Image
          src="/brand/baartwork-logo.png"
          alt="Baartwork"
          width={360}
          height={360}
          priority
          className="h-9 w-9 object-contain"
        />
        <div className="min-w-0">
          <div className="truncate font-montserrat text-xs font-medium uppercase tracking-[0.12em]">
            Media Workflow
          </div>
          <div className="truncate text-[11px] text-muted-foreground">Baartwork Studio</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 px-3 py-4">
        {nav.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              className={cn(
                "relative flex h-10 w-full items-center gap-3 px-3 text-left font-montserrat text-[11px] font-medium uppercase tracking-[0.08em] transition-colors",
                active
                  ? "bg-card text-foreground shadow-soft before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:bg-brand"
                  : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
              )}
              onClick={() => onTabChange(item.id)}
            >
              <Icon className={cn("h-4 w-4", active && "text-brand")} />
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 px-2 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-ink font-montserrat text-xs font-medium uppercase text-white">
            {userLabel.charAt(0)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium" title={userLabel}>{userLabel}</div>
            <div className="text-[11px] text-muted-foreground">Signed in</div>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full"
          disabled={signingOut}
          onClick={onSignOut}
        >
          {signingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
          {signingOut ? "Signing out…" : "Sign out"}
        </Button>
      </div>
    </aside>
  );
}

function TopBar({
  modelLibrary = false,
  selectedItem,
}: {
  modelLibrary?: boolean;
  selectedItem: DriveItem | null;
}) {
  return (
    <header className="flex min-h-16 min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-5 py-3">
      <div className="min-w-0 flex-1 basis-60">
        <h2 className="text-base font-semibold">{modelLibrary ? "Model Library" : "Creative source media"}</h2>
        <p className="truncate text-xs text-muted-foreground" title={selectedItem?.name}>
          {modelLibrary ? "Manage reference images for your media" : selectedItem ? `${selectedItem.itemType === 'FOLDER' ? 'Folder' : 'File'} selected: ${selectedItem.name}` : 'Select a file or folder to generate media'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          title="Open the user guide — English / Tiếng Việt (new tab)"
          onClick={() => window.open("/user-guide.html", "_blank", "noopener,noreferrer")}
        >
          <BookOpen className="h-4 w-4" />
          User Guide
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
  summary,
  onBreadcrumbSelect,
  onRefresh,
  previewPanelOpen,
  onTogglePreviewPanel,
}: {
  query: string;
  setQuery: (value: string) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  syncing: boolean;
  onSync: () => void;
  breadcrumbs: FolderCrumb[];
  summary: string;
  onBreadcrumbSelect: (index: number) => void;
  onRefresh: () => void;
  previewPanelOpen: boolean;
  onTogglePreviewPanel: () => void;
}) {
  // Long paths collapse to: Root › … › parent › current
  const visibleCrumbs = breadcrumbs.length > 3
    ? [0, -1, breadcrumbs.length - 2, breadcrumbs.length - 1]
    : breadcrumbs.map((_, index) => index);
  const canGoBack = breadcrumbs.length > 1;
  const parentCrumb = canGoBack ? breadcrumbs[breadcrumbs.length - 2] : null;

  return (
    <div className="flex min-h-[72px] min-w-0 flex-wrap items-center gap-y-3 border-b border-border px-5 py-3">
      <Button
        variant="outline"
        size="icon"
        className="mr-3 shrink-0"
        disabled={!canGoBack}
        onClick={() => onBreadcrumbSelect(breadcrumbs.length - 2)}
        title={parentCrumb ? `Back to ${parentCrumb.name}` : "Already at root folder"}
        aria-label="Back to parent folder"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <div className="min-w-0 flex-1 basis-40 pr-4">
        <nav aria-label="Folder path" className="flex min-w-0 items-center gap-0.5 text-sm text-muted-foreground">
          {visibleCrumbs.map((index, position) => {
            if (index === -1) {
              return (
                <span key="ellipsis" className="flex shrink-0 items-center gap-0.5">
                  <ChevronRight className="h-3.5 w-3.5 text-brand-line" />
                  <span className="px-1">…</span>
                </span>
              );
            }
            const crumb = breadcrumbs[index];
            const isCurrent = index === breadcrumbs.length - 1;
            return (
              <span
                key={`${crumb.driveItemId ?? "root"}-${index}`}
                className={cn("flex min-w-0 items-center gap-0.5", isCurrent ? "shrink-0 basis-auto" : "shrink")}
              >
                {position > 0 ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-brand-line" /> : null}
                <button
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 px-1.5 py-1 transition-colors",
                    isCurrent
                      ? "cursor-default font-medium text-foreground"
                      : "hover:bg-secondary hover:text-foreground",
                  )}
                  aria-current={isCurrent ? "page" : undefined}
                  disabled={isCurrent}
                  onClick={() => onBreadcrumbSelect(index)}
                  title={crumb.name}
                >
                  {index === 0 ? <HomeIcon className="h-3.5 w-3.5 shrink-0" /> : null}
                  {index === 0 && !isCurrent ? (
                    <span className="sr-only">{crumb.name}</span>
                  ) : (
                    <span className={cn("truncate", isCurrent ? "max-w-[260px]" : "max-w-[140px]")}>{crumb.name}</span>
                  )}
                </button>
              </span>
            );
          })}
        </nav>
        <div className="mt-0.5 pl-1.5 text-xs text-muted-foreground">{summary}</div>
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2">
        <div className="relative w-[280px] max-w-full flex-1 basis-40">
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
        <Button
          variant={previewPanelOpen ? "secondary" : "outline"}
          size="icon"
          onClick={onTogglePreviewPanel}
          title={previewPanelOpen ? "Hide details panel" : "Show details panel"}
          aria-label={previewPanelOpen ? "Hide details panel" : "Show details panel"}
          aria-pressed={previewPanelOpen}
        >
          {previewPanelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

// ─── Model tab components (Supabase Storage) ───────────────────────────────────




// ─── Model CRUD dialogs ─────────────────────────────────────────────────────



// ─── Model Picker Dialog ───────────────────────────────────────────────────

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

/**
 * Model reference library on Google Drive. Everything goes through the
 * model-library edge function → n8n Production_07; n8n returns the share link.
 *  - mode "picker": choose an image for Model Reference URL
 *  - mode "page":   Model tab (browse, upload, copy/open links)
 */
function ModelLibraryPanel({
  accessToken,
  mode,
  onPick,
  onCancel,
}: {
  accessToken: string;
  mode: "picker" | "page";
  onPick?: (url: string) => void;
  onCancel?: () => void;
}) {
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([{ id: MODEL_LIBRARY_ROOT_ID, name: "Model library" }]);
  const [items, setItems] = useState<ModelLibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"share" | "upload" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ModelLibraryItem | null>(null);
  const [query, setQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [dragOver, setDragOver] = useState(false);
  const folderId = trail[trail.length - 1].id;

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setSelected(null);
    const response = await platformApi.listModelLibrary(accessToken, id);
    setLoading(false);
    if (!response.success || !response.data) {
      setItems([]);
      setError(response.error?.message ?? "Could not load the model library.");
      return;
    }
    setItems(response.data.items);
  }, [accessToken]);

  useEffect(() => {
    queueMicrotask(() => void load(folderId));
  }, [folderId, load]);

  /** Asks n8n to share the image ("anyone with the link") and returns its link. */
  async function shareLink(item: ModelLibraryItem): Promise<string | null> {
    setBusy("share");
    setError(null);
    const response = await platformApi.shareModelImage(accessToken, item.id, folderId);
    setBusy(null);
    const url = response.data?.item.public_url ?? null;
    if (!response.success || !url) {
      setError(response.error?.message ?? "Could not share this image.");
      // Deleted on Drive since the list loaded: reload so it disappears here too.
      if (response.error?.code === "MODEL_NOT_FOUND") {
        setItems((current) => current.filter((candidate) => candidate.id !== item.id));
        setSelected(null);
      }
      return null;
    }
    return url;
  }

  async function pick(item: ModelLibraryItem | null = selected) {
    if (!item || busy) return;
    const url = await shareLink(item);
    if (url) onPick?.(url);
  }

  async function copyLink(item: ModelLibraryItem) {
    if (busy) return;
    const url = await shareLink(item);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setNotice(`Copied link for ${item.name}`);
    } catch {
      setNotice(url);
    }
  }

  async function upload(file: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Only JPEG, PNG, or WebP images can be uploaded.");
      return;
    }
    if (file.size > MODEL_LIBRARY_MAX_BYTES) {
      setError("Image must be 15 MB or smaller.");
      return;
    }
    setBusy("upload");
    setError(null);
    setNotice(null);
    try {
      const contentBase64 = await readFileAsBase64(file);
      const response = await platformApi.uploadModelImage(accessToken, {
        fileName: file.name,
        mimeType: file.type,
        contentBase64,
        folderId,
      });
      if (!response.success || !response.data) {
        setError(response.error?.message ?? "Upload failed.");
        return;
      }
      const uploaded = response.data.item;
      setItems((current) => [...current.filter((item) => item.id !== uploaded.id), uploaded]);
      setSelected(uploaded);
      setNotice(`Uploaded ${uploaded.name} to Google Drive.`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setBusy(null);
    }
  }

  const visibleItems = query.trim()
    ? items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()))
    : items;

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        if (!busy) setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        if (busy) return;
        if (event.dataTransfer.files.length !== 1) {
          setError("Please upload one reference image at a time.");
          return;
        }
        void upload(event.dataTransfer.files[0]);
      }}
    >
      {dragOver ? <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-primary bg-background/95 p-6">
        <div className="text-center"><UploadCloud className="mx-auto mb-3 h-10 w-10 text-primary" /><div className="font-medium">Drop your reference image here</div><p className="mt-2 text-sm text-muted-foreground">JPEG, PNG or WebP · up to 15 MB</p></div>
      </div> : null}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-card px-5 py-4">
        <div className="min-w-0 flex-1 basis-48">
          {mode === "picker" ? <h2 className="mb-2 text-lg font-semibold">Select Model Image</h2> : null}
          <nav aria-label="Model library path" className="mt-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
            {trail.map((crumb, index) => (
              <span key={crumb.id} className="flex min-w-0 items-center gap-1">
                {index > 0 ? <ChevronRight className="h-3 w-3 shrink-0" /> : null}
                <button
                  className={cn("truncate", index === trail.length - 1 ? "text-foreground" : "hover:text-foreground")}
                  title={crumb.name}
                  disabled={index === trail.length - 1 || Boolean(busy)}
                  onClick={() => { setQuery(""); setTrail((current) => current.slice(0, index + 1)); }}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>
          <p className="mt-2 text-xs text-muted-foreground">{loading ? "Loading…" : `${items.filter((item) => item.item_type === "FOLDER").length} folders · ${items.filter((item) => item.item_type !== "FOLDER").length} images`} · Drag an image here to upload</p>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
            <div className="relative w-[220px] max-w-full">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input aria-label="Search reference images" className="pl-8" placeholder="Search reference images" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <Button disabled={Boolean(busy)} onClick={() => fileInputRef.current?.click()}>
            {busy === "upload" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-1.5 h-4 w-4" />}
            {busy === "upload" ? "Uploading…" : "Upload image"}
          </Button>
          <Button variant="outline" size="icon" title="Refresh" aria-label="Refresh library" disabled={loading || Boolean(busy)} onClick={() => void load(folderId)}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          <div className="flex gap-0.5 border border-border p-0.5" role="group" aria-label="Library view">
            <Button variant={viewMode === "grid" ? "secondary" : "ghost"} size="icon" title="Grid view" aria-label="Grid view" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}><Grid2X2 className="h-4 w-4" /></Button>
            <Button variant={viewMode === "list" ? "secondary" : "ghost"} size="icon" title="List view" aria-label="List view" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}><List className="h-4 w-4" /></Button>
          </div>
          {onCancel ? (
            <Button variant="ghost" size="icon" title="Close" onClick={onCancel}>
              <X className="h-5 w-5" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className={cn("grid min-h-0 flex-1", selected && mode === "page" ? "grid-cols-1 xl:grid-cols-[minmax(0,1fr)_280px]" : "grid-cols-1")}>
      <div className="min-h-0 min-w-0 overflow-auto p-5">
        {error ? (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
        ) : null}
        {notice ? (
          <div role="status" className="mb-4 break-all rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            {notice}
          </div>
        ) : null}
        {loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4" aria-label="Loading model library" aria-busy="true">
            {Array.from({ length: 5 }, (_, index) => <div key={index} className="animate-pulse rounded-card border border-border bg-card p-2"><div className="aspect-[4/5] rounded-tile bg-muted" /><div className="mt-3 h-3 w-3/4 bg-muted" /></div>)}
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="mx-auto my-8 flex min-h-80 max-w-xl flex-col items-center justify-center rounded-card border border-dashed border-border bg-card p-8 text-center">
            <div className="mb-5 rounded-full bg-secondary p-5">{query.trim() ? <Search className="h-8 w-8 text-muted-foreground" /> : <UploadCloud className="h-8 w-8 text-primary" />}</div>
            <h3 className="text-base">{query.trim() ? "No matching images" : "Add your first reference image"}</h3>
            <p className="mt-3 max-w-sm text-sm text-muted-foreground">{query.trim() ? "Try another name or clear your search to see all items." : "Drag an image here or upload a file to build your model reference library."}</p>
            <Button className="mt-5" disabled={Boolean(busy)} onClick={() => query.trim() ? setQuery("") : fileInputRef.current?.click()}>{query.trim() ? "Clear search" : busy === "upload" ? "Uploading…" : "Upload image"}</Button>
            {!query.trim() ? <p className="mt-3 text-xs text-muted-foreground">JPEG, PNG or WebP · up to 15 MB per image</p> : null}
          </div>
        ) : (
          <div className={viewMode === "grid" ? "grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),240px))] gap-4" : "space-y-2"}>
            {visibleItems.map((item) => {
              const isFolder = item.item_type === "FOLDER";
              const isSelected = selected?.id === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    "min-w-0 overflow-hidden rounded-card border bg-card text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    viewMode === "list" && "flex w-full items-center gap-4 p-2",
                    isSelected ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-primary/50",
                  )}
                  disabled={Boolean(busy)}
                  onClick={() => (isFolder ? undefined : setSelected(item))}
                  onDoubleClick={() => {
                    if (isFolder) { setQuery(""); setTrail((current) => [...current, { id: item.id, name: item.name }]); }
                    else if (mode === "picker") {
                      setSelected(item);
                      void pick(item);
                    } else {
                      window.open(item.web_view_link ?? `https://drive.google.com/file/d/${item.id}/view`, "_blank", "noopener,noreferrer");
                    }
                  }}
                  title={isFolder ? "Double-click to open" : item.name}
                >
                  <div className={cn("flex items-center justify-center overflow-hidden bg-secondary", viewMode === "grid" ? "aspect-[4/5]" : "h-14 w-14 shrink-0 rounded-tile")}>
                    {isFolder ? (
                      <FolderGlyph className="h-12" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`https://drive.google.com/thumbnail?id=${encodeURIComponent(item.id)}&sz=w400`}
                        alt={item.name}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0 px-3 py-3"><div className="truncate text-sm font-medium">{item.name}</div><div className="mt-1 text-xs text-muted-foreground">{isFolder ? "Folder · double-click to open" : "Reference image"}</div></div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {selected && mode === "page" ? <aside className="min-w-0 border-t border-border bg-card p-5 xl:border-l xl:border-t-0">
        <div className="mb-4 flex items-center justify-between"><h3 className="text-xs">Image preview</h3><Button variant="ghost" size="icon" aria-label="Close image preview" onClick={() => setSelected(null)}><X className="h-4 w-4" /></Button></div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`https://drive.google.com/thumbnail?id=${encodeURIComponent(selected.id)}&sz=w800`} alt={selected.name} referrerPolicy="no-referrer" className="max-h-80 w-full rounded-tile bg-secondary object-contain" />
        <div className="mt-4 text-sm font-medium [overflow-wrap:anywhere]">{selected.name}</div><p className="mt-2 text-xs text-muted-foreground">Use Copy link to use this image as a model reference.</p>
      </aside> : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card p-4">
        <div className="min-w-0 truncate text-sm text-muted-foreground">
          {selected ? (
            <span className="font-medium text-foreground">Selected: {selected.name}</span>
          ) : (
            <span>{mode === "picker" ? "Choose a reference image, then select Use this image." : "Select an image to preview, open or copy its link."}</span>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {mode === "picker" ? (
            <>
              <Button variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button onClick={() => void pick()} disabled={!selected || Boolean(busy)}>
                {busy === "share" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Use this image
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={!selected}
                onClick={() =>
                  selected &&
                  window.open(selected.web_view_link ?? `https://drive.google.com/file/d/${selected.id}/view`, "_blank", "noopener,noreferrer")
                }
              >
                <Share2 className="mr-2 h-4 w-4" />
                Open in Drive
              </Button>
              <Button onClick={() => selected && void copyLink(selected)} disabled={!selected || Boolean(busy)}>
                {busy === "share" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Copy className="mr-2 h-4 w-4" />}
                Copy link
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DriveModelPickerDialog({
  accessToken,
  onPick,
  onCancel,
}: {
  accessToken: string;
  onPick: (url: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="h-full max-h-[80vh] w-full max-w-4xl overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <ModelLibraryPanel accessToken={accessToken} mode="picker" onPick={onPick} onCancel={onCancel} />
      </div>
    </div>
  );
}



function FolderTree({
  rootChildren,
  folderChildren,
  expanded,
  currentKey,
  loadingKeys,
  onNavigate,
  onToggle,
}: {
  rootChildren: DriveItem[];
  folderChildren: Record<string, DriveItem[]>;
  expanded: Set<string>;
  currentKey: string;
  loadingKeys: Set<string>;
  onNavigate: (key: string) => void;
  onToggle: (key: string) => void;
}) {
  function renderNode(item: DriveItem, depth: number, ancestors: Set<string> = new Set()) {
    const key = getFolderKeyFromItem(item);
    // Guard against cyclic folder data (e.g. synced items pointing back to an ancestor).
    if (ancestors.has(key)) return null;
    const lineage = new Set(ancestors).add(key);
    const children = folderChildren[key]?.filter((child) => !lineage.has(getFolderKeyFromItem(child)));
    const isExpanded = expanded.has(key);
    const isCurrent = currentKey === key;
    const isLoading = loadingKeys.has(key);
    const hasKnownNoChildren = children?.length === 0;

    return (
      <div key={key}>
        <div
          className={cn(
            "relative flex h-8 w-full items-center gap-1.5 rounded-tile pr-2 text-left text-sm transition-colors hover:bg-card",
            isCurrent
              ? "bg-card font-medium text-brand-dark before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:bg-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
          style={{ paddingLeft: 8 + depth * 16 }}
          title={item.name}
        >
          <button
            type="button"
            className={cn("flex h-5 w-5 shrink-0 items-center justify-center", hasKnownNoChildren && "invisible")}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(key);
            }}
            aria-label={isExpanded ? `Collapse ${item.name}` : `Expand ${item.name}`}
          >
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
            )}
          </button>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => {
              onNavigate(key);
              if (!isExpanded) onToggle(key);
            }}
          >
            <FolderGlyph className="h-4 shrink-0" />
            <span className="truncate">{item.name}</span>
          </button>
        </div>
        {isExpanded && children?.length ? children.map((child) => renderNode(child, depth + 1, lineage)) : null}
      </div>
    );
  }

  return (
    <aside className="overflow-auto border-r border-border bg-brand-cream/50 px-3 py-4">
      <div className="mb-2 px-2 font-montserrat text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        Folders
      </div>
      <div
        className={cn(
          "relative flex h-8 w-full items-center gap-2 rounded-tile pr-2 text-left text-sm transition-colors hover:bg-card",
          currentKey === "root"
            ? "bg-card font-medium text-brand-dark before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:bg-primary"
            : "text-muted-foreground hover:text-foreground",
        )}
        style={{ paddingLeft: 8 }}
      >
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center"
          onClick={(event) => {
            event.stopPropagation();
            onToggle("root");
          }}
          aria-label={expanded.has("root") ? "Collapse root" : "Expand root"}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded.has("root") && "rotate-90")} />
        </button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onNavigate("root")}>
          <HomeIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">Root folder</span>
        </button>
      </div>
      {expanded.has("root") ? (
        rootChildren.length ? rootChildren.map((child) => renderNode(child, 1)) : (
          <div className="h-8 py-1 text-xs italic text-muted-foreground" style={{ paddingLeft: 24 }}>
            No subfolders
          </div>
        )
      ) : null}
    </aside>
  );
}

function DriveContent({
  items,
  selectedItem,
  previewItem,
  onSelect,
  onPreview,
  onOpen,
  viewMode,
  loading,
  error,
  query,
  isRootFolder,
  onBack,
  onSync,
  gridClassName,
}: {
  items: DriveItem[];
  selectedItem: DriveItem | null;
  previewItem: DriveItem | null;
  onSelect: (id: string) => void;
  onPreview: (item: DriveItem) => void;
  onOpen: (item: DriveItem) => void;
  viewMode: ViewMode;
  loading: boolean;
  error: string | null;
  query: string;
  isRootFolder: boolean;
  onBack: () => void;
  onSync: () => void;
  gridClassName?: string;
}) {
  if (loading) {
    return (
      <section className={cn("grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4 p-5", gridClassName)}>
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
          <FolderGlyph className="mx-auto mb-3 h-10" />
          {query.trim() ? (
            <>
              <div className="font-medium">No matches for &ldquo;{query.trim()}&rdquo;</div>
              <p className="mt-1 text-sm text-muted-foreground">Try a different name, or clear the search.</p>
            </>
          ) : isRootFolder ? (
            <>
              <div className="font-medium">No Drive metadata yet</div>
              <p className="mt-1 text-sm text-muted-foreground">
                Run Drive Sync to load Google Drive metadata into Supabase.
              </p>
              <Button variant="outline" size="sm" className="mt-4" onClick={onSync}>
                <FolderSync className="mr-1.5 h-4 w-4" />
                Sync Drive
              </Button>
            </>
          ) : (
            <>
              <div className="font-medium">This folder is empty</div>
              <p className="mt-1 text-sm text-muted-foreground">
                Nothing synced here yet. If you just added files in Drive, sync this folder.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="outline" size="sm" onClick={onBack}>
                  <ArrowLeft className="mr-1.5 h-4 w-4" />
                  Back
                </Button>
                <Button variant="outline" size="sm" onClick={onSync}>
                  <FolderSync className="mr-1.5 h-4 w-4" />
                  Sync folder
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="min-w-0 p-5">
      {viewMode === "grid" ? (
        <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(min(100%,190px),240px))] gap-4", gridClassName)}>
          {items.map((item) => (
            <MediaCard
              key={item.id}
              item={item}
              selected={selectedItem?.id === item.id}
              previewed={previewItem?.id === item.id}
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
              previewed={previewItem?.id === item.id}
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

// Drive thumbnails are already resized and may require the browser's Google session.
// Next's server-side image optimizer does not forward that session.
function isGoogleThumbnail(src: string): boolean {
  try {
    const { hostname } = new URL(src);
    return hostname === "googleusercontent.com" || hostname.endsWith(".googleusercontent.com");
  } catch {
    return false;
  }
}

function MediaCard({
  item,
  selected,
  previewed,
  onSelect,
  onPreview,
  onOpen,
}: {
  item: DriveItem;
  selected: boolean;
  previewed: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onOpen: () => void;
}) {
  const Icon = typeIcon[item.itemType];
  const isFolder = item.itemType === "FOLDER";
  const [copied, setCopied] = useState(false);
  const meta = isFolder ? formatDate(item.modifiedTime) : `${formatDate(item.modifiedTime)} · ${formatBytes(item.sizeBytes)}`;
  const driveLink = stripMarkdownLink(item.webViewLink);

  function showCopied() {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function copyText(value: string | null) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    showCopied();
  }

  return (
    <article
      className={cn(
        "group relative flex min-w-0 flex-col rounded-card bg-card p-2 transition focus-within:shadow-[0_6px_24px_rgba(28,28,28,0.08)] hover:bg-card hover:shadow-[0_6px_24px_rgba(28,28,28,0.08)]",
        selected ? "ring-1 ring-primary" : previewed && "ring-1 ring-brand-line shadow-[0_6px_24px_rgba(28,28,28,0.08)]",
      )}
    >
      <button
        className="relative flex aspect-[4/3] select-none items-center justify-center overflow-hidden rounded-tile border border-border bg-card"
        title={isFolder ? "Double-click to open" : "Double-click to preview"}
        {...previewOpenHandlers(onPreview, onOpen)}
      >
        {/* Drive's folder thumbnails are blurry generic icons — always use our glyph. */}
        {isFolder ? (
          <FolderGlyph className="folder-card-icon h-16 shrink-0 transition-transform duration-300 motion-safe:group-hover:scale-110" />
        ) : item.thumbnailUrl ? (
          <Image src={item.thumbnailUrl} alt="" fill sizes="260px" className="object-cover" unoptimized={isGoogleThumbnail(item.thumbnailUrl)} referrerPolicy="no-referrer" />
        ) : (
          <Icon className="h-10 w-10 text-muted-foreground" />
        )}
        {item.syncStatus === "STALE" ? <span className="absolute bottom-3 left-3 h-2 w-2 rounded-full bg-amber-500" /> : null}
      </button>
      <button
        className={cn(
          "absolute right-4 top-4 flex h-5 w-5 items-center justify-center rounded-[4px] border-2 bg-card transition-opacity",
          selected
            ? "border-primary bg-primary text-primary-foreground opacity-100"
            : "border-muted-foreground/60 opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
        )}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        title={isFolder ? "Select folder" : "Select file"}
        aria-pressed={selected}
      >
        {selected ? <Check className="h-3.5 w-3.5" /> : null}
      </button>
      <div className="flex flex-1 flex-col">
        <button className="mt-3 line-clamp-1 select-none text-center text-sm font-medium hover:text-brand-dark" title={item.name} {...previewOpenHandlers(onPreview, onOpen)}>
          {item.name}
        </button>
        <div className="relative mt-1 h-8">
          <div className={cn("flex h-8 items-center justify-center truncate text-xs text-muted-foreground transition-opacity group-focus-within:opacity-0 group-hover:opacity-0", selected && "opacity-0")}>
            {copied ? "Copied" : meta}
          </div>
          <div className={cn("absolute inset-0 flex items-center justify-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100", selected && "opacity-100")}>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-secondary" title="Copy Google Drive link" aria-label="Copy Google Drive link" disabled={!driveLink} onClick={() => void copyText(driveLink)}>
              <Link className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-secondary" title="Open Google Drive link" aria-label="Open Google Drive link" disabled={!driveLink} onClick={() => driveLink ? window.open(driveLink, "_blank", "noopener") : undefined}>
              <Share2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function MediaRow(props: {
  item: DriveItem;
  selected: boolean;
  previewed: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onOpen: () => void;
}) {
  const Icon = typeIcon[props.item.itemType];
  const isFolder = props.item.itemType === "FOLDER";

  return (
    <div className={cn("grid grid-cols-[40px_minmax(0,1fr)_130px_120px_120px_44px] items-center border-b border-border px-3 py-2.5 last:border-b-0", props.selected ? "bg-primary/5" : props.previewed && "bg-secondary")}>
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
        className="flex min-w-0 select-none items-center gap-3 text-left"
        title={isFolder ? "Double-click to open" : undefined}
        {...previewOpenHandlers(props.onPreview, props.onOpen)}
        style={{ paddingLeft: Math.min(props.item.treeDepth ?? 0, 8) * 14 }}
      >
        {isFolder ? <FolderGlyph className="h-4 shrink-0" /> : <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
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
  onClose,
  item,
  selectedItem,
  productType,
  setProductType,
  productTypeOptions,
  productDescription,
  setProductDescription,
  sample_prompt,
  setSamplePrompt,
  sourceStoragePrefix,
  setSourceStoragePrefix,
  modelReferenceUrl,
  setModelReferenceUrl,
  styleReferenceUrl,
  setStyleReferenceUrl,
  submitNotice,
  onOpenModelPicker,
  outputType,
  setOutputType,
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
  onOpenFolder,
}: {
  item: DriveItem | null;
  selectedItem: DriveItem | null;
  productType: string;
  setProductType: (value: string) => void;
  productTypeOptions: ProductTypeOption[];
  productDescription: string;
  setProductDescription: (value: string) => void;
  sample_prompt: string;
  setSamplePrompt: (value: string) => void;
  sourceStoragePrefix: string;
  setSourceStoragePrefix: (value: string) => void;
  modelReferenceUrl: string;
  setModelReferenceUrl: (value: string) => void;
  styleReferenceUrl: string;
  setStyleReferenceUrl: (value: string) => void;
  submitNotice: string | null;
  onOpenModelPicker: () => void;
  outputType: OutputType;
  setOutputType: (value: OutputType) => void;
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
  onOpenFolder: (folder: DriveItem) => void;
  onClose: () => void;
}) {
  if (!selectedItem && !item) {
    return (
      <aside className="bg-card p-5">
        <div className="mb-4 flex justify-end">
          <Button variant="ghost" size="icon" title="Hide details panel" aria-label="Hide details panel" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          Select a file or folder to preview metadata.
        </div>
      </aside>
    );
  }

  const displayItem = item ?? selectedItem;

  return (
    <aside className="overflow-auto bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {selectedItem
            ? selectedItem.itemType === "FOLDER"
              ? "Folder Selection"
              : "File Selection"
            : "File Preview"}
        </h3>
        <Button variant="ghost" size="icon" title="Hide details panel" aria-label="Hide details panel" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Selected Item Info */}
      {selectedItem ? (
        <div className="mb-4 rounded-md border border-border p-3">
          <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Selected Item</div>
          <div className="font-medium [overflow-wrap:anywhere]">{selectedItem.name}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {selectedItem.itemType === "FOLDER" ? "Folder" : selectedItem.itemType} · {selectedItem.itemType === "FOLDER" ? "Contains all descendant files" : "Single file"}
          </div>
        </div>
      ) : null}

      {/* Generation Form */}
      {selectedItem ? (
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
                {productTypeOptions.map((option) => (
                  <option key={option.value} value={option.value} title={option.category}>
                    {option.label}
                  </option>
                ))}
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
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Input Sample Prompt</label>
              <Textarea
                placeholder="Optional sample prompt..."
                value={sample_prompt}
                onChange={(e) => setSamplePrompt(e.target.value)}
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
              <div className="flex flex-col gap-2">
                {modelReferenceUrl ? (
                  <div className="relative overflow-hidden rounded-md border border-border">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={modelReferenceUrl}
                      alt="Model Reference"
                      className="aspect-[4/3] w-full object-cover"
                    />
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <Input
                    value={modelReferenceUrl}
                    onChange={(e) => setModelReferenceUrl(e.target.value)}
                    placeholder="https://..."
                    className="flex-1"
                  />
                  <Button variant="secondary" onClick={onOpenModelPicker} type="button">
                    Browse
                  </Button>
                </div>
              </div>
            </div>

            {/* Style reference is hidden until the n8n flow is verified with a real provider. */}
            <div hidden>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Style Reference URL</label>
              <Input
                value={styleReferenceUrl}
                onChange={(e) => setStyleReferenceUrl(e.target.value)}
                placeholder="https://... (lighting, composition, mood)"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Optional. Public HTTPS link straight to an image — not a Google Drive preview link.
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Output Type *</label>
              <div role="radiogroup" aria-label="Output Type" className="grid grid-cols-3 gap-2">
                {OUTPUT_TYPE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    title={option.available ? undefined : "Coming soon — the workflow currently always creates images and a video"}
                    className={cn(
                      "flex h-10 items-center justify-center gap-2 rounded-md border text-sm transition-colors",
                      !option.available
                        ? "cursor-not-allowed border-border text-muted-foreground/60"
                        : outputType === option.value
                          ? "cursor-pointer border-primary bg-primary/10 font-medium text-foreground"
                          : "cursor-pointer border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <input
                      type="radio"
                      name="output_type"
                      value={option.value}
                      checked={outputType === option.value}
                      disabled={!option.available}
                      onChange={() => setOutputType(option.value)}
                      className="accent-primary"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Image-only and Video-only are coming soon. Every run currently creates both images and a video.
              </p>
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
        {submitNotice ? (
          <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
            {submitNotice}
          </div>
        ) : null}

        {/* File Preview (if a file is selected) */}
        </div>
      ) : null}

      {displayItem && displayItem.itemType === "FOLDER" ? (
        <div className={cn("pt-4", selectedItem && "border-t border-border")}>
          <div className="flex aspect-video items-center justify-center rounded-tile border border-border bg-brand-cream/50">
            <FolderGlyph className="h-16" />
          </div>
          <div className="mt-4 text-sm font-medium">{displayItem.name}</div>
          <div className="mt-3 space-y-3">
            <Info label="Modified" value={formatDate(displayItem.modifiedTime)} />
            <Info label="Sync" value={displayItem.syncStatus} />
          </div>
          <Button className="mt-4 w-full" onClick={() => onOpenFolder(displayItem)}>
            <FolderOpen className="h-4 w-4" />
            Open folder
          </Button>
          <p className="mt-2 text-center text-xs text-muted-foreground">Tip: double-click a folder to open it</p>
        </div>
      ) : null}

      {displayItem && displayItem.itemType !== "FOLDER" ? (
          <>
            <div className={cn("pt-4", selectedItem && "border-t border-border")}>
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <File className="h-4 w-4" />
                File Metadata
              </div>
              <div className="relative mb-4 aspect-video overflow-hidden rounded-md bg-secondary">
                {displayItem.thumbnailUrl ? (
                  <Image src={displayItem.thumbnailUrl} alt="" fill sizes="360px" className="object-cover" unoptimized={isGoogleThumbnail(displayItem.thumbnailUrl)} referrerPolicy="no-referrer" />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <File className="h-10 w-10 text-muted-foreground" />
                  </div>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <div className="text-base font-semibold">{displayItem.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{displayItem.mimeType}</div>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Info label="Size" value={formatBytes(displayItem.sizeBytes)} />
                  <Info label="Type" value={displayItem.itemType} />
                  <Info label="Drive modified" value={formatDate(displayItem.modifiedTime)} />
                  <Info label="Synced" value={formatDate(displayItem.syncedAt)} />
                </div>
                <div className="grid grid-cols-1 gap-2">
                  <Button
                    variant="outline"
                    disabled={!displayItem.webViewLink}
                    onClick={() => {
                      if (displayItem.webViewLink) {
                        window.open(displayItem.webViewLink, "_blank", "noopener,noreferrer");
                      }
                    }}
                  >
                    <Link className="h-4 w-4" />
                    View in Drive
                  </Button>
                </div>
              </div>
            </div>
          </>
        ) : null}
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

const JOBS_POLL_INTERVAL_MS = 15_000;
const JOB_GRID = "grid grid-cols-[minmax(0,1.8fr)_90px_140px_110px_130px_120px_88px] gap-3";

const RETRY_ACTION_LABEL: Record<string, string> = {
  recovery_existing_assets: "Can recover from saved outputs",
  resume_anchor_checkpoint: "Can resume from checkpoint",
  restart_generation_requires_approval: "Generating again requires confirmation",
  manual_review: "Needs manual review",
};

/** Depth-first order of the scan tree so children render under their parent. */
function orderFolderTree(folders: JobFolderRun[]): JobFolderRun[] {
  const ids = new Set(folders.map((folder) => folder.runId));
  const children = new Map<string | null, JobFolderRun[]>();
  for (const folder of folders) {
    const parent = folder.parentRunId && ids.has(folder.parentRunId) ? folder.parentRunId : null;
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  const ordered: JobFolderRun[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null) => {
    const list = (children.get(parent) ?? []).sort((a, b) =>
      (a.sourcePath ?? a.name).localeCompare(b.sourcePath ?? b.name),
    );
    for (const folder of list) {
      if (visited.has(folder.runId)) continue;
      visited.add(folder.runId);
      ordered.push(folder);
      walk(folder.runId);
    }
  };
  walk(null);
  return ordered;
}

/** What the user picked in Generate Media (file or folder), falling back to the scanned root folder. */
function jobLabel(job: WorkflowJob) {
  return job.selectedName ?? job.sourceName ?? `batch ${job.id.slice(0, 8)}`;
}

function folderCounts(job: WorkflowJob) {
  const done = job.folders.filter((folder) => folder.rawStatus === "completed").length;
  const failed = job.folders.filter((folder) => folder.status === "FAILED").length;
  return { done, failed, total: job.folders.length };
}

function RetryButton({
  runId,
  label,
  retryingRunId,
  onRetry,
  size = "sm",
}: {
  runId: string;
  label: string;
  retryingRunId: string | null;
  onRetry: (runId: string, label: string) => void;
  size?: "sm" | "icon";
}) {
  const busy = retryingRunId === runId;
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("shrink-0", size === "icon" && "h-7 px-2 text-xs")}
      disabled={Boolean(retryingRunId)}
      onClick={(event) => {
        event.stopPropagation();
        onRetry(runId, label);
      }}
      title={`Retry ${label}`}
    >
      {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
      Retry
    </Button>
  );
}

function JobsPage({
  activeJob,
  jobs,
  loading,
  onSelectJob,
  onRetry,
  retryingRunId,
  notice,
  onRefresh,
}: {
  activeJob: WorkflowJob | null;
  jobs: WorkflowJob[];
  loading: boolean;
  onSelectJob: (job: WorkflowJob) => void;
  onRetry: (runId: string, label: string) => void;
  retryingRunId: string | null;
  notice: { tone: "success" | "error"; text: string } | null;
  onRefresh: () => void;
}) {
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set());
  const toggleJob = (id: string) =>
    setExpandedJobIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="grid flex-1 grid-cols-[minmax(0,1fr)_420px]">
      <section className="min-w-0 p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Workflow Jobs</h2>
            <p className="text-sm text-muted-foreground">
              Each row is one Generate Media submission (n8n batch) with its folder scan tree.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Refresh
          </Button>
        </div>
        {notice ? (
          <div
            role="status"
            className={cn(
              "mb-4 rounded-md border p-3 text-sm",
              notice.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-700",
            )}
          >
            {notice.text}
          </div>
        ) : null}
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <div className={cn(JOB_GRID, "border-b border-border px-4 py-3 text-xs font-semibold uppercase text-muted-foreground")}>
            <span>Batch / folder</span>
            <span>Product</span>
            <span>Status</span>
            <span>Progress</span>
            <span>Folders · images</span>
            <span>Created</span>
            <span />
          </div>
          {loading && jobs.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">Loading workflow jobs...</div>
          ) : null}
          {!loading && jobs.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No workflow jobs yet. Select a folder in Drive Browser and run Generate Media.
            </div>
          ) : null}
          {jobs.map((job) => {
            const counts = folderCounts(job);
            const label = jobLabel(job);
            const isOpen = expandedJobIds.has(job.id);
            const isFile = job.selectedType && job.selectedType !== "FOLDER";
            return (
              <div key={job.id} className="border-b border-border last:border-b-0">
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  className={cn(
                    JOB_GRID,
                    "w-full cursor-pointer items-center px-4 py-3 text-left hover:bg-secondary",
                    activeJob?.id === job.id && "bg-primary/5",
                  )}
                  onClick={() => {
                    onSelectJob(job);
                    toggleJob(job.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      onSelectJob(job);
                      toggleJob(job.id);
                    }
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <ChevronRight
                      className={cn(
                        "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                        isOpen && "rotate-90",
                        counts.total === 0 && "invisible",
                      )}
                    />
                    {isFile ? (
                      <FileImage className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FolderGlyph className="h-4 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium" title={label}>{label}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {job.id.slice(0, 8)}
                        {job.sourceName && job.sourceName !== label ? ` · in ${job.sourceName}` : ""}
                      </div>
                    </div>
                  </div>
                  <span className="truncate text-sm capitalize">{job.productType ?? "—"}</span>
                  <WorkflowStatusBadge status={job.status} rawStatus={job.rawStatus} />
                  <WorkflowProgress value={job.progress} status={job.status} rawStatus={job.rawStatus} />
                  <span className="text-sm text-muted-foreground">
                    {counts.done}/{counts.total}
                    {counts.failed ? <span className="ml-1 text-red-600">· {counts.failed} failed</span> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDate(job.createdAt)}</span>
                  <div className="flex justify-end">
                    {job.canRetry ? (
                      <RetryButton runId={job.id} label={label} retryingRunId={retryingRunId} onRetry={onRetry} size="icon" />
                    ) : null}
                  </div>
                </div>
                {isOpen
                  ? orderFolderTree(job.folders).map((folder) => (
                      <div
                        key={folder.runId}
                        className={cn(
                          JOB_GRID,
                          "items-center border-t border-border/60 bg-background/60 px-4 py-2 text-left",
                          folder.status === "FAILED" && "bg-red-50/60",
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: 24 + folder.depth * 18 }}>
                          <FolderGlyph className="h-3.5 shrink-0" />
                          <div className="min-w-0">
                            <div className="truncate text-sm" title={folder.sourcePath ?? folder.name}>{folder.name}</div>
                            {folder.errorMessage ? (
                              <div className="text-[11px] text-red-700 [overflow-wrap:anywhere]">
                                {workflowErrorMessage(folder.errorMessage)}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <span />
                        <WorkflowStatusBadge status={folder.status} rawStatus={folder.rawStatus} />
                        <span />
                        <span className="text-xs text-muted-foreground">
                          {folder.imageCount !== null ? `${folder.imageCount} images` : "Not scanned"}
                          {folder.childFolderCount ? ` · ${folder.childFolderCount} sub` : ""}
                        </span>
                        <span className="text-xs text-muted-foreground">{formatDate(folder.updatedAt ?? folder.startedAt)}</span>
                        <div className="flex justify-end">
                          {folder.canRetry ? (
                            <RetryButton
                              runId={folder.runId}
                              label={folder.name}
                              retryingRunId={retryingRunId}
                              onRetry={onRetry}
                              size="icon"
                            />
                          ) : null}
                        </div>
                      </div>
                    ))
                  : null}
              </div>
            );
          })}
        </div>
      </section>
      <JobDetail job={activeJob} onRetry={onRetry} retryingRunId={retryingRunId} />
    </div>
  );
}

function JobDetail({
  job,
  onRetry,
  retryingRunId,
}: {
  job: WorkflowJob | null;
  onRetry: (runId: string, label: string) => void;
  retryingRunId: string | null;
}) {
  if (!job) {
    return (
      <aside className="border-l border-border bg-card p-5">
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          Select a batch to inspect its folders.
        </div>
      </aside>
    );
  }

  const folders = orderFolderTree(job.folders);
  const counts = folderCounts(job);
  const label = jobLabel(job);

  return (
    <aside className="overflow-auto border-l border-border bg-card p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <WorkflowStatusBadge status={job.status} rawStatus={job.rawStatus} />
          <h3 className="mt-3 truncate text-lg font-semibold" title={label}>{label}</h3>
          {job.productType ? <p className="mt-1 text-xs capitalize text-muted-foreground">{job.productType}</p> : null}
        </div>
        {job.canRetry ? (
          <RetryButton runId={job.id} label={label} retryingRunId={retryingRunId} onRetry={onRetry} />
        ) : null}
      </div>
      <WorkflowProgress value={job.progress} status={job.status} rawStatus={job.rawStatus} className="mb-2" />
      <div className="mb-5 text-xs text-muted-foreground">
        {counts.done} of {counts.total} folders completed
        {counts.failed ? ` · ${counts.failed} failed` : ""} · started {formatDate(job.startedAt ?? job.createdAt)}
      </div>

      {job.errorMessage || counts.failed ? (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <div className="flex items-start gap-2"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <div className="font-semibold">{counts.failed ? `${counts.failed} ${counts.failed === 1 ? "folder needs" : "folders need"} attention` : "Workflow could not finish"}</div>
              {counts.failed ? <ul className="mt-2 space-y-2">
                {folders.filter((folder) => folder.status === "FAILED").map((folder) => <li key={folder.runId} className="[overflow-wrap:anywhere]">
                  <div className="font-medium">{folder.name}</div>
                  <div className="mt-0.5 text-xs">{workflowErrorMessage(folder.errorMessage ?? job.errorMessage)}</div>
                </li>)}
              </ul> : <p className="mt-1 [overflow-wrap:anywhere]">{workflowErrorMessage(job.errorMessage)}</p>}
            </div>
          </div>
        </div>
      ) : null}

      <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Folders</div>
      {folders.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          No folders scanned for this batch yet.
        </div>
      ) : (
        <ul className="space-y-1">
          {folders.map((folder) => (
            <li
              key={folder.runId}
              className={cn(
                "rounded-md border border-transparent py-2 pr-2",
                folder.status === "FAILED" && "border-red-200 bg-red-50/60",
              )}
              style={{ paddingLeft: 8 + folder.depth * 16 }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <FolderGlyph className="h-4 shrink-0" />
                <span className="min-w-0 flex-1 basis-24 text-sm font-medium [overflow-wrap:anywhere]" title={folder.sourcePath ?? folder.name}>
                  {folder.name}
                </span>
                <WorkflowStatusBadge status={folder.status} rawStatus={folder.rawStatus} />
                {folder.canRetry ? (
                  <RetryButton
                    runId={folder.runId}
                    label={folder.name}
                    retryingRunId={retryingRunId}
                    onRetry={onRetry}
                    size="icon"
                  />
                ) : null}
              </div>
              <div className="mt-0.5 pl-6 text-xs text-muted-foreground">
                {folder.imageCount !== null ? `${folder.imageCount} images` : "Not scanned"}
                {folder.childFolderCount ? ` · ${folder.childFolderCount} subfolders` : ""}
                {folder.attempt && folder.attempt > 1 ? ` · attempt ${folder.attempt}` : ""}
                {folder.retryAction && RETRY_ACTION_LABEL[folder.retryAction]
                  ? ` · ${RETRY_ACTION_LABEL[folder.retryAction]}`
                  : ""}
              </div>
              {folder.errorMessage ? (
                <div className="mt-2 pl-6 text-xs leading-relaxed text-red-700 [overflow-wrap:anywhere]">{workflowErrorMessage(folder.errorMessage)}</div>
              ) : null}
              {folder.files.length ? (
                <ul className="mt-1.5 space-y-0.5 pl-6">
                  {folder.files.map((file) => (
                    <li key={file.id} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <FileImage className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate" title={file.name ?? file.id}>{file.name ?? file.id}</span>
                    </li>
                  ))}
                  {folder.imageCount && folder.imageCount > folder.files.length ? (
                    <li className="text-xs text-muted-foreground">+{folder.imageCount - folder.files.length} more</li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

// ─── Final Output tab: browse the generated-output Drive tree (final_items) ────

function driveDownloadUrl(item: DriveItem) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(item.driveItemId)}`;
}

function driveOpenUrl(item: DriveItem) {
  if (item.itemType === "FOLDER") return `https://drive.google.com/drive/folders/${encodeURIComponent(item.driveItemId)}`;
  return stripMarkdownLink(item.webViewLink) ?? `https://drive.google.com/file/d/${encodeURIComponent(item.driveItemId)}/view`;
}

type FinalFolderMeta = { name: string; parentId: string | null };

function FinalBrowser({ accessToken }: { accessToken: string }) {
  const [currentId, setCurrentId] = useState(FINAL_ROOT_FOLDER_ID);
  const [items, setItems] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [previewItem, setPreviewItem] = useState<DriveItem | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [meta, setMeta] = useState<Record<string, FinalFolderMeta>>({
    [FINAL_ROOT_FOLDER_ID]: { name: FINAL_ROOT_FOLDER_NAME, parentId: null },
  });
  const syncedRef = useRef(new Set<string>());
  const requestRef = useRef(0);

  const listFolder = useCallback(async (folderId: string) => {
    const response = await platformApi.listFinalFolder(accessToken, folderId);
    if (!response.success || !response.data) {
      return { ok: false as const, error: response.error?.message ?? "Could not load folder.", items: [] as DriveItem[] };
    }
    const list = response.data.items.filter((item) => !isHiddenDrivePlaceholder(item)).map(normalizeDriveItem);
    return { ok: true as const, error: null, items: list };
  }, [accessToken]);

  // Same lazy sync as Drive Browser: pull a folder from Drive the first time it is empty.
  const fetchFolder = useCallback(async (folderId: string, force = false) => {
    let result = await listFolder(folderId);
    if (!result.ok || (result.items.length > 0 && !force) || (!force && syncedRef.current.has(folderId))) return result;
    syncedRef.current.add(folderId);
    const sync = await platformApi.syncFinalFolder(accessToken, folderId);
    if (!sync.success) return { ...result, error: sync.error?.message ?? "Could not sync folder." };
    for (const delayMs of [0, 2000, 4000]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      result = await listFolder(folderId);
      if (!result.ok || result.items.length > 0) return result;
    }
    return result;
  }, [accessToken, listFolder]);

  const rememberFolders = useCallback((parentId: string, list: DriveItem[]) => {
    const folders = list.filter((item) => item.itemType === "FOLDER" && item.driveItemId !== parentId);
    setMeta((current) => {
      const next = { ...current };
      for (const folder of folders) next[folder.driveItemId] = { name: folder.name, parentId };
      return next;
    });
  }, []);

  const openFolderId = useCallback(async (folderId: string, force = false) => {
    const requestId = ++requestRef.current;
    setCurrentId(folderId);
    setQuery("");
    setPreviewItem(null);
    setLoading(true);
    setError(null);
    const result = await fetchFolder(folderId, force);
    if (requestId !== requestRef.current) return;
    setLoading(false);
    setItems(result.items);
    if (result.error) setError(result.error);
    rememberFolders(folderId, result.items);
  }, [fetchFolder, rememberFolders]);

  useEffect(() => {
    queueMicrotask(() => void openFolderId(FINAL_ROOT_FOLDER_ID));
  }, [openFolderId]);

  const breadcrumbs: FolderCrumb[] = useMemo(() => {
    const chain: FolderCrumb[] = [];
    const seen = new Set<string>();
    let cursor: string | null = currentId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.unshift({ driveItemId: cursor, name: meta[cursor]?.name ?? "Folder", key: cursor });
      cursor = meta[cursor]?.parentId ?? null;
    }
    return chain;
  }, [currentId, meta]);

  const visibleItems = query.trim()
    ? items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()))
    : items;
  const folderCount = items.filter((item) => item.itemType === "FOLDER").length;
  const summary = loading ? "Loading…" : `${folderCount} folders · ${items.length - folderCount} files`;

  function openItem(item: DriveItem) {
    if (item.itemType === "FOLDER") {
      void openFolderId(item.driveItemId);
      return;
    }
    window.open(driveOpenUrl(item), "_blank", "noopener,noreferrer");
  }

  async function syncCurrent() {
    setSyncing(true);
    syncedRef.current.delete(currentId);
    await openFolderId(currentId, true);
    setSyncing(false);
  }

  return (
    <div className={cn("grid min-h-0 min-w-0 flex-1", panelOpen ? "grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_360px]" : "grid-cols-[minmax(0,1fr)]")}>
      <div className={cn("min-w-0", panelOpen && "border-r border-border")}>
        <DriveToolbar
          query={query}
          setQuery={setQuery}
          viewMode={viewMode}
          setViewMode={setViewMode}
          syncing={syncing}
          onSync={() => void syncCurrent()}
          breadcrumbs={breadcrumbs}
          summary={summary}
          onBreadcrumbSelect={(index) => {
            const crumb = breadcrumbs[index];
            if (crumb?.driveItemId) void openFolderId(crumb.driveItemId);
          }}
          onRefresh={() => void openFolderId(currentId)}
          previewPanelOpen={panelOpen}
          onTogglePreviewPanel={() => setPanelOpen((open) => !open)}
        />
        <div className="min-h-[calc(100vh-72px)] min-w-0">
          <DriveContent
            items={visibleItems}
            gridClassName="final-output-grid"
            selectedItem={previewItem}
            previewItem={previewItem}
            onSelect={(id) => {
              const item = visibleItems.find((candidate) => candidate.id === id);
              if (!item) return;
              setPreviewItem(item);
              setPanelOpen(true);
            }}
            onPreview={(item) => {
              setPreviewItem(item);
              setPanelOpen(true);
            }}
            onOpen={openItem}
            viewMode={viewMode}
            loading={loading}
            error={error}
            query={query}
            isRootFolder={currentId === FINAL_ROOT_FOLDER_ID}
            onBack={() => {
              const parent = meta[currentId]?.parentId;
              if (parent) void openFolderId(parent);
            }}
            onSync={() => void syncCurrent()}
          />
        </div>
      </div>
      {panelOpen ? (
        <FinalPreviewPanel
          item={previewItem}
          onClose={() => setPanelOpen(false)}
          onOpenFolder={(folder) => void openFolderId(folder.driveItemId)}
        />
      ) : null}
    </div>
  );
}

function FinalPreviewPanel({
  item,
  onClose,
  onOpenFolder,
}: {
  item: DriveItem | null;
  onClose: () => void;
  onOpenFolder: (folder: DriveItem) => void;
}) {
  const header = (
    <div className="mb-4 flex items-center justify-between">
      <h3 className="text-sm font-semibold">{item ? (item.itemType === "FOLDER" ? "Folder" : "File Preview") : "Preview"}</h3>
      <Button variant="ghost" size="icon" title="Hide details panel" aria-label="Hide details panel" onClick={onClose}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );

  if (!item) {
    return (
      <aside className="bg-card p-5">
        {header}
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          Select a file to preview. Double-click to open it in Google Drive.
        </div>
      </aside>
    );
  }

  const isFolder = item.itemType === "FOLDER";
  const isImage = item.itemType === "IMAGE";
  const isVideo = item.itemType === "VIDEO";
  const previewId = encodeURIComponent(item.driveItemId);

  return (
    <aside className="overflow-auto bg-card p-5">
      {header}
      <div className="mb-4 overflow-hidden rounded-tile border border-border bg-brand-cream/50">
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`https://drive.google.com/thumbnail?id=${previewId}&sz=w1000`}
            alt={item.name}
            referrerPolicy="no-referrer"
            className="max-h-[420px] w-full object-contain"
          />
        ) : isVideo ? (
          <iframe
            src={`https://drive.google.com/file/d/${previewId}/preview`}
            title={item.name}
            allow="autoplay"
            className="aspect-video w-full"
          />
        ) : (
          <div className="flex aspect-video items-center justify-center">
            {isFolder ? <FolderGlyph className="h-16" /> : <File className="h-12 w-12 text-muted-foreground" />}
          </div>
        )}
      </div>
      <div className="mb-4 break-words text-sm font-medium">{item.name}</div>
      <dl className="mb-5 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-md border border-border p-3">
          <dt className="text-xs text-muted-foreground">Modified</dt>
          <dd>{formatDate(item.modifiedTime)}</dd>
        </div>
        <div className="rounded-md border border-border p-3">
          <dt className="text-xs text-muted-foreground">{isFolder ? "Type" : "Size"}</dt>
          <dd>{isFolder ? "Folder" : formatBytes(item.sizeBytes)}</dd>
        </div>
      </dl>
      <div className="space-y-2">
        {isFolder ? (
          <Button className="w-full" onClick={() => onOpenFolder(item)}>
            <FolderOpen className="mr-2 h-4 w-4" />
            Open folder
          </Button>
        ) : (
          <Button className="w-full" onClick={() => window.open(driveDownloadUrl(item), "_blank", "noopener,noreferrer")}>
            <Download className="mr-2 h-4 w-4" />
            Download
          </Button>
        )}
        <Button
          variant="outline"
          className="w-full"
          onClick={() => window.open(driveOpenUrl(item), "_blank", "noopener,noreferrer")}
        >
          <Share2 className="mr-2 h-4 w-4" />
          Open in Google Drive
        </Button>
      </div>
    </aside>
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
