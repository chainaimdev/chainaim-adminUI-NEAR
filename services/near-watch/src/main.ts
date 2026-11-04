/**
 * near-watch: start-up and wiring (ported from liveops ledger-watch src/main.ts). `startApp` is what the tests
 * drive; running this file directly reads the flags and process.env.
 *
 *   node --env-file=<secrets env> src/main.ts [flags]   (see --help)
 */
import { readFileSync } from "node:fs";
import { redactUrl } from "../../../packages/chain-core/src/redact.ts";
import { Backfill, backfillRange, type BackfillSource } from "./backfill.ts";
import { BalanceWatch } from "./balances.ts";
import { ConfigError, loadConfig, SETTLE_GRACE_DEFAULT, USAGE, type Config } from "./config.ts";
import { graceReport } from "./reconcile.ts";
import { isEntry } from "./entry.ts";
import { Bus, type ProviderState } from "./events.ts";
import { ADAPTERS, ADAPTER_IDS, type BlockLoop } from "./feeds/adapter.ts";
import { NeardataClient, NeardataRoad } from "./feeds/neardata.ts";
import { quicknodeRoad } from "./feeds/quicknode-rpc.ts";
import { rpcFinalHeight, RpcPollRoad } from "./feeds/rpc-poll.ts";
import { Links } from "./links.ts";
import { LiveOps } from "./liveops.ts";
import { Roads } from "./roads.ts";
import { httpRpc, RpcPool, viewFunction, type Rpc } from "./rpc.ts";
import { SellerBook } from "./seller.ts";
import { WatchServer } from "./server.ts";
import { Store, type Road } from "./store.ts";
import { buildWatchlist, type WatchEntry } from "./watchlist.ts";

export type App = {
  config: Config;
  store: Store;
  bus: Bus;
  roads: Roads;
  loops: Map<Road, BlockLoop>;
  backfill: Backfill | null;
  links: Links;
  liveOps: LiveOps;
  seller: SellerBook;
  balances: BalanceWatch;
  server: WatchServer;
  port: number;
  watchlist: WatchEntry[];
  decimals: number;
  feedsReport(): Record<string, unknown>;
  stop(): Promise<void>;
};

export type AppDeps = { log?: (line: string) => void; fetchImpl?: typeof fetch };

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const RANK: Record<ProviderState, number> = { live: 0, stale: 1, connecting: 2, down: 3 };

/** The token's decimals from ft_metadata, cross-checked against the configured value (DESIGN private-ai §5.1). */
async function tokenDecimals(pool: RpcPool, contract: string, configured: number | null): Promise<{ decimals: number; symbol: string }> {
  try {
    const m = await viewFunction<{ decimals?: unknown; symbol?: unknown }>(pool, contract, "ft_metadata", {});
    if (typeof m.decimals !== "number") throw new Error("ft_metadata has no decimals");
    if (configured !== null && configured !== m.decimals) throw new ConfigError(`--decimals ${configured} disagrees with ${contract} ft_metadata decimals ${m.decimals}`);
    return { decimals: m.decimals, symbol: typeof m.symbol === "string" ? m.symbol : "USDC" };
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    if (configured !== null) return { decimals: configured, symbol: "USDC" };
    throw new ConfigError(`could not read ft_metadata of ${contract} (${(e as Error).message}); set --decimals or NEAR_USDC_DECIMALS_<NET> to start without it`);
  }
}

