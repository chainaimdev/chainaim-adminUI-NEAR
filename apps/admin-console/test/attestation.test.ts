/**
 * ARCH-504 (PLAN-adminui-nearai-attestation.md): the Jobs tab's attestation data path. The REAL near-watch server
 * (test/watch-server.ts) takes a job and its job_attested through its own ingest parsers and streams them through the
 * console's proxy; lib/live-store.ts keeps the attestation on the job and the attested counts in the summary. A job
 * without attestation stays as before (blank in the Attested column, not "unverified").
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { applyEvent, emptyState, type LiveState } from "../lib/live-store.ts";
import { proxyGet, proxyStream } from "../lib/proxy.ts";
import { CAIP2, drainSockets, startWatchServer, until, type Running } from "./watch-server.ts";

const PLAIN = "a77e5700000000000000000000000001";
/** fix 4: what NEAR AI signed (model id + two SHA-256 hex) and an ecdsa signature (65 bytes). */
const SIGNED_TEXT = `deepseek-ai/DeepSeek-V4.1-Flash-1017:${"1a".repeat(32)}:${"2b".repeat(32)}`;
const SIGNATURE = "0x" + "cd".repeat(64) + "1b";
const JOB = "a77e5700000000000000000000000002";
const quoted = (jobId: string) => ({
  v: 1, event: "job_quoted", ts: "2026-11-06T10:00:00.000Z", jobId, network: CAIP2, amount: "12001", totalUsd: "0.012001", expiresAt: "2026-11-06T10:15:00.000Z",
  steps: [{ name: "query", ms: 2310, model: "nearai/deepseek-v4.1-flash", zone: "private-cloud", promptTokens: 1000, completionTokens: 50, usd: "0.000360", entityCounts: {}, residual: "pass" }],
  breakdown: { calls: [{ model: "nearai/deepseek-v4.1-flash", promptTokens: 1000, completionTokens: 50, usd: "0.000360" }], modelUsd: "0.000360", callFeesUsd: "0.001000", analystUsd: "0.000000", nearGasUsd: "0.000500", marginPct: "20", minPriceUsd: "0.01", minApplied: true },
});
const attested = {
  v: 1, event: "job_attested", ts: "2026-11-06T10:00:30.000Z", jobId: JOB, network: CAIP2, summary: "attested",
  calls: [{
    step: "query", model: "nearai/deepseek-v4.1-flash", servedModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017", providerId: "chatcmpl-0123456789abcdef",
    signatureKind: "provider_tee", signingAlgo: "ecdsa", signingAddress: "0x" + "ab12".repeat(10), reportFetchedAt: "2026-11-06T09:59:00.000Z",
    tdx: true, gpu: true, signature: true, hashes: true, status: "verified", reason: null,
    signedText: SIGNED_TEXT, signatureHex: SIGNATURE,
  }],
};

type SseEvent = { event: string; data: unknown };
let nw: Running;
const events: SseEvent[] = [];
before(async () => {
  nw = await startWatchServer();
  const browser = new AbortController();
  const res = await proxyStream(new Request("http://console.local/api/watch/stream", { signal: browser.signal }), nw.cfg());
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const readFor = async (cond: () => boolean): Promise<void> => {
    const end = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`stream incomplete: ${text.slice(-300)}`);
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      text += dec.decode(value, { stream: true });
    }
  };
  await readFor(() => text.includes("event: hello"));
  await until(() => nw.server.clientCount === 1, "near-watch to count the stream client");
  for (const r of [nw.liveOps.ingestJob(quoted(PLAIN)), nw.liveOps.ingestJob(quoted(JOB)), nw.liveOps.ingestJob(attested)]) {
    if (!r.ok) throw new Error(`refused: ${r.error}`);
  }
  await readFor(() => text.split("event: job\n").length - 1 >= 3 && text.endsWith("\n\n"));
  browser.abort();
  await reader.cancel().catch(() => undefined);
  await until(() => nw.server.clientCount === 0, "near-watch to drop the stream client");
  for (const frame of text.split("\n\n")) {
    const lines = frame.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
    if (ev) events.push({ event: ev, data: JSON.parse(data) as unknown });
  }
});
after(async () => {
  await nw.close();
  await drainSockets();
});

