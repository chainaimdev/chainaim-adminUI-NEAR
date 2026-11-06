/**
 * The console's view of near-watch, built only from near-watch's own events (ported from liveops admin-console
 * lib/live-store.ts; no other source, nothing invented). Pure: `applyEvent(state, name, data)` returns a new state
 * and never throws, so one bad event cannot blank the page; a refused event is counted in `stats` with its reason.
 *
 * Rules
 *   hello      replaces the data (near-watch's snapshot; sent first on every (re)connect), including the
 *              claims, reconcile rows and metrics of its liveOps part
 *   ledger     one final NEAR block; upsert by (network, index = height), oldest -> newest, last
 *              `limits.ledgersPerNetwork` kept
 *   tx         one entry per (network, hash), newest first; a repeat is merged, never duplicated
 *   road       a later road for a known transfer; the same road twice is kept once
 *   status     latest per network        balances   replaced          alert   appended, capped
 *   claim      one per (network, hash)   trace      one per (invoice, step), newest first
 *   reconcile  latest state per (network, hash)
 *   seller     replaced (the Seller Wallet figures; hello carries the current ones)
 *   job        latest per job id, with its network's counts and lost compute (hello.jobs carries the first copy; absent
 *              until near-watch holds a job: architecture-adminui-jobs.md ARCH-210)
 *
 * NEAR tx hashes are base58 and case-sensitive: keys use the hash exactly as sent (liveops upper-cased XRPL hex).
 *
 * Session data survives a reconnect (a new hello): `stats`, `roadStats` (arrival lags measured from this
 * session's tx/road events) and `rail` (the change log).
 */
import { short, unitsToDecimal } from "./format.ts";
import {
  ATTEST_SUMMARIES,
  EVENT_NAMES,
  type AlertEvent,
  type AttestSummary,
  type BalanceEntry,
  type ClaimRow,
  type EventName,
  type JobState,
  type JobView,
  type LedgerEvent,
  type Links,
  type Metrics,
  type ReconState,
  type Road,
  type Row,
  type SellerEvent,
  type StatusEvent,
  type TraceEvent,
  type WatchEntry,
} from "./types.ts";

export type Limits = { ledgersPerNetwork: number; alerts: number; txs: number; claims: number; traces: number; rail: number };

export const DEFAULT_LIMITS: Readonly<Limits> = { ledgersPerNetwork: 60, alerts: 100, txs: 500, claims: 500, traces: 1000, rail: 80 };

export type TxItem = {
  key: string;
  network: string;
  hash: string;
  row: Row;
  firstVia: Road;
  /** Arrival of the first road after the block's time (from `tx`), or null when it came from a snapshot. */
  lagMs: number | null;
  firstSeenMs: number | null;
  links: Links | null;
  /** Later roads, from `road` events: delay behind the first road. */
  roads: { via: Road; lagMs: number }[];
};

export type ReconItem = { network: string; hash: string; invoiceId: string | null; state: ReconState; previous: ReconState | null; side: string; detail: string | null; at: number };

/** Per network and road, this session: first arrivals with their lag after block time; later arrivals with their delay behind the first road. */
export type RoadStat = { first: number; firstLagSum: number; firstLagN: number; later: number; behindSum: number };

export type RailEntry = { id: number; at: number | null; level: "info" | "warn" | "error"; text: string; network: string | null };

export type Stats = { applied: Partial<Record<EventName, number>>; ignored: Record<string, number>; errors: number; lastError: string | null };

