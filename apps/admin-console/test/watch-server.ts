/**
 * Starts the real near-watch HTTP server (services/near-watch/src/server.ts, the class main.ts runs) on a free loopback
 * port, with an in-memory store and near-watch's own Roads, Links, LiveOps and SellerBook, for the console's proxy,
 * stream and store tests (ported from liveops admin-console test/watch-server.ts). No npm install is needed in
 * services/near-watch: it has no runtime dependencies (node:sqlite is built in).
 *
 * Chain data is near-watch's RECORDED real testnet fixture (services/near-watch/test/fixtures/x402-near-payment.json,
 * written by its scripts/record-fixture.ts): one real x402 NEAR payment, 0.01 USDC from chainaim-buyer-seller.testnet
 * to the pay-to chainaim-payto-seller.testnet, relayed as a NEP-366 delegate ft_transfer with no memo. `deliver()` hands that receipt in through the neardata road (first) and the qn-rpc road
 * (later), exactly as the running roads do, so every event the console sees is computed by near-watch itself.
 * Not tested here: /api/feeds (main.ts builds it from running roads; this double starts none, so the route is 404).
 */
import { headerTimeMs, neardataBlock, txStatusOutcomes } from "../../../services/near-watch/src/decode.ts";
import { Bus, type EventName } from "../../../services/near-watch/src/events.ts";
import { Links } from "../../../services/near-watch/src/links.ts";
import { LiveOps } from "../../../services/near-watch/src/liveops.ts";
import { Roads } from "../../../services/near-watch/src/roads.ts";
import { SellerBook } from "../../../services/near-watch/src/seller.ts";
import { WatchServer } from "../../../services/near-watch/src/server.ts";
import { Store } from "../../../services/near-watch/src/store.ts";
import type { WatchEntry } from "../../../services/near-watch/src/watchlist.ts";
import { fixture, RECEIVER, SENDER } from "../../../services/near-watch/test/fixtures.ts";
import type { ConsoleConfig } from "../lib/config.ts";
import { parseNearWatchUrl } from "../lib/config.ts";

export const ADMIN_KEY = "near-console-test-admin-key-0123456789abcdef";
/** near-watch's default for testnet (docs/NEAR-GATES.md A5: the id @x402/near and the paywall use). */
export const CAIP2 = "near:testnet";
export const NETWORK = fixture.network;
export const CONTRACT = fixture.contract;
export const TX_HASH = fixture.txStatus.transaction.hash;
export const PAY_TO = RECEIVER;
export const BUYER = SENDER;
export const DECIMALS = 6;
export const EXPLORER = "https://testnet.nearblocks.io";

export const WATCHLIST: WatchEntry[] = [
  { network: NETWORK, label: "paywall", role: "payto", address: PAY_TO, source: "paywall" },
  { network: NETWORK, label: "buyer", role: "buyer", address: BUYER, source: "flag" },
];

export type Running = {
  server: WatchServer;
  bus: Bus;
  store: Store;
  roads: Roads;
  liveOps: LiveOps;
  seller: SellerBook;
  base: string;
  cfg: (key?: string) => ConsoleConfig;
  /** Every event near-watch emitted, in order, as the console would receive it after `hello`. */
  events: { event: EventName; data: unknown }[];
  /** The recorded transfer: block final + receipt via neardata (first road), then via qn-rpc (later road). */
  deliver: () => void;
  close: () => Promise<void>;
};

export async function startWatchServer(): Promise<Running> {
  const store = new Store(":memory:");
  const bus = new Bus();
  const events: Running["events"] = [];
  bus.on((event, data) => events.push({ event, data }));
  const roads = new Roads(store, bus, {
    usdcContract: CONTRACT,
    decimals: DECIMALS,
    watched: new Map([[NETWORK, new Set(WATCHLIST.map((w) => w.address))]]),
    payTo: new Map([[NETWORK, new Set([PAY_TO])]]),
  });
  const links = new Links({ bases: { [NETWORK]: EXPLORER }, txPath: "/txns/{hash}", accountPath: "/address/{address}" });
  const liveOps = new LiveOps(store, bus, {
    networks: [NETWORK],
    caips: { [CAIP2]: NETWORK },
    watchlist: WATCHLIST,
    graceBlocks: 5,
    lowCalls: 0,
    reconcileSec: 3600,
    reconcileBatch: 100,
    metricsWindowSec: 3600,
    alertEverySec: 60,
    paywallLogFile: null,
    paywallLogPollMs: 1000,
  });
  const seller = new SellerBook(store, bus, {
    networks: [NETWORK],
    watchlist: WATCHLIST,
    contract: CONTRACT,
    code: "USDC",
    decimals: DECIMALS,
    callPriceUnits: "10000",
    estimate: false,
    expireSec: 120,
    recent: 10,
    debounceMs: 0,
    windowSec: 3600,
  });
  const server = new WatchServer(
    { adminKey: ADMIN_KEY, networks: [NETWORK], watchlist: WATCHLIST, sseReplay: 10, sseHeartbeatSec: 30, sseMaxClients: 4, version: "console-test", startedAt: Date.now(), links },
    store,
    bus,
    roads,
    liveOps,
    seller,
  );
  const addr = await server.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${addr.port}`;
  const deliver = (): void => {
    const nd = neardataBlock(fixture.neardata[String(fixture.receiptHeight)], CONTRACT);
    roads.blockFinal(NETWORK, nd.block.height, nd.block.timeMs, nd.block.txCount, "neardata");
    for (const o of nd.outcomes) roads.offer(NETWORK, o, "neardata");
    const blocks = fixture.blocks as Record<string, { header: Record<string, unknown> & { height: number } }>;
    const rpcOutcomes = txStatusOutcomes(fixture.txStatus, CONTRACT, (h) => (blocks[h] ? { height: blocks[h].header.height, timeMs: headerTimeMs(blocks[h].header) } : undefined));
    for (const o of rpcOutcomes) roads.offer(NETWORK, o, "qn-rpc");
    // What SellerBook.start() would stream after the tx (debounced): computed now, synchronously.
    bus.emit("seller", seller.compute());
  };
  return {
    server,
    bus,
    store,
    roads,
    liveOps,
    seller,
    base,
    events,
    deliver,
    cfg: (key = ADMIN_KEY) => ({ nearWatchUrl: parseNearWatchUrl(base), adminKeyEnv: "ADMIN_API_KEY", adminKey: key, upstreamTimeoutMs: 3000, connectTimeoutMs: 3000 }),
    close: async () => {
      seller.stop();
      liveOps.stop();
      await server.close();
      store.close();
    },
  };
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until this process holds no open TCP socket. fetch's (undici's) client sockets to the test server are
 * still closing right after server.close(); if the process ends at that moment, Node on Windows can abort in libuv
 * ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c"). A socket still open after `ms` is a
 * leak: fail. The count is process-wide, so call it once every test server of the file is closed (in `after`).
 */
export async function drainSockets(ms = 3000): Promise<void> {
  const open = (): number => process.getActiveResourcesInfo().filter((r) => r === "TCPSocketWrap").length;
  const end = Date.now() + ms;
  while (open() > 0) {
    if (Date.now() > end) throw new Error(`${open()} TCP socket(s) still open ${ms} ms after the test server closed`);
    await wait(10);
  }
}

export async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
}
