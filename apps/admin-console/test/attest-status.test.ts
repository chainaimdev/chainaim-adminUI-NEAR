/** lib/attest-status.ts (owner 2026-11-07): the Feeds tab's attestation-service row, against a real loopback ca-attest stand-in. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { attestUrl, readAttestStatus, summarizeReports } from "../lib/attest-status.ts";

let srv: Server, base: URL, mode = "ok";
before(async () => {
  srv = createServer((req, res) => {
    if (mode === "500") { res.writeHead(500).end("{}"); return; }
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz") res.end(JSON.stringify({ ok: true, service: "attest", ready: true, models: ["m"], gpuCheck: true }));
    else if (req.url === "/reports") res.end(JSON.stringify({ models: [{ model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", latest: { model: "x", nonce: "SECRET-NONCE", fetchedAt: "2026-11-07T10:00:00.000Z",
      attestations: [{ signingAddress: "0x9f3a", signingAlgo: "ecdsa", verified: true, reasons: [], checks: { tdxVerified: true, embedsNonce: true, bindsAddress: true, gpu: { checked: true, nonceMatches: true, verdict: true }, quote: "HUGE-QUOTE" } }] } }] }));
    else res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = new URL(`http://127.0.0.1:${(srv.address() as { port: number }).port}/`);
});
after(() => new Promise<void>((r) => srv.close(() => r())));

test("up: per model the report time, signer, the checks and the verdict; never the nonce or the quote", async () => {
  mode = "ok";
  const s = await readAttestStatus(base, 2000);
  assert.ok(s.configured && s.up);
  if (!s.configured || !s.up) return;
  assert.equal(s.ready, true);
  assert.deepEqual(s.models[0], { model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", fetchedAt: "2026-11-07T10:00:00.000Z", error: null,
    attestations: [{ signingAddress: "0x9f3a", verified: true, reasons: [], tdx: true, gpu: true, bindsNonce: true }] });
  assert.ok(!JSON.stringify(s).includes("SECRET-NONCE") && !JSON.stringify(s).includes("HUGE-QUOTE"));
});

test("down or refusing: a plain reason without the URL; off: not shown", async () => {
  mode = "500";
  const s = await readAttestStatus(base, 2000);
  assert.deepEqual(s, { configured: true, up: false, error: "ca-attest answered HTTP 500 on healthz" });
  const gone = await readAttestStatus(new URL("http://127.0.0.1:1/"), 500);
  assert.ok(gone.configured && !gone.up && !gone.error.includes("127.0.0.1"));
  assert.equal(attestUrl({ ATTEST_URL: "off" }), null);
  assert.equal(attestUrl({})!.href, "http://127.0.0.1:8770/");
  assert.throws(() => attestUrl({ ATTEST_URL: "http://example.com:8770" }), /loopback/);
});

test("malformed bodies become empty, never a throw", () => {
  assert.deepEqual(summarizeReports(null, { models: [{ latest: { attestations: [null] } }] }).models[0].attestations[0], { signingAddress: "?", verified: false, reasons: [], tdx: false, gpu: null, bindsNonce: false });
});
