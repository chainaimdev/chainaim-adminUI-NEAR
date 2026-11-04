/**
 * CONSOLE-DERIVE: lib/derive.ts (ported from liveops test/derive.test.ts) on the session recorded from the real
 * near-watch (test/session.ts), and feedActivity on /api/feeds reports in the shape near-watch src/main.ts feedsReport
 * builds, from near-watch's own adapter catalogue (src/feeds/adapter.ts ADAPTERS) and road status shape.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ADAPTER_IDS, ADAPTERS } from "../../../services/near-watch/src/feeds/adapter.ts";
import { attention, buyers, feedActivity, kpis, mergeTxs, roadRows, sellerWallets, x402Network, x402Payments, x402TxOfInvoice } from "../lib/derive.ts";
import { applyEvent, emptyState, type LiveState } from "../lib/live-store.ts";
import type { FeedRoad, FeedsNetwork, Metrics } from "../lib/types.ts";
import { recordSession, type SseEvent } from "./session.ts";
import { BUYER, CONTRACT, drainSockets, NETWORK, PAY_TO, TX_HASH, type Running } from "./watch-server.ts";

let state: LiveState;
let metrics: Metrics;
let nw: Running;
before(async () => {
  let events: SseEvent[];
  ({ events, nw } = await recordSession());
  state = events.reduce((s, e) => applyEvent(s, e.event, e.data), emptyState());
  metrics = nw.liveOps.metrics() as unknown as Metrics;
});
after(async () => {
  await nw.close();
  await drainSockets();
});

const NOW = (): number => Date.now();

test("CONSOLE-DERIVE x402 runs on the paywall's pay-to network; the recorded memo-less payment counts as x402", () => {
  assert.equal(x402Network(state), NETWORK);
  const t = state.txs.find((x) => x.hash === TX_HASH);
  assert.equal(t?.row.memo, null, "an x402 NEAR transfer carries no memo");
  assert.deepEqual(x402Payments(state, NETWORK).map((x) => x.hash), [TX_HASH]);
});

test("CONSOLE-DERIVE an invoice reaches its transfer only through the claim's tx hash", () => {
  assert.equal(x402TxOfInvoice(state, NETWORK, "INV-RECORDED-1")?.hash, TX_HASH, "claim 1 names the recorded hash");
  assert.equal(x402TxOfInvoice(state, NETWORK, "INV-UNSEEN-2"), undefined, "claim 2's hash is not on chain");
  assert.equal(x402TxOfInvoice(state, NETWORK, "INV-NO-CLAIM"), undefined);
  assert.equal(x402TxOfInvoice(state, "mainnet", "INV-RECORDED-1"), undefined, "networks are kept apart");
});

test("CONSOLE-DERIVE buyer: counted by the Seller Wallet (measured) as x402; no rig trace, so no steps", () => {
  const list = buyers(state, NOW(), metrics);
  assert.equal(list.length, 1);
  const b = list[0];
  assert.equal(b.entry.address, BUYER);
  assert.deepEqual(b.steps, ["", "", "", "", ""]);
  assert.equal(b.counted?.received, "0.01");
  assert.equal(b.counted?.manualCount, 0);
  assert.equal(b.settled, 1, "the recorded x402 payment");
  assert.equal(b.windowCalls, 1, "the x402 payment in /api/metrics' window");
  assert.equal(sellerWallets(state)[0]?.address, PAY_TO);
});

test("CONSOLE-DERIVE KPIs: window and reconcile figures are /api/metrics' own", () => {
  const k = kpis(state, NOW(), metrics, buyers(state, NOW(), metrics));
  const nm = metrics.networks[NETWORK];
  assert.equal(k.paidInWindow, nm.paidInWindow);
  const total = Object.values(nm.reconcile).reduce((a, b) => a + b, 0);
  assert.equal(k.reconDecided, total - nm.reconcile.pending);
  assert.equal(k.reconGaps, nm.reconcile.only_in_log + nm.reconcile.only_on_ledger + nm.reconcile.mismatch);
  assert.equal(k.reconGaps, 0, "matched + pending: no gap");
});

test("CONSOLE-DERIVE feed race: neardata won the transfer, qn-rpc arrived later with a measured delay", () => {
  const rows = Object.fromEntries(roadRows(state, NETWORK).map((r) => [r.road, r]));
  assert.equal(rows.neardata?.sessionFirst, 1);
  assert.equal(rows["qn-rpc"]?.later, 1);
  assert.equal(typeof rows["qn-rpc"]?.avgBehindMs, "number");
});

test("CONSOLE-DERIVE needs attention lists a reconcile gap, never a matched or pending row", () => {
  const items = attention(state, NOW(), buyers(state, NOW(), metrics)).filter((a) => a.tab === "Reconcile");
  assert.deepEqual(items, [], "matched (recorded payment) and pending (unseen claim) are not gaps");
  const key = Object.keys(state.recon).find((k) => k.endsWith(TX_HASH)) as string;
  const gap: LiveState = { ...state, recon: { ...state.recon, [key]: { ...state.recon[key], state: "mismatch", detail: "chain moved 10000 base units, the log says 20000" } } };
  const listed = attention(gap, NOW(), buyers(gap, NOW(), metrics)).filter((a) => a.tab === "Reconcile");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, "Claim and chain disagree");
  assert.match(listed[0].detail, new RegExp(TX_HASH.slice(0, 8)));
});

test("CONSOLE-DERIVE mergeTxs: the live entry wins for the same transfer; no duplicates; case kept", () => {
  const rest = state.txs.map((t) => ({ row: t.row, firstVia: "rpc" as const, firstSeenMs: 0, network: t.network, links: t.links ?? undefined }));
  const merged = mergeTxs(state.txs, rest);
  assert.equal(merged.length, new Set(state.txs.map((t) => t.key)).size);
  for (const t of merged) assert.equal(t.firstVia, state.txs.find((x) => x.key === t.key)?.firstVia);
  assert.ok(merged.some((t) => t.hash === TX_HASH));
});

/** A feeds report as near-watch src/main.ts feedsReport builds it, from near-watch's own adapter catalogue. */
function report(selected: string[], roads: FeedRoad[], skipped: { road: string; reason: string }[] = [], backfill = true): FeedsNetwork {
  return {
    selected,
    skipped,
    adapters: ADAPTER_IDS.map((id) => ({
      ...ADAPTERS[id],
      selected: id === "backfill" ? backfill : selected.includes(id),
      available: ADAPTERS[id].built && !skipped.some((s) => s.road === id),
      reason: !ADAPTERS[id].built ? ADAPTERS[id].description : (skipped.find((s) => s.road === id)?.reason ?? null),
    })),
    roads,
    stats: {},
    lags: {},
    backfill: null,
    explorer: null,
    token: { contract: CONTRACT, decimals: 6, symbol: "USDC" },
    caip2: "near:testnet",
  };
}
const road = (r: FeedRoad["road"], state: FeedRoad["state"], over: Partial<FeedRoad> = {}): FeedRoad => ({ road: r, state, provider: r, lastBlock: 270414460, lastBlockAgeMs: 500, lagBlocks: 0, errors: 0, reset: false, host: null, done: false, ...over });
const states = (f: FeedsNetwork) => Object.fromEntries(feedActivity(f).map((a) => [a.id, a.state]));

