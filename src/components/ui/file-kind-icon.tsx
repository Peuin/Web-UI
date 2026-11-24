import { cn } from "@/lib/utils/cn";
import {
  fileExtension,
  fileKindBadgeColor,
  fileKindColor,
  fileKindIcon,
  getFileKind,
  type FileKindSource,
} from "@/lib/utils/drive";

/** File-type icon tinted with the kind's brand color (green sheets, blue docs…). */
export function FileKindIcon({ item, className }: { item: FileKindSource; className?: string }) {
  const kind = getFileKind(item);
  const Icon = fileKindIcon[kind];
  return <Icon className={cn(fileKindColor[kind], className)} />;
}

/** Small uppercase extension tag ("XLSX") tinted with the kind's color. */
export function FileExtensionBadge({ item, className }: { item: FileKindSource; className?: string }) {
  const ext = fileExtension(item.name);
  if (!ext) return null;
  return (
    <span
      className={cn(
        "rounded-sm border px-1 py-px text-[9px] font-semibold leading-tight tracking-wide",
        fileKindBadgeColor[getFileKind(item)],
        className,
      )}
    >
      {ext}
    </span>
  );
}
