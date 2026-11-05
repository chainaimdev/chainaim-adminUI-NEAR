/**
 * Alert rules beyond those raised where things happen (ported from ledger-watch src/alerts.ts):
 *   low_calls   a buyer's USDC covers fewer than --low-calls paid calls; raised once, cleared with low_calls_ok
 *   low_gas     a relayer's NEAR covers fewer than --relayer-min-payments x402 payments at --gas-per-payment-near each
 *               (architecture-adminui-jobs.md ARCH-209); at most once per --alert-every-sec per relayer while low
 *   *_refused   ingest refusals: at most one alert per code per --alert-every-sec, the rest counted
 */
import { toUnits } from "../../../packages/chain-core/src/money.ts";
import { NEAR_DECIMALS } from "../../../packages/chain-core/src/near.ts";
import type { BalancesEvent, Bus } from "./events.ts";

export class LowCallsRule {
  private readonly low = new Set<string>();
  private readonly bus: Bus;
  private readonly threshold: number;

  constructor(bus: Bus, threshold: number) {
    this.bus = bus;
    this.threshold = threshold;
  }

  check(event: BalancesEvent): void {
    if (this.threshold === 0) return;
    for (const e of event.entries) {
      if (e.role !== "buyer" || e.callsLeft === null || e.error !== null) continue;
      const key = `${e.network}/${e.address}`;
      if (e.callsLeft < this.threshold) {
        if (this.low.has(key)) continue;
        this.low.add(key);
        this.bus.alert("warn", "low_calls", `${e.label} (${e.address}) has ${e.asset.code} for ${e.callsLeft} more call(s), below ${this.threshold}`, e.network);
      } else if (this.low.delete(key)) {
        this.bus.alert("info", "low_calls_ok", `${e.label} (${e.address}) is back to ${e.callsLeft} call(s)`, e.network);
      }
    }
  }

  attach(): () => void {
    return this.bus.on((name, data) => {
      if (name === "balances") this.check(data as BalancesEvent);
    });
  }
}

/** How many whole payments `near` NEAR covers at `gasPerPayment` NEAR each (exact, in yoctoNEAR). */
export function paymentsCovered(near: string, gasPerPayment: string): bigint {
  const gas = BigInt(toUnits(gasPerPayment, NEAR_DECIMALS));
  if (gas === 0n) throw new Error("gas per payment must be above 0");
  return BigInt(toUnits(near, NEAR_DECIMALS)) / gas;
}

export class LowGasRule {
  private readonly last = new Map<string, number>();
  private readonly bus: Bus;
  private readonly opts: { gasPerPaymentNear: string; minPayments: number; everySec: number; now: () => number };

  constructor(bus: Bus, opts: { gasPerPaymentNear: string; minPayments: number; everySec: number; now?: () => number }) {
    this.bus = bus;
    this.opts = { ...opts, now: opts.now ?? Date.now };
  }

  check(event: BalancesEvent): void {
    for (const e of event.entries) {
      if (e.role !== "relayer" || e.near === null || e.error !== null) continue;
      const covered = paymentsCovered(e.near, this.opts.gasPerPaymentNear);
      if (covered >= BigInt(this.opts.minPayments)) continue;
      const key = `${e.network}/${e.address}`;
      const t = this.opts.now();
      const at = this.last.get(key);
      if (at !== undefined && t - at < this.opts.everySec * 1000) continue;
      this.last.set(key, t);
      this.bus.alert("warn", "low_gas", `${e.label} (${e.address}) holds ${e.near} NEAR: gas for ${covered} more payment(s) at ${this.opts.gasPerPaymentNear} NEAR each, below ${this.opts.minPayments}`, e.network);
    }
  }

  attach(): () => void {
    return this.bus.on((name, data) => {
      if (name === "balances") this.check(data as BalancesEvent);
    });
  }
}

export class AlertGate {
  private readonly last = new Map<string, { at: number; suppressed: number }>();
  private readonly bus: Bus;
  private readonly everyMs: number;
  private readonly now: () => number;

  constructor(bus: Bus, everySec: number, now: () => number = Date.now) {
    this.bus = bus;
    this.everyMs = everySec * 1000;
    this.now = now;
  }

  alert(level: "info" | "warn" | "error", code: string, message: string, network?: string): void {
    const t = this.now();
    const seen = this.last.get(code);
    if (seen && t - seen.at < this.everyMs) {
      seen.suppressed += 1;
      return;
    }
    const extra = seen && seen.suppressed > 0 ? ` (${seen.suppressed} more since the last alert)` : "";
    this.last.set(code, { at: t, suppressed: 0 });
    this.bus.alert(level, code, `${message}${extra}`, network);
  }
}
