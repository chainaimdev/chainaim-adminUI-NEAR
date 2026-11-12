/**
 * The SSE and REST contract of services/near-watch, mirrored from its src/events.ts (event names and payloads),
 * src/decode.ts (Row), src/store.ts (ClaimRow, TraceRow, ReconRow, Road), src/seller.ts (SellerWallet),
 * src/metrics.ts (Metrics), src/server.ts (routes, snapshot, tx entries decorated with network + links from
 * src/links.ts), src/liveops.ts (TraceView) and src/main.ts (feedsReport = /api/feeds, the `status` event).
 *
 * NEAR facts that differ from the XRPL console:
 *   - a tx hash is base58 and CASE-SENSITIVE: it is compared and shown exactly as sent (never upper-cased)
 *   - `ledger.index` is a NEAR final block height
 *   - Row.amount and ClaimRow.amount are base units (integer strings); Row.value and every other money field are
 *     decimal strings. Nothing here is a float.
 * Times are ms since the Unix epoch.
 */
export type Road = "neardata" | "qn-rpc" | "rpc" | "backfill";
/** near-watch src/store.ts ROADS, same order. Stored in SQLite and never renamed. */
export const ROADS: readonly Road[] = ["neardata", "qn-rpc", "rpc", "backfill"];

export type ProviderState = "connecting" | "live" | "stale" | "down";

/** One final NEAR block (index = height). `ourAmount` is the decimal sum of our x402 transfers in it. */
export type LedgerEvent = { network: string; index: number; closeTime: number | null; txCount: number | null; ourCount: number; ourAmount: string; via?: Road };

export type RoadCount = { first: number; total: number };

/** One road's live state (near-watch src/feeds/adapter.ts BlockLoop.status). */
export type RoadStatus = { road: Road; state: ProviderState; provider: string; lastBlock: number | null; lastBlockAgeMs: number | null; lagBlocks: number | null; errors: number; reset: boolean };

export type StatusEvent = {
  network: string;
  /** The live road that most recently delivered a block first ("none" when no road runs). */
  provider: string;
  /** Redacted origin of that road's endpoint (near-watch strips tokens and keys). */
  providerUrl: string;
  state: ProviderState;
  /** Highest final block height any road has delivered. */
  lastLedger: number | null;
  lastLedgerAgeMs: number | null;
  roads: Partial<Record<Road, RoadCount>>;
  /** Every road's own state, backfill included while it runs. */
  feeds: RoadStatus[];
  failovers: number;
  at: number;
};

/** One watched account's balances: NEAR and the token (decimal + base units), and its NEP-145 storage registration. */
export type BalanceEntry = {
  network: string;
  label: string;
  role: string;
  address: string;
  near: string | null;
  asset: { code: string; contract: string; value: string | null; units: string | null };
  registered: boolean | null;
  callsLeft: number | null;
  error: string | null;
  at: number;
};

export type AlertEvent = { level: "info" | "warn" | "error"; code: string; message: string; network?: string; at: number };

/** Explorer links built by near-watch (src/links.ts). The browser never builds a URL. */
export type Links = Partial<Record<"tx" | "account" | "destination", string | null>>;

/** One decoded NEP-141 transfer (near-watch src/decode.ts Row). */
export type Row = {
  network: string;
  /** base58, case-sensitive: the join key with the paywall's claim. */
  hash: string;
  blockHeight: number;
  blockTimeMs: number | null;
  receiptId: string;
  contract: string;
  method: string | null;
  from: string;
  to: string;
  /** Base units, integer string. */
  amount: string;
  /** The same amount as a decimal string (token decimals). */
  value: string;
  /** NEP-141 memo when present; an x402 NEAR transfer carries none (data only, never matched). */
  memo: string | null;
  status: "success" | "failure";
  final: boolean;
  isUsdc: boolean;
  isX402: boolean;
  events: number;
};

