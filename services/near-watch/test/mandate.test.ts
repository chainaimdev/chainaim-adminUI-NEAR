/**
 * The buyer agent's checkout mandate on a job's receipt (ARCH-704; private-ai privateAI-design-42 ARCH-710,
 * design-36 ARCH-668), through the real app over the protocol doubles of the recorded real testnet payment, with events
 * posted to /ingest/job as private-ai's test-console job-feed.ts builds them with --job-feed-mandate on.
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
const dir = mkdtempSync(join(tmpdir(), "near-watch-mandate-"));
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
const ID = (n: number) => (0x9e0a0000 + n).toString(16).padStart(32, "0");

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

// The live t01 mandate of job a5bd2720… (2026-11-14): key id and hash as its receipt records them.
const MANDATE = { kid: "964b1199a73a9b22e6be8bc2e4b2ce26", tenant: "t01", sha256: "7cd12328f2e8e1d0fee66764ba5e84b80858e194fafe9c31d4caa578884d1250" };

describe("ARCH-704 the checkout mandate on job_receipt", () => {
  let app: App;
  const store = join(dir, "mandate.sqlite");
  before(async () => {
    new Store(store).close();
    app = await start(store);
  });
  after(() => app.stop());
  const one = async (id: string) => ((await (await get(app, `/api/job/${id}`)).json()) as Record<string, any>).job;

  test("ARCH-201 ARCH-704: a receipt without a mandate is exactly as before (no mandate key on the job)", async () => {
    const id = ID(1);
    assert.equal((await post(app, "/ingest/job", quoted(id))).status, 202);
    assert.equal((await post(app, "/ingest/job", receipt(id))).status, 202);
    const j = await one(id);
    assert.equal(j.receipt.receiptId, "b".repeat(32));
    assert.equal("mandate" in j, false);
  });

  test("ARCH-704: job_receipt with mandate {kid, tenant, sha256} is stored and shown on the job and in the list", async () => {
    const id = ID(2);
    assert.equal((await post(app, "/ingest/job", quoted(id))).status, 202);
    assert.deepEqual(await (await post(app, "/ingest/job", receipt(id, { mandate: MANDATE }))).json(), { accepted: 1, repeats: 0, refused: [] });
    assert.deepEqual((await one(id)).mandate, MANDATE);
    const list = (await (await get(app, "/api/jobs")).json()) as Record<string, any>;
    assert.deepEqual(list.jobs.find((j: { jobId: string }) => j.jobId === id).mandate, MANDATE);
    assert.deepEqual(app.store.getMandate(id), { network: app.store.getReceipt(id)!.network, ...MANDATE });
  });

  test("ARCH-704: a receipt before its job keeps its mandate, shown once the job arrives", async () => {
    const id = ID(3);
    assert.equal((await post(app, "/ingest/job", receipt(id, { mandate: MANDATE }))).status, 202);
    assert.equal(app.store.getJob(id), undefined);
    assert.equal((await post(app, "/ingest/job", quoted(id))).status, 202);
    assert.deepEqual((await one(id)).mandate, MANDATE);
  });

  test("ARCH-704: a settled receipt replacing an unsettled one replaces its mandate too (none -> none stays none, one -> none drops it)", async () => {
    const id = ID(4);
    assert.equal((await post(app, "/ingest/job", quoted(id))).status, 202);
    const unsettled = receipt(id, { settled: false, transaction: null, ts: "2026-11-06T10:01:00.000Z", mandate: MANDATE });
    assert.equal((await post(app, "/ingest/job", unsettled)).status, 202);
    assert.deepEqual((await one(id)).mandate, MANDATE);
    assert.equal((await post(app, "/ingest/job", receipt(id))).status, 202);
    assert.equal("mandate" in (await one(id)), false, "the newest receipt records no mandate, so none is shown");
    // A repeat of an older receipt (with a mandate) changes nothing.
    assert.deepEqual(await (await post(app, "/ingest/job", { ...unsettled, ts: "2026-11-06T10:05:00.000Z" })).json(), { accepted: 0, repeats: 1, refused: [] });
    assert.equal("mandate" in (await one(id)), false);
  });

  test("ARCH-704: a bad mandate is refused whole (400) naming the field: the mandate itself, nonce, account, bad tenant, upper-case kid, short hash", async () => {
    const id = ID(5);
    const bad: [string, unknown, string][] = [
      ["mandate not an object", "eyJhbGciOiJFUzI1NiJ9.x.y~", "mandate must be an object"],
      ["kid upper case", { ...MANDATE, kid: MANDATE.kid.toUpperCase() }, "mandate.kid"],
      ["tenant with a space", { ...MANDATE, tenant: "Tenant One" }, "mandate.tenant"],
      ["tenant too long", { ...MANDATE, tenant: "t".repeat(33) }, "mandate.tenant"],
      ["hash too short", { ...MANDATE, sha256: "7cd1" }, "mandate.sha256"],
      ["the payer account", { ...MANDATE, accountId: "chainaim-buyer-seller.testnet" }, "unknown field accountId"],
      ["the nonce", { ...MANDATE, nonce: "7E891A98F5D8491F95C631504A07007C" }, "unknown field nonce"],
      ["the mandate token", { ...MANDATE, presentation: "eyJh..sig~" }, "unknown field presentation"],
    ];
    for (const [why, mandate, names] of bad) {
      const r = await post(app, "/ingest/job", receipt(id, { mandate }));
      assert.equal(r.status, 400, why);
      const j = (await r.json()) as Refusal;
      assert.ok(j.refused[0].error.includes(names), `${why}: "${j.refused[0].error}" names ${names}`);
    }
    assert.equal(app.store.getReceipt(id), undefined);
    assert.equal(app.store.getMandate(id), undefined);
  });
});
