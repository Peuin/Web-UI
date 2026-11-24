"use client";

import { ChevronRight, CircleAlert, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FileKindIcon } from "@/components/ui/file-kind-icon";
import { FolderGlyph } from "@/components/ui/folder-glyph";
import { WorkflowProgress, WorkflowStatusBadge } from "@/components/ui/workflow-status";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { workflowErrorMessage } from "@/lib/utils/workflow-error";
import type { JobFolderRun, WorkflowJob } from "@/types/domain";

const JOB_GRID =
  "grid gap-3 grid-cols-[minmax(0,1fr)_116px_88px] md:grid-cols-[minmax(0,1fr)_140px_110px_110px_88px] xl:grid-cols-[minmax(0,1fr)_140px_110px_120px_120px_88px]";
const JOB_MD_CELL = "hidden md:block";
const JOB_XL_CELL = "hidden xl:block";

export const RETRY_SKIP_LABEL: Record<string, string> = {
  job_not_found: "not a SKU job",
  duplicate_request: "already sent",
  job_not_retryable: "not retryable",
  retry_already_active: "retry already running",
  folder_busy: "folder is busy",
  original_name_missing: "original folder name missing, needs review",
  branch_review_required: "needs review",
  batch_snapshot_missing: "original settings missing",
};

const RETRY_ACTION_LABEL: Record<string, string> = {
  recovery_existing_assets: "Can recover from saved outputs",
  resume_anchor_checkpoint: "Can resume from checkpoint",
  restart_generation_requires_approval: "Generating again requires confirmation",
  manual_review: "Needs manual review",
};

