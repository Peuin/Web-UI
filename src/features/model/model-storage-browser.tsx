"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  File,
  FileImage,
  FileText,
  Film,
  FolderOpen,
  Grid2X2,
  Home as HomeIcon,
  List,
  MoreHorizontal,
  Music,
  RefreshCw,
  Search,
  Share2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FolderGlyph } from "@/components/ui/folder-glyph";
import { Input } from "@/components/ui/input";
import { copyTextToClipboard } from "@/lib/utils/clipboard";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import { MODEL_STORAGE_BUCKET, MODEL_STORAGE_ROOT, isHiddenDrivePlaceholder, type ViewMode } from "@/lib/utils/drive";
import { formatBytes, formatDate } from "@/lib/utils/format";
import type { StorageItem } from "@/types/domain";

type StorageListObject = {
  id?: string | null;
  name: string;
  metadata?: { mimetype?: string; size?: number } | null;
  created_at?: string | null;
  updated_at?: string | null;
};

function extensionToMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

function mapStorageObject(object: StorageListObject, parentPath: string): StorageItem {
  const isFolder = object.id == null;
  const path = `${parentPath}/${object.name}`;
  return {
    id: object.id ?? path,
    name: object.name,
    type: isFolder ? "folder" : "file",
    path,
    mimeType: isFolder ? null : object.metadata?.mimetype ?? extensionToMimeType(object.name),
    sizeBytes: isFolder ? null : object.metadata?.size ?? null,
    updatedAt: object.updated_at ?? object.created_at ?? null,
    metadata: object.metadata ?? null,
    thumbnailUrl: null,
  };
}

