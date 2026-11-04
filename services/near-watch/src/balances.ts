/**
 * Balances of every watched account, read every --balances-sec and shortly after a transfer touches one
 * (final state, RPC `query`):
 *   NEAR          view_account -> amount (yoctoNEAR)
 *   USDC          ft_balance_of {account_id} on the token contract
 *   registered    storage_balance_of {account_id} != null (NEP-145: an unregistered receiver cannot be paid)
 *   callsLeft     buyers: whole multiples of --call-price (base units) in the USDC balance
 */
import { formatUnits } from "../../../packages/chain-core/src/money.ts";
import { NEAR_DECIMALS } from "../../../packages/chain-core/src/near.ts";
import type { BalanceEntry, Bus, TxEvent } from "./events.ts";
import { viewFunction, type RpcPool } from "./rpc.ts";
import type { WatchEntry } from "./watchlist.ts";

export type BalanceOptions = { contract: string; code: string; decimals: number; callPriceUnits: string | null; everySec: number; onTxDebounceMs: number };

export class BalanceWatch {
  private readonly list: readonly WatchEntry[];
  private readonly rpc: RpcPool;
  private readonly bus: Bus;
  private readonly opts: BalanceOptions;
  private timer: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;
  private busy = false;

  constructor(list: readonly WatchEntry[], rpc: RpcPool, bus: Bus, opts: BalanceOptions) {
    this.list = list;
    this.rpc = rpc;
    this.bus = bus;
    this.opts = opts;
  }

  async read(e: WatchEntry): Promise<BalanceEntry> {
    const base: BalanceEntry = { network: e.network, label: e.label, role: e.role, address: e.address, near: null, asset: { code: this.opts.code, contract: this.opts.contract, value: null, units: null }, registered: null, callsLeft: null, error: null, at: Date.now() };
    try {
      const acct = await this.rpc.call<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: e.address });
      base.near = formatUnits(acct.amount, NEAR_DECIMALS);
      const units = await viewFunction<string>(this.rpc, this.opts.contract, "ft_balance_of", { account_id: e.address });
      base.asset.units = BigInt(units).toString();
      base.asset.value = formatUnits(base.asset.units, this.opts.decimals);
      const storage = await viewFunction<unknown>(this.rpc, this.opts.contract, "storage_balance_of", { account_id: e.address });
      base.registered = storage !== null;
      if (e.role === "buyer" && this.opts.callPriceUnits && BigInt(this.opts.callPriceUnits) > 0n) base.callsLeft = Number(BigInt(base.asset.units) / BigInt(this.opts.callPriceUnits));
    } catch (err) {
      base.error = (err as Error).message;
    }
    return base;
  }

  async refresh(): Promise<void> {
    if (this.busy || this.list.length === 0 || this.rpc.size === 0) return;
    this.busy = true;
    try {
      const entries: BalanceEntry[] = [];
      for (const e of this.list) entries.push(await this.read(e));
      this.bus.emit("balances", { entries });
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    const tick = (): void => void this.refresh().catch((e: Error) => this.bus.alert("warn", "balances_error", e.message));
    tick();
    this.timer = setInterval(tick, this.opts.everySec * 1000);
    this.timer.unref();
    const watched = new Set(this.list.map((e) => e.address));
    this.off = this.bus.on((name, data) => {
      if (name !== "tx") return;
      const row = (data as TxEvent).row;
      if (!watched.has(row.to) && !watched.has(row.from)) return;
      if (this.pending) clearTimeout(this.pending);
      this.pending = setTimeout(tick, this.opts.onTxDebounceMs);
      this.pending.unref();
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
    this.off?.();
    this.timer = this.pending = null;
  }
}
