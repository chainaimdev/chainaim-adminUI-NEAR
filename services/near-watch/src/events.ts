/**
 * The events near-watch streams to the console (SSE contract, same names as liveops ledger-watch):
 * hello, ledger, tx, road, balances, status, alert, claim, trace, reconcile, seller, and job (paid jobs, sent only once
 * a job event or a job's claim arrives: architecture-adminui-jobs.md ARCH-207).
 * `ledger` carries one final NEAR block (index = block height) so the console's strip and the reconcile grace
 * work as they do for XRPL ledgers.
 *
 * Money: `ourAmount` and balances are decimal strings; claim amounts are base units. Times are ms since the epoch.
 */
import { EventEmitter } from "node:events";
import type { Row } from "./decode.ts";
import type { JobView, JobsSummary } from "./jobs.ts";
import type { SellerWallet } from "./seller.ts";
import type { ClaimRow, ReconSide, ReconState, Road, TraceRow } from "./store.ts";

export type LedgerEvent = { network: string; index: number; closeTime: number | null; txCount: number | null; ourCount: number; ourAmount: string; via: Road };
export type TxEvent = { row: Row; via: Road; lagMs: number | null };
export type RoadEvent = { network: string; hash: string; via: Road; lagMs: number; firstVia: Road };
/** One watched account's balances: NEAR (decimal) and the token, and whether it is registered with the token contract (storage_deposit). */
export type BalanceEntry = {
  network: string;
  label: string;
  role: string;
  address: string;
  near: string | null;
  asset: { code: string; contract: string; value: string | null; units: string | null };
  registered: boolean | null;
  callsLeft: number | null;
  error: string | null;
  at: number;
};
export type BalancesEvent = { entries: BalanceEntry[] };
export type ProviderState = "connecting" | "live" | "stale" | "down";
export type RoadStatus = { road: Road; state: ProviderState; provider: string; lastBlock: number | null; lastBlockAgeMs: number | null; lagBlocks: number | null; errors: number; reset: boolean };
export type StatusEvent = {
  network: string;
  /** The live road that most recently delivered a block first. */
  provider: string;
  providerUrl: string;
  state: ProviderState;
  lastLedger: number | null;
  lastLedgerAgeMs: number | null;
  roads: Record<Road, { first: number; total: number }>;
  feeds: RoadStatus[];
  failovers: number;
  at: number;
};
export type AlertEvent = { level: "info" | "warn" | "error"; code: string; message: string; network?: string; at: number };
export type ClaimEvent = { claim: ClaimRow };
export type TraceEvent = { trace: TraceRow; stepName: string; txHash: string | null };
export type ReconcileEvent = { network: string; hash: string; invoiceId: string | null; state: ReconState; previous: ReconState | null; side: ReconSide; detail: string | null; at: number };
export type SellerEvent = { wallets: SellerWallet[]; at: number };
/** One job changed (src/jobs.ts): the job as /api/job shows it, and its network's counts and lost compute. */
export type JobEvent = { job: JobView; summary: JobsSummary };

export type EventMap = {
  ledger: LedgerEvent;
  tx: TxEvent;
  road: RoadEvent;
  balances: BalancesEvent;
  status: StatusEvent;
  alert: AlertEvent;
  claim: ClaimEvent;
  trace: TraceEvent;
  reconcile: ReconcileEvent;
  seller: SellerEvent;
  job: JobEvent;
};
export type EventName = keyof EventMap;

export class Bus {
  private readonly emitter = new EventEmitter();
  readonly ledgers = new Map<string, LedgerEvent[]>();
  readonly status = new Map<string, StatusEvent>();
  balances: BalancesEvent = { entries: [] };
  readonly alerts: AlertEvent[] = [];
  readonly keepLedgers: number;
  readonly keepAlerts: number;

  constructor(keepLedgers = 60, keepAlerts = 100) {
    this.keepLedgers = keepLedgers;
    this.keepAlerts = keepAlerts;
    this.emitter.setMaxListeners(0);
  }

  emit<K extends EventName>(name: K, data: EventMap[K]): void {
    if (name === "ledger") {
      const e = data as LedgerEvent;
      const list = this.ledgers.get(e.network) ?? [];
      const i = list.findIndex((l) => l.index === e.index);
      if (i >= 0) list[i] = e;
      else {
        list.push(e);
        list.sort((a, b) => a.index - b.index);
        while (list.length > this.keepLedgers) list.shift();
      }
      this.ledgers.set(e.network, list);
    } else if (name === "status") {
      const s = data as StatusEvent;
      this.status.set(s.network, s);
    } else if (name === "balances") {
      this.balances = data as BalancesEvent;
    } else if (name === "alert") {
      this.alerts.push(data as AlertEvent);
      while (this.alerts.length > this.keepAlerts) this.alerts.shift();
    }
    this.emitter.emit("event", name, data);
  }

  on(listener: (name: EventName, data: unknown) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  alert(level: AlertEvent["level"], code: string, message: string, network?: string): void {
    this.emit("alert", { level, code, message, ...(network ? { network } : {}), at: Date.now() });
  }
}
