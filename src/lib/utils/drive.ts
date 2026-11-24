import {
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Palette,
  Presentation,
} from "lucide-react";
import type { DriveItem } from "@/types/domain";

export type ViewMode = "grid" | "list";
export type FolderCrumb = {
  driveItemId: string | null;
  storagePath?: string | null;
  name: string;
  key?: string;
};
export type FolderMeta = {
  name: string;
  driveItemId: string | null;
  storagePath?: string | null;
};

export const DEFAULT_CONNECTION_ID = "00000000-0000-0000-0000-000000000000";
export const DRIVE_ROOT_FOLDER_ID = "1cMsSZ66rvnFvbf4ZRsV1QcpYeOzp0Inq";
// Generated output root (output_config.folder_id → "02_AI_PROCESSING").
export const FINAL_ROOT_FOLDER_ID = "1fa_BesuUdYOlqRUnV5eVS3p9FZKfqLzh";
export const FINAL_ROOT_FOLDER_NAME = "02_AI_PROCESSING";
// Model reference library on Google Drive (n8n Production_07).
// Google Drive folder "05_MODEL".
export const MODEL_LIBRARY_ROOT_ID = "18K-yWcm-qshgE9_UjQ6s5m64g7Ar43jr";
export const MODEL_LIBRARY_MAX_BYTES = 15 * 1024 * 1024;
// Storage folder mirroring the Drive root (see drive-list-folder DEFAULT_ROOT_PATH)
export const DRIVE_STORAGE_ROOT = "google-drive/01_New_Product_Raw";
// Model tab browses Supabase Storage directly — no Drive/edge-function calls.
export const MODEL_STORAGE_BUCKET = "BAartworkShopify";
export const MODEL_STORAGE_ROOT = "google-drive/Model";

export const PREVIEW_PANEL_STORAGE_KEY = "drive.previewPanel";
export const PANEL_WIDTH_STORAGE_KEY = "drive.panelWidth";
export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 560;
export const PANEL_DEFAULT_WIDTH = 360;
export const GENERATION_PREFS_STORAGE_KEY = "drive.generationPrefs";
export const NARROW_SCREEN_QUERY = "(max-width: 1279px)";

// ─── File kinds (MIME type first, extension fallback) ─────────────────────────
// The DB item_type only distinguishes FOLDER | IMAGE | OTHER, so Office files,
// PDFs, archives, etc. need finer detection for icons and thumbnail rules.

export type FileKind =
  | "image"
  | "video"
  | "spreadsheet"
  | "document"
  | "presentation"
  | "pdf"
  | "archive"
  | "audio"
  | "design"
  | "other";

/** Anything with a name (and optional mime type) can be classified. */
export type FileKindSource = { name: string; mimeType?: string | null };

const KIND_BY_MIME: Record<string, FileKind> = {
  // Design MIMEs first: image/vnd.adobe.photoshop also matches image/*.
  "image/vnd.adobe.photoshop": "design",
  "application/postscript": "design",
  "application/illustrator": "design",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "application/vnd.ms-excel": "spreadsheet",
  "application/vnd.google-apps.spreadsheet": "spreadsheet",
  "text/csv": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/msword": "document",
  "application/vnd.google-apps.document": "document",
  "text/plain": "document",
  "application/rtf": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "presentation",
  "application/vnd.ms-powerpoint": "presentation",
  "application/vnd.google-apps.presentation": "presentation",
  "application/pdf": "pdf",
  "application/zip": "archive",
  "application/x-rar-compressed": "archive",
  "application/x-7z-compressed": "archive",
};

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  xlsx: "spreadsheet", xls: "spreadsheet", csv: "spreadsheet",
  docx: "document", doc: "document", txt: "document", rtf: "document",
  pptx: "presentation", ppt: "presentation",
  pdf: "pdf",
  zip: "archive", rar: "archive", "7z": "archive",
  psd: "design", ai: "design", eps: "design",
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
  svg: "image", bmp: "image", tif: "image", tiff: "image", heic: "image",
  heif: "image", avif: "image", ico: "image",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video",
  m4v: "video", mpg: "video", mpeg: "video", "3gp": "video",
  mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", m4a: "audio",
  aac: "audio",
};

/** Uppercase extension for the badge ("XLSX"), or null when the name has none. */
export function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toUpperCase();
}

function kindFromMime(mimeType: string | null | undefined): FileKind | null {
  if (!mimeType) return null;
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  const exact = KIND_BY_MIME[mime];
  if (exact) return exact;
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  return null;
}

/** File kind from mimeType first, then the file extension in `name`. */
export function getFileKind(item: FileKindSource): FileKind {
  const fromMime = kindFromMime(item.mimeType);
  if (fromMime) return fromMime;
  const ext = fileExtension(item.name)?.toLowerCase();
  return (ext && KIND_BY_EXTENSION[ext]) || "other";
}

export const fileKindIcon: Record<FileKind, typeof File> = {
  image: FileImage,
  video: FileVideo,
  spreadsheet: FileSpreadsheet,
  document: FileText,
  presentation: Presentation,
  pdf: FileType,
  archive: FileArchive,
  audio: FileAudio,
  design: Palette,
  other: File,
};

