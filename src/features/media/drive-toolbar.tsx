"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Grid2X2,
  Home as HomeIcon,
  List,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { friendlyItemName, type FolderCrumb, type ViewMode } from "@/lib/utils/drive";

export type FolderSort = "modified_desc" | "modified_asc" | "name_asc" | "name_desc";

const SORT_OPTIONS: { value: FolderSort; label: string }[] = [
  { value: "modified_desc", label: "Newest" },
  { value: "modified_asc", label: "Oldest" },
  { value: "name_asc", label: "Name A–Z" },
  { value: "name_desc", label: "Name Z–A" },
];

export function DriveToolbar({
  query,
  setQuery,
  viewMode,
  setViewMode,
  syncing,
  onSync,
  breadcrumbs,
  summary,
  onBreadcrumbSelect,
  previewPanelOpen,
  onTogglePreviewPanel,
  sort,
  onSortChange,
  updatedAt,
  searchInputRef,
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
  /** Kept for callers; Sync already re-lists, so no separate Refresh button. */
  onRefresh?: () => void;
  previewPanelOpen: boolean;
  onTogglePreviewPanel: () => void;
  sort?: FolderSort;
  onSortChange?: (sort: FolderSort) => void;
  /** When the listing was last fetched — shown as "Updated 3 min ago" (U6). */
  updatedAt?: Date | null;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  // Long paths collapse to: Root › … › parent › current
  const visibleCrumbs = breadcrumbs.length > 3
    ? [0, -1, breadcrumbs.length - 2, breadcrumbs.length - 1]
    : breadcrumbs.map((_, index) => index);
  const canGoBack = breadcrumbs.length > 1;
  const parentCrumb = canGoBack ? breadcrumbs[breadcrumbs.length - 2] : null;

  const relativeUpdated = useRelativeTime(updatedAt ?? null);

  return (
    <div className="flex min-h-[68px] min-w-0 flex-wrap items-center gap-x-3 gap-y-3 border-b border-border px-5 py-3">
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          disabled={!canGoBack}
          onClick={() => onBreadcrumbSelect(breadcrumbs.length - 2)}
          title={parentCrumb ? `Back to ${parentCrumb.name}` : "Already at root folder"}
          aria-label="Back to parent folder"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
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
              const friendly = friendlyItemName(crumb.name);
              return (
                <span
                  key={`${crumb.driveItemId ?? "root"}-${index}`}
                  className={cn("flex min-w-0 items-center gap-0.5", isCurrent ? "shrink-0 basis-auto" : "shrink")}
                >
                  {position > 0 ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-brand-line" /> : null}
                  <button
                    className={cn(
                      "flex min-w-0 items-center gap-1.5 px-1.5 py-0.5 transition-colors",
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
                      <span className={cn("truncate", isCurrent ? "max-w-[260px]" : "max-w-[140px]")}>
                        {friendly.label}
                        {friendly.date ? <span className="ml-1 text-[10px] uppercase text-muted-foreground">{friendly.date}</span> : null}
                      </span>
                    )}
                  </button>
                </span>
              );
            })}
          </nav>
          <div className="mt-0.5 flex items-center gap-1.5 pl-1.5 text-xs text-muted-foreground">
            <span>{summary}</span>
            {relativeUpdated ? (
              <>
                <span aria-hidden="true" className="text-brand-line">•</span>
                <span title={updatedAt?.toLocaleString()}>Updated {relativeUpdated}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
        <label className="group relative flex h-9 min-w-0 flex-1 items-center border border-input bg-background transition-colors focus-within:border-brand-ink basis-full sm:w-64 sm:basis-auto sm:flex-none lg:w-72">
          <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchInputRef}
            className="h-full w-full min-w-0 bg-transparent pl-8 pr-9 text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Search this folder"
            aria-label="Search this folder"
            aria-keyshortcuts="/"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="absolute right-1.5 flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 hidden h-5 min-w-5 items-center justify-center border border-border bg-secondary px-1 font-sans text-[11px] text-muted-foreground group-focus-within:hidden sm:flex">
              /
            </kbd>
          )}
        </label>

        {onSortChange ? (
          <label className="relative flex h-9 min-w-0 flex-1 items-center border border-input sm:flex-none bg-background transition-colors focus-within:border-brand-ink hover:border-brand-ink">
            <ArrowUpDown className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <select
              aria-label="Sort items"
              className="h-full w-full cursor-pointer appearance-none bg-transparent pl-8 pr-7 text-sm outline-none"
              value={sort ?? "modified_desc"}
              onChange={(event) => onSortChange(event.target.value as FolderSort)}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </label>
        ) : null}

        <Button
          variant="outline"
          className="shrink-0 px-3"
          onClick={onSync}
          disabled={syncing}
          title="Pull the latest from Google Drive"
          aria-label="Sync folder from Google Drive"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} aria-hidden="true" />
          <span className="hidden md:inline">{syncing ? "Syncing" : "Sync"}</span>
        </Button>

        <div className="flex h-9 shrink-0 items-stretch border border-brand-line bg-card" role="group" aria-label="View options">
          <ToolbarToggle label="Grid view" active={viewMode === "grid"} onClick={() => setViewMode("grid")}>
            <Grid2X2 className="h-4 w-4" />
          </ToolbarToggle>
          <ToolbarToggle label="List view" active={viewMode === "list"} onClick={() => setViewMode("list")}>
            <List className="h-4 w-4" />
          </ToolbarToggle>
          <span className="my-2 w-px bg-border" aria-hidden="true" />
          <ToolbarToggle
            label={previewPanelOpen ? "Hide details panel" : "Show details panel"}
            active={previewPanelOpen}
            onClick={onTogglePreviewPanel}
          >
            {previewPanelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </ToolbarToggle>
        </div>
      </div>
    </div>
  );
}

function ToolbarToggle({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-9 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      )}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

/** "just now" / "3 min ago" / "2 h ago", re-rendered every 30 s. */
function useRelativeTime(date: Date | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!date) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [date]);
  if (!date) return null;
  const seconds = Math.max(0, Math.round((Math.max(now, date.getTime()) - date.getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return date.toLocaleDateString();
}

/** "21 folders · 3 files", dropping zero counts; "Empty folder" when both are 0. */
export function formatFolderSummary(folderCount: number, fileCount: number) {
  const parts: string[] = [];
  if (folderCount) parts.push(`${folderCount} ${folderCount === 1 ? "folder" : "folders"}`);
  if (fileCount) parts.push(`${fileCount} ${fileCount === 1 ? "file" : "files"}`);
  return parts.length ? parts.join(" · ") : "Empty folder";
}
