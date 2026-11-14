/**
 * Paid jobs (architecture-adminui-jobs.md ARCH-206..208): the private-ai test console's job events in, one row per job
 * out, joined to the paywall's claim for that job and through it to the chain transfer and its reconcile state.
 *
 *   job_quoted    {v:1, event, ts, jobId, network, amount, totalUsd, expiresAt, steps[], breakdown{}}
 *   job_released  {v:1, event, ts, jobId, network}
 *   job_expired   {v:1, event, ts, jobId, network}
 *   job_attested  {v:1, event, ts, jobId, network, summary, calls[]}   (PLAN-adminui-nearai-attestation.md ARCH-501..503:
 *                 the NEAR AI model attestation result private-ai's ca-attest verified; near-watch only stores and shows it)
 *   job_receipt   {v:1, event, ts, jobId, network, receiptId, keyId, resultSha256, filesRoot, settled, transaction}
 *                 (ARCH-701: the console's signed Job Evidence Receipt, privateAI-design-32 ARCH-615; ids and hashes only)
 *   job_quoted may carry ap2 {kid, merchantAuthSha256} (ARCH-702: the quote was signed as an AP2 merchant authorization,
 *                 privateAI-design-33 ARCH-628; the key id and the hash of the signature only)
 *   job_receipt may carry mandate {kid, tenant, sha256} (ARCH-704: the buyer agent's AP2 checkout mandate the receipt
 *                 records, verified by ChainAim's signer before the job ran; privateAI-design-42 ARCH-710; the tenant's key
 *                 id, the tenant id and the mandate's hash only, never the mandate, its nonce or an account)
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
export const JOB_EVENTS = ["job_quoted", "job_released", "job_expired", "job_attested", "job_receipt"] as const;
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

/**
 * NEAR AI model attestation of a job (ARCH-501): verified elsewhere (private-ai ca-attest), stored and shown here.
 * unavailable (owner decision 2026-11-06): the evidence could not be obtained yet (signature not ready, ca-attest
 * unreachable), as distinct from unverified (a check ran and failed). Neither is trusted; a later job_attested replaces it.
 */
export const ATTEST_SUMMARIES = ["attested", "partial", "unverified", "unavailable", "not_applicable"] as const;
export type AttestSummary = (typeof ATTEST_SUMMARIES)[number];
export const ATTEST_STATUSES = ["verified", "unverified", "unavailable", "not_applicable"] as const;
export type AttestStatus = (typeof ATTEST_STATUSES)[number];
/**
 * One model call's evidence: ids, an address, a report time, check results (null = not checked) and a short reason.
 * Fix 4 (2026-11-07): signedText and signatureHex let anyone re-check the reply signature themselves. signedText is
 * NEAR AI's signed string "<servedModel>:<sha256 request>:<sha256 response>" (or "<req>:<resp>"): a model id and two
 * hashes, never request or reply text. Both are null on events from consoles that do not send them (and on stored rows
 * from before; see withEvidence).
 */
export type AttestedCall = {
  step: "query" | "answer"; model: string; servedModel: string | null; providerId: string | null;
  signatureKind: "provider_tee" | "gateway" | null; signingAlgo: "ecdsa" | "ed25519" | null; signingAddress: string | null;
  reportFetchedMs: number | null; tdx: boolean | null; gpu: boolean | null; signature: boolean | null; hashes: boolean | null;
  status: AttestStatus; reason: string | null;
  signedText: string | null; signatureHex: string | null;
};
/** A stored call from before fix 4 lacks signedText / signatureHex: read them as null so every view has the same shape. */
export const withEvidence = (calls: readonly AttestedCall[]): AttestedCall[] => calls.map((c) => ({ ...c, signedText: c.signedText ?? null, signatureHex: c.signatureHex ?? null }));
export type JobAttestation = { tsMs: number; summary: AttestSummary; calls: AttestedCall[]; receivedMs: number };

