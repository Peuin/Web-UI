import { Check, CircleAlert, Clock3, Loader2, Pause, ScanLine, SkipForward, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils/cn";
import type { WorkflowStatus } from "@/types/domain";

function statusAppearance(status: WorkflowStatus, rawStatus?: string) {
  if (rawStatus === "scanning") return { label: "Scanning", variant: "info", Icon: ScanLine, active: true } as const;
  if (rawStatus === "partial_failed") return { label: "Partially failed", variant: "danger", Icon: CircleAlert, active: false } as const;
  if (rawStatus === "skipped") return { label: "Skipped", variant: "neutral", Icon: SkipForward, active: false } as const;
  if (rawStatus === "ready") return { label: "Ready", variant: "neutral", Icon: Check, active: false } as const;
  const appearances = {
    QUEUED: { label: rawStatus === "queued_scan" ? "Queued scan" : "Queued", variant: "neutral", Icon: Clock3, active: false },
    PROCESSING: { label: "Processing", variant: "info", Icon: Loader2, active: true },
    WAITING_EXTERNAL: { label: "Waiting for service", variant: "warning", Icon: Clock3, active: true },
    COMPLETED: { label: "Completed", variant: "success", Icon: Check, active: false },
    FAILED: { label: "Failed", variant: "danger", Icon: CircleAlert, active: false },
    CANCELLED: { label: "Canceled", variant: "neutral", Icon: X, active: false },
  } as const;
  return appearances[status];
}

export function WorkflowStatusBadge({ status, rawStatus }: { status: WorkflowStatus; rawStatus?: string }) {
  const appearance = statusAppearance(status, rawStatus);
  const { Icon } = appearance;
  return <Badge variant={appearance.variant} className="w-fit max-w-full gap-1.5 whitespace-normal leading-4">
    <Icon aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0", appearance.active && (Icon === Loader2 ? "motion-safe:animate-spin" : "motion-safe:animate-pulse"))} />
    <span>{appearance.label}</span>
  </Badge>;
}

export function WorkflowProgress({ value, status, rawStatus, className }: {
  value: number; status: WorkflowStatus; rawStatus?: string; className?: string;
}) {
  const appearance = statusAppearance(status, rawStatus);
  const skipped = rawStatus === "skipped";
  const progress = status === "COMPLETED" && !skipped ? 100 : Math.max(0, Math.min(Number.isFinite(value) ? value : 0, 100));
  const indeterminate = appearance.active && (rawStatus === "scanning" || progress === 0);
  const tone = appearance.variant === "success" ? "bg-emerald-500" : appearance.variant === "danger" ? "bg-red-500" : appearance.variant === "warning" ? "bg-amber-500" : appearance.variant === "info" ? "bg-sky-500" : "bg-muted-foreground/40";
  return <div className={cn("min-w-0", className)}>
    <div
      role="progressbar"
      aria-label={appearance.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : progress}
      aria-valuetext={indeterminate ? `${appearance.label} in progress` : skipped || status === "QUEUED" || status === "CANCELLED" ? appearance.label : `${appearance.label}: ${Math.round(progress)}%`}
      className="relative h-1.5 overflow-hidden rounded-full bg-muted"
    >
      <div className={cn("h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none", tone, indeterminate && "workflow-progress-sweep", appearance.active && !indeterminate && "workflow-progress-stripes")} style={{ width: indeterminate ? "35%" : `${progress}%` }} />
    </div>
    <div className="mt-1 flex items-center gap-1 text-[10px] leading-3 text-muted-foreground">
      {status === "CANCELLED" ? <Pause aria-hidden="true" className="h-2.5 w-2.5" /> : null}
      {rawStatus === "scanning" ? "Scanning files…" : indeterminate ? "Working…" : skipped ? "Skipped" : status === "QUEUED" ? "Pending" : status === "CANCELLED" ? "Stopped" : appearance.variant === "danger" ? "Needs attention" : `${Math.round(progress)}%`}
    </div>
  </div>;
}
