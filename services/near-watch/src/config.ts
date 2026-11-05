/**
 * near-watch configuration: CLI flags with safe defaults, secrets and chain values from env only (DESIGN §0, §6.1).
 * Nothing unknown is defaulted: the USDC contract is a required env var and start-up fails with a clear message when
 * it is missing. The NEAR CAIP-2 id defaults to near:testnet / near:mainnet, the only two ids @x402/near accepts and so
 * the only values the paywall can write (docs/NEAR-GATES.md A5, chainiam-private-ai NEAR-GATES G4); NEAR_CAIP2_<NET>
 * stays as an optional override. Token-bearing URLs (QuickNode, neardata ?apiKey) are only ever shown
 * redacted.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCaip2 } from "../../../packages/chain-core/src/caip.ts";
import { isUnits } from "../../../packages/chain-core/src/money.ts";
import { isAccountId } from "../../../packages/chain-core/src/near.ts";
import { redactUrl } from "../../../packages/chain-core/src/redact.ts";
import type { ExplorerConfig } from "./links.ts";

export class ConfigError extends Error {}

export const NETWORKS = ["testnet", "mainnet"] as const;

/** --settle-grace-blocks default: final blocks a lone claim or transfer waits before it is a gap (reconcile.ts). */
export const SETTLE_GRACE_DEFAULT = 30;

/**
 * CAIP-2 id per network: the x402 NEAR exact scheme's ids, the only two `@x402/near` accepts (its NEAR_NETWORKS), and
 * what the paywall writes in payment_settled.network (chainiam-private-ai services/paywall/src/config.ts NEAR_NETWORKS;
 * its docs/NEAR-GATES.md G4). docs/NEAR-GATES.md A5.
 */
export const NEAR_CAIP2_DEFAULT: Readonly<Record<(typeof NETWORKS)[number], string>> = { testnet: "near:testnet", mainnet: "near:mainnet" };
export type NetworkName = (typeof NETWORKS)[number];
export const LIVE_ROADS = ["neardata", "qn-rpc", "rpc"] as const;
export type LiveRoad = (typeof LIVE_ROADS)[number];

/** GATE A1: neardata hosts (github.com/fastnear/neardata-server README). */
export const NEARDATA_DEFAULT: Record<NetworkName, string> = { testnet: "https://testnet.neardata.xyz", mainnet: "https://mainnet.neardata.xyz" };
/** GATE A6: NearBlocks (routes from the NearBlocks frontend source). */
export const EXPLORER_DEFAULT: Record<NetworkName, string> = { testnet: "https://testnet.nearblocks.io", mainnet: "https://nearblocks.io" };

export type Config = {
  network: NetworkName;
  caip2: string;
  usdcContract: string;
  /** From --decimals / NEAR_USDC_DECIMALS_<NET>, cross-checked against ft_metadata at start-up; null = read it. */
  decimals: number | null;
  feeds: LiveRoad[];
  /** Roads left out of a default --feeds list because they are not configured, with why. */
  skipped: { road: LiveRoad; reason: string }[];
  quicknodeUrl: string | null;
  rpcFallbackUrl: string | null;
  neardataUrl: string;
  neardataApiKey: string | null;
  pollSec: number;
  backfill: boolean;
  backfillMaxBlocks: number;
  backfillSource: "auto" | "qn-rpc" | "rpc" | "neardata";
  settleGraceBlocks: number;
  resetBlocks: number;
  bind: string;
  port: number;
  store: string;
  watch: string[];
  payTo: string | null;
  adminKey: string;
  ingestKey: string | null;
  explorer: ExplorerConfig;
  callPriceUnits: string | null;
  lowCalls: number;
  /** ARCH-209: NEAR one x402 payment costs the relayer (decimal string); required when a relayer is watched, else null. */
  gasPerPaymentNear: string | null;
  /** ARCH-209: low_gas when the relayer's NEAR covers fewer payments than this. */
  relayerMinPayments: number;
  reconcileSec: number;
  reconcileBatch: number;
  metricsWindowSec: number;
  alertEverySec: number;
  paywallLogFile: string | null;
  paywallLogPollMs: number;
  balancesSec: number;
  staleSec: number;
  requestTimeoutMs: number;
  txStatusTimeoutMs: number;
  longPollMs: number;
  neardataMinMs: number;
  rpcMinMs: number;
  /** RPC roads: heights read ahead at once (block + chunk calls); 1 = serial. */
  rpcPrefetch: number;
  backoffMaxSec: number;
  sseReplay: number;
  sseHeartbeatSec: number;
  sseMaxClients: number;
  ingestMaxBytes: number;
  inflightExpireSec: number;
  inflightEstimate: boolean;
  sellerRecent: number;
  sellerDebounceMs: number;
  envNames: { adminKey: string; ingestKey: string; quicknode: string; usdc: string; caip2: string; payTo: string; neardataKey: string };
};

