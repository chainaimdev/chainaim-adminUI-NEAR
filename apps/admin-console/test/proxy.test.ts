/**
 * CONSOLE-PROXY-LIVE: proxyGet against the real near-watch WatchServer (ported from liveops). The key is added by the
 * console, the answer never contains it, upstream failures are reported without near-watch's address, and tx entries
 * arrive decorated by near-watch with `network` and explorer `links` (the browser never builds a URL).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { proxyGet } from "../lib/proxy.ts";
import { ADMIN_KEY, drainSockets, EXPLORER, PAY_TO, startWatchServer, TX_HASH, type Running } from "./watch-server.ts";

let nw: Running;
before(async () => {
  nw = await startWatchServer();
  nw.deliver();
});
after(async () => {
  await nw.close();
  await drainSockets();
});

const get = (path: string): Request => new Request(`http://console.local/api/watch/${path}`);

test("CONSOLE-PROXY-LIVE snapshot through the console: 200 JSON from near-watch, key added server-side, never echoed", async () => {
  const res = await proxyGet(get("snapshot"), ["snapshot"], nw.cfg());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  assert.equal(text.includes(ADMIN_KEY), false);
  const body = JSON.parse(text) as { version: string; networks: string[]; txs: { row: { hash: string }; firstVia: string; links: { tx: string } }[]; seller: { wallets: { address: string }[] } };
  assert.equal(body.version, "console-test");
  assert.deepEqual(body.networks, ["testnet"]);
  assert.equal(body.txs[0].row.hash, TX_HASH, "base58 hash kept exactly");
  assert.equal(body.txs[0].firstVia, "neardata");
  assert.equal(body.txs[0].links.tx, `${EXPLORER}/txns/${TX_HASH}`);
  assert.equal(body.seller.wallets[0].address, PAY_TO);
});

test("CONSOLE-PROXY-LIVE /api/tx/<base58>: the row and every road that delivered it (neardata first, qn-rpc later)", async () => {
  const res = await proxyGet(get(`tx/${TX_HASH}?network=testnet`), ["tx", TX_HASH], nw.cfg());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { firstVia: string; roads: { via: string; lagMs: number }[] };
  assert.equal(body.firstVia, "neardata");
  assert.deepEqual(
    body.roads.map((r) => r.via),
    ["neardata", "qn-rpc"],
  );
});

test("CONSOLE-PROXY-LIVE near-watch's own 404 (a hash it has not seen, or a route it lacks) is passed on", async () => {
  // H3ZF… -> H3zF…: still valid base58, but another hash (lower-casing it whole would make an invalid "l").
  const lower = TX_HASH.replace("Z", "z");
  assert.notEqual(lower, TX_HASH);
  const res = await proxyGet(get(`tx/${lower}`), ["tx", lower], nw.cfg());
  assert.equal(res.status, 404, "base58 is case-sensitive: a hash differing only in case is another hash");
  assert.deepEqual(await res.json(), { error: "not seen" });
  const feeds = await proxyGet(get("feeds"), ["feeds"], nw.cfg());
  assert.equal(feeds.status, 404, "this double runs no roads, so near-watch has no feeds report");
  await feeds.body?.cancel();
});

test("CONSOLE-PROXY-LIVE a wrong admin key becomes 502 'refused the admin key', not near-watch's 401", async () => {
  const res = await proxyGet(get("snapshot"), ["snapshot"], nw.cfg("wrong-key-wrong-key-wrong-key-123"));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "near-watch refused the admin key" });
});

test("CONSOLE-PROXY-LIVE near-watch down: 502 'unreachable', without its address", async () => {
  const down = await startWatchServer();
  const cfg = down.cfg();
  await down.close();
  const res = await proxyGet(get("snapshot"), ["snapshot"], cfg);
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.equal(text.includes(cfg.nearWatchUrl.host), false);
  assert.deepEqual(JSON.parse(text), { error: "near-watch unreachable" });
});
