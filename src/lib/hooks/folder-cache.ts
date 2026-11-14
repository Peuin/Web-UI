import type { DriveItem } from "@/types/domain";

/**
 * Client-side folder listing cache (stale-while-revalidate). Reopening a
 * folder renders the snapshot instantly while a background fetch refreshes it.
 */
export type FolderSnapshot = {
  items: DriveItem[];
  folder: DriveItem | null;
  at: number;
};

const SNAPSHOT_TTL_MS = 10 * 60_000;
const store = new Map<string, FolderSnapshot>();

export function readFolderSnapshot(key: string): FolderSnapshot | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SNAPSHOT_TTL_MS) {
    store.delete(key);
    return null;
  }
  return hit;
}

export function writeFolderSnapshot(key: string, items: DriveItem[], folder: DriveItem | null) {
  store.set(key, { items, folder, at: Date.now() });
}

export function clearFolderSnapshots() {
  store.clear();
}