/** Depth-first order of the scan tree so children render under their parent. */
function orderFolderTree(folders: JobFolderRun[]): JobFolderRun[] {
  const ids = new Set(folders.map((folder) => folder.runId));
  const children = new Map<string | null, JobFolderRun[]>();
  for (const folder of folders) {
    const parent = folder.parentRunId && ids.has(folder.parentRunId) ? folder.parentRunId : null;
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  const ordered: JobFolderRun[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null) => {
    const list = (children.get(parent) ?? []).sort((a, b) =>
      (a.sourcePath ?? a.name).localeCompare(b.sourcePath ?? b.name),
    );
    for (const folder of list) {
      if (visited.has(folder.runId)) continue;
      visited.add(folder.runId);
      ordered.push(folder);
      walk(folder.runId);
    }
  };
  walk(null);
  return ordered;
}

/** What the user picked in Generate Media (file or folder), falling back to the scanned root folder. */
function jobLabel(job: WorkflowJob) {
  return job.selectedName ?? job.sourceName ?? `batch ${job.id.slice(0, 8)}`;
}

function folderCounts(job: WorkflowJob) {
  const done = job.folders.filter((folder) => folder.rawStatus === "completed").length;
  const failed = job.folders.filter((folder) => folder.status === "FAILED").length;
  return { done, failed, total: job.folders.length };
}

const RETRY_STATUS_STYLE: Record<NonNullable<JobFolderRun["lastRetryStatus"]>, { label: string; className: string }> = {
  queued: { label: "Queued", className: "border-amber-200 bg-amber-50 text-amber-800" },
  processing: { label: "Processing", className: "border-blue-200 bg-blue-50 text-blue-800" },
  completed: { label: "Succeeded", className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  failed: { label: "Failed", className: "border-red-200 bg-red-50 text-red-700" },
};

/** SKU retry state shown on the original folder row (retries never create a new batch). */
function RetryStatusBadge({ folder }: { folder: JobFolderRun }) {
  if (!folder.lastRetryStatus) return null;
  const style = RETRY_STATUS_STYLE[folder.lastRetryStatus];
  const active = folder.lastRetryStatus === "queued" || folder.lastRetryStatus === "processing";
  const title = [
    folder.retryMode ? `Mode: ${folder.retryMode}` : null,
    folder.lastRetryAt ? `Requested ${formatDate(folder.lastRetryAt)}` : null,
    folder.lastRetryStatus === "failed" && folder.lastRetryError ? workflowErrorMessage(folder.lastRetryError) : null,
  ].filter(Boolean).join("\n");
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium", style.className)}
      title={title || undefined}
    >
      {active ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
      Retry #{folder.retryCount} · {style.label}
    </span>
  );
}

function RetryButton({
  runId,
  label,
  retryingRunId,
  onRetry,
  size = "sm",
}: {
  runId: string;
  label: string;
  retryingRunId: string | null;
  onRetry: (runId: string, label: string) => void;
  size?: "sm" | "icon";
}) {
  const busy = retryingRunId === runId;
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("shrink-0", size === "icon" && "h-7 px-2 text-xs")}
      disabled={Boolean(retryingRunId)}
      onClick={(event) => {
        event.stopPropagation();
        onRetry(runId, label);
      }}
      title={`Retry ${label}`}
      aria-label={`Retry ${label}`}
    >
      {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
      Retry
    </Button>
  );
}

export function JobsPage({
  activeJob,
  jobs,
  loading,
  onSelectJob,
  onRetry,
  retryingRunId,
  notice,
  onRefresh,
}: {
  activeJob: WorkflowJob | null;
  jobs: WorkflowJob[];
  loading: boolean;
  onSelectJob: (job: WorkflowJob) => void;
  onRetry: (runId: string, label: string) => void;
  retryingRunId: string | null;
  notice: { tone: "success" | "error"; text: string } | null;
  onRefresh: () => void;
}) {
  const [expandedJobIds, setExpandedJobIds] = useState<Set<string>>(new Set());
  const toggleJob = (id: string) =>
    setExpandedJobIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="grid flex-1 grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_400px]">
      <section className="min-w-0 p-4 md:p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Workflow Jobs</h2>
            <p className="text-sm text-muted-foreground">
              Each row is one Generate Media submission (n8n batch) with its folder scan tree.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            Refresh
          </Button>
        </div>
        {notice ? (
          <div
            role="status"
            className={cn(
              "mb-4 rounded-md border p-3 text-sm",
              notice.tone === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-700",
            )}
          >
            {notice.text}
          </div>
        ) : null}
        <div className="overflow-hidden rounded-md border border-border bg-card">
          <div className={cn(JOB_GRID, "border-b border-border px-4 py-3 text-xs font-semibold uppercase text-muted-foreground")}>
            <span>Batch / folder</span>
            <span>Status</span>
            <span className={JOB_MD_CELL}>Progress</span>
            <span className={JOB_MD_CELL}>Folders · images</span>
            <span className={JOB_XL_CELL}>Created</span>
            <span />
          </div>
          {loading && jobs.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">Loading workflow jobs...</div>
          ) : null}
          {!loading && jobs.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No workflow jobs yet. Select a folder in Drive Browser and run Generate Media.
            </div>
          ) : null}
          {jobs.map((job) => {
            const counts = folderCounts(job);
            const label = jobLabel(job);
            const isOpen = expandedJobIds.has(job.id);
            const isFile = job.selectedType && job.selectedType !== "FOLDER";
            return (
              <div key={job.id} className="border-b border-border last:border-b-0">
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  aria-label={`Batch ${label}, ${counts.done} of ${counts.total} folders done${counts.failed ? `, ${counts.failed} failed` : ""}`}
                  className={cn(
                    JOB_GRID,
                    "w-full cursor-pointer items-center px-4 py-3 text-left hover:bg-secondary",
                    activeJob?.id === job.id && "bg-primary/5",
                  )}
                  onClick={() => {
                    onSelectJob(job);
                    toggleJob(job.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectJob(job);
                      toggleJob(job.id);
                    }
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <ChevronRight
                      className={cn(
                        "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                        isOpen && "rotate-90",
                        counts.total === 0 && "invisible",
                      )}
                    />
                    {isFile ? (
                      <FileKindIcon item={{ name: label, mimeType: null }} className="h-4 w-4 shrink-0" />
                    ) : (
                      <FolderGlyph className="h-4 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium" title={label}>{label}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {job.productType ? <span className="font-sans capitalize">{job.productType} · </span> : null}
                        {job.id.slice(0, 8)}
                        {job.sourceName && job.sourceName !== label ? ` · in ${job.sourceName}` : ""}
                      </div>
                    </div>
                  </div>
                  <WorkflowStatusBadge status={job.status} rawStatus={job.rawStatus} />
                  <WorkflowProgress value={job.progress} status={job.status} rawStatus={job.rawStatus} className={JOB_MD_CELL} />
                  <span className={cn("text-sm text-muted-foreground", JOB_MD_CELL)}>
                    {counts.done}/{counts.total}
                    {counts.failed ? <span className="ml-1 text-red-600">· {counts.failed} failed</span> : null}
                  </span>
                  <span className={cn("text-xs text-muted-foreground", JOB_XL_CELL)}>{formatDate(job.createdAt)}</span>
                  <div className="flex justify-end">
                    {job.canRetry ? (
                      <RetryButton runId={job.id} label={label} retryingRunId={retryingRunId} onRetry={onRetry} size="icon" />
                    ) : null}
                  </div>
                </div>
                {isOpen
                  ? orderFolderTree(job.folders).map((folder) => (
                      <div
                        key={folder.runId}
                        className={cn(
                          JOB_GRID,
                          "items-center border-t border-border/60 bg-background/60 px-4 py-2 text-left",
                          folder.status === "FAILED" && "bg-red-50/60",
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: 12 + folder.depth * 14 }}>
                          <FolderGlyph className="h-3.5 shrink-0" />
                          <div className="min-w-0">
                            <div className="truncate text-sm" title={folder.sourcePath ?? folder.name}>{folder.name}</div>
                            {folder.errorMessage ? (
                              <div className="text-[11px] text-red-700 [overflow-wrap:anywhere]">
                                {workflowErrorMessage(folder.errorMessage)}
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                          <WorkflowStatusBadge status={folder.status} rawStatus={folder.rawStatus} />
                          <RetryStatusBadge folder={folder} />
                        </div>
                        <span className={JOB_MD_CELL} />
                        <span className={cn("text-xs text-muted-foreground", JOB_MD_CELL)}>
                          {folder.imageCount !== null ? `${folder.imageCount} images` : "Not scanned"}
                          {folder.childFolderCount ? ` · ${folder.childFolderCount} sub` : ""}
                        </span>
                        <span className={cn("text-xs text-muted-foreground", JOB_XL_CELL)}>{formatDate(folder.updatedAt ?? folder.startedAt)}</span>
                        <div className="flex justify-end">
                          {folder.canRetry ? (
                            <RetryButton
                              runId={folder.runId}
                              label={folder.name}
                              retryingRunId={retryingRunId}
                              onRetry={onRetry}
                              size="icon"
                            />
                          ) : null}
                        </div>
                      </div>
                    ))
                  : null}
              </div>
            );
          })}
        </div>
      </section>
      <JobDetail job={activeJob} onRetry={onRetry} retryingRunId={retryingRunId} />
    </div>
  );
}

function JobDetail({
  job,
  onRetry,
  retryingRunId,
}: {
  job: WorkflowJob | null;
  onRetry: (runId: string, label: string) => void;
  retryingRunId: string | null;
}) {
  if (!job) {
    return (
      <aside className="border-t border-border bg-card p-4 md:p-5 2xl:border-l 2xl:border-t-0">
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          Select a batch to inspect its folders.
        </div>
      </aside>
    );
  }

  const folders = orderFolderTree(job.folders);
  const counts = folderCounts(job);
  const label = jobLabel(job);

  return (
    <aside className="overflow-auto border-t border-border bg-card p-4 md:p-5 2xl:border-l 2xl:border-t-0">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <WorkflowStatusBadge status={job.status} rawStatus={job.rawStatus} />
          <h3 className="mt-3 truncate text-lg font-semibold" title={label}>{label}</h3>
          {job.productType ? <p className="mt-1 text-xs capitalize text-muted-foreground">{job.productType}</p> : null}
        </div>
        {job.canRetry ? (
          <RetryButton runId={job.id} label={label} retryingRunId={retryingRunId} onRetry={onRetry} />
        ) : null}
      </div>
      <WorkflowProgress value={job.progress} status={job.status} rawStatus={job.rawStatus} className="mb-2" />
      <div className="mb-5 text-xs text-muted-foreground">
        {counts.done} of {counts.total} folders completed
        {counts.failed ? ` · ${counts.failed} failed` : ""} · started {formatDate(job.startedAt ?? job.createdAt)}
      </div>

      {job.errorMessage || counts.failed ? (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <div className="flex items-start gap-2"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <div className="font-semibold">{counts.failed ? `${counts.failed} ${counts.failed === 1 ? "folder needs" : "folders need"} attention` : "Workflow could not finish"}</div>
              {counts.failed ? <ul className="mt-2 space-y-2">
                {folders.filter((folder) => folder.status === "FAILED").map((folder) => <li key={folder.runId} className="[overflow-wrap:anywhere]">
                  <div className="font-medium">{folder.name}</div>
                  <div className="mt-0.5 text-xs">{workflowErrorMessage(folder.errorMessage ?? job.errorMessage)}</div>
                </li>)}
              </ul> : <p className="mt-1 [overflow-wrap:anywhere]">{workflowErrorMessage(job.errorMessage)}</p>}
            </div>
          </div>
        </div>
      ) : null}

      <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Folders</div>
      {folders.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          No folders scanned for this batch yet.
        </div>
      ) : (
        <ul className="space-y-1">
          {folders.map((folder) => (
            <li
              key={folder.runId}
              className={cn(
                "rounded-md border border-transparent py-2 pr-2",
                folder.status === "FAILED" && "border-red-200 bg-red-50/60",
              )}
              style={{ paddingLeft: 8 + folder.depth * 16 }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <FolderGlyph className="h-4 shrink-0" />
                <span className="min-w-0 flex-1 basis-24 text-sm font-medium [overflow-wrap:anywhere]" title={folder.sourcePath ?? folder.name}>
                  {folder.name}
                </span>
                <WorkflowStatusBadge status={folder.status} rawStatus={folder.rawStatus} />
                <RetryStatusBadge folder={folder} />
                {folder.canRetry ? (
                  <RetryButton
                    runId={folder.runId}
                    label={folder.name}
                    retryingRunId={retryingRunId}
                    onRetry={onRetry}
                    size="icon"
                  />
                ) : null}
              </div>
              <div className="mt-0.5 pl-6 text-xs text-muted-foreground">
                {folder.imageCount !== null ? `${folder.imageCount} images` : "Not scanned"}
                {folder.childFolderCount ? ` · ${folder.childFolderCount} subfolders` : ""}
                {folder.attempt && folder.attempt > 1 ? ` · attempt ${folder.attempt}` : ""}
                {folder.retryAction && RETRY_ACTION_LABEL[folder.retryAction]
                  ? ` · ${RETRY_ACTION_LABEL[folder.retryAction]}`
                  : ""}
              </div>
              {folder.errorMessage ? (
                <div className="mt-2 pl-6 text-xs leading-relaxed text-red-700 [overflow-wrap:anywhere]">{workflowErrorMessage(folder.errorMessage)}</div>
              ) : null}
              {folder.files.length ? (
                <ul className="mt-1.5 space-y-0.5 pl-6">
                  {folder.files.map((file) => (
                    <li key={file.id} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <FileKindIcon item={{ name: file.name ?? "", mimeType: null }} className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate" title={file.name ?? file.id}>{file.name ?? file.id}</span>
                    </li>
                  ))}
                  {folder.imageCount && folder.imageCount > folder.files.length ? (
                    <li className="text-xs text-muted-foreground">+{folder.imageCount - folder.files.length} more</li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
