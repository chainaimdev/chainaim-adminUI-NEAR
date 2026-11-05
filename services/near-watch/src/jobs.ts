/**
 * Paid jobs (architecture-adminui-jobs.md ARCH-206..208): the private-ai test console's job events in, one row per job
 * out, joined to the paywall's claim for that job and through it to the chain transfer and its reconcile state.
 *
 *   job_quoted    {v:1, event, ts, jobId, network, amount, totalUsd, expiresAt, steps[], breakdown{}}
 *   job_released  {v:1, event, ts, jobId, network}
 *   job_expired   {v:1, event, ts, jobId, network}
 * (chainiam-private-ai test-console/console/job-feed.ts builds them.)
 *
 * Fail closed: an event is parsed strictly (every field typed and bounded, unknown fields refused), so nothing but ids,
 * times, amounts, model ids, zones and counts is ever stored; a malformed event is refused whole (IngestError).
 *
 * States: quoted -> paid (a claim for the job's release route is seen) -> released (job_released); quoted -> expired
 * (job_expired, only while no claim is linked). A claim for a job never quoted here makes a row "paid (no job event)"
 * and raises job_unknown once; a late job_quoted fills that row in.
 * Lost compute: the model cost + call fees + analyst fee of expired jobs, per network (the compute that was run and
 * quoted but never paid for).
 */
import { formatUnits, isUnits, toUnits } from "../../../packages/chain-core/src/money.ts";
import { IngestError, isObj, isoMs, watchedNetwork, type CaipMap } from "./claims.ts";
import type { Bus } from "./events.ts";
import type { ClaimRow, JobRow, JobState, ReconState, Store } from "./store.ts";

export const JOB_STATES = ["quoted", "paid", "released", "expired"] as const;
export const JOB_EVENTS = ["job_quoted", "job_released", "job_expired"] as const;
export type JobEventName = (typeof JOB_EVENTS)[number];

/** The paywall's release route for a job (paywall routes.ts): the claim's `route` names the job. */
export const RELEASE_ROUTE = /^POST \/v1\/jobs\/([0-9a-f]{32})\/release$/;
export const releaseRoute = (jobId: string): string => `POST /v1/jobs/${jobId}/release`;
const JOB_ID = /^[0-9a-f]{32}$/;
const MODEL_ID = /^[A-Za-z0-9._:\/@-]{1,128}$/;
const ZONE = /^[a-z][a-z-]{0,31}$/;
const KIND = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** A USD amount as cost.ts writes it: whole dollars and at most 6 decimals (USDC precision). */
const USD = /^\d{1,12}(\.\d{1,6})?$/;
/** marginPct / minPriceUsd as the operator set them (any non-negative decimal of reasonable size). */
const DECIMAL = /^\d{1,12}(\.\d{1,18})?$/;
const MAX_STEPS = 32;
const MAX_KINDS = 64;

export type AnalystStep = { name: "analyst"; ms: number; files: number; relations: number };
export type ModelStep = {
  name: "query" | "answer"; ms: number; model: string; zone: string | null; promptTokens: number; completionTokens: number; usd: string;
  entityCounts: Record<string, number> | null; residual: "pass" | "refused" | null;
};
export type SqlStep = { name: "sql"; ms: number; rows: number };
export type JobStep = AnalystStep | ModelStep | SqlStep;
export type BreakdownCall = { model: string; promptTokens: number; completionTokens: number; usd: string };
export type JobBreakdown = {
  calls: BreakdownCall[]; modelUsd: string; callFeesUsd: string; analystUsd: string; nearGasUsd: string; marginPct: string; minPriceUsd: string; minApplied: boolean;
  /** Optional: sent by consoles whose cost.ts reports them; jobs stored before have neither. */
  subtotalUsd?: string; withMarginUsd?: string;
};

export type JobEventInput =
  | { event: "job_quoted"; tsMs: number; jobId: string; network: string; amount: string; totalUsd: string; expiresMs: number; steps: JobStep[]; breakdown: JobBreakdown }
  | { event: "job_released" | "job_expired"; tsMs: number; jobId: string; network: string };

// ---- strict parsing ----

function only(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new IngestError(`${what}: unknown field ${k}`);
}
function int(v: unknown, field: string, max = 2_147_483_647): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) throw new IngestError(`${field} must be a whole number from 0 to ${max}`);
  return v;
}
function str(v: unknown, field: string, re: RegExp, max: number): string {
  if (typeof v !== "string" || v.length > max || !re.test(v)) throw new IngestError(`${field} must match ${re.source} (at most ${max} characters)`);
  return v;
}
const usd = (v: unknown, field: string): string => str(v, field, USD, 19);

