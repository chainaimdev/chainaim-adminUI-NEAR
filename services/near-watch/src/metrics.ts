/**
 * Live-ops metrics computed from the store on request (ported from ledger-watch src/metrics.ts):
 * claims per minute / window, our x402 transfers in the window (count, USDC sum), per payer, reconcile counts,
 * settle lag (claim time minus block time), rig end-to-end span.
 */
import { sumDecimal } from "./decimal.ts";
import type { ReconState, Store } from "./store.ts";
import { FIRST_STEP, LAST_STEP } from "./traces.ts";

export type Spread = { count: number; p50: number | null; p95: number | null; max: number | null };
export type PayerStat = { payer: string; label: string | null; calls: number; amount: string };
export type NetworkMetrics = { claimsLastMinute: number; claimsInWindow: number; paidInWindow: number; paidAmountInWindow: string; payers: PayerStat[]; reconcile: Record<ReconState, number>; settleLagMs: Spread };
export type Metrics = { at: number; windowSec: number; networks: Record<string, NetworkMetrics>; endToEndMs: Spread };
export type MetricsOptions = { networks: readonly string[]; payTo: ReadonlyMap<string, ReadonlySet<string>>; labels: ReadonlyMap<string, ReadonlyMap<string, string>>; windowSec: number; now?: () => number };

export function spread(values: readonly number[]): Spread {
  if (values.length === 0) return { count: 0, p50: null, p95: null, max: null };
  const s = [...values].sort((a, b) => a - b);
  const rank = (p: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
  return { count: s.length, p50: rank(50), p95: rank(95), max: s[s.length - 1] };
}

export function computeMetrics(store: Store, opts: MetricsOptions): Metrics {
  const at = (opts.now ?? Date.now)();
  const since = at - opts.windowSec * 1000;
  const networks: Record<string, NetworkMetrics> = {};
  for (const network of opts.networks) {
    const paid = store.chainPaymentsSince(network, [...(opts.payTo.get(network) ?? [])], since);
    const byPayer = new Map<string, string[]>();
    for (const r of paid) byPayer.set(r.from, [...(byPayer.get(r.from) ?? []), r.value]);
    const labels = opts.labels.get(network);
    const payers = [...byPayer]
      .map(([payer, amounts]): PayerStat => ({ payer, label: labels?.get(payer) ?? null, calls: amounts.length, amount: sumDecimal(amounts) }))
      .sort((a, b) => b.calls - a.calls || a.payer.localeCompare(b.payer));
    networks[network] = {
      claimsLastMinute: store.claimCountSince(network, at - 60_000),
      claimsInWindow: store.claimCountSince(network, since),
      paidInWindow: paid.length,
      paidAmountInWindow: sumDecimal(paid.map((r) => r.value)),
      payers,
      reconcile: store.reconCounts(network),
      settleLagMs: spread(store.settleLagsSince(network, since)),
    };
  }
  return { at, windowSec: opts.windowSec, networks, endToEndMs: spread(store.traceSpansSince(since, FIRST_STEP, LAST_STEP)) };
}
