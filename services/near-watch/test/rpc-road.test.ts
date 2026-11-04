/**
 * The RPC road's read-ahead (src/feeds/rpc-poll.ts, --rpc-prefetch). Live testnet, 2026-11-04: one height costs a block
 * call plus ~1.8 chunk calls at ~270-370 ms each, done one after another = ~770-970 ms a height, while testnet makes a
 * final block every ~580 ms, so a serial road falls further behind the longer it runs (rpc ~215 blocks, qn-rpc ~670
 * blocks behind the chain; transfer BFEX1KAH… recorded 58.2 s after its block). Here the double answers every call
 * after a fixed round trip and the road walks the three recorded heights of that real payment: serial vs read-ahead.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Bus } from "../src/events.ts";
import { RpcPollRoad } from "../src/feeds/rpc-poll.ts";
import { Roads } from "../src/roads.ts";
import { httpRpc } from "../src/rpc.ts";
import { Store } from "../src/store.ts";
import { lateFixture as lf, RECEIVER } from "./fixtures.ts";
import { NearRpcDouble } from "./near-rpc-double.ts";

const RTT_MS = 150;
let rpc: NearRpcDouble;
before(async () => {
  rpc = new NearRpcDouble(lf);
  rpc.latencyMs = RTT_MS;
  await rpc.listen();
});
after(() => rpc.close());

async function walk(prefetch: number, minIntervalMs = 0): Promise<{ ms: number; maxInFlight: number; ledger: number[]; via: string | undefined; road: RpcPollRoad }> {
  rpc.maxInFlight = 0;
  const store = new Store(":memory:");
  const bus = new Bus();
  const ledger: number[] = [];
  bus.on((name, data) => {
    if (name === "ledger") ledger.push((data as { index: number }).index);
  });
  // Only the pay-to is watched: the road finds the payment through its NEP-366 Delegate action.
  const roads = new Roads(store, bus, { usdcContract: lf.contract, decimals: 6, watched: new Map([["testnet", new Set([RECEIVER])]]), payTo: new Map([["testnet", new Set([RECEIVER])]]) });
  const road = new RpcPollRoad(
    { network: "testnet", road: "rpc", provider: "near-rpc", startHeight: lf.inclusionHeight, endHeight: null, pollSec: 1, staleSec: 30, resetBlocks: 100_000, backoffMaxSec: 5, minIntervalMs, contract: lf.contract, txStatusTimeoutMs: 10_000, prefetch },
    httpRpc("rpc", rpc.url, { timeoutMs: 10_000 }),
    roads,
    store,
    bus,
  );
  const t0 = performance.now();
  road.start();
  try {
    for (;;) {
      if (store.getCursor("testnet", "rpc") === lf.receiptHeight) break;
      if (performance.now() - t0 > 15_000) throw new Error("road did not reach the recorded receipt height");
      await new Promise((r) => setTimeout(r, 10));
    }
    const ms = performance.now() - t0;
    return { ms, maxInFlight: rpc.maxInFlight, ledger: [...new Set(ledger)], via: store.getTx("testnet", lf.tx)?.firstVia, road };
  } finally {
    await road.stop();
    store.close();
  }
}

test("read-ahead: the same heights, the same transfer, in height order, in well under the serial time", async (t) => {
  const serial = await walk(1);
  const ahead = await walk(4);
  t.diagnostic(`serial ${serial.ms.toFixed(0)} ms (max ${serial.maxInFlight} in flight) vs read-ahead 4: ${ahead.ms.toFixed(0)} ms (max ${ahead.maxInFlight}); round trip ${RTT_MS} ms`);
  assert.equal(serial.maxInFlight, 1, "prefetch 1 = one call after another (the old behaviour)");
  assert.ok(ahead.maxInFlight > 1, `reads overlap (max ${ahead.maxInFlight} in flight)`);
  for (const r of [serial, ahead]) {
    assert.equal(r.via, "rpc", "the real BFEX1KAH… payment is recorded");
    assert.deepEqual(r.ledger, [lf.inclusionHeight, lf.inclusionHeight + 1, lf.receiptHeight], "blocks handed in strictly in height order");
  }
  // Serial: tip + 3 blocks + 5 chunks + tx status + its receipt block, one round trip each.
  assert.ok(serial.ms >= 10 * RTT_MS, `serial ${serial.ms.toFixed(0)} ms`);
  assert.ok(ahead.ms < serial.ms * 0.6, `read-ahead ${ahead.ms.toFixed(0)} ms vs serial ${serial.ms.toFixed(0)} ms`);
});

test("--rpc-min-ms paces each request, so it forces the read-ahead to 1", async () => {
  const paced = await walk(4, 1);
  assert.equal(paced.road.prefetch, 1);
  assert.equal(paced.maxInFlight, 1);
});