function parseCounts(v: unknown, field: string): Record<string, number> | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) throw new IngestError(`${field} must be an object of entity kind -> count`);
  const keys = Object.keys(v);
  if (keys.length > MAX_KINDS) throw new IngestError(`${field}: at most ${MAX_KINDS} kinds`);
  const out: Record<string, number> = {};
  for (const k of keys) {
    if (!KIND.test(k)) throw new IngestError(`${field}: ${k.slice(0, 20)}… is not an entity kind`);
    out[k] = int(v[k], `${field}.${k}`, 1_000_000);
  }
  return out;
}

function parseStep(v: unknown, i: number): JobStep {
  const at = `steps[${i}]`;
  if (!isObj(v)) throw new IngestError(`${at} must be an object`);
  if (v.name === "analyst") {
    only(v, ["name", "ms", "files", "relations"], at);
    return { name: "analyst", ms: int(v.ms, `${at}.ms`, 86_400_000), files: int(v.files, `${at}.files`, 100_000), relations: int(v.relations, `${at}.relations`, 100_000) };
  }
  if (v.name === "sql") {
    only(v, ["name", "ms", "rows"], at);
    return { name: "sql", ms: int(v.ms, `${at}.ms`, 86_400_000), rows: int(v.rows, `${at}.rows`, 100_000_000) };
  }
  if (v.name === "query" || v.name === "answer") {
    only(v, ["name", "ms", "model", "zone", "promptTokens", "completionTokens", "usd", "entityCounts", "residual"], at);
    if (v.residual !== undefined && v.residual !== null && v.residual !== "pass" && v.residual !== "refused") throw new IngestError(`${at}.residual must be pass or refused`);
    return {
      name: v.name,
      ms: int(v.ms, `${at}.ms`, 86_400_000),
      model: str(v.model, `${at}.model`, MODEL_ID, 128),
      zone: v.zone === undefined || v.zone === null ? null : str(v.zone, `${at}.zone`, ZONE, 32),
      promptTokens: int(v.promptTokens, `${at}.promptTokens`, 100_000_000),
      completionTokens: int(v.completionTokens, `${at}.completionTokens`, 100_000_000),
      usd: usd(v.usd, `${at}.usd`),
      entityCounts: parseCounts(v.entityCounts, `${at}.entityCounts`),
      residual: (v.residual as "pass" | "refused" | undefined) ?? null,
    };
  }
  throw new IngestError(`${at}.name must be analyst, query, sql or answer`);
}

function parseBreakdown(v: unknown): JobBreakdown {
  if (!isObj(v)) throw new IngestError("breakdown must be an object");
  only(v, ["calls", "modelUsd", "callFeesUsd", "analystUsd", "nearGasUsd", "marginPct", "minPriceUsd", "minApplied", "subtotalUsd", "withMarginUsd"], "breakdown");
  if (!Array.isArray(v.calls) || v.calls.length > MAX_STEPS) throw new IngestError(`breakdown.calls must be a list of at most ${MAX_STEPS}`);
  const calls = v.calls.map((c, i) => {
    const at = `breakdown.calls[${i}]`;
    if (!isObj(c)) throw new IngestError(`${at} must be an object`);
    only(c, ["model", "promptTokens", "completionTokens", "usd"], at);
    return { model: str(c.model, `${at}.model`, MODEL_ID, 128), promptTokens: int(c.promptTokens, `${at}.promptTokens`, 100_000_000), completionTokens: int(c.completionTokens, `${at}.completionTokens`, 100_000_000), usd: usd(c.usd, `${at}.usd`) };
  });
  if (typeof v.minApplied !== "boolean") throw new IngestError("breakdown.minApplied must be true or false");
  return {
    calls,
    modelUsd: usd(v.modelUsd, "breakdown.modelUsd"),
    callFeesUsd: usd(v.callFeesUsd, "breakdown.callFeesUsd"),
    analystUsd: usd(v.analystUsd, "breakdown.analystUsd"),
    nearGasUsd: usd(v.nearGasUsd, "breakdown.nearGasUsd"),
    marginPct: str(v.marginPct, "breakdown.marginPct", DECIMAL, 31),
    minPriceUsd: str(v.minPriceUsd, "breakdown.minPriceUsd", DECIMAL, 31),
    minApplied: v.minApplied,
    ...(v.subtotalUsd !== undefined ? { subtotalUsd: usd(v.subtotalUsd, "breakdown.subtotalUsd") } : {}),
    ...(v.withMarginUsd !== undefined ? { withMarginUsd: usd(v.withMarginUsd, "breakdown.withMarginUsd") } : {}),
  };
}

