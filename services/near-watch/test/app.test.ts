/**
 * End to end over the protocol doubles (recorded real testnet data): the app's roads, store, reconcile and HTTP API
 * together, on a recorded real x402 NEAR payment (no memo: a relayed NEP-366 delegate ft_transfer). Mirrors DESIGN §9:
 * one paid call reconciles to matched by tx hash (1), a dead neardata road still records via RPC
 * (2), a restart backfills from the stored cursor with no duplicates (3), no secret reaches the API (5).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { startApp, type App } from "../src/main.ts";
import { Store } from "../src/store.ts";
import { AMOUNT, fixture as fx, RECEIVER, SENDER, VALUE } from "./fixtures.ts";
import { NeardataDouble } from "./neardata-double.ts";
import { NearRpcDouble } from "./near-rpc-double.ts";

/** The paywall's invoice id: on the claim only (the transfer carries no memo). */
const INV = "0123456789ABCDEF0123456789ABCDEF";
const ADMIN = "admin-key-for-tests-0123456789";
const INGEST = "ingest-key-for-tests-0123456789";
const ND_KEY = "neardata-secret-key-xyz";
const dir = mkdtempSync(join(tmpdir(), "near-watch-"));
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

const env = { ADMIN_API_KEY: ADMIN, NEAR_WATCH_INGEST_KEY: INGEST, NEAR_USDC_CONTRACT_TESTNET: fx.contract, NEAR_CAIP2_TESTNET: "near:testnet", NEAR_PAY_TO_TESTNET: RECEIVER, NEARDATA_API_KEY: ND_KEY };

async function start(store: string, extra: string[], watch = ["--watch", `buyer1=buyer=${SENDER}`], envOver: Record<string, string> = {}): Promise<App> {
  const argv = ["--neardata-url", nd.url, "--rpc-fallback-url", rpc.url, "--port", "0", "--store", store, ...watch, "--poll-sec", "1", "--neardata-min-ms", "0", "--long-poll-ms", "1000", "--settle-grace-blocks", "5", ...extra];
  return startApp(loadConfig(argv, { ...env, ...envOver }), { log: process.env.NW_TEST_LOG ? (l) => console.log("LOG", l) : () => {} });
}

async function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const get = (app: App, path: string) => fetch(`http://127.0.0.1:${app.port}${path}`, { headers: { "x-admin-key": ADMIN } });

function seed(path: string, cursors: Record<string, number>): void {
  const s = new Store(path);
  for (const [road, h] of Object.entries(cursors)) s.setCursor("testnet", road as never, h);
  s.close();
}

