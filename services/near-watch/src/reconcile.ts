/**
 * Reconcile (ported from ledger-watch src/reconcile.ts; same states and alert codes). A claim joins a chain transfer by
 * (network, transaction hash) only: base58, compared exactly (DESIGN §5.3). An x402 NEAR transfer carries no memo
 * (chainiam-private-ai docs/NEAR-GATES.md G3: the exact scheme's ft_transfer is {receiver_id, amount}), so the claim's
 * invoiceId is carried along for display and never compared with anything on chain.
 *
 *   matched         claim and chain transfer agree (x402, ours, amount in base units, payer, token)
 *   pending         one side seen, the other not yet, still inside the grace
 *   only_in_log     a claim with no chain transfer after --settle-grace-blocks final blocks
 *   only_on_ledger  an x402 transfer into a pay-to with no claim after the grace
 *   mismatch        both seen, but they disagree (detail says how); final
 *
 * Late arrival: only_in_log / only_on_ledger are final for alerting, not for the money. When the missing side lands
 * after the grace (same network and tx hash), the same row becomes matched (or mismatch) and its detail says how late
 * it was ("late: …"), with an info alert reconcile_late_match. Both sides share the one (network, hash) row, so a
 * claim-side and a chain-side gap of one payment merge into it. run() also re-decides any gap whose two sides are both
 * stored, so a missed tx event or a restart cannot leave one behind.
 *
 * Grace is counted in final blocks the watcher has seen. Chain transfers from before reconciling began on a network
 * (meta reconcile_from_block:<network>, set at the first final block seen) are not reconciled: backfilled history
 * was never covered by claims.
 */
import { compareUnits } from "../../../packages/chain-core/src/money.ts";
import type { Row } from "./decode.ts";
import type { Bus, LedgerEvent } from "./events.ts";
import type { ClaimRow, ReconSide, ReconState, Store, StoredTx } from "./store.ts";

export type ReconcileOptions = { networks: readonly string[]; payTo: ReadonlyMap<string, ReadonlySet<string>>; graceBlocks: number; batch: number; now?: () => number };
export type Decision = { state: ReconState; side: ReconSide; detail: string | null; invoiceId: string | null };

const FINAL_ALERT: Partial<Record<ReconState, { level: "warn" | "error"; code: string }>> = {
  only_in_log: { level: "warn", code: "reconcile_only_in_log" },
  only_on_ledger: { level: "warn", code: "reconcile_only_on_ledger" },
  mismatch: { level: "error", code: "reconcile_mismatch" },
};

/** The grace as /api/feeds shows it: setting, default, what it means in time now, and the trade-off. */
export type GraceReport = {
  graceBlocks: number;
  defaultBlocks: number;
  /** Median ms between consecutive final blocks near-watch handed in (null until two adjacent ones). */
  blockMs: number | null;
  /** graceBlocks x blockMs. */
  graceMs: number | null;
  /** How old the newest final block near-watch has handed in is, and that in blocks: how far the roads trail the chain. */
  trailMs: number | null;
  trailBlocks: number | null;
  tradeoff: string;
  /** Set when the roads trail the chain by at least the grace: then claims become only_in_log before their transfer is read. */
  warning: string | null;
};

