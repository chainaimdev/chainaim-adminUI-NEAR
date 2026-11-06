/**
 * HTTP surface (ported from liveops ledger-watch src/server.ts: same routes, keys and SSE names), bound to --bind:
 *   GET /healthz             no key; per-network feed state only, nothing secret
 *   GET /api/snapshot        everything a console needs to draw its first frame
 *   GET /api/txs?limit=&network=
 *   GET /api/tx/<hash>?network=   the row plus every road that delivered it
 *   GET /api/feeds           feed adapters per network: selected, available (or why not), live state;
 *                            provider names only, never URLs
 *   GET /stream              Server-Sent Events: hello (= snapshot) then live events
 * Every transaction entry sent out (snapshot, /api/txs, /api/tx, SSE tx) carries
 * `network` and `links {tx, account, destination}` to the block explorer of its
 * network (src/links.ts); the stored row is unchanged.
 * Phase 2 (live ops, when started with it):
 *   GET /api/claims?limit=&network=     paywall claims, newest first
 *   GET /api/reconcile?limit=&state=    reconcile rows, most recently changed first, plus counts
 *   GET /api/metrics                    rolling metrics (src/metrics.ts)
 *   GET /api/trace/<invoiceId>          every step, claim, ledger payment and reconcile state of one call
 *   POST /ingest/claim                  one payment_settled line, or a list of up to 100
 *   POST /ingest/trace                  one rig trace step, or a list of up to 100
 * Paid jobs (architecture-adminui-jobs.md ARCH-206..208; src/jobs.ts):
 *   POST /ingest/job                    one job event (job_quoted / job_released / job_expired), or a list of up to 100
 *   GET /api/jobs?limit=&network=&state=   jobs newest first, counts per state, lost compute
 *   GET /api/job/<jobId>                one job: steps, breakdown, linked claim, transfer and reconcile state
 *   The snapshot carries `jobs` only once a job exists.
 *   NEAR AI model attestation (PLAN-adminui-nearai-attestation.md ARCH-501..503): job_attested comes in on /ingest/job too;
 *   a job's view carries `attestation` and the summary `attestation` counts only once one is stored.
 * Seller Wallet (when started with it): GET /api/seller (src/seller.ts) and `seller` in the snapshot.
 * Every /api and /stream call needs the admin key, sent as
 * `x-admin-key: <key>` or `authorization: Bearer <key>`; the console's server
 * side adds it, so the key never reaches a browser. /ingest takes only the
 * ingest key (`x-ingest-key` or Bearer), which must differ from the admin key:
 * a sender can add records but never read them. /ingest is off (404) when no
 * ingest key is configured.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Row } from "./decode.ts";
import type { Bus, EventName, TxEvent } from "./events.ts";
import type { Links } from "./links.ts";
import type { IngestResult, LiveOps } from "./liveops.ts";
import type { Roads } from "./roads.ts";
import type { SellerBook } from "./seller.ts";
import { JOB_STATES } from "./jobs.ts";
import { RECON_STATES, type JobState, type ReconState, type Store } from "./store.ts";
import type { WatchEntry } from "./watchlist.ts";
import { isNearHash } from "../../../packages/chain-core/src/near.ts";

export type ServerOptions = {
  adminKey: string;
  networks: string[];
  watchlist: WatchEntry[];
  sseReplay: number;
  sseHeartbeatSec: number;
  sseMaxClients: number;
  version: string;
  startedAt: number;
  /** The key /ingest takes; null or absent turns /ingest off. */
  ingestKey?: string | null;
  /** Largest /ingest body, in bytes. */
  ingestMaxBytes?: number;
  /** Explorer links added to every transaction entry sent out; absent = no links. */
  links?: Links;
  /** The /api/feeds report; absent = 404. */
  feeds?: () => unknown;
  /** The token near-watch counts (contract, symbol, decimals), so a console can format base units from the first frame. */
  token?: { contract: string; symbol: string; decimals: number };
};

/** Most records in one /ingest body. */
export const INGEST_MAX_ITEMS = 100;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The request body as text, refused once it passes `max` bytes. */
function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      reject(new HttpError(413, `body over ${max} bytes`));
      req.resume();
      return;
    }
    const parts: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (d: Buffer) => {
      if (failed) return;
      size += d.length;
      if (size > max) {
        failed = true;
        reject(new HttpError(413, `body over ${max} bytes`));
        return;
      }
      parts.push(d);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(parts).toString("utf8"));
    });
    req.on("error", (e) => {
      if (!failed) reject(e);
    });
  });
}

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

