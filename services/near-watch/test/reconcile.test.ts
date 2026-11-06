import assert from "node:assert/strict";
import { test } from "node:test";
import { IngestError, parseClaim } from "../src/claims.ts";
import { decodeOutcome, neardataBlock } from "../src/decode.ts";
import { Bus } from "../src/events.ts";
import { graceReport, Reconciler, REJUDGED } from "../src/reconcile.ts";
import { Store, type ClaimRow } from "../src/store.ts";
import { AMOUNT, ctx, fixture as fx, LATE_LIVE, lateFixture, RECEIVER, SENDER } from "./fixtures.ts";

/** The paywall's invoice id for the call: on the claim only, never on chain (the transfer has no memo). */
const INV = "0123456789ABCDEF0123456789ABCDEF";
const CAIPS = { "near:testnet": "testnet" };
const x402Row = () => neardataBlock(fx.neardata[String(fx.receiptHeight)], fx.contract).outcomes.flatMap((o) => decodeOutcome(o, ctx()))[0];
const line = (over: Record<string, unknown> = {}) => ({ ts: "2026-11-04T10:00:00.000Z", event: "payment_settled", route: "POST /v1/chat", amount: AMOUNT, asset: fx.contract, network: "near:testnet", payer: SENDER, transaction: fx.tx, invoiceId: INV, ...over });

function setup(grace = 3) {
  const store = new Store(":memory:");
  const bus = new Bus();
  const rec = new Reconciler(store, bus, { networks: ["testnet"], payTo: new Map([["testnet", new Set([RECEIVER])]]), graceBlocks: grace, batch: 100 });
  const tip = (h: number) => bus.emit("ledger", { network: "testnet", index: h, closeTime: null, txCount: 0, ourCount: 0, ourAmount: "0", via: "neardata" });
  const claim = (over: Record<string, unknown> = {}): ClaimRow => ({ ...parseClaim(line(over), CAIPS), source: "http", receivedMs: Date.now(), seenBlock: rec.tip("testnet") });
  return { store, bus, rec, tip, claim };
}

test("parseClaim: base-unit amounts, NEAR CAIP-2 from config, base58 hash", () => {
  const c = parseClaim(line(), CAIPS);
  assert.equal(c.amount, AMOUNT);
  assert.equal(c.network, "testnet");
  assert.throws(() => parseClaim(line({ amount: "4.5" }), CAIPS), IngestError);
  assert.throws(() => parseClaim(line({ network: "xrpl:1" }), CAIPS), IngestError);
  assert.throws(() => parseClaim(line({ transaction: "AB".repeat(32) }), CAIPS), IngestError);
  assert.throws(() => parseClaim(line({ payer: "Not An Account" }), CAIPS), IngestError);
});

test("claim + the memo-less chain transfer with the same tx hash -> matched; the claim's invoiceId is shown", () => {
  const { store, rec, tip, claim } = setup();
  tip(fx.receiptHeight);
  const row = x402Row();
  assert.equal(row.memo, null);
  store.recordArrival(row, "neardata", Date.now());
  const c = claim();
  store.insertClaim(c);
  rec.onClaim(c);
  const r = store.getRecon("testnet", fx.tx);
  assert.equal(r?.state, "matched");
  assert.equal(r?.detail, null);
  assert.equal(r?.invoiceId, INV, "carried from the claim for display");
  assert.equal(store.txByInvoice(INV)?.row.hash, fx.tx, "invoice -> transfer goes through the claim");
});

test("a claim without an invoiceId matches too: the join is the tx hash alone", () => {
  const { store, rec, tip, claim } = setup();
  tip(fx.receiptHeight);
  store.recordArrival(x402Row(), "neardata", Date.now());
  const c = claim({ invoiceId: undefined });
  store.insertClaim(c);
  rec.onClaim(c);
  assert.equal(store.getRecon("testnet", fx.tx)?.state, "matched");
  assert.equal(store.getRecon("testnet", fx.tx)?.invoiceId, null);
});