/** `source` is where near-watch got the account ("paywall" = NEAR_PAY_TO_<NET>, "flag" = --watch; src/watchlist.ts). */
export type WatchEntry = { label: string; role: string; address: string; network: string; source?: string };

/** One entry of `hello.txs` / `/api/txs` (store.recentTxs, decorated with network + links). */
export type SnapshotTx = { row: Row; firstVia: Road; firstSeenMs: number; network?: string; links?: Links };

/** A payment the paywall says it settled. `amount` is BASE UNITS; `asset` is the token contract id. */
export type ClaimRow = {
  network: string;
  hash: string;
  invoiceId: string | null;
  amount: string;
  asset: string | null;
  payer: string | null;
  route: string | null;
  tsMs: number;
  source: string;
  receivedMs: number;
  seenBlock: number | null;
};

export type TraceRow = {
  invoiceId: string;
  step: number;
  network: string | null;
  tenant: string | null;
  payer: string | null;
  tsMs: number;
  ms: number | null;
  status: number | null;
  txHash: string | null;
  receivedMs: number;
};

export type ReconState = "matched" | "pending" | "only_in_log" | "only_on_ledger" | "mismatch";
export const RECON_STATES: readonly ReconState[] = ["matched", "pending", "only_in_log", "only_on_ledger", "mismatch"];
export const GAP_STATES: readonly ReconState[] = ["only_in_log", "only_on_ledger", "mismatch"];
/** near-watch store ReconRow (REST /api/reconcile rows, hello.liveOps.reconcile.recent). side: "log" | "ledger". */
export type ReconRow = { network: string; hash: string; state: ReconState; side: string; invoiceId: string | null; detail: string | null; sinceMs: number; updatedMs: number };

export type Spread = { count: number; p50: number | null; p95: number | null; max: number | null };
export type PayerStat = { payer: string; label: string | null; calls: number; amount: string };
export type NetworkMetrics = {
  claimsLastMinute: number;
  claimsInWindow: number;
  paidInWindow: number;
  paidAmountInWindow: string;
  payers: PayerStat[];
  reconcile: Record<ReconState, number>;
  settleLagMs: Spread;
};
export type Metrics = { at: number; windowSec: number; networks: Record<string, NetworkMetrics>; endToEndMs: Spread };

/** Seller Wallet (near-watch src/seller.ts). Decimal strings except `units`. */
export type SellerPayment = {
  hash: string;
  blockHeight: number;
  blockTimeMs: number | null;
  firstSeenMs: number;
  firstVia: Road;
  from: string;
  label: string | null;
  amount: string;
  units: string;
  memo: string | null;
  isX402: boolean;
  watched: boolean;
};
export type SellerBuyer = { address: string; label: string; received: string; count: number; x402Count: number; manualCount: number; inFlight: string; inFlightCount: number; lastMs: number | null };
export type SellerWallet = {
  network: string;
  address: string;
  label: string;
  asset: { code: string; contract: string; decimals: number };
  balance: { amount: string | null; near: string | null; registered: boolean | null; at: number | null; error: string | null };
  received: { amount: string; units: string; count: number; x402Count: number; x402Amount: string; manualCount: number; manualAmount: string; fromBlock: number | null };
  inFlight: { amount: string; count: number; claims: number; rig: number; estimated: boolean };
  expected: string;
  window: { sec: number; count: number; amount: string; buyers: number };
  buyers: SellerBuyer[];
  unwatched: { count: number; amount: string; recent: SellerPayment[] };
  recent: SellerPayment[];
};
export type SellerEvent = { at: number; wallets: SellerWallet[] };

