"use client";

import { useEffect, useRef } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

/**
 * Subscribes to postgres_changes on a table (e.g. children of the open folder)
 * and invokes onChange — debounced — when a sync writes rows. Falls back
 * silently to whatever polling the caller already has when Realtime is off.
 */
export function useTableChanges({
  table,
  filter,
  enabled,
  onChange,
  debounceMs = 350,
}: {
  table: "drive_items" | "final_items";
  /** PostgREST filter, e.g. `parent_drive_item_id=eq.abc123` */
  filter: string;
  enabled: boolean;
  onChange: () => void;
  debounceMs?: number;
}) {
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!enabled || !filter) return;
    const supabase = createBrowserSupabaseClient();
    if (!supabase) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel(`folder-watch:${table}:${filter}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter },
        () => {
          clearTimeout(timer);
          timer = setTimeout(() => onChangeRef.current(), debounceMs);
        },
      )
      .subscribe();

    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [table, filter, enabled, debounceMs]);
}
