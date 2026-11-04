/**
 * Alert rules beyond those raised where things happen (ported from ledger-watch src/alerts.ts):
 *   low_calls   a buyer's USDC covers fewer than --low-calls paid calls; raised once, cleared with low_calls_ok
 *   *_refused   ingest refusals: at most one alert per code per --alert-every-sec, the rest counted
 */
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
