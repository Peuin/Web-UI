"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils/cn";

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Right-hand panel: a grid column on xl+, a slide-over sheet below xl and a
 * bottom sheet on phones. Keeps focus inside while overlaid and closes on Esc.
 */
export function SidePanel({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<Element | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    if (mq.matches) return; // A plain column on desktop — no trap needed.
    previousFocus.current = document.activeElement;
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      (previousFocus.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    if (window.matchMedia("(min-width: 1280px)").matches) return;
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => !el.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/30 xl:hidden" aria-hidden="true" onClick={onClose} />
      {/* Below sm: bottom sheet. sm–xl: right slide-over. xl+: static column. */}
      <div
        ref={panelRef}
        role="complementary"
        onKeyDown={onKeyDown}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 max-h-[78vh] w-full overflow-y-auto rounded-t-2xl bg-card shadow-xl",
          "sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:max-h-none sm:w-full sm:max-w-md sm:rounded-none",
          "xl:static xl:z-auto xl:max-w-none xl:overflow-visible xl:shadow-none",
        )}
      >
        {children}
      </div>
    </>
  );
}