test("the hash join is exact: a claim naming the hash in other case does not join", () => {
  const { store, rec, tip, claim } = setup();
  tip(fx.receiptHeight);
  store.recordArrival(x402Row(), "neardata", Date.now());
  const swapped = fx.tx.replace("Z", "z"); // H3ZF… -> H3zF…: still valid base58
  const c = claim({ transaction: swapped });
  assert.notEqual(c.hash, fx.tx);
  store.insertClaim(c);
  rec.onClaim(c);
  assert.equal(store.getRecon("testnet", c.hash)?.state, "pending", "waiting for a transfer with exactly that hash");
  assert.equal(store.getRecon("testnet", fx.tx), undefined);
});

test("claim that disagrees on amount -> mismatch with the reason", () => {
  const { store, rec, tip, claim } = setup();
  tip(fx.receiptHeight);
  store.recordArrival(x402Row(), "neardata", Date.now());
  const c = claim({ amount: "4500000" });
  store.insertClaim(c);
  rec.onClaim(c);
  const r = store.getRecon("testnet", fx.tx);
  assert.equal(r?.state, "mismatch");
  assert.match(r?.detail ?? "", /chain moved 10000 base units, the log says 4500000/);
});

test("claim with no chain transfer: pending, then only_in_log after the grace", () => {
  const { store, rec, tip, claim } = setup(3);
  tip(1000);
  const c = claim({ transaction: "9".repeat(44) });
  store.insertClaim(c);
  rec.onClaim(c);
  assert.equal(store.getRecon("testnet", c.hash)?.state, "pending");
  tip(1003);
  rec.run();
  assert.equal(store.getRecon("testnet", c.hash)?.state, "pending");
  tip(1004);
  rec.run();
  assert.equal(store.getRecon("testnet", c.hash)?.state, "only_in_log");
});

test("x402 transfer with no claim: only_on_ledger after the grace", () => {
  const { store, rec, tip } = setup(3);
  tip(fx.receiptHeight - 1); // reconciling starts here
  rec.run();
  const r = x402Row();
  store.recordArrival(r, "neardata", Date.now());
  rec.onTx(r);
  assert.equal(store.getRecon("testnet", r.hash)?.state, "pending");
  tip(fx.receiptHeight + 4);
  rec.run();
  assert.equal(store.getRecon("testnet", r.hash)?.state, "only_on_ledger");
});

// ---- false mismatch from a wrong pay-to at read time (live 2026-11-06, jobs 09ebdf3d… and bef914c0…) ----

/** The real x402 payment read while near-watch's pay-to was another account: kept (the buyer is watched), not x402. */
const readWithWrongPayTo = () => neardataBlock(fx.neardata[String(fx.receiptHeight)], fx.contract).outcomes.flatMap((o) => decodeOutcome(o, ctx({ payTo: new Set(["chainaim-old-payto.testnet"]) })))[0];
const REASON = "receiver checked on nearblocks: chainaim-payto-seller.testnet; near-watch pay-to was misconfigured";

function falseMismatch() {
  const s = setup();
  const alerts: { code: string; message: string }[] = [];
  s.bus.on((name, data) => {
    if (name === "alert") alerts.push(data as { code: string; message: string });
  });
  s.tip(fx.receiptHeight);
  const row = readWithWrongPayTo();
  s.store.recordArrival(row, "rpc", Date.now());
  const c = s.claim();
  s.store.insertClaim(c);
  s.rec.onClaim(c);
  return { ...s, row, c, alerts };
}

test("wrong pay-to at read time: mismatch, and the detail names the receiver (status, method and events were right)", () => {
  const { store, row } = falseMismatch();
  assert.equal(row.isX402, false);
  assert.equal(row.to, RECEIVER);
  const r = store.getRecon("testnet", fx.tx);
  assert.equal(r?.state, "mismatch");
  assert.equal(r?.detail, `the chain transfer is not a valid x402 NEAR USDC payment (status success, method ft_transfer, 1 transfer event(s); into ${RECEIVER}, which was not a watched pay-to when near-watch read the transfer)`);
});