export function keyMatches(expected: string, req: IncomingMessage, headerName = "x-admin-key"): boolean {
  const header = req.headers[headerName];
  const auth = req.headers.authorization;
  const given = typeof header === "string" ? header : typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // Hash both sides so the comparison takes the same time whatever the lengths.
  return given !== "" && timingSafeEqual(digest(given), digest(expected));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export class WatchServer {
  readonly server: Server;
  private clients = new Set<ServerResponse>();
  private eventId = 0;

  private readonly opts: ServerOptions;
  private readonly store: Store;
  private readonly bus: Bus;
  private readonly roads: Roads;
  private readonly ops: LiveOps | null;
  private readonly seller: SellerBook | null;

  constructor(opts: ServerOptions, store: Store, bus: Bus, roads: Roads, ops: LiveOps | null = null, seller: SellerBook | null = null) {
    this.opts = opts;
    this.store = store;
    this.bus = bus;
    this.roads = roads;
    this.ops = ops;
    this.seller = seller;
    const fail = (res: ServerResponse, e: unknown): void => {
      this.bus.alert("error", "http_error", (e as Error).message);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    };
    this.server = createServer((req, res) => {
      try {
        if (req.method === "POST") {
          this.ingest(req, res).catch((e: unknown) => fail(res, e));
          return;
        }
        this.route(req, res);
      } catch (e) {
        fail(res, e);
      }
    });
  }

  /** POST /ingest/claim, /ingest/trace and /ingest/job. */
  private async ingest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://near-watch.local").pathname;
    const kind = path === "/ingest/claim" ? "claim" : path === "/ingest/trace" ? "trace" : path === "/ingest/job" ? "job" : null;
    const ingestKey = this.opts.ingestKey ?? null;
    if (!kind || !this.ops || !ingestKey) {
      req.resume();
      return json(res, 404, { error: "not found" });
    }
    if (!keyMatches(ingestKey, req, "x-ingest-key")) {
      req.resume();
      return json(res, 401, { error: "ingest key required" });
    }
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      req.resume();
      return json(res, 415, { error: "content-type must be application/json" });
    }
    let text: string;
    try {
      text = await readBody(req, this.opts.ingestMaxBytes ?? 65_536);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      throw e;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(res, 400, { error: "body is not JSON" });
    }
    const items = Array.isArray(body) ? body : [body];
    if (items.length === 0 || items.length > INGEST_MAX_ITEMS) return json(res, 400, { error: `send 1 to ${INGEST_MAX_ITEMS} records` });
    const ops = this.ops;
    const results: IngestResult[] = items.map((item) => (kind === "claim" ? ops.ingestClaim(item, "http") : kind === "job" ? ops.ingestJob(item) : ops.ingestTrace(item)));
    const refused = results.flatMap((r, index) => (r.ok ? [] : [{ index, error: r.error }]));
    const accepted = results.filter((r) => r.ok && r.isNew).length;
    const repeats = results.filter((r) => r.ok && !r.isNew).length;
    return json(res, refused.length === items.length ? 400 : 202, { accepted, repeats, refused });
  }

  snapshot(): Record<string, unknown> {
    const jobs = this.ops?.jobs.snapshot(Math.min(this.opts.sseReplay, 500)) ?? null;
    return {
      version: this.opts.version,
      ...(this.opts.token ? { token: this.opts.token } : {}),
      startedAt: this.opts.startedAt,
      networks: this.opts.networks,
      // source ("paywall" | "tenant" | "flag") lets the console tell the x402 pay-to from other pay-to accounts.
      watchlist: this.opts.watchlist.map(({ label, role, address, network, source }) => ({ label, role, address, network, source })),
      status: Object.fromEntries(this.bus.status),
      ledgers: Object.fromEntries(this.bus.ledgers),
      balances: this.bus.balances,
      alerts: this.bus.alerts,
      txs: this.store.recentTxs(this.opts.sseReplay).map((t) => this.withLinks({ row: t.row, firstVia: t.firstVia, firstSeenMs: t.firstSeenMs })),
      counters: this.roads.counters,
      ...(this.ops ? { liveOps: this.ops.snapshot(Math.min(this.opts.sseReplay, 500)) } : {}),
      ...(this.seller ? { seller: this.seller.compute() } : {}),
      ...(jobs ? { jobs } : {}),
    };
  }

  /** network + explorer links beside a transaction entry (when links are configured). */
  private withLinks<T extends { row: Row }>(entry: T): T {
    return this.opts.links ? this.opts.links.decorate(entry) : entry;
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://near-watch.local");
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (url.pathname === "/healthz") {
      const feeds = Object.fromEntries([...this.bus.status].map(([n, s]) => [n, { state: s.state, lastLedger: s.lastLedger, lastLedgerAgeMs: s.lastLedgerAgeMs }]));
      const ok = this.opts.networks.every((n) => this.bus.status.get(n)?.state === "live");
      return json(res, ok ? 200 : 503, { ok, feeds, network: this.opts.networks[0] });
    }
    if (!keyMatches(this.opts.adminKey, req)) return json(res, 401, { error: "admin key required" });
    if (url.pathname === "/stream") return this.stream(req, res);
    if (url.pathname === "/api/snapshot") return json(res, 200, this.snapshot());
    if (url.pathname === "/api/txs") {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
      const network = url.searchParams.get("network") ?? undefined;
      return json(res, 200, { txs: this.store.recentTxs(limit, network).map((t) => this.withLinks(t)) });
    }
    if (url.pathname === "/api/feeds") return this.opts.feeds ? json(res, 200, this.opts.feeds()) : json(res, 404, { error: "not found" });
    if (url.pathname === "/api/seller") return this.seller ? json(res, 200, this.seller.compute()) : json(res, 404, { error: "not found" });
    const limit = (fallback: number): number => Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? fallback) || fallback));
    if (this.ops) {
      if (url.pathname === "/api/claims") return json(res, 200, { claims: this.store.recentClaims(limit(100), url.searchParams.get("network") ?? undefined) });
      if (url.pathname === "/api/reconcile") {
        const state = url.searchParams.get("state");
        if (state !== null && !(RECON_STATES as readonly string[]).includes(state)) return json(res, 400, { error: `state must be one of ${RECON_STATES.join(", ")}` });
        return json(res, 200, { counts: this.store.reconCounts(), rows: this.store.recentRecon(limit(100), (state ?? undefined) as ReconState | undefined) });
      }
      if (url.pathname === "/api/metrics") return json(res, 200, this.ops.metrics());
      const t = /^\/api\/trace\/([A-Za-z0-9._:-]{1,128})$/.exec(url.pathname);
      if (t) return json(res, 200, this.ops.traceView(t[1]));
      if (url.pathname === "/api/jobs") {
        const state = url.searchParams.get("state");
        if (state !== null && !(JOB_STATES as readonly string[]).includes(state)) return json(res, 400, { error: `state must be one of ${JOB_STATES.join(", ")}` });
        const network = url.searchParams.get("network") ?? undefined;
        const book = this.ops.jobs;
        return json(res, 200, { ...book.summary(network), jobs: this.store.recentJobs(limit(100), network, (state ?? undefined) as JobState | undefined).map((j) => book.view(j)) });
      }
      const j = /^\/api\/job\/([^/]+)$/.exec(url.pathname);
      if (j) {
        const job = /^[0-9a-f]{32}$/.test(j[1]) ? this.store.getJob(j[1]) : undefined;
        if (!job) return json(res, 404, { error: "no such job" });
        const claim = job.txHash ? (this.store.getClaim(job.network, job.txHash) ?? null) : null;
        const tx = job.txHash ? this.store.getTx(job.network, job.txHash) : undefined;
        const recon = job.txHash ? this.store.getRecon(job.network, job.txHash) : undefined;
        return json(res, 200, { job: this.ops.jobs.view(job), claim, tx: tx ? this.withLinks(tx) : null, reconcile: recon ? { state: recon.state, detail: recon.detail } : null });
      }
    }
    const m = /^\/api\/tx\/([1-9A-HJ-NP-Za-km-z]{43,44})$/.exec(url.pathname);
    if (m && isNearHash(m[1])) {
      const network = url.searchParams.get("network") ?? this.opts.networks[0];
      const tx = this.store.getTx(network, m[1]);
      return tx ? json(res, 200, { ...this.withLinks(tx), roads: this.store.roadsFor(network, m[1]) }) : json(res, 404, { error: "not seen" });
    }
    return json(res, 404, { error: "not found" });
  }

  private send(res: ServerResponse, name: string, data: unknown): void {
    this.eventId += 1;
    res.write(`id: ${this.eventId}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private stream(req: IncomingMessage, res: ServerResponse): void {
    if (this.clients.size >= this.opts.sseMaxClients) return json(res, 503, { error: `at most ${this.opts.sseMaxClients} stream clients` });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 3000\n\n");
    this.clients.add(res);
    this.send(res, "hello", this.snapshot());
    const off = this.bus.on((name: EventName, data: unknown) => this.send(res, name, name === "tx" ? this.withLinks(data as TxEvent) : data));
    const beat = setInterval(() => res.write(`: keep-alive ${Date.now()}\n\n`), this.opts.sseHeartbeatSec * 1000);
    const close = (): void => {
      clearInterval(beat);
      off();
      this.clients.delete(res);
    };
    req.on("close", close);
    res.on("error", close);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  listen(port: number, host: string): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => resolve(this.server.address() as AddressInfo));
    });
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.end();
    this.clients.clear();
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    // Shutting down: drop kept-alive sockets too, so no connection is still closing when the process exits
    // (on Windows an exit while sockets close can abort Node in libuv).
    this.server.closeAllConnections();
    await closed;
  }
}
