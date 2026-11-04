/**
 * Seller Wallet (policy ported from ledger-watch src/seller.ts): per pay-to account,
 *   received     successful USDC transfers into the pay-to from a watched buyer — x402 (one ft_transfer event, no memo needed)
 *                counted apart from manual ones; measured, final blocks only
 *   unwatched    the same from any other account: listed, never counted
 *   in flight    paywall claims with no chain transfer yet, and rig calls signed/sent with no transfer and no claim yet
 *                (amount estimated at --call-price), younger than --inflight-expire-sec
 *   balance      the pay-to's USDC / NEAR from the last balance read
 * Streamed as `seller` (debounced) whenever a tx, claim, trace, balance or reconcile event arrives.
 */
import { formatUnits, sumUnits } from "../../../packages/chain-core/src/money.ts";
import type { BalanceEntry, Bus, EventName } from "./events.ts";
import type { Road, Store } from "./store.ts";
import { LAST_STEP, TRACE_STEPS } from "./traces.ts";
import type { WatchEntry } from "./watchlist.ts";

export const IN_FLIGHT_STEPS: readonly number[] = Object.entries(TRACE_STEPS)
  .filter(([, n]) => n === "signed" || n === "sent")
  .map(([s]) => Number(s));
const TRIGGERS: ReadonlySet<EventName> = new Set<EventName>(["tx", "balances", "claim", "trace", "reconcile"]);

export type SellerPayment = { hash: string; blockHeight: number; blockTimeMs: number | null; firstSeenMs: number; firstVia: Road; from: string; label: string | null; amount: string; units: string; memo: string | null; isX402: boolean; watched: boolean };
export type SellerBuyer = { address: string; label: string; received: string; count: number; x402Count: number; manualCount: number; inFlight: string; inFlightCount: number; lastMs: number | null };
export type SellerWallet = {
  network: string;
  address: string;
  label: string;
  asset: { code: string; contract: string; decimals: number };
  balance: { amount: string | null; near: string | null; registered: boolean | null; at: number | null; error: string | null };
  received: { amount: string; units: string; count: number; x402Count: number; x402Amount: string; manualCount: number; manualAmount: string; fromBlock: number | null };
  inFlight: { amount: string; count: number; claims: number; rig: number; estimated: boolean };
  expected: string;
  window: { sec: number; count: number; amount: string; buyers: number };
  buyers: SellerBuyer[];
  unwatched: { count: number; amount: string; recent: SellerPayment[] };
  recent: SellerPayment[];
};

export type SellerOptions = { networks: readonly string[]; watchlist: readonly WatchEntry[]; contract: string; code: string; decimals: number; callPriceUnits: string | null; estimate: boolean; expireSec: number; recent: number; debounceMs: number; windowSec: number; now?: () => number };

export class SellerBook {
  private readonly store: Store;
  private readonly bus: Bus;
  private readonly opts: SellerOptions;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;
  private last = "";

