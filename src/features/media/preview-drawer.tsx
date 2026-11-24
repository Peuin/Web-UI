"use client";

import {
  ChevronDown,
  File,
  FolderOpen,
  Info as InfoIcon,
  Link,
  Loader2,
  Play,
  Sparkles,
  X,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FileExtensionBadge, FileKindIcon } from "@/components/ui/file-kind-icon";
import { FolderGlyph } from "@/components/ui/folder-glyph";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  OUTPUT_TYPE_OPTIONS,
  validateReferenceImageUrl,
  type GenerationFormValues,
  type ProductTypeOption,
} from "@/features/media/generation";
import { cn } from "@/lib/utils/cn";
import {
  fileKindLabel,
  getFileKind,
  isValidStoragePrefix,
  skipImageOptimizer,
} from "@/lib/utils/drive";
import { formatBytes, formatDate } from "@/lib/utils/format";
import type { DriveItem } from "@/types/domain";

export type FolderStats = {
  key: string;
  files: number;
  subfolders: number;
  totalBytes: number;
};

const NOTICE_AUTO_HIDE_MS = 8000;

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-medium">{value}</div>
    </div>
  );
}

// Single-line textarea that grows with its content instead of reserving rows.
function GrowTextarea({ className, value, ...props }: ComponentProps<typeof Textarea>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <Textarea
      ref={ref}
      rows={1}
      value={value}
      className={cn("min-h-[38px] resize-none overflow-hidden", className)}
      {...props}
    />
  );
}

function FormSection({
  id,
  title,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border">
      <h4>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        >
          {title}
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
        </button>
      </h4>
      {open ? <div id={id} className="space-y-3 border-t border-border p-3">{children}</div> : null}
    </section>
  );
}