function storagePublicUrl(path: string): string | null {
  const supabase = createBrowserSupabaseClient();
  if (!supabase) return null;
  const { data } = supabase.storage.from(MODEL_STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl ?? null;
}

/** Model tab: browses the model folder in Supabase Storage directly (no Drive calls). */
export function ModelStorageBrowser() {
  const [currentPath, setCurrentPath] = useState(MODEL_STORAGE_ROOT);
  const [items, setItems] = useState<StorageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [previewItem, setPreviewItem] = useState<StorageItem | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const loadStorageItems = useCallback(async (path: string) => {
    const supabase = createBrowserSupabaseClient();
    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    const { data, error: listError } = await supabase.storage
      .from(MODEL_STORAGE_BUCKET)
      .list(path, {
        limit: 500,
        offset: 0,
        sortBy: { column: "name", order: "asc" },
      });
    if (requestId !== requestIdRef.current) return;
    setLoading(false);
    if (listError) {
      console.error("Storage list error:", listError);
      setItems([]);
      setError(listError.message);
      return;
    }
    const mapped = (data ?? [])
      .filter((object) => !isHiddenDrivePlaceholder(object))
      .map((object) => mapStorageObject(object, path))
      .sort((a, b) =>
        a.type !== b.type
          ? a.type === "folder" ? -1 : 1
          : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    for (const item of mapped) {
      if (item.type === "file" && item.mimeType?.startsWith("image/")) {
        item.thumbnailUrl = storagePublicUrl(item.path);
      }
    }
    setItems(mapped);
  }, []);

  useEffect(() => {
    queueMicrotask(() => void loadStorageItems(currentPath));
  }, [currentPath, loadStorageItems]);

  // Breadcrumb rooted at google-drive/Model — the google-drive/ prefix is hidden
  // and "Model" is the top level, so the user cannot go above it.
  const crumbs = useMemo(() => {
    const segments = currentPath.split("/").filter(Boolean);
    return segments.slice(1).map((label, index) => ({
      label,
      path: segments.slice(0, index + 2).join("/"),
    }));
  }, [currentPath]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) => item.name.toLowerCase().includes(normalized));
  }, [items, query]);

  const folderCount = items.filter((item) => item.type === "folder").length;
  const summary = `${folderCount} ${folderCount === 1 ? "folder" : "folders"} · ${items.length - folderCount} ${items.length - folderCount === 1 ? "file" : "files"}`;

  function openStorageFolder(item: StorageItem) {
    setQuery("");
    setMenuFor(null);
    setPreviewItem(null);
    setCurrentPath(item.path);
  }

  function navigateToCrumb(path: string) {
    setQuery("");
    setMenuFor(null);
    setPreviewItem(null);
    setCurrentPath(path);
  }

  function itemPublicUrl(item: StorageItem): string | null {
    return item.thumbnailUrl ?? storagePublicUrl(item.path);
  }

  async function copyLink(item: StorageItem) {
    const url = itemPublicUrl(item);
    if (!url) return;
    setMenuFor(null);
    await copyTextToClipboard(url);
  }

  function renderItemMenu(item: StorageItem) {
    const url = itemPublicUrl(item);
    return (
      <div className="absolute right-2 top-2 z-40 w-44 overflow-hidden rounded-md border border-border bg-card py-1 text-left shadow-md">
        {item.type === "folder" ? (
          <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary" onClick={() => openStorageFolder(item)}>
            <FolderOpen className="h-4 w-4" /> Open folder
          </button>
        ) : (
          <>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary" onClick={() => { setMenuFor(null); setPreviewItem(item); }}>
              <FileImage className="h-4 w-4" /> Preview
            </button>
            {url ? (
              <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary" onClick={() => { setMenuFor(null); window.open(url, "_blank", "noopener,noreferrer"); }}>
                <Share2 className="h-4 w-4" /> Open in new tab
              </button>
            ) : null}
            <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary" onClick={() => void copyLink(item)}>
              <Copy className="h-4 w-4" /> Copy link
            </button>
          </>
        )}
      </div>
    );
  }

  function renderItemIcon(item: StorageItem, compact = false) {
    if (item.type === "folder") {
      return <FolderGlyph className={compact ? "h-8" : "h-12"} />;
    }
    const boxClass = compact ? "h-8 w-8" : "h-12 w-12";
    const iconClass = compact ? "h-4 w-4" : "h-6 w-6";
    const Icon = item.mimeType?.startsWith("video/")
      ? Film
      : item.mimeType?.startsWith("audio/")
        ? Music
        : item.mimeType === "application/pdf" || item.mimeType?.startsWith("text/")
          ? FileText
          : File;
    return (
      <span className={cn("flex items-center justify-center rounded-tile bg-card text-muted-foreground", boxClass)}>
        <Icon className={iconClass} />
      </span>
    );
  }

  const previewUrl = previewItem ? itemPublicUrl(previewItem) : null;

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-card px-5 py-4">
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 shrink-0"
              disabled={crumbs.length <= 1}
              title={crumbs.length > 1 ? `Back to ${crumbs[crumbs.length - 2].label}` : "Already at Model"}
              aria-label="Back to parent folder"
              onClick={() => navigateToCrumb(crumbs[crumbs.length - 2].path)}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <nav aria-label="Storage path" className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="flex min-w-0 items-center gap-1">
                  {index > 0 ? <ChevronRight className="h-3 w-3 shrink-0" /> : null}
                  <button
                    className={cn("truncate", index === crumbs.length - 1 ? "text-foreground" : "hover:text-foreground")}
                    title={crumb.label}
                    disabled={index === crumbs.length - 1}
                    onClick={() => navigateToCrumb(crumb.path)}
                  >
                    {index === 0 ? <HomeIcon className="mr-1 inline h-3.5 w-3.5" /> : null}
                    {crumb.label}
                  </button>
                </span>
              ))}
            </nav>
          </div>
          <p className="mt-2 pl-9 text-xs text-muted-foreground">{loading ? "Loading…" : summary}</p>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <div className="relative w-[220px] max-w-full">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              aria-label="Search files and folders"
              className="pl-8"
              placeholder="Search this folder…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button variant="outline" size="icon" title="Refresh" aria-label="Refresh" disabled={loading} onClick={() => void loadStorageItems(currentPath)}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          <div className="flex gap-0.5 border border-border p-0.5" role="group" aria-label="View mode">
            <Button variant={viewMode === "grid" ? "secondary" : "ghost"} size="icon" title="Grid view" aria-label="Grid view" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}><Grid2X2 className="h-4 w-4" /></Button>
            <Button variant={viewMode === "list" ? "secondary" : "ghost"} size="icon" title="List view" aria-label="List view" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}><List className="h-4 w-4" /></Button>
          </div>
        </div>
      </div>

      <div className={cn("grid min-h-0 flex-1", previewItem ? "grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px]" : "grid-cols-1")}>
        <div className="min-h-0 min-w-0 overflow-auto p-5">
          {error ? (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
          ) : null}
          {loading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),1fr))] gap-4" aria-label="Loading folder" aria-busy="true">
              {Array.from({ length: 5 }, (_, index) => <div key={index} className="animate-pulse rounded-card border border-border bg-card p-2"><div className="aspect-[4/5] rounded-tile bg-muted" /><div className="mt-3 h-3 w-3/4 bg-muted" /></div>)}
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="mx-auto my-8 flex min-h-80 max-w-xl flex-col items-center justify-center rounded-card border border-dashed border-border bg-card p-8 text-center">
              <div className="mb-5 rounded-full bg-secondary p-5">{query.trim() ? <Search className="h-8 w-8 text-muted-foreground" /> : <FolderGlyph className="h-8 w-8" />}</div>
              <h3 className="text-base">{query.trim() ? "No matching items" : "This folder is empty"}</h3>
              <p className="mt-3 max-w-sm text-sm text-muted-foreground">{query.trim() ? "Try another name or clear your search to see all items." : "Nothing has been synced into this Storage folder yet."}</p>
              {query.trim() ? <Button className="mt-5" onClick={() => setQuery("")}>Clear search</Button> : null}
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,180px),240px))] gap-4">
              {visibleItems.map((item) => (
                <div key={item.id} className="relative">
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 w-full overflow-hidden rounded-card border bg-card text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      previewItem?.id === item.id ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-primary/50",
                    )}
                    onClick={() => (item.type === "folder" ? openStorageFolder(item) : setPreviewItem(item))}
                    title={item.type === "folder" ? "Open folder" : item.name}
                  >
                    <div className="flex aspect-[4/5] items-center justify-center overflow-hidden bg-secondary">
                      {item.type === "file" && item.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.thumbnailUrl} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        renderItemIcon(item)
                      )}
                    </div>
                    <div className="min-w-0 px-3 py-3">
                      <div className="truncate text-sm font-medium">{item.name}</div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {item.type === "folder"
                          ? "Folder"
                          : [item.sizeBytes != null ? formatBytes(item.sizeBytes) : null, item.updatedAt ? formatDate(item.updatedAt) : null].filter(Boolean).join(" · ") || "File"}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="absolute right-2 top-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-sm hover:text-foreground sm:h-7 sm:w-7"
                    aria-label={`Actions for ${item.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === item.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuFor((current) => (current === item.id ? null : item.id));
                    }}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  {menuFor === item.id ? renderItemMenu(item) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {visibleItems.map((item) => (
                <div key={item.id} className="relative">
                  <button
                    type="button"
                    className={cn(
                      "flex w-full min-w-0 items-center gap-4 overflow-hidden rounded-card border bg-card p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      previewItem?.id === item.id ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-primary/50",
                    )}
                    onClick={() => (item.type === "folder" ? openStorageFolder(item) : setPreviewItem(item))}
                    title={item.type === "folder" ? "Open folder" : item.name}
                  >
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-tile bg-secondary">
                      {item.type === "file" && item.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.thumbnailUrl} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        renderItemIcon(item, true)
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {item.type === "folder"
                          ? "Folder"
                          : [item.mimeType && item.mimeType !== "application/octet-stream" ? item.mimeType : "File", item.sizeBytes != null ? formatBytes(item.sizeBytes) : null, item.updatedAt ? formatDate(item.updatedAt) : null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground sm:h-7 sm:w-7"
                    aria-label={`Actions for ${item.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === item.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuFor((current) => (current === item.id ? null : item.id));
                    }}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  {menuFor === item.id ? renderItemMenu(item) : null}
                </div>
              ))}
            </div>
          )}
        </div>
        {previewItem ? (
          <aside className="min-w-0 overflow-y-auto border-t border-border bg-card p-5 xl:border-l xl:border-t-0">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">File Preview</h3>
              <Button variant="ghost" size="icon" aria-label="Close file preview" onClick={() => setPreviewItem(null)}><X className="h-4 w-4" /></Button>
            </div>
            {previewItem.mimeType?.startsWith("image/") && previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt={previewItem.name} className="max-h-80 w-full rounded-tile bg-secondary object-contain" />
            ) : previewItem.mimeType?.startsWith("video/") && previewUrl ? (
              <video src={previewUrl} controls className="max-h-80 w-full rounded-tile bg-black" />
            ) : previewItem.mimeType?.startsWith("audio/") && previewUrl ? (
              <audio src={previewUrl} controls className="w-full" />
            ) : (
              <div className="flex h-40 items-center justify-center rounded-tile bg-secondary">{renderItemIcon(previewItem)}</div>
            )}
            <div className="mt-4 text-sm font-medium [overflow-wrap:anywhere]">{previewItem.name}</div>
            <dl className="mt-3 space-y-1.5 text-xs text-muted-foreground">
              {previewItem.mimeType ? <div className="flex justify-between gap-3"><dt>Type</dt><dd className="truncate">{previewItem.mimeType}</dd></div> : null}
              {previewItem.sizeBytes != null ? <div className="flex justify-between gap-3"><dt>Size</dt><dd>{formatBytes(previewItem.sizeBytes)}</dd></div> : null}
              {previewItem.updatedAt ? <div className="flex justify-between gap-3"><dt>Modified</dt><dd>{formatDate(previewItem.updatedAt)}</dd></div> : null}
            </dl>
            {previewUrl ? (
              <Button variant="outline" size="sm" className="mt-4 w-full" onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}>
                <Share2 className="mr-2 h-4 w-4" /> Open in new tab
              </Button>
            ) : null}
          </aside>
        ) : null}
      </div>
      {menuFor ? <div className="fixed inset-0 z-30" aria-hidden="true" onClick={() => setMenuFor(null)} /> : null}
    </div>
  );
}
