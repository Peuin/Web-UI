import { File, FileImage, FileText, Film, Folder } from "lucide-react";
import type { DriveItem, DriveItemType } from "@/types/domain";

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
export const GENERATION_PREFS_STORAGE_KEY = "drive.generationPrefs";
export const NARROW_SCREEN_QUERY = "(max-width: 1279px)";

export const typeIcon: Record<DriveItemType, typeof File> = {
  FOLDER: Folder,
  IMAGE: FileImage,
  VIDEO: Film,
  DOCUMENT: FileText,
  OTHER: File,
};

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