export function graceReport(graceBlocks: number, defaultBlocks: number, ledgers: readonly LedgerEvent[], now: number): GraceReport {
  const gaps: number[] = [];
  for (let i = 1; i < ledgers.length; i++) {
    const a = ledgers[i - 1];
    const b = ledgers[i];
    if (b.index === a.index + 1 && a.closeTime !== null && b.closeTime !== null && b.closeTime > a.closeTime) gaps.push(b.closeTime - a.closeTime);
  }
  gaps.sort((x, y) => x - y);
  const blockMs = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const newest = ledgers.length ? ledgers[ledgers.length - 1].closeTime : null;
  const trailMs = newest === null ? null : Math.max(0, now - newest);
  const trailBlocks = trailMs !== null && blockMs ? Math.round(trailMs / blockMs) : null;
  const graceMs = blockMs === null ? null : graceBlocks * blockMs;
  const secs = (ms: number | null): string => (ms === null ? "?" : `${(ms / 1000).toFixed(1)} s`);
  return {
    graceBlocks,
    defaultBlocks,
    blockMs,
    graceMs,
    trailMs,
    trailBlocks,
    tradeoff:
      `${graceBlocks} final blocks (default ${defaultBlocks}) ≈ ${secs(graceMs)} at the measured block time. Shorter: a gap is flagged sooner, but a claim whose transfer the roads read late is first flagged only_in_log (it still turns matched, marked late, when the transfer lands). Longer: fewer false gaps, real ones surface later. The grace counts final blocks near-watch has read, from its own tip when the claim arrived.`,
    warning:
      trailBlocks !== null && trailBlocks >= graceBlocks
        ? `the roads trail the chain by ~${trailBlocks} blocks (${secs(trailMs)}), at least the ${graceBlocks}-block grace: claims will show only_in_log before their transfer is read`
        : null,
  };
}

export class Reconciler {
  readonly counters = { passes: 0, changes: 0 };
  private readonly store: Store;
  private readonly bus: Bus;
  private readonly opts: ReconcileOptions;
  private readonly now: () => number;

