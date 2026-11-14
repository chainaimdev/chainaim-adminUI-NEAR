/** CONSOLE-PROXY rules (lib/proxy.ts upstreamFor; ported from liveops): what the browser may ask near-watch through the console. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNearWatchUrl } from "../lib/config.ts";
import { proxyGet, upstreamFor } from "../lib/proxy.ts";

const BASE = parseNearWatchUrl("http://127.0.0.1:8790");
/** The recorded real testnet transfer (services/near-watch/test/fixtures/x402-near-payment.json): base58, case-sensitive. */
const HASH = "H3ZFsVY1zDSQKsL3dktYBcNHSLiE8GpR5JtytFLjnbqD";
const q = (s = ""): URLSearchParams => new URLSearchParams(s);

test("CONSOLE-PROXY-ALLOW read routes map to near-watch /api/*, with only the known query keys; hashes keep their case", () => {
  const ok = (segments: string[], search = "") => {
    const r = upstreamFor(BASE, segments, q(search));
    assert.ok(r.ok, JSON.stringify(r));
    return r.url.href;
  };
  assert.equal(ok(["snapshot"]), "http://127.0.0.1:8790/api/snapshot");
  assert.equal(ok(["txs"], "limit=50&network=testnet"), "http://127.0.0.1:8790/api/txs?limit=50&network=testnet");
  assert.equal(ok(["reconcile"], "state=only_in_log"), "http://127.0.0.1:8790/api/reconcile?state=only_in_log");
  assert.equal(ok(["tx", HASH], "network=testnet"), `http://127.0.0.1:8790/api/tx/${HASH}?network=testnet`);
  assert.equal(ok(["trace", "339C78BE7D5B47E69A3FCDC03A34BC77"]), "http://127.0.0.1:8790/api/trace/339C78BE7D5B47E69A3FCDC03A34BC77");
  for (const r of ["feeds", "claims", "metrics", "seller"]) assert.equal(ok([r]), `http://127.0.0.1:8790/api/${r}`);
});

test("CONSOLE-PROXY-REFUSE ingest, healthz, stream, unknown routes, traversal, wrong arity, unknown or repeated query keys", () => {
  const no = (segments: string[], search = "", status = 404) => {
    const r = upstreamFor(BASE, segments, q(search));
    assert.equal(r.ok, false, segments.join("/"));
    if (!r.ok) assert.equal(r.status, status, `${segments.join("/")}: ${r.error}`);
  };
  no(["ingest"]);
  no(["ingest", "claim"]);
  no(["ingest", "trace"]);
  no(["healthz"]);
  no(["stream"]);
  no(["__proto__"]);
  no(["constructor"]);
  no([]);
  no(["snapshot", "x"]);
  no(["seller", "x"]);
  no(["tx"]);
  no(["tx", ".."], "", 400);
  no(["tx", "a/b"], "", 400);
  no(["tx", "a%2Fb"], "", 400);
  no(["txs"], "key=x", 400);
  no(["txs"], "limit=1&limit=2", 400);
  no(["txs"], `network=${"x".repeat(65)}`, 400);
});

test("CONSOLE-PROXY-METHOD only GET is proxied", async () => {
  const cfg = { nearWatchUrl: BASE, adminKeyEnv: "ADMIN_API_KEY", adminKey: "k".repeat(40), upstreamTimeoutMs: 1000, connectTimeoutMs: 1000 };
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await proxyGet(new Request("http://console.local/api/watch/snapshot", { method }), ["snapshot"], cfg);
    assert.equal(res.status, 405, method);
  }
});

test("CONSOLE-PROXY-AGENTS private-AI agent calls: /api/watch/agent-calls with limit and tenant only", () => {
  const r = upstreamFor(BASE, ["agent-calls"], q("limit=200&tenant=jupiter-knitting"));
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) assert.equal(r.url.href, "http://127.0.0.1:8790/api/agent-calls?limit=200&tenant=jupiter-knitting");
  const extra = upstreamFor(BASE, ["agent-calls"], q("alias=x"));
  assert.equal(extra.ok, false);
  const arity = upstreamFor(BASE, ["agent-calls", "x"], q());
  assert.equal(arity.ok, false);
  const ingest = upstreamFor(BASE, ["ingest", "agent"], q());
  assert.equal(ingest.ok, false, "the console never reaches /ingest");
});
