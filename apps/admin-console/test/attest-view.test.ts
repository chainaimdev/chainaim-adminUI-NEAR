/** lib/attest-view.ts (owner 2026-11-07): attestation in plain words for every tab; joins by the settlement tx hash. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionFor, attestAttention, attestShare, attestView, callSentence, jobsByTx, usdcOf } from "../lib/attest-view.ts";
import { txKey } from "../lib/live-store.ts";
import type { AttestedCall, JobView } from "../lib/types.ts";

const NET = "near:testnet";
const call = (o: Partial<AttestedCall>): AttestedCall => ({
  step: "answer", model: "nearai/deepseek-v4.1-flash", servedModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017", providerId: "chatcmpl-1",
  signatureKind: "provider_tee", signingAlgo: "ecdsa", signingAddress: "0x9f3a0000000000000000000000000000000c21e", reportFetchedMs: 1, tdx: true, gpu: true,
  signature: true, hashes: true, status: "verified", reason: null, ...o,
});
const bedrock = call({ step: "query", model: "bedrock/nemotron-nano-3-30b", status: "not_applicable", signatureKind: null, signingAddress: null, tdx: null, gpu: null, signature: null, hashes: null });
const job = (id: string, o: Partial<JobView> = {}): JobView => ({
  jobId: id.padEnd(32, "0"), network: NET, state: "released", amount: "10000", totalUsd: "0.01", quotedMs: 1, expiresMs: 2, paidMs: 1, releasedMs: 1, expiredMs: null,
  txHash: `tx${id}`, breakdown: null, steps: null, receivedMs: 1, noJobEvent: false, invoiceId: null, payer: null, reconcile: null, ...o,
});
const att = (summary: NonNullable<JobView["attestation"]>["summary"], calls: AttestedCall[], receivedMs = 1000) => ({ attestation: { tsMs: receivedMs, summary, calls, receivedMs } });

test("verified: the label counts NEAR AI calls and not-attestable ones; the sentence names what was checked", () => {
  const v = attestView(job("a", att("attested", [bedrock, call({})])))!;
  assert.equal(v.tone, "ok");
  assert.equal(v.label, "Verified · 1/1 NEAR AI · 1 not attestable");
  assert.match(v.sentence, /query step \(bedrock\/nemotron-nano-3-30b\) has no enclave proof/);
  assert.match(v.sentence, /answer step \(nearai\/deepseek-v4\.1-flash\) ran in a NEAR AI enclave: its Intel TDX quote and its NVIDIA GPU proof were checked/);
  assert.match(v.sentence, /signed bytes match/);
  assert.equal(v.action, null);
});

test("failures carry the reason and what to do; pending and no-NEAR-AI are not failures", () => {
  const gw = attestView(job("b", att("unverified", [call({ status: "unverified", reason: "signed by NEAR AI's gateway, not by the model's TEE: model not attested" })])))!;
  assert.equal(gw.tone, "bad");
  assert.match(gw.action!, /do not claim attestation/);
  assert.match(actionFor(call({ status: "unverified", reason: "hash mismatch: the signature does not cover the bytes the gateway sent and received" }))!, /investigate/);
  assert.equal(attestView(job("c", att("unavailable", [call({ status: "unavailable", reason: "checking" })])))!.tone, "warn");
  assert.equal(attestView(job("d", att("not_applicable", [bedrock])))!.label, "No AI proof (no NEAR AI call)");
  assert.equal(attestView(job("e")), null, "no attestation stored: no verdict, never 'unverified'");
  assert.match(callSentence(call({ gpu: null })), /\(GPU not checked\)/);
});

test("joined by network:txHash, the ledger / reconcile key", () => {
  const m = jobsByTx({ a: job("a"), b: job("b", { txHash: null }) });
  assert.equal(m.get(txKey(NET, "txa"))?.jobId, "a".padEnd(32, "0"));
  assert.equal(m.size, 1);
});

test("needs attention: failed = error, partial = warn, pending only after the wait; newest first", () => {
  const jobs = {
    f: job("f", att("unverified", [call({ status: "unverified", reason: "hash mismatch" })], 5000)),
    p: job("p", att("partial", [call({}), call({ status: "unverified", reason: "x" })], 4000)),
    w: job("w", att("unavailable", [call({ status: "unavailable", reason: "checking" })], 1000)),
    ok: job("o", att("attested", [call({})], 6000)),
  };
  const early = attestAttention(jobs, 1000 + 60_000, 10 * 60_000);
  assert.deepEqual(early.map((a) => [a.level, a.title.split(" · ")[0]]), [["error", "AI proof failed"], ["warn", "AI proof partial"]]);
  const late = attestAttention(jobs, 1000 + 11 * 60_000, 10 * 60_000);
  assert.equal(late.length, 3);
  assert.match(late[2].detail, /not ready after 11 min/);
});

test("seller wallet split: money of paid jobs, and of those verified", () => {
  const s = attestShare({
    a: job("a", { amount: "10000", ...att("attested", [call({})]) }),
    b: job("b", { amount: "20000" }),
    c: job("c", { amount: "5000", state: "expired" }),
    d: job("d", { amount: "7000", network: "near:mainnet", ...att("attested", [call({})]) }),
  }, NET);
  assert.deepEqual(s, { paidJobs: 2, paidBase: 30000n, attestedJobs: 1, attestedBase: 10000n, pendingJobs: 1 });
  assert.equal(usdcOf(30000n), "0.03");
  assert.equal(usdcOf(1_250_000n), "1.25");
  assert.equal(usdcOf(0n), "0");
});
