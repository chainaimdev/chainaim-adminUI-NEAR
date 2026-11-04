/**
 * Everything the Live ops panels show, derived from LiveState (near-watch's events), its /api/metrics and /api/feeds
 * (ported from liveops admin-console lib/derive.ts). Pure functions of (state, now, metrics, feeds): no other source,
 * nothing estimated.
 *
 * Measured vs reported: a figure read from a final-block transfer row is "measured"; a figure the paywall (claim) or
 * the rig (trace) says about itself is "reported". Each result says which it is.
 *
 * Dropped from liveops: per-network tokens (RLUSD / TUSD) and the Devnet direct lane. near-watch watches one network
 * with one token (NEAR_USDC_CONTRACT); its symbol and decimals come from the data (balances, Seller Wallet, /api/feeds).
 */
import { sumDecimal } from "./format.ts";
import { labelOf, tokenCode, txKey, type LiveState, type ReconItem, type TxItem } from "./live-store.ts";
import {
  GAP_STATES,
  ROADS,
  type BalanceEntry,
  type FeedsNetwork,
  type Metrics,
  type Road,
  type SellerBuyer,
  type SellerWallet,
  type Spread,
  type TraceEvent,
  type WatchEntry,
} from "./types.ts";

/** How long after its last step a call still counts as in progress, and a buyer as active. */
export const IN_FLIGHT_MS = 120_000;
export const ACTIVE_MS = 300_000;

/** The network x402 payments settle on: the paywall's pay-to (watchlist source "paywall"), else the first pay-to listed. */
export function x402Network(state: LiveState): string | null {
  const payTos = state.watchlist.filter((w) => w.role === "payto");
  return (payTos.find((w) => w.source === "paywall") ?? payTos[0])?.network ?? null;
}

export const payToOf = (state: LiveState, network: string): WatchEntry[] => state.watchlist.filter((w) => w.role === "payto" && w.network === network);

/** The token symbol to print beside an amount on `network`; "token" until near-watch has named it (balances / seller). */
export const tokenOf = (state: LiveState, network: string | null): string => (network ? tokenCode(state, network) : null) ?? "token";

/** The Seller Wallets, the x402 network's first, then by network name (near-watch's order within a network). */
export function sellerWallets(state: LiveState): SellerWallet[] {
  const x = x402Network(state);
  return [...(state.seller?.wallets ?? [])].sort((a, b) => Number(b.network === x) - Number(a.network === x) || a.network.localeCompare(b.network));
}

/** When a transfer happened: its block's time, else when near-watch first saw it. */
export const txTime = (t: TxItem): number | null => t.row.blockTimeMs ?? t.firstSeenMs;

/** Final, successful x402 transfers into a pay-to account on this network (measured). */
export function x402Payments(state: LiveState, network: string): TxItem[] {
  const payTo = new Set(payToOf(state, network).map((w) => w.address));
  return state.txs.filter((t) => t.network === network && t.row.isX402 && t.row.status === "success" && payTo.has(t.row.to));
}

export type StepMark = "" | "r" | "m" | "f";

export type Buyer = {
  entry: WatchEntry;
  balance: BalanceEntry | null;
  /** The buyer's most recent paid call (by invoice), from rig traces. */
  invoiceId: string | null;
  /** Steps 1..5 of that call: r = reported (rig / paywall), m = measured on chain (step 4), f = failed. */
  steps: StepMark[];
  /** request → answer of that call, from the rig's own step times (reported). */
  endToEndMs: number | null;
  lastStepAt: number | null;
  status: "paying" | "settled" | "dry" | "idle";
  /** This session's measured x402 transfers from this buyer. */
  settled: number;
  spent: string;
  spark: string[];
  /** /api/metrics payer stats in the metrics window (measured; x402 transfers only). */
  windowCalls: number | null;
  windowAmount: string | null;
  /** The Seller Wallet's figures for this buyer (every successful USDC transfer into the pay-to, x402 and manual). */
  counted: SellerBuyer | null;
};

