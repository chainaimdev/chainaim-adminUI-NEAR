/**
 * Where every road (neardata, qn-rpc, rpc, backfill) hands in what it saw. One decode, one store decision, one
 * event (ported from ledger-watch src/roads.ts):
 *   first arrival   -> tx {row, via, lagMs behind block time}
 *   later arrival   -> road {hash, via, lagMs behind the first road}
 *   same road again -> dropped (counted)
 * Roads only call `offer` for receipts of final blocks (GATE A3), so every stored row has final = true.
 */
import { sumDecimal } from "./decimal.ts";
import { decodeOutcome, DecodeError, type DecodeContext, type ReceiptOutcome, type Row } from "./decode.ts";
import type { Bus, LedgerEvent } from "./events.ts";
import type { Road, Store } from "./store.ts";

export type RoadsOptions = {
  usdcContract: string;
  decimals: number;
  watched: Map<string, Set<string>>;
  payTo: Map<string, Set<string>>;
  now?: () => number;
};

export class Roads {
  readonly counters = { decodeErrors: 0, repeats: 0, blocks: 0 };
  private readonly blocks = new Map<string, Map<number, { closeTime: number | null; txCount: number | null; via: Road }>>();
  private readonly now: () => number;
  private readonly store: Store;
  private readonly bus: Bus;
  readonly opts: RoadsOptions;

  constructor(store: Store, bus: Bus, opts: RoadsOptions) {
    this.store = store;
    this.bus = bus;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  ctx(network: string): DecodeContext {
    return { network, usdcContract: this.opts.usdcContract, decimals: this.opts.decimals, watched: this.opts.watched.get(network) ?? new Set(), payTo: this.opts.payTo.get(network) ?? new Set() };
  }

  watchedAccounts(network: string): ReadonlySet<string> {
    return this.opts.watched.get(network) ?? new Set();
  }

  isOurs(row: Row): boolean {
    return row.isX402 && (this.opts.payTo.get(row.network)?.has(row.to) ?? false);
  }

  /** Hand in one receipt outcome from a final block. Returns the rows recorded (first or later). */
  offer(network: string, outcome: ReceiptOutcome, via: Road): Row[] {
    const seenMs = this.now();
    let rows: Row[];
    try {
      rows = decodeOutcome(outcome, this.ctx(network));
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      this.counters.decodeErrors += 1;
      this.bus.alert("warn", "decode_error", `${via}: ${e.message}`, network);
      return [];
    }
    const out: Row[] = [];
    for (const row of rows) {
      const arrival = this.store.recordArrival(row, via, seenMs);
      if (arrival.kind === "repeat") {
        this.counters.repeats += 1;
        continue;
      }
      out.push(row);
      if (arrival.kind === "first") {
        this.bus.emit("tx", { row, via, lagMs: row.blockTimeMs === null ? null : seenMs - row.blockTimeMs });
        if (this.blocks.get(network)?.has(row.blockHeight)) this.emitLedger(network, row.blockHeight);
      } else {
        this.bus.emit("road", { network, hash: row.hash, via, lagMs: arrival.lagMs, firstVia: arrival.firstVia });
      }
    }
    return out;
  }

  /** A final block was processed by a road. The first road to report a height emits the console's ledger strip entry. */
  blockFinal(network: string, height: number, closeTime: number | null, txCount: number | null, via: Road): boolean {
    const map = this.blocks.get(network) ?? new Map();
    if (map.has(height)) {
      const prev = map.get(height);
      if (prev && prev.txCount === null && txCount !== null) prev.txCount = txCount;
      return false;
    }
    map.set(height, { closeTime, txCount, via });
    while (map.size > 400) map.delete(map.keys().next().value as number);
    this.blocks.set(network, map);
    this.counters.blocks += 1;
    // Backfill history does not move the live strip (and so not the reconcile tip) backwards.
    const list = this.bus.ledgers.get(network);
    const tip = list && list.length ? list[list.length - 1].index : 0;
    if (via !== "backfill" || height > tip) this.emitLedger(network, height);
    return true;
  }

  private emitLedger(network: string, height: number): void {
    const info = this.blocks.get(network)?.get(height);
    const ours = this.store.txsInBlock(network, height).filter((r) => this.isOurs(r));
    const event: LedgerEvent = {
      network,
      index: height,
      closeTime: info?.closeTime ?? null,
      txCount: info?.txCount ?? null,
      ourCount: ours.length,
      ourAmount: sumDecimal(ours.map((r) => r.value)),
      via: info?.via ?? "neardata",
    };
    this.bus.emit("ledger", event);
  }
}
