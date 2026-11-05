/**
 * Paid jobs (architecture-adminui-jobs.md ARCH-201, ARCH-206..209) through the real app over the protocol doubles of
 * the recorded real testnet payment (x402-near-payment.json, H3ZFsVY1…, matched on chain by the RPC road), with job
 * events posted to /ingest/job as the private-ai console's job feed sends them.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { LowGasRule, paymentsCovered } from "../src/alerts.ts";
import { loadConfig } from "../src/config.ts";
import { Bus, type AlertEvent } from "../src/events.ts";
import { parseJobEvent } from "../src/jobs.ts";
import { startApp, type App } from "../src/main.ts";
import { Store } from "../src/store.ts";
import { AMOUNT, fixture as fx, lateFixture, RECEIVER, RELAYER, SENDER } from "./fixtures.ts";
import { NeardataDouble } from "./neardata-double.ts";
import { NearRpcDouble } from "./near-rpc-double.ts";

const ADMIN = "admin-key-for-tests-0123456789";
const INGEST = "ingest-key-for-tests-0123456789";
const dir = mkdtempSync(join(tmpdir(), "near-watch-jobs-"));
let nd: NeardataDouble;
let rpc: NearRpcDouble;
before(async () => {
  nd = new NeardataDouble(fx);
  rpc = new NearRpcDouble(fx);
  await nd.listen();
  await rpc.listen();
});
after(async () => {
  await nd.close();
  await rpc.close();
  rmSync(dir, { recursive: true, force: true });
});

const ENV = { ADMIN_API_KEY: ADMIN, NEAR_WATCH_INGEST_KEY: INGEST, NEAR_USDC_CONTRACT_TESTNET: fx.contract, NEAR_PAY_TO_TESTNET: RECEIVER };
async function start(store: string, extra: string[] = [], env: Record<string, string> = ENV): Promise<App> {
  const argv = ["--neardata-url", nd.url, "--rpc-fallback-url", rpc.url, "--port", "0", "--store", store, "--watch", `buyer1=buyer=${SENDER}`, "--poll-sec", "1", "--neardata-min-ms", "0", "--long-poll-ms", "1000", "--settle-grace-blocks", "5", "--feeds", "rpc", "--backfill", "off", ...extra];
  return startApp(loadConfig(argv, env), { log: () => {} });
}
function seed(path: string): void {
  const s = new Store(path);
  s.setCursor("testnet", "rpc", fx.inclusionHeight - 1);
  s.close();
}
async function until<T>(fn: () => T | undefined | false | null, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const get = (app: App, path: string, key = ADMIN) => fetch(`http://127.0.0.1:${app.port}${path}`, { headers: { "x-admin-key": key } });
const post = (app: App, path: string, body: unknown, key: string | null = INGEST) =>
  fetch(`http://127.0.0.1:${app.port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-ingest-key": key } : {}) }, body: JSON.stringify(body) });

/** A job_quoted as test-console/console/job-feed.ts builds it: two Bedrock model calls priced by cost.ts. */
function quoted(jobId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, event: "job_quoted", ts: "2026-11-05T10:00:00.000Z", jobId, network: "near:testnet", amount: "12001", totalUsd: "0.012001", expiresAt: "2026-11-05T10:15:00.000Z",
    steps: [
      { name: "analyst", ms: 412, files: 2, relations: 1 },
      { name: "query", ms: 2310, model: "bedrock/nemotron-nano-3-30b", zone: "private-cloud", promptTokens: 1000, completionTokens: 50, usd: "0.000075", entityCounts: { PERSON: 3, EMAIL_ADDRESS: 1 }, residual: "pass" },
      { name: "sql", ms: 38, rows: 4 },
      { name: "answer", ms: 1804, model: "bedrock/nemotron-nano-3-30b", zone: "private-cloud", promptTokens: 2000, completionTokens: 150, usd: "0.000161", entityCounts: {}, residual: "pass" },
    ],
    breakdown: {
      calls: [{ model: "bedrock/nemotron-nano-3-30b", promptTokens: 1000, completionTokens: 50, usd: "0.000075" }, { model: "bedrock/nemotron-nano-3-30b", promptTokens: 2000, completionTokens: 150, usd: "0.000161" }],
      modelUsd: "0.000236", callFeesUsd: "0.002000", analystUsd: "0.002000", nearGasUsd: "0.000500", marginPct: "20", minPriceUsd: "0.01", minApplied: true,
    },
    ...over,
  };
}
const closed = (event: string, jobId: string, ts = "2026-11-05T10:20:00.000Z") => ({ v: 1, event, ts, jobId, network: "near:testnet" });
const claimFor = (jobId: string, hash: string) => ({ ts: "2026-11-05T10:01:00.000Z", event: "payment_settled", route: `POST /v1/jobs/${jobId}/release`, amount: AMOUNT, asset: fx.contract, network: "near:testnet", payer: SENDER, transaction: hash, invoiceId: "0123456789ABCDEF0123456789ABCDEF" });
const ID = (n: number) => n.toString(16).padStart(32, "0");
/** A third base58 hash for a claim no transfer backs (the doubles serve only the recorded one). */
const OTHER = fx.tx.replace("Z", "z");
const alerts = (app: App, code: string) => app.bus.alerts.filter((a) => a.code === code);

