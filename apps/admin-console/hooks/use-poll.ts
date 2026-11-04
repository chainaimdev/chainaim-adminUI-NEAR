"use client";
/**
 * Reads one console REST route (ported from liveops admin-console hooks/use-poll.ts) (/api/watch/...) now and every `everyMs`, while `enabled`. Keeps the last good
 * answer when a refresh fails and reports the failure beside it, so a hiccup never blanks a panel.
 */
import { useEffect, useState } from "react";

export type Poll<T> = { data: T | null; error: string | null; at: number | null; loading: boolean };

export function usePoll<T>(path: string, everyMs: number, enabled = true): Poll<T> {
  const [state, setState] = useState<Poll<T>>({ data: null, error: null, at: null, loading: true });
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(path, { cache: "no-store", signal: ctrl.signal });
        const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
        if (stopped) return;
        if (!res.ok || body === null) {
          const msg = body && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
          setState((s) => ({ ...s, error: msg, loading: false }));
        } else {
          setState({ data: body, error: null, at: Date.now(), loading: false });
        }
      } catch (e) {
        if (stopped || (e as Error).name === "AbortError") return;
        setState((s) => ({ ...s, error: "the console server is not answering", loading: false }));
      }
      if (!stopped) timer = setTimeout(() => void tick(), everyMs);
    };
    void tick();
    return () => {
      stopped = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, everyMs, enabled]);
  return state;
}
