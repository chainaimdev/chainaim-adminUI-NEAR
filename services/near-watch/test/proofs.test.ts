/**
 * The signed quote and the signed receipt of a paid job on near-watch (ARCH-701 job_receipt, ARCH-702 job_quoted.ap2;
 * private-ai privateAI-design-33 section 7 and design-32 ARCH-615), through the real app over the protocol doubles of the
 * recorded real testnet payment, with events posted to /ingest/job as private-ai's test-console job-feed.ts builds them.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { startApp, type App } from "../src/main.ts";
import { Store } from "../src/store.ts";
import { fixture as fx, RECEIVER, SENDER } from "./fixtures.ts";
import { NeardataDouble } from "./neardata-double.ts";
import { NearRpcDouble } from "./near-rpc-double.ts";

const ADMIN = "admin-key-for-tests-0123456789";
const INGEST = "ingest-key-for-tests-0123456789";
const dir = mkdtempSync(join(tmpdir(), "near-watch-proofs-"));
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
async function start(store: string): Promise<App> {
  const argv = ["--neardata-url", nd.url, "--rpc-fallback-url", rpc.url, "--port", "0", "--store", store, "--watch", `buyer1=buyer=${SENDER}`, "--poll-sec", "1", "--neardata-min-ms", "0", "--long-poll-ms", "1000", "--settle-grace-blocks", "5", "--feeds", "rpc", "--backfill", "off"];
  return startApp(loadConfig(argv, ENV), { log: () => {} });
}
const get = (app: App, path: string, key = ADMIN) => fetch(`http://127.0.0.1:${app.port}${path}`, { headers: { "x-admin-key": key } });
const post = (app: App, path: string, body: unknown, key: string | null = INGEST) =>
  fetch(`http://127.0.0.1:${app.port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-ingest-key": key } : {}) }, body: JSON.stringify(body) });
const ID = (n: number) => (0x9e0f0000 + n).toString(16).padStart(32, "0");

function quoted(jobId: string): Record<string, unknown> {
  return {
    v: 1, event: "job_quoted", ts: "2026-11-06T10:00:00.000Z", jobId, network: "near:testnet", amount: "12001", totalUsd: "0.012001", expiresAt: "2026-11-06T10:15:00.000Z",
    steps: [
      { name: "query", ms: 2310, model: "nearai/deepseek-v4.1-flash", zone: "private-cloud", promptTokens: 1000, completionTokens: 50, usd: "0.000360", entityCounts: { PERSON: 1 }, residual: "pass" },
      { name: "answer", ms: 1804, model: "nearai/deepseek-v4.1-flash", zone: "private-cloud", promptTokens: 2000, completionTokens: 150, usd: "0.000780", entityCounts: {}, residual: "pass" },
    ],
    breakdown: {
      calls: [{ model: "nearai/deepseek-v4.1-flash", promptTokens: 1000, completionTokens: 50, usd: "0.000360" }, { model: "nearai/deepseek-v4.1-flash", promptTokens: 2000, completionTokens: 150, usd: "0.000780" }],
      modelUsd: "0.001140", callFeesUsd: "0.002000", analystUsd: "0.000000", nearGasUsd: "0.000500", marginPct: "20", minPriceUsd: "0.01", minApplied: true,
    },
  };
}
const KID = "83816e6fd32b879fd96d0318a40cd40d";
const MAH = "a".repeat(64);
const TX = "6RoFLYdZ3q8m4hWbKcBtZ8x1yNvP2sTuQwErAa";
const receipt = (jobId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1, event: "job_receipt", ts: "2026-11-06T10:01:30.000Z", jobId, network: "near:testnet", receiptId: "b".repeat(32), keyId: "d27d1e9f17a0104e34c46cf3e5233f23",
  resultSha256: "c".repeat(64), filesRoot: "d".repeat(64), settled: true, transaction: TX, ...over,
});
type Refusal = { accepted: number; repeats: number; refused: { index: number; error: string }[] };

describe("ARCH-701 ARCH-702 signed quote and receipt on near-watch", () => {
  let app: App;
  const store = join(dir, "proofs.sqlite");
  before(async () => {
    new Store(store).close();
    app = await start(store);
  });
  after(() => app.stop());

  test("ARCH-201 ARCH-701 ARCH-702: a job without either is exactly as before (no new keys)", async () => {
    assert.equal((await post(app, "/ingest/job", quoted(ID(1)))).status, 202);
    const one = (await (await get(app, `/api/job/${ID(1)}`)).json()) as Record<string, any>;
    assert.equal("signedQuote" in one.job, false);
    assert.equal("receipt" in one.job, false);
  });

  test("ARCH-702: job_quoted with ap2 {kid, merchantAuthSha256} is stored and shown as signedQuote", async () => {
    assert.equal((await post(app, "/ingest/job", { ...quoted(ID(2)), ap2: { kid: KID, merchantAuthSha256: MAH } })).status, 202);
    const one = (await (await get(app, `/api/job/${ID(2)}`)).json()) as Record<string, any>;
    assert.deepEqual(one.job.signedQuote, { kid: KID, merchantAuthSha256: MAH });
    const list = (await (await get(app, "/api/jobs")).json()) as Record<string, any>;
    assert.deepEqual(list.jobs.find((j: { jobId: string }) => j.jobId === ID(2)).signedQuote, { kid: KID, merchantAuthSha256: MAH });
  });

  test("ARCH-702: a bad ap2 is refused whole (400): text, wrong lengths, extra fields; the job is not stored", async () => {
    const bad: [string, unknown, string][] = [
      ["ap2 not an object", "signed", "ap2 must be an object"],
      ["kid upper case", { kid: KID.toUpperCase(), merchantAuthSha256: MAH }, "ap2.kid"],
      ["kid too short", { kid: "8381", merchantAuthSha256: MAH }, "ap2.kid"],
      ["hash that is text", { kid: KID, merchantAuthSha256: "the quote was 0.02" }, "ap2.merchantAuthSha256"],
      ["the JWS itself", { kid: KID, merchantAuthSha256: MAH, merchant_authorization: "eyJh..sig" }, "unknown field merchant_authorization"],
    ];
    for (const [why, ap2, names] of bad) {
      const r = await post(app, "/ingest/job", { ...quoted(ID(3)), ap2 });
      assert.equal(r.status, 400, why);
      const j = (await r.json()) as Refusal;
      assert.ok(j.refused[0].error.includes(names), `${why}: "${j.refused[0].error}" names ${names}`);
    }
    assert.equal(app.store.getJob(ID(3)), undefined);
  });

  test("ARCH-701: job_receipt is stored and shown; a repeat is a repeat; a settled one replaces an unsettled one, never the reverse", async () => {
    const id = ID(4);
    assert.equal((await post(app, "/ingest/job", quoted(id))).status, 202);
    const unsettled = receipt(id, { settled: false, transaction: null, ts: "2026-11-06T10:01:00.000Z" });
    assert.deepEqual(await (await post(app, "/ingest/job", unsettled)).json(), { accepted: 1, repeats: 0, refused: [] });
    let one = (await (await get(app, `/api/job/${id}`)).json()) as Record<string, any>;
    assert.deepEqual([one.job.receipt.settled, one.job.receipt.transaction], [false, null]);
    assert.deepEqual(await (await post(app, "/ingest/job", receipt(id))).json(), { accepted: 1, repeats: 0, refused: [] });
    assert.deepEqual(await (await post(app, "/ingest/job", receipt(id))).json(), { accepted: 0, repeats: 1, refused: [] });
    assert.deepEqual(await (await post(app, "/ingest/job", { ...unsettled, ts: "2026-11-06T10:05:00.000Z" })).json(), { accepted: 0, repeats: 1, refused: [] }, "an unsettled receipt never replaces a settled one");
    one = (await (await get(app, `/api/job/${id}`)).json()) as Record<string, any>;
    assert.deepEqual(one.job.receipt, { tsMs: Date.parse("2026-11-06T10:01:30.000Z"), receiptId: "b".repeat(32), keyId: "d27d1e9f17a0104e34c46cf3e5233f23", resultSha256: "c".repeat(64), filesRoot: "d".repeat(64), settled: true, transaction: TX, receivedMs: one.job.receipt.receivedMs });
  });

  test("ARCH-701: a receipt before its job is kept and shown once the job arrives", async () => {
    const id = ID(5);
    assert.equal((await post(app, "/ingest/job", receipt(id))).status, 202);
    assert.equal(app.store.getJob(id), undefined);
    assert.equal((await post(app, "/ingest/job", quoted(id))).status, 202);
    const one = (await (await get(app, `/api/job/${id}`)).json()) as Record<string, any>;
    assert.equal(one.job.receipt.receiptId, "b".repeat(32));
  });

  test("ARCH-701: each invalid field is refused whole (400) naming the field; nothing stored", async () => {
    const id = ID(6);
    const bad: [string, unknown, string][] = [
      ["receiptId", receipt(id, { receiptId: "x" }), "receiptId"],
      ["keyId", receipt(id, { keyId: "K".repeat(32) }), "keyId"],
      ["resultSha256 that is text", receipt(id, { resultSha256: "the revenue was 42" }), "resultSha256"],
      ["filesRoot", receipt(id, { filesRoot: "e".repeat(63) }), "filesRoot"],
      ["settled as text", receipt(id, { settled: "yes" }), "settled"],
      ["settled without a transaction", receipt(id, { transaction: null }), "a settled receipt names its transaction"],
      ["transaction without settled", receipt(id, { settled: false }), "a settled receipt names its transaction"],
      ["transaction not base58", receipt(id, { transaction: "0OIl" + "a".repeat(30) }), "transaction"],
      ["text-like extra field", receipt(id, { sql: "SELECT 1" }), "unknown field sql"],
    ];
    for (const [why, body, names] of bad) {
      const r = await post(app, "/ingest/job", body);
      assert.equal(r.status, 400, why);
      const j = (await r.json()) as Refusal;
      assert.ok(j.refused[0].error.includes(names), `${why}: "${j.refused[0].error}" names ${names}`);
    }
    assert.equal(app.store.getReceipt(id), undefined);
  });

  test("ARCH-701 ARCH-702: restart keeps both (same SQLite file)", async () => {
    app.stop();
    app = await start(store);
    const one = (await (await get(app, `/api/job/${ID(2)}`)).json()) as Record<string, any>;
    assert.equal(one.job.signedQuote.kid, KID);
    const four = (await (await get(app, `/api/job/${ID(4)}`)).json()) as Record<string, any>;
    assert.equal(four.job.receipt.settled, true);
  });
});