function tracesOf(state: LiveState, w: WatchEntry): TraceEvent[] {
  return state.traces.filter((t) => t.trace.payer === w.address || (t.trace.payer === null && t.trace.tenant === w.label));
}

export function buyers(state: LiveState, now: number, metrics: Metrics | null): Buyer[] {
  return state.watchlist
    .filter((w) => w.role === "buyer")
    .map((w): Buyer => {
      const balance = state.balances.find((b) => b.network === w.network && b.address === w.address) ?? null;
      const mine = tracesOf(state, w);
      const latest = mine.reduce<TraceEvent | null>((a, b) => (a === null || b.trace.tsMs > a.trace.tsMs ? b : a), null);
      const invoiceId = latest?.trace.invoiceId ?? null;
      const steps: StepMark[] = ["", "", "", "", ""];
      let endToEndMs: number | null = null;
      let lastStepAt: number | null = null;
      if (invoiceId) {
        const call = mine.filter((t) => t.trace.invoiceId === invoiceId);
        for (const t of call) {
          if (t.trace.step >= 1 && t.trace.step <= 5) steps[t.trace.step - 1] = t.trace.status !== null && t.trace.status >= 400 ? "f" : "r";
          lastStepAt = Math.max(lastStepAt ?? 0, t.trace.tsMs);
        }
        const onChain = x402TxOfInvoice(state, w.network, invoiceId);
        if (onChain) steps[3] = "m";
        else if (state.claims.some((c) => c.invoiceId === invoiceId)) steps[3] = "r";
        const s1 = call.find((t) => t.trace.step === 1);
        const s5 = call.find((t) => t.trace.step === 5);
        if (s1 && s5) endToEndMs = s5.trace.tsMs - s1.trace.tsMs;
      }
      const paid = state.txs.filter((t) => t.network === w.network && t.row.isX402 && t.row.status === "success" && t.row.from === w.address).sort((a, b) => a.row.blockHeight - b.row.blockHeight);
      const amounts = paid.map((t) => t.row.value);
      const stat = metrics?.networks[w.network]?.payers.find((p) => p.payer === w.address) ?? null;
      const counted = (state.seller?.wallets ?? []).filter((s) => s.network === w.network).flatMap((s) => s.buyers.filter((x) => x.address === w.address))[0] ?? null;
      const inProgress = invoiceId !== null && steps[4] === "" && lastStepAt !== null && now - lastStepAt < IN_FLIGHT_MS;
      const status: Buyer["status"] = inProgress ? "paying" : balance?.callsLeft === 0 ? "dry" : steps[4] !== "" ? "settled" : "idle";
      return {
        entry: w,
        balance,
        invoiceId,
        steps,
        endToEndMs,
        lastStepAt,
        status,
        settled: paid.length,
        spent: sumDecimal(amounts),
        spark: amounts.slice(-24),
        windowCalls: metrics ? (stat?.calls ?? 0) : null,
        windowAmount: metrics ? (stat?.amount ?? "0") : null,
        counted,
      };
    });
}

export type Kpis = {
  network: string | null;
  buyersActive: number;
  buyersWatched: number;
  buyersPaying: number;
  /** Measured: x402 transfers into pay-to whose block is from the last 60 s. */
  paidLastMinute: number;
  paidAmountLastMinute: string;
  /** Measured, from /api/metrics: transfers first seen in the metrics window. */
  paidInWindow: number | null;
  paidAmountInWindow: string | null;
  windowSec: number | null;
  /** Reported: paywall claims in the last minute. */
  claimsLastMinute: number | null;
  /** Reported by the rig: step 1 → step 5. */
  endToEnd: Spread | null;
  /** Claim time minus block time, matched claims. */
  settleLag: Spread | null;
  /** Reconcile, all time (from /api/metrics): decided = everything but pending. */
  reconDecided: number | null;
  reconGaps: number | null;
};