export type LiveState = {
  hasHello: boolean;
  version: string | null;
  startedAt: number | null;
  networks: string[];
  watchlist: WatchEntry[];
  status: Record<string, StatusEvent>;
  ledgers: Record<string, LedgerEvent[]>;
  balances: BalanceEntry[];
  alerts: AlertEvent[];
  txs: TxItem[];
  claims: ClaimRow[];
  traces: TraceEvent[];
  recon: Record<string, ReconItem>;
  /** From hello.liveOps.metrics; the page refreshes it from /api/metrics. */
  metrics: Metrics | null;
  /** Seller Wallet (hello.seller, then every `seller` event); null when near-watch sends none. */
  seller: SellerEvent | null;
  /** hello.token: contract, symbol and decimals near-watch read from ft_metadata; null on an older near-watch. */
  token: { contract: string; symbol: string; decimals: number } | null;
  /** Paid jobs by job id (hello.jobs.recent, then every `job` event); empty until near-watch holds one. */
  jobs: Record<string, JobView>;
  /** Counts per job state and lost compute per network, as near-watch last sent them; null before any job. */
  jobSummary: { counts: Record<JobState, number>; lostCompute: Record<string, string>; attestation?: Record<AttestSummary, number> } | null;
  counters: unknown;
  stats: Stats;
  roadStats: Record<string, Partial<Record<Road, RoadStat>>>;
  rail: RailEntry[];
  railSeq: number;
};

export function emptyState(): LiveState {
  return {
    hasHello: false,
    version: null,
    startedAt: null,
    networks: [],
    watchlist: [],
    status: {},
    ledgers: {},
    balances: [],
    alerts: [],
    txs: [],
    claims: [],
    traces: [],
    recon: {},
    metrics: null,
    seller: null,
    token: null,
    jobs: {},
    jobSummary: null,
    counters: null,
    stats: { applied: {}, ignored: {}, errors: 0, lastError: null },
    roadStats: {},
    rail: [],
    railSeq: 0,
  };
}

/** (network, hash) key. The hash is base58 and case-sensitive: never case-folded. */
export const txKey = (network: string, hash: string): string => `${network}:${hash}`;

/** The watchlist label of an account on a network, or the account id (shortened when long). */
export function labelOf(state: Pick<LiveState, "watchlist">, network: string, address: string | null | undefined): string {
  if (!address) return "—";
  return state.watchlist.find((w) => w.network === network && w.address === address)?.label ?? (address.length > 28 ? short(address, 8, 6) : address);
}

/** The token a network counts (its symbol): from the balances, else the Seller Wallet; null when near-watch named none yet. */
export function tokenCode(state: Pick<LiveState, "balances" | "seller">, network: string): string | null {
  return state.balances.find((b) => b.network === network && b.asset?.code)?.asset.code ?? state.seller?.wallets.find((w) => w.network === network)?.asset.code ?? null;
}

/** The token's decimals on a network, from the Seller Wallet's asset (near-watch reads them from ft_metadata); null when unknown. */
export function tokenDecimals(state: Pick<LiveState, "seller"> & { token?: LiveState["token"] }, network: string): number | null {
  return state.seller?.wallets.find((w) => w.network === network)?.asset.decimals ?? state.token?.decimals ?? null;
}

class Refused extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** near-watch (packages/chain-core near.ts): base58 of 32 bytes, 43 or 44 characters. */
const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const UNITS = /^\d+$/;

function need<T>(ok: boolean, value: T, what: string): T {
  if (!ok) throw new Refused(what);
  return value;
}
const str = (o: Record<string, unknown>, k: string): string => need(typeof o[k] === "string" && o[k] !== "", o[k] as string, `${k} is not a string`);
const int = (o: Record<string, unknown>, k: string): number => need(Number.isInteger(o[k]), o[k] as number, `${k} is not a whole number`);
const decStr = (o: Record<string, unknown>, k: string, where: string): void => {
  need(typeof o[k] === "string", null, `${where}.${k} is not a decimal string`);
};