  constructor(store: Store, bus: Bus, opts: ReconcileOptions) {
    this.store = store;
    this.bus = bus;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  tip(network: string): number | null {
    const list = this.bus.ledgers.get(network);
    return list && list.length > 0 ? list[list.length - 1].index : null;
  }

  private isOurs(row: Row): boolean {
    return row.isX402 && (this.opts.payTo.get(row.network)?.has(row.to) ?? false);
  }

  differences(claim: ClaimRow, row: Row): string[] {
    const out: string[] = [];
    if (!row.isX402) out.push(`the chain transfer is not a valid x402 NEAR USDC payment (status ${row.status}, method ${row.method ?? "?"}, ${row.events} transfer event(s))`);
    else if (!this.isOurs(row)) out.push(`paid to ${row.to}, not a watched pay-to account`);
    if (compareUnits(row.amount, claim.amount) !== 0) out.push(`chain moved ${row.amount} base units, the log says ${claim.amount}`);
    if (claim.payer !== null && claim.payer !== row.from) out.push(`chain payer ${row.from}, the log says ${claim.payer}`);
    if (claim.asset !== null && claim.asset !== row.contract) out.push(`token ${row.contract}, the log says ${claim.asset}`);
    return out;
  }

  decideClaim(claim: ClaimRow, tip: number | null): Decision {
    const tx = this.store.getTx(claim.network, claim.hash);
    if (tx) {
      const diff = this.differences(claim, tx.row);
      const late = this.lateness(claim, tx);
      const detail = [late, diff.length ? diff.join("; ") : null].filter((x) => x !== null).join(" | ") || null; // " | ": the late note itself holds "; "
      return { state: diff.length === 0 ? "matched" : "mismatch", side: "log", detail, invoiceId: claim.invoiceId };
    }
    const waited = tip === null || claim.seenBlock === null ? 0 : tip - claim.seenBlock;
    return waited > this.opts.graceBlocks
      ? { state: "only_in_log", side: "log", detail: `no chain transfer ${claim.hash} after ${this.opts.graceBlocks} final blocks`, invoiceId: claim.invoiceId }
      : { state: "pending", side: "log", detail: "waiting for the chain", invoiceId: claim.invoiceId };
  }

  /**
   * "late: …" when this payment's row was already decided as a one-sided gap (or was matched late before), else null.
   * Times are near-watch's own: when the claim was received, when the first road recorded the transfer, the block time.
   */
  private lateness(claim: ClaimRow, tx: StoredTx): string | null {
    const prev = this.store.getRecon(claim.network, claim.hash);
    if (!prev) return null;
    if (prev.state === "matched" || prev.state === "mismatch") return prev.detail?.startsWith("late: ") ? (prev.detail.split(" | ")[0] as string) : null;
    if (prev.state !== "only_in_log" && prev.state !== "only_on_ledger") return null;
    const s = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
    const gapFor = s(Math.max(0, this.now() - prev.sinceMs));
    const block = tx.row.blockTimeMs === null ? "" : `, ${s(tx.firstSeenMs - tx.row.blockTimeMs)} after its block`;
    return prev.state === "only_in_log"
      ? `late: was only_in_log for ${gapFor}; the transfer was recorded ${s(tx.firstSeenMs - claim.receivedMs)} after the claim (via ${tx.firstVia}${block}), past the ${this.opts.graceBlocks}-block grace`
      : `late: was only_on_ledger for ${gapFor}; the claim arrived ${s(claim.receivedMs - tx.firstSeenMs)} after the transfer was recorded (via ${tx.firstVia}${block}), past the ${this.opts.graceBlocks}-block grace`;
  }

  decideChain(row: Row, tip: number | null): Decision {
    const waited = tip === null ? 0 : tip - row.blockHeight;
    // No claim yet, so no invoice: the chain side has none (no memo on an x402 NEAR transfer).
    const invoiceId = null;
    return waited > this.opts.graceBlocks
      ? { state: "only_on_ledger", side: "ledger", detail: `no paywall claim after ${this.opts.graceBlocks} final blocks`, invoiceId }
      : { state: "pending", side: "ledger", detail: "waiting for the paywall's claim", invoiceId };
  }

  private apply(network: string, hash: string, d: Decision): void {
    const prev = this.store.getRecon(network, hash);
    if (prev && prev.state === d.state && prev.detail === d.detail && prev.side === d.side) return;
    const at = this.now();
    this.store.putRecon({ network, hash, state: d.state, side: d.side, invoiceId: d.invoiceId, detail: d.detail, sinceMs: prev && prev.state === d.state ? prev.sinceMs : at, updatedMs: at });
    this.counters.changes += 1;
    this.bus.emit("reconcile", { network, hash, invoiceId: d.invoiceId, state: d.state, previous: prev?.state ?? null, side: d.side, detail: d.detail, at });
    const alert = FINAL_ALERT[d.state];
    if (alert && prev?.state !== d.state) this.bus.alert(alert.level, alert.code, `${hash}${d.invoiceId ? ` (invoice ${d.invoiceId})` : ""}: ${d.detail ?? d.state}`, network);
    if (d.state === "matched" && (prev?.state === "only_in_log" || prev?.state === "only_on_ledger"))
      this.bus.alert("info", "reconcile_late_match", `${hash}${d.invoiceId ? ` (invoice ${d.invoiceId})` : ""}: ${d.detail ?? "matched"}`, network);
  }

  onClaim(claim: ClaimRow): void {
    this.apply(claim.network, claim.hash, this.decideClaim(claim, this.tip(claim.network)));
  }

  onTx(row: Row): void {
    const claim = this.store.getClaim(row.network, row.hash);
    if (claim) return this.onClaim(claim);
    if (!this.isOurs(row)) return;
    const from = this.fromBlock(row.network);
    if (from === null || row.blockHeight < from) return;
    this.apply(row.network, row.hash, this.decideChain(row, this.tip(row.network)));
  }

  fromBlock(network: string): number | null {
    const key = `reconcile_from_block:${network}`;
    const stored = this.store.getMeta(key);
    if (stored !== undefined) return Number(stored);
    const tip = this.tip(network);
    if (tip === null) return null;
    this.store.setMeta(key, String(tip));
    return tip;
  }

  run(): void {
    this.counters.passes += 1;
    for (const network of this.opts.networks) {
      const tip = this.tip(network);
      if (tip === null) continue;
      this.store.setClaimSeenBlock(network, tip);
      for (const claim of this.store.openClaims(network, this.opts.batch)) this.apply(network, claim.hash, this.decideClaim(claim, tip));
      for (const claim of this.store.gapClaimsWithTx(network, this.opts.batch)) this.apply(network, claim.hash, this.decideClaim(claim, tip));
      const from = this.fromBlock(network);
      if (from === null) continue;
      const payTo = [...(this.opts.payTo.get(network) ?? [])];
      for (const tx of this.store.openChainPayments(network, payTo, from, this.opts.batch)) this.apply(network, tx.row.hash, this.decideChain(tx.row, tip));
    }
  }
}
