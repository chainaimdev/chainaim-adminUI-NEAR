/**
 * Feed adapters (roads) and the block loop they share.
 *
 *   neardata   FastNear neardata: GET /v0/block/<height>, which waits for a block near the tip (long-poll, push-like)
 *   qn-rpc     QuickNode NEAR JSON-RPC: `block` + `chunk` per final height, then `EXPERIMENTAL_tx_status` per candidate
 *   rpc        the same against a public RPC (fallback)
 *   backfill   one pass from the stored cursor to the start-up tip (QuickNode archival when configured)
 *   qn-wss     listed, not built: no NEAR WebSocket subscription method is documented (DESIGN §3), QuickNode Streams
 *              for NEAR not confirmed
 *
 * Every road walks final heights in order, hands each block's USDC receipt outcomes to Roads.offer, and moves its
 * cursor forward only after a height is fully processed (cursor = last height done). A height with no block
 * (NEAR skips heights) counts as done. A tip far below the stored cursor (--reset-blocks) means the network was
 * reset: the road stops with alert network_reset, as in ledger-watch.
 */
import type { Bus, ProviderState, RoadStatus } from "../events.ts";
import type { Roads } from "../roads.ts";
import type { Road, Store } from "../store.ts";

export const ADAPTER_IDS = ["neardata", "qn-rpc", "rpc", "backfill", "qn-wss"] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];
export type AdapterInfo = { id: AdapterId; kind: "push" | "poll" | "once"; provider: string; built: boolean; description: string };

export const ADAPTERS: Record<AdapterId, AdapterInfo> = {
  neardata: { id: "neardata", kind: "push", provider: "fastnear", built: true, description: "neardata long-poll by height (final blocks, one JSON per block)" },
  "qn-rpc": { id: "qn-rpc", kind: "poll", provider: "quicknode", built: true, description: "QuickNode NEAR JSON-RPC: block + chunk every --poll-sec" },
  rpc: { id: "rpc", kind: "poll", provider: "near-rpc", built: true, description: "public NEAR JSON-RPC fallback (same method as qn-rpc)" },
  backfill: { id: "backfill", kind: "once", provider: "quicknode|near-rpc|fastnear", built: true, description: "stored cursor -> start-up tip, once per start" },
  "qn-wss": { id: "qn-wss", kind: "push", provider: "quicknode", built: false, description: "not built: no NEAR WebSocket subscription is documented; QuickNode Streams for NEAR not confirmed" },
};

export type BlockResult = { kind: "block"; height: number; timeMs: number | null; txCount: number | null } | { kind: "skipped" };

export type LoopOptions = {
  network: string;
  road: Road;
  provider: string;
  startHeight: number;
  /** Stop after this height (backfill); null = run forever. */
  endHeight: number | null;
  pollSec: number;
  staleSec: number;
  resetBlocks: number;
  backoffMaxSec: number;
  /** Least time between two block requests (rate limits). */
  minIntervalMs: number;
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** The loop every road runs; subclasses say how to read the final tip and one height. */
export abstract class BlockLoop {
  state: ProviderState = "connecting";
  lastBlock: number | null = null;
  lastBlockAt: number | null = null;
  tipSeen: number | null = null;
  errors = 0;
  reset = false;
  done = false;
  next: number;
  readonly opts: LoopOptions;
  protected readonly roads: Roads;
  protected readonly store: Store;
  protected readonly bus: Bus;
  private abort = new AbortController();
  private running: Promise<void> | null = null;
  private lastRequest = 0;

  constructor(opts: LoopOptions, roads: Roads, store: Store, bus: Bus) {
    this.opts = opts;
    this.roads = roads;
    this.store = store;
    this.bus = bus;
    this.next = opts.startHeight;
  }

  /** The newest final height the provider knows. */
  protected abstract tip(signal: AbortSignal): Promise<number>;
  /** Read one final height and hand its outcomes to Roads.offer. `atTip` = the height is just past the known tip. */
  protected abstract height(h: number, atTip: boolean, signal: AbortSignal): Promise<BlockResult | "not_yet">;
  /** Whether the road may ask for tip+1 (long-poll) instead of waiting for the tip to move. */
  protected readonly longPoll: boolean = false;

  get road(): Road {
    return this.opts.road;
  }

  status(now = Date.now()): RoadStatus {
    let state = this.state;
    if (state === "live" && this.lastBlockAt !== null && now - this.lastBlockAt > this.opts.staleSec * 1000) state = "stale";
    return {
      road: this.opts.road,
      state,
      provider: this.opts.provider,
      lastBlock: this.lastBlock,
      lastBlockAgeMs: this.lastBlockAt === null ? null : now - this.lastBlockAt,
      lagBlocks: this.tipSeen !== null && this.lastBlock !== null ? Math.max(0, this.tipSeen - this.lastBlock) : null,
      errors: this.errors,
      reset: this.reset,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = this.loop().catch((e: unknown) => {
      this.state = "down";
      this.bus.alert("error", "feed_crashed", `${this.opts.road}: ${(e as Error).message}`, this.opts.network);
    });
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.running;
    this.running = null;
  }

  /** Wait until the loop has ended (backfill). */
  finished(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async pace(signal: AbortSignal): Promise<void> {
    const wait = this.lastRequest + this.opts.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait, signal);
    this.lastRequest = Date.now();
  }

  private async loop(): Promise<void> {
    const signal = this.abort.signal;
    const { network, road } = this.opts;
    let backoff = 1;
    let tip: number | null = null;
    while (!signal.aborted) {
      if (this.opts.endHeight !== null && this.next > this.opts.endHeight) {
        this.done = true;
        this.state = "live";
        return;
      }
      try {
        if (tip === null || this.next > tip + (this.longPoll ? 1 : 0)) {
          await this.pace(signal);
          tip = await this.tip(signal);
          this.tipSeen = tip;
          const cursor = this.store.getCursor(network, road);
          if (cursor !== undefined && tip < cursor - this.opts.resetBlocks) {
            this.reset = true;
            this.state = "down";
            this.bus.alert("error", "network_reset", `${road}: final tip ${tip} is ${cursor - tip} blocks below the stored cursor ${cursor} (more than --reset-blocks ${this.opts.resetBlocks}); road stopped`, network);
            return;
          }
          if (this.next > tip + (this.longPoll ? 1 : 0)) {
            if (this.state === "connecting") this.state = "live";
            await sleep(this.opts.pollSec * 1000, signal);
            continue;
          }
        }
        await this.pace(signal);
        const r = await this.height(this.next, this.next > tip, signal);
        if (r === "not_yet") {
          tip = null; // re-read the tip: a height past it is trusted as skipped only once the tip has moved beyond it
          continue;
        }
        if (r.kind === "block") {
          this.roads.blockFinal(network, r.height, r.timeMs, r.txCount, road);
          this.lastBlock = r.height;
          this.lastBlockAt = Date.now();
          if (r.height > (tip ?? 0)) tip = r.height;
        }
        this.store.setCursor(network, road, this.next);
        this.next += 1;
        if (this.state !== "live") {
          if (this.errors > 0) this.bus.alert("info", "feed_live", `${road}: delivering final blocks again at ${this.next - 1}`, network);
          this.state = "live";
        }
        backoff = 1;
      } catch (e) {
        if (signal.aborted) return;
        this.errors += 1;
        const was = this.state;
        this.state = "down";
        if (was !== "down") this.bus.alert("warn", "feed_down", `${road}: ${(e as Error).message}`, network);
        await sleep(backoff * 1000, signal);
        backoff = Math.min(this.opts.backoffMaxSec, backoff * 2);
        tip = null;
      }
    }
  }
}