const SERVICE_DIR = fileURLToPath(new URL("..", import.meta.url));

export const USAGE = `near-watch: NEAR USDC payments to the paywall, from the chain (neardata / QuickNode RPC / public RPC) and from the
paywall's claims, reconciled. Run: node --env-file=<secrets env> src/main.ts [flags]

  --network testnet|mainnet           (testnet)
  --feeds neardata,qn-rpc,rpc         live roads (default: all three; unconfigured ones are skipped and reported)
  --quicknode-http-env NAME           env var holding the QuickNode NEAR HTTPS URL (QUICKNODE_NEAR_HTTP_<NET>)
  --rpc-fallback-url URL              public RPC for road rpc (or env NEAR_RPC_FALLBACK_URL_<NET>)
  --neardata-url URL                  (testnet https://testnet.neardata.xyz)
  --neardata-api-key-env NAME         optional (NEARDATA_API_KEY)
  --poll-sec N                        RPC roads: seconds between tip checks (2)
  --backfill on|off                   stored cursor -> tip on start (on)
  --backfill-max-blocks N             (1200)     --backfill-source auto|qn-rpc|rpc|neardata (auto)
  --settle-grace-blocks N             final blocks before only_in_log / only_on_ledger (30)
  --reset-blocks N                    tip this far below the cursor = network reset (100000)
  --bind HOST --port N                (127.0.0.1, 8790)
  --store PATH                        (../../data/near-watch/watch.sqlite from the service folder)
  --watch label=role=account          repeatable; role payto|buyer|relayer|other
  --ingest-key-env NAME               (NEAR_WATCH_INGEST_KEY; unset = /ingest off)
  --admin-key-env NAME                (ADMIN_API_KEY)
  --usdc-contract-env NAME            (NEAR_USDC_CONTRACT_<NET>, required)
  --caip2-env NAME                    (NEAR_CAIP2_<NET>, optional override; default near:testnet / near:mainnet, as @x402/near)
  --decimals N                        cross-check for ft_metadata (or env NEAR_USDC_DECIMALS_<NET>)
  --explorer <base>|none              (testnet https://testnet.nearblocks.io)
  --explorer-tx-path P                (/txns/{hash})   --explorer-account-path P (/address/{address})
  --call-price UNITS                  one paid call in USDC base units (env NEAR_CALL_PRICE_UNITS; unset = no estimate)
  --low-calls N                       buyer low-balance alert, in calls (3; 0 = off)
  --gas-per-payment-near D            NEAR one x402 payment costs the relayer (required with a relayer=relayer=... watch)
  --relayer-min-payments N            low_gas alert below this many payments of relayer gas (500)
  --paywall-log-file PATH             tail the paywall's PAYMENT_LOG_FILE for claims
  --reconcile-sec N (5)  --metrics-window-sec N (3600)  --balances-sec N (30)  --stale-sec N (30)
  --request-timeout-ms N (15000)  --long-poll-ms N (30000)  --neardata-min-ms N (450)  --rpc-min-ms N (0)
  --rpc-prefetch N                    RPC roads: heights read at once (4; 1 = serial; forced to 1 when --rpc-min-ms > 0)`;

type Flags = Map<string, string[]>;