export function kpis(state: LiveState, now: number, metrics: Metrics | null, list: Buyer[]): Kpis {
  const network = x402Network(state);
  const recent = network ? x402Payments(state, network).filter((t) => (txTime(t) ?? 0) >= now - 60_000) : [];
  const nm = network && metrics ? (metrics.networks[network] ?? null) : null;
  const counts = nm?.reconcile ?? null;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
  return {
    network,
    buyersActive: list.filter((b) => (b.lastStepAt !== null && now - b.lastStepAt < ACTIVE_MS) || state.txs.some((t) => t.row.from === b.entry.address && now - (txTime(t) ?? 0) < ACTIVE_MS)).length,
    buyersWatched: list.length,
    buyersPaying: list.filter((b) => b.status === "paying").length,
    paidLastMinute: recent.length,
    paidAmountLastMinute: sumDecimal(recent.map((t) => t.row.value)),
    paidInWindow: nm?.paidInWindow ?? null,
    paidAmountInWindow: nm?.paidAmountInWindow ?? null,
    windowSec: metrics?.windowSec ?? null,
    claimsLastMinute: nm?.claimsLastMinute ?? null,
    endToEnd: metrics?.endToEndMs ?? null,
    settleLag: nm?.settleLagMs ?? null,
    reconDecided: counts && total !== null ? total - (counts.pending ?? 0) : null,
    reconGaps: counts ? GAP_STATES.reduce((a, s) => a + (counts[s] ?? 0), 0) : null,
  };
}

export type RoadRow = { road: Road; first: number; total: number; sessionFirst: number; avgFirstLagMs: number | null; later: number; avgBehindMs: number | null };

/** Feed race for one network: totals from near-watch's status (all time), lags from this session's events. */
export function roadRows(state: LiveState, network: string): RoadRow[] {
  const st = state.status[network]?.roads ?? {};
  const ss = state.roadStats[network] ?? {};
  return ROADS.filter((r) => (st[r] && st[r].total > 0) || ss[r]).map((road) => {
    const s = ss[road];
    return {
      road,
      first: st[road]?.first ?? 0,
      total: st[road]?.total ?? 0,
      sessionFirst: s?.first ?? 0,
      avgFirstLagMs: s && s.firstLagN > 0 ? Math.round(s.firstLagSum / s.firstLagN) : null,
      later: s?.later ?? 0,
      avgBehindMs: s && s.later > 0 ? Math.round(s.behindSum / s.later) : null,
    };
  });
}

/** Time between the last two consecutive final blocks the console holds (from their block times), or null. */
export function blockInterval(state: LiveState, network: string): number | null {
  const l = (state.ledgers[network] ?? []).filter((x) => x.closeTime !== null);
  if (l.length < 2) return null;
  const a = l[l.length - 2];
  const b = l[l.length - 1];
  return b.index === a.index + 1 ? (b.closeTime as number) - (a.closeTime as number) : null;
}

/**
 * The x402 chain transfer of an invoice. The chain never names the invoice (an x402 NEAR transfer has no memo), so the
 * link is a paywall claim with that invoiceId, or a rig trace's tx hash, joined to the transfer by tx hash (exact).
 */
export function x402TxOfInvoice(state: LiveState, network: string | null, invoiceId: string): TxItem | undefined {
  // (network or null = any, base58 hash) pairs that name this invoice's transaction.
  const refs: { network: string | null; hash: string }[] = [];
  for (const c of state.claims) if (c.invoiceId === invoiceId) refs.push({ network: c.network, hash: c.hash });
  for (const t of state.traces) if (t.trace.invoiceId === invoiceId && t.trace.txHash) refs.push({ network: t.trace.network, hash: t.trace.txHash });
  const wanted = refs.filter((r) => network === null || r.network === null || r.network === network);
  return state.txs.find((t) => t.row.isX402 && wanted.some((r) => r.hash === t.row.hash && (r.network === null || r.network === t.network)));
}

/** Calls the rig reported as sent (step 3) in the last 2 min with no answer and no chain transfer yet (reported). */
export function inFlight(state: LiveState, now: number): number {
  const sent = state.traces.filter((t) => t.trace.step === 3 && now - t.trace.tsMs < IN_FLIGHT_MS);
  return sent.filter(
    (s) => !state.traces.some((t) => t.trace.invoiceId === s.trace.invoiceId && t.trace.step === 5) && x402TxOfInvoice(state, s.trace.network, s.trace.invoiceId) === undefined,
  ).length;
}

