"use client";

import { Folder, HardDrive, ImageIcon, Loader2, LogOut, Workflow } from "lucide-react";
import Image from "next/image";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";

export type WorkspaceTab = "browser" | "model" | "jobs" | "final" | "settings";

export function AppSidebar({
  open,
  onClose,
  activeTab,
  onTabChange,
  userEmail,
  signingOut,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  userEmail: string | null;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const nav = [
    { id: "browser" as const, label: "Drive Browser", icon: HardDrive },
    { id: "model" as const, label: "Model", icon: Folder },
    { id: "jobs" as const, label: "Workflow Jobs", icon: Workflow },
    { id: "final" as const, label: "Final Output", icon: ImageIcon },
  ];
  const userLabel = userEmail ?? "Signed in";

  // The drawer should close on Esc like any overlay (U9).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {open ? <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" aria-hidden="true" onClick={onClose} /> : null}
      {/* Off-canvas drawer below lg; fixed column on desktop. */}
      <aside
        aria-label="Workspace navigation"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-screen w-[260px] flex-col border-r border-border bg-brand-cream transition-transform lg:sticky lg:top-0 lg:z-auto lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-16 items-center gap-3 border-b border-border px-5">
          <Image
            src="/brand/baartwork-logo.png"
            alt="Baartwork"
            width={360}
            height={360}
            priority
            className="h-9 w-9 object-contain"
          />
          <div className="min-w-0">
            <div className="truncate font-montserrat text-xs font-medium uppercase tracking-[0.12em]">
              Media Workflow
            </div>
            <div className="truncate text-[11px] text-muted-foreground">Baartwork Studio</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3 py-4">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-10 w-full items-center gap-3 px-3 text-left font-montserrat text-[11px] font-medium uppercase tracking-[0.08em] transition-colors",
                  active
                    ? "bg-card text-foreground shadow-soft before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:bg-brand"
                    : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                )}
                onClick={() => onTabChange(item.id)}
              >
                <Icon className={cn("h-4 w-4", active && "text-brand")} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-ink font-montserrat text-xs font-medium uppercase text-white">
              {userLabel.charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium" title={userLabel}>{userLabel}</div>
              <div className="text-[11px] text-muted-foreground">Signed in</div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 w-full"
            disabled={signingOut}
            onClick={onSignOut}
          >
            {signingOut ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </aside>
    </>
  );
}
