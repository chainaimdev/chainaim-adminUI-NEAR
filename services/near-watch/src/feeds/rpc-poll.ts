/**
 * Roads `qn-rpc` and `rpc`: walk final heights over NEAR JSON-RPC (docs.near.org/api/rpc/block-chunk).
 *   tip       `block` {finality: "final"}
 *   height h  `block` {block_id: h}  (UNKNOWN_BLOCK below the tip = a skipped height)
 *             `chunk` {chunk_id} for each chunk new in this block (height_included == h) with a non-empty tx_root
 *             (the empty Merkle root is 32 zero bytes = base58 "111…1"; checked against the recorded fixture)
 *             `EXPERIMENTAL_tx_status` (wait_until FINAL) for each transaction signed by a watched account, or sent to
 *             the USDC contract naming a watched receiver; its USDC receipt outcomes go to Roads.offer
 * Throughput: one height costs a `block` round trip plus one `chunk` round trip per new non-empty chunk (testnet,
 * 2026-11-04: 10 shards, ~1.8 such chunks a height, ~270-370 ms a call), i.e. ~770-970 ms a height done one call
 * after another, while testnet makes a final block every ~580 ms: a serial road falls further behind the longer it
 * runs. So the reads (block + its chunks, the chunks in parallel) of up to --rpc-prefetch heights are in flight at once;
 * outcomes are still handed in, and the cursor moved, strictly in height order.
 * This road sees every transfer the paywall's buyers make (signed straight to the token contract). A transfer to a
 * pay-to made by an unwatched account through another contract is seen only by `neardata`, which reads all receipt
 * outcomes.
 */
import { candidateTxs, headerTimeMs } from "../decode.ts";
import type { Bus } from "../events.ts";
import type { Roads } from "../roads.ts";
import { RpcError, type Rpc } from "../rpc.ts";
import type { Store } from "../store.ts";
import { TxStatus } from "../tx-status.ts";
import { BlockLoop, type BlockResult, type LoopOptions } from "./adapter.ts";

export const EMPTY_ROOT = "11111111111111111111111111111111";

type ChunkHeader = { chunk_hash: string; height_included: number; tx_root: string; shard_id: number };
type BlockView = { header: Record<string, unknown> & { height: number; hash: string }; chunks: ChunkHeader[] };

export type RpcRoadOptions = LoopOptions & {
  contract: string;
  txStatusTimeoutMs: number;
  /** Heights whose block + chunk reads may be in flight at once (1 = one call after another). */
  prefetch?: number;
};

/** The network reads of one height: its block and its new non-empty chunks (fetched in parallel), or a skipped height. */
export type FetchedHeight = { kind: "skipped" } | { kind: "block"; height: number; block: BlockView; chunks: { transactions: unknown[] }[] };

/** `parallel`: fetch the height's chunks at once (read-ahead on) or one after another (serial, as backfill does). */
export async function fetchHeight(rpc: Pick<Rpc, "call">, h: number, tip: number, parallel = false): Promise<FetchedHeight> {
  let block: BlockView;
  try {
    block = await rpc.call<BlockView>("block", { block_id: h });
  } catch (e) {
    if (e instanceof RpcError && e.cause_name === "UNKNOWN_BLOCK" && h <= tip) return { kind: "skipped" };
    throw e;
  }
  const fresh = block.chunks.filter((c) => c.height_included === h && c.tx_root !== EMPTY_ROOT);
  const get = (c: ChunkHeader) => rpc.call<{ transactions: unknown[] }>("chunk", { chunk_id: c.chunk_hash });
  const chunks = parallel ? await Promise.all(fresh.map(get)) : [];
  if (!parallel) for (const c of fresh) chunks.push(await get(c));
  return { kind: "block", height: h, block, chunks };
}

/** Offer one fetched height's USDC outcomes (chunks in header order; tx status lookups one after another). */
export async function offerHeight(f: FetchedHeight, txs: TxStatus, network: string, contract: string, roads: Roads, via: Parameters<Roads["offer"]>[2]): Promise<BlockResult> {
  if (f.kind === "skipped") return f;
  const timeMs = headerTimeMs(f.block.header);
  txs.remember(f.block.header.hash, f.height, timeMs);
  const watched = roads.watchedAccounts(network);
  let txCount = 0;
  for (const chunk of f.chunks) {
    txCount += Array.isArray(chunk.transactions) ? chunk.transactions.length : 0;
    for (const cand of candidateTxs(chunk, contract, watched)) {
      const { outcomes } = await txs.outcomes(cand.hash, cand.signer, contract);
      for (const o of outcomes) roads.offer(network, o, via);
    }
  }
  return { kind: "block", height: f.height, timeMs, txCount };
}

/** Read one height over RPC and offer its USDC outcomes. Shared by the poll roads and backfill. */
export async function rpcHeight(rpc: Pick<Rpc, "call">, txs: TxStatus, h: number, tip: number, network: string, contract: string, roads: Roads, via: Parameters<Roads["offer"]>[2]): Promise<BlockResult> {
  return offerHeight(await fetchHeight(rpc, h, tip), txs, network, contract, roads, via);
}

export async function rpcFinalHeight(rpc: Pick<Rpc, "call">): Promise<number> {
  const b = await rpc.call<BlockView>("block", { finality: "final" });
  return b.header.height;
}

export class RpcPollRoad extends BlockLoop {
  private readonly rpc: Rpc;
  private readonly txs: TxStatus;
  private readonly contract: string;
  /** Reads started ahead of the loop, by height. */
  private readonly ahead = new Map<number, Promise<FetchedHeight>>();
  /** Effective read-ahead: 1 when --rpc-min-ms paces requests (a pace is per request, not per height). */
  readonly prefetch: number;

  constructor(opts: RpcRoadOptions, rpc: Rpc, roads: Roads, store: Store, bus: Bus) {
    super(opts, roads, store, bus);
    this.rpc = rpc;
    this.contract = opts.contract;
    this.txs = new TxStatus(rpc, opts.txStatusTimeoutMs);
    this.prefetch = opts.minIntervalMs > 0 ? 1 : Math.max(1, opts.prefetch ?? 1);
  }

  protected tip(): Promise<number> {
    return rpcFinalHeight(this.rpc);
  }

  protected async height(h: number): Promise<BlockResult> {
    const tip = this.tipSeen ?? h;
    for (const k of this.ahead.keys()) if (k < h) this.ahead.delete(k);
    // Start the reads of h .. h+prefetch-1 (never past the known final tip: those blocks are final and immutable).
    for (let k = h; k < h + this.prefetch && k <= Math.max(tip, h); k++) {
      if (this.ahead.has(k)) continue;
      const p = fetchHeight(this.rpc, k, tip, this.prefetch > 1);
      p.catch(() => undefined); // awaited (and its error thrown) only when the loop reaches k
      this.ahead.set(k, p);
    }
    const fetched = this.ahead.get(h) as Promise<FetchedHeight>;
    this.ahead.delete(h);
    try {
      return await offerHeight(await fetched, this.txs, this.opts.network, this.contract, this.roads, this.opts.road);
    } catch (e) {
      this.ahead.clear(); // after an error the loop backs off and re-reads the tip: start afresh
      throw e;
    }
  }
}
