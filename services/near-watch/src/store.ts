/**
 * Durable state in one SQLite file (node:sqlite, no native module). Ported from liveops
 * services/ledger-watch/src/store.ts; same tables and rules, NEAR names:
 *   txs     one row per (network, tx hash): the decoded Row, which road saw it first, and when
 *   roads   every (network, hash, road) arrival with its delay behind the first road
 *   cursors per (network, road): the highest final block that road has covered (only moves forward)
 *   claims  one row per (network, hash): a payment the paywall says it settled (payment_settled)
 *   traces  one row per (invoice_id, step): a buyer-side step the rig reported
 *   recon   one row per (network, hash): the reconcile state of a claim and/or chain transfer
 *   meta    schema, reconcile start block per network, the paywall log tail offset
 *   jobs    one row per paid job (architecture-adminui-jobs.md ARCH-206): its state, quote, steps and the tx hash of the
 *           claim that paid it; created only when job events or job claims arrive (CREATE IF NOT EXISTS, no other
 *           table changes, so the schema version stays 2)
 *   job_attestations  the newest NEAR AI model attestation per job (PLAN-adminui-nearai-attestation.md ARCH-502), likewise
 *           a new table only
 *   job_signed_quotes  the AP2 signed quote of a job (ARCH-702): key id and signature hash; a new table only
 *   job_receipts  the newest signed receipt per job (ARCH-701): ids and hashes; a new table only
 *   job_mandates  the checkout mandate that receipt records (ARCH-704): tenant key id, tenant id, hash; a new table only
 * A transfer is tied to an invoice only through its claim (same network and tx hash): an x402 NEAR transfer carries
 * no memo (chainiam-private-ai docs/NEAR-GATES.md G3), so the chain side has no invoice of its own.
 * Schema 2 (from 1): txs.invoice_id is gone, and stored rows are re-judged by the memo-free x402 rule (migrate1to2).
 * NEAR hashes are base58 and case-sensitive: they are stored and compared exactly as given (never upper-cased).
 * The first-road decision is a single INSERT ... ON CONFLICT DO NOTHING, so two roads delivering the same
 * transaction at once cannot both win.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Row } from "./decode.ts";
import { ATTEST_SUMMARIES, type AttestedCall, type AttestSummary, type JobAttestation, type JobBreakdown, type JobReceipt, type JobStep, type ReceiptMandate, type SignedQuote } from "./jobs.ts";

export const SCHEMA_VERSION = 2;

export type StoreOptions = {
  /** Watched pay-to accounts per network: needed only to migrate a schema-1 store (its rows' isX402 is re-judged). */
  payTo?: ReadonlyMap<string, ReadonlySet<string>>;
};

export type ClaimSource = "http" | "file";