function parseArgv(argv: readonly string[]): Flags {
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new ConfigError(`unexpected argument ${a} (see --help)`);
    let name = a.slice(2);
    let value: string;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new ConfigError(`--${name} needs a value`);
      i += 1;
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return flags;
}

const KNOWN = new Set(
  "network feeds quicknode-http-env rpc-fallback-url neardata-url neardata-api-key-env poll-sec backfill backfill-max-blocks backfill-source settle-grace-blocks reset-blocks bind port store watch ingest-key-env admin-key-env usdc-contract-env caip2-env decimals explorer explorer-tx-path explorer-account-path call-price low-calls reconcile-sec reconcile-batch metrics-window-sec alert-every-sec paywall-log-file paywall-log-poll-ms balances-sec stale-sec request-timeout-ms tx-status-timeout-ms long-poll-ms neardata-min-ms rpc-min-ms rpc-prefetch backoff-max-sec sse-replay sse-heartbeat-sec sse-max-clients ingest-max-bytes inflight-expire-sec inflight-estimate seller-recent seller-debounce-ms gas-per-payment-near relayer-min-payments".split(
    " ",
  ),
);

function httpsUrl(v: string, what: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`${what} is not a URL`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname))) throw new ConfigError(`${what} must be https (${redactUrl(v)})`);
  return v;
}