export function parseJobEvent(input: unknown, caips: CaipMap): JobEventInput {
  if (!isObj(input)) throw new IngestError("a job event must be a JSON object");
  if (input.v !== 1) throw new IngestError("v must be 1");
  const event = input.event;
  if (typeof event !== "string" || !(JOB_EVENTS as readonly string[]).includes(event)) throw new IngestError(`event must be one of ${JOB_EVENTS.join(", ")}`);
  if (typeof input.jobId !== "string" || !JOB_ID.test(input.jobId)) throw new IngestError("jobId must be 32 lowercase hex characters");
  const base = { tsMs: isoMs(input.ts, "ts"), jobId: input.jobId, network: watchedNetwork(input.network, caips) };
  if (event !== "job_quoted") {
    only(input, ["v", "event", "ts", "jobId", "network"], event);
    return { event: event as "job_released" | "job_expired", ...base };
  }
  only(input, ["v", "event", "ts", "jobId", "network", "amount", "totalUsd", "expiresAt", "steps", "breakdown"], event);
  if (!isUnits(input.amount) || BigInt(input.amount) === 0n) throw new IngestError("amount must be a positive integer string of USDC base units");
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > MAX_STEPS) throw new IngestError(`steps must be a list of 1 to ${MAX_STEPS}`);
  return {
    event: "job_quoted",
    ...base,
    amount: BigInt(input.amount).toString(),
    totalUsd: usd(input.totalUsd, "totalUsd"),
    expiresMs: isoMs(input.expiresAt, "expiresAt"),
    steps: input.steps.map(parseStep),
    breakdown: parseBreakdown(input.breakdown),
  };
}

// ---- money ----

const USD_DECIMALS = 6;
/** A non-negative micro-dollar count as a 6-decimal string. */
export const usdText = (micros: bigint): string => {
  const s = formatUnits(micros, USD_DECIMALS);
  const [w, f = ""] = s.split(".");
  return `${w}.${f.padEnd(USD_DECIMALS, "0")}`;
};
/** What an expired job's compute cost: model calls + call fees + analyst fee (gas and margin were never spent). */
export function lostOf(b: JobBreakdown): bigint {
  return BigInt(toUnits(b.modelUsd, USD_DECIMALS)) + BigInt(toUnits(b.callFeesUsd, USD_DECIMALS)) + BigInt(toUnits(b.analystUsd, USD_DECIMALS));
}

// ---- the book ----

/** A job as the API and the stream show it. `reconcile` is the linked transfer's reconcile state, when there is one. */
export type JobView = JobRow & {
  /** True for a row made from a claim alone: near-watch never received this job's job_quoted. */
  noJobEvent: boolean;
  invoiceId: string | null;
  payer: string | null;
  reconcile: ReconState | null;
};
export type JobCounts = Record<JobState, number>;
export type JobsSummary = { counts: JobCounts; lostCompute: Record<string, string> };

export class JobBook {
  readonly counters = { events: 0, repeats: 0, unknownClaims: 0 };
  private readonly store: Store;
  private readonly bus: Bus;
  private readonly caips: CaipMap;
  private readonly networks: readonly string[];
  private readonly now: () => number;
  private readonly unknownAlerted = new Set<string>();

  constructor(store: Store, bus: Bus, opts: { caips: CaipMap; networks: readonly string[]; now?: () => number }) {
    this.store = store;
    this.bus = bus;
    this.caips = opts.caips;
    this.networks = opts.networks;
    this.now = opts.now ?? Date.now;
  }

