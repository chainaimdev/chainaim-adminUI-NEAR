/**
 * Road `neardata` (FastNear neardata; GATE A1, docs/NEAR-GATES.md). Verified from github.com/fastnear/neardata-server:
 *   GET /v0/block/<h>         the finalized block as one JSON (incl. receipt outcomes with tx_hash); `null` when the
 *                             height has no block; waits when the block is close to the final tip (long-poll); may
 *                             redirect (fetch follows)
 *   GET /v0/last_block/final  redirects to the latest finalized block
 *   limit 180 req/min/IP; `?apiKey=` raises it (never logged: the URL is redacted)
 */
import { scrub } from "../../../../packages/chain-core/src/redact.ts";
import { DecodeError, neardataBlock } from "../decode.ts";
import type { Bus } from "../events.ts";
import type { Roads } from "../roads.ts";
import type { Store } from "../store.ts";
import { BlockLoop, type BlockResult, type LoopOptions } from "./adapter.ts";

export type NeardataOptions = LoopOptions & { baseUrl: string; apiKey: string | null; longPollMs: number; requestTimeoutMs: number; contract: string; fetchImpl?: typeof fetch };

export class NeardataClient {
  private readonly base: string;
  private readonly apiKey: string | null;
  private readonly f: typeof fetch;
  constructor(baseUrl: string, apiKey: string | null, fetchImpl?: typeof fetch) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.f = fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.base}${path}${this.apiKey ? `?apiKey=${encodeURIComponent(this.apiKey)}` : ""}`;
  }

  /** A block JSON, or null for a height without a block. */
  async get(path: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.f(this.url(path), { signal: s, redirect: "follow", headers: { accept: "application/json" } });
    } catch (e) {
      throw new Error(`neardata ${path}: ${scrub((e as Error).message, [this.apiKey])}`);
    }
    if (res.status === 429) throw new Error(`neardata ${path}: rate limited (HTTP 429; set NEARDATA_API_KEY for a higher limit)`);
    if (!res.ok) throw new Error(`neardata ${path}: HTTP ${res.status}`);
    return (await res.json()) as unknown;
  }

  block(height: number, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    return this.get(`/v0/block/${height}`, timeoutMs, signal);
  }

  async finalHeight(timeoutMs: number, signal?: AbortSignal): Promise<number> {
    const b = (await this.get("/v0/last_block/final", timeoutMs, signal)) as { block?: { header?: { height?: unknown } } } | null;
    const h = b?.block?.header?.height;
    if (typeof h !== "number") throw new Error("neardata /v0/last_block/final: no block height");
    return h;
  }
}

/** Hand one neardata block's USDC outcomes to the store gate. */
export function offerNeardataBlock(raw: unknown, network: string, contract: string, roads: Roads, via: Parameters<Roads["offer"]>[2]): BlockResult {
  if (raw === null) return { kind: "skipped" };
  const { block, outcomes } = neardataBlock(raw, contract);
  for (const o of outcomes) roads.offer(network, o, via);
  return { kind: "block", height: block.height, timeMs: block.timeMs, txCount: block.txCount };
}

export class NeardataRoad extends BlockLoop {
  protected override readonly longPoll = true;
  readonly client: NeardataClient;
  private readonly nd: NeardataOptions;

  constructor(opts: NeardataOptions, roads: Roads, store: Store, bus: Bus) {
    super(opts, roads, store, bus);
    this.nd = opts;
    this.client = new NeardataClient(opts.baseUrl, opts.apiKey, opts.fetchImpl);
  }

  protected tip(signal: AbortSignal): Promise<number> {
    return this.client.finalHeight(this.nd.requestTimeoutMs, signal);
  }

  protected async height(h: number, atTip: boolean, signal: AbortSignal): Promise<BlockResult | "not_yet"> {
    const raw = await this.client.block(h, atTip ? this.nd.longPollMs : this.nd.requestTimeoutMs, signal);
    // At the tip, `null` can mean "not produced yet" rather than "skipped": only trust null below the known tip.
    if (raw === null && atTip) return "not_yet";
    try {
      return offerNeardataBlock(raw, this.opts.network, this.nd.contract, this.roads, this.opts.road);
    } catch (e) {
      if (e instanceof DecodeError) throw new Error(`block ${h}: ${e.message}`);
      throw e;
    }
  }
}