/** ARCH-702: the job's quote was signed (AP2 merchant authorization): the signing key id and the signature's SHA-256. */
export type SignedQuote = { kid: string; merchantAuthSha256: string };
/** ARCH-701: the job's signed receipt as the console reported it: ids, hashes, and the settlement transaction when attached. */
export type JobReceipt = { tsMs: number; receiptId: string; keyId: string; resultSha256: string; filesRoot: string; settled: boolean; transaction: string | null; receivedMs: number };
/** ARCH-704: the buyer agent's checkout mandate the job's receipt records: the tenant's key id, the tenant id, the mandate's SHA-256. */
export type ReceiptMandate = { kid: string; tenant: string; sha256: string };

export type JobEventInput =
  | { event: "job_quoted"; tsMs: number; jobId: string; network: string; amount: string; totalUsd: string; expiresMs: number; steps: JobStep[]; breakdown: JobBreakdown; ap2?: SignedQuote }
  | { event: "job_receipt"; tsMs: number; jobId: string; network: string; receiptId: string; keyId: string; resultSha256: string; filesRoot: string; settled: boolean; transaction: string | null; mandate?: ReceiptMandate }
  | { event: "job_released" | "job_expired"; tsMs: number; jobId: string; network: string }
  | { event: "job_attested"; tsMs: number; jobId: string; network: string; summary: AttestSummary; calls: AttestedCall[] };

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

// ---- job_attested (ARCH-501) ----

/** NEAR AI chat id / provider id: an id, never text. */
const PROVIDER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** ecdsa signer: an Ethereum-style address; ed25519 signer: a 32-byte public key in hex. */
const ECDSA_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ED25519_KEY = /^(0x)?[0-9a-fA-F]{64}$/;
/** A verifier's short reason: printable ASCII on one line, at most 200 characters. */
const REASON = /^[\x20-\x7E]{1,200}$/;
/** NEAR AI's signed text: optional model id, then two lowercase SHA-256 hex hashes. Nothing else fits. */
const SIGNED_TEXT = /^(?:[A-Za-z0-9._:\/@-]{1,128}:)?[0-9a-f]{64}:[0-9a-f]{64}$/;
const SIGNED_TEXT_MAX = 128 + 1 + 64 + 1 + 64;
/** ecdsa: 65 bytes r||s||v; ed25519: 64 bytes. Hex, optional 0x. */
const ECDSA_SIG = /^(0x)?[0-9a-fA-F]{130}$/;
const ED25519_SIG = /^(0x)?[0-9a-fA-F]{128}$/;
const ATTESTED_CALL_FIELDS = ["step", "model", "servedModel", "providerId", "signatureKind", "signingAlgo", "signingAddress", "reportFetchedAt", "tdx", "gpu", "signature", "hashes", "status", "reason", "signedText", "signatureHex"];

const isNone = (v: unknown): boolean => v === undefined || v === null;
function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new IngestError(`${field} must be one of ${allowed.join(", ")}`);
  return v as T;
}
/** true / false = checked and passed / failed; null (or absent) = not checked. */
function check(v: unknown, field: string): boolean | null {
  if (isNone(v)) return null;
  if (typeof v !== "boolean") throw new IngestError(`${field} must be true, false or null`);
  return v;
}