test("CONSOLE-FEEDS neardata live, qn-rpc down, rpc not selected, qn-wss not built, backfill done", () => {
  const f = report(["neardata", "qn-rpc"], [road("neardata", "live"), road("qn-rpc", "down", { errors: 3 }), road("backfill", "live", { done: true })]);
  assert.deepEqual(states(f), { neardata: "on", "qn-rpc": "issue", rpc: "off", backfill: "on", "qn-wss": "off" });
  const why = Object.fromEntries(feedActivity(f).map((a) => [a.id, a]));
  assert.equal(why["qn-rpc"].badge, "down");
  assert.match(why["qn-rpc"].text, /3 error/);
  assert.match(why["qn-wss"].text, /not built/);
  assert.equal(why.backfill.badge, "done");
  assert.match(why.rpc.text, /not selected/);
});

test("CONSOLE-FEEDS a road skipped at start-up is off with near-watch's reason; a reset stops a road; lag in blocks is shown", () => {
  const f = report(["neardata", "rpc"], [road("neardata", "live", { lagBlocks: 2 }), road("rpc", "down", { reset: true })], [{ road: "qn-rpc", reason: "QUICKNODE_NEAR_HTTP_TESTNET is not set" }], false);
  const a = Object.fromEntries(feedActivity(f).map((x) => [x.id, x]));
  assert.equal(a["qn-rpc"].state, "off");
  assert.equal(a["qn-rpc"].text, "QUICKNODE_NEAR_HTTP_TESTNET is not set");
  assert.equal(a.rpc.state, "issue");
  assert.equal(a.rpc.badge, "reset");
  assert.match(a.neardata.text, /2 block\(s\) behind/);
  assert.equal(a.backfill.state, "off");
});

test("CONSOLE-ALERTS a later feed_live for the same road clears feed_down; low_calls_ok clears low_calls for that account only", () => {
  const at = NOW();
  const a = (code: string, message: string, level: "info" | "warn" = "warn", dt = 0) => ({ level, code, message, network: NETWORK, at: at + dt });
  const s: LiveState = {
    ...state,
    recon: {},
    alerts: [
      a("feed_down", "neardata: fetch failed"),
      a("feed_down", "qn-rpc: HTTP 429"),
      a("feed_live", "neardata: delivering final blocks again at 270414461", "info", 1),
      a("low_calls", "stocks (near-stocks.testnet) has USDC for 2 more call(s), below 5"),
      a("low_calls", "other (other.testnet) has USDC for 1 more call(s), below 5"),
      a("low_calls_ok", "stocks (near-stocks.testnet) is back to 9 call(s)", "info", 2),
    ],
  };
  const titles = attention(s, at + 10, []).filter((x) => x.tab === null).map((x) => `${x.title} ${x.detail}`);
  assert.deepEqual(titles.sort(), ["feed_down qn-rpc: HTTP 429", "low_calls other (other.testnet) has USDC for 1 more call(s), below 5"]);
});