test("two roads: first wins, the other is recorded with its lag; a claim reconciles to matched; no secret leaks", async () => {
  const store = join(dir, "a.sqlite");
  seed(store, { neardata: fx.inclusionHeight - 1, rpc: fx.inclusionHeight - 1 });
  const app = await start(store, ["--feeds", "neardata,rpc", "--backfill", "off"]);
  try {
    assert.equal(app.decimals, 6, "decimals read from the recorded ft_metadata");
    const tx = await until(() => app.store.getTx("testnet", fx.tx));
    assert.equal(tx.row.isX402, true);
    await until(() => app.store.roadsFor("testnet", fx.tx).length === 2);
    const roads = app.store.roadsFor("testnet", fx.tx).map((r) => r.via).sort();
    assert.deepEqual(roads, ["neardata", "rpc"]);

    const res = await fetch(`http://127.0.0.1:${app.port}/ingest/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-key": INGEST },
      body: JSON.stringify({ ts: new Date().toISOString(), event: "payment_settled", route: "POST /v1/chat", amount: AMOUNT, asset: fx.contract, network: "near:testnet", payer: SENDER, transaction: fx.tx, invoiceId: INV }),
    });
    assert.equal(res.status, 202);
    assert.equal(app.store.getRecon("testnet", fx.tx)?.state, "matched");
    assert.equal(app.store.getRecon("testnet", fx.tx)?.invoiceId, INV);

    const one = (await (await get(app, `/api/tx/${fx.tx}`)).json()) as { roads: unknown[]; links: { tx: string } };
    assert.equal(one.roads.length, 2);
    assert.equal(one.links.tx, `https://testnet.nearblocks.io/txns/${fx.tx}`);
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/snapshot`)).status, 401, "admin key required");
    const ingestAsAdmin = await fetch(`http://127.0.0.1:${app.port}/ingest/claim`, { method: "POST", headers: { "content-type": "application/json", "x-ingest-key": ADMIN }, body: "{}" });
    assert.equal(ingestAsAdmin.status, 401, "the admin key is not an ingest key");

    for (const p of ["/api/feeds", "/api/snapshot"]) {
      const text = await (await get(app, p)).text();
      assert.ok(!text.includes(ND_KEY), `${p} must not carry the neardata api key`);
      assert.ok(!text.includes(ADMIN) && !text.includes(INGEST), `${p} must not carry keys`);
    }
    assert.ok(nd.apiKeys.includes(ND_KEY), "the api key is sent to neardata");
    const feeds = (await (await get(app, "/api/feeds")).json()) as { networks: { testnet: { roads: { road: string; state: string }[]; token: { decimals: number }; reconcile: { graceBlocks: number; defaultBlocks: number; tradeoff: string }; rpcPrefetch: number } } };
    assert.deepEqual(feeds.networks.testnet.roads.map((r) => r.road).sort(), ["neardata", "rpc"]);
    assert.deepEqual([feeds.networks.testnet.reconcile.graceBlocks, feeds.networks.testnet.reconcile.defaultBlocks], [5, 30], "--settle-grace-blocks and its default");
    assert.match(feeds.networks.testnet.reconcile.tradeoff, /Shorter: .* Longer: /);
    assert.equal(feeds.networks.testnet.rpcPrefetch, 4);
    const seller = app.seller.compute().wallets[0];
    assert.equal(seller.received.amount, VALUE);
    assert.equal(seller.received.x402Count, 1);
  } finally {
    await app.stop();
  }
});

test("false mismatch (live 2026-11-06): read with a wrong pay-to, still a mismatch after the fix and a restart; POST /admin/reconcile/rejudge clears it", async () => {
  const store = join(dir, "r.sqlite");
  seed(store, { neardata: fx.inclusionHeight - 1, rpc: fx.inclusionHeight - 1 });
  const claimBody = JSON.stringify({ ts: new Date().toISOString(), event: "payment_settled", route: "POST /v1/jobs/09ebdf3d9b6d968ae76de3b1f4c18835/release", amount: AMOUNT, asset: fx.contract, network: "near:testnet", payer: SENDER, transaction: fx.tx, invoiceId: INV });
  const wrong = await start(store, ["--feeds", "neardata,rpc", "--backfill", "off"], ["--watch", `buyer1=buyer=${SENDER}`], { NEAR_PAY_TO_TESTNET: "chainaim-old-payto.testnet" });
  try {
    const tx = await until(() => wrong.store.getTx("testnet", fx.tx));
    assert.equal(tx.row.isX402, false, "the transfer went to a pay-to near-watch did not watch then");
    const res = await fetch(`http://127.0.0.1:${wrong.port}/ingest/claim`, { method: "POST", headers: { "content-type": "application/json", "x-ingest-key": INGEST }, body: claimBody });
    assert.equal(res.status, 202);
    assert.equal(wrong.store.getRecon("testnet", fx.tx)?.state, "mismatch");
  } finally {
    await wrong.stop();
  }
  const fixed = await start(store, ["--feeds", "neardata,rpc", "--backfill", "off"]);
  try {
    assert.equal(fixed.store.getRecon("testnet", fx.tx)?.state, "mismatch", "fixing the pay-to does not bless the stored row");
    const post = (headers: Record<string, string>, body: unknown) => fetch(`http://127.0.0.1:${fixed.port}/admin/reconcile/rejudge`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const ask = { hash: fx.tx, receiver: RECEIVER, reason: "receiver checked on nearblocks" };
    assert.equal((await post({}, ask)).status, 401, "admin key required");
    assert.equal((await post({ "x-ingest-key": INGEST }, ask)).status, 401, "the ingest key cannot re-judge");
    assert.equal((await post({ authorization: `Bearer ${INGEST}` }, ask)).status, 401);
    const wrongReceiver = await post({ "x-admin-key": ADMIN }, { ...ask, receiver: SENDER });
    assert.equal(wrongReceiver.status, 409);
    assert.equal(fixed.store.getRecon("testnet", fx.tx)?.state, "mismatch");
    // The operator's command (src/rejudge.ts), as run inside the container: key from env, never printed.
    const cli = (args: string[], keyEnv: Record<string, string>) => {
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv.ADMIN_API_KEY;
      Object.assign(childEnv, keyEnv);
      return promisify(execFile)(process.execPath, [fileURLToPath(new URL("../src/rejudge.ts", import.meta.url)), "--url", `http://127.0.0.1:${fixed.port}`, ...args], { env: childEnv }).then(
        (r) => ({ code: 0, stdout: String(r.stdout), out: String(r.stdout) + String(r.stderr) }),
        (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: String(e.stdout), out: String(e.stdout) + String(e.stderr) }),
      );
    };
    const noKey = await cli(["--hash", fx.tx, "--receiver", RECEIVER, "--reason", ask.reason], {});
    assert.equal(noKey.code, 2);
    assert.match(noKey.out, /env ADMIN_API_KEY is not set/);
    const usage = await cli(["--hash", fx.tx, "--all-mismatches", "--receiver", RECEIVER, "--reason", ask.reason], { ADMIN_API_KEY: ADMIN });
    assert.equal(usage.code, 2, "--hash and --all-mismatches together are refused");
    // desk.ps1 -RejudgeReceiver runs --all-mismatches: every mismatch row, each checked on its own.
    const run = await cli(["--all-mismatches", "--receiver", RECEIVER, "--reason", ask.reason], { ADMIN_API_KEY: ADMIN });
    assert.equal(run.code, 0, run.out);
    assert.ok(!run.out.includes(ADMIN), "the key is never printed");
    assert.match(run.stdout, /^1 mismatch row\(s\) on testnet$/m);
    const m = new RegExp(`^${fx.tx}: HTTP 200 (\\{.*\\})$`, "m").exec(run.stdout);
    assert.ok(m, run.out);
    const body = JSON.parse(m[1]) as { ok: boolean; state: string; detail: string };
    assert.deepEqual([body.ok, body.state], [true, "matched"]);
    assert.match(body.detail, /^re-judged by operator: was mismatch \(the chain transfer is not a valid x402 NEAR USDC payment .*\); reason: receiver checked on nearblocks$/);
    const recon = (await (await get(fixed, "/api/reconcile")).json()) as { counts: { testnet: Record<string, number> } | Record<string, number> };
    const text = JSON.stringify(recon);
    assert.ok(!text.includes(ADMIN) && !text.includes(INGEST), "no key in the answer");
    assert.equal(fixed.store.reconCounts("testnet").mismatch, 0);
    assert.equal(fixed.store.reconCounts("testnet").matched, 1);
    const none = await cli(["--all-mismatches", "--receiver", RECEIVER, "--reason", ask.reason], { ADMIN_API_KEY: ADMIN });
    assert.equal(none.code, 0, "nothing left to re-judge is not an error");
    assert.match(none.stdout, /^0 mismatch row\(s\) on testnet$/m);
  } finally {
    await fixed.stop();
  }
});

test("neardata down: the RPC road still records the transfer (only the pay-to watched: found through the Delegate action)", async () => {
  const store = join(dir, "b.sqlite");
  seed(store, { neardata: fx.inclusionHeight - 1, rpc: fx.inclusionHeight - 1 });
  nd.down = true;
  try {
    const app = await startWithNeardataDown(store);
    try {
      const tx = await until(() => app.store.getTx("testnet", fx.tx));
      assert.equal(tx.firstVia, "rpc");
      assert.equal(tx.row.isX402, true);
      const st = app.loops.get("neardata")?.status();
      assert.equal(st?.state, "down");
    } finally {
      await app.stop();
    }
  } finally {
    nd.down = false;
  }
});

/** With neardata down the start-up tip comes from the RPC endpoint. No --watch: only NEAR_PAY_TO_TESTNET. */
function startWithNeardataDown(store: string): Promise<App> {
  return start(store, ["--feeds", "neardata,rpc", "--backfill", "off"], []);
}

test("restart: backfill reads from the stored cursor to the tip, then a second restart adds no duplicates", async () => {
  const store = join(dir, "c.sqlite");
  seed(store, { neardata: fx.inclusionHeight - 1 });
  const app = await start(store, ["--feeds", "neardata,rpc", "--backfill", "on"]);
  try {
    const tx = await until(() => app.store.getTx("testnet", fx.tx));
    assert.equal(tx.firstVia, "backfill");
    await until(() => app.backfill?.done);
  } finally {
    await app.stop();
  }
  const again = await start(store, ["--feeds", "neardata,rpc", "--backfill", "on"]);
  try {
    assert.equal(again.backfill, null, "cursor already at the tip: nothing to backfill");
    const n = (again.store.db.prepare("SELECT COUNT(*) AS n FROM txs").get() as { n: number }).n;
    assert.equal(n, 1);
    assert.equal(again.store.roadsFor("testnet", fx.tx).length, 1);
  } finally {
    await again.stop();
  }
});