const replay = (list: SseEvent[], from: LiveState = emptyState()): LiveState => list.reduce((s, e) => applyEvent(s, e.event, e.data), from);

test("ARCH-504: the store keeps the attestation from the real near-watch on its job, and none on the other", () => {
  const s = replay(events);
  assert.equal(s.stats.errors, 0, s.stats.lastError ?? "");
  const j = s.jobs[JOB];
  assert.equal(j.attestation?.summary, "attested");
  assert.equal(j.attestation?.calls[0].providerId, "chatcmpl-0123456789abcdef");
  assert.equal(j.attestation?.calls[0].signingAddress, "0x" + "ab12".repeat(10));
  assert.equal(j.attestation?.calls[0].reportFetchedMs, Date.parse("2026-11-06T09:59:00.000Z"));
  assert.equal(j.attestation?.calls[0].signedText, SIGNED_TEXT, "fix 4: signed text arrives through the real near-watch");
  assert.equal(j.attestation?.calls[0].signatureHex, SIGNATURE, "fix 4: signature arrives through the real near-watch");
  assert.equal(s.jobs[PLAIN].attestation, undefined, "no data -> no attestation (blank, not unverified)");
  assert.deepEqual(s.jobSummary?.attestation, { attested: 1, partial: 0, unverified: 0, unavailable: 0, not_applicable: 0 });
  assert.deepEqual(s.jobSummary?.counts, { quoted: 2, paid: 0, released: 0, expired: 0 });
});

test("ARCH-504: before any job_attested the summary has no attestation key (as before)", () => {
  const firstTwo = events.filter((e) => e.event === "job").slice(0, 2);
  const s = replay(firstTwo, replay(events.filter((e) => e.event === "hello")));
  assert.equal(s.jobSummary?.attestation, undefined);
  assert.deepEqual(Object.keys(s.jobSummary ?? {}).sort(), ["counts", "lostCompute"]);
});

test("ARCH-504: a malformed attestation is refused and counted, the state unchanged", () => {
  const s = replay(events);
  const job = s.jobs[JOB];
  for (const bad of [{ ...job, attestation: "attested" }, { ...job, attestation: { ...job.attestation, summary: "maybe" } }, { ...job, attestation: { ...job.attestation, calls: "x" } }]) {
    const next = applyEvent(s, "job", { job: bad, summary: s.jobSummary });
    assert.equal(next.stats.errors, s.stats.errors + 1);
    assert.equal(next.jobs, s.jobs);
  }
  const badSummary = applyEvent(s, "job", { job, summary: { ...s.jobSummary, attestation: 3 } });
  assert.equal(badSummary.stats.errors, s.stats.errors + 1);
});

test("ARCH-504: hello after a reconnect carries the attestation and its counts", async () => {
  const r = await proxyGet(new Request("http://console.local/api/watch/snapshot"), ["snapshot"], nw.cfg());
  assert.equal(r.status, 200);
  const s = applyEvent(emptyState(), "hello", await r.json());
  assert.equal(s.stats.errors, 0, s.stats.lastError ?? "");
  assert.equal(s.jobs[JOB].attestation?.summary, "attested");
  assert.equal(s.jobSummary?.attestation?.attested, 1);
});

test("ARCH-504: /api/watch/job/<id> through the proxy shows the attestation", async () => {
  const one = await proxyGet(new Request(`http://console.local/api/watch/job/${JOB}`), ["job", JOB], nw.cfg());
  assert.equal(one.status, 200);
  const body = (await one.json()) as { job: { attestation: { summary: string; calls: unknown[] } } };
  assert.deepEqual([body.job.attestation.summary, body.job.attestation.calls.length], ["attested", 1]);
  const plain = (await (await proxyGet(new Request(`http://console.local/api/watch/job/${PLAIN}`), ["job", PLAIN], nw.cfg())).json()) as { job: Record<string, unknown> };
  assert.equal("attestation" in plain.job, false);
});