export function PreviewDrawer({
  onClose,
  item,
  selectedItem,
  folderStats,
  form,
  onFieldChange,
  productTypeOptions,
  submitNotice,
  onDismissNotice,
  onOpenModelPicker,
  submitting,
  onSubmit,
  onOpenFolder,
}: {
  item: DriveItem | null;
  selectedItem: DriveItem | null;
  folderStats: FolderStats | null;
  form: GenerationFormValues;
  onFieldChange: (field: keyof GenerationFormValues, value: string) => void;
  productTypeOptions: ProductTypeOption[];
  submitNotice: string | null;
  onDismissNotice: () => void;
  onOpenModelPicker: () => void;
  submitting: boolean;
  onSubmit: () => void;
  onOpenFolder: (folder: DriveItem) => void;
  onClose: () => void;
}) {
  const [sections, setSections] = useState({ product: true, source: false, output: false });
  // Thumbnail load failure falls back to the kind icon (keyed by URL).
  const [brokenThumb, setBrokenThumb] = useState<string | null>(null);

  useEffect(() => {
    if (!submitNotice) return;
    const timer = window.setTimeout(onDismissNotice, NOTICE_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [submitNotice, onDismissNotice]);

  const toggleSection = (key: keyof typeof sections) =>
    setSections((current) => ({ ...current, [key]: !current[key] }));

  if (!selectedItem && !item) {
    return (
      <aside className="flex max-h-[78vh] flex-col bg-card p-5 sm:h-full sm:max-h-none xl:sticky xl:top-0 xl:h-[calc(100vh-65px)]">
        <div className="mb-4 flex justify-end">
          <Button variant="ghost" size="icon" title="Hide details panel" aria-label="Hide details panel" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          Select a file or folder to preview metadata.
        </div>
      </aside>
    );
  }

  // The checked selection is the panel's source of truth; a plain preview only
  // shows when nothing is selected.
  const displayItem = selectedItem ?? item;
  const stats = displayItem && folderStats?.key === displayItem.driveItemId ? folderStats : null;

  // U13 — validate inline, before the user ever presses Generate Media.
  const modelUrlError = validateReferenceImageUrl("Model Reference URL", form.modelReferenceUrl.trim() || null);
  const styleUrlError = validateReferenceImageUrl("Style Reference URL", form.styleReferenceUrl.trim() || null);
  const prefixError = form.sourceStoragePrefix.trim() && !isValidStoragePrefix(form.sourceStoragePrefix)
    ? "This looks like a URL, not a storage path — expected e.g. google-drive/01_New_Product_Raw/FOLDER."
    : null;
  const formError = modelUrlError ?? styleUrlError ?? prefixError;
  const imageCount = parseInt(form.imageCount, 10) || 0;
  const videoSeconds = parseInt(form.videoSeconds, 10) || 0;
  const summaryChips = selectedItem
    ? [`${imageCount} img`, `1 video ${videoSeconds}s`, form.aspectRatio, form.videoResolution]
    : null;
  const displayKind = displayItem && displayItem.itemType !== "FOLDER" ? getFileKind(displayItem) : null;
  const isMediaKind = displayKind === "image" || displayKind === "video";
  const showThumb = isMediaKind && displayItem?.thumbnailUrl && brokenThumb !== displayItem.thumbnailUrl;

  return (
    <aside className="flex max-h-[78vh] flex-col bg-card sm:h-full sm:max-h-none xl:sticky xl:top-0 xl:h-[calc(100vh-65px)]">
      <div className="flex items-center justify-between px-5 pb-3 pt-5">
        <h3 className="text-sm font-semibold">
          {selectedItem
            ? selectedItem.itemType === "FOLDER"
              ? "Folder Selection"
              : "File Selection"
            : "File Preview"}
        </h3>
        <Button variant="ghost" size="icon" title="Hide details panel" aria-label="Hide details panel" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5">
        {/* Selected Item Info */}
        {selectedItem ? (
          <div className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2.5">
            {selectedItem.itemType === "FOLDER" ? (
              <FolderGlyph className="h-5 shrink-0" />
            ) : (
              <FileKindIcon item={selectedItem} className="h-4 w-4 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-medium" title={selectedItem.name}>{selectedItem.name}</div>
              <div className="text-xs text-muted-foreground">
                {selectedItem.itemType === "FOLDER" ? "Folder · all descendant files" : `${fileKindLabel(selectedItem)} · single file`}
              </div>
            </div>
          </div>
        ) : null}

        {/* Generation Form */}
        {selectedItem ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4" />
              Media Generation Parameters
            </div>

            <FormSection id="gen-sec-product" title="Product" open={sections.product} onToggle={() => toggleSection("product")}>
              <div>
                <label htmlFor="gen-product-type" className="mb-1 block text-xs font-medium text-muted-foreground">Product Type *</label>
                <Select id="gen-product-type" value={form.productType} onChange={(e) => onFieldChange("productType", e.target.value)}>
                  {productTypeOptions.map((option) => (
                    <option key={option.value} value={option.value} title={option.category}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>

              <div>
                <label htmlFor="gen-product-desc" className="mb-1 block text-xs font-medium text-muted-foreground">Product Description</label>
                <GrowTextarea
                  id="gen-product-desc"
                  placeholder="Optional product description..."
                  value={form.productDescription}
                  onChange={(e) => onFieldChange("productDescription", e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="gen-concept-style" className="mb-1 block text-xs font-medium text-muted-foreground">Concept/Style</label>
                <GrowTextarea
                  id="gen-concept-style"
                  placeholder="Optional concept/style for the image set..."
                  value={form.conceptStyle}
                  onChange={(e) => onFieldChange("conceptStyle", e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="gen-sample-prompt" className="mb-1 block text-xs font-medium text-muted-foreground">Input Sample Prompt</label>
                <GrowTextarea
                  id="gen-sample-prompt"
                  placeholder="Optional sample prompt..."
                  value={form.samplePrompt}
                  onChange={(e) => onFieldChange("samplePrompt", e.target.value)}
                />
              </div>
            </FormSection>

            <FormSection id="gen-sec-source" title="Source & references" open={sections.source} onToggle={() => toggleSection("source")}>
              <div>
                <label htmlFor="gen-source-prefix" className="mb-1 block text-xs font-medium text-muted-foreground">Source Storage Prefix *</label>
                <Input
                  id="gen-source-prefix"
                  value={form.sourceStoragePrefix}
                  onChange={(e) => onFieldChange("sourceStoragePrefix", e.target.value)}
                  placeholder="google-drive/01_New_Product_Raw/..."
                  aria-invalid={Boolean(prefixError)}
                />
                {prefixError ? <p className="mt-1 text-xs text-red-600">{prefixError}</p> : null}
              </div>

              <div>
                <label htmlFor="gen-model-ref" className="mb-1 block text-xs font-medium text-muted-foreground">Model Reference URL</label>
                <div className="flex flex-col gap-2">
                  {form.modelReferenceUrl ? (
                    <div className="relative overflow-hidden rounded-md border border-border">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={form.modelReferenceUrl}
                        alt="Model Reference"
                        className="aspect-[4/3] w-full object-cover"
                      />
                    </div>
                  ) : null}
                  <div className="flex gap-2">
                    <Input
                      id="gen-model-ref"
                      value={form.modelReferenceUrl}
                      onChange={(e) => onFieldChange("modelReferenceUrl", e.target.value)}
                      placeholder="https://..."
                      className="flex-1"
                      aria-invalid={Boolean(modelUrlError)}
                    />
                    <Button variant="secondary" onClick={onOpenModelPicker} type="button">
                      Browse
                    </Button>
                  </div>
                  {modelUrlError ? <p className="text-xs text-red-600">{modelUrlError}</p> : null}
                </div>
              </div>

              {/* Style reference is hidden until the n8n flow is verified with a real provider. */}
              <div hidden>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Style Reference URL</label>
                <Input
                  value={form.styleReferenceUrl}
                  onChange={(e) => onFieldChange("styleReferenceUrl", e.target.value)}
                  placeholder="https://... (lighting, composition, mood)"
                />
                {styleUrlError ? <p className="mt-1 text-xs text-red-600">{styleUrlError}</p> : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  Optional. Public HTTPS link straight to an image — not a Google Drive preview link.
                </p>
              </div>
            </FormSection>

            <FormSection id="gen-sec-output" title="Output" open={sections.output} onToggle={() => toggleSection("output")}>
              <div>
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Output Type *</span>
                <div role="radiogroup" aria-label="Output Type" className="grid grid-cols-3 gap-2">
                  {OUTPUT_TYPE_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      title={option.available ? undefined : "Coming soon — the workflow currently always creates images and a video"}
                      className={cn(
                        "flex h-10 items-center justify-center gap-2 rounded-md border text-sm transition-colors",
                        !option.available
                          ? "cursor-not-allowed border-border text-muted-foreground/60"
                          : form.outputType === option.value
                            ? "cursor-pointer border-primary bg-primary/10 font-medium text-foreground"
                            : "cursor-pointer border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <input
                        type="radio"
                        name="output_type"
                        value={option.value}
                        checked={form.outputType === option.value}
                        disabled={!option.available}
                        onChange={() => onFieldChange("outputType", option.value)}
                        className="accent-primary"
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="gen-image-count" className="mb-1 block text-xs font-medium text-muted-foreground">Image Count *</label>
                  <Select id="gen-image-count" value={form.imageCount} onChange={(e) => onFieldChange("imageCount", e.target.value)}>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                    <option value="6">6</option>
                    <option value="8">8</option>
                    <option value="10">10</option>
                  </Select>
                </div>

                <div>
                  <label htmlFor="gen-video-seconds" className="mb-1 block text-xs font-medium text-muted-foreground">Video Seconds *</label>
                  <Select id="gen-video-seconds" value={form.videoSeconds} onChange={(e) => onFieldChange("videoSeconds", e.target.value)}>
                    <option value="5">5</option>
                    <option value="8">8</option>
                    <option value="10">10</option>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="gen-aspect-ratio" className="mb-1 block text-xs font-medium text-muted-foreground">Aspect Ratio *</label>
                  <Select id="gen-aspect-ratio" value={form.aspectRatio} onChange={(e) => onFieldChange("aspectRatio", e.target.value)}>
                    <option value="9:16">9:16</option>
                    <option value="1:1">1:1</option>
                    <option value="16:9">16:9</option>
                  </Select>
                </div>
                <div>
                  <label htmlFor="gen-video-res" className="mb-1 block text-xs font-medium text-muted-foreground">Video Resolution *</label>
                  <Select id="gen-video-res" value={form.videoResolution} onChange={(e) => onFieldChange("videoResolution", e.target.value)}>
                    <option value="480p">480p</option>
                    <option value="720p">720p</option>
                  </Select>
                </div>
              </div>
            </FormSection>
          </div>
        ) : null}

        {displayItem && displayItem.itemType === "FOLDER" ? (
          <div className={cn(selectedItem && "border-t border-border pt-4")}>
            <div className="flex items-center gap-3 rounded-tile border border-border bg-brand-cream/50 p-4">
              <FolderGlyph className="h-10 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium [overflow-wrap:anywhere]">{displayItem.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">Folder</div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Info label="Files" value={stats ? String(stats.files) : "…"} />
              <Info label="Subfolders" value={stats ? String(stats.subfolders) : "…"} />
              <Info label="Total size" value={stats ? formatBytes(stats.totalBytes) : "…"} />
              <Info label="Modified" value={formatDate(displayItem.modifiedTime)} />
            </div>
            <Button className="mt-4 w-full" onClick={() => onOpenFolder(displayItem)}>
              <FolderOpen className="h-4 w-4" />
              Open folder
            </Button>
            <p className="mt-2 text-center text-xs text-muted-foreground">Tip: click a folder once to open it</p>
          </div>
        ) : null}

        {displayItem && displayItem.itemType !== "FOLDER" ? (
          <div className={cn(selectedItem && "border-t border-border pt-4")}>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <File className="h-4 w-4" />
              File Metadata
            </div>
            <div className="relative mb-4 aspect-video overflow-hidden rounded-md bg-secondary">
              {showThumb && displayItem.thumbnailUrl ? (
                <Image
                  src={displayItem.thumbnailUrl}
                  alt=""
                  fill
                  sizes="560px"
                  className="object-cover"
                  unoptimized={skipImageOptimizer(displayItem.thumbnailUrl)}
                  referrerPolicy="no-referrer"
                  onError={() => setBrokenThumb(displayItem.thumbnailUrl)}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2">
                  <FileKindIcon item={displayItem} className="h-10 w-10" />
                  <FileExtensionBadge item={displayItem} />
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <div className="text-base font-semibold">{displayItem.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">{displayItem.mimeType}</div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Info label="Size" value={formatBytes(displayItem.sizeBytes)} />
                <Info label="Type" value={fileKindLabel(displayItem)} />
                <Info label="Drive modified" value={formatDate(displayItem.modifiedTime)} />
                <Info label="Synced" value={formatDate(displayItem.syncedAt)} />
              </div>
              <div className="grid grid-cols-1 gap-2">
                <Button
                  variant="outline"
                  disabled={!displayItem.webViewLink}
                  onClick={() => {
                    if (displayItem.webViewLink) {
                      window.open(displayItem.webViewLink, "_blank", "noopener,noreferrer");
                    }
                  }}
                >
                  <Link className="h-4 w-4" />
                  View in Drive
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* U13 — state the cost before the user commits it; pinned so Generate is always visible. */}
      {selectedItem ? (
        <div className="space-y-3 border-t border-border px-5 py-4">
          {submitNotice ? (
            <div role="status" className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <span
                className="mt-0.5 shrink-0"
                title="The workflow runs in the background — don't submit again unless you're sure the previous run failed."
              >
                <InfoIcon className="h-3.5 w-3.5" />
              </span>
              <span className="flex-1">{submitNotice}</span>
              <button
                type="button"
                aria-label="Dismiss notification"
                className="shrink-0 text-emerald-700 transition-colors hover:text-emerald-900"
                onClick={onDismissNotice}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
          {summaryChips ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Will create</span>
              {summaryChips.map((chip) => (
                <span
                  key={chip}
                  className="rounded-full border border-brand-line bg-brand-cream/60 px-2 py-0.5 text-[11px] font-medium text-foreground"
                >
                  {chip}
                </span>
              ))}
            </div>
          ) : null}
          <Button
            className="w-full"
            disabled={submitting || Boolean(formError)}
            title={formError ?? undefined}
            onClick={onSubmit}
          >
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {submitting ? "Submitting..." : "Generate Media"}
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