function parseAttestedCall(v: unknown, i: number): AttestedCall {
  const at = `calls[${i}]`;
  if (!isObj(v)) throw new IngestError(`${at} must be an object`);
  only(v, ATTESTED_CALL_FIELDS, at);
  const signingAlgo = isNone(v.signingAlgo) ? null : oneOf(v.signingAlgo, `${at}.signingAlgo`, ["ecdsa", "ed25519"] as const);
  let signingAddress: string | null = null;
  if (!isNone(v.signingAddress)) {
    if (signingAlgo === null) throw new IngestError(`${at}.signingAddress needs ${at}.signingAlgo`);
    signingAddress = signingAlgo === "ecdsa" ? str(v.signingAddress, `${at}.signingAddress`, ECDSA_ADDRESS, 42) : str(v.signingAddress, `${at}.signingAddress`, ED25519_KEY, 66);
  }
  let signatureHex: string | null = null;
  if (!isNone(v.signatureHex)) {
    if (signingAlgo === null) throw new IngestError(`${at}.signatureHex needs ${at}.signingAlgo`);
    signatureHex = signingAlgo === "ecdsa" ? str(v.signatureHex, `${at}.signatureHex`, ECDSA_SIG, 132) : str(v.signatureHex, `${at}.signatureHex`, ED25519_SIG, 130);
  }
  return {
    step: oneOf(v.step, `${at}.step`, ["query", "answer"] as const),
    model: str(v.model, `${at}.model`, MODEL_ID, 128),
    servedModel: isNone(v.servedModel) ? null : str(v.servedModel, `${at}.servedModel`, MODEL_ID, 128),
    providerId: isNone(v.providerId) ? null : str(v.providerId, `${at}.providerId`, PROVIDER_ID, 128),
    signatureKind: isNone(v.signatureKind) ? null : oneOf(v.signatureKind, `${at}.signatureKind`, ["provider_tee", "gateway"] as const),
    signingAlgo,
    signingAddress,
    reportFetchedMs: isNone(v.reportFetchedAt) ? null : isoMs(v.reportFetchedAt, `${at}.reportFetchedAt`),
    tdx: check(v.tdx, `${at}.tdx`),
    gpu: check(v.gpu, `${at}.gpu`),
    signature: check(v.signature, `${at}.signature`),
    hashes: check(v.hashes, `${at}.hashes`),
    status: oneOf(v.status, `${at}.status`, ATTEST_STATUSES),
    reason: isNone(v.reason) ? null : str(v.reason, `${at}.reason`, REASON, 200),
    signedText: isNone(v.signedText) ? null : str(v.signedText, `${at}.signedText`, SIGNED_TEXT, SIGNED_TEXT_MAX),
    signatureHex,
  };
}

// ---- job_receipt (ARCH-701) and job_quoted.ap2 (ARCH-702) ----

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** A NEAR transaction hash: base58, as claims carry it. */
const NEAR_TX = /^[1-9A-HJ-NP-Za-km-z]{20,100}$/;

/** A tenant id as private-ai's mandate key registry names one (packages/ap2 mandate.ts parseMandateRegistry). */
const TENANT = /^[a-z0-9_-]{1,32}$/;

function parseReceiptMandate(v: unknown): ReceiptMandate {
  if (!isObj(v)) throw new IngestError("mandate must be an object {kid, tenant, sha256}");
  only(v, ["kid", "tenant", "sha256"], "mandate");
  return { kid: str(v.kid, "mandate.kid", HEX32, 32), tenant: str(v.tenant, "mandate.tenant", TENANT, 32), sha256: str(v.sha256, "mandate.sha256", HEX64, 64) };
}

function parseSignedQuote(v: unknown): SignedQuote {
  if (!isObj(v)) throw new IngestError("ap2 must be an object {kid, merchantAuthSha256}");
  only(v, ["kid", "merchantAuthSha256"], "ap2");
  return { kid: str(v.kid, "ap2.kid", HEX32, 32), merchantAuthSha256: str(v.merchantAuthSha256, "ap2.merchantAuthSha256", HEX64, 64) };
}

