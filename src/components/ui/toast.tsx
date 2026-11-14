"use client";

import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";

export type ToastTone = "success" | "error" | "info";

type ToastItem = { id: number; tone: ToastTone; text: string };

type ToastContextValue = {
  push: (tone: ToastTone, text: string) => void;
  success: (text: string) => void;
  error: (text: string) => void;
  info: (text: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_AUTO_DISMISS_MS = 4000;

const toneStyle: Record<ToastTone, { icon: typeof Info; className: string }> = {
  success: { icon: CircleCheck, className: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  error: { icon: CircleAlert, className: "border-red-200 bg-red-50 text-red-700" },
  info: { icon: Info, className: "border-border bg-card text-foreground" },
};

/** One toast channel for the whole app: aria-live, auto-dismiss, close button. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((tone: ToastTone, text: string) => {
    const id = ++nextId.current;
    setToasts((current) => [...current.slice(-3), { id, tone, text }]);
    window.setTimeout(() => dismiss(id), TOAST_AUTO_DISMISS_MS);
  }, [dismiss]);

  const value = useMemo<ToastContextValue>(() => ({
    push,
    success: (text) => push("success", text),
    error: (text) => push("error", text),
    info: (text) => push("info", text),
  }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        role="status"
        className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((toast) => {
          const style = toneStyle[toast.tone];
          const Icon = style.icon;
          return (
            <div
              key={toast.id}
              className={cn(
                "pointer-events-auto flex items-start gap-2 rounded-md border p-3 text-sm shadow-lg",
                style.className,
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{toast.text}</span>
              <button
                type="button"
                aria-label="Dismiss notification"
                className="shrink-0 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => dismiss(toast.id)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  // Components outside the provider (shouldn't happen) get a no-op channel.
  return context ?? { push: () => {}, success: () => {}, error: () => {}, info: () => {} };
}
