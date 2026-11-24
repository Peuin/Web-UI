"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, FolderOpen, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileExtensionBadge, FileKindIcon } from "@/components/ui/file-kind-icon";
import { FolderGlyph } from "@/components/ui/folder-glyph";
import { SidePanel } from "@/components/ui/side-panel";
import { DriveContent } from "@/features/media/drive-content";
import { DriveToolbar, formatFolderSummary } from "@/features/media/drive-toolbar";
import { normalizeDriveItem, platformApi } from "@/lib/api/edge-functions";
import { useTableChanges } from "@/lib/hooks/use-table-changes";
import { cn } from "@/lib/utils/cn";
import {
  FINAL_ROOT_FOLDER_ID,
  FINAL_ROOT_FOLDER_NAME,
  NARROW_SCREEN_QUERY,
  getFileKind,
  isHiddenDrivePlaceholder,
  stripMarkdownLink,
  type FolderCrumb,
  type ViewMode,
} from "@/lib/utils/drive";
import { formatBytes, formatDate } from "@/lib/utils/format";
import type { DriveItem } from "@/types/domain";

// Final Output auto-sync: re-list the open folder from Drive this often while
// the tab is visible. Was 30 s — Realtime now pushes row changes, so the poll
// is only a backstop and each open tab costs far fewer n8n runs.
const FINAL_AUTO_SYNC_INTERVAL_MS = 120_000;
// After asking n8n to re-list, check the cache at these gaps (n8n answers asynchronously).
const FINAL_BACKGROUND_RELIST_DELAYS_MS = [3000, 5000];

function driveDownloadUrl(item: DriveItem) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(item.driveItemId)}`;
}

function driveOpenUrl(item: DriveItem) {
  if (item.itemType === "FOLDER") return `https://drive.google.com/drive/folders/${encodeURIComponent(item.driveItemId)}`;
  return stripMarkdownLink(item.webViewLink) ?? `https://drive.google.com/file/d/${encodeURIComponent(item.driveItemId)}/view`;
}

type FinalFolderMeta = { name: string; parentId: string | null };

