"use client";
/**
 * One EventSource (ported from liveops admin-console hooks/use-live.ts) to the console's own /api/watch/stream, folded into LiveState by lib/live-store.ts.
 *
 * EventSource reconnects by itself while the stream breaks (near-watch sends `retry: 3000`). When the route
 * answers with an error instead of a stream (near-watch down, wrong key, console misconfigured), the browser
 * gives up for good; this hook then reads the reason from /api/watch/snapshot (JSON) and tries again with back-off.
 * Every (re)connect starts with `hello`, which replaces the data.
 *
 * `subscribe(fn)` hands each event to animations (the flow canvas) as it arrives; it is not state.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { applyEvent, emptyState, type LiveState } from "../lib/live-store.ts";
import { EVENT_NAMES } from "../lib/types.ts";

export type Conn = { state: "connecting" | "open" | "retrying" | "down"; since: number; lastEventAt: number | null; reason: string | null; attempts: number };

type Action = { name: string; data: unknown };
export type LiveListener = (name: string, data: unknown) => void;

export type LiveOptions = { streamPath: string; probePath: string; maxBackoffMs: number };

export const LIVE_DEFAULTS: LiveOptions = { streamPath: "/api/watch/stream", probePath: "/api/watch/snapshot", maxBackoffMs: 30_000 };

async function probeReason(path: string): Promise<string> {
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (res.ok) return "the stream closed; the console reaches near-watch, retrying";
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error : `console answered HTTP ${res.status}`;
  } catch {
    return "the console server is not answering";
  }
}

export function useLive(opts: LiveOptions = LIVE_DEFAULTS): { live: LiveState; conn: Conn; subscribe: (fn: LiveListener) => () => void } {
  const [live, dispatch] = useReducer((s: LiveState, a: Action) => applyEvent(s, a.name, a.data), undefined, emptyState);
  const [conn, setConn] = useState<Conn>({ state: "connecting", since: Date.now(), lastEventAt: null, reason: null, attempts: 0 });
  const listeners = useRef(new Set<LiveListener>());

  const subscribe = useCallback((fn: LiveListener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let attempts = 0;

    const open = (): void => {
      if (stopped) return;
      es = new EventSource(opts.streamPath);
      setConn((c) => ({ ...c, state: attempts === 0 ? "connecting" : "retrying", since: Date.now() }));
      es.onopen = () => {
        attempts = 0;
        setConn((c) => ({ ...c, state: "open", since: Date.now(), reason: null, attempts: 0 }));
      };
      for (const name of EVENT_NAMES) {
        es.addEventListener(name, (ev) => {
          let data: unknown;
          try {
            data = JSON.parse((ev as MessageEvent<string>).data);
          } catch {
            data = undefined;
          }
          dispatch({ name, data });
          for (const fn of listeners.current) fn(name, data);
          setConn((c) => ({ ...c, lastEventAt: Date.now() }));
        });
      }
      es.onerror = () => {
        if (!es || stopped) return;
        if (es.readyState === EventSource.CONNECTING) {
          setConn((c) => ({ ...c, state: "retrying", since: Date.now() }));
          return;
        }
        // CLOSED: the browser will not retry by itself.
        es.close();
        attempts += 1;
        const delay = Math.min(opts.maxBackoffMs, 1000 * 2 ** Math.min(attempts - 1, 5));
        void probeReason(opts.probePath).then((reason) => {
          if (!stopped) setConn((c) => ({ ...c, state: "down", since: Date.now(), reason, attempts }));
        });
        timer = setTimeout(open, delay);
      };
    };
    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [opts.streamPath, opts.probePath, opts.maxBackoffMs]);

  return { live, conn, subscribe };
}

/** Re-renders every `ms` so ages ("closed 3 s ago") stay current. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