export type Attention = { level: "warn" | "error"; title: string; detail: string; tab: "Reconcile" | "Feeds" | "Live ops" | null; at: number };

const RECON_TITLE: Record<string, string> = { only_in_log: "Claimed, not on chain", only_on_ledger: "Money nobody claimed", mismatch: "Claim and chain disagree" };

export function attention(state: LiveState, now: number, list: Buyer[]): Attention[] {
  const out: Attention[] = [];
  for (const r of Object.values(state.recon)
    .filter((x: ReconItem) => (GAP_STATES as readonly string[]).includes(x.state))
    .sort((a, b) => b.at - a.at)
    .slice(0, 5)) {
    out.push({ level: r.state === "only_on_ledger" ? "warn" : "error", title: RECON_TITLE[r.state] ?? r.state, detail: `${r.network} · ${r.hash.slice(0, 8)}…${r.detail ? ` · ${r.detail}` : ""}`, tab: "Reconcile", at: r.at });
  }
  for (const n of state.networks) {
    const st = state.status[n];
    if (!st) continue;
    if (st.state !== "live") out.push({ level: st.state === "down" ? "error" : "warn", title: `${n} feeds ${st.state}`, detail: `best road ${st.provider} · failovers ${st.failovers}`, tab: "Feeds", at: st.at });
    // A single road down while another carries the network: not an outage, but the race is one road short.
    for (const f of st.feeds ?? []) {
      if (f.road === "backfill" || f.state === "live" || st.state !== "live") continue;
      out.push({ level: f.reset ? "error" : "warn", title: `road ${f.road} ${f.reset ? "stopped (network reset)" : f.state}`, detail: `${n} · ${f.provider} · ${f.errors} error(s)${f.lagBlocks !== null ? ` · ${f.lagBlocks} block(s) behind` : ""}`, tab: "Feeds", at: st.at });
    }
  }
  for (const b of state.balances) {
    // NEP-145: an account not registered with the token contract cannot receive it; a pay-to like that cannot be paid.
    if (b.registered === false && b.role === "payto") out.push({ level: "error", title: `${b.label} not registered with ${b.asset.code}`, detail: `${b.address} · storage_deposit needed before it can be paid`, tab: null, at: b.at });
  }
  for (const b of list) {
    const token = b.balance?.asset.code ?? tokenOf(state, b.entry.network);
    if (b.balance?.callsLeft === 0) out.push({ level: "error", title: `${b.entry.label} cannot pay`, detail: `${b.balance.asset.value ?? "0"} ${token} · ${b.entry.network} · 0 calls left (measured)`, tab: null, at: b.balance.at });
  }
  // Alerts newest first, one per (code, network, road); a later clearing alert ends the warning (near-watch:
  // low_calls -> low_calls_ok, feed_down -> feed_live for the same road). liveops skipped info alerts before checking,
  // so its "_ok" never cleared anything.
  const seen = new Set<string>();
  const alerts = state.alerts;
  for (let i = alerts.length - 1; i >= 0; i--) {
    const a = alerts[i];
    if (a.level === "info" || now - a.at > 30 * 60_000) continue;
    const k = `${a.code}:${a.network ?? ""}:${roadOfAlert(a) ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (alerts.slice(i + 1).some((b) => clears(a, b))) continue;
    out.push({ level: a.level, title: a.code, detail: a.message, tab: null, at: a.at });
  }
  return out;
}

/** near-watch prefixes road alerts with the road ("neardata: …", src/feeds/adapter.ts). */
const roadOfAlert = (a: { message: string }): string | null => /^(neardata|qn-rpc|rpc|backfill):/.exec(a.message)?.[1] ?? null;

/** Whether alert `b` (later) clears alert `a`: same network, and `<code>_ok`, or feed_live for the road that was down. */
export function clears(a: { code: string; network?: string; message: string }, b: { code: string; network?: string; message: string }): boolean {
  if ((a.network ?? "") !== (b.network ?? "")) return false;
  // low_calls / low_calls_ok name the account first: "<label> (<account>) …" (near-watch src/alerts.ts).
  const who = (m: string): string => m.split(" ").slice(0, 2).join(" ");
  if (b.code === `${a.code}_ok`) return a.code !== "low_calls" || who(a.message) === who(b.message);
  return a.code === "feed_down" && b.code === "feed_live" && roadOfAlert(a) === roadOfAlert(b);
}

export type FeedNow = {
  id: string;
  selected: boolean;
  /** on = running and delivering; issue = running but not live, or stopped by a reset; off = not running. */
  state: "on" | "issue" | "off";
  /** One word for the line ("", "stale", "down", "reset", "done", "off"…). */
  badge: string;
  /** Why, in plain words (shown on hover and in the Feeds tab). */
  text: string;
};

/**
 * What each feed adapter of a network is doing now, read from /api/feeds (near-watch src/main.ts feedsReport):
 *   not available    off, with near-watch's own reason (qn-wss is listed but not built; a road skipped at start-up)
 *   not selected     off
 *   running          its road status: live = on; stale / down / connecting = issue; reset = issue (stopped)
 *   backfill         done = on ("done"); running = as above; no range to cover = off
 *   selected, no status   off ("not running")
 */
export function feedActivity(f: FeedsNetwork): FeedNow[] {
  return f.adapters.map((a): FeedNow => {
    const selected = a.selected;
    if (!a.available) return { id: a.id, selected, state: "off", badge: "off", text: a.reason ?? "not available" };
    if (!selected) return { id: a.id, selected, state: "off", badge: "off", text: "not selected (--feeds)" };
    const r = f.roads.find((x) => x.road === a.id);
    if (!r) return { id: a.id, selected, state: "off", badge: "off", text: a.id === "backfill" ? "nothing to backfill at start-up" : "selected but not running" };
    if (r.reset) return { id: a.id, selected, state: "issue", badge: "reset", text: "stopped: network reset detected (final tip far below the stored cursor)" };
    if (a.id === "backfill" && r.done) return { id: a.id, selected, state: "on", badge: "done", text: `caught up to block ${r.lastBlock ?? "—"} via ${r.provider}` };
    const lag = r.lagBlocks !== null ? ` · ${r.lagBlocks} block(s) behind its tip` : "";
    return r.state === "live"
      ? { id: a.id, selected, state: "on", badge: "", text: `live via ${r.provider}${r.host ? ` (${r.host})` : ""}${lag} · ${r.errors} error(s)` }
      : { id: a.id, selected, state: "issue", badge: r.state, text: `${r.state} via ${r.provider}${lag} · ${r.errors} error(s)` };
  });
}

/** Account labels for a transfer's two sides. */
export const sides = (state: LiveState, t: TxItem): { from: string; to: string } => ({ from: labelOf(state, t.network, t.row.from), to: labelOf(state, t.network, t.row.to) });

/** Merges REST transfer rows (/api/txs) with the live ones; the live entry wins for the same key. */
export function mergeTxs(live: TxItem[], rest: { row: TxItem["row"]; firstVia: Road; firstSeenMs: number; network?: string; links?: TxItem["links"] }[]): TxItem[] {
  const byKey = new Map<string, TxItem>();
  for (const r of rest) {
    const network = r.network ?? r.row.network;
    const key = txKey(network, r.row.hash);
    byKey.set(key, { key, network, hash: r.row.hash, row: r.row, firstVia: r.firstVia, lagMs: null, firstSeenMs: r.firstSeenMs, links: r.links ?? null, roads: [] });
  }
  for (const t of live) byKey.set(t.key, t);
  return [...byKey.values()].sort((a, b) => (txTime(b) ?? 0) - (txTime(a) ?? 0) || b.row.blockHeight - a.row.blockHeight);
}