function asLedger(v: unknown): LedgerEvent {
  if (!isObj(v)) throw new Refused("ledger is not an object");
  str(v, "network");
  int(v, "index");
  return v as unknown as LedgerEvent;
}
function asStatus(v: unknown): StatusEvent {
  if (!isObj(v)) throw new Refused("status is not an object");
  str(v, "network");
  str(v, "state");
  return v as unknown as StatusEvent;
}
function asRow(v: unknown): Row {
  if (!isObj(v)) throw new Refused("row is not an object");
  need(typeof v.hash === "string" && HASH.test(v.hash), null, "row.hash is not a base58 transaction hash");
  int(v, "blockHeight");
  need(typeof v.value === "string", null, "row.value is not a decimal string");
  return v as unknown as Row;
}
function asClaim(v: unknown): ClaimRow {
  if (!isObj(v)) throw new Refused("claim is not an object");
  str(v, "network");
  str(v, "hash");
  need(typeof v.amount === "string" && UNITS.test(v.amount), null, "claim.amount is not base units");
  return v as unknown as ClaimRow;
}
function asSeller(v: unknown): SellerEvent {
  if (!isObj(v)) throw new Refused("seller is not an object");
  need(Array.isArray(v.wallets), null, "seller.wallets is not a list");
  for (const w of v.wallets as unknown[]) {
    if (!isObj(w)) throw new Refused("seller wallet is not an object");
    str(w, "network");
    str(w, "address");
    need(isObj(w.asset) && Number.isInteger((w.asset as Record<string, unknown>).decimals), null, "seller asset.decimals is not a whole number");
    need(isObj(w.balance) && isObj(w.received) && isObj(w.inFlight) && isObj(w.window) && isObj(w.unwatched), null, "seller wallet lacks balance, received, inFlight, window or unwatched");
    decStr(w.received as Record<string, unknown>, "amount", "seller received");
    decStr(w.inFlight as Record<string, unknown>, "amount", "seller inFlight");
    decStr(w.window as Record<string, unknown>, "amount", "seller window");
    decStr(w, "expected", "seller");
    need(Array.isArray(w.recent) && Array.isArray(w.buyers), null, "seller recent / buyers is not a list");
  }
  return v as unknown as SellerEvent;
}
const JOB_ID = /^[0-9a-f]{32}$/;
const JOB_STATE_SET = new Set(["quoted", "paid", "released", "expired"]);
function asJob(v: unknown): JobView {
  if (!isObj(v)) throw new Refused("job is not an object");
  need(typeof v.jobId === "string" && JOB_ID.test(v.jobId), null, "job.jobId is not 32 hex characters");
  str(v, "network");
  need(typeof v.state === "string" && JOB_STATE_SET.has(v.state), null, "job.state is not a job state");
  need(v.amount === null || (typeof v.amount === "string" && UNITS.test(v.amount)), null, "job.amount is not base units");
  need(v.steps === null || Array.isArray(v.steps), null, "job.steps is not a list");
  // NEAR AI attestation (ARCH-504): absent on jobs without one; when present, a known summary and a list of calls.
  if (v.attestation !== undefined) {
    const a = v.attestation;
    need(isObj(a) && typeof a.summary === "string" && ATTEST_SET.has(a.summary) && Array.isArray(a.calls) && a.calls.every(isObj), null, "job.attestation is not an attestation");
  }
  return v as unknown as JobView;
}
const ATTEST_SET = new Set<string>(ATTEST_SUMMARIES);
function asJobSummary(v: unknown): NonNullable<LiveState["jobSummary"]> {
  need(isObj(v) && isObj(v.counts) && isObj(v.lostCompute), null, "job summary lacks counts or lostCompute");
  need((v as Record<string, unknown>).attestation === undefined || isObj((v as Record<string, unknown>).attestation), null, "job summary attestation is not an object");
  return v as unknown as NonNullable<LiveState["jobSummary"]>;
}

function networkOf(entry: Record<string, unknown>, row: Row): string {
  const n = typeof entry.network === "string" ? entry.network : row.network;
  return need(typeof n === "string" && n !== "", n as string, "transaction has no network");
}

