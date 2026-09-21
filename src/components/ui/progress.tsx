import { cn } from "@/lib/utils/cn";

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-2 overflow-hidden rounded-sm bg-muted", className)}>
      <div
        className="h-full rounded-sm bg-primary transition-all"
        style={{ width: `${Math.max(0, Math.min(value, 100))}%` }}
      />
    </div>
  );
}