/** Today's snapshot keys and the liveOps keys inside it (server.ts, liveops.ts), before any job. */
const SNAPSHOT_KEYS = ["alerts", "balances", "counters", "ledgers", "liveOps", "networks", "seller", "startedAt", "status", "token", "txs", "version", "watchlist"];

describe("paid jobs on near-watch", () => {
  let app: App;
  const store = join(dir, "jobs.sqlite");
  before(async () => {
    seed(store);
    app = await start(store);
    await until(() => app.store.getTx("testnet", fx.tx));
  });
  after(() => app.stop());

  test("ARCH-201: snapshot keys unchanged when no job was ingested", async () => {
    const snap = (await (await get(app, "/api/snapshot")).json()) as Record<string, any>;
    assert.deepEqual(Object.keys(snap).sort(), SNAPSHOT_KEYS);
    assert.deepEqual(Object.keys(snap.liveOps).sort(), ["claims", "counters", "metrics", "reconcile"]);
    assert.deepEqual(Object.keys(snap.liveOps.counters).sort(), ["claimRepeats", "claims", "reconcileChanges", "reconcilePasses", "refused", "tail", "traceRepeats", "traces"]);
    // A claim that is not a job's release route makes no job either.
    assert.equal((await post(app, "/ingest/claim", { ...claimFor(ID(99), fx.tx.replace("S", "s")), route: "POST /v1/chat" })).status, 202);
    assert.equal(app.store.hasJobs(), false);
    assert.deepEqual(Object.keys((await (await get(app, "/api/snapshot")).json()) as object).sort(), SNAPSHOT_KEYS);
  });

  test("ARCH-206: 401 without the ingest key, and with the admin key", async () => {
    assert.equal((await post(app, "/ingest/job", quoted(ID(1)), null)).status, 401);
    assert.equal((await post(app, "/ingest/job", quoted(ID(1)), ADMIN)).status, 401);
    assert.equal(app.store.getJob(ID(1)), undefined);
  });

  test("ARCH-206: each refusal reason is refused whole (400), stored nothing and alerted job_refused", async () => {
    const id = ID(2);
    const q = quoted(id) as Record<string, any>;
    const bad: [string, unknown][] = [
      ["not an object", "job"],
      ["v", { ...q, v: 2 }],
      ["unknown event", { ...q, event: "job_paid" }],
      ["bad id (upper case)", { ...q, jobId: "ABCDEF0123456789ABCDEF0123456789" }],
      ["bad id (short)", { ...q, jobId: "abc" }],
      ["unwatched network", { ...q, network: "near:mainnet" }],
      ["bad ts", { ...q, ts: "yesterday" }],
      ["negative number", { ...q, steps: [{ ...q.steps[0], ms: -1 }] }],
      ["fractional tokens", { ...q, steps: [q.steps[0], { ...q.steps[1], promptTokens: 1.5 }] }],
      ["number as text", { ...q, steps: [{ ...q.steps[0], files: "2" }] }],
      ["unknown field (text-like)", { ...q, question: "how many orders?" }],
      ["unknown step field", { ...q, steps: [{ ...q.steps[0], sql: "SELECT 1" }] }],
      ["unknown step name", { ...q, steps: [{ name: "answer_text", ms: 1 }] }],
      ["model id too long", { ...q, steps: [q.steps[0], { ...q.steps[1], model: "m".repeat(129) }] }],
      ["model id with spaces", { ...q, steps: [q.steps[0], { ...q.steps[1], model: "the answer is 42" }] }],
      ["entity kind that is text", { ...q, steps: [q.steps[0], { ...q.steps[1], entityCounts: { "Jane Roe": 1 } }] }],
      ["residual", { ...q, steps: [q.steps[0], { ...q.steps[1], residual: "maybe" }] }],
      ["amount 0", { ...q, amount: "0" }],
      ["amount not units", { ...q, amount: "0.01" }],
      ["usd with 7 decimals", { ...q, totalUsd: "0.0120001" }],
      ["breakdown unknown field", { ...q, breakdown: { ...q.breakdown, note: "x" } }],
      ["no steps", { ...q, steps: [] }],
      ["released with extra field", { ...closed("job_released", id), amount: "1" }],
    ];
    for (const [why, body] of bad) {
      const before = alerts(app, "job_refused").length + (app.liveOps.counters.refused);
      const r = await post(app, "/ingest/job", body);
      assert.equal(r.status, 400, why);
      const j = (await r.json()) as { refused: { error: string }[] };
      assert.equal(j.refused.length, 1, why);
      assert.equal(app.store.getJob(id), undefined, `${why}: nothing stored`);
      assert.ok(alerts(app, "job_refused").length + app.liveOps.counters.refused > before, `${why}: counted and alerted`);
    }
    assert.ok(alerts(app, "job_refused").length >= 1, "job_refused raised (AlertGate: at most once per --alert-every-sec)");
    assert.ok(parseJobEvent(quoted(id), { "near:testnet": "testnet" }), "the well-formed event parses");
  });

  test("ARCH-206 / ARCH-207: quoted -> paid -> released with the real payment; repeats accepted and dropped; reconcile matched", async () => {
    const id = ID(3);
    let r = await post(app, "/ingest/job", quoted(id));
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { accepted: 1, repeats: 0, refused: [] });
    assert.equal(app.store.getJob(id)?.state, "quoted");
    r = await post(app, "/ingest/job", quoted(id));
    assert.deepEqual(await r.json(), { accepted: 0, repeats: 1, refused: [] }, "a repeat is accepted and dropped");

    assert.equal((await post(app, "/ingest/claim", claimFor(id, fx.tx))).status, 202);
    const paid = app.liveOps.jobs.view(app.store.getJob(id)!);
    assert.deepEqual([paid.state, paid.txHash, paid.payer, paid.invoiceId, paid.reconcile, paid.noJobEvent], ["paid", fx.tx, SENDER, "0123456789ABCDEF0123456789ABCDEF", "matched", false]);

    assert.equal((await post(app, "/ingest/job", closed("job_released", id))).status, 202);
    assert.equal(app.store.getJob(id)?.state, "released");
    assert.deepEqual(await (await post(app, "/ingest/job", closed("job_released", id))).json(), { accepted: 0, repeats: 1, refused: [] });
    // A late expiry never un-pays a job.
    await post(app, "/ingest/job", closed("job_expired", id));
    assert.equal(app.store.getJob(id)?.state, "released");
  });

  test("ARCH-207: quoted -> expired adds its model cost, call fees and analyst fee to lost compute", async () => {
    const before = (await (await get(app, "/api/jobs")).json()) as { lostCompute: Record<string, string> };
    const id = ID(4);
    await post(app, "/ingest/job", quoted(id));
    assert.equal((await post(app, "/ingest/job", closed("job_expired", id))).status, 202);
    assert.equal(app.store.getJob(id)?.state, "expired");
    const after = (await (await get(app, "/api/jobs")).json()) as { lostCompute: Record<string, string>; counts: Record<string, number> };
    // 0.000236 + 0.002000 + 0.002000 (gas and margin were never spent)
    assert.equal(BigInt(after.lostCompute.testnet.replace(".", "")) - BigInt(before.lostCompute.testnet.replace(".", "")), 4236n);
    assert.match(after.lostCompute.testnet, /^\d+\.\d{6}$/);
    assert.ok(after.counts.expired >= 1);
  });

  test("ARCH-207: a claim before its job event (late job_quoted) still links", async () => {
    const id = ID(5);
    assert.equal((await post(app, "/ingest/claim", claimFor(id, lateFixture.tx))).status, 202);
    const early = app.liveOps.jobs.view(app.store.getJob(id)!);
    assert.deepEqual([early.state, early.noJobEvent, early.txHash], ["paid", true, lateFixture.tx], "paid (no job event)");
    assert.equal((await post(app, "/ingest/job", quoted(id))).status, 202);
    const late = app.liveOps.jobs.view(app.store.getJob(id)!);
    assert.deepEqual([late.state, late.noJobEvent, late.txHash, late.amount], ["paid", false, lateFixture.tx, "12001"]);
    assert.equal(late.steps?.length, 4);
  });

  test("ARCH-207: a claim for an unknown job raises job_unknown once", async () => {
    const id = ID(6);
    const n = alerts(app, "job_unknown").filter((a) => a.message.includes(id)).length;
    assert.equal(n, 0);
    // The ID(5) claim above was unknown too when it arrived: one alert for it.
    assert.equal(alerts(app, "job_unknown").filter((a) => a.message.includes(ID(5))).length, 1);
    assert.equal((await post(app, "/ingest/claim", claimFor(id, OTHER))).status, 202);
    assert.equal((await post(app, "/ingest/claim", claimFor(id, OTHER))).status, 202, "a repeat claim");
    assert.equal(alerts(app, "job_unknown").filter((a) => a.message.includes(id)).length, 1);
    assert.equal(app.store.getJob(id)?.state, "paid");
  });

  test("ARCH-207: SSE carries job events", async () => {
    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${app.port}/stream`, { headers: { "x-admin-key": ADMIN }, signal: ac.signal });
    const reader = r.body!.getReader();
    let text = "";
    const id = ID(7);
    const sent = (async () => {
      while (!text.includes("event: hello")) await new Promise((res) => setTimeout(res, 20));
      await post(app, "/ingest/job", quoted(id));
    })();
    try {
      while (!text.includes(`"jobId":"${id}"`)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } finally {
      ac.abort();
    }
    await sent;
    const hello = JSON.parse(/event: hello\ndata: (.*)\n/.exec(text)![1]);
    assert.ok(hello.jobs, "the first frame carries jobs once a job exists");
    const ev = JSON.parse(new RegExp(`event: job\\ndata: (.*"jobId":"${id}".*)\\n`).exec(text)![1]);
    assert.equal(ev.job.state, "quoted");
    assert.deepEqual(Object.keys(ev.summary).sort(), ["counts", "lostCompute"]);
  });

  test("ARCH-208: /api/jobs and /api/job need the admin key; filters, limit and an unknown id", async () => {
    assert.equal((await get(app, "/api/jobs", "wrong-key-0123456789abcdef")).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/job/${ID(3)}`)).status, 401);
    const all = (await (await get(app, "/api/jobs")).json()) as { jobs: { jobId: string; state: string }[]; counts: Record<string, number> };
    assert.ok(all.jobs.length >= 5);
    assert.deepEqual(Object.keys(all.counts).sort(), ["expired", "paid", "quoted", "released"]);
    const released = (await (await get(app, "/api/jobs?state=released")).json()) as { jobs: { state: string }[] };
    assert.ok(released.jobs.length >= 1 && released.jobs.every((j) => j.state === "released"));
    assert.equal(((await (await get(app, "/api/jobs?limit=2")).json()) as { jobs: unknown[] }).jobs.length, 2);
    assert.equal((await get(app, "/api/jobs?state=lost")).status, 400);
    assert.equal(((await (await get(app, "/api/jobs?network=mainnet")).json()) as { jobs: unknown[] }).jobs.length, 0);
    const one = (await (await get(app, `/api/job/${ID(3)}`)).json()) as Record<string, any>;
    assert.deepEqual(Object.keys(one).sort(), ["claim", "job", "reconcile", "tx"]);
    assert.equal(one.job.breakdown.minApplied, true);
    assert.equal(one.job.steps[1].entityCounts.PERSON, 3);
    assert.equal(one.claim.hash, fx.tx);
    assert.equal(one.tx.row.hash, fx.tx);
    assert.equal(one.reconcile.state, "matched");
    assert.equal((await get(app, `/api/job/${ID(12345)}`)).status, 404);
    assert.equal((await get(app, "/api/job/not-a-job")).status, 404);
  });

  test("ARCH-206: restart keeps jobs (same SQLite file)", async () => {
    await app.stop();
    app = await start(store);
    assert.equal(app.store.getJob(ID(3))?.state, "released");
    assert.equal(app.store.getJob(ID(4))?.state, "expired");
    assert.deepEqual(await (await post(app, "/ingest/job", quoted(ID(3)))).json(), { accepted: 0, repeats: 1, refused: [] }, "still a repeat after the restart");
    const snap = (await (await get(app, "/api/snapshot")).json()) as { jobs: { counts: Record<string, number>; recent: unknown[]; lostCompute: Record<string, string> } };
    assert.deepEqual(Object.keys(snap.jobs).sort(), ["counts", "lostCompute", "recent"]);
  });
});

