/**
 * CONSOLE-STREAM: proxyStream against the real near-watch WatchServer (ported from liveops). hello passes through
 * first, live events follow (a final block, the recorded transfer's tx via the winning road, the later road's `road`
 * event with its lag), the key is never in the bytes, and a browser leaving frees near-watch's stream slot.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { proxyStream } from "../lib/proxy.ts";
import { ADMIN_KEY, drainSockets, EXPLORER, startWatchServer, TX_HASH, until, type Running } from "./watch-server.ts";

let nw: Running;
before(async () => {
  nw = await startWatchServer();
});
after(async () => {
  await nw.close();
  await drainSockets();
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, ms = 3000): Promise<string> {
  const dec = new TextDecoder();
  let text = "";
  const end = Date.now() + ms;
  while (!text.includes(needle)) {
    if (Date.now() > end) throw new Error(`no "${needle}" within ${ms} ms; got: ${text.slice(0, 300)}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before "${needle}"`);
    text += dec.decode(value, { stream: true });
  }
  return text;
}

test("CONSOLE-STREAM hello, then ledger, tx (first road) and road (later road) as text/event-stream; key never in the bytes; leaving frees the slot", async () => {
  const browser = new AbortController();
  const res = await proxyStream(new Request("http://console.local/api/watch/stream", { signal: browser.signal }), nw.cfg());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(res.headers.get("cache-control"), "no-store, no-transform");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let text = await readUntil(reader, "event: hello");
  await until(() => nw.server.clientCount === 1, "near-watch to count the stream client");
  nw.deliver();
  text += await readUntil(reader, "event: seller");
  assert.ok(text.indexOf("event: hello") < text.indexOf("event: ledger"));
  assert.ok(text.indexOf("event: tx") < text.indexOf("event: road"));
  assert.match(text, /"index":276202563/, "ledger.index is the NEAR final block height");
  assert.ok(text.includes(`"hash":"${TX_HASH}"`), "base58 hash passed through unchanged");
  assert.ok(text.includes(`"tx":"${EXPLORER}/txns/${TX_HASH}"`), "tx events carry near-watch's explorer link");
  assert.match(text, /"via":"qn-rpc","lagMs":\d+,"firstVia":"neardata"/);
  assert.equal(text.includes(ADMIN_KEY), false);
  browser.abort();
  await reader.cancel().catch(() => undefined);
  await until(() => nw.server.clientCount === 0, "near-watch to drop the stream client after the browser left");
});

test("CONSOLE-STREAM wrong key: 502 JSON, not a stream", async () => {
  const res = await proxyStream(new Request("http://console.local/api/watch/stream"), nw.cfg("wrong-key-wrong-key-wrong-key-123"));
  assert.equal(res.status, 502);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await res.json(), { error: "near-watch refused the admin key" });
});

test("CONSOLE-STREAM near-watch down: 502 'unreachable'", async () => {
  const down = await startWatchServer();
  const cfg = down.cfg();
  await down.close();
  const res = await proxyStream(new Request("http://console.local/api/watch/stream"), cfg);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "near-watch unreachable" });
});