/** A payment the paywall logged as settled. Amount in base units; times are ms since the epoch. */
export type ClaimRow = {
  network: string;
  hash: string;
  invoiceId: string | null;
  amount: string;
  asset: string | null;
  payer: string | null;
  route: string | null;
  tsMs: number;
  source: ClaimSource;
  receivedMs: number;
  /** The final block the watcher was at when the claim arrived; grace is counted from here. */
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

export const RECON_STATES = ["matched", "pending", "only_in_log", "only_on_ledger", "mismatch"] as const;
export type ReconState = (typeof RECON_STATES)[number];
export type ReconSide = "log" | "ledger";
export type ReconRow = { network: string; hash: string; state: ReconState; side: ReconSide; invoiceId: string | null; detail: string | null; sinceMs: number; updatedMs: number };

export type JobState = "quoted" | "paid" | "released" | "expired";
/** A paid job (src/jobs.ts). quotedMs null = made from a claim alone (no job_quoted seen). Amount in USDC base units. */
export type JobRow = {
  jobId: string;
  network: string;
  state: JobState;
  amount: string | null;
  totalUsd: string | null;
  quotedMs: number | null;
  expiresMs: number | null;
  paidMs: number | null;
  releasedMs: number | null;
  expiredMs: number | null;
  txHash: string | null;
  breakdown: JobBreakdown | null;
  steps: JobStep[] | null;
  receivedMs: number;
};
type JobDb = {
  job_id: string; network: string; state: string; amount: string | null; total_usd: string | null; quoted_ms: number | null; expires_ms: number | null;
  paid_ms: number | null; released_ms: number | null; expired_ms: number | null; tx_hash: string | null; breakdown_json: string | null; steps_json: string | null; received_ms: number;
};
const toJob = (r: JobDb): JobRow => ({
  jobId: r.job_id, network: r.network, state: r.state as JobState, amount: r.amount, totalUsd: r.total_usd, quotedMs: r.quoted_ms, expiresMs: r.expires_ms,
  paidMs: r.paid_ms, releasedMs: r.released_ms, expiredMs: r.expired_ms, txHash: r.tx_hash,
  breakdown: r.breakdown_json === null ? null : (JSON.parse(r.breakdown_json) as JobBreakdown), steps: r.steps_json === null ? null : (JSON.parse(r.steps_json) as JobStep[]), receivedMs: r.received_ms,
});

/** How a transfer arrived. Stored as text and never renamed (DESIGN §5.2). */
export type Road = "neardata" | "qn-rpc" | "rpc" | "backfill";
export const ROADS: readonly Road[] = ["neardata", "qn-rpc", "rpc", "backfill"];

export type Arrival =
  | { kind: "first"; row: Row; via: Road; seenMs: number }
  | { kind: "later"; row: Row; via: Road; seenMs: number; firstVia: Road; lagMs: number }
  | { kind: "repeat"; via: Road };

export type StoredTx = { row: Row; firstVia: Road; firstSeenMs: number };

type ClaimDb = { network: string; hash: string; invoice_id: string | null; amount: string; asset: string | null; payer: string | null; route: string | null; ts_ms: number; source: string; received_ms: number; seen_block: number | null };
type TraceDb = { invoice_id: string; step: number; network: string | null; tenant: string | null; payer: string | null; ts_ms: number; ms: number | null; status: number | null; tx_hash: string | null; received_ms: number };
type ReconDb = { network: string; hash: string; state: string; side: string; invoice_id: string | null; detail: string | null; since_ms: number; updated_ms: number };
type TxDb = { row_json: string; first_via: string; first_seen_ms: number };

const toClaim = (r: ClaimDb): ClaimRow => ({ network: r.network, hash: r.hash, invoiceId: r.invoice_id, amount: r.amount, asset: r.asset, payer: r.payer, route: r.route, tsMs: r.ts_ms, source: r.source as ClaimSource, receivedMs: r.received_ms, seenBlock: r.seen_block });
const toTrace = (r: TraceDb): TraceRow => ({ invoiceId: r.invoice_id, step: r.step, network: r.network, tenant: r.tenant, payer: r.payer, tsMs: r.ts_ms, ms: r.ms, status: r.status, txHash: r.tx_hash, receivedMs: r.received_ms });
const toRecon = (r: ReconDb): ReconRow => ({ network: r.network, hash: r.hash, state: r.state as ReconState, side: r.side as ReconSide, invoiceId: r.invoice_id, detail: r.detail, sinceMs: r.since_ms, updatedMs: r.updated_ms });
const toStored = (r: TxDb): StoredTx => ({ row: JSON.parse(r.row_json) as Row, firstVia: r.first_via as Road, firstSeenMs: r.first_seen_ms });

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, opts: StoreOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS txs (
        network TEXT NOT NULL, hash TEXT NOT NULL, block_height INTEGER NOT NULL,
        block_time_ms INTEGER, first_via TEXT NOT NULL, first_seen_ms INTEGER NOT NULL,
        is_x402 INTEGER NOT NULL, row_json TEXT NOT NULL,
        PRIMARY KEY (network, hash));
      CREATE INDEX IF NOT EXISTS txs_height ON txs (network, block_height);
      CREATE TABLE IF NOT EXISTS roads (
        network TEXT NOT NULL, hash TEXT NOT NULL, via TEXT NOT NULL,
        seen_ms INTEGER NOT NULL, lag_ms INTEGER NOT NULL,
        PRIMARY KEY (network, hash, via),
        FOREIGN KEY (network, hash) REFERENCES txs (network, hash));
      CREATE TABLE IF NOT EXISTS cursors (
        network TEXT NOT NULL, road TEXT NOT NULL, height INTEGER NOT NULL,
        PRIMARY KEY (network, road));
      CREATE TABLE IF NOT EXISTS claims (
        network TEXT NOT NULL, hash TEXT NOT NULL, invoice_id TEXT, amount TEXT NOT NULL, asset TEXT,
        payer TEXT, route TEXT, ts_ms INTEGER NOT NULL, source TEXT NOT NULL, received_ms INTEGER NOT NULL,
        seen_block INTEGER,
        PRIMARY KEY (network, hash));
      CREATE INDEX IF NOT EXISTS claims_invoice ON claims (invoice_id);
      CREATE INDEX IF NOT EXISTS claims_ts ON claims (ts_ms);
      CREATE TABLE IF NOT EXISTS traces (
        invoice_id TEXT NOT NULL, step INTEGER NOT NULL, network TEXT, tenant TEXT, payer TEXT,
        ts_ms INTEGER NOT NULL, ms INTEGER, status INTEGER, tx_hash TEXT, received_ms INTEGER NOT NULL,
        PRIMARY KEY (invoice_id, step));
      CREATE INDEX IF NOT EXISTS traces_ts ON traces (ts_ms);
      CREATE TABLE IF NOT EXISTS recon (
        network TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, side TEXT NOT NULL,
        invoice_id TEXT, detail TEXT, since_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
        PRIMARY KEY (network, hash));
      CREATE INDEX IF NOT EXISTS recon_state ON recon (network, state);
    `);
    // Paid jobs (ARCH-206): a new table only; the tables above are not altered.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY, network TEXT NOT NULL, state TEXT NOT NULL, amount TEXT, total_usd TEXT,
        quoted_ms INTEGER, expires_ms INTEGER, paid_ms INTEGER, released_ms INTEGER, expired_ms INTEGER, tx_hash TEXT,
        breakdown_json TEXT, steps_json TEXT, received_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_tx ON jobs (network, tx_hash);
      CREATE INDEX IF NOT EXISTS jobs_received ON jobs (received_ms);
    `);
    // NEAR AI model attestation per job (PLAN-adminui-nearai-attestation.md ARCH-502): a new table only; the newest
    // job_attested per job replaces the one before. Keyed by job id alone, so it may come before the job's row.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_attestations (
        job_id TEXT PRIMARY KEY, network TEXT NOT NULL, ts_ms INTEGER NOT NULL, summary TEXT NOT NULL, calls_json TEXT NOT NULL,
        received_ms INTEGER NOT NULL);
    `);
    // ARCH-701 / ARCH-702: new tables only, keyed by job id alone (an event may come before the job's row).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_signed_quotes (
        job_id TEXT PRIMARY KEY, network TEXT NOT NULL, kid TEXT NOT NULL, merchant_auth_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_receipts (
        job_id TEXT PRIMARY KEY, network TEXT NOT NULL, ts_ms INTEGER NOT NULL, receipt_id TEXT NOT NULL, key_id TEXT NOT NULL,
        result_sha256 TEXT NOT NULL, files_root TEXT NOT NULL, settled INTEGER NOT NULL, tx_hash TEXT, received_ms INTEGER NOT NULL);
    `);
    // ARCH-704: a new table only, keyed by job id; written and cleared with the job's receipt.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_mandates (
        job_id TEXT PRIMARY KEY, network TEXT NOT NULL, kid TEXT NOT NULL, tenant TEXT NOT NULL, sha256 TEXT NOT NULL);
    `);
    const v = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined;
    if (!v) this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
    else if (Number(v.value) !== SCHEMA_VERSION) {
      try {
        if (Number(v.value) !== 1) throw new Error(`store ${path} has schema ${v.value}; this build reads ${SCHEMA_VERSION}`);
        this.migrate1to2(path, opts.payTo);
      } catch (e) {
        this.db.close(); // a store that cannot be opened leaves no handle on the file
        throw e;
      }
    }
  }

  /**
   * Schema 1 judged x402 by an invoice memo. Re-judge every stored row by the memo-free rule (decode.ts): success,
   * method ft_transfer, exactly one NEP-141 event, into a watched pay-to; drop the row's invoiceId/invoiceMatches.
   * The old txs.invoice_id column stays in the file, unused.
   */
  private migrate1to2(path: string, payTo: StoreOptions["payTo"]): void {
    if (!payTo) throw new Error(`store ${path} has schema 1; open it with the watched pay-to accounts to migrate it to ${SCHEMA_VERSION}`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT network, hash, row_json FROM txs").all() as { network: string; hash: string; row_json: string }[];
      const put = this.db.prepare("UPDATE txs SET is_x402 = ?, row_json = ? WHERE network = ? AND hash = ?");
      for (const r of rows) {
        const { invoiceId: _i, invoiceMatches: _m, ...row } = JSON.parse(r.row_json) as Row & { invoiceId?: unknown; invoiceMatches?: unknown };
        row.isX402 = row.status === "success" && row.method === "ft_transfer" && row.events === 1 && (payTo.get(row.network)?.has(row.to) ?? false);
        put.run(row.isX402 ? 1 : 0, JSON.stringify(row), r.network, r.hash);
      }
      this.db.exec("DROP INDEX IF EXISTS txs_invoice");
      this.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema'").run(String(SCHEMA_VERSION));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---- transfers ----

  recordArrival(row: Row, via: Road, seenMs: number): Arrival {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare(
          `INSERT INTO txs (network, hash, block_height, block_time_ms, first_via, first_seen_ms, is_x402, row_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (network, hash) DO NOTHING`,
        )
        .run(row.network, row.hash, row.blockHeight, row.blockTimeMs, via, seenMs, row.isX402 ? 1 : 0, JSON.stringify(row));
      let arrival: Arrival;
      if (inserted.changes === 1) {
        this.db.prepare("INSERT INTO roads (network, hash, via, seen_ms, lag_ms) VALUES (?, ?, ?, ?, 0)").run(row.network, row.hash, via, seenMs);
        arrival = { kind: "first", row, via, seenMs };
      } else {
        const first = this.db.prepare("SELECT first_via, first_seen_ms FROM txs WHERE network = ? AND hash = ?").get(row.network, row.hash) as { first_via: Road; first_seen_ms: number };
        const lagMs = Math.max(0, seenMs - first.first_seen_ms);
        const r = this.db.prepare("INSERT INTO roads (network, hash, via, seen_ms, lag_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").run(row.network, row.hash, via, seenMs, lagMs);
        arrival = r.changes === 1 ? { kind: "later", row, via, seenMs, firstVia: first.first_via, lagMs } : { kind: "repeat", via };
      }
      this.db.exec("COMMIT");
      return arrival;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getTx(network: string, hash: string): StoredTx | undefined {
    const r = this.db.prepare("SELECT row_json, first_via, first_seen_ms FROM txs WHERE network = ? AND hash = ?").get(network, hash) as TxDb | undefined;
    return r ? toStored(r) : undefined;
  }

  recentTxs(limit: number, network?: string): StoredTx[] {
    const rows = network
      ? this.db.prepare("SELECT row_json, first_via, first_seen_ms FROM txs WHERE network = ? ORDER BY block_height DESC, first_seen_ms DESC LIMIT ?").all(network, limit)
      : this.db.prepare("SELECT row_json, first_via, first_seen_ms FROM txs ORDER BY first_seen_ms DESC LIMIT ?").all(limit);
    return (rows as TxDb[]).map(toStored);
  }

  txsInBlock(network: string, height: number): Row[] {
    return (this.db.prepare("SELECT row_json FROM txs WHERE network = ? AND block_height = ?").all(network, height) as { row_json: string }[]).map((r) => JSON.parse(r.row_json) as Row);
  }

  /** The chain transfer of an invoice: via a claim naming it (same network and hash), else a rig trace's tx hash. */
  txByInvoice(invoiceId: string): StoredTx | undefined {
    const r = this.db
      .prepare(
        `SELECT t.row_json, t.first_via, t.first_seen_ms FROM txs t
         WHERE EXISTS (SELECT 1 FROM claims c WHERE c.invoice_id = ? AND c.network = t.network AND c.hash = t.hash)
            OR EXISTS (SELECT 1 FROM traces s WHERE s.invoice_id = ? AND s.tx_hash = t.hash AND (s.network IS NULL OR s.network = t.network))
         ORDER BY t.block_height LIMIT 1`,
      )
      .get(invoiceId, invoiceId) as TxDb | undefined;
    return r ? toStored(r) : undefined;
  }

  roadsFor(network: string, hash: string): { via: Road; seenMs: number; lagMs: number }[] {
    const rows = this.db.prepare("SELECT via, seen_ms, lag_ms FROM roads WHERE network = ? AND hash = ? ORDER BY seen_ms").all(network, hash) as { via: Road; seen_ms: number; lag_ms: number }[];
    return rows.map((r) => ({ via: r.via, seenMs: r.seen_ms, lagMs: r.lag_ms }));
  }

  roadStats(network: string): Record<Road, { first: number; total: number }> {
    const out = Object.fromEntries(ROADS.map((r) => [r, { first: 0, total: 0 }])) as Record<Road, { first: number; total: number }>;
    for (const r of this.db.prepare("SELECT via, COUNT(*) AS n FROM roads WHERE network = ? GROUP BY via").all(network) as { via: Road; n: number }[]) if (out[r.via]) out[r.via].total = r.n;
    for (const r of this.db.prepare("SELECT first_via AS via, COUNT(*) AS n FROM txs WHERE network = ? GROUP BY first_via").all(network) as { via: Road; n: number }[]) if (out[r.via]) out[r.via].first = r.n;
    return out;
  }

  /** Mean / max delay behind the first road, per road (ms), over every later arrival. */
  roadLags(network: string): Record<string, { later: number; meanMs: number | null; maxMs: number | null }> {
    const rows = this.db.prepare("SELECT via, COUNT(*) AS n, AVG(lag_ms) AS mean, MAX(lag_ms) AS mx FROM roads WHERE network = ? AND lag_ms > 0 GROUP BY via").all(network) as { via: string; n: number; mean: number | null; mx: number | null }[];
    return Object.fromEntries(rows.map((r) => [r.via, { later: r.n, meanMs: r.mean === null ? null : Math.round(r.mean), maxMs: r.mx }]));
  }

  getCursor(network: string, road: Road): number | undefined {
    return (this.db.prepare("SELECT height FROM cursors WHERE network = ? AND road = ?").get(network, road) as { height: number } | undefined)?.height;
  }

  /** Cursors only move forward. */
  setCursor(network: string, road: Road, height: number): void {
    this.db.prepare("INSERT INTO cursors (network, road, height) VALUES (?, ?, ?) ON CONFLICT (network, road) DO UPDATE SET height = MAX(height, excluded.height)").run(network, road, height);
  }

  /** The furthest block any road has covered on a network. */
  maxCursor(network: string): number | undefined {
    const r = this.db.prepare("SELECT MAX(height) AS h FROM cursors WHERE network = ?").get(network) as { h: number | null } | undefined;
    return r?.h ?? undefined;
  }

  // ---- claims ----

  insertClaim(c: ClaimRow): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO claims (network, hash, invoice_id, amount, asset, payer, route, ts_ms, source, received_ms, seen_block)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (network, hash) DO NOTHING`,
      )
      .run(c.network, c.hash, c.invoiceId, c.amount, c.asset, c.payer, c.route, c.tsMs, c.source, c.receivedMs, c.seenBlock);
    return r.changes === 1;
  }

  getClaim(network: string, hash: string): ClaimRow | undefined {
    const r = this.db.prepare("SELECT * FROM claims WHERE network = ? AND hash = ?").get(network, hash) as ClaimDb | undefined;
    return r ? toClaim(r) : undefined;
  }

  claimsByInvoice(invoiceId: string): ClaimRow[] {
    return (this.db.prepare("SELECT * FROM claims WHERE invoice_id = ? ORDER BY ts_ms").all(invoiceId) as ClaimDb[]).map(toClaim);
  }

  recentClaims(limit: number, network?: string): ClaimRow[] {
    const rows = network ? this.db.prepare("SELECT * FROM claims WHERE network = ? ORDER BY ts_ms DESC LIMIT ?").all(network, limit) : this.db.prepare("SELECT * FROM claims ORDER BY ts_ms DESC LIMIT ?").all(limit);
    return (rows as ClaimDb[]).map(toClaim);
  }

  setClaimSeenBlock(network: string, height: number): void {
    this.db.prepare("UPDATE claims SET seen_block = ? WHERE network = ? AND seen_block IS NULL").run(height, network);
  }

  openClaims(network: string, limit: number): ClaimRow[] {
    return (
      this.db
        .prepare(
          `SELECT c.* FROM claims c LEFT JOIN recon r ON r.network = c.network AND r.hash = c.hash
           WHERE c.network = ? AND (r.state IS NULL OR r.state = 'pending') ORDER BY c.ts_ms LIMIT ?`,
        )
        .all(network, limit) as ClaimDb[]
    ).map(toClaim);
  }

  /** x402 transfers into one of `payTo`, from `fromBlock` on, with no claim and not yet decided (or pending). */
  openChainPayments(network: string, payTo: readonly string[], fromBlock: number, limit: number): StoredTx[] {
    if (payTo.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT t.row_json, t.first_via, t.first_seen_ms FROM txs t
           LEFT JOIN recon r ON r.network = t.network AND r.hash = t.hash
           LEFT JOIN claims c ON c.network = t.network AND c.hash = t.hash
           WHERE t.network = ? AND t.is_x402 = 1 AND t.block_height >= ? AND c.hash IS NULL
             AND json_extract(t.row_json, '$.to') IN (SELECT value FROM json_each(?))
             AND (r.state IS NULL OR r.state = 'pending')
           ORDER BY t.block_height LIMIT ?`,
        )
        .all(network, fromBlock, JSON.stringify(payTo), limit) as TxDb[]
    ).map(toStored);
  }

  chainPaymentsSince(network: string, payTo: readonly string[], sinceMs: number): Row[] {
    if (payTo.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT row_json FROM txs WHERE network = ? AND is_x402 = 1 AND first_seen_ms >= ?
             AND json_extract(row_json, '$.to') IN (SELECT value FROM json_each(?))`,
        )
        .all(network, sinceMs, JSON.stringify(payTo)) as { row_json: string }[]
    ).map((r) => JSON.parse(r.row_json) as Row);
  }

  /** Successful USDC transfers into one of `payTo` (any sender), oldest first: the Seller Wallet's source. */
  usdcInto(network: string, payTo: readonly string[]): StoredTx[] {
    if (payTo.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT row_json, first_via, first_seen_ms FROM txs
           WHERE network = ? AND json_extract(row_json, '$.status') = 'success' AND json_extract(row_json, '$.isUsdc') = 1
             AND json_extract(row_json, '$.to') IN (SELECT value FROM json_each(?))
           ORDER BY block_height, first_seen_ms`,
        )
        .all(network, JSON.stringify(payTo)) as TxDb[]
    ).map(toStored);
  }

  firstBlock(network: string): number | null {
    return (this.db.prepare("SELECT MIN(block_height) AS n FROM txs WHERE network = ?").get(network) as { n: number | null } | undefined)?.n ?? null;
  }

  /** Matched claims settled since `sinceMs`: claim time minus block time, in ms. */
  settleLagsSince(network: string, sinceMs: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT c.ts_ms - t.block_time_ms AS lag FROM claims c
           JOIN txs t ON t.network = c.network AND t.hash = c.hash
           JOIN recon r ON r.network = c.network AND r.hash = c.hash
           WHERE c.network = ? AND c.ts_ms >= ? AND r.state = 'matched' AND t.block_time_ms IS NOT NULL`,
        )
        .all(network, sinceMs) as { lag: number }[]
    ).map((r) => r.lag);
  }

  claimCountSince(network: string, sinceMs: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE network = ? AND ts_ms >= ?").get(network, sinceMs) as { n: number }).n;
  }

  claimsNotOnChain(network: string, sinceMs: number): ClaimRow[] {
    return (
      this.db
        .prepare(
          `SELECT c.* FROM claims c
           LEFT JOIN txs t ON t.network = c.network AND t.hash = c.hash
           LEFT JOIN recon r ON r.network = c.network AND r.hash = c.hash
           WHERE c.network = ? AND c.ts_ms >= ? AND t.hash IS NULL AND (r.state IS NULL OR r.state = 'pending')
           ORDER BY c.ts_ms`,
        )
        .all(network, sinceMs) as ClaimDb[]
    ).map(toClaim);
  }

  // ---- traces ----

  insertTrace(t: TraceRow): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO traces (invoice_id, step, network, tenant, payer, ts_ms, ms, status, tx_hash, received_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (invoice_id, step) DO NOTHING`,
      )
      .run(t.invoiceId, t.step, t.network, t.tenant, t.payer, t.tsMs, t.ms, t.status, t.txHash, t.receivedMs);
    return r.changes === 1;
  }

  tracesFor(invoiceId: string): TraceRow[] {
    return (this.db.prepare("SELECT * FROM traces WHERE invoice_id = ? ORDER BY step").all(invoiceId) as TraceDb[]).map(toTrace);
  }

  traceSpansSince(sinceMs: number, firstStep: number, lastStep: number): number[] {
    return (
      this.db.prepare("SELECT b.ts_ms - a.ts_ms AS span FROM traces a JOIN traces b ON b.invoice_id = a.invoice_id WHERE a.step = ? AND b.step = ? AND a.ts_ms >= ?").all(firstStep, lastStep, sinceMs) as {
        span: number;
      }[]
    ).map((r) => r.span);
  }

  /** Rig calls signed or sent since `sinceMs` with no chain transfer and no claim yet, not answered with a non-2xx. */
  tracesInFlight(network: string, sinceMs: number, steps: readonly number[], answeredStep: number): TraceRow[] {
    if (steps.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT t.* FROM traces t
           WHERE t.step = (SELECT MAX(x.step) FROM traces x WHERE x.invoice_id = t.invoice_id AND x.step IN (SELECT value FROM json_each(?)))
             AND t.ts_ms >= ? AND (t.network = ? OR t.network IS NULL)
             AND NOT EXISTS (SELECT 1 FROM traces s JOIN txs p ON p.hash = s.tx_hash WHERE s.invoice_id = t.invoice_id)
             AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.invoice_id = t.invoice_id)
             AND NOT EXISTS (SELECT 1 FROM traces a WHERE a.invoice_id = t.invoice_id AND a.step = ? AND a.status IS NOT NULL AND (a.status < 200 OR a.status > 299))
           ORDER BY t.ts_ms`,
        )
        .all(JSON.stringify(steps), sinceMs, network, answeredStep) as TraceDb[]
    ).map(toTrace);
  }

  // ---- reconcile ----

  getRecon(network: string, hash: string): ReconRow | undefined {
    const r = this.db.prepare("SELECT * FROM recon WHERE network = ? AND hash = ?").get(network, hash) as ReconDb | undefined;
    return r ? toRecon(r) : undefined;
  }

  /**
   * Claims whose row is still a one-sided gap (only_in_log / only_on_ledger) although both sides are now stored: the
   * transfer (or the claim) landed after the grace. reconcile.ts run() re-decides them, so a missed tx event or a
   * restart cannot leave a paid call stuck as a gap.
   */
  gapClaimsWithTx(network: string, limit: number): ClaimRow[] {
    return (
      this.db
        .prepare(
          `SELECT c.* FROM claims c
           JOIN recon r ON r.network = c.network AND r.hash = c.hash
           JOIN txs t ON t.network = c.network AND t.hash = c.hash
           WHERE c.network = ? AND r.state IN ('only_in_log', 'only_on_ledger') ORDER BY c.ts_ms LIMIT ?`,
        )
        .all(network, limit) as ClaimDb[]
    ).map(toClaim);
  }

  putRecon(r: ReconRow): void {
    this.db
      .prepare(
        `INSERT INTO recon (network, hash, state, side, invoice_id, detail, since_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (network, hash) DO UPDATE SET state = excluded.state, side = excluded.side, invoice_id = excluded.invoice_id,
           detail = excluded.detail, since_ms = excluded.since_ms, updated_ms = excluded.updated_ms`,
      )
      .run(r.network, r.hash, r.state, r.side, r.invoiceId, r.detail, r.sinceMs, r.updatedMs);
  }

  reconCounts(network?: string): Record<ReconState, number> {
    const out = Object.fromEntries(RECON_STATES.map((s) => [s, 0])) as Record<ReconState, number>;
    const rows = (network ? this.db.prepare("SELECT state, COUNT(*) AS n FROM recon WHERE network = ? GROUP BY state").all(network) : this.db.prepare("SELECT state, COUNT(*) AS n FROM recon GROUP BY state").all()) as {
      state: ReconState;
      n: number;
    }[];
    for (const r of rows) if (r.state in out) out[r.state] = r.n;
    return out;
  }

  recentRecon(limit: number, state?: ReconState): ReconRow[] {
    const rows = state ? this.db.prepare("SELECT * FROM recon WHERE state = ? ORDER BY updated_ms DESC LIMIT ?").all(state, limit) : this.db.prepare("SELECT * FROM recon ORDER BY updated_ms DESC LIMIT ?").all(limit);
    return (rows as ReconDb[]).map(toRecon);
  }

  // ---- paid jobs (ARCH-206) ----

  getJob(jobId: string): JobRow | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobDb | undefined;
    return r ? toJob(r) : undefined;
  }

  jobByTx(network: string, hash: string): JobRow | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE network = ? AND tx_hash = ?").get(network, hash) as JobDb | undefined;
    return r ? toJob(r) : undefined;
  }

  putJob(j: JobRow): void {
    this.db
      .prepare(
        `INSERT INTO jobs (job_id, network, state, amount, total_usd, quoted_ms, expires_ms, paid_ms, released_ms, expired_ms, tx_hash, breakdown_json, steps_json, received_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET state = excluded.state, amount = excluded.amount, total_usd = excluded.total_usd, quoted_ms = excluded.quoted_ms,
           expires_ms = excluded.expires_ms, paid_ms = excluded.paid_ms, released_ms = excluded.released_ms, expired_ms = excluded.expired_ms,
           tx_hash = excluded.tx_hash, breakdown_json = excluded.breakdown_json, steps_json = excluded.steps_json`,
      )
      .run(j.jobId, j.network, j.state, j.amount, j.totalUsd, j.quotedMs, j.expiresMs, j.paidMs, j.releasedMs, j.expiredMs, j.txHash, j.breakdown === null ? null : JSON.stringify(j.breakdown), j.steps === null ? null : JSON.stringify(j.steps), j.receivedMs);
  }

  hasJobs(): boolean {
    return this.db.prepare("SELECT 1 FROM jobs LIMIT 1").get() !== undefined;
  }

  /** Newest first (by when near-watch first heard of the job). */
  recentJobs(limit: number, network?: string, state?: JobState): JobRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (network) (where.push("network = ?"), args.push(network));
    if (state) (where.push("state = ?"), args.push(state));
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_ms DESC, job_id LIMIT ?`;
    return (this.db.prepare(sql).all(...args, limit) as JobDb[]).map(toJob);
  }

  jobCounts(network?: string): Record<JobState, number> {
    const out: Record<JobState, number> = { quoted: 0, paid: 0, released: 0, expired: 0 };
    const rows = (network ? this.db.prepare("SELECT state, COUNT(*) AS n FROM jobs WHERE network = ? GROUP BY state").all(network) : this.db.prepare("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").all()) as { state: JobState; n: number }[];
    for (const r of rows) if (r.state in out) out[r.state] = r.n;
    return out;
  }

  /** The quote breakdowns of expired jobs on `network` (lost compute, src/jobs.ts). */
  expiredBreakdowns(network: string): JobBreakdown[] {
    return (this.db.prepare("SELECT breakdown_json FROM jobs WHERE network = ? AND state = 'expired' AND breakdown_json IS NOT NULL").all(network) as { breakdown_json: string }[]).map((r) => JSON.parse(r.breakdown_json) as JobBreakdown);
  }

  // ---- NEAR AI model attestation per job (ARCH-502) ----

  getAttestation(jobId: string): (JobAttestation & { network: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM job_attestations WHERE job_id = ?").get(jobId) as
      | { job_id: string; network: string; ts_ms: number; summary: string; calls_json: string; received_ms: number }
      | undefined;
    return r ? { network: r.network, tsMs: r.ts_ms, summary: r.summary as AttestSummary, calls: JSON.parse(r.calls_json) as AttestedCall[], receivedMs: r.received_ms } : undefined;
  }

  putAttestation(jobId: string, network: string, a: JobAttestation): void {
    this.db
      .prepare(
        `INSERT INTO job_attestations (job_id, network, ts_ms, summary, calls_json, received_ms) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (job_id) DO UPDATE SET ts_ms = excluded.ts_ms, summary = excluded.summary, calls_json = excluded.calls_json, received_ms = excluded.received_ms`,
      )
      .run(jobId, network, a.tsMs, a.summary, JSON.stringify(a.calls), a.receivedMs);
  }

  hasAttestations(): boolean {
    return this.db.prepare("SELECT 1 FROM job_attestations LIMIT 1").get() !== undefined;
  }

  /** Known jobs (rows in jobs) per attestation summary. */
  attestationCounts(network?: string): Record<AttestSummary, number> {
    const out = Object.fromEntries(ATTEST_SUMMARIES.map((s) => [s, 0])) as Record<AttestSummary, number>;
    const sql = `SELECT a.summary AS summary, COUNT(*) AS n FROM job_attestations a JOIN jobs j ON j.job_id = a.job_id ${network ? "WHERE j.network = ?" : ""} GROUP BY a.summary`;
    const rows = (network ? this.db.prepare(sql).all(network) : this.db.prepare(sql).all()) as { summary: AttestSummary; n: number }[];
    for (const r of rows) if (r.summary in out) out[r.summary] = r.n;
    return out;
  }

  // ---- signed quote (ARCH-702) and receipt (ARCH-701) per job ----

  getSignedQuote(jobId: string): (SignedQuote & { network: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM job_signed_quotes WHERE job_id = ?").get(jobId) as { network: string; kid: string; merchant_auth_sha256: string } | undefined;
    return r ? { network: r.network, kid: r.kid, merchantAuthSha256: r.merchant_auth_sha256 } : undefined;
  }

  putSignedQuote(jobId: string, network: string, q: SignedQuote): void {
    this.db.prepare(`INSERT INTO job_signed_quotes (job_id, network, kid, merchant_auth_sha256) VALUES (?, ?, ?, ?)
      ON CONFLICT (job_id) DO UPDATE SET kid = excluded.kid, merchant_auth_sha256 = excluded.merchant_auth_sha256`).run(jobId, network, q.kid, q.merchantAuthSha256);
  }

  getReceipt(jobId: string): (JobReceipt & { network: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM job_receipts WHERE job_id = ?").get(jobId) as
      | { network: string; ts_ms: number; receipt_id: string; key_id: string; result_sha256: string; files_root: string; settled: number; tx_hash: string | null; received_ms: number }
      | undefined;
    return r ? { network: r.network, tsMs: r.ts_ms, receiptId: r.receipt_id, keyId: r.key_id, resultSha256: r.result_sha256, filesRoot: r.files_root, settled: r.settled === 1, transaction: r.tx_hash, receivedMs: r.received_ms } : undefined;
  }

  putReceipt(jobId: string, network: string, rc: JobReceipt): void {
    this.db.prepare(`INSERT INTO job_receipts (job_id, network, ts_ms, receipt_id, key_id, result_sha256, files_root, settled, tx_hash, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (job_id) DO UPDATE SET ts_ms = excluded.ts_ms, receipt_id = excluded.receipt_id, key_id = excluded.key_id, result_sha256 = excluded.result_sha256,
        files_root = excluded.files_root, settled = excluded.settled, tx_hash = excluded.tx_hash, received_ms = excluded.received_ms`)
      .run(jobId, network, rc.tsMs, rc.receiptId, rc.keyId, rc.resultSha256, rc.filesRoot, rc.settled ? 1 : 0, rc.transaction, rc.receivedMs);
  }

  // ---- the checkout mandate a job's receipt records (ARCH-704) ----

  getMandate(jobId: string): (ReceiptMandate & { network: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM job_mandates WHERE job_id = ?").get(jobId) as { network: string; kid: string; tenant: string; sha256: string } | undefined;
    return r ? { network: r.network, kid: r.kid, tenant: r.tenant, sha256: r.sha256 } : undefined;
  }

  putMandate(jobId: string, network: string, m: ReceiptMandate): void {
    this.db.prepare(`INSERT INTO job_mandates (job_id, network, kid, tenant, sha256) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (job_id) DO UPDATE SET kid = excluded.kid, tenant = excluded.tenant, sha256 = excluded.sha256`).run(jobId, network, m.kid, m.tenant, m.sha256);
  }

  dropMandate(jobId: string): void {
    this.db.prepare("DELETE FROM job_mandates WHERE job_id = ?").run(jobId);
  }

  /** The claim whose route is `route` (a job's release route), oldest first. */
  claimByRoute(network: string, route: string): ClaimRow | undefined {
    const r = this.db.prepare("SELECT * FROM claims WHERE network = ? AND route = ? ORDER BY ts_ms LIMIT 1").get(network, route) as ClaimDb | undefined;
    return r ? toClaim(r) : undefined;
  }

  close(): void {
    this.db.close();
  }
}