// Brand-adjacent colors; every other kind stays muted.
export const fileKindColor: Record<FileKind, string> = {
  image: "text-muted-foreground",
  video: "text-muted-foreground",
  spreadsheet: "text-emerald-600",
  document: "text-blue-600",
  presentation: "text-orange-500",
  pdf: "text-red-600",
  archive: "text-muted-foreground",
  audio: "text-muted-foreground",
  design: "text-muted-foreground",
  other: "text-muted-foreground",
};

export const fileKindBadgeColor: Record<FileKind, string> = {
  image: "border-border bg-secondary text-muted-foreground",
  video: "border-border bg-secondary text-muted-foreground",
  spreadsheet: "border-emerald-200 bg-emerald-50 text-emerald-700",
  document: "border-blue-200 bg-blue-50 text-blue-700",
  presentation: "border-orange-200 bg-orange-50 text-orange-700",
  pdf: "border-red-200 bg-red-50 text-red-700",
  archive: "border-border bg-secondary text-muted-foreground",
  audio: "border-border bg-secondary text-muted-foreground",
  design: "border-border bg-secondary text-muted-foreground",
  other: "border-border bg-secondary text-muted-foreground",
};

/** Friendly "Type" label, e.g. "Excel spreadsheet" instead of "DOCUMENT". */
export function fileKindLabel(item: FileKindSource): string {
  const kind = getFileKind(item);
  const mime = item.mimeType ?? "";
  const ext = fileExtension(item.name)?.toLowerCase();
  switch (kind) {
    case "spreadsheet":
      if (ext === "csv" || mime === "text/csv") return "CSV file";
      if (mime === "application/vnd.google-apps.spreadsheet") return "Google Sheets";
      if (ext === "xlsx" || ext === "xls" || mime) return "Excel spreadsheet";
      return "Spreadsheet";
    case "document":
      if (ext === "txt" || mime === "text/plain") return "Text file";
      if (ext === "rtf" || mime === "application/rtf") return "Rich text document";
      if (mime === "application/vnd.google-apps.document") return "Google Doc";
      if (ext === "docx" || ext === "doc" || mime) return "Word document";
      return "Document";
    case "presentation":
      if (mime === "application/vnd.google-apps.presentation") return "Google Slides";
      if (ext === "pptx" || ext === "ppt" || mime) return "PowerPoint presentation";
      return "Presentation";
    case "pdf": return "PDF document";
    case "image": return "Image";
    case "video": return "Video";
    case "audio": return "Audio file";
    case "archive": return "Archive";
    case "design": return "Design file";
    default: return "File";
  }
}

export function isHiddenDrivePlaceholder(item: { name: string }): boolean {
  return item.name === ".emptyFolderPlaceholder";
}

export function stripMarkdownLink(value: string | null): string | null {
  if (!value) return null;
  // Convert [label](url) to url
  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/;
  const match = value.match(markdownLinkRegex);
  if (match) {
    return match[2]; // Return the URL part
  }
  return value;
}

export function isValidStoragePrefix(value: string): boolean {
  // Reject if it contains URL patterns or corruption markers
  const invalidPatterns = [
    "](http",
    "http://",
    "https://",
    "?token=",
    "selected_items",
    "parameters",
  ];
  return !invalidPatterns.some((pattern) => value.includes(pattern));
}

export function getFolderKeyFromItem(item: DriveItem): string {
  return item.connectionId === "storage" ? item.driveItemId ?? item.id : item.driveItemId ?? item.id;
}

export function getFolderKey(folderDriveId: string | null = null, storagePath: string | null = null): string {
  return storagePath ?? folderDriveId ?? "root";
}

/** Touch screens have no double-click; a tap on a folder opens it directly. */
export function isTouchOnly() {
  return typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;
}

// Drive thumbnails are already resized and may require the browser's Google session.
// Next's server-side image optimizer does not forward that session.
export function isGoogleThumbnail(src: string): boolean {
  try {
    const { hostname } = new URL(src);
    return hostname === "drive.google.com" || hostname === "googleusercontent.com" ||
      hostname.endsWith(".googleusercontent.com");
  } catch {
    return false;
  }
}

// Supabase signed URLs carry a changing ?token= that Next's optimizer cannot
// cache — serve the (already resized s400) image directly instead.
export function isSignedStorageUrl(src: string): boolean {
  try {
    const { pathname, hostname } = new URL(src);
    return (hostname.endsWith(".supabase.co") || hostname.endsWith(".supabase.in")) &&
      pathname.includes("/storage/v1/object/sign/");
  } catch {
    return false;
  }
}

/** next/image `unoptimized`: true whenever the URL already serves a thumbnail. */
export function skipImageOptimizer(src: string): boolean {
  return isGoogleThumbnail(src) || isSignedStorageUrl(src);
}

// Run folders look like "11-10 scarf_2026-11-14_eaeac8c4-468f-4aff-8071-8a1d57cabe58".
const RUN_FOLDER_SUFFIX =
  /_(\d{4}-\d{2}-\d{2})_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Friendly label for run folders: drops the UUID, surfaces the date as a badge. */
export function friendlyItemName(name: string): { label: string; date: string | null } {
  const match = name.match(RUN_FOLDER_SUFFIX);
  if (!match || match.index === undefined) return { label: name, date: null };
  return { label: name.slice(0, match.index) || name, date: match[1] };
}
