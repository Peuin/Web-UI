"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Copy,
  Grid2X2,
  List,
  Loader2,
  RefreshCw,
  Search,
  Share2,
  UploadCloud,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { FolderGlyph } from "@/components/ui/folder-glyph";
import { Input } from "@/components/ui/input";
import { platformApi } from "@/lib/api/edge-functions";
import { copyTextToClipboard } from "@/lib/utils/clipboard";
import { cn } from "@/lib/utils/cn";
import { MODEL_LIBRARY_MAX_BYTES, MODEL_LIBRARY_ROOT_ID, type ViewMode } from "@/lib/utils/drive";
import type { ModelLibraryItem } from "@/types/domain";

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
export function ModelLibraryPanel({
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
    // Clipboard can be blocked (http/iframe) — show the URL so it can be copied by hand.
    setNotice((await copyTextToClipboard(url)) ? `Copied link for ${item.name}` : url);
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
            <Button variant="ghost" size="icon" title="Close" aria-label="Close model picker" onClick={onCancel}>
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
                  onClick={() => {
                    if (isFolder) {
                      setQuery("");
                      setTrail((current) => [...current, { id: item.id, name: item.name }]);
                    } else if (mode === "picker") {
                      setSelected(item);
                    } else {
                      setSelected(item);
                    }
                  }}
                  onDoubleClick={() => {
                    if (isFolder) return;
                    if (mode === "picker") {
                      setSelected(item);
                      void pick(item);
                    } else {
                      window.open(item.web_view_link ?? `https://drive.google.com/file/d/${item.id}/view`, "_blank", "noopener,noreferrer");
                    }
                  }}
                  title={isFolder ? "Open folder" : item.name}
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
                  <div className="min-w-0 px-3 py-3"><div className="truncate text-sm font-medium">{item.name}</div><div className="mt-1 text-xs text-muted-foreground">{isFolder ? "Folder" : "Reference image"}</div></div>
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

export function DriveModelPickerDialog({
  accessToken,
  onPick,
  onCancel,
}: {
  accessToken: string;
  onPick: (url: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Select model image">
      <div className="h-full max-h-[80vh] w-full max-w-4xl overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <ModelLibraryPanel accessToken={accessToken} mode="picker" onPick={onPick} onCancel={onCancel} />
      </div>
    </div>
  );
}
