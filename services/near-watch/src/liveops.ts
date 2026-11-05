/**
 * Live ops: claims and traces in, reconcile and metrics out (ported from ledger-watch src/liveops.ts).
 * Joins: claim <-> transfer by (network, tx hash); trace <-> claim by invoice id; trace <-> transfer through the claim
 * (or the trace's own tx hash). An x402 NEAR transfer has no memo, so the chain never names the invoice.
 * Every new claim and trace is streamed; repeats are accepted and dropped, so a sender may retry safely.
 * Paid jobs (architecture-adminui-jobs.md ARCH-206/207): job events in through ingestJob, joined to claims by the
 * job's release route (src/jobs.ts); the relayer's gas alert (ARCH-209) sits beside low_calls.
 */
import { AlertGate, LowCallsRule, LowGasRule } from "./alerts.ts";
import { IngestError, parseClaim, type CaipMap } from "./claims.ts";
import type { Row } from "./decode.ts";
import type { Bus, TxEvent } from "./events.ts";
import { JobBook } from "./jobs.ts";
import { computeMetrics, type Metrics } from "./metrics.ts";
import { Reconciler } from "./reconcile.ts";
import type { ClaimRow, ClaimSource, ReconState, Store, StoredTx, TraceRow } from "./store.ts";
import { FileTail } from "./tail.ts";
import { parseTrace, TRACE_STEPS } from "./traces.ts";
import type { WatchEntry } from "./watchlist.ts";

export type LiveOpsOptions = {
  networks: readonly string[];
  caips: CaipMap;
  watchlist: readonly WatchEntry[];
  graceBlocks: number;
  lowCalls: number;
  reconcileSec: number;
  reconcileBatch: number;
  metricsWindowSec: number;
  alertEverySec: number;
  paywallLogFile: string | null;
  paywallLogPollMs: number;
  /** ARCH-209: NEAR one x402 payment costs the relayer (--gas-per-payment-near); null/absent = no relayer gas rule. */
  gasPerPaymentNear?: string | null;
  /** ARCH-209: low_gas below this many payments (--relayer-min-payments). */
  relayerMinPayments?: number;
  now?: () => number;
};

export type IngestResult = { ok: true; isNew: boolean } | { ok: false; error: string };
export type TraceView = { invoiceId: string; steps: (TraceRow & { name: string })[]; claims: ClaimRow[]; tx: StoredTx | null; reconcile: { state: ReconState; detail: string | null } | null };

export class LiveOps {
  readonly reconciler: Reconciler;
  readonly tail: FileTail | null;
  readonly jobs: JobBook;
  readonly counters = { claims: 0, claimRepeats: 0, traces: 0, traceRepeats: 0, refused: 0 };
  private readonly store: Store;
  private readonly bus: Bus;
  private readonly opts: LiveOpsOptions;
  private readonly now: () => number;
  private readonly payTo = new Map<string, Set<string>>();
  private readonly labels = new Map<string, Map<string, string>>();
  private readonly gate: AlertGate;
  private readonly lowCalls: LowCallsRule;
  private readonly lowGas: LowGasRule | null;
  private timer: NodeJS.Timeout | null = null;
  private offs: (() => void)[] = [];

  constructor(store: Store, bus: Bus, opts: LiveOpsOptions) {
    this.store = store;
    this.bus = bus;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    for (const e of opts.watchlist) {
      if (e.role === "payto") this.payTo.set(e.network, (this.payTo.get(e.network) ?? new Set()).add(e.address));
      this.labels.set(e.network, (this.labels.get(e.network) ?? new Map()).set(e.address, e.label));
    }
    this.reconciler = new Reconciler(store, bus, { networks: opts.networks, payTo: this.payTo, graceBlocks: opts.graceBlocks, batch: opts.reconcileBatch, now: this.now });
    this.gate = new AlertGate(bus, opts.alertEverySec, this.now);
    this.lowCalls = new LowCallsRule(bus, opts.lowCalls);
    this.lowGas = opts.gasPerPaymentNear ? new LowGasRule(bus, { gasPerPaymentNear: opts.gasPerPaymentNear, minPayments: opts.relayerMinPayments ?? 500, everySec: opts.alertEverySec, now: this.now }) : null;
    this.jobs = new JobBook(store, bus, { caips: opts.caips, networks: opts.networks, now: this.now });
    this.tail = opts.paywallLogFile
      ? new FileTail(store, { path: opts.paywallLogFile, pollMs: opts.paywallLogPollMs, onLine: (line) => this.ingestLine(line), onProblem: (level, code, message) => this.gate.alert(level, code, message) })
      : null;
  }

