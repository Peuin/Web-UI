"use client";

import { ChevronRight, Home as HomeIcon, Loader2 } from "lucide-react";
import { FolderGlyph } from "@/components/ui/folder-glyph";
import { cn } from "@/lib/utils/cn";
import { getFolderKeyFromItem } from "@/lib/utils/drive";
import type { DriveItem } from "@/types/domain";

export function FolderTree({
  rootChildren,
  folderChildren,
  expanded,
  currentKey,
  loadingKeys,
  onNavigate,
  onToggle,
  onPrefetch,
}: {
  rootChildren: DriveItem[];
  folderChildren: Record<string, DriveItem[]>;
  expanded: Set<string>;
  currentKey: string;
  loadingKeys: Set<string>;
  onNavigate: (key: string) => void;
  onToggle: (key: string) => void;
  /** P2 — hover/focus warms the listing cache for the hovered folder. */
  onPrefetch?: (key: string) => void;
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
            onMouseEnter={() => onPrefetch?.(key)}
            onFocus={() => onPrefetch?.(key)}
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
    <aside className="hidden overflow-auto border-r border-border bg-brand-cream/50 px-3 py-4 lg:block">
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