function upsertLedger(list: LedgerEvent[] | undefined, e: LedgerEvent, keep: number): LedgerEvent[] {
  const next = (list ?? []).filter((l) => l.index !== e.index);
  next.push(e);
  next.sort((a, b) => a.index - b.index);
  return next.length > keep ? next.slice(next.length - keep) : next;
}

const capFront = <T>(list: T[], keep: number): T[] => (list.length > keep ? list.slice(0, keep) : list);

function addRail(state: LiveState, at: number | null, level: RailEntry["level"], text: string, network: string | null, limits: Limits): Pick<LiveState, "rail" | "railSeq"> {
  const id = state.railSeq + 1;
  return { rail: capFront([{ id, at, level, text, network }, ...state.rail], limits.rail), railSeq: id };
}

function bumpRoad(stats: LiveState["roadStats"], network: string, via: Road, f: (s: RoadStat) => RoadStat): LiveState["roadStats"] {
  const cur = stats[network]?.[via] ?? { first: 0, firstLagSum: 0, firstLagN: 0, later: 0, behindSum: 0 };
  return { ...stats, [network]: { ...stats[network], [via]: f(cur) } };
}

function fromHello(data: unknown, prev: LiveState, limits: Limits): LiveState {
  if (!isObj(data)) throw new Refused("hello is not an object");
  const networks = need(Array.isArray(data.networks) && data.networks.every((n) => typeof n === "string"), data.networks as string[], "hello.networks is not a list of names");
  const s = emptyState();
  s.hasHello = true;
  s.version = typeof data.version === "string" ? data.version : null;
  s.startedAt = typeof data.startedAt === "number" ? data.startedAt : null;
  s.networks = [...networks];
  s.watchlist = Array.isArray(data.watchlist) ? (data.watchlist.filter(isObj) as unknown as WatchEntry[]) : [];
  if (isObj(data.status)) for (const [n, st] of Object.entries(data.status)) s.status[n] = asStatus(st);
  if (isObj(data.ledgers)) {
    for (const [n, list] of Object.entries(data.ledgers)) {
      let acc: LedgerEvent[] = [];
      for (const l of Array.isArray(list) ? list : []) acc = upsertLedger(acc, asLedger(l), limits.ledgersPerNetwork);
      s.ledgers[n] = acc;
    }
  }
  s.balances = isObj(data.balances) && Array.isArray(data.balances.entries) ? (data.balances.entries.filter(isObj) as unknown as BalanceEntry[]) : [];
  s.alerts = Array.isArray(data.alerts) ? (data.alerts.filter(isObj) as unknown as AlertEvent[]).slice(-limits.alerts) : [];
  const seen = new Set<string>();
  for (const t of Array.isArray(data.txs) ? data.txs : []) {
    if (!isObj(t)) throw new Refused("hello.txs entry is not an object");
    const row = asRow(t.row);
    const network = networkOf(t, row);
    const key = txKey(network, row.hash);
    if (seen.has(key)) continue;
    seen.add(key);
    s.txs.push({
      key,
      network,
      hash: row.hash,
      row,
      firstVia: str(t, "firstVia") as Road,
      lagMs: null,
      firstSeenMs: typeof t.firstSeenMs === "number" ? t.firstSeenMs : null,
      links: isObj(t.links) ? (t.links as Links) : null,
      roads: [],
    });
  }
  s.txs = capFront(s.txs, limits.txs);
  s.counters = data.counters ?? null;
  const ops = isObj(data.liveOps) ? data.liveOps : null;
  if (ops) {
    const claimSeen = new Set<string>();
    for (const c of Array.isArray(ops.claims) ? ops.claims : []) {
      const claim = asClaim(c);
      const key = txKey(claim.network, claim.hash);
      if (claimSeen.has(key)) continue;
      claimSeen.add(key);
      s.claims.push(claim);
    }
    s.claims = capFront(s.claims, limits.claims);
    const recent = isObj(ops.reconcile) && Array.isArray(ops.reconcile.recent) ? ops.reconcile.recent : [];
    for (const r of recent) {
      if (!isObj(r)) throw new Refused("hello reconcile row is not an object");
      const key = txKey(str(r, "network"), str(r, "hash"));
      const at = typeof r.updatedMs === "number" ? r.updatedMs : 0;
      if (s.recon[key] && s.recon[key].at >= at) continue;
      s.recon[key] = {
        network: r.network as string,
        hash: r.hash as string,
        invoiceId: typeof r.invoiceId === "string" ? r.invoiceId : null,
        state: str(r, "state") as ReconState,
        previous: null,
        side: typeof r.side === "string" ? r.side : "",
        detail: typeof r.detail === "string" ? r.detail : null,
        at,
      };
    }
    s.metrics = isObj(ops.metrics) ? (ops.metrics as unknown as Metrics) : null;
  }
  // A malformed Seller Wallet part leaves the tile empty and is counted; it does not refuse the rest of hello.
  let sellerError: string | null = null;
  if (data.seller !== undefined) {
    try {
      s.seller = asSeller(data.seller);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      sellerError = `hello: ${e.message}`;
    }
  }
  // The console session (counters, measured lags, change log) survives a reconnect; the data does not.
  s.stats = sellerError === null ? prev.stats : { ...prev.stats, errors: prev.stats.errors + 1, lastError: sellerError };
  // Paid jobs: only when near-watch holds one (hello.jobs absent otherwise).
  if (data.jobs !== undefined) {
    if (!isObj(data.jobs)) throw new Refused("hello.jobs is not an object");
    for (const j of Array.isArray(data.jobs.recent) ? data.jobs.recent : []) {
      const job = asJob(j);
      s.jobs[job.jobId] = job;
    }
    s.jobSummary = asJobSummary(data.jobs);
  }
  const tk = (data as Record<string, unknown>).token;
  s.token = isObj(tk) && typeof tk.contract === "string" && typeof tk.symbol === "string" && Number.isInteger(tk.decimals) ? { contract: tk.contract, symbol: tk.symbol, decimals: tk.decimals as number } : null;
  s.roadStats = prev.roadStats;
  s.rail = prev.rail;
  s.railSeq = prev.railSeq;
  const statusTimes = Object.values(s.status).map((x) => x.at).filter((x): x is number => typeof x === "number");
  const helloAt = statusTimes.length > 0 ? Math.max(...statusTimes) : null;
  Object.assign(
    s,
    addRail(s, helloAt, "info", `connected to near-watch ${s.version ?? ""}: ${networks.join(" + ")}, ${s.watchlist.length} watched account(s), ${s.txs.length} recent transfer(s)`, null, limits),
  );
  return s;
}

