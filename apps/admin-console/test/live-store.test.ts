/**
 * CONSOLE-STORE: lib/live-store.ts replays a session read from the real near-watch /stream through the console's proxy
 * (test/session.ts; ported from liveops test/live-store.test.ts + seller-store.test.ts). Expectations come from the
 * session's own events and near-watch's recorded real testnet transfer.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { applyEvent, emptyState, lastLedger, txKey, type LiveState } from "../lib/live-store.ts";
import { recordSession, UNSEEN_HASH, type SseEvent } from "./session.ts";
import { fixture } from "../../../services/near-watch/test/fixtures.ts";
import { drainSockets, EXPLORER, NETWORK, PAY_TO, TX_HASH, type Running } from "./watch-server.ts";

let events: SseEvent[] = [];
let nw: Running;
before(async () => {
  ({ events, nw } = await recordSession());
});
after(async () => {
  await nw.close();
  await drainSockets();
});

const replay = (list: SseEvent[], from: LiveState = emptyState()): LiveState => list.reduce((s, e) => applyEvent(s, e.event, e.data), from);
const counts = (list: SseEvent[]): Record<string, number> => list.reduce<Record<string, number>>((a, e) => ({ ...a, [e.event]: (a[e.event] ?? 0) + 1 }), {});

test("CONSOLE-STORE the session starts with hello and replays with nothing refused or unknown", () => {
  assert.equal(events[0].event, "hello");
  const s = replay(events);
  assert.equal(s.stats.errors, 0, s.stats.lastError ?? "");
  assert.deepEqual(s.stats.ignored, {});
  assert.deepEqual(s.stats.applied, counts(events));
  assert.equal(s.hasHello, true);
  assert.deepEqual(s.networks, [NETWORK]);
  for (const name of ["ledger", "tx", "road", "claim", "reconcile", "seller"]) assert.ok((s.stats.applied as Record<string, number>)[name], `${name} in the session`);
});

test("CONSOLE-STORE the transfer is held once, hash exactly as sent; the winning road and the later road with its lag", () => {
  const s = replay(events);
  const t = s.txs.find((x) => x.key === txKey(NETWORK, TX_HASH));
  assert.ok(t, "the recorded transfer");
  assert.equal(s.txs.filter((x) => x.hash.toLowerCase() === TX_HASH.toLowerCase()).length, 1);
  assert.equal(t.hash, TX_HASH, "base58 is case-sensitive: never upper-cased");
  assert.equal(t.firstVia, "neardata");
  assert.deepEqual(t.roads.map((r) => r.via), ["qn-rpc"]);
  assert.ok(t.roads[0].lagMs >= 0);
  assert.equal(t.links?.tx, `${EXPLORER}/txns/${TX_HASH}`, "near-watch's link, not one built here");
  assert.equal(t.row.value, "0.01");
  assert.equal(t.row.amount, "10000");
  assert.equal(t.row.memo, null);
  assert.equal(t.row.blockHeight, fixture.receiptHeight, "the block the USDC receipt executed in");
  assert.equal(lastLedger(s, NETWORK), fixture.receiptHeight);
  const again = replay(events.filter((e) => e.event === "tx" || e.event === "road"), s);
  assert.equal(again.txs.length, s.txs.length, "replaying adds nothing");
  assert.deepEqual(again.txs.find((x) => x.key === t.key)?.roads, t.roads, "the same road twice is kept once");
});

test("CONSOLE-STORE road statistics: one first arrival per new tx, one later arrival per road event", () => {
  const s = replay(events);
  assert.equal(s.roadStats[NETWORK]?.neardata?.first, 1);
  assert.equal(s.roadStats[NETWORK]?.["qn-rpc"]?.later, events.filter((e) => e.event === "road").length);
});

test("CONSOLE-STORE claims and reconcile: one claim per payment; matched by tx hash for the recorded payment, pending for an unseen hash", () => {
  const s = replay(events);
  assert.equal(s.claims.length, 2);
  const r = s.recon[txKey(NETWORK, TX_HASH)];
  assert.equal(r?.state, "matched", "no memo on chain: joined by the exact tx hash");
  assert.equal(r?.invoiceId, "INV-RECORDED-1", "the claim's invoiceId, shown");
  assert.equal(r?.detail, null);
  assert.equal(s.recon[txKey(NETWORK, UNSEEN_HASH)]?.state, "pending");
  assert.ok(s.rail.some((r) => /^claim 0\.01 USDC from buyer/.test(r.text)), "claim base units shown as a decimal with the Seller Wallet's decimals");
});

test("CONSOLE-STORE Seller Wallet: hello carries it, each seller event replaces it; the recorded payment counts as x402", () => {
  const s = replay(events);
  const w = s.seller?.wallets[0];
  assert.equal(w?.address, PAY_TO);
  assert.equal(w?.asset.decimals, 6);
  assert.equal(w?.received.amount, "0.01");
  assert.equal(w?.received.manualCount, 0);
  assert.equal(w?.received.x402Count, 1);
  assert.equal(w?.recent[0]?.hash, TX_HASH);
  assert.equal(w?.inFlight.claims, 1, "the unseen claim is in flight; the recorded one has its transfer");
  const hello = replay(events.slice(0, 1));
  assert.equal(hello.seller?.wallets[0]?.received.count, 0, "before the transfer");
});

test("CONSOLE-STORE a second hello (reconnect) replaces the data and keeps the session (counters, lags, change log)", () => {
  const s = replay(events);
  const r = applyEvent(s, "hello", events[0].data);
  assert.equal(r.txs.length, 0, "the first hello came before the transfer");
  assert.equal(r.claims.length, 0);
  assert.equal(r.stats.applied.hello, (s.stats.applied.hello ?? 0) + 1);
  assert.deepEqual(r.roadStats, s.roadStats);
  assert.equal(r.rail.length, Math.min(s.rail.length + 1, 80));
});

test("CONSOLE-STORE malformed or unknown events are counted, never thrown, and change no data", () => {
  const s = replay(events);
  const a = applyEvent(s, "ledger", { network: NETWORK, index: "not a number" });
  assert.equal(a.stats.errors, s.stats.errors + 1);
  assert.match(a.stats.lastError ?? "", /^ledger: index/);
  assert.deepEqual(a.ledgers, s.ledgers);
  const hex = applyEvent(s, "tx", { row: { hash: "15EB0D1B91309F5D1050D0CB3B2E0EE07100B54B4646577B43A1A39F1BCE6BCC", blockHeight: 1, value: "1" }, via: "neardata", network: NETWORK });
  assert.equal(hex.txs, s.txs, "an XRPL hex hash is not a NEAR hash");
  const claim = applyEvent(s, "claim", { claim: { network: NETWORK, hash: UNSEEN_HASH, amount: "4.5" } });
  assert.match(claim.stats.lastError ?? "", /claim\.amount is not base units/);
  const seller = applyEvent(s, "seller", { wallets: [{ network: NETWORK, address: PAY_TO, asset: { decimals: 6 }, balance: {}, received: { amount: 1 }, inFlight: {}, window: {}, unwatched: {} }] });
  assert.match(seller.stats.lastError ?? "", /seller received\.amount is not a decimal string/);
  assert.equal(seller.seller, s.seller, "the last good figures stay");
  const h = applyEvent(s, "hello", { networks: [NETWORK], seller: { wallets: 5 } });
  assert.equal(h.hasHello, true, "the rest of hello is applied");
  assert.equal(h.seller, null);
  const c = applyEvent(s, "webhook", {});
  assert.equal(c.stats.ignored.webhook, 1);
});