export function parseJobEvent(input: unknown, caips: CaipMap): JobEventInput {
  if (!isObj(input)) throw new IngestError("a job event must be a JSON object");
  if (input.v !== 1) throw new IngestError("v must be 1");
  const event = input.event;
  if (typeof event !== "string" || !(JOB_EVENTS as readonly string[]).includes(event)) throw new IngestError(`event must be one of ${JOB_EVENTS.join(", ")}`);
  if (typeof input.jobId !== "string" || !JOB_ID.test(input.jobId)) throw new IngestError("jobId must be 32 lowercase hex characters");
  const base = { tsMs: isoMs(input.ts, "ts"), jobId: input.jobId, network: watchedNetwork(input.network, caips) };
  if (event === "job_attested") {
    only(input, ["v", "event", "ts", "jobId", "network", "summary", "calls"], event);
    if (!Array.isArray(input.calls) || input.calls.length > MAX_STEPS) throw new IngestError(`calls must be a list of at most ${MAX_STEPS}`);
    return { event, ...base, summary: oneOf(input.summary, "summary", ATTEST_SUMMARIES), calls: input.calls.map(parseAttestedCall) };
  }
  if (event === "job_receipt") {
    only(input, ["v", "event", "ts", "jobId", "network", "receiptId", "keyId", "resultSha256", "filesRoot", "settled", "transaction", "mandate"], event);
    if (typeof input.settled !== "boolean") throw new IngestError("settled must be true or false");
    const transaction = isNone(input.transaction) ? null : str(input.transaction, "transaction", NEAR_TX, 100);
    if (input.settled !== (transaction !== null)) throw new IngestError("a settled receipt names its transaction, and only a settled one does");
    return {
      event, ...base,
      receiptId: str(input.receiptId, "receiptId", HEX32, 32), keyId: str(input.keyId, "keyId", HEX32, 32),
      resultSha256: str(input.resultSha256, "resultSha256", HEX64, 64), filesRoot: str(input.filesRoot, "filesRoot", HEX64, 64),
      settled: input.settled, transaction,
      ...(input.mandate !== undefined ? { mandate: parseReceiptMandate(input.mandate) } : {}),
    };
  }
  if (event !== "job_quoted") {
    only(input, ["v", "event", "ts", "jobId", "network"], event);
    return { event: event as "job_released" | "job_expired", ...base };
  }
  only(input, ["v", "event", "ts", "jobId", "network", "amount", "totalUsd", "expiresAt", "steps", "breakdown", "ap2"], event);
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
    ...(input.ap2 !== undefined ? { ap2: parseSignedQuote(input.ap2) } : {}),
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
  /** The NEAR AI model attestation (ARCH-503): present only when a job_attested was stored for this job. */
  attestation?: JobAttestation;
  /** ARCH-702: present only when the job's job_quoted carried ap2 (the quote was signed). */
  signedQuote?: SignedQuote;
  /** ARCH-701: present only when a job_receipt was stored for this job. */
  receipt?: JobReceipt;
  /** ARCH-704: present only when a stored job_receipt carried the buyer agent's checkout mandate. */
  mandate?: ReceiptMandate;
};
export type JobCounts = Record<JobState, number>;
/** attestation: known jobs per attestation summary; present only once any job_attested is stored. */
export type JobsSummary = { counts: JobCounts; lostCompute: Record<string, string>; attestation?: Record<AttestSummary, number> };

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
    if (e.event === "job_attested") return this.attested(e, prev, t);
    if (e.event === "job_receipt") return this.receipted(e, prev, t);
    let next: JobRow;
    if (e.event === "job_quoted") {
      if (prev?.quotedMs != null) return this.repeat();
      const claim = prev?.txHash ? null : this.store.claimByRoute(e.network, releaseRoute(e.jobId));
      const base: JobRow = prev ?? { jobId: e.jobId, network: e.network, state: "quoted", amount: null, totalUsd: null, quotedMs: null, expiresMs: null, paidMs: null, releasedMs: null, expiredMs: null, txHash: null, breakdown: null, steps: null, receivedMs: t };
      next = { ...base, amount: e.amount, totalUsd: e.totalUsd, quotedMs: e.tsMs, expiresMs: e.expiresMs, breakdown: e.breakdown, steps: e.steps };
      // ARCH-702: stored before the job is emitted, so the stream shows the signed quote with the quote.
      if (e.ap2) this.store.putSignedQuote(e.jobId, e.network, e.ap2);
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

  /**
   * job_attested (ARCH-501/502): stored against the job id whether or not the job is known yet (it may arrive before
   * job_quoted, after job_released, or after a restart). The newest event per job wins; an older or identical one is a
   * repeat. The job is re-sent on the stream only when near-watch already has it.
   */
  private attested(e: Extract<JobEventInput, { event: "job_attested" }>, job: JobRow | undefined, t: number): { isNew: boolean } {
    const prev = this.store.getAttestation(e.jobId);
    if (prev && prev.network !== e.network) throw new IngestError(`job ${e.jobId} is on ${prev.network}, not ${e.network}`);
    if (prev && (prev.tsMs > e.tsMs || (prev.tsMs === e.tsMs && prev.summary === e.summary && JSON.stringify(withEvidence(prev.calls)) === JSON.stringify(e.calls)))) return this.repeat();
    this.store.putAttestation(e.jobId, e.network, { tsMs: e.tsMs, summary: e.summary, calls: e.calls, receivedMs: t });
    this.counters.events += 1;
    if (job) this.emit(job);
    return { isNew: true };
  }

  /**
   * job_receipt (ARCH-701): stored against the job id whether or not the job is known yet, like job_attested. A settled
   * receipt replaces an unsettled one; the same or an older event is a repeat. Re-sent on the stream when the job is known.
   */
  private receipted(e: Extract<JobEventInput, { event: "job_receipt" }>, job: JobRow | undefined, t: number): { isNew: boolean } {
    const prev = this.store.getReceipt(e.jobId);
    if (prev && prev.network !== e.network) throw new IngestError(`job ${e.jobId} is on ${prev.network}, not ${e.network}`);
    if (prev && (prev.settled && !e.settled || (prev.settled === e.settled && prev.tsMs >= e.tsMs))) return this.repeat();
    this.store.putReceipt(e.jobId, e.network, { tsMs: e.tsMs, receiptId: e.receiptId, keyId: e.keyId, resultSha256: e.resultSha256, filesRoot: e.filesRoot, settled: e.settled, transaction: e.transaction, receivedMs: t });
    // ARCH-704: the receipt's mandate, kept beside it; a receipt that replaces it without one leaves no stale mandate.
    if (e.mandate) this.store.putMandate(e.jobId, e.network, e.mandate);
    else this.store.dropMandate(e.jobId);
    this.counters.events += 1;
    if (job) this.emit(job);
    return { isNew: true };
  }

  view(job: JobRow): JobView {
    const claim = job.txHash ? this.store.getClaim(job.network, job.txHash) : undefined;
    const recon = job.txHash ? this.store.getRecon(job.network, job.txHash) : undefined;
    const att = this.store.getAttestation(job.jobId);
    const sq = this.store.getSignedQuote(job.jobId);
    const rc = this.store.getReceipt(job.jobId);
    const md = rc ? this.store.getMandate(job.jobId) : undefined;
    // `attestation` only when one is stored (ARCH-503): a job without one is exactly as before.
    return {
      ...job, noJobEvent: job.quotedMs === null, invoiceId: claim?.invoiceId ?? null, payer: claim?.payer ?? null, reconcile: recon?.state ?? null,
      ...(att ? { attestation: { tsMs: att.tsMs, summary: att.summary, calls: withEvidence(att.calls), receivedMs: att.receivedMs } } : {}),
      // ARCH-701 / ARCH-702: only when stored, so a job without them is exactly as before.
      ...(sq ? { signedQuote: { kid: sq.kid, merchantAuthSha256: sq.merchantAuthSha256 } } : {}),
      ...(rc ? { receipt: { tsMs: rc.tsMs, receiptId: rc.receiptId, keyId: rc.keyId, resultSha256: rc.resultSha256, filesRoot: rc.filesRoot, settled: rc.settled, transaction: rc.transaction, receivedMs: rc.receivedMs } } : {}),
      // ARCH-704: only when the stored receipt carried one, so a job without it is exactly as before.
      ...(md ? { mandate: { kid: md.kid, tenant: md.tenant, sha256: md.sha256 } } : {}),
    };
  }

  summary(network?: string): JobsSummary {
    const lost: Record<string, string> = {};
    for (const n of network ? [network] : this.networks) {
      let micros = 0n;
      for (const b of this.store.expiredBreakdowns(n)) micros += lostOf(b);
      lost[n] = usdText(micros);
    }
    // `attestation` (jobs per attestation summary) only once any attestation is stored (ARCH-503).
    return { counts: this.store.jobCounts(network), lostCompute: lost, ...(this.store.hasAttestations() ? { attestation: this.store.attestationCounts(network) } : {}) };
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
