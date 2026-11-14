"use client";

import { Check, Link, MoreHorizontal, Share2 } from "lucide-react";
import Image from "next/image";
import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import { FolderGlyph } from "@/components/ui/folder-glyph";
import { copyTextToClipboard } from "@/lib/utils/clipboard";
import { cn } from "@/lib/utils/cn";
import {
  friendlyItemName,
  skipImageOptimizer,
  stripMarkdownLink,
  typeIcon,
} from "@/lib/utils/drive";
import { formatBytes, formatDate } from "@/lib/utils/format";
import type { DriveItem } from "@/types/domain";

/**
 * U2 — predictable activation: a folder opens on single click; a file previews
 * on single click and opens in Google Drive on double-click (or Enter/Space).
 */
function itemHandlers(onPreview: () => void, onOpen: () => void, isFolder: boolean) {
  return {
    onClick: () => (isFolder ? onOpen() : onPreview()),
    onDoubleClick: () => {
      if (!isFolder) onOpen();
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (isFolder) onOpen();
        else onPreview();
      }
    },
  };
}

// U4 — actions must be reachable on touch (no hover) and discoverable on
// desktop: faint by default, solid on hover/focus/selection.
const HOVER_ACTION =
  "opacity-40 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100";
const HOVER_ACTION_HIDDEN =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100";