test("ARCH-206: /ingest/job is 404 without an ingest key", async () => {
  const store = join(dir, "noingest.sqlite");
  seed(store);
  const { NEAR_WATCH_INGEST_KEY: _k, ...env } = ENV;
  const app = await start(store, [], env);
  try {
    assert.equal((await post(app, "/ingest/job", quoted(ID(8)))).status, 404);
    assert.equal(app.store.hasJobs(), false);
  } finally {
    await app.stop();
  }
});

describe("ARCH-209: relayer gas alert", () => {
  test("ARCH-209: start-up error when a relayer is watched without --gas-per-payment-near", () => {
    assert.throws(() => loadConfig(["--watch", `relayer=relayer=${RELAYER}`], ENV), /needs --gas-per-payment-near/);
    assert.throws(() => loadConfig(["--watch", `relayer=relayer=${RELAYER}`, "--gas-per-payment-near", "0"], ENV), /above 0/);
    const c = loadConfig(["--watch", `relayer=relayer=${RELAYER}`, "--gas-per-payment-near", "0.000333"], ENV);
    assert.deepEqual([c.gasPerPaymentNear, c.relayerMinPayments], ["0.000333", 500]);
  });

  test("ARCH-209: the recorded relayer balance covers 30026 payments at 0.000333 NEAR", () => {
    // view_account of chainaim-relayer-seller.testnet in x402-near-payment.json: 9998670422279634399999996 yoctoNEAR.
    assert.equal(paymentsCovered("9.998670422279634399999996", "0.000333"), 30026n);
  });

  for (const [min, want] of [[500, 0], [40_000, 1]] as const) {
    test(`ARCH-209: with the RPC double, --relayer-min-payments ${min}: ${want ? "below -> one low_gas" : "above threshold, no alert"}`, async () => {
      const store = join(dir, `gas-${min}.sqlite`);
      seed(store);
      const app = await start(store, ["--watch", `relayer=relayer=${RELAYER}`, "--gas-per-payment-near", "0.000333", "--relayer-min-payments", String(min), "--balances-sec", "5"]);
      try {
        const entry = await until(() => app.bus.balances.entries.find((e) => e.role === "relayer"));
        assert.equal(entry.near, "9.998670422279634399999996");
        await app.balances.refresh(); // a second reading inside --alert-every-sec
        assert.equal(alerts(app, "low_gas").length, want);
        if (want) assert.match(alerts(app, "low_gas")[0].message, /gas for 30026 more payment\(s\) at 0\.000333 NEAR each, below 40000/);
        // The relayer is not a buyer or pay-to: the Seller wallet does not list it.
        assert.ok(!JSON.stringify(app.seller.compute()).includes(RELAYER));
      } finally {
        await app.stop();
      }
    });
  }

  test("ARCH-209: at most once per --alert-every-sec while low", () => {
    const bus = new Bus();
    let now = 0;
    const seen: AlertEvent[] = [];
    bus.on((n, d) => n === "alert" && seen.push(d as AlertEvent));
    const rule = new LowGasRule(bus, { gasPerPaymentNear: "0.000333", minPayments: 500, everySec: 60, now: () => now });
    const entries = [{ network: "testnet", label: "relayer", role: "relayer", address: RELAYER, near: "0.1", asset: { code: "USDC", contract: fx.contract, value: null, units: null }, registered: null, callsLeft: null, error: null, at: 0 }];
    rule.check({ entries });
    now = 59_000;
    rule.check({ entries });
    now = 60_000;
    rule.check({ entries });
    assert.equal(seen.filter((a) => a.code === "low_gas").length, 2);
    rule.check({ entries: [{ ...entries[0], role: "buyer" }] });
    assert.equal(seen.filter((a) => a.code === "low_gas").length, 2, "only relayers");
  });
});