export type Snapshot = {
  version: string;
  startedAt: number;
  networks: string[];
  watchlist: WatchEntry[];
  status: Record<string, StatusEvent>;
  ledgers: Record<string, LedgerEvent[]>;
  balances: { entries: BalanceEntry[] };
  alerts: AlertEvent[];
  txs: SnapshotTx[];
  counters: unknown;
  liveOps?: { claims: ClaimRow[]; reconcile: { counts: Record<ReconState, number>; recent: ReconRow[] }; metrics: Metrics; counters: unknown };
  seller?: SellerEvent;
  /** The token near-watch counts (from ft_metadata at its start-up). */
  token?: { contract: string; symbol: string; decimals: number };
  /** Paid jobs (architecture-adminui-jobs.md ARCH-208): present only once near-watch holds a job. */
  jobs?: { counts: Record<JobState, number>; recent: JobView[]; lostCompute: Record<string, string>; attestation?: Record<AttestSummary, number> };
};

/** Paid jobs (near-watch src/jobs.ts). Ids, times, amounts, model ids, zones and counts only: no text is ever sent. */
export const JOB_STATES = ["quoted", "paid", "released", "expired"] as const;
export type JobState = (typeof JOB_STATES)[number];
export type JobStep =
  | { name: "analyst"; ms: number; files: number; relations: number }
  | {
      name: "query" | "answer"; ms: number; model: string; zone: string | null; promptTokens: number; completionTokens: number; usd: string;
      entityCounts: Record<string, number> | null; residual: "pass" | "refused" | null;
    }
  | { name: "sql"; ms: number; rows: number };
export type JobBreakdown = {
  calls: { model: string; promptTokens: number; completionTokens: number; usd: string }[];
  modelUsd: string; callFeesUsd: string; analystUsd: string; nearGasUsd: string; marginPct: string; minPriceUsd: string; minApplied: boolean;
  /** Before the margin, and with the margin before the minimum; absent for jobs quoted before they were reported. */
  subtotalUsd?: string; withMarginUsd?: string;
};
export type JobView = {
  jobId: string; network: string; state: JobState;
  /** USDC base units (6 decimals) and the same total in USD; null for a job known only from its claim. */
  amount: string | null; totalUsd: string | null;
  quotedMs: number | null; expiresMs: number | null; paidMs: number | null; releasedMs: number | null; expiredMs: number | null;
  txHash: string | null; breakdown: JobBreakdown | null; steps: JobStep[] | null; receivedMs: number;
  /** A claim paid this job but near-watch never received its job_quoted. */
  noJobEvent: boolean;
  invoiceId: string | null; payer: string | null; reconcile: ReconState | null;
  /** NEAR AI model attestation (PLAN-adminui-nearai-attestation.md ARCH-503): only when near-watch stored a job_attested. */
  attestation?: JobAttestation;
  /** ARCH-702 (near-watch): the quote was signed (AP2 merchant authorization); key id and signature hash only. */
  signedQuote?: { kid: string; merchantAuthSha256: string };
  /** ARCH-701 (near-watch): the job's signed receipt as the console reported it; ids and hashes only. */
  receipt?: { tsMs: number; receiptId: string; keyId: string; resultSha256: string; filesRoot: string; settled: boolean; transaction: string | null; receivedMs: number };
};
/**
 * NEAR AI model attestation, as private-ai's ca-attest verified it (near-watch src/jobs.ts): ids, an address, times, checks.
 * unavailable: the evidence could not be obtained yet (not a failed check); never shown as attested.
 */
