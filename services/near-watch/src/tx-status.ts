/**
 * For the RPC roads: a candidate transaction's receipt outcomes, final, with the height of the block each receipt
 * executed in. `EXPERIMENTAL_tx_status` with wait_until FINAL (docs.near.org/api/rpc/transactions) returns once the
 * transaction and all its receipts are final; each receipt outcome names its block by hash, resolved with RPC
 * `block` (cached).
 */
import { txStatusBlockHashes, txStatusOutcomes, headerTimeMs, type ReceiptOutcome } from "./decode.ts";
import type { Rpc } from "./rpc.ts";

type Header = { height: number; hash: string; timestamp_nanosec?: string; timestamp?: number };

export class TxStatus {
  private readonly heights = new Map<string, { height: number; timeMs: number | null }>();
  private readonly rpc: Pick<Rpc, "call">;
  private readonly timeoutMs: number;

  constructor(rpc: Pick<Rpc, "call">, timeoutMs: number) {
    this.rpc = rpc;
    this.timeoutMs = timeoutMs;
  }

  /** Remember a block the road already fetched, so its receipts need no extra lookup. */
  remember(hash: string, height: number, timeMs: number | null): void {
    this.heights.set(hash, { height, timeMs });
    while (this.heights.size > 2000) this.heights.delete(this.heights.keys().next().value as string);
  }

  async outcomes(txHash: string, signer: string, contract: string): Promise<{ outcomes: ReceiptOutcome[]; raw: unknown }> {
    const raw = await this.rpc.call("EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: signer, wait_until: "FINAL" }, this.timeoutMs);
    for (const h of txStatusBlockHashes(raw, contract)) {
      if (this.heights.has(h)) continue;
      const b = await this.rpc.call<{ header: Header }>("block", { block_id: h });
      this.remember(h, b.header.height, headerTimeMs(b.header as unknown as Record<string, unknown>));
    }
    return { outcomes: txStatusOutcomes(raw, contract, (h) => this.heights.get(h)), raw };
  }
}