export const MediaCard = memo(function MediaCard({
  item,
  selected,
  previewed,
  onSelect,
  onPreview,
  onOpen,
  onPrefetch,
}: {
  item: DriveItem;
  selected: boolean;
  previewed: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onOpen: () => void;
  onPrefetch?: () => void;
}) {
  const Icon = typeIcon[item.itemType];
  const isFolder = item.itemType === "FOLDER";
  const [copied, setCopied] = useState(false);
  const meta = isFolder ? formatDate(item.modifiedTime) : `${formatDate(item.modifiedTime)} · ${formatBytes(item.sizeBytes)}`;
  const driveLink = stripMarkdownLink(item.webViewLink);
  const friendly = isFolder ? friendlyItemName(item.name) : null;

  function showCopied() {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function copyText(value: string | null) {
    if (!value) return;
    if (await copyTextToClipboard(value)) showCopied();
  }

  return (
    <article
      className={cn(
        "group relative flex min-w-0 flex-col rounded-card bg-card p-2 transition focus-within:shadow-[0_6px_24px_rgba(28,28,28,0.08)] hover:bg-card hover:shadow-[0_6px_24px_rgba(28,28,28,0.08)]",
        selected ? "ring-1 ring-primary" : previewed && "ring-1 ring-brand-line shadow-[0_6px_24px_rgba(28,28,28,0.08)]",
      )}
      onMouseEnter={() => isFolder && onPrefetch?.()}
    >
      <button
        className="relative flex aspect-[4/3] select-none items-center justify-center overflow-hidden rounded-tile border border-border bg-card"
        title={isFolder ? "Open folder" : `${item.name} — double-click to open in Drive`}
        aria-label={isFolder ? `Open folder ${item.name}` : `Preview ${item.name}`}
        data-media-item
        {...itemHandlers(onPreview, onOpen, isFolder)}
      >
        {/* Drive's folder thumbnails are blurry generic icons — always use our glyph. */}
        {isFolder ? (
          <FolderGlyph className="folder-card-icon h-16 shrink-0 transition-transform duration-300 motion-safe:group-hover:scale-110" />
        ) : item.thumbnailUrl ? (
          <Image src={item.thumbnailUrl} alt="" fill sizes="260px" className="object-cover" unoptimized={skipImageOptimizer(item.thumbnailUrl)} referrerPolicy="no-referrer" />
        ) : (
          <Icon className="h-10 w-10 text-muted-foreground" />
        )}
        {item.syncStatus === "STALE" ? <span className="absolute bottom-3 left-3 h-2 w-2 rounded-full bg-amber-500" /> : null}
      </button>
      <input
        type="checkbox"
        checked={selected}
        aria-label={isFolder ? `Select folder ${item.name}` : `Select file ${item.name}`}
        className={cn(
          "absolute right-3 top-3 h-5 w-5 cursor-pointer appearance-none rounded-[4px] border-2 border-muted-foreground/60 bg-card transition-opacity checked:border-primary checked:bg-primary",
          HOVER_ACTION,
          selected && "border-primary bg-primary opacity-100",
        )}
        onClick={(event) => event.stopPropagation()}
        onChange={onSelect}
      />
      {selected ? <Check className="pointer-events-none absolute right-[15px] top-[15px] h-3.5 w-3.5 text-primary-foreground" /> : null}
      <div className="flex flex-1 flex-col">
        <button
          className="mt-3 line-clamp-1 select-none text-center text-sm font-medium hover:text-brand-dark"
          title={item.name}
          {...itemHandlers(onPreview, onOpen, isFolder)}
        >
          {friendly?.label ?? item.name}
        </button>
        {friendly?.date ? (
          <div className="mt-0.5 text-center text-[10px] uppercase tracking-wide text-muted-foreground">{friendly.date}</div>
        ) : null}
        <div className="relative mt-1 h-8">
          <div className={cn("flex h-8 items-center justify-center truncate text-xs text-muted-foreground transition-opacity group-focus-within:opacity-0 group-hover:opacity-0 [@media(hover:none)]:hidden", selected && "opacity-0")}>
            {copied ? "Copied" : meta}
          </div>
          <div className={cn("absolute inset-0 flex items-center justify-center gap-1", HOVER_ACTION_HIDDEN, selected && "opacity-100")}>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-secondary [@media(hover:none)]:h-11 [@media(hover:none)]:w-11" title="Copy Google Drive link" aria-label={`Copy link for ${item.name}`} disabled={!driveLink} onClick={() => void copyText(driveLink)}>
              <Link className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-secondary [@media(hover:none)]:h-11 [@media(hover:none)]:w-11" title="Open Google Drive link" aria-label={`Open ${item.name} in Google Drive`} disabled={!driveLink} onClick={() => driveLink ? window.open(driveLink, "_blank", "noopener") : undefined}>
              <Share2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
});

export const MediaRow = memo(function MediaRow({
  item,
  selected,
  previewed,
  onSelect,
  onPreview,
  onOpen,
  onPrefetch,
}: {
  item: DriveItem;
  selected: boolean;
  previewed: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onOpen: () => void;
  onPrefetch?: () => void;
}) {
  const Icon = typeIcon[item.itemType];
  const isFolder = item.itemType === "FOLDER";
  const friendly = isFolder ? friendlyItemName(item.name) : null;

  return (
    <div className={cn("grid grid-cols-[40px_minmax(0,1fr)_44px] items-center md:grid-cols-[40px_minmax(0,1fr)_130px_120px_120px_44px] border-b border-border px-3 py-2.5 last:border-b-0", selected ? "bg-primary/5" : previewed && "bg-secondary")}>
      <span className="relative flex h-5 w-5">
        <input
          type="checkbox"
          checked={selected}
          aria-label={isFolder ? `Select folder ${item.name}` : `Select file ${item.name}`}
          className="h-5 w-5 cursor-pointer appearance-none rounded-sm border-2 border-border bg-card checked:border-primary checked:bg-primary"
          onClick={(event) => event.stopPropagation()}
          onChange={onSelect}
          onMouseEnter={() => isFolder && onPrefetch?.()}
        />
        {selected ? <Check className="pointer-events-none absolute inset-0 m-auto h-3.5 w-3.5 text-primary-foreground" /> : null}
      </span>
      <button
        className="flex min-w-0 select-none items-center gap-3 text-left"
        title={isFolder ? "Open folder" : item.name}
        aria-label={isFolder ? `Open folder ${item.name}` : `Preview ${item.name}`}
        data-media-item
        {...itemHandlers(onPreview, onOpen, isFolder)}
        style={{ paddingLeft: Math.min(item.treeDepth ?? 0, 8) * 14 }}
        onMouseEnter={() => isFolder && onPrefetch?.()}
      >
        {isFolder ? <FolderGlyph className="h-4 shrink-0" /> : <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {friendly?.label ?? item.name}
            {friendly?.date ? <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{friendly.date}</span> : null}
          </span>
          {item.treePath && item.treePath.length > 1 ? (
            <span className="block truncate text-xs text-muted-foreground">
              {item.treePath.slice(0, -1).join(" / ")}
            </span>
          ) : null}
        </span>
      </button>
      <span className="hidden text-xs text-muted-foreground md:block">{item.itemType}</span>
      <span className="hidden text-xs text-muted-foreground md:block">{formatBytes(item.sizeBytes)}</span>
      <span className="hidden text-xs text-muted-foreground md:block">{formatDate(item.modifiedTime)}</span>
      <Button variant="ghost" size="icon" title="Preview metadata" aria-label={`Preview metadata for ${item.name}`} onClick={onPreview}>
        <MoreHorizontal className="h-4 w-4" />
      </Button>
    </div>
  );
});