test("the read-time verdict is final: later passes and a repeated claim leave the false mismatch alone", () => {
  const { store, rec, tip, c } = falseMismatch();
  tip(fx.receiptHeight + 100);
  rec.run();
  rec.onClaim(c);
  assert.equal(store.getRecon("testnet", fx.tx)?.state, "mismatch", "a config fix alone never blesses old payments");
});

test("rejudge: refused, changing nothing, unless the receiver, the current pay-to and the claim all agree", () => {
  const { store, rec } = falseMismatch();
  const before = store.getRecon("testnet", fx.tx);
  const ask = (over: Partial<{ network: string; hash: string; receiver: string; reason: string }> = {}) => rec.rejudge({ network: "testnet", hash: fx.tx, receiver: RECEIVER, reason: REASON, ...over });
  const refused = (over: Parameters<typeof ask>[0], status: number, re: RegExp) => {
    const r = ask(over);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, status);
      assert.match(r.error, re);
    }
  };
  refused({ receiver: SENDER }, 409, /is not a watched pay-to now/);
  refused({ reason: "   " }, 400, /reason must be/);
  refused({ reason: "two\nlines" }, 400, /reason must be/);
  refused({ reason: "x".repeat(201) }, 400, /reason must be/);
  refused({ hash: "9".repeat(44) }, 404, /no reconcile row/);
  refused({ hash: "not-a-hash" }, 400, /base58/);
  refused({ network: "mainnet" }, 400, /not watched/);
  // A pay-to that is watched now but is not where the transfer went.
  const other = new Reconciler(store, new Bus(), { networks: ["testnet"], payTo: new Map([["testnet", new Set([RECEIVER, "chainaim-other-payto.testnet"])]]), graceBlocks: 3, batch: 100 });
  const r = other.rejudge({ network: "testnet", hash: fx.tx, receiver: "chainaim-other-payto.testnet", reason: REASON });
  assert.ok(!r.ok && r.status === 409 && /went to chainaim-payto-seller\.testnet, not chainaim-other-payto\.testnet/.test(r.error));
  assert.deepEqual(store.getRecon("testnet", fx.tx), before, "nothing changed");
});

test("rejudge: a real disagreement (amount) stays a mismatch", () => {
  const { store, rec, tip, claim } = setup();
  tip(fx.receiptHeight);
  store.recordArrival(readWithWrongPayTo(), "rpc", Date.now());
  const c = claim({ amount: "4500000" });
  store.insertClaim(c);
  rec.onClaim(c);
  const r = rec.rejudge({ network: "testnet", hash: fx.tx, receiver: RECEIVER, reason: REASON });
  assert.ok(!r.ok && r.status === 409 && /still disagrees: chain moved 10000 base units, the log says 4500000/.test(r.error));
  assert.equal(store.getRecon("testnet", fx.tx)?.state, "mismatch");
});