  constructor(store: Store, bus: Bus, opts: SellerOptions) {
    this.store = store;
    this.bus = bus;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  compute(): { wallets: SellerWallet[]; at: number } {
    const at = this.now();
    const fmt = (u: string): string => formatUnits(u, this.opts.decimals);
    const wallets: SellerWallet[] = [];
    for (const network of this.opts.networks) {
      const list = this.opts.watchlist.filter((w) => w.network === network);
      const buyers = new Map(list.filter((w) => w.role === "buyer").map((w) => [w.address, w.label]));
      const labels = new Map(list.map((w) => [w.address, w.label]));
      const bal = new Map<string, BalanceEntry>(this.bus.balances.entries.filter((b) => b.network === network).map((b) => [b.address, b]));
      for (const p of list.filter((w) => w.role === "payto")) {
        const txs = this.store.usdcInto(network, [p.address]);
        const pays: SellerPayment[] = txs.map((t) => ({
          hash: t.row.hash,
          blockHeight: t.row.blockHeight,
          blockTimeMs: t.row.blockTimeMs,
          firstSeenMs: t.firstSeenMs,
          firstVia: t.firstVia,
          from: t.row.from,
          label: labels.get(t.row.from) ?? null,
          amount: t.row.value,
          units: t.row.amount,
          memo: t.row.memo,
          isX402: t.row.isX402,
          watched: buyers.has(t.row.from),
        }));
        const counted = pays.filter((x) => x.watched);
        const other = pays.filter((x) => !x.watched);
        const x402 = counted.filter((x) => x.isX402);
        const manual = counted.filter((x) => !x.isX402);
        const since = at - this.opts.expireSec * 1000;
        const claims = this.store.claimsNotOnChain(network, since).filter((c) => c.asset === null || c.asset === this.opts.contract);
        const rig = this.store.tracesInFlight(network, since, IN_FLIGHT_STEPS, LAST_STEP);
        const rigUnits = this.opts.estimate && this.opts.callPriceUnits ? rig.map(() => this.opts.callPriceUnits as string) : [];
        const inFlightUnits = sumUnits([...claims.map((c) => c.amount), ...rigUnits]);
        const receivedUnits = sumUnits(counted.map((x) => x.units));
        const winSince = at - this.opts.windowSec * 1000;
        const inWindow = counted.filter((x) => (x.blockTimeMs ?? x.firstSeenMs) >= winSince);
        const b = bal.get(p.address);
        wallets.push({
          network,
          address: p.address,
          label: p.label,
          asset: { code: this.opts.code, contract: this.opts.contract, decimals: this.opts.decimals },
          balance: { amount: b?.asset.value ?? null, near: b?.near ?? null, registered: b?.registered ?? null, at: b?.at ?? null, error: b?.error ?? null },
          received: {
            amount: fmt(receivedUnits),
            units: receivedUnits,
            count: counted.length,
            x402Count: x402.length,
            x402Amount: fmt(sumUnits(x402.map((x) => x.units))),
            manualCount: manual.length,
            manualAmount: fmt(sumUnits(manual.map((x) => x.units))),
            fromBlock: this.store.firstBlock(network),
          },
          inFlight: { amount: fmt(inFlightUnits), count: claims.length + rig.length, claims: claims.length, rig: rig.length, estimated: this.opts.estimate && this.opts.callPriceUnits !== null },
          expected: fmt(sumUnits([receivedUnits, inFlightUnits])),
          window: { sec: this.opts.windowSec, count: inWindow.length, amount: fmt(sumUnits(inWindow.map((x) => x.units))), buyers: new Set(inWindow.map((x) => x.from)).size },
          buyers: [...buyers].map(([address, label]) => {
            const mine = counted.filter((x) => x.from === address);
            const fl = claims.filter((c) => c.payer === address);
            const flRig = rig.filter((r) => r.payer === address);
            return {
              address,
              label,
              received: fmt(sumUnits(mine.map((x) => x.units))),
              count: mine.length,
              x402Count: mine.filter((x) => x.isX402).length,
              manualCount: mine.filter((x) => !x.isX402).length,
              inFlight: fmt(sumUnits([...fl.map((c) => c.amount), ...(this.opts.estimate && this.opts.callPriceUnits ? flRig.map(() => this.opts.callPriceUnits as string) : [])])),
              inFlightCount: fl.length + flRig.length,
              lastMs: mine.length ? (mine[mine.length - 1].blockTimeMs ?? mine[mine.length - 1].firstSeenMs) : null,
            };
          }),
          unwatched: { count: other.length, amount: fmt(sumUnits(other.map((x) => x.units))), recent: other.slice(-this.opts.recent).reverse() },
          recent: counted.slice(-this.opts.recent).reverse(),
        });
      }
    }
    return { wallets, at };
  }

  private push(): void {
    const s = this.compute();
    const key = JSON.stringify(s.wallets);
    if (key === this.last) return;
    this.last = key;
    this.bus.emit("seller", s);
  }

  start(): void {
    this.off = this.bus.on((name) => {
      if (!TRIGGERS.has(name) || this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        try {
          this.push();
        } catch (e) {
          this.bus.alert("warn", "seller_error", (e as Error).message);
        }
      }, this.opts.debounceMs);
      this.timer.unref();
    });
  }

  stop(): void {
    this.off?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
