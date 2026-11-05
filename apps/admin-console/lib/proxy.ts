/**
 * The console's only way to near-watch (ported from liveops admin-console lib/proxy.ts; /api/lw renamed /api/watch).
 * Runs on the server (Next.js route handlers); the browser calls /api/watch/... and never learns near-watch's
 * address or the admin key.
 *
 *   proxyGet     GET /api/watch/<path>  ->  GET <near-watch>/api/<path>   (allowlisted paths and query keys)
 *   proxyStream  GET /api/watch/stream  ->  GET <near-watch>/stream       (Server-Sent Events, passed through as bytes)
 *
 * Only GET is proxied. /ingest and /healthz are never reachable through the console.
 * Upstream headers are not forwarded (only the content type); upstream failures are reported without the URL.
 */
import type { ConsoleConfig } from "./config.ts";

/** near-watch read routes (services/near-watch/src/server.ts), by first path segment, with their segment count. */
export const ALLOWED_ROUTES: Readonly<Record<string, 1 | 2>> = {
  snapshot: 1,
  txs: 1,
  feeds: 1,
  claims: 1,
  reconcile: 1,
  metrics: 1,
  seller: 1,
  tx: 2,
  trace: 2,
  // Paid jobs (architecture-adminui-jobs.md ARCH-210): /api/jobs and /api/job/<jobId>.
  jobs: 1,
  job: 2,
};

/** Query keys near-watch reads; anything else is refused rather than silently dropped. */
export const ALLOWED_QUERY_KEYS: ReadonlySet<string> = new Set(["limit", "network", "state"]);

/** A path parameter: a base58 tx hash (case-sensitive, passed as given) or an invoice id. */
const SEGMENT = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_QUERY_VALUE = 64;

export type Upstream = { ok: true; url: URL } | { ok: false; status: number; error: string };

export function upstreamFor(base: URL, segments: readonly string[], search: URLSearchParams): Upstream {
  const [first, ...rest] = segments;
  const arity = first === undefined ? undefined : ALLOWED_ROUTES[first];
  if (arity === undefined || !Object.hasOwn(ALLOWED_ROUTES, first as string)) return { ok: false, status: 404, error: "not a near-watch read route" };
  if (segments.length !== arity) return { ok: false, status: 404, error: `/${first} takes ${arity === 1 ? "no" : "one"} path parameter` };
  for (const s of segments) {
    if (!SEGMENT.test(s) || s === "." || s === "..") return { ok: false, status: 400, error: "path segment not allowed" };
  }
  const query = new URLSearchParams();
  for (const key of new Set(search.keys())) {
    if (!ALLOWED_QUERY_KEYS.has(key)) return { ok: false, status: 400, error: `query parameter "${key}" is not allowed` };
    const values = search.getAll(key);
    if (values.length !== 1) return { ok: false, status: 400, error: `query parameter "${key}" given more than once` };
    if (values[0].length > MAX_QUERY_VALUE) return { ok: false, status: 400, error: `query parameter "${key}" is too long` };
    query.set(key, values[0]);
  }
  const url = new URL(`api/${[first, ...rest].map(encodeURIComponent).join("/")}`, base);
  url.search = query.toString();
  return { ok: true, url };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** What the console says when near-watch answers with an error status (its body is passed on only for 4xx it owns). */
function upstreamRefusal(status: number): Response {
  if (status === 401) return json(502, { error: "near-watch refused the admin key" });
  return json(502, { error: `near-watch answered HTTP ${status}` });
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export async function proxyGet(req: Request, segments: readonly string[], cfg: ConsoleConfig, fetchImpl: FetchLike = fetch): Promise<Response> {
  if (req.method !== "GET") return json(405, { error: "only GET is allowed" });
  const target = upstreamFor(cfg.nearWatchUrl, segments, new URL(req.url).searchParams);
  if (!target.ok) return json(target.status, { error: target.error });
  let res: Response;
  try {
    res = await fetchImpl(target.url, {
      method: "GET",
      headers: { "x-admin-key": cfg.adminKey, accept: "application/json" },
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(cfg.upstreamTimeoutMs)]),
      redirect: "error",
    });
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError";
    return json(timedOut ? 504 : 502, { error: timedOut ? `near-watch did not answer within ${cfg.upstreamTimeoutMs} ms` : "near-watch unreachable" });
  }
  // 404 and 400 are near-watch's own answers about the request (e.g. a hash not seen yet): pass them on.
  if (res.status === 401 || res.status >= 500) {
    await res.body?.cancel();
    return upstreamRefusal(res.status);
  }
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function proxyStream(req: Request, cfg: ConsoleConfig, fetchImpl: FetchLike = fetch): Promise<Response> {
  if (req.method !== "GET") return json(405, { error: "only GET is allowed" });
  const connect = new AbortController();
  const timer = setTimeout(() => connect.abort(new DOMException("connect timeout", "TimeoutError")), cfg.connectTimeoutMs);
  let res: Response;
  try {
    // The browser leaving (req.signal) closes the upstream connection too, so near-watch frees its stream slot.
    res = await fetchImpl(new URL("stream", cfg.nearWatchUrl), {
      method: "GET",
      headers: { "x-admin-key": cfg.adminKey, accept: "text/event-stream" },
      signal: AbortSignal.any([req.signal, connect.signal]),
      redirect: "error",
    });
  } catch {
    const timedOut = connect.signal.aborted && !req.signal.aborted;
    return json(timedOut ? 504 : 502, { error: timedOut ? `near-watch did not start the stream within ${cfg.connectTimeoutMs} ms` : "near-watch unreachable" });
  } finally {
    clearTimeout(timer);
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    if (res.status === 503) return json(503, { error: "near-watch has no free stream slot" });
    return upstreamRefusal(res.status);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!/^text\/event-stream\b/i.test(type) || !res.body) {
    await res.body?.cancel();
    return json(502, { error: "near-watch did not answer with an event stream" });
  }
  return new Response(res.body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
  });
}
