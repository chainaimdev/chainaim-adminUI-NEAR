/**
 * One recorded console session, as the browser receives it: the bytes of /api/watch/stream (lib/proxy.ts proxyStream)
 * from the real near-watch WatchServer (test/watch-server.ts), parsed into SSE events. Takes the place of liveops'
 * recorded ndjson fixture: near-watch has no SSE recording yet, so the session is produced live from near-watch's
 * recorded real testnet transfer, plus two paywall claims sent through near-watch's own ingest parser:
 *   claim 1  the recorded payment's hash, 10000 base units, payer chainaim-buyer-seller.testnet -> matched (a real
 *            x402 NEAR payment: no memo, joined by tx hash; the claim's invoiceId is only shown)
 *   claim 2  a hash near-watch has never seen on chain                                         -> pending (inside grace)
 * Every event is computed by near-watch; this file only drives it and reads the stream.
 */
import { proxyStream } from "../lib/proxy.ts";
import { AMOUNT, fixture } from "../../../services/near-watch/test/fixtures.ts";
import { BUYER, CAIP2, CONTRACT, startWatchServer, TX_HASH, until, type Running } from "./watch-server.ts";

export type SseEvent = { event: string; data: unknown };

/** A real base58 hash that is not a transaction: the recorded inclusion block's hash (never on chain as a tx). */
export const UNSEEN_HASH = Object.keys(fixture.blocks)[0];

export const claimLine = (hash: string, invoiceId: string) => ({
  event: "payment_settled",
  network: CAIP2,
  transaction: hash,
  asset: CONTRACT,
  amount: AMOUNT,
  payer: BUYER,
  invoiceId,
  route: "/v1/test",
  // Now: near-watch counts a claim as in flight only while it is younger than --inflight-expire-sec.
  ts: new Date().toISOString(),
});

function parse(text: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const frame of text.split("\n\n")) {
    const lines = frame.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
    if (ev) out.push({ event: ev, data: JSON.parse(data) as unknown });
  }
  return out;
}

export async function recordSession(): Promise<{ events: SseEvent[]; nw: Running }> {
  const nw = await startWatchServer();
  const browser = new AbortController();
  const res = await proxyStream(new Request("http://console.local/api/watch/stream", { signal: browser.signal }), nw.cfg());
  if (res.status !== 200 || !res.body) throw new Error(`stream answered ${res.status}`);
  const reader = res.body.getReader();
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
  for (const r of [nw.liveOps.ingestClaim(claimLine(TX_HASH, "INV-RECORDED-1"), "http"), nw.liveOps.ingestClaim(claimLine(UNSEEN_HASH, "INV-UNSEEN-2"), "http")]) {
    if (!r.ok) throw new Error(`claim refused: ${r.error}`);
  }
  nw.bus.emit("seller", nw.seller.compute());
  const count = (name: string): number => text.split(`event: ${name}\n`).length - 1;
  await readFor(() => count("reconcile") >= 2 && count("seller") >= 2 && text.endsWith("\n\n"));
  browser.abort();
  await reader.cancel().catch(() => undefined);
  await until(() => nw.server.clientCount === 0, "near-watch to drop the stream client");
  return { events: parse(text), nw };
}
