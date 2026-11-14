"use client";

import dynamic from "next/dynamic";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { LoginScreen } from "@/components/auth/login-screen";
import { AppSidebar, type WorkspaceTab } from "@/components/layout/app-sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SidePanel } from "@/components/ui/side-panel";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { DriveContent } from "@/features/media/drive-content";
import { DriveToolbar, formatFolderSummary, type FolderSort } from "@/features/media/drive-toolbar";
import { FolderTree } from "@/features/media/folder-tree";
import {
  DEFAULT_PRODUCT_TYPE_OPTIONS,
  REMEMBERED_FORM_FIELDS,
  formatProductTypeLabel,
  validateReferenceImageUrl,
  type GenerationFormValues,
} from "@/features/media/generation";
import { PreviewDrawer } from "@/features/media/preview-drawer";
import { DriveModelPickerDialog } from "@/features/model/model-library";
import {
  normalizeDriveItem,
  normalizeWorkflowJob,
  platformApi,
} from "@/lib/api/edge-functions";
import {
  clearFolderSnapshots,
  readFolderSnapshot,
  writeFolderSnapshot,
} from "@/lib/hooks/folder-cache";
import { useTableChanges } from "@/lib/hooks/use-table-changes";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import {
  DEFAULT_CONNECTION_ID,
  DRIVE_ROOT_FOLDER_ID,
  DRIVE_STORAGE_ROOT,
  GENERATION_PREFS_STORAGE_KEY,
  NARROW_SCREEN_QUERY,
  PREVIEW_PANEL_STORAGE_KEY,
  getFolderKey,
  getFolderKeyFromItem,
  isHiddenDrivePlaceholder,
  isValidStoragePrefix,
  stripMarkdownLink,
  type FolderCrumb,
  type FolderMeta,
  type ViewMode,
} from "@/lib/utils/drive";
import type { ApiDriveItem, DriveItem, WorkflowJob } from "@/types/domain";

// P6 — only the Drive Browser is on the critical path; every other tab is a
// separate chunk loaded on first switch.
const JobsPage = dynamic(() => import("@/features/jobs/jobs-page").then((mod) => mod.JobsPage), { ssr: false });
const FinalBrowser = dynamic(() => import("@/features/final/final-browser").then((mod) => mod.FinalBrowser), { ssr: false });
// Model tab browses the Google Drive folder 05_MODEL (MODEL_LIBRARY_ROOT_ID) via model-library / n8n.
const ModelLibraryPanel = dynamic(() => import("@/features/model/model-library").then((mod) => mod.ModelLibraryPanel), { ssr: false });
const SettingsPage = dynamic(() => import("@/features/settings/settings-page").then((mod) => mod.SettingsPage), { ssr: false });

const JOBS_POLL_INTERVAL_MS = 15_000;

const RETRY_SKIP_LABEL: Record<string, string> = {
  job_not_found: "not a SKU job",
  duplicate_request: "already sent",
  job_not_retryable: "not retryable",
  retry_already_active: "retry already running",
  folder_busy: "folder is busy",
  original_name_missing: "original folder name missing, needs review",
  branch_review_required: "needs review",
  batch_snapshot_missing: "original settings missing",
};

const DEFAULT_FORM: GenerationFormValues = {
  productType: "cape",
  productDescription: "",
  samplePrompt: "",
  sourceStoragePrefix: "google-drive/01_New_Product_Raw/ARTIC WIDE LAPEL",
  modelReferenceUrl: "",
  styleReferenceUrl: "",
  outputType: "both",
  imageCount: "4",
  videoSeconds: "8",
  aspectRatio: "9:16",
  videoResolution: "480p",
};

function readInitialForm(): GenerationFormValues {
  try {
    const saved = JSON.parse(localStorage.getItem(GENERATION_PREFS_STORAGE_KEY) ?? "{}") as Partial<GenerationFormValues>;
    const form = { ...DEFAULT_FORM };
    for (const field of REMEMBERED_FORM_FIELDS) {
      const value = saved[field];
      if (typeof value === "string" && value) (form as Record<string, string>)[field] = value;
    }
    return form;
  } catch {
    return DEFAULT_FORM;
  }
}

export default function Home() {
  return (
    <ToastProvider>
      <Workspace />
    </ToastProvider>
  );
}

