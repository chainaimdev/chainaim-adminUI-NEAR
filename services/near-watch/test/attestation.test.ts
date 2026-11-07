/**
 * NEAR AI model attestation per paid job (PLAN-adminui-nearai-attestation.md ARCH-501..503) through the real app over the
 * protocol doubles of the recorded real testnet payment (x402-near-payment.json), with job_attested events posted to
 * /ingest/job in the shape the private-ai console's job feed sends (companion plan ARCH-412). near-watch verifies nothing:
 * it validates, stores and shows the result.
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
const dir = mkdtempSync(join(tmpdir(), "near-watch-attest-"));
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
const ID = (n: number) => (0xa77e5700 + n).toString(16).padStart(32, "0");

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
/** One verified call, every field of ARCH-412 present. */
const call = (step: "query" | "answer", over: Record<string, unknown> = {}): Record<string, unknown> => ({
  step, model: "nearai/deepseek-v4.1-flash", servedModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017", providerId: `chatcmpl-${step}0123456789abcdef`,
  signatureKind: "provider_tee", signingAlgo: "ecdsa", signingAddress: "0x" + "ab12".repeat(10), reportFetchedAt: "2026-11-06T09:59:00.000Z",
  tdx: true, gpu: true, signature: true, hashes: true, status: "verified", reason: null, ...over,
});
const attested = (jobId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1, event: "job_attested", ts: "2026-11-06T10:00:30.000Z", jobId, network: "near:testnet", summary: "attested", calls: [call("query"), call("answer")], ...over,
});
type Refusal = { accepted: number; repeats: number; refused: { index: number; error: string }[] };