export async function startApp(config: Config, deps: AppDeps = {}): Promise<App> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const network = config.network;
  const { entries: watchlist, warnings } = buildWatchlist(network, config.payTo, config.watch);
  for (const w of warnings) log(`warning: ${w}`);
  if (watchlist.length === 0) throw new ConfigError(`nothing to watch: set ${config.envNames.payTo} or pass --watch label=role=account`);
  if (!watchlist.some((w) => w.role === "payto")) log(`warning: no pay-to watched (${config.envNames.payTo} unset): nothing will count as an x402 payment`);
  for (const s of config.skipped) log(`road ${s.road} skipped: ${s.reason}`);

  // RPC endpoints, QuickNode first. Used by balances, ft_metadata, the RPC roads and backfill.
  const rpcs: Rpc[] = [];
  if (config.quicknodeUrl) rpcs.push(httpRpc("quicknode", config.quicknodeUrl, { timeoutMs: config.requestTimeoutMs, fetchImpl: deps.fetchImpl }));
  if (config.rpcFallbackUrl) rpcs.push(httpRpc("near-rpc", config.rpcFallbackUrl, { timeoutMs: config.requestTimeoutMs, fetchImpl: deps.fetchImpl }));
  const pool = new RpcPool(rpcs);
  const neardata = new NeardataClient(config.neardataUrl, config.neardataApiKey, deps.fetchImpl);
  const token = pool.size ? await tokenDecimals(pool, config.usdcContract, config.decimals) : config.decimals !== null ? { decimals: config.decimals, symbol: "USDC" } : null;
  if (!token) throw new ConfigError("no RPC endpoint to read ft_metadata: set --decimals, or configure QuickNode / --rpc-fallback-url");

  const watched = new Map([[network, new Set(watchlist.map((w) => w.address))]]);
  const payTo = new Map([[network, new Set(watchlist.filter((w) => w.role === "payto").map((w) => w.address))]]);
  const store = new Store(config.store, { payTo });
  const bus = new Bus();
  const roads = new Roads(store, bus, { usdcContract: config.usdcContract, decimals: token.decimals, watched, payTo });
  const links = new Links(config.explorer);

  // The start-up tip: from the first road that answers.
  let startTip: number | null = null;
  for (const get of [() => neardata.finalHeight(config.requestTimeoutMs), ...rpcs.map((r) => () => rpcFinalHeight(r))]) {
    try {
      startTip = await get();
      break;
    } catch (e) {
      log(`start-up tip: ${(e as Error).message}`);
    }
  }
  if (startTip === null) {
    store.close();
    throw new Error("no road answered for the final tip (neardata and every RPC endpoint failed)");
  }

  const loopBase = { network, pollSec: config.pollSec, staleSec: config.staleSec, resetBlocks: config.resetBlocks, backoffMaxSec: config.backoffMaxSec, endHeight: null };
  /** Without backfill a live road resumes from its own cursor when it is close enough, else from the tip. */
  const startFor = (road: Road): number => {
    if (config.backfill) return (startTip as number) + 1;
    const c = store.getCursor(network, road);
    return c !== undefined && (startTip as number) - c <= config.backfillMaxBlocks ? c + 1 : (startTip as number) + 1;
  };
  const loops = new Map<Road, BlockLoop>();
  for (const r of config.feeds) {
    if (r === "neardata") {
      loops.set(
        r,
        new NeardataRoad(
          { ...loopBase, road: r, provider: "fastnear", startHeight: startFor(r), minIntervalMs: config.neardataMinMs, baseUrl: config.neardataUrl, apiKey: config.neardataApiKey, longPollMs: config.longPollMs, requestTimeoutMs: config.requestTimeoutMs, contract: config.usdcContract, fetchImpl: deps.fetchImpl },
          roads,
          store,
          bus,
        ),
      );
    } else if (r === "qn-rpc") {
      loops.set(r, quicknodeRoad({ ...loopBase, road: r, provider: "quicknode", startHeight: startFor(r), minIntervalMs: config.rpcMinMs, prefetch: config.rpcPrefetch, contract: config.usdcContract, txStatusTimeoutMs: config.txStatusTimeoutMs }, config.quicknodeUrl as string, config.requestTimeoutMs, roads, store, bus, deps.fetchImpl));
    } else {
      const rpc = httpRpc("near-rpc", config.rpcFallbackUrl as string, { timeoutMs: config.requestTimeoutMs, fetchImpl: deps.fetchImpl });
      loops.set(r, new RpcPollRoad({ ...loopBase, road: r, provider: "near-rpc", startHeight: startFor(r), minIntervalMs: config.rpcMinMs, prefetch: config.rpcPrefetch, contract: config.usdcContract, txStatusTimeoutMs: config.txStatusTimeoutMs }, rpc, roads, store, bus));
    }
  }

  let backfill: Backfill | null = null;
  let backfillInfo: { from: number; to: number; truncated: number; source: string } | null = null;
  if (config.backfill) {
    const range = backfillRange(store, network, startTip, config.backfillMaxBlocks);
    if (range) {
      const want = config.backfillSource;
      const qn = rpcs.find((r) => r.name === "quicknode");
      const pub = rpcs.find((r) => r.name === "near-rpc");
      const src: { s: BackfillSource; name: string } =
        (want === "qn-rpc" || want === "auto") && qn
          ? { s: { kind: "rpc", rpc: qn, txStatusTimeoutMs: config.txStatusTimeoutMs }, name: "quicknode" }
          : (want === "rpc" || want === "auto") && pub
            ? { s: { kind: "rpc", rpc: pub, txStatusTimeoutMs: config.txStatusTimeoutMs }, name: "near-rpc" }
            : { s: { kind: "neardata", client: neardata, timeoutMs: config.requestTimeoutMs }, name: "fastnear" };
      backfill = new Backfill({ ...loopBase, road: "backfill", provider: src.name, startHeight: range.from, endHeight: range.to, minIntervalMs: src.name === "fastnear" ? config.neardataMinMs : config.rpcMinMs, contract: config.usdcContract }, src.s, roads, store, bus);
      backfillInfo = { ...range, source: src.name };
      if (range.truncated > 0) bus.alert("warn", "backfill_truncated", `backfill limited to the newest ${config.backfillMaxBlocks} blocks; ${range.truncated} older blocks since the cursor were not read`, network);
    }
  }

  const feedsReport = (): Record<string, unknown> => {
    const now = Date.now();
    const all = [...loops.values(), ...(backfill ? [backfill] : [])];
    return {
      networks: {
        [network]: {
          selected: config.feeds,
          skipped: config.skipped,
          adapters: ADAPTER_IDS.map((id) => ({ ...ADAPTERS[id], selected: id === "backfill" ? config.backfill : (config.feeds as string[]).includes(id), available: ADAPTERS[id].built && !config.skipped.some((s) => s.road === id), reason: !ADAPTERS[id].built ? ADAPTERS[id].description : (config.skipped.find((s) => s.road === id)?.reason ?? null) })),
          roads: all.map((l) => ({ ...l.status(now), host: l.road === "neardata" ? redactUrl(config.neardataUrl) : l.road === "qn-rpc" ? redactUrl(config.quicknodeUrl ?? "") : l.road === "rpc" ? redactUrl(config.rpcFallbackUrl ?? "") : null, done: l.done })),
          stats: store.roadStats(network),
          lags: store.roadLags(network),
          backfill: backfillInfo ? { ...backfillInfo, done: backfill?.done ?? false, at: backfill?.next ?? null } : null,
          explorer: config.explorer.bases[network] ?? null,
          token: { contract: config.usdcContract, decimals: token.decimals, symbol: token.symbol },
          caip2: config.caip2,
          reconcile: graceReport(config.settleGraceBlocks, SETTLE_GRACE_DEFAULT, bus.ledgers.get(network) ?? [], now),
          rpcPrefetch: config.rpcMinMs > 0 ? 1 : config.rpcPrefetch,
        },
      },
    };
  };

  // Network status for the console header, recomputed every few seconds and after each block.
  let failovers = 0;
  let lastProvider = "";
  const emitStatus = (): void => {
    const now = Date.now();
    const statuses = [...loops.values()].map((l) => l.status(now));
    const best = [...statuses].sort((a, b) => RANK[a.state] - RANK[b.state] || (b.lastBlock ?? 0) - (a.lastBlock ?? 0))[0];
    const tipBlock = Math.max(0, ...statuses.map((s) => s.lastBlock ?? 0));
    const provider = best?.road ?? "none";
    if (lastProvider && provider !== lastProvider) failovers += 1;
    lastProvider = provider;
    const host = provider === "neardata" ? redactUrl(config.neardataUrl) : provider === "qn-rpc" ? redactUrl(config.quicknodeUrl ?? "") : redactUrl(config.rpcFallbackUrl ?? "");
    const ages = statuses.map((s) => s.lastBlockAgeMs).filter((x): x is number => x !== null);
    bus.emit("status", {
      network,
      provider,
      providerUrl: host,
      state: best?.state ?? "down",
      lastLedger: tipBlock || null,
      lastLedgerAgeMs: ages.length ? Math.min(...ages) : null,
      roads: store.roadStats(network),
      feeds: [...statuses, ...(backfill ? [backfill.status(now)] : [])],
      failovers,
      at: now,
    });
  };

  const balances = new BalanceWatch(watchlist, pool, bus, { contract: config.usdcContract, code: token.symbol, decimals: token.decimals, callPriceUnits: config.callPriceUnits, everySec: config.balancesSec, onTxDebounceMs: 1500 });
  const liveOps = new LiveOps(store, bus, {
    networks: [network],
    caips: { [config.caip2]: network },
    watchlist,
    graceBlocks: config.settleGraceBlocks,
    lowCalls: config.lowCalls,
    reconcileSec: config.reconcileSec,
    reconcileBatch: config.reconcileBatch,
    metricsWindowSec: config.metricsWindowSec,
    alertEverySec: config.alertEverySec,
    paywallLogFile: config.paywallLogFile,
    paywallLogPollMs: config.paywallLogPollMs,
  });
  const seller = new SellerBook(store, bus, {
    networks: [network],
    watchlist,
    contract: config.usdcContract,
    code: token.symbol,
    decimals: token.decimals,
    callPriceUnits: config.callPriceUnits,
    estimate: config.inflightEstimate,
    expireSec: config.inflightExpireSec,
    recent: config.sellerRecent,
    debounceMs: config.sellerDebounceMs,
    windowSec: config.metricsWindowSec,
  });
  const server = new WatchServer(
    {
      adminKey: config.adminKey,
      networks: [network],
      watchlist,
      sseReplay: config.sseReplay,
      sseHeartbeatSec: config.sseHeartbeatSec,
      sseMaxClients: config.sseMaxClients,
      version: VERSION,
      startedAt: Date.now(),
      ingestKey: config.ingestKey,
      ingestMaxBytes: config.ingestMaxBytes,
      links,
      feeds: feedsReport,
      token: { contract: config.usdcContract, symbol: token.symbol, decimals: token.decimals },
    },
    store,
    bus,
    roads,
    liveOps,
    seller,
  );
  const address = await server.listen(config.port, config.bind);
  bus.on((name, data) => {
    if (name === "alert") {
      const a = data as { level: string; code: string; message: string; network?: string };
      log(`${a.level} ${a.code}${a.network ? ` [${a.network}]` : ""}: ${a.message}`);
    }
  });
  const statusTimer = setInterval(emitStatus, 2000);
  statusTimer.unref();
  seller.start();
  for (const l of loops.values()) l.start();
  backfill?.start();
  balances.start();
  liveOps.start();
  emitStatus();

  log(`${network}: token ${config.usdcContract} (${token.symbol}, ${token.decimals} decimals); CAIP-2 ${config.caip2}; start-up tip ${startTip}`);
  log(`roads: ${[...loops.values()].map((l) => `${l.road} from ${l.next}`).join(", ")}; backfill ${backfillInfo ? `${backfillInfo.from}..${backfillInfo.to} via ${backfillInfo.source}` : config.backfill ? "nothing to do" : "off"}`);
  log(`endpoints: neardata ${redactUrl(config.neardataUrl)}${config.neardataApiKey ? " (api key set)" : ""}; rpc ${rpcs.map((r) => `${r.name} ${r.host}`).join(" -> ") || "none"}`);
  log(`live ops: claims via ${config.ingestKey ? `POST /ingest (key from ${config.envNames.ingestKey})` : `no HTTP (${config.envNames.ingestKey} unset)`}${config.paywallLogFile ? ` + file ${config.paywallLogFile}` : ""}; grace ${config.settleGraceBlocks} final blocks`);
  log(`near-watch ${VERSION} listening on http://${address.address}:${address.port} (key from ${config.envNames.adminKey}); store ${config.store}; watching ${watchlist.map((w) => `${w.label}/${w.role}=${w.address}`).join(", ")}`);

  let stopped = false;
  return {
    config,
    store,
    bus,
    roads,
    loops,
    backfill,
    links,
    liveOps,
    seller,
    balances,
    server,
    port: address.port,
    watchlist,
    decimals: token.decimals,
    feedsReport,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(statusTimer);
      balances.stop();
      seller.stop();
      liveOps.stop();
      await Promise.all([...loops.values(), ...(backfill ? [backfill] : [])].map((l) => l.stop()));
      await server.close();
      store.close();
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  let app: App;
  try {
    app = await startApp(loadConfig(argv, process.env));
  } catch (e) {
    process.stderr.write(`near-watch: ${(e as Error).message}\n`);
    process.exit(e instanceof ConfigError ? 2 : 1);
  }
  const shutdown = (signal: string): void => {
    process.stdout.write(`near-watch: ${signal}, stopping\n`);
    app.stop().then(
      () => process.exit(0),
      (e: Error) => {
        process.stderr.write(`near-watch: stop failed: ${e.message}\n`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (isEntry(import.meta.url)) void main();