export function FinalBrowser({ accessToken }: { accessToken: string }) {
  const [currentId, setCurrentId] = useState(FINAL_ROOT_FOLDER_ID);
  const [items, setItems] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // n8n is listing an empty folder from Drive for the first time (U6).
  const [syncingFolder, setSyncingFolder] = useState(false);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [previewItem, setPreviewItem] = useState<DriveItem | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  useEffect(() => {
    // The panel overlays the grid on narrow screens; start with it closed there.
    if (window.matchMedia(NARROW_SCREEN_QUERY).matches) queueMicrotask(() => setPanelOpen(false));
  }, []);
  const [meta, setMeta] = useState<Record<string, FinalFolderMeta>>({
    [FINAL_ROOT_FOLDER_ID]: { name: FINAL_ROOT_FOLDER_NAME, parentId: null },
  });
  const [notice, setNotice] = useState<string | null>(null);
  const syncedRef = useRef(new Set<string>());
  const requestRef = useRef(0);
  const currentIdRef = useRef(currentId);
  const metaRef = useRef(meta);
  const backgroundSyncingRef = useRef(false);
  useEffect(() => {
    currentIdRef.current = currentId;
    metaRef.current = meta;
  }, [currentId, meta]);

  const listFolder = useCallback(async (folderId: string) => {
    const response = await platformApi.listFinalFolder(accessToken, folderId);
    if (!response.success || !response.data) {
      return { ok: false as const, error: response.error?.message ?? "Could not load folder.", items: [] as DriveItem[], folderExists: true };
    }
    const list = response.data.items.filter((item) => !isHiddenDrivePlaceholder(item)).map(normalizeDriveItem);
    return { ok: true as const, error: null, items: list, folderExists: Boolean(response.data.folder) };
  }, [accessToken]);

  // Same lazy sync as Drive Browser: pull a folder from Drive the first time it is empty.
  const fetchFolder = useCallback(async (folderId: string, force = false) => {
    let result = await listFolder(folderId);
    if (!result.ok || (result.items.length > 0 && !force) || (!force && syncedRef.current.has(folderId))) {
      return { ...result, synced: false };
    }
    syncedRef.current.add(folderId);
    setSyncingFolder(true);
    const sync = await platformApi.syncFinalFolder(accessToken, folderId);
    if (!sync.success) {
      setSyncingFolder(false);
      return { ...result, synced: false, error: sync.error?.message ?? "Could not sync folder." };
    }
    for (const delayMs of [0, 2000, 4000]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      result = await listFolder(folderId);
      if (!result.ok || result.items.length > 0) {
        setSyncingFolder(false);
        return { ...result, synced: true };
      }
    }
    setSyncingFolder(false);
    return { ...result, synced: true };
  }, [accessToken, listFolder]);

  const rememberFolders = useCallback((parentId: string, list: DriveItem[]) => {
    const folders = list.filter((item) => item.itemType === "FOLDER" && item.driveItemId !== parentId);
    setMeta((current) => {
      const next = { ...current };
      for (const folder of folders) next[folder.driveItemId] = { name: folder.name, parentId };
      return next;
    });
  }, []);

  // Re-list the open folder (and its parent, to notice the folder itself being
  // deleted) from Drive in the background, then quietly apply what changed.
  const backgroundSync = useCallback(async (folderId: string) => {
    if (backgroundSyncingRef.current) return;
    backgroundSyncingRef.current = true;
    const requestId = requestRef.current;
    const stillCurrent = () => requestId === requestRef.current && currentIdRef.current === folderId;
    let deleted: { parentId: string; name: string } | null = null;
    try {
      const parentId = folderId === FINAL_ROOT_FOLDER_ID ? null : metaRef.current[folderId]?.parentId ?? null;
      const syncs = await Promise.all(
        [folderId, parentId].filter((id): id is string => Boolean(id)).map((id) => platformApi.syncFinalFolder(accessToken, id)),
      );
      if (!syncs.some((sync) => sync.success)) return;
      for (const delayMs of FINAL_BACKGROUND_RELIST_DELAYS_MS) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (!stillCurrent()) return;
        const result = await listFolder(folderId);
        if (!result.ok || !stillCurrent()) return;
        if (parentId && !result.folderExists && result.items.length === 0) {
          deleted = { parentId, name: metaRef.current[folderId]?.name ?? "This folder" };
          break;
        }
        const ids = new Set(result.items.map((item) => item.id));
        setItems((current) => {
          const unchanged = current.length === result.items.length &&
            current.every((item, index) => item.id === result.items[index].id && item.modifiedTime === result.items[index].modifiedTime);
          return unchanged ? current : result.items;
        });
        setPreviewItem((current) => (current && !ids.has(current.id) ? null : current));
        rememberFolders(folderId, result.items);
        setLastUpdated(new Date());
      }
    } finally {
      backgroundSyncingRef.current = false;
    }
    if (deleted) {
      const { parentId, name } = deleted;
      setMeta((current) => {
        const next = { ...current };
        delete next[folderId];
        return next;
      });
      await openFolderId(parentId);
      setNotice(`"${name}" was deleted on Google Drive.`);
    }
    // openFolderId is declared below; it is stable for a given accessToken.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, listFolder, rememberFolders]);

  const openFolderId = useCallback(async (folderId: string, force = false): Promise<void> => {
    const requestId = ++requestRef.current;
    setCurrentId(folderId);
    currentIdRef.current = folderId;
    setQuery("");
    setPreviewItem(null);
    setNotice(null);
    setLoading(true);
    setError(null);
    const result = await fetchFolder(folderId, force);
    if (requestId !== requestRef.current) return;
    setLoading(false);
    setItems(result.items);
    if (result.error) setError(result.error);
    rememberFolders(folderId, result.items);
    setLastUpdated(new Date());
    // Cached listing shown instantly; confirm it against Drive in the background.
    if (result.ok && !result.synced) void backgroundSync(folderId);
  }, [fetchFolder, rememberFolders, backgroundSync]);

  useEffect(() => {
    queueMicrotask(() => void openFolderId(FINAL_ROOT_FOLDER_ID));
  }, [openFolderId]);

  // Keep the open folder in step with Drive: poll while visible, and on return to the tab.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void backgroundSync(currentIdRef.current);
    };
    const timer = setInterval(tick, FINAL_AUTO_SYNC_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [backgroundSync]);

  // P5 — Realtime: when n8n writes rows under this folder, refresh immediately
  // instead of waiting for the next poll tick.
  useTableChanges({
    table: "final_items",
    filter: `parent_drive_item_id=eq.${currentId}`,
    enabled: Boolean(currentId),
    onChange: () => void backgroundSync(currentIdRef.current),
  });

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
  const summary = loading ? "Loading…" : formatFolderSummary(folderCount, items.length - folderCount);

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
      <div className={cn("min-w-0", panelOpen && "xl:border-r xl:border-border")}>
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
          updatedAt={lastUpdated}
        />
        <div className="min-h-[calc(100vh-72px)] min-w-0">
          {notice ? (
            <div role="status" className="mx-5 mt-4 flex items-start justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <span>{notice}</span>
              <button type="button" className="shrink-0 text-amber-700 hover:underline" onClick={() => setNotice(null)}>Dismiss</button>
            </div>
          ) : null}
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
            syncing={syncingFolder}
            error={error}
            query={query}
            isRootFolder={currentId === FINAL_ROOT_FOLDER_ID}
            onBack={() => {
              const parent = meta[currentId]?.parentId;
              if (parent) void openFolderId(parent);
            }}
            onRetry={() => void openFolderId(currentId)}
            onSync={() => void syncCurrent()}
          />
        </div>
      </div>
      {panelOpen ? (
        <SidePanel onClose={() => setPanelOpen(false)}>
        <FinalPreviewPanel
          item={previewItem}
          onClose={() => setPanelOpen(false)}
          onOpenFolder={(folder) => void openFolderId(folder.driveItemId)}
        />
        </SidePanel>
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
  const kind = getFileKind(item);
  const isImage = kind === "image";
  const isVideo = kind === "video";
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
          <div className="flex aspect-video flex-col items-center justify-center gap-2">
            {isFolder ? (
              <FolderGlyph className="h-16" />
            ) : (
              <>
                <FileKindIcon item={item} className="h-12 w-12" />
                <FileExtensionBadge item={item} />
              </>
            )}
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
