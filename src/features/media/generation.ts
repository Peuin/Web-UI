export type OutputType = "image" | "video" | "both";

// The n8n contract (BR-19) still always produces images + a video, so only
// "both" is selectable until the workflow honours output_type.
export const OUTPUT_TYPE_OPTIONS: { value: OutputType; label: string; available: boolean }[] = [
  { value: "image", label: "Image", available: false },
  { value: "video", label: "Video", available: false },
  { value: "both", label: "Both", available: true },
];

export type ProductTypeOption = { value: string; label: string; category?: string };

export function formatProductTypeLabel(productType: string): string {
  return productType
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Fallback until baartwork_segformer_profiles loads (or if it cannot be read).
export const DEFAULT_PRODUCT_TYPE_OPTIONS: ProductTypeOption[] = ["cape", "hat", "shawl", "umbrella"].map((value) => ({
  value,
  label: formatProductTypeLabel(value),
}));

/** Reference images must be direct public HTTPS image URLs the provider can fetch. */
export function validateReferenceImageUrl(label: string, value: string | null): string | null {
  if (!value) return null;
  if (value.length > 2048) return `${label} must be at most 2048 characters.`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${label} must be a valid URL.`;
  }
  if (url.protocol !== "https:") return `${label} must be a public HTTPS link.`;
  // Drive direct links (uc?export=view&id=…) from the model library are fine; preview pages are not.
  const isDriveDirectLink = url.hostname === "drive.google.com" && url.pathname === "/uc" && url.searchParams.has("id");
  if (/(^|\.)(drive|docs)\.google\.com$/.test(url.hostname) && !isDriveDirectLink) {
    return `${label} must link directly to an image, not a Google Drive preview.`;
  }
  return null;
}

export type GenerationFormValues = {
  productType: string;
  productDescription: string;
  samplePrompt: string;
  sourceStoragePrefix: string;
  modelReferenceUrl: string;
  styleReferenceUrl: string;
  outputType: OutputType;
  imageCount: string;
  videoSeconds: string;
  aspectRatio: string;
  videoResolution: string;
};

/** Fields remembered between sessions (U13). */
export const REMEMBERED_FORM_FIELDS = [
  "productType",
  "imageCount",
  "videoSeconds",
  "aspectRatio",
  "videoResolution",
] as const satisfies readonly (keyof GenerationFormValues)[];
