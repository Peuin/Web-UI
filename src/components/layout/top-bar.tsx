"use client";

import { BookOpen, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DriveItem } from "@/types/domain";

export function TopBar({
  onOpenNav,
  modelLibrary = false,
  selectedItem,
}: {
  onOpenNav: () => void;
  modelLibrary?: boolean;
  selectedItem: DriveItem | null;
}) {
  return (
    <header className="flex min-h-16 min-w-0 items-center justify-between gap-3 border-b border-border bg-card px-4 py-3 md:px-5">
      <Button variant="ghost" size="icon" className="shrink-0 lg:hidden" aria-label="Open menu" onClick={onOpenNav}>
        <Menu className="h-5 w-5" />
      </Button>
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">Creative source media</h2>
        <p className="truncate text-xs text-muted-foreground" title={selectedItem?.name}>
          {modelLibrary ? "Model media in Supabase Storage" : selectedItem ? `${selectedItem.itemType === "FOLDER" ? "Folder" : "File"} selected: ${selectedItem.name}` : "Select a file or folder to generate media"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          title="Open the user guide — English / Tiếng Việt (new tab)"
          onClick={() => window.open("/user-guide.html", "_blank", "noopener,noreferrer")}
        >
          <BookOpen className="h-4 w-4" />
          <span className="hidden sm:inline">User Guide</span>
        </Button>
      </div>
    </header>
  );
}