function apply(state: LiveState, name: EventName, data: unknown, limits: Limits): LiveState {
  switch (name) {
    case "hello":
      return fromHello(data, state, limits);
    case "ledger": {
      const e = asLedger(data);
      return { ...state, ledgers: { ...state.ledgers, [e.network]: upsertLedger(state.ledgers[e.network], e, limits.ledgersPerNetwork) } };
    }
    case "status": {
      const e = asStatus(data);
      const before = state.status[e.network];
      const next = { ...state, status: { ...state.status, [e.network]: e } };
      if (before && before.state !== e.state) {
        const level = e.state === "live" ? "info" : e.state === "down" ? "error" : "warn";
        return { ...next, ...addRail(state, e.at, level, `${e.network} feed ${before.state} → ${e.state} (${e.provider})`, e.network, limits) };
      }
      return next;
    }
    case "balances": {
      if (!isObj(data) || !Array.isArray(data.entries)) throw new Refused("balances.entries is not a list");
      return { ...state, balances: data.entries.filter(isObj) as unknown as BalanceEntry[] };
    }
    case "alert": {
      if (!isObj(data)) throw new Refused("alert is not an object");
      str(data, "code");
      const a = data as unknown as AlertEvent;
      const alerts = [...state.alerts, a];
      return {
        ...state,
        alerts: alerts.length > limits.alerts ? alerts.slice(alerts.length - limits.alerts) : alerts,
        ...addRail(state, a.at, a.level, `${a.code}: ${a.message}`, a.network ?? null, limits),
      };
    }
    case "tx": {
      if (!isObj(data)) throw new Refused("tx is not an object");
      const row = asRow(data.row);
      const network = networkOf(data, row);
      const key = txKey(network, row.hash);
      const existing = state.txs.find((t) => t.key === key);
      const via = existing?.firstVia ?? (str(data, "via") as Road);
      const lagMs = typeof data.lagMs === "number" ? data.lagMs : null;
      const item: TxItem = {
        key,
        network,
        hash: row.hash,
        row,
        firstVia: via,
        lagMs: existing?.lagMs ?? lagMs,
        firstSeenMs: existing?.firstSeenMs ?? null,
        links: isObj(data.links) ? (data.links as Links) : (existing?.links ?? null),
        roads: existing?.roads ?? [],
      };
      const txs = capFront([item, ...state.txs.filter((t) => t.key !== key)], limits.txs);
      if (existing) return { ...state, txs };
      const roadStats = bumpRoad(state.roadStats, network, via, (s) => ({
        ...s,
        first: s.first + 1,
        firstLagSum: s.firstLagSum + (lagMs ?? 0),
        firstLagN: s.firstLagN + (lagMs === null ? 0 : 1),
      }));
      const token = tokenCode(state, network) ?? short(row.contract, 6, 4);
      const text = `${row.status === "success" ? "+" : "failed "}${row.value} ${token} ${labelOf(state, network, row.from)} → ${labelOf(state, network, row.to)} · ${row.method ?? "transfer"}${row.isX402 ? " · x402" : ""} · block ${row.blockHeight} · first via ${via}`;
      return { ...state, txs, roadStats, ...addRail(state, row.blockTimeMs, row.status === "success" ? "info" : "warn", text, network, limits) };
    }
    case "road": {
      if (!isObj(data)) throw new Refused("road is not an object");
      const network = str(data, "network");
      const key = txKey(network, str(data, "hash"));
      const via = str(data, "via") as Road;
      const lagMs = typeof data.lagMs === "number" ? data.lagMs : 0;
      let added = false;
      const txs = state.txs.map((t) => {
        if (t.key !== key || t.firstVia === via || t.roads.some((r) => r.via === via)) return t;
        added = true;
        return { ...t, roads: [...t.roads, { via, lagMs }] };
      });
      const roadStats = bumpRoad(state.roadStats, network, via, (s) => ({ ...s, later: s.later + 1, behindSum: s.behindSum + lagMs }));
      return { ...state, txs: added ? txs : state.txs, roadStats };
    }
    case "claim": {
      if (!isObj(data)) throw new Refused("claim is not an object");
      const c = asClaim(data.claim);
      const key = txKey(c.network, c.hash);
      const claims = capFront([c, ...state.claims.filter((x) => txKey(x.network, x.hash) !== key)], limits.claims);
      // A claim's amount is base units: shown as a decimal only when the token's decimals are known.
      const dec = unitsToDecimal(c.amount, tokenDecimals(state, c.network));
      const amount = dec !== null ? `${dec} ${tokenCode(state, c.network) ?? ""}`.trim() : `${c.amount} base units`;
      const text = `claim ${amount} from ${labelOf(state, c.network, c.payer)} · ${c.route ?? "—"} · tx ${short(c.hash, 6, 4)} (reported by paywall, ${c.source})`;
      return { ...state, claims, ...addRail(state, c.tsMs, "info", text, c.network, limits) };
    }
    case "trace": {
      if (!isObj(data) || !isObj(data.trace)) throw new Refused("trace.trace is not an object");
      const t = data.trace;
      str(t, "invoiceId");
      int(t, "step");
      const ev = data as unknown as TraceEvent;
      const traces = capFront([ev, ...state.traces.filter((x) => !(x.trace.invoiceId === ev.trace.invoiceId && x.trace.step === ev.trace.step))], limits.traces);
      return { ...state, traces };
    }
    case "reconcile": {
      if (!isObj(data)) throw new Refused("reconcile is not an object");
      const network = str(data, "network");
      const hash = str(data, "hash");
      const item: ReconItem = {
        network,
        hash,
        invoiceId: typeof data.invoiceId === "string" ? data.invoiceId : null,
        state: str(data, "state") as ReconState,
        previous: typeof data.previous === "string" ? (data.previous as ReconState) : null,
        side: typeof data.side === "string" ? data.side : "",
        detail: typeof data.detail === "string" ? data.detail : null,
        at: typeof data.at === "number" ? data.at : 0,
      };
      const gap = item.state === "only_in_log" || item.state === "only_on_ledger" || item.state === "mismatch";
      const text = `reconcile ${short(hash, 6, 4)}: ${item.previous ?? "new"} → ${item.state}${item.detail ? ` (${item.detail})` : ""}`;
      return { ...state, recon: { ...state.recon, [txKey(network, hash)]: item }, ...addRail(state, item.at, gap ? (item.state === "only_on_ledger" ? "warn" : "error") : "info", text, network, limits) };
    }
    case "seller":
      return { ...state, seller: asSeller(data) };
    case "job": {
      if (!isObj(data)) throw new Refused("job event is not an object");
      const job = asJob(data.job);
      const summary = asJobSummary(data.summary);
      const before = state.jobs[job.jobId];
      const attestation: Record<AttestSummary, number> | undefined = summary.attestation ?? state.jobSummary?.attestation;
      const jobSummary = { counts: summary.counts, lostCompute: { ...(state.jobSummary?.lostCompute ?? {}), ...summary.lostCompute }, ...(attestation ? { attestation } : {}) };
      const next = { ...state, jobs: { ...state.jobs, [job.jobId]: job }, jobSummary };
      if (before?.state === job.state) return next;
      const at = job.releasedMs ?? job.expiredMs ?? job.paidMs ?? job.quotedMs ?? job.receivedMs;
      const text = `job ${short(job.jobId, 6, 4)}: ${before?.state ?? "new"} → ${job.state}${job.noJobEvent ? " (no job event)" : ""}${job.totalUsd ? ` · $${job.totalUsd}` : ""}`;
      return { ...next, ...addRail(state, at, job.state === "expired" ? "warn" : "info", text, job.network, limits) };
    }
  }
}