  /** Parse and apply one event. Throws IngestError on a malformed one (nothing stored). isNew false = a repeat. */
  ingest(input: unknown): { isNew: boolean } {
    const e = parseJobEvent(input, this.caips);
    const prev = this.store.getJob(e.jobId);
    if (prev && prev.network !== e.network) throw new IngestError(`job ${e.jobId} is on ${prev.network}, not ${e.network}`);
    const t = this.now();
    let next: JobRow;
    if (e.event === "job_quoted") {
      if (prev?.quotedMs != null) return this.repeat();
      const claim = prev?.txHash ? null : this.store.claimByRoute(e.network, releaseRoute(e.jobId));
      const base: JobRow = prev ?? { jobId: e.jobId, network: e.network, state: "quoted", amount: null, totalUsd: null, quotedMs: null, expiresMs: null, paidMs: null, releasedMs: null, expiredMs: null, txHash: null, breakdown: null, steps: null, receivedMs: t };
      next = { ...base, amount: e.amount, totalUsd: e.totalUsd, quotedMs: e.tsMs, expiresMs: e.expiresMs, breakdown: e.breakdown, steps: e.steps };
      if (claim) next = { ...next, state: next.state === "released" ? "released" : "paid", paidMs: claim.tsMs, txHash: claim.hash };
    } else if (e.event === "job_released") {
      if (prev?.releasedMs != null) return this.repeat();
      next = { ...(prev ?? this.blank(e.jobId, e.network, t)), state: "released", releasedMs: e.tsMs };
    } else {
      if (prev?.expiredMs != null) return this.repeat();
      const p = prev ?? this.blank(e.jobId, e.network, t);
      // A paid or released job keeps its state: the payment is on chain whatever the console's clock says.
      next = { ...p, expiredMs: e.tsMs, state: p.txHash || p.state === "released" ? p.state : "expired" };
    }
    this.store.putJob(next);
    this.counters.events += 1;
    this.emit(next);
    return { isNew: true };
  }

  /** A newly stored claim: link it when its route is a job's release route. */
  onClaim(claim: ClaimRow): void {
    const m = claim.route ? RELEASE_ROUTE.exec(claim.route) : null;
    if (!m) return;
    const jobId = m[1];
    const prev = this.store.getJob(jobId);
    if (prev?.txHash) return; // already linked (one payment per job)
    let next: JobRow;
    if (!prev) {
      next = { ...this.blank(jobId, claim.network, this.now()), state: "paid", paidMs: claim.tsMs, txHash: claim.hash };
      this.counters.unknownClaims += 1;
      if (!this.unknownAlerted.has(jobId)) {
        this.unknownAlerted.add(jobId);
        this.bus.alert("warn", "job_unknown", `claim ${claim.hash} pays job ${jobId}, which near-watch has no job_quoted for (shown as paid, no job event)`, claim.network);
      }
    } else {
      next = { ...prev, paidMs: claim.tsMs, txHash: claim.hash, state: prev.state === "released" ? "released" : "paid" };
    }
    this.store.putJob(next);
    this.emit(next);
  }

  /** A reconcile change on a job's transfer: re-send the job so a console sees its new reconcile state. */
  onReconcile(network: string, hash: string): void {
    const job = this.store.jobByTx(network, hash);
    if (job) this.emit(job);
  }

  view(job: JobRow): JobView {
    const claim = job.txHash ? this.store.getClaim(job.network, job.txHash) : undefined;
    const recon = job.txHash ? this.store.getRecon(job.network, job.txHash) : undefined;
    return { ...job, noJobEvent: job.quotedMs === null, invoiceId: claim?.invoiceId ?? null, payer: claim?.payer ?? null, reconcile: recon?.state ?? null };
  }

  summary(network?: string): JobsSummary {
    const lost: Record<string, string> = {};
    for (const n of network ? [network] : this.networks) {
      let micros = 0n;
      for (const b of this.store.expiredBreakdowns(n)) micros += lostOf(b);
      lost[n] = usdText(micros);
    }
    return { counts: this.store.jobCounts(network), lostCompute: lost };
  }

  /** The snapshot's `jobs`: only when at least one job exists (ARCH-201: no new key otherwise). */
  snapshot(limit: number): { counts: JobCounts; recent: JobView[]; lostCompute: Record<string, string> } | null {
    if (!this.store.hasJobs()) return null;
    return { ...this.summary(), recent: this.store.recentJobs(limit).map((j) => this.view(j)) };
  }

  private blank(jobId: string, network: string, t: number): JobRow {
    return { jobId, network, state: "quoted", amount: null, totalUsd: null, quotedMs: null, expiresMs: null, paidMs: null, releasedMs: null, expiredMs: null, txHash: null, breakdown: null, steps: null, receivedMs: t };
  }

  private repeat(): { isNew: boolean } {
    this.counters.repeats += 1;
    return { isNew: false };
  }

  private emit(job: JobRow): void {
    this.bus.emit("job", { job: this.view(job), summary: this.summary(job.network) });
  }
}
