"use client";

import {
  File,
  FolderOpen,
  Link,
  Loader2,
  Play,
  Sparkles,
  X,
} from "lucide-react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
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
import { isValidStoragePrefix, skipImageOptimizer } from "@/lib/utils/drive";
import { formatBytes, formatDate } from "@/lib/utils/format";
import type { DriveItem } from "@/types/domain";

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-medium">{value}</div>
    </div>
  );
}

export function PreviewDrawer({
  onClose,
  item,
  selectedItem,
  form,
  onFieldChange,
  productTypeOptions,
  submitNotice,
  onOpenModelPicker,
  submitting,
  onSubmit,
  onOpenFolder,
}: {
  item: DriveItem | null;
  selectedItem: DriveItem | null;
  form: GenerationFormValues;
  onFieldChange: (field: keyof GenerationFormValues, value: string) => void;
  productTypeOptions: ProductTypeOption[];
  submitNotice: string | null;
  onOpenModelPicker: () => void;
  submitting: boolean;
  onSubmit: () => void;
  onOpenFolder: (folder: DriveItem) => void;
  onClose: () => void;
}) {
  if (!selectedItem && !item) {
    return (
      <aside className="bg-card p-5">
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

  const displayItem = item ?? selectedItem;

  // U13 — validate inline, before the user ever presses Generate Media.
  const modelUrlError = validateReferenceImageUrl("Model Reference URL", form.modelReferenceUrl.trim() || null);
  const styleUrlError = validateReferenceImageUrl("Style Reference URL", form.styleReferenceUrl.trim() || null);
  const prefixError = form.sourceStoragePrefix.trim() && !isValidStoragePrefix(form.sourceStoragePrefix)
    ? "This looks like a URL, not a storage path — expected e.g. google-drive/01_New_Product_Raw/FOLDER."
    : null;
  const formError = modelUrlError ?? styleUrlError ?? prefixError;
  const imageCount = parseInt(form.imageCount, 10) || 0;
  const videoSeconds = parseInt(form.videoSeconds, 10) || 0;
  const submitSummary = selectedItem
    ? `Will create ${imageCount} images + 1 video ${videoSeconds}s, ${form.aspectRatio}, ${form.videoResolution} for "${selectedItem.name}".`
    : null;

  return (
    <aside className="overflow-auto bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
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

      {/* Selected Item Info */}
      {selectedItem ? (
        <div className="mb-4 rounded-md border border-border p-3">
          <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Selected Item</div>
          <div className="font-medium [overflow-wrap:anywhere]">{selectedItem.name}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {selectedItem.itemType === "FOLDER" ? "Folder" : selectedItem.itemType} · {selectedItem.itemType === "FOLDER" ? "Contains all descendant files" : "Single file"}
          </div>
        </div>
      ) : null}

      {/* Generation Form */}
      {selectedItem ? (
        <div className="space-y-4">
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4" />
              Media Generation Parameters
            </div>

            <div className="space-y-3">
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
                <Textarea
                  id="gen-product-desc"
                  placeholder="Optional product description..."
                  value={form.productDescription}
                  onChange={(e) => onFieldChange("productDescription", e.target.value)}
                  rows={2}
                />
              </div>

              <div>
                <label htmlFor="gen-sample-prompt" className="mb-1 block text-xs font-medium text-muted-foreground">Input Sample Prompt</label>
                <Textarea
                  id="gen-sample-prompt"
                  placeholder="Optional sample prompt..."
                  value={form.samplePrompt}
                  onChange={(e) => onFieldChange("samplePrompt", e.target.value)}
                  rows={2}
                />
              </div>

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
                <p className="mt-1 text-xs text-muted-foreground">
                  Image-only and Video-only are coming soon. Every run currently creates both images and a video.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="gen-image-count" className="mb-1 block text-xs font-medium text-muted-foreground">Image Count *</label>
                  <Select id="gen-image-count" value={form.imageCount} onChange={(e) => onFieldChange("imageCount", e.target.value)}>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
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
            </div>
          </div>

          {/* U13 — state the cost before the user commits it. */}
          {submitSummary ? (
            <p className="rounded-md border border-border bg-brand-cream/60 p-2.5 text-xs text-muted-foreground">
              {submitSummary}
            </p>
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
          {submitNotice ? (
            <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
              {submitNotice}
            </div>
          ) : null}
        </div>
      ) : null}

      {displayItem && displayItem.itemType === "FOLDER" ? (
        <div className={cn("pt-4", selectedItem && "border-t border-border")}>
          <div className="flex aspect-video items-center justify-center rounded-tile border border-border bg-brand-cream/50">
            <FolderGlyph className="h-16" />
          </div>
          <div className="mt-4 text-sm font-medium">{displayItem.name}</div>
          <div className="mt-3 space-y-3">
            <Info label="Modified" value={formatDate(displayItem.modifiedTime)} />
            <Info label="Sync" value={displayItem.syncStatus} />
          </div>
          <Button className="mt-4 w-full" onClick={() => onOpenFolder(displayItem)}>
            <FolderOpen className="h-4 w-4" />
            Open folder
          </Button>
          <p className="mt-2 text-center text-xs text-muted-foreground">Tip: click a folder once to open it</p>
        </div>
      ) : null}

      {displayItem && displayItem.itemType !== "FOLDER" ? (
        <>
          <div className={cn("pt-4", selectedItem && "border-t border-border")}>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <File className="h-4 w-4" />
              File Metadata
            </div>
            <div className="relative mb-4 aspect-video overflow-hidden rounded-md bg-secondary">
              {displayItem.thumbnailUrl ? (
                <Image src={displayItem.thumbnailUrl} alt="" fill sizes="360px" className="object-cover" unoptimized={skipImageOptimizer(displayItem.thumbnailUrl)} referrerPolicy="no-referrer" />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <File className="h-10 w-10 text-muted-foreground" />
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
                <Info label="Type" value={displayItem.itemType} />
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
        </>
      ) : null}
    </aside>
  );
}