export function isEventName(name: string): name is EventName {
  return (EVENT_NAMES as readonly string[]).includes(name);
}

/** Applies one event. Unknown names and refused data leave the data unchanged and are counted. */
export function applyEvent(state: LiveState, name: string, data: unknown, limits: Limits = DEFAULT_LIMITS): LiveState {
  if (!isEventName(name)) {
    return { ...state, stats: { ...state.stats, ignored: { ...state.stats.ignored, [name]: (state.stats.ignored[name] ?? 0) + 1 } } };
  }
  try {
    const next = apply(state, name, data, limits);
    return { ...next, stats: { ...next.stats, applied: { ...next.stats.applied, [name]: (next.stats.applied[name] ?? 0) + 1 } } };
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    return { ...state, stats: { ...state.stats, errors: state.stats.errors + 1, lastError: `${name}: ${e.message}` } };
  }
}

/** The highest final block height the console holds for a network, or null. */
export function lastLedger(state: LiveState, network: string): number | null {
  const list = state.ledgers[network];
  const fromStrip = list && list.length > 0 ? list[list.length - 1].index : null;
  const fromStatus = state.status[network]?.lastLedger ?? null;
  if (fromStrip === null) return fromStatus;
  if (fromStatus === null) return fromStrip;
  return Math.max(fromStrip, fromStatus);
}
