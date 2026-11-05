/**
 * ARCH-210 (architecture-adminui-jobs.md): the Jobs tab's data path. The proxy allows /api/watch/jobs and
 * /api/watch/job/<id> (and still refuses /ingest); lib/live-store.ts applies the `job` events the REAL near-watch server
 * (test/watch-server.ts) streams through the console's proxy while a job goes quoted -> paid -> released on near-watch's
 * recorded real testnet payment (0.01 USDC, H3ZFsVY1…), reconciled matched by near-watch itself.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { applyEvent, emptyState, type LiveState } from "../lib/live-store.ts";
import { proxyGet, proxyStream, upstreamFor } from "../lib/proxy.ts";
import { parseNearWatchUrl } from "../lib/config.ts";
import { claimLine } from "./session.ts";
import { CAIP2, drainSockets, startWatchServer, TX_HASH, until, type Running } from "./watch-server.ts";

const JOB = "9001b38e0c2a4f5d8e7b6a5c4d3e141b";
const quoted = {
  v: 1, event: "job_quoted", ts: "2026-11-05T10:00:00.000Z", jobId: JOB, network: CAIP2, amount: "12001", totalUsd: "0.012001", expiresAt: "2026-11-05T10:15:00.000Z",
  steps: [
    { name: "analyst", ms: 412, files: 2, relations: 1 },
    { name: "query", ms: 2310, model: "bedrock/nemotron-nano-3-30b", zone: "private-cloud", promptTokens: 1000, completionTokens: 50, usd: "0.000075", entityCounts: { PERSON: 3 }, residual: "pass" },
    { name: "sql", ms: 38, rows: 4 },
  ],
  breakdown: { calls: [{ model: "bedrock/nemotron-nano-3-30b", promptTokens: 1000, completionTokens: 50, usd: "0.000075" }], modelUsd: "0.000075", callFeesUsd: "0.001000", analystUsd: "0.002000", nearGasUsd: "0.000500", marginPct: "20", minPriceUsd: "0.01", minApplied: true },
};

type SseEvent = { event: string; data: unknown };
let nw: Running;
let events: SseEvent[] = [];
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
  nw.deliver();
  // As the private-ai console's job feed and the paywall send them, through near-watch's own ingest parsers.
  for (const r of [
    nw.liveOps.ingestJob(quoted),
    nw.liveOps.ingestClaim({ ...claimLine(TX_HASH, "INV-JOB-1"), route: `POST /v1/jobs/${JOB}/release` }, "http"),
    nw.liveOps.ingestJob({ v: 1, event: "job_released", ts: "2026-11-05T10:01:05.000Z", jobId: JOB, network: CAIP2 }),
  ]) {
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

test("ARCH-210: the proxy allows /api/watch/jobs and /api/watch/job/<id> and still refuses /ingest", () => {
  const base = parseNearWatchUrl("http://127.0.0.1:8790");
  const ok = (segments: string[], search = "") => {
    const r = upstreamFor(base, segments, new URLSearchParams(search));
    assert.ok(r.ok, JSON.stringify(r));
    return r.url.href;
  };
  assert.equal(ok(["jobs"], "limit=50&state=expired&network=testnet"), "http://127.0.0.1:8790/api/jobs?limit=50&state=expired&network=testnet");
  assert.equal(ok(["job", JOB]), `http://127.0.0.1:8790/api/job/${JOB}`);
  for (const segments of [["ingest", "job"], ["ingest"], ["job"], ["jobs", JOB], ["job", JOB, "x"]]) assert.equal(upstreamFor(base, segments, new URLSearchParams()).ok, false, segments.join("/"));
  assert.equal(upstreamFor(base, ["jobs"], new URLSearchParams("question=x")).ok, false, "unknown query key");
});

test("ARCH-210: the store applies job events from the real near-watch: quoted -> paid -> released, reconcile matched", () => {
  const jobEvents = events.filter((e) => e.event === "job");
  assert.equal(jobEvents.length, 3);
  const s = replay(events);
  assert.equal(s.stats.errors, 0, s.stats.lastError ?? "");
  assert.deepEqual(s.stats.ignored, {});
  const states: string[] = [];
  jobEvents.reduce((st, e) => {
    const next = applyEvent(st, e.event, e.data);
    states.push(next.jobs[JOB].state);
    return next;
  }, replay(events.filter((e) => e.event === "hello")));
  assert.deepEqual(states, ["quoted", "paid", "released"]);
  const j = s.jobs[JOB];
  assert.equal(j.txHash, TX_HASH);
  assert.equal(j.reconcile, "matched");
  assert.equal(j.totalUsd, "0.012001");
  assert.equal(j.steps?.length, 3);
  assert.deepEqual(s.jobSummary?.counts, { quoted: 0, paid: 0, released: 1, expired: 0 });
  assert.equal(s.jobSummary?.lostCompute.testnet, "0.000000");
  assert.ok(s.rail.some((r) => r.text.startsWith("job 9001b3…141b: paid → released")), "the change log names the step");
  // Before any job event, nothing about jobs exists in the state (ARCH-201).
  const hello = replay(events.filter((e) => e.event === "hello"));
  assert.deepEqual([hello.jobs, hello.jobSummary], [{}, null]);
});

test("ARCH-210: a malformed job event is refused and counted, the state unchanged", () => {
  const s = replay(events);
  for (const bad of [{ job: { jobId: "x" }, summary: {} }, { job: { ...s.jobs[JOB], state: "lost" }, summary: s.jobSummary }, "job"]) {
    const next = applyEvent(s, "job", bad);
    assert.equal(next.stats.errors, s.stats.errors + 1);
    assert.equal(next.jobs, s.jobs);
  }
});

test("ARCH-210: /api/watch/jobs and /api/watch/job/<id> through the proxy to the real near-watch", async () => {
  const get = (path: string) => new Request(`http://console.local/api/watch/${path}`);
  const list = await proxyGet(get("jobs?state=released"), ["jobs"], nw.cfg());
  assert.equal(list.status, 200);
  const body = (await list.json()) as { jobs: { jobId: string }[]; counts: Record<string, number> };
  assert.deepEqual(body.jobs.map((x) => x.jobId), [JOB]);
  const one = await proxyGet(get(`job/${JOB}`), ["job", JOB], nw.cfg());
  assert.equal(one.status, 200);
  const j = (await one.json()) as { job: { state: string }; reconcile: { state: string } };
  assert.deepEqual([j.job.state, j.reconcile.state], ["released", "matched"]);
  assert.equal((await proxyGet(get(`job/${"0".repeat(32)}`), ["job", "0".repeat(32)], nw.cfg())).status, 404);
});