function Workspace() {
  const toast = useToast();
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("browser");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<FolderSort>("modified_desc");
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
  // U8 — the ConfirmDialog target (jobIds resolved before the dialog opens).
  const [retryTarget, setRetryTarget] = useState<{ runId: string; label: string; jobIds: string[]; skus: string[] } | null>(null);
  // Kept only when acceptance is unknown (503/network), so a resend reuses the same request_id.
  const pendingRetryRef = useRef<{ key: string; requestId: string } | null>(null);
  const [jobsNotice, setJobsNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [loadingDrive, setLoadingDrive] = useState(false);
  const driveNavigatingRef = useRef(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [lazySyncing, setLazySyncing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Model Reference picker (Google Drive model library via n8n)
  const [driveModelPickerOpen, setDriveModelPickerOpen] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const syncedFolderIdsRef = useRef(new Set<string>());
  const [previewPanelOpen, setPreviewPanelOpen] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [form, setForm] = useState<GenerationFormValues>(DEFAULT_FORM);
  const formLoadedRef = useRef(false);
  const [productTypeOptions, setProductTypeOptions] = useState(DEFAULT_PRODUCT_TYPE_OPTIONS);
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const accessTokenRef = useRef<string | null>(null);
  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  // U13 — restore remembered choices after mount (avoids SSR/CSR mismatch).
  useEffect(() => {
    if (formLoadedRef.current) return;
    formLoadedRef.current = true;
    setForm(readInitialForm());
  }, []);

  const onFieldChange = useCallback((field: keyof GenerationFormValues, value: string) => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      try {
        localStorage.setItem(
          GENERATION_PREFS_STORAGE_KEY,
          JSON.stringify(Object.fromEntries(REMEMBERED_FORM_FIELDS.map((f) => [f, next[f]]))),
        );
      } catch {
        // Storage unavailable; remembering is a convenience only.
      }
      return next;
    });
  }, []);

  const folders = useMemo(() => items.filter((i) => i.itemType === "FOLDER" && !isHiddenDrivePlaceholder(i)), [items]);

  const filteredItems = useMemo(() => {
    const result = items.filter((item) => !isHiddenDrivePlaceholder(item));
    const normalized = deferredQuery.trim().toLowerCase();
    if (!normalized) return result;
    return result.filter((item) => item.name.toLowerCase().includes(normalized));
  }, [items, deferredQuery]);

  const driveSummary = useMemo(() => {
    const folderCount = filteredItems.filter((item) => item.itemType === "FOLDER").length;
    const fileCount = filteredItems.length - folderCount;
    return formatFolderSummary(folderCount, fileCount);
  }, [filteredItems]);

  const listDriveFolder = useCallback(async (
    token: string,
    folderDriveId: string | null,
    storagePath: string | null,
    sortKey: FolderSort = "modified_desc",
  ) => {
    const allItems: ApiDriveItem[] = [];
    let folder: ApiDriveItem | null = null;
    let ancestors: ApiDriveItem[] | undefined;
    let page = 1;
    let response: Awaited<ReturnType<typeof platformApi.listFolder>> | null = null;

    do {
      const params = new URLSearchParams({
        connection_id: DEFAULT_CONNECTION_ID,
        page: String(page),
        page_size: "500",
        sort: sortKey,
        ancestors: "true",
      });
      if (storagePath) {
        params.set("storage_path", storagePath);
      } else if (folderDriveId) {
        params.set("folder_id", folderDriveId);
      }

      response = await platformApi.listFolder(token, params);
      if (!response.success || !response.data) {
        return { response, items: [] as DriveItem[], folder: null as DriveItem | null, ancestors };
      }

      allItems.push(...response.data.items);
      folder ??= response.data.folder;
      ancestors ??= response.data.ancestors;
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
      ancestors,
    };
  }, []);

  const fetchDriveFolder = useCallback(async (
    token: string,
    folderDriveId: string | null,
    storagePath: string | null,
    sortKey: FolderSort = "modified_desc",
  ) => {
    const result = await listDriveFolder(token, folderDriveId, storagePath, sortKey);
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
    setLazySyncing(true);
    const sync = await platformApi.syncDrive(token, {
      connection_id: DEFAULT_CONNECTION_ID,
      root_folder_id: folderDriveId,
      sync_mode: "INCREMENTAL",
      recursive: false,
      max_folders: 1,
    });
    if (!sync.success) {
      setLazySyncing(false);
      return result;
    }

    // n8n may acknowledge the webhook before its callback has stored the items.
    for (const delayMs of [0, 2000, 4000]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const refreshed = await listDriveFolder(token, folderDriveId, storagePath, sortKey);
      if (!refreshed.response?.success || refreshed.items.length > 0) {
        setLazySyncing(false);
        return refreshed;
      }
    }
    setLazySyncing(false);
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

  // Seed parent/meta from the API's ancestor chain — needed to rebuild
  // breadcrumbs + tree when landing directly on a deep folder link (P8).
  const seedAncestors = useCallback((ancestors: ApiDriveItem[] | undefined, leafKey: string) => {
    if (!ancestors?.length) return;
    const metas: Record<string, FolderMeta> = {};
    const parents: Record<string, string> = {};
    let prev = "root";
    for (const raw of ancestors) {
      const item = normalizeDriveItem(raw);
      const key = getFolderKeyFromItem(item);
      metas[key] = {
        name: item.name,
        driveItemId: item.connectionId === "storage" ? null : item.driveItemId,
        storagePath: item.connectionId === "storage" ? item.driveItemId : null,
      };
      parents[key] = prev;
      prev = key;
    }
    parents[leafKey] = prev;
    setFolderMeta((current) => ({ ...current, ...metas }));
    setFolderParent((current) => ({ ...current, ...parents }));
  }, []);

  const loadDrive = useCallback(async (
    token: string,
    folderDriveId: string | null = null,
    storagePath: string | null = null,
    options?: { push?: boolean; sortKey?: FolderSort; silent?: boolean },
  ) => {
    // Background refreshes (Realtime) must not show the centred loading overlay,
    // and must never supersede a navigation the user started.
    if (options?.silent && driveNavigatingRef.current) return;
    const showLoading = !options?.silent;
    const requestId = ++driveRequestIdRef.current;
    const key = getFolderKey(folderDriveId, storagePath);

    // P2 — show the last snapshot instantly; the fresh listing then swaps in.
    const snapshot = readFolderSnapshot(key);
    const sameFolder = currentFolderKeyRef.current === key;
    if (snapshot && !sameFolder) {
      currentFolderKeyRef.current = key;
      setCurrentFolderKey(key);
      setItems(snapshot.items);
      setCurrentFolder(snapshot.folder);
      storeFolderChildren(key, snapshot.items, snapshot.folder?.name);
      setBreadcrumbs(buildCrumbs(key));
      expandAncestors(key);
      setPreviewItem(null);
      setSelectedItem(null);
    }

    if (showLoading) {
      driveNavigatingRef.current = true;
      setLoadingDrive(true);
    }
    setAppError(null);
    const { response, items: normalizedItems, folder: normalizedFolder, ancestors } = await fetchDriveFolder(
      token, folderDriveId, storagePath, options?.sortKey,
    );

    // A slower request must not send the user back to a previous folder.
    if (requestId !== driveRequestIdRef.current) return;
    driveNavigatingRef.current = false;
    setLoadingDrive(false);

    if (!response?.success || !response.data) {
      // Keep the snapshot on screen; only surface an error when nothing is shown.
      setAppError(response.error?.message ?? "Could not load Google Drive metadata from Supabase.");
      return;
    }

    const stillSameFolder = currentFolderKeyRef.current === key;
    currentFolderKeyRef.current = key;
    seedAncestors(ancestors, key);
    storeFolderChildren(key, normalizedItems, normalizedFolder?.name);
    writeFolderSnapshot(key, normalizedItems, normalizedFolder);
    setItems(normalizedItems);
    setCurrentFolder(normalizedFolder);
    setCurrentFolderKey(key);
    setBreadcrumbs(buildCrumbs(key));
    expandAncestors(key);
    setLastUpdated(new Date());
    setPreviewItem((current) => stillSameFolder && current
      ? normalizedItems.find((candidate) => candidate.id === current.id) ?? null
      : normalizedItems[0] ?? null);
    setSelectedItem((current) => stillSameFolder && current
      ? normalizedItems.find((candidate) => candidate.id === current.id) ?? null
      : null);

    // P8 — folder position lives in the URL: reload restores it, Back undoes it.
    if (options?.push !== false) {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", "browser");
      if (storagePath) {
        url.searchParams.set("storage", storagePath);
        url.searchParams.delete("folder");
      } else if (folderDriveId) {
        url.searchParams.set("folder", folderDriveId);
        url.searchParams.delete("storage");
      } else {
        url.searchParams.delete("folder");
        url.searchParams.delete("storage");
      }
      const next = `${url.pathname}${url.search}`;
      if (next !== `${window.location.pathname}${window.location.search}`) {
        window.history.pushState({ folder: folderDriveId, storage: storagePath }, "", next);
      }
    }
  }, [buildCrumbs, expandAncestors, fetchDriveFolder, seedAncestors, storeFolderChildren]);

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
      if (
        window.matchMedia(NARROW_SCREEN_QUERY).matches ||
        localStorage.getItem(PREVIEW_PANEL_STORAGE_KEY) === "closed"
      ) {
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
        setForm((current) => (options.some((option) => option.value === current.productType)
          ? current
          : { ...current, productType: options[0].value }));
      });
  }, [isSignedIn]);

  // P8 — restore tab + folder from the URL on first sign-in, and let the
  // browser Back/Forward buttons navigate between folders.
  const urlStateRestoredRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab") as WorkspaceTab | null;
    if (tab && ["browser", "model", "jobs", "final", "settings"].includes(tab)) {
      queueMicrotask(() => setActiveTab(tab));
    }
    const folder = params.get("folder");
    const storage = params.get("storage");
    if (folder || storage) urlStateRestoredRef.current = true;
  }, []);

  useEffect(() => {
    if (!isSignedIn || !accessToken || urlStateRestoredRef.current === false) return;
    const params = new URLSearchParams(window.location.search);
    const folder = params.get("folder");
    const storage = params.get("storage");
    if (folder || storage) {
      urlStateRestoredRef.current = false;
      queueMicrotask(() => void loadDrive(accessToken, folder, storage, { push: false }));
    }
  }, [isSignedIn, accessToken, loadDrive]);

  useEffect(() => {
    const onPopState = () => {
      const token = accessTokenRef.current;
      if (!token) return;
      const params = new URLSearchParams(window.location.search);
      const tab = params.get("tab") as WorkspaceTab | null;
      if (tab && ["browser", "model", "jobs", "final", "settings"].includes(tab)) setActiveTab(tab);
      const folder = params.get("folder");
      const storage = params.get("storage");
      setQuery("");
      void loadDrive(token, folder, storage, { push: false });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadDrive]);

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
        const params = new URLSearchParams(window.location.search);
        const folder = params.get("folder");
        const storage = params.get("storage");
        if (folder || storage) {
          urlStateRestoredRef.current = false;
          void loadDrive(token, folder, storage, { push: false });
        } else {
          void loadDrive(token);
        }
        void loadJobs(token);
      }, 0);
    });

    return () => {
      clearTimeout(initialLoadTimer);
      const requestTracker = driveRequestIdRef;
      ++requestTracker.current;
      listener.subscription.unsubscribe();
    };
  }, [loadDrive, loadJobs]);

  // P5 — when a sync writes children for the open folder, refresh silently
  // instead of waiting for the lazy-sync poll.
  useTableChanges({
    table: "drive_items",
    filter: `parent_drive_item_id=eq.${currentFolder?.driveItemId ?? DRIVE_ROOT_FOLDER_ID}`,
    enabled: isSignedIn && activeTab === "browser",
    onChange: () => {
      const token = accessTokenRef.current;
      if (!token) return;
      const driveId = currentFolder?.connectionId === "storage" ? null : currentFolder?.driveItemId ?? null;
      const storage = currentFolder?.connectionId === "storage" ? currentFolder.driveItemId : null;
      void loadDrive(token, driveId, storage, { push: false, silent: true });
    },
  });

  // U11 — "/" focuses the folder search from anywhere (except while typing).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Storage path of a selected folder, used to prefill "Source Storage Prefix".
  // Prefer the path stored in DB; otherwise derive it from the open folder path.
  function folderStoragePrefix(folder: DriveItem): string {
    if (folder.storagePath) return folder.storagePath;
    const parents = breadcrumbs.slice(1).map((crumb) => crumb.name);
    return [DRIVE_STORAGE_ROOT, ...parents, folder.name].join("/");
  }

  function applySelection(item: DriveItem) {
    setSelectedItem(item);
    if (item.itemType === "FOLDER") {
      onFieldChange("sourceStoragePrefix", folderStoragePrefix(item));
    }
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

  // Single click on a file previews it; a folder opens on single click (U2).
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
    void loadDrive(accessToken, storagePath ? null : driveItemId, storagePath, { sortKey: sort });
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
    void loadDrive(accessToken, meta.storagePath ? null : meta.driveItemId, meta.storagePath ?? null, { sortKey: sort });
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

  // P2 — warm the snapshot on hover/focus so a later click feels instant.
  const prefetchFolder = useCallback((item: DriveItem) => {
    const token = accessTokenRef.current;
    if (!token || item.itemType !== "FOLDER") return;
    const key = getFolderKeyFromItem(item);
    if (readFolderSnapshot(key)) return;
    const storagePath = item.connectionId === "storage" ? item.driveItemId : null;
    void listDriveFolder(token, storagePath ? null : item.driveItemId, storagePath).then((result) => {
      if (result.response?.success) writeFolderSnapshot(key, result.items, result.folder);
    }).catch(() => {});
  }, [listDriveFolder]);

  async function signOut() {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;

    setSigningOut(true);
    // Default scope is "global", which revokes this user's sessions on every device.
    await supabase.auth.signOut({ scope: "local" });
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
    setLastUpdated(null);
    clearFolderSnapshots();
    window.history.replaceState({}, "", window.location.pathname);
  }

  function switchTab(tab: WorkspaceTab) {
    setActiveTab(tab);
    // Returning to Drive Browser preserves its folder, selection and form.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", `${url.pathname}${url.search}`);
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
    // U2 — a file's "open" is its preview; double-click goes to Drive.
    selectAndPreview(item);
  }

  function refreshDrive() {
    if (!accessToken) return;
    clearFolderSnapshots();
    setFolderChildren({});
    setFolderParent({});
    setFolderMeta({ root: { name: "Root folder", driveItemId: null, storagePath: null } });
    setExpanded(new Set(["root"]));
    void loadDrive(
      accessToken,
      currentFolder?.connectionId === "storage" ? null : currentFolder?.driveItemId ?? null,
      currentFolder?.connectionId === "storage" ? currentFolder.driveItemId : null,
      { sortKey: sort },
    );
  }

  async function syncDrive() {
    if (!accessToken) return;
    if (currentFolder?.connectionId === "storage") {
      refreshDrive();
      return;
    }
    setSyncing(true);
    setAppError(null);

    const response = await platformApi.syncDrive(accessToken, {
      connection_id: DEFAULT_CONNECTION_ID,
      root_folder_id: currentFolder?.driveItemId ?? DRIVE_ROOT_FOLDER_ID,
      sync_mode: "INCREMENTAL",
      recursive: false,
      max_folders: 1,
    });

    setSyncing(false);
    if (!response.success) {
      toast.error(response.error?.message ?? "Could not trigger Drive Sync.");
      return;
    }
    toast.info("Drive sync started — new items appear as soon as they sync.");
    clearFolderSnapshots();
    refreshDrive();
  }

  // Poll while the Jobs tab is open and something is still running.
  const hasActiveJobs = jobs.some((job) =>
    job.status === "QUEUED" || job.status === "PROCESSING" ||
    job.folders.some((folder) => folder.lastRetryStatus === "queued" || folder.lastRetryStatus === "processing")
  );
  useEffect(() => {
    if (activeTab !== "jobs" || !accessToken) return;
    if (!hasActiveJobs) return;
    const timer = setInterval(() => void loadJobs(accessToken), JOBS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [activeTab, accessToken, hasActiveJobs, loadJobs]);

  // U8 — open the confirm dialog with the SKU list instead of window.confirm.
  function retryRun(runId: string, label: string) {
    if (!accessToken || retryingRunId) return;
    // Batch-level Retry = Retry All failed SKU folders in that batch.
    const batch = jobs.find((job) => job.id === runId);
    const jobIds = batch
      ? batch.folders.filter((folder) => folder.canRetry).map((folder) => folder.runId)
      : [runId];
    if (jobIds.length === 0) {
      setJobsNotice({ tone: "error", text: "No failed SKU folders to retry in this batch." });
      return;
    }
    const nameById = new Map(jobs.flatMap((job) => job.folders.map((folder) => [folder.runId, folder.name] as const)));
    setRetryTarget({ runId, label, jobIds, skus: jobIds.map((id) => nameById.get(id) ?? id) });
  }

  async function confirmRetry() {
    const target = retryTarget;
    if (!accessToken || !target) return;
    setRetryTarget(null);
    const { jobIds } = target;

    const key = [...jobIds].sort().join(",");
    const requestId = pendingRetryRef.current?.key === key
      ? pendingRetryRef.current.requestId
      : crypto.randomUUID();
    pendingRetryRef.current = { key, requestId };

    setRetryingRunId(target.runId);
    setJobsNotice(null);
    const response = await platformApi.retrySkuJobs(accessToken, requestId, jobIds);
    setRetryingRunId(null);
    if (!response.success || !response.data) {
      const code = response.error?.code;
      const unknownOutcome = code === "RETRY_QUEUE_UNAVAILABLE" || code === "NETWORK_ERROR" || code?.startsWith("HTTP_5");
      if (!unknownOutcome) pendingRetryRef.current = null;
      setJobsNotice({
        tone: "error",
        text: unknownOutcome
          ? "Retry was not confirmed. Check the job status, then press Retry again to resend the same request."
          : response.error?.message ?? "Could not retry this run.",
      });
      return;
    }
    pendingRetryRef.current = null;

    const { accepted, skipped } = response.data;
    const nameById = new Map(jobs.flatMap((job) => job.folders.map((folder) => [folder.runId, folder.name] as const)));
    const skippedText = skipped
      .map((item) => `${nameById.get(item.job_id) ?? item.job_id}: ${RETRY_SKIP_LABEL[item.reason] ?? item.reason}`)
      .join("; ");
    setJobsNotice({
      tone: accepted.length > 0 ? "success" : "error",
      text: [
        accepted.length > 0 ? `Retry queued for ${accepted.length} SKU${accepted.length > 1 ? "s" : ""}.` : "No SKU was queued.",
        skippedText ? `Skipped — ${skippedText}.` : "",
      ].filter(Boolean).join(" "),
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
    if (!isValidStoragePrefix(form.sourceStoragePrefix)) {
      setAppError("Invalid source_storage_prefix. It appears to be corrupted with URL data.");
      return;
    }

    setSubmitting(true);
    setAppError(null);

    // Sanitize URLs to remove Markdown links
    const sanitizedModelReferenceUrl = stripMarkdownLink(form.modelReferenceUrl.trim());
    const sanitizedStyleReferenceUrl = stripMarkdownLink(form.styleReferenceUrl.trim());
    const referenceError =
      validateReferenceImageUrl("Model Reference URL", sanitizedModelReferenceUrl) ??
      validateReferenceImageUrl("Style Reference URL", sanitizedStyleReferenceUrl);
    if (referenceError) {
      setAppError(referenceError);
      setSubmitting(false);
      return;
    }

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
        product_type: form.productType,
        product_description: form.productDescription,
        sample_prompt: form.samplePrompt,
        source_storage_prefix: form.sourceStoragePrefix,
        model_reference_url: sanitizedModelReferenceUrl ?? "",
        style_reference_url: sanitizedStyleReferenceUrl ?? "",
        output_type: form.outputType,
        image_count: parseInt(form.imageCount, 10),
        video_seconds: parseInt(form.videoSeconds, 10),
        aspect_ratio: form.aspectRatio,
        video_resolution: form.videoResolution,
      },
    });

    setSubmitting(false);
    if (!response.success) {
      setAppError(response.error?.message ?? "Could not submit workflow.");
      return;
    }

    // n8n only acknowledges receipt ("Workflow got started."); it does not
    // return a job ID or wait for validation, so this is "sent", not "done".
    setAppError(null);
    setSubmitNotice(
      "Sent to n8n. The workflow runs in the background — results will appear in Final Output when it finishes. Don't submit again unless you're sure the previous run failed.",
    );
    toast.success("Media generation submitted.");
    void loadJobs(accessToken);
  }

  if (!isSignedIn) {
    return <LoginScreen />;
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <AppSidebar
          open={navOpen}
          onClose={() => setNavOpen(false)}
          activeTab={activeTab}
          onTabChange={(tab) => {
            setNavOpen(false);
            switchTab(tab);
          }}
          userEmail={userEmail}
          signingOut={signingOut}
          onSignOut={() => void signOut()}
        />
        <section className="flex min-w-0 flex-col">
          <TopBar
            onOpenNav={() => setNavOpen(true)}
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
              <div className={cn("min-w-0", previewPanelOpen && "xl:border-r xl:border-border")}>
                <DriveToolbar
                  previewPanelOpen={previewPanelOpen}
                  onTogglePreviewPanel={() => setPreviewPanelOpen((open) => !open)}
                  query={query}
                  setQuery={setQuery}
                  viewMode={viewMode}
                  setViewMode={setViewMode}
                  syncing={syncing}
                  onSync={() => void syncDrive()}
                  breadcrumbs={breadcrumbs}
                  summary={loadingDrive && items.length === 0 ? "Loading…" : driveSummary}
                  onBreadcrumbSelect={selectBreadcrumb}
                  onRefresh={refreshDrive}
                  sort={sort}
                  onSortChange={(next) => {
                    setSort(next);
                    if (accessToken) {
                      const driveId = currentFolder?.connectionId === "storage" ? null : currentFolder?.driveItemId ?? null;
                      const storage = currentFolder?.connectionId === "storage" ? currentFolder.driveItemId : null;
                      void loadDrive(accessToken, driveId, storage, { push: false, sortKey: next });
                    }
                  }}
                  updatedAt={lastUpdated}
                  searchInputRef={searchInputRef}
                />
                <div className="grid min-h-[calc(100vh-137px)] grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)]">
                  <FolderTree
                    rootChildren={folderChildren.root ?? folders}
                    folderChildren={folderChildren}
                    expanded={expanded}
                    currentKey={currentFolderKey}
                    loadingKeys={loadingFolderKeys}
                    onNavigate={navigateFolderKey}
                    onToggle={toggleFolderKey}
                    onPrefetch={(key) => {
                      const meta = folderMetaRef.current[key];
                      if (!meta || !accessToken) return;
                      void listDriveFolder(accessToken, meta.storagePath ? null : meta.driveItemId, meta.storagePath ?? null)
                        .then((result) => {
                          if (result.response?.success) writeFolderSnapshot(key, result.items, result.folder);
                        })
                        .catch(() => {});
                    }}
                  />
                  <DriveContent
                    items={filteredItems}
                    selectedItem={selectedItem}
                    previewItem={previewItem}
                    onSelect={toggleSelected}
                    onPreview={selectAndPreview}
                    onOpen={openDriveItem}
                    onPrefetch={prefetchFolder}
                    viewMode={viewMode}
                    loading={loadingDrive}
                    syncing={lazySyncing}
                    error={appError}
                    query={query}
                    isRootFolder={breadcrumbs.length <= 1}
                    onBack={() => selectBreadcrumb(breadcrumbs.length - 2)}
                    onRetry={refreshDrive}
                    onSync={() => void syncDrive()}
                  />
                </div>
              </div>
              {previewPanelOpen ? (
              <SidePanel onClose={() => setPreviewPanelOpen(false)}>
              <PreviewDrawer
                onClose={() => setPreviewPanelOpen(false)}
                item={previewItem}
                selectedItem={selectedItem}
                form={form}
                onFieldChange={onFieldChange}
                productTypeOptions={productTypeOptions}
                submitNotice={submitNotice}
                onOpenModelPicker={() => setDriveModelPickerOpen(true)}
                submitting={submitting}
                onSubmit={() => void submitWorkflow()}
                onOpenFolder={openFolder}
              />
              </SidePanel>
              ) : null}
            </div>
          ) : null}

          {/* ── Model tab: Google Drive folder 05_MODEL via model-library / n8n Production_07 ─ */}
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
            onFieldChange("modelReferenceUrl", url);
            setDriveModelPickerOpen(false);
          }}
          onCancel={() => setDriveModelPickerOpen(false)}
        />
      ) : null}

      {/* ── U8 retry confirmation ── */}
      <ConfirmDialog
        open={Boolean(retryTarget)}
        title={`Retry ${retryTarget?.label ?? ""}`}
        confirmLabel={retryTarget ? `Retry ${retryTarget.jobIds.length} SKU${retryTarget.jobIds.length > 1 ? "s" : ""}` : "Retry"}
        busy={Boolean(retryingRunId)}
        onCancel={() => setRetryTarget(null)}
        onConfirm={() => void confirmRetry()}
      >
        <p>
          Existing output is checked first: complete output is only finalized; missing media
          is regenerated with the original settings (uses AI credits).
        </p>
        {retryTarget && retryTarget.skus.length > 1 ? (
          <ul className="mt-3 max-h-40 list-disc space-y-1 overflow-auto pl-5 text-foreground">
            {retryTarget.skus.map((sku) => <li key={sku} className="truncate" title={sku}>{sku}</li>)}
          </ul>
        ) : null}
      </ConfirmDialog>

    </main>
  );
}
