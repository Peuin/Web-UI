"use client";

import { ArrowLeft, CircleAlert, FolderSync } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FolderGlyph } from "@/components/ui/folder-glyph";
import { FolderLoader, MediaCardSkeleton } from "@/components/ui/folder-loader";
import { MediaCard, MediaRow } from "@/features/media/media-card";
import { cn } from "@/lib/utils/cn";
import type { ViewMode } from "@/lib/utils/drive";
import type { DriveItem } from "@/types/domain";

// P7 — long folders render progressively; the sentinel reveals the next slice.
const RENDER_STEP = 200;

// auto-fit + 1fr lets cards grow to fill the row instead of capping at a fixed
// width and leaving a dead zone on the right.
const GRID_COLUMNS = "grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))]";

export function DriveContent({
  items,
  selectedItem,
  previewItem,
  onSelect,
  onPreview,
  onOpen,
  onPrefetch,
  viewMode,
  loading,
  syncing,
  error,
  query,
  isRootFolder,
  onBack,
  onRetry,
  onSync,
  gridClassName,
}: {
  items: DriveItem[];
  selectedItem: DriveItem | null;
  previewItem: DriveItem | null;
  onSelect: (id: string) => void;
  onPreview: (item: DriveItem) => void;
  onOpen: (item: DriveItem) => void;
  onPrefetch?: (item: DriveItem) => void;
  viewMode: ViewMode;
  loading: boolean;
  /** Lazy Drive sync in progress — distinct from a normal load (U6). */
  syncing?: boolean;
  error: string | null;
  query: string;
  isRootFolder: boolean;
  onBack: () => void;
  onRetry?: () => void;
  onSync: () => void;
  gridClassName?: string;
}) {
  const [renderCount, setRenderCount] = useState(RENDER_STEP);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Reset the progressive window when a different listing arrives — render-phase
  // reset (React's recommended alternative to a setState-in-effect).
  const [lastItems, setLastItems] = useState(items);
  if (lastItems !== items) {
    setLastItems(items);
    setRenderCount(RENDER_STEP);
  }

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRenderCount((count) => Math.min(count + RENDER_STEP, items.length));
      }
    }, { rootMargin: "600px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [items.length]);

  const visibleItems = useMemo(() => items.slice(0, renderCount), [items, renderCount]);

  // U9 — roving focus: arrows move between item buttons in the grid.
  function onGridKeyDown(event: React.KeyboardEvent) {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    const container = gridRef.current;
    const current = (event.target as HTMLElement).closest("[data-media-item]");
    if (!container || !current) return;
    const focusables = Array.from(container.querySelectorAll<HTMLElement>("[data-media-item]"));
    const index = focusables.indexOf(current as HTMLElement);
    if (index < 0) return;
    event.preventDefault();

    let next = index;
    const columns = viewMode === "grid"
      ? Math.max(1, Math.round(container.clientWidth / 220))
      : 1;
    if (event.key === "ArrowRight") next = index + 1;
    if (event.key === "ArrowLeft") next = index - 1;
    if (event.key === "ArrowDown") next = index + columns;
    if (event.key === "ArrowUp") next = index - columns;
    focusables[Math.min(Math.max(next, 0), focusables.length - 1)]?.focus();
  }

  if (loading && items.length === 0) {
    return (
      <section className="p-5" aria-busy="true" aria-label="Loading folder">
        <div className={cn("grid gap-4", GRID_COLUMNS, gridClassName)}>
          {Array.from({ length: 8 }).map((_, index) => <MediaCardSkeleton key={index} />)}
        </div>
      </section>
    );
  }

  // U6 — first open of an unsynced folder: n8n is pulling from Drive behind us.
  if (syncing && items.length === 0) {
    return (
      <div className="flex items-center justify-center p-10">
        <div className="max-w-md text-center">
          <FolderLoader label="Fetching from Google Drive" />
          <p className="mt-3 text-sm text-muted-foreground">
            First open takes a few seconds while we copy the folder metadata.
          </p>
        </div>
      </div>
    );
  }

  // U5 — errors get a way out: retry the request or step back to the parent.
  if (error) {
    return (
      <div className="flex items-center justify-center p-10">
        <div className="w-full max-w-md rounded-md border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          <div className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">Couldn&apos;t load this folder.</div>
              <p className="mt-1 text-red-700/90">Check your connection, then try again.</p>
              <details className="mt-2 text-xs text-red-700/80">
                <summary className="cursor-pointer">Details</summary>
                <p className="mt-1 [overflow-wrap:anywhere]">{error}</p>
              </details>
            </div>
          </div>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="outline" size="sm" onClick={onRetry ?? onSync}>
              <FolderSync className="mr-1.5 h-4 w-4" />
              Try again
            </Button>
            {!isRootFolder ? (
              <Button variant="outline" size="sm" onClick={onBack}>
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                Back to parent folder
              </Button>
            ) : null}
          </div>
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
              <div className="font-medium">No matches for &ldquo;{query.trim()}&rdquo; in this folder</div>
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
    <section className="relative min-w-0 p-5" onKeyDown={onGridKeyDown} aria-busy={loading || undefined}>
      {/* Loading over existing content: dim it and keep a spinner centred in the viewport. */}
      {loading ? (
        <div className="absolute inset-0 z-10 flex justify-center bg-background/75 backdrop-blur-[2px] loader-fade-in">
          <FolderLoader className="sticky top-[calc(50vh-80px)] self-start rounded-card border border-border bg-card px-10 pb-5 pt-6 shadow-soft" />
        </div>
      ) : null}
      {viewMode === "grid" ? (
        <div ref={gridRef} className={cn("grid gap-4", GRID_COLUMNS, gridClassName)}>
          {visibleItems.map((item) => (
            <MediaCard
              key={item.id}
              item={item}
              selected={selectedItem?.id === item.id}
              previewed={previewItem?.id === item.id}
              onSelect={() => onSelect(item.id)}
              onPreview={() => onPreview(item)}
              onOpen={() => onOpen(item)}
              onPrefetch={onPrefetch ? () => onPrefetch(item) : undefined}
            />
          ))}
        </div>
      ) : (
        <div ref={gridRef} className="overflow-hidden rounded-md border border-border bg-card">
          {visibleItems.map((item) => (
            <MediaRow
              key={item.id}
              item={item}
              selected={selectedItem?.id === item.id}
              previewed={previewItem?.id === item.id}
              onSelect={() => onSelect(item.id)}
              onPreview={() => onPreview(item)}
              onOpen={() => onOpen(item)}
              onPrefetch={onPrefetch ? () => onPrefetch(item) : undefined}
            />
          ))}
        </div>
      )}
      {renderCount < items.length ? (
        <div ref={sentinelRef} className="flex justify-center py-6" aria-hidden="true">
          <div className="text-xs text-muted-foreground">Loading {items.length - renderCount} more…</div>
        </div>
      ) : null}
    </section>
  );
}
