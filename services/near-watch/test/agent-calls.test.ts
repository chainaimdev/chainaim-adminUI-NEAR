/**
 * Private-AI agent calls (src/agent-calls.ts): records as chainiam-private-ai quote-agents sends them (--feed-url),
 * through the real app over the protocol doubles: POST /ingest/agent (ingest key only) → store → GET /api/agent-calls
 * (admin key only). Strict parsing: unknown fields (a price, a message, a body) are refused whole.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseAgentCall } from "../src/agent-calls.ts";
import { IngestError } from "../src/claims.ts";
import { loadConfig } from "../src/config.ts";
import { startApp, type App } from "../src/main.ts";
import { fixture as fx, RECEIVER, SENDER } from "./fixtures.ts";
import { NeardataDouble } from "./neardata-double.ts";
import { NearRpcDouble } from "./near-rpc-double.ts";

const ADMIN = "admin-key-for-tests-0123456789";
const INGEST = "ingest-key-for-tests-0123456789";
const dir = mkdtempSync(join(tmpdir(), "near-watch-agents-"));
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
const post = (app: App, body: unknown, key: string | null = INGEST) =>
  fetch(`http://127.0.0.1:${app.port}/ingest/agent`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-ingest-key": key } : {}) }, body: JSON.stringify(body) });

const call = (n: number, over: Record<string, unknown> = {}) => ({
  v: 1, event: "agent_call", ts: `2026-11-14T16:55:${String(20 + n).padStart(2, "0")}.000Z`, tenant: "jupiter-knitting", alias: "JupiterInventoryAgent",
  path: "agents/inventory", status: 200, ms: 11, source: null, requestId: `905a9ae0-6524-48e3-85c5-a6be0b9c02${String(n).padStart(2, "0")}`, code: null, ...over,
});

test("parseAgentCall: typed and bounded; unknown fields (a price, a body) refused whole", () => {
  assert.deepEqual(parseAgentCall(call(1)), { tsMs: Date.parse("2026-11-14T16:55:21.000Z"), tenant: "jupiter-knitting", alias: "JupiterInventoryAgent", path: "agents/inventory", status: 200, ms: 11, source: null, requestId: "905a9ae0-6524-48e3-85c5-a6be0b9c0201", code: null });
  assert.equal(parseAgentCall({ v: 1, event: "agent_call", ts: "2026-11-14T16:55:21.000Z", path: "/v1/tenants/acme/agents/inventory", status: 404, ms: 0, code: "unknown_tenant" }).tenant, null, "a refused call may have no tenant or alias");
  for (const bad of [{ priceCents: 300 }, { body: "{}" }, { status: 99 }, { source: "gpt" }, { tenant: "Jupiter Knitting" }, { alias: "x y" }, { path: "../etc" }, { v: 2 }, { event: "job_quoted" }])
    assert.throws(() => parseAgentCall(call(1, bad)), IngestError, JSON.stringify(bad));
});

test("POST /ingest/agent (ingest key) → GET /api/agent-calls (admin key): stored, newest first, per tenant, repeats once", async () => {
  const app = await start(join(dir, "a.sqlite"));
  try {
    const hub = [
      call(1, { tenant: "tommy-hilfiger-europe", alias: "TommyTreasuryAgent", path: "agents/treasury" }),
      call(2),
      call(3, { alias: "JupiterLogisticsAgent", path: "agents/logistics" }),
      call(4, { alias: "JupiterTreasuryAgent", path: "agents/treasury" }),
      call(5, { alias: "jupiterSellerAgent", path: "seller/synthesize", source: "rules", ms: 30 }),
      call(6, { tenant: "tommy-hilfiger-europe", alias: "tommyBuyerAgent", path: "buyer/synthesize", source: "rules" }),
    ];
    const r = await post(app, hub);
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { accepted: 6, repeats: 0, refused: [] });
    assert.deepEqual(await (await post(app, call(2))).json(), { accepted: 0, repeats: 1, refused: [] }, "same requestId and path: stored once");

    const all = (await (await get(app, "/api/agent-calls")).json()) as { total: number; failed: number; byTenant: Record<string, number>; calls: { alias: string; path: string }[] };
    assert.equal(all.total, 6);
    assert.equal(all.failed, 0);
    assert.deepEqual(all.byTenant, { "tommy-hilfiger-europe": 2, "jupiter-knitting": 4 });
    assert.deepEqual(all.calls.map((c) => c.alias), ["tommyBuyerAgent", "jupiterSellerAgent", "JupiterTreasuryAgent", "JupiterLogisticsAgent", "JupiterInventoryAgent", "TommyTreasuryAgent"]);
    const tommy = (await (await get(app, "/api/agent-calls?tenant=tommy-hilfiger-europe&limit=10")).json()) as { calls: { path: string }[] };
    assert.deepEqual(tommy.calls.map((c) => c.path), ["buyer/synthesize", "agents/treasury"]);

    assert.equal((await post(app, call(9), null)).status, 401, "no ingest key");
    assert.equal((await post(app, call(9), ADMIN)).status, 401, "the admin key cannot write");
    assert.equal((await get(app, "/api/agent-calls", INGEST)).status, 401, "the ingest key cannot read");
    assert.equal((await get(app, "/api/agent-calls?tenant=BAD TENANT")).status, 400);
    const bad = await post(app, call(9, { messageToBuyer: "we can offer $3.06" }));
    assert.equal(bad.status, 400);
    assert.equal(app.store.recentAgentCalls(100).length, 6, "the refused record was not stored");
  } finally {
    await app.stop();
  }
});
