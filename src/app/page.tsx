"use client";

import {
  Activity,
  BellRing,
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
  Pencil,
  Play,
  RefreshCw,
  Search,
  Share2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  Workflow,
  X,
  ImageIcon,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoginScreen } from "@/components/auth/login-screen";
import { Badge } from "@/components/ui/badge";
import { FolderGlyph } from "@/components/ui/folder-glyph";
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
  StorageBreadcrumb,
  StorageItem,
  WorkflowJob,
  WorkflowStatus,
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

// Model tab — Supabase Storage constants
const MODEL_BUCKET = "BAartworkShopify";
const MODEL_ROOT_PATH = "google-drive/Model";
// Storage folder mirroring the Drive root (see drive-list-folder DEFAULT_ROOT_PATH)
const DRIVE_STORAGE_ROOT = "google-drive/01_New_Product_Raw";

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
  const [loadingDrive, setLoadingDrive] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);

  // ── Model tab state (Supabase Storage, no Google Drive) ───────────────────
  const [modelPath, setModelPath] = useState(MODEL_ROOT_PATH);
  const [modelItems, setModelItems] = useState<StorageItem[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelPreviewItem, setModelPreviewItem] = useState<StorageItem | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  // ── Model CRUD state ──────────────────────────────────────────
  const [modelUploading, setModelUploading] = useState(false);
  const [modelDeleteItem, setModelDeleteItem] = useState<StorageItem | null>(null);
  const [modelDeleteLoading, setModelDeleteLoading] = useState(false);
  const [modelRenameItem, setModelRenameItem] = useState<StorageItem | null>(null);
  const [modelRenameName, setModelRenameName] = useState("");
  const [modelRenameLoading, setModelRenameLoading] = useState(false);
  const modelFileInputRef = useRef<HTMLInputElement>(null);
  // ── Drag-and-drop state ───────────────────────────────────────
  const [modelDragOver, setModelDragOver] = useState(false);
  // ── Model Picker dialog (for Model Reference URL) ──────────────────────────
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerPath, setModelPickerPath] = useState(MODEL_ROOT_PATH);
  const [modelPickerItems, setModelPickerItems] = useState<StorageItem[]>([]);
  const [modelPickerLoading, setModelPickerLoading] = useState(false);
  const [modelPickerSelected, setModelPickerSelected] = useState<StorageItem | null>(null);

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

  const driveSummary = useMemo(() => {
    const folderCount = filteredItems.filter((item) => item.itemType === "FOLDER").length;
    const fileCount = filteredItems.length - folderCount;
    return `${folderCount} ${folderCount === 1 ? "folder" : "folders"} · ${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  }, [filteredItems]);

  // ── Model breadcrumbs — computed from modelPath string ─────────────────────
  const modelBreadcrumbs = useMemo<StorageBreadcrumb[]>(() => {
    // modelPath = "google-drive/Model/Folder A/Folder B"
    // Remove "google-drive/" prefix so display starts at "Model"
    const relative = modelPath.replace(/^google-drive\//, "");
    const parts = relative.split("/");
    return parts.map((part, i) => ({
      label: part,
      path: "google-drive/" + parts.slice(0, i + 1).join("/"),
    }));
  }, [modelPath]);

  // ── Model filtered items — search within current Storage path only ─────────
  const modelFilteredItems = useMemo(() => {
    const normalized = modelQuery.trim().toLowerCase();
    if (!normalized) return modelItems;
    return modelItems.filter((item) => item.name.toLowerCase().includes(normalized));
  }, [modelItems, modelQuery]);

  const fetchDriveFolder = useCallback(async (
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

  const storeFolderChildren = useCallback((key: string, children: DriveItem[], parentName?: string) => {
    const foldersOnly = children.filter((item) => item.itemType === "FOLDER");
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
    setLoadingDrive(true);
    setAppError(null);
    const key = getFolderKey(folderDriveId, storagePath);
    const { response, items: normalizedItems, folder: normalizedFolder } = await fetchDriveFolder(token, folderDriveId, storagePath);

    setLoadingDrive(false);

    if (!response?.success || !response.data) {
      setItems([]);
      setPreviewItem(null);
      setSelectedItem(null);
      setAppError(response.error?.message ?? "Could not load Google Drive metadata from Supabase.");
      return;
    }

    storeFolderChildren(key, normalizedItems, normalizedFolder?.name);
    setItems(normalizedItems);
    setCurrentFolder(normalizedFolder);
    setCurrentFolderKey(key);
    setBreadcrumbs(buildCrumbs(key));
    expandAncestors(key);
    setPreviewItem(normalizedItems[0] ?? null);
    setSelectedItem(null);
  }, [buildCrumbs, expandAncestors, fetchDriveFolder, storeFolderChildren]);

  // ── Model tab: load from Supabase Storage directly — no Drive API ──────────
  const loadStorageItems = useCallback(async (path: string) => {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;

    setModelLoading(true);
    setModelError(null);

    const { data, error } = await supabase.storage
      .from(MODEL_BUCKET)
      .list(path, {
        limit: 500,
        offset: 0,
        sortBy: { column: "name", order: "asc" },
      });

    setModelLoading(false);

    if (error) {
      console.error("Storage list error:", error);
      setModelError(error.message);
      return;
    }

    const mapped: StorageItem[] = (data ?? [])
      .filter((item) => item.name !== ".emptyFolderPlaceholder")
      .map((item) => {
        const filePath = `${path}/${item.name}`;
        const mimeType = (item.metadata?.mimetype as string) ?? null;
        const isImageFile = !!item.metadata && mimeType?.startsWith("image/");

        // getPublicUrl is synchronous — safe for public bucket (BAartworkShopify is PUBLIC)
        const thumbnailUrl = isImageFile
          ? (supabase.storage.from(MODEL_BUCKET).getPublicUrl(filePath).data?.publicUrl ?? null)
          : null;

        return {
          id: item.name,
          name: item.name,
          path: filePath,
          // Supabase Storage: metadata is null for folders, object for files
          type: (item.metadata ? "file" : "folder") as "file" | "folder",
          mimeType,
          sizeBytes: (item.metadata?.size as number) ?? null,
          updatedAt: (item.updated_at as string) ?? null,
          metadata: (item.metadata as Record<string, unknown>) ?? null,
          thumbnailUrl,
        };
      });

    setModelItems(mapped);
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

  // ── Trigger Model Storage load when modelPath or activeTab changes ─────────
  useEffect(() => {
    if (activeTab === "model") {
      queueMicrotask(() => {
        void loadStorageItems(modelPath);
      });
    }
  }, [modelPath, activeTab, loadStorageItems]);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token ?? null;
      setAccessToken(token);
      setUserEmail(data.session?.user.email ?? null);
      setIsSignedIn(Boolean(token));
      if (token) {
        void loadDrive(token);
        void loadJobs(token);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const token = session?.access_token ?? null;
      setAccessToken(token);
      setUserEmail(session?.user.email ?? null);
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
    setFinalFiles([]);
    setFinalRuns([]);
    setFinalError(null);
    setAppError(null);
  }

  function switchTab(tab: WorkspaceTab) {
    setActiveTab(tab);
    if (tab === "model") {
      // Reset Model to root — useEffect will trigger loadStorageItems
      setModelPath(MODEL_ROOT_PATH);
      setModelPreviewItem(null);
      setModelQuery("");
    }
    if (tab === "browser") {
      if (accessToken) void loadDrive(accessToken);
    }
  }

  function openModelItem(item: StorageItem) {
    if (item.type === "folder") {
      setModelPath(item.path);
      setModelQuery("");
    } else {
      setModelPreviewItem(item);
    }
  }

  // ── Model CRUD functions ──────────────────────────────────────────

  async function uploadToModel(files: FileList | null) {
    if (!files || files.length === 0) return;
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;
    setModelUploading(true);
    for (const file of Array.from(files)) {
      const destPath = `${modelPath}/${file.name}`;
      await supabase.storage.from(MODEL_BUCKET).upload(destPath, file, { upsert: true });
    }
    setModelUploading(false);
    // Reset file input so same file can be picked again
    if (modelFileInputRef.current) modelFileInputRef.current.value = "";
    void loadStorageItems(modelPath);
  }

  async function deleteModelItem() {
    const item = modelDeleteItem;
    if (!item) return;
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;
    setModelDeleteLoading(true);
    if (item.type === "file") {
      await supabase.storage.from(MODEL_BUCKET).remove([item.path]);
    } else {
      // Only delete empty folders — Supabase has no folder API,
      // so attempt to remove the hidden placeholder or nothing and let list confirm empty
      const { data: children } = await supabase.storage.from(MODEL_BUCKET).list(item.path, { limit: 10 });
      const realChildren = (children ?? []).filter(c => c.name !== ".emptyFolderPlaceholder");
      if (realChildren.length > 0) {
        setModelDeleteLoading(false);
        setModelDeleteItem(null);
        setModelError(`Cannot delete "${item.name}": folder is not empty (${realChildren.length} item${realChildren.length > 1 ? "s" : ""} inside).`);
        return;
      }
      // Delete the placeholder if exists
      await supabase.storage.from(MODEL_BUCKET).remove([`${item.path}/.emptyFolderPlaceholder`]);
    }
    setModelDeleteLoading(false);
    setModelDeleteItem(null);
    if (modelPreviewItem?.id === item.id) setModelPreviewItem(null);
    void loadStorageItems(modelPath);
  }

  async function renameModelItem() {
    const item = modelRenameItem;
    const newName = modelRenameName.trim();
    if (!item || !newName || newName === item.name) { setModelRenameItem(null); return; }
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;
    setModelRenameLoading(true);
    // Compute parent path = everything in item.path before the last slash
    const parentPath = item.path.substring(0, item.path.lastIndexOf("/"));
    const newPath = `${parentPath}/${newName}`;
    await supabase.storage.from(MODEL_BUCKET).move(item.path, newPath);
    setModelRenameLoading(false);
    setModelRenameItem(null);
    if (modelPreviewItem?.id === item.id) setModelPreviewItem(null);
    void loadStorageItems(modelPath);
  }

  function downloadModelItem(item: StorageItem) {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;
    const { data } = supabase.storage.from(MODEL_BUCKET).getPublicUrl(item.path);
    if (data?.publicUrl) {
      const a = document.createElement("a");
      a.href = data.publicUrl;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }

  // ── Model Picker dialog functions ──────────────────────────────────────────

  async function loadPickerItems(path: string) {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;
    setModelPickerLoading(true);
    const { data, error } = await supabase.storage
      .from(MODEL_BUCKET)
      .list(path, { limit: 500, sortBy: { column: "name", order: "asc" } });
    setModelPickerLoading(false);
    if (error || !data) return;
    const mapped: StorageItem[] = data
      .filter((item) => item.name !== ".emptyFolderPlaceholder")
      .map((item) => {
        const filePath = `${path}/${item.name}`;
        const mimeType = (item.metadata?.mimetype as string) ?? null;
        const isImageFile = !!item.metadata && mimeType?.startsWith("image/");
        const thumbnailUrl = isImageFile
          ? (supabase.storage.from(MODEL_BUCKET).getPublicUrl(filePath).data?.publicUrl ?? null)
          : null;
        return {
          id: item.name,
          name: item.name,
          path: filePath,
          type: (item.metadata ? "file" : "folder") as "file" | "folder",
          mimeType,
          sizeBytes: (item.metadata?.size as number) ?? null,
          updatedAt: (item.updated_at as string) ?? null,
          metadata: (item.metadata as Record<string, unknown>) ?? null,
          thumbnailUrl,
        };
      });
    setModelPickerItems(mapped);
  }

  function openModelPicker() {
    setModelPickerOpen(true);
    setModelPickerPath(MODEL_ROOT_PATH);
    setModelPickerSelected(null);
    void loadPickerItems(MODEL_ROOT_PATH);
  }

  function confirmModelPicker() {
    if (!modelPickerSelected) return;
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;
    const { data } = supabase.storage.from(MODEL_BUCKET).getPublicUrl(modelPickerSelected.path);
    if (data?.publicUrl) {
      setModelReferenceUrl(data.publicUrl);
    }
    setModelPickerOpen(false);
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
      root_folder_id: currentFolder?.driveItemId ?? "1vP62rBKIsfZGPZy7TXHsRwQLdO7pJ4W2",
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

  async function submitWorkflow() {
    if (!accessToken || !selectedItem) return;

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
        <AppSidebar
          activeTab={activeTab}
          onTabChange={switchTab}
          userEmail={userEmail}
          signingOut={signingOut}
          onSignOut={() => void signOut()}
        />
        <section className="flex min-w-0 flex-col">
          <TopBar
            selectedItem={selectedItem}
            onRunWorkflow={submitWorkflow}
          />

          {/* ── Drive Browser tab ─────────────────────────────────────── */}
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
                onOpenModelPicker={openModelPicker}
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
            </div>
          ) : null}

          {/* ── Model tab (Supabase Storage, no Google Drive) ─────────── */}
          {activeTab === "model" ? (
            <div className="relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px]">
              {/* Hidden file input for upload */}
              <input
                ref={modelFileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => void uploadToModel(e.target.files)}
              />

              <div
                className={cn(
                  "relative min-w-0 border-r border-border",
                  modelDragOver && "ring-2 ring-primary ring-inset",
                )}
                onDragOver={(e) => { e.preventDefault(); setModelDragOver(true); }}
                onDragLeave={() => setModelDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setModelDragOver(false);
                  void uploadToModel(e.dataTransfer.files);
                }}
              >
                {/* Drag overlay */}
                {modelDragOver && (
                  <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-sm bg-primary/10">
                    <div className="rounded-md border-2 border-dashed border-primary bg-background px-8 py-6 text-center shadow-lg">
                      <UploadCloud className="mx-auto mb-2 h-8 w-8 text-primary" />
                      <div className="font-semibold text-primary">Drop files to upload</div>
                    </div>
                  </div>
                )}

                <ModelToolbar
                  query={modelQuery}
                  setQuery={setModelQuery}
                  viewMode={viewMode}
                  setViewMode={setViewMode}
                  breadcrumbs={modelBreadcrumbs}
                  rootPath={MODEL_ROOT_PATH}
                  onBreadcrumbSelect={(path) => setModelPath(path)}
                  onRefresh={() => void loadStorageItems(modelPath)}
                  uploading={modelUploading}
                  onUpload={() => modelFileInputRef.current?.click()}
                />
                <ModelContent
                  items={modelFilteredItems}
                  previewItem={modelPreviewItem}
                  onOpen={openModelItem}
                  onPreview={setModelPreviewItem}
                  onDownload={downloadModelItem}
                  onRename={(item) => { setModelRenameItem(item); setModelRenameName(item.name); }}
                  onDelete={(item) => setModelDeleteItem(item)}
                  viewMode={viewMode}
                  loading={modelLoading}
                  error={modelError}
                />
              </div>
              <ModelPreviewPanel item={modelPreviewItem} onOpenFolder={openModelItem} />

              {/* ── Rename dialog ── */}
              {modelRenameItem ? (
                <ModelRenameDialog
                  item={modelRenameItem}
                  name={modelRenameName}
                  onNameChange={setModelRenameName}
                  onConfirm={() => void renameModelItem()}
                  onCancel={() => setModelRenameItem(null)}
                  loading={modelRenameLoading}
                />
              ) : null}

              {/* ── Delete dialog ── */}
              {modelDeleteItem ? (
                <ModelDeleteDialog
                  item={modelDeleteItem}
                  onConfirm={() => void deleteModelItem()}
                  onCancel={() => setModelDeleteItem(null)}
                  loading={modelDeleteLoading}
                />
              ) : null}
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

      {/* ── Model Picker dialog ── */}
      {modelPickerOpen ? (
        <ModelPickerDialog
          path={modelPickerPath}
          setPath={setModelPickerPath}
          items={modelPickerItems}
          loading={modelPickerLoading}
          selected={modelPickerSelected}
          onSelect={setModelPickerSelected}
          onConfirm={confirmModelPicker}
          onCancel={() => setModelPickerOpen(false)}
          onRefresh={() => void loadPickerItems(modelPickerPath)}
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
  summary,
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
  summary: string;
  onBreadcrumbSelect: (index: number) => void;
  onRefresh: () => void;
}) {
  // Long paths collapse to: Root › … › parent › current
  const visibleCrumbs = breadcrumbs.length > 4
    ? [0, -1, breadcrumbs.length - 2, breadcrumbs.length - 1]
    : breadcrumbs.map((_, index) => index);

  return (
    <div className="flex h-[72px] items-center justify-between border-b border-border px-5">
      <div className="min-w-0 flex-1 pr-4">
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
              <span key={`${crumb.driveItemId ?? "root"}-${index}`} className="flex min-w-0 items-center gap-0.5">
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
                  <span className="max-w-[180px] truncate">{crumb.name}</span>
                </button>
              </span>
            );
          })}
        </nav>
        <div className="mt-0.5 pl-1.5 text-xs text-muted-foreground">{summary}</div>
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

// ─── Model tab components (Supabase Storage) ───────────────────────────────────

function ModelToolbar({
  query,
  setQuery,
  viewMode,
  setViewMode,
  breadcrumbs,
  rootPath,
  onBreadcrumbSelect,
  onRefresh,
  uploading,
  onUpload,
}: {
  query: string;
  setQuery: (value: string) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  breadcrumbs: StorageBreadcrumb[];
  rootPath: string;
  onBreadcrumbSelect: (path: string) => void;
  onRefresh: () => void;
  uploading: boolean;
  onUpload: () => void;
}) {
  return (
    <div className="flex h-[72px] items-center justify-between border-b border-border px-5">
      <div className="min-w-0">
        <div className="flex max-w-[460px] items-center gap-1 overflow-hidden text-sm text-muted-foreground">
          {breadcrumbs.map((crumb, index) => (
            <div key={crumb.path} className="flex min-w-0 items-center gap-1">
              {index > 0 ? <ChevronRight className="h-3 w-3 shrink-0" /> : null}
              <button
                className={cn(
                  "truncate rounded-sm px-1 py-0.5 hover:bg-secondary hover:text-foreground",
                  index === 0 && crumb.path === rootPath
                    ? "cursor-default font-medium text-foreground"
                    : index === breadcrumbs.length - 1
                      ? "font-medium text-foreground"
                      : "cursor-pointer",
                )}
                onClick={() => {
                  if (crumb.path === rootPath && index === 0 && breadcrumbs.length === 1) return;
                  onBreadcrumbSelect(crumb.path);
                }}
                disabled={index === breadcrumbs.length - 1}
              >
                {crumb.label}
              </button>
            </div>
          ))}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          Drag & drop to upload · click files to preview
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative w-[220px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button
          variant="default"
          className="gap-1.5"
          onClick={onUpload}
          disabled={uploading}
          title="Upload files to current folder"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <UploadCloud className="h-4 w-4" />
          )}
          {uploading ? "Uploading…" : "Upload"}
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

function ModelContent({
  items,
  previewItem,
  onOpen,
  onPreview,
  onDownload,
  onRename,
  onDelete,
  viewMode,
  loading,
  error,
}: {
  items: StorageItem[];
  previewItem: StorageItem | null;
  onOpen: (item: StorageItem) => void;
  onPreview: (item: StorageItem) => void;
  onDownload: (item: StorageItem) => void;
  onRename: (item: StorageItem) => void;
  onDelete: (item: StorageItem) => void;
  viewMode: ViewMode;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <section className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4 p-5">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="h-[220px] animate-pulse rounded-md border border-border bg-card">
            <div className="h-32 bg-muted" />
            <div className="space-y-3 p-3">
              <div className="h-4 rounded-sm bg-muted" />
              <div className="h-4 w-2/3 rounded-sm bg-muted" />
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
          <div className="font-medium">No items in this folder</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload files using the Upload button or drag & drop.
          </p>
        </div>
      </div>
    );
  }

  return (
    <section className="min-w-0 p-5">
      {viewMode === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          {items.map((item) => (
            <ModelCard
              key={item.id}
              item={item}
              isPreview={previewItem?.id === item.id}
              onOpen={() => onOpen(item)}
              onPreview={() => onPreview(item)}
              onDownload={() => onDownload(item)}
              onRename={() => onRename(item)}
              onDelete={() => onDelete(item)}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card">
          {items.map((item) => (
            <ModelRow
              key={item.id}
              item={item}
              isPreview={previewItem?.id === item.id}
              onOpen={() => onOpen(item)}
              onPreview={() => onPreview(item)}
              onDownload={() => onDownload(item)}
              onRename={() => onRename(item)}
              onDelete={() => onDelete(item)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ModelCard({
  item,
  isPreview,
  onOpen,
  onPreview,
  onDownload,
  onRename,
  onDelete,
}: {
  item: StorageItem;
  isPreview: boolean;
  onOpen: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const publicUrl = item.thumbnailUrl ?? (item.type === "file" ? createBrowserSupabaseClient()?.storage.from(MODEL_BUCKET).getPublicUrl(item.path).data?.publicUrl ?? null : null);
  const meta = item.sizeBytes !== null ? `${item.updatedAt ? formatDate(item.updatedAt) : "Storage"} · ${formatBytes(item.sizeBytes)}` : item.updatedAt ? formatDate(item.updatedAt) : "Folder";

  function showCopied() {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function copyText(value: string | null) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    showCopied();
  }

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <article
      className={cn(
        "group relative flex flex-col rounded-card bg-card p-2 transition focus-within:shadow-[0_6px_24px_rgba(28,28,28,0.08)] hover:bg-card hover:shadow-[0_6px_24px_rgba(28,28,28,0.08)]",
        isPreview && "bg-card ring-1 ring-primary",
      )}
    >
      <button
        className="relative flex aspect-[4/3] w-full select-none items-center justify-center overflow-hidden rounded-tile border border-border bg-card"
        title={item.type === "folder" ? "Double-click to open" : "Click to preview"}
        {...previewOpenHandlers(onPreview, onOpen)}
      >
        {item.type === "folder" ? (
          <div className="flex h-full items-center justify-center">
            <FolderGlyph className="h-16 transition-transform duration-300 group-hover:scale-110" />
          </div>
        ) : item.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumbnailUrl}
            alt={item.name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : item.mimeType?.startsWith("video/") ? (
          <div className="flex h-full items-center justify-center">
            <Film className="h-10 w-10 text-muted-foreground" />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <File className="h-10 w-10 text-muted-foreground" />
          </div>
        )}
      </button>
      <div className="flex flex-1 flex-col">
        <button className="mt-3 line-clamp-1 w-full select-none text-center text-sm font-medium" title={item.name} {...previewOpenHandlers(onPreview, onOpen)}>
          {item.name}
        </button>
        <div className="relative mt-1 h-8">
          <div className={cn("flex h-8 items-center justify-center truncate text-xs text-muted-foreground transition-opacity group-focus-within:opacity-0 group-hover:opacity-0", isPreview && "opacity-0")}>
            {copied ? "Copied" : meta}
          </div>
          <div className={cn("absolute inset-0 flex items-center justify-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100", isPreview && "opacity-100")}>
          {/* ··· context menu */}
          <div ref={menuRef} className="relative">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-full hover:bg-secondary"
              title="More options"
              aria-label="More options"
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
            {menuOpen && (
              <div className="absolute right-0 bottom-full z-50 mb-1 min-w-[140px] overflow-hidden rounded-md border border-border bg-card shadow-lg">
                {item.type === "file" && (
                  <>
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary"
                      onClick={() => { onPreview(); setMenuOpen(false); }}
                    >
                      <FileImage className="h-3.5 w-3.5" /> Preview
                    </button>
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary"
                      onClick={() => { onDownload(); setMenuOpen(false); }}
                    >
                      <Download className="h-3.5 w-3.5" /> Download
                    </button>
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary"
                      onClick={() => { onRename(); setMenuOpen(false); }}
                    >
                      <Pencil className="h-3.5 w-3.5" /> Rename
                    </button>
                  </>
                )}
                {item.type === "folder" && (
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary"
                    onClick={() => { onOpen(); setMenuOpen(false); }}
                  >
                    <FolderGlyph className="h-3.5" /> Open
                  </button>
                )}
                <div className="my-1 border-t border-border" />
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                  onClick={() => { onDelete(); setMenuOpen(false); }}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </div>
            )}
          </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-secondary" title="Copy path" aria-label="Copy path" onClick={() => void copyText(item.path)}>
              <Copy className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-secondary" title="Copy link" aria-label="Copy link" disabled={!publicUrl} onClick={() => void copyText(publicUrl)}>
              <Link className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-secondary" title="Open link" aria-label="Open link" disabled={!publicUrl} onClick={() => publicUrl ? window.open(publicUrl, "_blank", "noopener") : undefined}>
              <Share2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function ModelRow({
  item,
  isPreview,
  onOpen,
  onPreview,
  onDownload,
  onRename,
  onDelete,
}: {
  item: StorageItem;
  isPreview: boolean;
  onOpen: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isFolder = item.type === "folder";
  const Icon = item.mimeType?.startsWith("video/") ? Film : item.mimeType?.startsWith("image/") ? FileImage : File;

  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_90px_110px_44px] items-center border-b border-border px-4 py-2.5 last:border-b-0",
        isPreview && "bg-primary/5",
      )}
    >
      <button className="flex min-w-0 select-none items-center gap-3 text-left" {...previewOpenHandlers(onPreview, onOpen)}>
        {isFolder ? <FolderGlyph className="h-4 shrink-0" /> : <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="truncate text-sm font-medium">{item.name}</span>
      </button>
      <span className="text-xs capitalize text-muted-foreground">{item.type}</span>
      <span className="text-xs text-muted-foreground">
        {item.sizeBytes !== null ? formatBytes(item.sizeBytes) : "—"}
      </span>
      <div ref={menuRef} className="relative flex justify-end">
        <Button
          variant="ghost"
          size="icon"
          title="More options"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 min-w-[140px] overflow-hidden rounded-md border border-border bg-card shadow-lg">
            {item.type === "file" && (
              <>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary"
                  onClick={() => { onPreview(); setMenuOpen(false); }}
                >
                  <FileImage className="h-3.5 w-3.5" /> Preview
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary"
                  onClick={() => { onDownload(); setMenuOpen(false); }}
                >
                  <Download className="h-3.5 w-3.5" /> Download
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary"
                  onClick={() => { onRename(); setMenuOpen(false); }}
                >
                  <Pencil className="h-3.5 w-3.5" /> Rename
                </button>
              </>
            )}
            <div className="my-1 border-t border-border" />
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
              onClick={() => { onDelete(); setMenuOpen(false); }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ModelPreviewPanel({
  item,
  onOpenFolder,
}: {
  item: StorageItem | null;
  onOpenFolder: (folder: StorageItem) => void;
}) {
  // Compute public URL synchronously — bucket BAartworkShopify is PUBLIC
  // For images: thumbnailUrl is already computed during loadStorageItems
  // For video/audio: compute here inline
  const supabase = createBrowserSupabaseClient();
  const publicUrl = item?.type === "file" && supabase
    ? (supabase.storage.from(MODEL_BUCKET).getPublicUrl(item.path).data?.publicUrl ?? null)
    : null;

  if (!item) {
    return (
      <aside className="bg-card p-5">
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          <File className="mx-auto mb-3 h-8 w-8" />
          Click a file to preview it here.
        </div>
      </aside>
    );
  }

  if (item.type === "folder") {
    return (
      <aside className="bg-card p-5">
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          <FolderGlyph className="mx-auto mb-3 h-10" />
          <div className="font-medium">{item.name}</div>
          <Button className="mt-4 w-full" onClick={() => onOpenFolder(item)}>
            <FolderOpen className="h-4 w-4" />
            Open folder
          </Button>
          <p className="mt-2 text-xs">Tip: double-click a folder to open it</p>
        </div>
      </aside>
    );
  }

  const isImage = item.mimeType?.startsWith("image/");
  const isVideo = item.mimeType?.startsWith("video/");
  const isAudio = item.mimeType?.startsWith("audio/");

  // For image: use thumbnailUrl (already computed, same public URL)
  // For video/audio: use publicUrl computed above
  const previewUrl = isImage ? item.thumbnailUrl : publicUrl;

  return (
    <aside className="overflow-auto bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">File Preview</h3>
      </div>

      {/* Preview area */}
      <div className="mb-4 overflow-hidden rounded-md bg-secondary">
        {previewUrl && isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={item.name}
            className="max-h-[360px] w-full object-contain"
          />
        ) : previewUrl && isVideo ? (
          <video
            src={previewUrl}
            controls
            className="max-h-[360px] w-full"
          />
        ) : previewUrl && isAudio ? (
          <div className="p-4">
            <audio src={previewUrl} controls className="w-full" />
          </div>
        ) : (
          <div className="flex aspect-video items-center justify-center">
            <File className="h-12 w-12 text-muted-foreground" />
          </div>
        )}
      </div>

      {/* File metadata */}
      <div className="space-y-3">
        <div>
          <div className="text-base font-semibold">{item.name}</div>
          {item.mimeType ? (
            <div className="mt-1 text-xs text-muted-foreground">{item.mimeType}</div>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {item.sizeBytes !== null ? (
            <Info label="Size" value={formatBytes(item.sizeBytes)} />
          ) : null}
          <Info label="Type" value={item.type} />
          {item.updatedAt ? (
            <Info label="Modified" value={formatDate(item.updatedAt)} />
          ) : null}
        </div>
        {publicUrl ? (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => window.open(publicUrl, "_blank", "noopener,noreferrer")}
          >
            <Link className="h-4 w-4" />
            Open in new tab
          </Button>
        ) : null}
      </div>
    </aside>
  );
}

// ─── Model CRUD dialogs ─────────────────────────────────────────────────────

function ModelRenameDialog({
  item,
  name,
  onNameChange,
  onConfirm,
  onCancel,
  loading,
}: {
  item: StorageItem;
  name: string;
  onNameChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-xl">
        <h2 className="mb-1 text-base font-semibold">Rename file</h2>
        <p className="mb-4 truncate text-sm text-muted-foreground">{item.name}</p>
        <Input
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm();
            if (e.key === "Escape") onCancel();
          }}
          placeholder="New file name"
          className="mb-4"
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={loading || !name.trim() || name === item.name}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Rename
          </Button>
        </div>
      </div>
    </div>
  );
}

function ModelDeleteDialog({
  item,
  onConfirm,
  onCancel,
  loading,
}: {
  item: StorageItem;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-xl">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100">
            <Trash2 className="h-5 w-5 text-red-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold">
              Delete {item.type === "folder" ? "folder" : "file"}
            </h2>
            <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
          </div>
        </div>
        <div className="mb-4 rounded-md bg-secondary px-3 py-2 text-sm">
          <span className="font-medium">{item.name}</span>
          {item.type === "folder" && (
            <p className="mt-1 text-xs text-muted-foreground">
              Only empty folders can be deleted. Files inside must be removed first.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Model Picker Dialog ───────────────────────────────────────────────────

function ModelPickerDialog({
  path,
  setPath,
  items,
  loading,
  selected,
  onSelect,
  onConfirm,
  onCancel,
  onRefresh,
}: {
  path: string;
  setPath: (p: string) => void;
  items: StorageItem[];
  loading: boolean;
  selected: StorageItem | null;
  onSelect: (item: StorageItem | null) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="flex h-full max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h2 className="text-lg font-semibold">Select Model Image</h2>
            <div className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
              {path !== MODEL_ROOT_PATH ? (
                <button
                  className="flex items-center hover:text-foreground"
                  onClick={() => {
                    const parent = path.substring(0, path.lastIndexOf("/"));
                    setPath(parent || MODEL_ROOT_PATH);
                  }}
                >
                  <ChevronRight className="mr-1 h-3 w-3 rotate-180" /> Back
                </button>
              ) : (
                <span>Root</span>
              )}
              <span className="text-border">/</span>
              <span className="truncate max-w-[300px]">{path.replace(MODEL_ROOT_PATH, "") || "Model"}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={onRefresh}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
            <Button variant="ghost" size="icon" onClick={onCancel}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20 p-4">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
              <FolderGlyph className="mb-2 h-10" />
              <p>Empty folder</p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
              {items.map((item) => {
                const isSelected = selected?.id === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      if (item.type === "folder") {
                        setPath(item.path);
                        onSelect(null);
                      } else {
                        onSelect(item);
                      }
                    }}
                    className={cn(
                      "group relative flex aspect-square flex-col items-center justify-center overflow-hidden rounded-md border bg-card transition-all hover:border-primary/50 hover:shadow-md",
                      isSelected ? "border-primary ring-2 ring-primary ring-offset-1" : "border-border",
                    )}
                  >
                    {item.type === "folder" ? (
                      <div className="flex h-full w-full flex-col items-center justify-center bg-secondary/50">
                        <FolderGlyph className="mb-2 h-10" />
                        <span className="truncate px-2 text-center text-xs font-medium w-full">{item.name}</span>
                      </div>
                    ) : item.thumbnailUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={item.thumbnailUrl}
                          alt={item.name}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                        <div className="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1.5 text-center text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                          <span className="truncate block">{item.name}</span>
                        </div>
                      </>
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center bg-secondary/50">
                        <FileImage className="mb-2 h-8 w-8 text-muted-foreground" />
                        <span className="truncate px-2 text-center text-xs font-medium w-full">{item.name}</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border bg-card p-4">
          <div className="text-sm text-muted-foreground">
            {selected ? (
              <span className="font-medium text-foreground">Selected: {selected.name}</span>
            ) : (
              "Select an image file"
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={onConfirm} disabled={!selected || selected.type !== "file"}>
              Confirm Selection
            </Button>
          </div>
        </div>
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
  function renderNode(item: DriveItem, depth: number) {
    const key = getFolderKeyFromItem(item);
    const children = folderChildren[key];
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
        {isExpanded && children?.length ? children.map((child) => renderNode(child, depth + 1)) : null}
        {isExpanded && hasKnownNoChildren ? (
          <div className="h-8 py-1 text-xs italic text-muted-foreground" style={{ paddingLeft: 8 + (depth + 1) * 16 }}>
            No subfolders
          </div>
        ) : null}
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
          <FolderGlyph className="mx-auto mb-3 h-10" />
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
        "group relative flex flex-col rounded-card bg-card p-2 transition focus-within:shadow-[0_6px_24px_rgba(28,28,28,0.08)] hover:bg-card hover:shadow-[0_6px_24px_rgba(28,28,28,0.08)]",
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
          <FolderGlyph className="h-16 transition-transform duration-300 group-hover:scale-110" />
        ) : item.thumbnailUrl ? (
          <Image src={item.thumbnailUrl} alt="" fill sizes="260px" className="object-cover" />
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
  onOpenModelPicker,
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
  productDescription: string;
  setProductDescription: (value: string) => void;
  productAttributes: string;
  setProductAttributes: (value: string) => void;
  sourceStoragePrefix: string;
  setSourceStoragePrefix: (value: string) => void;
  modelReferenceUrl: string;
  setModelReferenceUrl: (value: string) => void;
  onOpenModelPicker: () => void;
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
}) {
  if (!selectedItem && !item) {
    return (
      <aside className="bg-card p-5">
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
        <Button variant="ghost" size="icon" title="Close preview">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Selected Item Info */}
      {selectedItem ? (
        <div className="mb-4 rounded-md border border-border p-3">
          <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Selected Item</div>
          <div className="font-medium">{selectedItem.name}</div>
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
                  <Image src={displayItem.thumbnailUrl} alt="" fill sizes="360px" className="object-cover" />
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

// Drive "view" links are HTML pages, not images — map them to Drive's thumbnail endpoint.
function thumbnailSrc(url: string): string {
  const driveId = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/)?.[1]
    ?? (url.includes("drive.google.com") ? new URL(url).searchParams.get("id") : null);
  return driveId ? `https://drive.google.com/thumbnail?id=${driveId}&sz=w200` : url;
}

function FinalFileRow({ file, onOpen }: { file: FinalFile; onOpen: () => void }) {
  const isImage = file.mime_type?.startsWith("image/");
  const isVideo = file.mime_type?.startsWith("video/");
  const [thumbFailed, setThumbFailed] = useState(false);

  return (
    <div className="grid grid-cols-[82px_minmax(180px,1.4fr)_minmax(180px,1fr)_140px_120px_96px] items-center border-b border-border px-3 py-2.5 last:border-b-0">
      <button className="relative block h-14 w-14 overflow-hidden rounded-md bg-secondary" onClick={onOpen}>
        {isImage && file.signed_url && !thumbFailed ? (
          // Plain <img>: sources span Supabase signed URLs and Drive, not all whitelisted for next/image.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailSrc(file.signed_url)}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
            onError={() => setThumbFailed(true)}
          />
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