test("rejudge: the false mismatch becomes matched, keeps what it was and why, alerts once, and stays matched", () => {
  const { store, rec, tip, c, alerts, bus } = falseMismatch();
  const was = store.getRecon("testnet", fx.tx)?.detail;
  const events: { state: string; previous: string | null }[] = [];
  bus.on((name, data) => {
    if (name === "reconcile") events.push(data as { state: string; previous: string | null });
  });
  const r = rec.rejudge({ network: "testnet", hash: fx.tx, receiver: RECEIVER, reason: `  ${REASON}  ` });
  assert.equal(r.ok, true);
  const row = store.getRecon("testnet", fx.tx);
  assert.equal(row?.state, "matched");
  assert.equal(row?.invoiceId, INV);
  assert.ok(row?.detail?.startsWith(REJUDGED));
  assert.match(row?.detail ?? "", /^re-judged \d{4}-\d\d-\d\dT[\d:.]+Z by operator: was mismatch \(/);
  assert.ok(row?.detail?.includes(`(${was}); reason: ${REASON}`), "the old detail and the trimmed reason are kept");
  assert.deepEqual(events.map((e) => [e.state, e.previous]), [["matched", "mismatch"]], "one reconcile event (the Jobs tab follows it)");
  assert.equal(alerts.filter((a) => a.code === "reconcile_rejudged").length, 1);
  assert.deepEqual([store.reconCounts("testnet").matched, store.reconCounts("testnet").mismatch], [1, 0]);
  // Later passes, a repeated claim and a second re-judge do not undo or repeat it.
  tip(fx.receiptHeight + 100);
  rec.run();
  rec.onClaim(c);
  assert.equal(store.getRecon("testnet", fx.tx)?.detail, row?.detail);
  const again = rec.rejudge({ network: "testnet", hash: fx.tx, receiver: RECEIVER, reason: REASON });
  assert.ok(!again.ok && again.status === 409 && /the row is matched/.test(again.error));
});

// ---- late arrival: the real BFEX1KAH… payment, with the times the live store recorded ----

function lateSetup(grace = 30) {
  let now: number = LATE_LIVE.claimReceivedMs;
  const store = new Store(":memory:");
  const bus = new Bus();
  const alerts: { code: string; message: string }[] = [];
  bus.on((name, data) => {
    if (name === "alert") alerts.push(data as { code: string; message: string });
  });
  const rec = new Reconciler(store, bus, { networks: ["testnet"], payTo: new Map([["testnet", new Set([RECEIVER])]]), graceBlocks: grace, batch: 100, now: () => now });
  const tip = (h: number) => bus.emit("ledger", { network: "testnet", index: h, closeTime: null, txCount: 0, ourCount: 0, ourAmount: "0", via: "rpc" });
  const lf = lateFixture;
  const row = neardataBlock(lf.neardata[String(lf.receiptHeight)], lf.contract).outcomes.flatMap((o) => decodeOutcome(o, ctx({ usdcContract: lf.contract })))[0];
  const claimRow = (): ClaimRow => ({
    ...parseClaim({ ts: new Date(LATE_LIVE.claimTsMs).toISOString(), event: "payment_settled", route: "POST /v1/privacy/scan", amount: "10000", asset: lf.contract, network: "near:testnet", payer: SENDER, transaction: lf.tx, invoiceId: LATE_LIVE.invoiceId }, CAIPS),
    source: "http",
    receivedMs: LATE_LIVE.claimReceivedMs,
    seenBlock: LATE_LIVE.claimSeenBlock,
  });
  return { store, bus, rec, tip, row, claimRow, alerts, at: (ms: number) => (now = ms) };
}

test("late transfer: an only_in_log claim becomes matched on the same (network, hash), with the lateness shown", () => {
  const { store, rec, tip, row, claimRow, alerts, at } = lateSetup(30);
  assert.equal(row.isX402, true);
  assert.equal(row.memo, null);
  tip(LATE_LIVE.claimSeenBlock);
  rec.run(); // reconciling starts at the tip
  const c = claimRow();
  store.insertClaim(c);
  rec.onClaim(c);
  assert.equal(store.getRecon("testnet", lateFixture.tx)?.state, "pending");
  at(LATE_LIVE.claimReceivedMs + 39_000); // live: only_in_log at 14:32:46
  tip(LATE_LIVE.claimSeenBlock + 31);
  rec.run();
  assert.equal(store.getRecon("testnet", lateFixture.tx)?.state, "only_in_log");
  assert.ok(alerts.some((a) => a.code === "reconcile_only_in_log"));

  at(LATE_LIVE.rpcSeenMs);
  store.recordArrival(row, "rpc", LATE_LIVE.rpcSeenMs);
  rec.onTx(row);
  const r = store.getRecon("testnet", lateFixture.tx);
  assert.equal(r?.state, "matched");
  assert.equal(r?.invoiceId, LATE_LIVE.invoiceId);
  assert.match(r?.detail ?? "", /^late: was only_in_log for 16\.5 s; the transfer was recorded 55\.5 s after the claim \(via rpc, 58\.2 s after its block\), past the 30-block grace$/);
  assert.ok(alerts.some((a) => a.code === "reconcile_late_match" && a.message.includes(LATE_LIVE.invoiceId)));

  // The later road and later passes keep the one row and its lateness.
  at(LATE_LIVE.qnRpcSeenMs);
  assert.equal(store.recordArrival(row, "qn-rpc", LATE_LIVE.qnRpcSeenMs).kind, "later");
  tip(LATE_LIVE.claimSeenBlock + 200);
  rec.run();
  rec.onClaim(c);
  assert.equal(store.getRecon("testnet", lateFixture.tx)?.detail, r?.detail);
  assert.equal(store.reconCounts("testnet").matched, 1);
  assert.equal(store.reconCounts("testnet").only_in_log, 0);
});

test("late claim: an only_on_ledger transfer and its claim merge into one matched row", () => {
  const { store, rec, tip, row, claimRow, at } = lateSetup(30);
  tip(lateFixture.receiptHeight - 1);
  rec.run();
  at(LATE_LIVE.rpcSeenMs);
  store.recordArrival(row, "rpc", LATE_LIVE.rpcSeenMs);
  rec.onTx(row);
  tip(lateFixture.receiptHeight + 31);
  at(LATE_LIVE.rpcSeenMs + 20_000);
  rec.run();
  assert.equal(store.getRecon("testnet", lateFixture.tx)?.state, "only_on_ledger");
  const c = { ...claimRow(), receivedMs: LATE_LIVE.rpcSeenMs + 30_000 };
  at(c.receivedMs);
  store.insertClaim(c);
  rec.onClaim(c);
  const r = store.getRecon("testnet", lateFixture.tx);
  assert.equal(r?.state, "matched");
  assert.equal(r?.side, "log");
  assert.match(r?.detail ?? "", /^late: was only_on_ledger for 10\.0 s; the claim arrived 30\.0 s after the transfer was recorded/);
  const counts = store.reconCounts("testnet");
  assert.deepEqual([counts.matched, counts.only_on_ledger, counts.only_in_log], [1, 0, 0], "one row for the payment");
});

test("a gap whose two sides are both stored is re-decided by run() even if the tx event was missed", () => {
  const { store, rec, tip, row, claimRow, at } = lateSetup(30);
  tip(LATE_LIVE.claimSeenBlock);
  rec.run();
  const c = claimRow();
  store.insertClaim(c);
  rec.onClaim(c);
  tip(LATE_LIVE.claimSeenBlock + 31);
  rec.run();
  assert.equal(store.getRecon("testnet", lateFixture.tx)?.state, "only_in_log");
  at(LATE_LIVE.rpcSeenMs);
  store.recordArrival(row, "rpc", LATE_LIVE.rpcSeenMs); // e.g. recorded by backfill before LiveOps started: no onTx
  rec.run();
  assert.equal(store.getRecon("testnet", lateFixture.tx)?.state, "matched");
});

test("graceReport: the grace in blocks and time, its default, and a warning when the roads trail the chain by more", () => {
  // 0.578 s a block (testnet, 2026-11-04). At the claim the newest block read was 63 blocks (~36 s) old: the live case.
  const blocks = (n: number, from: number, t0: number) => Array.from({ length: n }, (_, i) => ({ network: "testnet", index: from + i, closeTime: t0 + i * 578, txCount: 0, ourCount: 0, ourAmount: "0", via: "rpc" as const }));
  const list = blocks(20, LATE_LIVE.claimSeenBlock - 19, 1_000_000);
  const newest = list[list.length - 1].closeTime;
  const live = graceReport(30, 30, list, newest + 63 * 578);
  assert.equal(live.blockMs, 578);
  assert.equal(live.graceMs, 30 * 578);
  assert.equal(live.trailBlocks, 63);
  assert.match(live.tradeoff, /^30 final blocks \(default 30\) ≈ 17\.3 s/);
  assert.match(live.warning ?? "", /trail the chain by ~63 blocks .* at least the 30-block grace/);
  const caughtUp = graceReport(30, 30, list, newest + 2 * 578);
  assert.equal(caughtUp.trailBlocks, 2);
  assert.equal(caughtUp.warning, null);
  assert.equal(graceReport(30, 30, [], 0).blockMs, null, "nothing read yet");
});