export const ATTEST_SUMMARIES = ["attested", "partial", "unverified", "unavailable", "not_applicable"] as const;
export type AttestSummary = (typeof ATTEST_SUMMARIES)[number];
export type AttestedCall = {
  step: "query" | "answer"; model: string; servedModel: string | null; providerId: string | null;
  signatureKind: "provider_tee" | "gateway" | null; signingAlgo: "ecdsa" | "ed25519" | null; signingAddress: string | null;
  /** null = not checked */
  reportFetchedMs: number | null; tdx: boolean | null; gpu: boolean | null; signature: boolean | null; hashes: boolean | null;
  status: "verified" | "unverified" | "unavailable" | "not_applicable"; reason: string | null;
  /**
   * Fix 4: the text NEAR AI signed ("<servedModel>:<sha256 request>:<sha256 response>", a model id and two hashes)
   * and the signature in hex, so anyone can re-check it. Absent from an older near-watch; null when not sent.
   */
  signedText?: string | null; signatureHex?: string | null;
};
export type JobAttestation = { tsMs: number; summary: AttestSummary; calls: AttestedCall[]; receivedMs: number };
/** attestation: known jobs per attestation summary, present only once near-watch stored any job_attested. */
export type JobsSummary = { counts: Record<JobState, number>; lostCompute: Record<string, string>; attestation?: Record<AttestSummary, number> };
export type JobEvent = { job: JobView; summary: JobsSummary };

export type TxEvent = { row: Row; via: Road; lagMs: number | null; network?: string; links?: Links };
export type RoadEvent = { network: string; hash: string; via: Road; lagMs: number; firstVia: Road };
export type BalancesEvent = { entries: BalanceEntry[] };
export type ClaimEvent = { claim: ClaimRow };
export type TraceEvent = { trace: TraceRow; stepName: string; txHash: string | null };
export type ReconcileEvent = { network: string; hash: string; invoiceId: string | null; state: ReconState; previous: ReconState | null; side: string; detail: string | null; at: number };

export type EventMap = {
  hello: Snapshot;
  ledger: LedgerEvent;
  tx: TxEvent;
  road: RoadEvent;
  balances: BalancesEvent;
  status: StatusEvent;
  alert: AlertEvent;
  claim: ClaimEvent;
  trace: TraceEvent;
  reconcile: ReconcileEvent;
  seller: SellerEvent;
  job: JobEvent;
};
export type EventName = keyof EventMap;

export const EVENT_NAMES: readonly EventName[] = ["hello", "ledger", "tx", "road", "balances", "status", "alert", "claim", "trace", "reconcile", "seller", "job"];

/** /api/feeds (near-watch src/main.ts feedsReport; adapter catalogue from src/feeds/adapter.ts). */
export type FeedAdapter = { id: string; kind: string; provider: string; built: boolean; description: string; selected: boolean; available: boolean; reason: string | null };
/** One road in the feeds report: its live status plus its redacted endpoint host and, for backfill, whether it is done. */
export type FeedRoad = RoadStatus & { host: string | null; done: boolean };
export type FeedsNetwork = {
  selected: string[];
  skipped: { road: string; reason: string }[];
  adapters: FeedAdapter[];
  roads: FeedRoad[];
  stats: Partial<Record<Road, RoadCount>>;
  /** Delay behind the first road, per road, over every later arrival (store.roadLags). */
  lags: Partial<Record<string, { later: number; meanMs: number | null; maxMs: number | null }>>;
  backfill: { from: number; to: number; truncated: number; source: string; done: boolean; at: number | null } | null;
  explorer: string | null;
  token: { contract: string; decimals: number; symbol: string };
  caip2: string;
  /** --settle-grace-blocks as near-watch applies it (src/reconcile.ts graceReport). */
  reconcile?: GraceReport;
  /** RPC roads' read-ahead (--rpc-prefetch; 1 = serial). */
  rpcPrefetch?: number;
};
export type GraceReport = {
  graceBlocks: number;
  defaultBlocks: number;
  blockMs: number | null;
  graceMs: number | null;
  trailMs: number | null;
  trailBlocks: number | null;
  tradeoff: string;
  warning: string | null;
};
export type FeedsReport = { networks: Record<string, FeedsNetwork> };

/** Steps of one paid call (near-watch src/traces.ts TRACE_STEPS; 4 = the paywall's settle, seen from its claim). */
export const STEP_NAMES: Readonly<Record<number, string>> = { 1: "quoted", 2: "signed", 3: "sent", 4: "settled", 5: "answered" };