export function loadConfig(argv: readonly string[], env: Record<string, string | undefined>): Config {
  const flags = parseArgv(argv);
  for (const k of flags.keys()) if (!KNOWN.has(k)) throw new ConfigError(`unknown flag --${k} (see --help)`);
  const one = (k: string): string | undefined => {
    const v = flags.get(k);
    if (v && v.length > 1 && k !== "watch") throw new ConfigError(`--${k} given more than once`);
    return v?.[0];
  };
  const int = (k: string, def: number, min: number, max: number): number => {
    const raw = one(k);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`--${k} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const onOff = (k: string, def: boolean): boolean => {
    const raw = one(k);
    if (raw === undefined) return def;
    if (raw !== "on" && raw !== "off") throw new ConfigError(`--${k} must be on or off`);
    return raw === "on";
  };
  const network = (one("network") ?? "testnet") as NetworkName;
  if (!(NETWORKS as readonly string[]).includes(network)) throw new ConfigError(`--network must be one of ${NETWORKS.join(", ")}`);
  const NET = network.toUpperCase();
  const envNames = {
    adminKey: one("admin-key-env") ?? "ADMIN_API_KEY",
    ingestKey: one("ingest-key-env") ?? "NEAR_WATCH_INGEST_KEY",
    quicknode: one("quicknode-http-env") ?? `QUICKNODE_NEAR_HTTP_${NET}`,
    usdc: one("usdc-contract-env") ?? `NEAR_USDC_CONTRACT_${NET}`,
    caip2: one("caip2-env") ?? `NEAR_CAIP2_${NET}`,
    payTo: `NEAR_PAY_TO_${NET}`,
    neardataKey: one("neardata-api-key-env") ?? "NEARDATA_API_KEY",
  };
  const val = (name: string): string | null => {
    const v = env[name]?.trim();
    return v ? v : null;
  };

  const adminKey = val(envNames.adminKey);
  if (!adminKey) throw new ConfigError(`${envNames.adminKey} is not set (the console's admin key; 24+ characters)`);
  if (adminKey.length < 24) throw new ConfigError(`${envNames.adminKey} must be at least 24 characters`);
  const ingestKey = val(envNames.ingestKey);
  if (ingestKey !== null) {
    if (ingestKey.length < 24) throw new ConfigError(`${envNames.ingestKey} must be at least 24 characters`);
    if (ingestKey === adminKey) throw new ConfigError(`${envNames.ingestKey} must differ from ${envNames.adminKey}: a sender may add records, never read them`);
  }
  const usdcContract = val(envNames.usdc);
  if (!usdcContract) throw new ConfigError(`${envNames.usdc} is not set (the NEAR USDC contract id; see docs/NEAR-GATES.md A4)`);
  if (!isAccountId(usdcContract)) throw new ConfigError(`${envNames.usdc}=${usdcContract} is not a NEAR account id`);
  const caip2 = val(envNames.caip2) ?? NEAR_CAIP2_DEFAULT[network];
  if (!isCaip2(caip2) || !caip2.startsWith("near:")) throw new ConfigError(`${envNames.caip2}=${caip2} is not a near:<reference> CAIP-2 id`);
  const decRaw = one("decimals") ?? val(`NEAR_USDC_DECIMALS_${NET}`) ?? undefined;
  let decimals: number | null = null;
  if (decRaw !== undefined) {
    decimals = Number(decRaw);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 24) throw new ConfigError("--decimals must be 0-24");
  }

  // Roads.
  const quicknodeUrl = val(envNames.quicknode);
  if (quicknodeUrl) httpsUrl(quicknodeUrl, envNames.quicknode);
  const rpcFallbackUrl = one("rpc-fallback-url") ?? val(`NEAR_RPC_FALLBACK_URL_${NET}`);
  if (rpcFallbackUrl) httpsUrl(rpcFallbackUrl, "--rpc-fallback-url");
  const explicit = one("feeds");
  const requested = (explicit ?? LIVE_ROADS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const r of requested) {
    if (r === "qn-wss") throw new ConfigError("qn-wss is not built: no NEAR WebSocket subscription method is documented (DESIGN §3)");
    if (!(LIVE_ROADS as readonly string[]).includes(r)) throw new ConfigError(`--feeds: unknown road ${r} (roads: ${LIVE_ROADS.join(", ")})`);
  }
  const feeds: LiveRoad[] = [];
  const skipped: Config["skipped"] = [];
  for (const r of [...new Set(requested)] as LiveRoad[]) {
    const missing = r === "qn-rpc" && !quicknodeUrl ? `${envNames.quicknode} is not set` : r === "rpc" && !rpcFallbackUrl ? `--rpc-fallback-url / NEAR_RPC_FALLBACK_URL_${NET} is not set` : null;
    if (missing && explicit) throw new ConfigError(`--feeds ${r}: ${missing}`);
    if (missing) skipped.push({ road: r, reason: missing });
    else feeds.push(r);
  }
  if (feeds.length === 0) throw new ConfigError("no road can run: every road in --feeds is unconfigured");
  const neardataUrl = httpsUrl(one("neardata-url") ?? NEARDATA_DEFAULT[network], "--neardata-url");
  const backfillSource = (one("backfill-source") ?? "auto") as Config["backfillSource"];
  if (!["auto", "qn-rpc", "rpc", "neardata"].includes(backfillSource)) throw new ConfigError("--backfill-source must be auto, qn-rpc, rpc or neardata");
  if (backfillSource === "qn-rpc" && !quicknodeUrl) throw new ConfigError(`--backfill-source qn-rpc: ${envNames.quicknode} is not set`);
  if (backfillSource === "rpc" && !rpcFallbackUrl) throw new ConfigError("--backfill-source rpc: --rpc-fallback-url is not set");

  const explorerRaw = one("explorer") ?? EXPLORER_DEFAULT[network];
  const explorer: ExplorerConfig = {
    bases: explorerRaw === "none" ? {} : { [network]: httpsUrl(explorerRaw, "--explorer") },
    txPath: one("explorer-tx-path") ?? "/txns/{hash}",
    accountPath: one("explorer-account-path") ?? "/address/{address}",
  };
  if (!explorer.txPath.includes("{hash}")) throw new ConfigError("--explorer-tx-path must contain {hash}");
  if (!explorer.accountPath.includes("{address}")) throw new ConfigError("--explorer-account-path must contain {address}");

  const callPrice = one("call-price") ?? val("NEAR_CALL_PRICE_UNITS") ?? null;
  if (callPrice !== null && !isUnits(callPrice)) throw new ConfigError("--call-price must be an integer of USDC base units (0.01 USDC = 10000)");
  const sseHeartbeatSec = int("sse-heartbeat-sec", 15, 1, 300);
  // ARCH-209: a watched relayer needs the gas one payment costs, measured on chain (docs: architecture-adminui-jobs.md F11).
  const gasRaw = one("gas-per-payment-near") ?? null;
  if (gasRaw !== null && (!/^\d{1,6}(\.\d{1,24})?$/.test(gasRaw) || !/[1-9]/.test(gasRaw))) throw new ConfigError("--gas-per-payment-near must be a NEAR amount above 0 with at most 24 decimals (e.g. 0.000333)");
  const relayerWatched = (flags.get("watch") ?? []).some((s) => s.split("=")[1] === "relayer");
  if (relayerWatched && gasRaw === null) throw new ConfigError("--watch ...=relayer=... needs --gas-per-payment-near (NEAR one x402 payment costs the relayer, e.g. 0.000333)");

  return {
    network,
    caip2,
    usdcContract,
    decimals,
    feeds,
    skipped,
    quicknodeUrl,
    rpcFallbackUrl,
    neardataUrl,
    neardataApiKey: val(envNames.neardataKey),
    pollSec: int("poll-sec", 2, 1, 300),
    backfill: onOff("backfill", true),
    backfillMaxBlocks: int("backfill-max-blocks", 1200, 1, 10_000_000),
    backfillSource,
    settleGraceBlocks: int("settle-grace-blocks", SETTLE_GRACE_DEFAULT, 1, 1_000_000),
    resetBlocks: int("reset-blocks", 100_000, 1, 1_000_000_000),
    bind: one("bind") ?? "127.0.0.1",
    port: int("port", 8790, 0, 65535),
    store: resolve(one("store") ? process.cwd() : SERVICE_DIR, one("store") ?? "../../data/near-watch/watch.sqlite"),
    watch: flags.get("watch") ?? [],
    payTo: val(envNames.payTo),
    adminKey,
    ingestKey,
    explorer,
    callPriceUnits: callPrice === null ? null : BigInt(callPrice).toString(),
    lowCalls: int("low-calls", 3, 0, 1_000_000),
    gasPerPaymentNear: gasRaw,
    relayerMinPayments: int("relayer-min-payments", 500, 1, 100_000_000),
    reconcileSec: int("reconcile-sec", 5, 1, 3600),
    reconcileBatch: int("reconcile-batch", 200, 1, 100_000),
    metricsWindowSec: int("metrics-window-sec", 3600, 60, 30 * 86400),
    alertEverySec: int("alert-every-sec", 60, 1, 86400),
    paywallLogFile: one("paywall-log-file") ?? null,
    paywallLogPollMs: int("paywall-log-poll-ms", 1000, 100, 60_000),
    balancesSec: int("balances-sec", 30, 5, 3600),
    staleSec: int("stale-sec", 30, 5, 3600),
    requestTimeoutMs: int("request-timeout-ms", 15_000, 1000, 120_000),
    txStatusTimeoutMs: int("tx-status-timeout-ms", 30_000, 1000, 120_000),
    longPollMs: int("long-poll-ms", 30_000, 1000, 120_000),
    neardataMinMs: int("neardata-min-ms", 450, 0, 60_000), // 133 req/min: under the public 180/min with room for tip checks
    rpcMinMs: int("rpc-min-ms", 0, 0, 60_000),
    // Testnet 2026-11-04: ~770-970 ms of serial calls a height vs a final block every ~580 ms (rpc-poll.ts).
    rpcPrefetch: int("rpc-prefetch", 4, 1, 32),
    backoffMaxSec: int("backoff-max-sec", 30, 1, 600),
    sseReplay: int("sse-replay", 200, 1, 1000),
    sseHeartbeatSec,
    sseMaxClients: int("sse-max-clients", 20, 1, 1000),
    ingestMaxBytes: int("ingest-max-bytes", 65_536, 1024, 1_048_576),
    inflightExpireSec: int("inflight-expire-sec", 300, 10, 86400),
    inflightEstimate: onOff("inflight-estimate", true),
    sellerRecent: int("seller-recent", 20, 1, 500),
    sellerDebounceMs: int("seller-debounce-ms", 250, 0, 60_000),
    envNames,
  };
}