describe("NEAR AI attestation on near-watch", () => {
  let app: App;
  const store = join(dir, "attest.sqlite");
  before(async () => {
    new Store(store).close();
    app = await start(store);
  });
  after(() => app.stop());

  test("ARCH-503: before any job_attested, a job's JSON and the summary are as today", async () => {
    assert.equal((await post(app, "/ingest/job", quoted(ID(1)))).status, 202);
    const list = (await (await get(app, "/api/jobs")).json()) as Record<string, any>;
    assert.deepEqual(Object.keys(list).sort(), ["counts", "jobs", "lostCompute"]);
    assert.equal("attestation" in list.jobs[0], false);
    const one = (await (await get(app, `/api/job/${ID(1)}`)).json()) as Record<string, any>;
    assert.equal("attestation" in one.job, false);
    assert.equal(app.store.hasAttestations(), false);
  });

  test("ARCH-501: the ingest key is still required (none, or the admin key: 401)", async () => {
    assert.equal((await post(app, "/ingest/job", attested(ID(1)), null)).status, 401);
    assert.equal((await post(app, "/ingest/job", attested(ID(1)), ADMIN)).status, 401);
    assert.equal(app.store.getAttestation(ID(1)), undefined);
  });

  test("ARCH-501: each invalid field is refused whole (400) naming the field; nothing stored", async () => {
    const id = ID(1);
    const a = attested(id);
    const c = (over: Record<string, unknown>) => ({ ...a, calls: [call("query", over)] });
    const bad: [string, unknown, string][] = [
      ["summary", { ...a, summary: "maybe" }, "summary"],
      ["calls not a list", { ...a, calls: "all good" }, "calls"],
      ["too many calls", { ...a, calls: Array.from({ length: 33 }, () => call("query")) }, "calls"],
      ["text-like extra field", { ...a, answer: "the revenue was 42" }, "unknown field answer"],
      ["text-like extra call field", c({ prompt: "how many orders?" }), "unknown field prompt"],
      ["step", c({ step: "sql" }), "calls[0].step"],
      ["status", c({ status: "ok" }), "calls[0].status"],
      ["signatureKind", c({ signatureKind: "tee" }), "calls[0].signatureKind"],
      ["signingAlgo", c({ signingAlgo: "rsa" }), "calls[0].signingAlgo"],
      ["ecdsa address too short", c({ signingAddress: "0x1234" }), "calls[0].signingAddress"],
      ["ed25519 key given for ecdsa", c({ signingAddress: "ab".repeat(32) }), "calls[0].signingAddress"],
      ["address without algo", c({ signingAlgo: null }), "calls[0].signingAddress needs"],
      ["providerId with spaces", c({ providerId: "chat id 1" }), "calls[0].providerId"],
      ["providerId too long", c({ providerId: "c".repeat(129) }), "calls[0].providerId"],
      ["model id that is text", c({ model: "the answer is 42" }), "calls[0].model"],
      ["servedModel", c({ servedModel: "x".repeat(129) }), "calls[0].servedModel"],
      ["tdx as text", c({ tdx: "true" }), "calls[0].tdx"],
      ["gpu as number", c({ gpu: 1 }), "calls[0].gpu"],
      ["signature as text", c({ signature: "yes" }), "calls[0].signature"],
      ["hashes as text", c({ hashes: "equal" }), "calls[0].hashes"],
      ["reportFetchedAt", c({ reportFetchedAt: "earlier" }), "calls[0].reportFetchedAt"],
      ["reason with a newline", c({ reason: "line one\nline two" }), "calls[0].reason"],
      ["reason over 200", c({ reason: "r".repeat(201) }), "calls[0].reason"],
      // fix 4: signature evidence is bounded hex / a model id + two hashes, never text
      ["signedText that is text", c({ signedText: "the revenue was 42" }), "calls[0].signedText"],
      ["signedText with uppercase hash", c({ signedText: `m:${"A".repeat(64)}:${"b".repeat(64)}` }), "calls[0].signedText"],
      ["signedText with one hash", c({ signedText: `m:${"a".repeat(64)}` }), "calls[0].signedText"],
      ["signedText with a space", c({ signedText: `my model:${"a".repeat(64)}:${"b".repeat(64)}` }), "calls[0].signedText"],
      ["signedText as number", c({ signedText: 42 }), "calls[0].signedText"],
      ["ecdsa signature too short", c({ signatureHex: "0x" + "ab".repeat(64) }), "calls[0].signatureHex"],
      ["ecdsa signature not hex", c({ signatureHex: "0x" + "zz".repeat(65) }), "calls[0].signatureHex"],
      ["ed25519 signature given for ecdsa", c({ signatureHex: "ab".repeat(64) }), "calls[0].signatureHex"],
      ["signature without algo", c({ signingAlgo: null, signingAddress: null, signatureHex: "0x" + "ab".repeat(65) }), "calls[0].signatureHex needs"],
      ["v", { ...a, v: 2 }, "v must be 1"],
      ["jobId", { ...a, jobId: "x" }, "jobId"],
      ["network", { ...a, network: "near:mainnet" }, "network"],
    ];
    for (const [why, body, names] of bad) {
      const r = await post(app, "/ingest/job", body);
      assert.equal(r.status, 400, why);
      const j = (await r.json()) as Refusal;
      assert.equal(j.refused.length, 1, why);
      assert.ok(j.refused[0].error.includes(names), `${why}: "${j.refused[0].error}" names ${names}`);
    }
    assert.equal(app.store.getAttestation(id), undefined);
    assert.equal(app.store.hasAttestations(), false);
  });

  test("ARCH-501 / ARCH-503: a valid job_attested is stored (202) and the job shows it", async () => {
    const id = ID(1);
    const r = await post(app, "/ingest/job", attested(id));
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { accepted: 1, repeats: 0, refused: [] });
    assert.deepEqual(await (await post(app, "/ingest/job", attested(id))).json(), { accepted: 0, repeats: 1, refused: [] }, "the same event again is a repeat");
    const one = (await (await get(app, `/api/job/${id}`)).json()) as Record<string, any>;
    assert.equal(one.job.attestation.summary, "attested");
    assert.equal(one.job.attestation.tsMs, Date.parse("2026-11-06T10:00:30.000Z"));
    assert.equal(one.job.attestation.calls.length, 2);
    assert.deepEqual(one.job.attestation.calls[0], {
      step: "query", model: "nearai/deepseek-v4.1-flash", servedModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017", providerId: "chatcmpl-query0123456789abcdef",
      signatureKind: "provider_tee", signingAlgo: "ecdsa", signingAddress: "0x" + "ab12".repeat(10), reportFetchedMs: Date.parse("2026-11-06T09:59:00.000Z"),
      tdx: true, gpu: true, signature: true, hashes: true, status: "verified", reason: null, signedText: null, signatureHex: null,
    });
    const list = (await (await get(app, "/api/jobs")).json()) as Record<string, any>;
    assert.deepEqual(list.attestation, { attested: 1, partial: 0, unverified: 0, unavailable: 0, not_applicable: 0 });
    assert.equal(list.jobs.find((j: { jobId: string }) => j.jobId === id).attestation.summary, "attested");
  });

  test("ARCH-501: nulls for checks not run, ed25519 signer, and a short reason are accepted", async () => {
    const id = ID(2);
    await post(app, "/ingest/job", quoted(id));
    const body = attested(id, {
      summary: "partial",
      calls: [
        call("query", { signingAlgo: "ed25519", signingAddress: "cd".repeat(32), gpu: null, status: "verified" }),
        call("answer", { providerId: null, signatureKind: null, signingAlgo: null, signingAddress: null, reportFetchedAt: null, tdx: null, gpu: null, signature: null, hashes: null, status: "unavailable", reason: "signature not found after 30 s" }),
      ],
    });
    assert.equal((await post(app, "/ingest/job", body)).status, 202);
    const a = app.store.getAttestation(id)!;
    assert.equal(a.summary, "partial");
    assert.deepEqual([a.calls[0].signingAlgo, a.calls[0].gpu, a.calls[1].status, a.calls[1].reason, a.calls[1].tdx], ["ed25519", null, "unavailable", "signature not found after 30 s", null]);
  });

  test("fix 4: signature evidence (signed text + signature hex) is stored and shown as sent", async () => {
    const id = ID(6);
    await post(app, "/ingest/job", quoted(id));
    const signedText = `deepseek-ai/DeepSeek-V4.1-Flash-1017:${"1a".repeat(32)}:${"2b".repeat(32)}`;
    const ecdsaSig = "0x" + "cd".repeat(64) + "1b";
    const edSig = "ef".repeat(64);
    const body = attested(id, {
      calls: [
        call("query", { signedText, signatureHex: ecdsaSig }),
        call("answer", { signingAlgo: "ed25519", signingAddress: "cd".repeat(32), signedText: `${"3c".repeat(32)}:${"4d".repeat(32)}`, signatureHex: edSig }),
      ],
    });
    const r = await post(app, "/ingest/job", body);
    assert.equal(r.status, 202, await r.text());
    const one = (await (await get(app, `/api/job/${id}`)).json()) as Record<string, any>;
    assert.deepEqual([one.job.attestation.calls[0].signedText, one.job.attestation.calls[0].signatureHex], [signedText, ecdsaSig]);
    assert.deepEqual([one.job.attestation.calls[1].signedText, one.job.attestation.calls[1].signatureHex], [`${"3c".repeat(32)}:${"4d".repeat(32)}`, edSig]);
    assert.deepEqual(await (await post(app, "/ingest/job", body)).json(), { accepted: 0, repeats: 1, refused: [] }, "the same evidence again is a repeat");
  });

  test("ARCH-502: a newer event replaces the stored one; an older one is a repeat", async () => {
    const id = ID(2);
    const newer = attested(id, { ts: "2026-11-06T10:05:00.000Z", summary: "unverified", calls: [call("query", { hashes: false, status: "unverified", reason: "hash mismatch" })] });
    assert.deepEqual(await (await post(app, "/ingest/job", newer)).json(), { accepted: 1, repeats: 0, refused: [] });
    assert.equal(app.store.getAttestation(id)?.summary, "unverified");
    assert.equal(app.store.getAttestation(id)?.calls.length, 1);
    const older = attested(id, { ts: "2026-11-06T10:01:00.000Z" });
    assert.deepEqual(await (await post(app, "/ingest/job", older)).json(), { accepted: 0, repeats: 1, refused: [] });
    assert.equal(app.store.getAttestation(id)?.summary, "unverified");
  });

  test("ARCH-502: an attestation before its job is kept and shown once the job arrives", async () => {
    const id = ID(3);
    assert.equal((await post(app, "/ingest/job", attested(id))).status, 202);
    assert.equal(app.store.getJob(id), undefined, "no job row is made from an attestation alone");
    assert.equal((await get(app, `/api/job/${id}`)).status, 404);
    assert.equal((await post(app, "/ingest/job", quoted(id))).status, 202);
    const one = (await (await get(app, `/api/job/${id}`)).json()) as Record<string, any>;
    assert.equal(one.job.attestation.summary, "attested");
  });

  test("ARCH-503: SSE job event carries the attestation; another job's view is unchanged", async () => {
    const plain = ID(4);
    await post(app, "/ingest/job", quoted(plain));
    const before = await (await get(app, `/api/job/${plain}`)).text();
    const id = ID(5);
    await post(app, "/ingest/job", quoted(id));
    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${app.port}/stream`, { headers: { "x-admin-key": ADMIN }, signal: ac.signal });
    const reader = r.body!.getReader();
    let text = "";
    const sent = (async () => {
      while (!text.includes("event: hello")) await new Promise((res) => setTimeout(res, 20));
      await post(app, "/ingest/job", attested(id));
    })();
    try {
      while (!new RegExp(`event: job\\ndata: .*"jobId":"${id}".*\\n`).test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } finally {
      ac.abort();
    }
    await sent;
    const ev = JSON.parse(new RegExp(`event: job\\ndata: (.*"jobId":"${id}".*)\\n`).exec(text)![1]);
    assert.equal(ev.job.attestation.summary, "attested");
    assert.deepEqual(Object.keys(ev.summary).sort(), ["attestation", "counts", "lostCompute"]);
    assert.equal(await (await get(app, `/api/job/${plain}`)).text(), before, "a job without attestation is byte-identical");
  });

  test("ARCH-502: restart keeps attestations (same SQLite file)", async () => {
    await app.stop();
    app = await start(store);
    assert.equal(app.store.getAttestation(ID(1))?.summary, "attested");
    assert.equal(app.store.getAttestation(ID(2))?.summary, "unverified");
    assert.deepEqual(await (await post(app, "/ingest/job", attested(ID(1)))).json(), { accepted: 0, repeats: 1, refused: [] }, "still a repeat after the restart");
    const snap = (await (await get(app, "/api/snapshot")).json()) as { jobs: Record<string, any> };
    assert.deepEqual(Object.keys(snap.jobs).sort(), ["attestation", "counts", "lostCompute", "recent"]);
    assert.equal(snap.jobs.attestation.attested, 4);
    const ev = (await (await get(app, `/api/job/${ID(6)}`)).json()) as Record<string, any>;
    assert.equal(ev.job.attestation.calls[0].signatureHex, "0x" + "cd".repeat(64) + "1b", "evidence survives a restart");
    assert.equal(snap.jobs.attestation.unverified, 1);
  });
});
