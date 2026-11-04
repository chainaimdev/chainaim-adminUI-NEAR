/**
 * Road `backfill`: on start, read every final height from the furthest stored cursor (any road) to the start-up tip,
 * so a restart misses nothing; transfers the live roads already recorded are dropped as repeats (first road wins).
 * The live roads then start at tip + 1. A gap larger than --backfill-max-blocks is cut to the newest blocks, with
 * alert backfill_truncated.
 *
 * Source: QuickNode RPC (archival) when configured, else the public RPC, else neardata (--backfill-source auto).
 */
import type { Bus } from "./events.ts";
import { BlockLoop, type BlockResult, type LoopOptions } from "./feeds/adapter.ts";
import { NeardataClient, offerNeardataBlock } from "./feeds/neardata.ts";
import { rpcHeight } from "./feeds/rpc-poll.ts";
import type { Roads } from "./roads.ts";
import type { Rpc } from "./rpc.ts";
import type { Store } from "./store.ts";
import { TxStatus } from "./tx-status.ts";

export type BackfillSource = { kind: "rpc"; rpc: Rpc; txStatusTimeoutMs: number } | { kind: "neardata"; client: NeardataClient; timeoutMs: number };

/** Where backfill starts and ends, or null when there is nothing to do. */
export function backfillRange(store: Store, network: string, tip: number, maxBlocks: number): { from: number; to: number; truncated: number } | null {
  const cursor = store.maxCursor(network);
  if (cursor === undefined || cursor >= tip) return null;
  let from = cursor + 1;
  let truncated = 0;
  if (tip - from + 1 > maxBlocks) {
    truncated = tip - from + 1 - maxBlocks;
    from = tip - maxBlocks + 1;
  }
  return { from, to: tip, truncated };
}

export class Backfill extends BlockLoop {
  private readonly src: BackfillSource;
  private readonly contract: string;
  private readonly txs: TxStatus | null;

  constructor(opts: LoopOptions & { contract: string }, src: BackfillSource, roads: Roads, store: Store, bus: Bus) {
    super(opts, roads, store, bus);
    this.src = src;
    this.contract = opts.contract;
    this.txs = src.kind === "rpc" ? new TxStatus(src.rpc, src.txStatusTimeoutMs) : null;
  }

  protected async tip(): Promise<number> {
    return this.opts.endHeight ?? this.next;
  }

  protected async height(h: number): Promise<BlockResult> {
    const { network } = this.opts;
    if (this.src.kind === "rpc") return rpcHeight(this.src.rpc, this.txs as TxStatus, h, this.opts.endHeight ?? h, network, this.contract, this.roads, "backfill");
    return offerNeardataBlock(await this.src.client.block(h, this.src.timeoutMs), network, this.contract, this.roads, "backfill");
  }
}