  ingestLine(line: string): IngestResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return this.refuse("claim_refused", "a paywall log line is not JSON");
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { event?: unknown }).event !== "payment_settled") return { ok: true, isNew: false };
    // The paywall may log both rails into one file: an XRPL line is not ours and is skipped silently.
    const net = (parsed as { network?: unknown }).network;
    if (typeof net === "string" && !Object.hasOwn(this.opts.caips, net) && !net.startsWith("near")) return { ok: true, isNew: false };
    return this.ingestClaim(parsed, "file");
  }

  ingestClaim(input: unknown, source: ClaimSource): IngestResult {
    let c;
    try {
      c = parseClaim(input, this.opts.caips);
    } catch (e) {
      if (!(e instanceof IngestError)) throw e;
      return this.refuse("claim_refused", `claim from ${source}: ${e.message}`);
    }
    const claim: ClaimRow = { ...c, source, receivedMs: this.now(), seenBlock: this.reconciler.tip(c.network) };
    if (!this.store.insertClaim(claim)) {
      this.counters.claimRepeats += 1;
      return { ok: true, isNew: false };
    }
    this.counters.claims += 1;
    this.bus.emit("claim", { claim });
    this.reconciler.onClaim(claim);
    this.jobs.onClaim(claim);
    return { ok: true, isNew: true };
  }

  ingestTrace(input: unknown): IngestResult {
    let t;
    try {
      t = parseTrace(input, this.opts.caips);
    } catch (e) {
      if (!(e instanceof IngestError)) throw e;
      return this.refuse("trace_refused", `trace: ${e.message}`);
    }
    const trace: TraceRow = { ...t, receivedMs: this.now() };
    if (!this.store.insertTrace(trace)) {
      this.counters.traceRepeats += 1;
      return { ok: true, isNew: false };
    }
    this.counters.traces += 1;
    this.bus.emit("trace", { trace, stepName: TRACE_STEPS[trace.step], txHash: this.store.txByInvoice(trace.invoiceId)?.row.hash ?? null });
    return { ok: true, isNew: true };
  }

  /** One paid-job event (ARCH-206): stored, or refused whole and alerted job_refused. */
  ingestJob(input: unknown): IngestResult {
    let r: { isNew: boolean };
    try {
      r = this.jobs.ingest(input);
    } catch (e) {
      if (!(e instanceof IngestError)) throw e;
      return this.refuse("job_refused", `job: ${e.message}`);
    }
    return { ok: true, isNew: r.isNew };
  }

  private refuse(code: string, message: string): IngestResult {
    this.counters.refused += 1;
    this.gate.alert("warn", code, message);
    return { ok: false, error: message };
  }

  traceView(invoiceId: string): TraceView {
    const tx = this.store.txByInvoice(invoiceId) ?? null;
    const claims = this.store.claimsByInvoice(invoiceId);
    const hash = tx?.row.hash ?? claims[0]?.hash;
    const network = tx?.row.network ?? claims[0]?.network;
    const recon = hash && network ? this.store.getRecon(network, hash) : undefined;
    return {
      invoiceId,
      steps: this.store.tracesFor(invoiceId).map((s) => ({ ...s, name: TRACE_STEPS[s.step] ?? String(s.step) })),
      claims,
      tx,
      reconcile: recon ? { state: recon.state, detail: recon.detail } : null,
    };
  }

  metrics(): Metrics {
    return computeMetrics(this.store, { networks: this.opts.networks, payTo: this.payTo, labels: this.labels, windowSec: this.opts.metricsWindowSec, now: this.now });
  }

  snapshot(limit: number): Record<string, unknown> {
    return {
      claims: this.store.recentClaims(limit),
      reconcile: { counts: this.store.reconCounts(), recent: this.store.recentRecon(limit) },
      metrics: this.metrics(),
      counters: { ...this.counters, reconcilePasses: this.reconciler.counters.passes, reconcileChanges: this.reconciler.counters.changes, tail: this.tail ? { path: this.tail.path, ...this.tail.counters } : null },
    };
  }

  start(): void {
    this.offs.push(
      this.bus.on((name, data) => {
        if (name === "tx") {
          const row = (data as TxEvent).row as Row;
          queueMicrotask(() => {
            try {
              this.reconciler.onTx(row);
            } catch (e) {
              this.gate.alert("error", "reconcile_error", (e as Error).message);
            }
          });
        } else if (name === "reconcile") {
          const r = data as { network: string; hash: string };
          this.jobs.onReconcile(r.network, r.hash);
        }
      }),
      this.lowCalls.attach(),
      ...(this.lowGas ? [this.lowGas.attach()] : []),
    );
    this.tail?.start();
    const pass = (): void => {
      try {
        this.reconciler.run();
      } catch (e) {
        this.gate.alert("error", "reconcile_error", (e as Error).message);
      }
    };
    pass();
    this.timer = setInterval(pass, this.opts.reconcileSec * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tail?.stop();
    for (const off of this.offs) off();
    this.offs = [];
  }
}
