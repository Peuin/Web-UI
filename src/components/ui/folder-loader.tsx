import { FolderGlyph } from "@/components/ui/folder-glyph";
import { cn } from "@/lib/utils/cn";

/**
 * Brand loading mark: the orange folder glyph bobbing above three
 * sequenced dots and a small uppercase caption (same type as headings).
 */
export function FolderLoader({ label = "Loading folder", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-3", className)} role="status" aria-live="polite">
      <div className="relative flex flex-col items-center">
        <FolderGlyph className="folder-loader-glyph h-11" />
        <span className="folder-loader-shadow mt-1.5 h-1 w-9 rounded-full bg-foreground/10" aria-hidden="true" />
      </div>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        <span className="folder-loader-dot h-1.5 w-1.5 rounded-full bg-[#F2994A]" />
        <span className="folder-loader-dot h-1.5 w-1.5 rounded-full bg-[#F2994A] [animation-delay:160ms]" />
        <span className="folder-loader-dot h-1.5 w-1.5 rounded-full bg-[#F2994A] [animation-delay:320ms]" />
      </div>
      <span className="font-montserrat text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/** Placeholder shaped like a MediaCard, with a warm shimmer sweep. */
export function MediaCardSkeleton() {
  return (
    <div className="flex flex-col rounded-card bg-card p-2" aria-hidden="true">
      <div className="skeleton-shimmer aspect-[4/3] rounded-tile border border-border" />
      <div className="skeleton-shimmer mx-auto mt-4 h-3.5 w-3/5 rounded-full" />
      <div className="skeleton-shimmer mx-auto mt-3 mb-2.5 h-2.5 w-2/5 rounded-full" />
    </div>
  );
}
