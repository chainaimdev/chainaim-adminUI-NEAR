"use client";
/**
 * Jobs (architecture-adminui-jobs.md ARCH-210): every paid tab 03 job of chainiam-private-ai's test console, from its
 * quote to its release, as near-watch joined it (src/jobs.ts): the job's steps (analyst, model calls, SQL), tokens,
 * masking counts and full cost breakdown from the console's job feed; payment and reconcile from the paywall's claim
 * and the chain. Jobs quoted but never paid show as expired, and their compute as lost.
 *
 * Text fields are never rendered because none are received: near-watch refuses any job event that carries one.
 * Amounts: totals and costs are USD decimal strings as cost.ts computed them; the payment amount is USDC base units,
 * shown with the token's decimals.
 */
import { useState } from "react";
import { clock, short, unitsToDecimal } from "../../lib/format.ts";
import { labelOf, txKey, type LiveState } from "../../lib/live-store.ts";
import { JOB_STATES, type JobStep, type JobView } from "../../lib/types.ts";
import { Measured, Reported, TxLink } from "../ui.tsx";

const when = (j: JobView): number => j.quotedMs ?? j.paidMs ?? j.receivedMs;
const counts = (c: Record<string, number> | null): string =>
  c === null ? "—" : Object.keys(c).length === 0 ? "none" : Object.entries(c).map(([k, n]) => `${k} ${n}`).join(" · ");
const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const usd = (v: string | null | undefined): string => (v ? `$${v}` : "—");

function stateText(j: JobView): string {
  return j.noJobEvent ? `${j.state} (no job event)` : j.state;
}

/** Analyst → Query model → SQL → Answer model → Quote → Paid → Released | Expired: done or not. */
function Strip({ j }: { j: JobView }) {
  const steps = j.steps ?? [];
  const has = (name: JobStep["name"]) => steps.some((s) => s.name === name);
  const stages: [string, boolean][] = [
    ["Analyst", has("analyst")],
    ["Query model", has("query")],
    ["SQL", has("sql")],
    ["Answer model", has("answer")],
    ["Quote", j.quotedMs !== null],
    ["Paid", j.paidMs !== null],
    j.state === "expired" ? ["Expired", true] : ["Released", j.releasedMs !== null],
  ];
  return (
    <div className="chips" aria-label="job steps">
      {stages.map(([name, done], i) => (
        <span key={name} className={`chip ${done ? "done" : "off"}`}>
          <b>{done ? "✓" : "·"}</b> {name}
          {i < stages.length - 1 && <span className="sep">→</span>}
        </span>
      ))}
    </div>
  );
}

function StepTable({ j }: { j: JobView }) {
  const steps = j.steps ?? [];
  return (
    <div className="panel tw">
      <table className="wide">
        <thead>
          <tr>
            <th>step</th>
            <th className="r">time</th>
            <th>model</th>
            <th>zone</th>
            <th className="r">tokens in</th>
            <th className="r">tokens out</th>
            <th title="Entity kinds and counts the gateway masked in this call (never the values)">masked</th>
            <th title="The gateway's last check after masking">residual</th>
            <th className="r">step cost</th>
          </tr>
        </thead>
        <tbody>
          {steps.length === 0 ? (
            <tr>
              <td colSpan={9} className="empty">
                {j.noJobEvent ? "near-watch has no job_quoted for this job: only its payment is known." : "No steps."}
              </td>
            </tr>
          ) : (
            steps.map((s, i) => (
              <tr key={i}>
                <td>{s.name}</td>
                <td className="r">{ms(s.ms)}</td>
                {s.name === "query" || s.name === "answer" ? (
                  <>
                    <td>{s.model}</td>
                    <td>{s.zone ?? "—"}</td>
                    <td className="r">{s.promptTokens}</td>
                    <td className="r">{s.completionTokens}</td>
                    <td className="muted">{counts(s.entityCounts)}</td>
                    <td className={s.residual === "refused" ? "st only_in_log" : ""}>{s.residual ?? "—"}</td>
                    <td className="r">{usd(s.usd)}</td>
                  </>
                ) : (
                  <>
                    <td colSpan={2} className="muted">
                      {s.name === "analyst" ? `${s.files} file(s), ${s.relations} relation(s), on this PC` : `${"rows" in s ? s.rows : 0} row(s), on this PC`}
                    </td>
                    <td colSpan={4} />
                    <td className="r">{s.name === "analyst" ? usd(j.breakdown?.analystUsd) : "—"}</td>
                  </>
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Breakdown({ j, decimalsOf }: { j: JobView; decimalsOf: (network: string) => number | null }) {
  const b = j.breakdown;
  if (!b) return null;
  const paid = j.amount ? unitsToDecimal(j.amount, decimalsOf(j.network)) : null;
  return (
    <div className="panel tw">
      <table>
        <tbody>
          {b.calls.map((c, i) => (
            <tr key={i}>
              <td>
                model call {i + 1}: {c.model} ({c.promptTokens} in / {c.completionTokens} out)
              </td>
              <td className="r">{usd(c.usd)}</td>
            </tr>
          ))}
          <tr>
            <td>model cost (subtotal)</td>
            <td className="r">{usd(b.modelUsd)}</td>
          </tr>
          <tr>
            <td>call fees ({b.calls.length} call(s))</td>
            <td className="r">{usd(b.callFeesUsd)}</td>
          </tr>
          <tr>
            <td>analyst fee</td>
            <td className="r">{usd(b.analystUsd)}</td>
          </tr>
          <tr>
            <td>NEAR gas fee</td>
            <td className="r">{usd(b.nearGasUsd)}</td>
          </tr>
          <tr>
            <td>subtotal (without margin)</td>
            <td className="r">{usd(b.subtotalUsd)}</td>
          </tr>
          <tr>
            <td>margin</td>
            <td className="r">{b.marginPct} %</td>
          </tr>
          <tr>
            <td>total with margin (before minimum)</td>
            <td className="r">{usd(b.withMarginUsd)}</td>
          </tr>
          <tr>
            <td>minimum price {b.minApplied ? "(applied)" : "(not applied)"}</td>
            <td className="r">{usd(b.minPriceUsd)}</td>
          </tr>
          <tr>
            <td>
              <b>total</b> <Reported by="console" />
            </td>
            <td className="r" title={j.amount ? `${j.amount} base units` : undefined}>
              <b>{usd(j.totalUsd)}</b>
              {paid !== null && <span className="muted"> · {paid} USDC</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function JobsTab({ live, decimalsOf }: { live: LiveState; decimalsOf: (network: string) => number | null }) {
  const jobs = Object.values(live.jobs).sort((a, b) => when(b) - when(a) || a.jobId.localeCompare(b.jobId));
  const [picked, setPicked] = useState<string | null>(null);
  const sel = (picked ? live.jobs[picked] : undefined) ?? jobs[0];
  const recon = (j: JobView) => (j.txHash ? (live.recon[txKey(j.network, j.txHash)]?.state ?? j.reconcile) : null);
  const tx = sel?.txHash ? live.txs.find((t) => t.key === txKey(sel.network, sel.txHash as string)) : undefined;
  const summary = live.jobSummary;

  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow">Paid jobs · tab 03, quote to release</div>
          <h2 className="q">What did each paid job run, cost and earn?</h2>
        </div>
      </div>
      <div className="kpis six">
        {JOB_STATES.map((s) => (
          <div className="kpi" key={s}>
            <span>{s}</span>
            <strong className={s === "released" ? "ok" : s === "expired" ? "warn" : ""}>{summary ? (summary.counts[s] ?? 0) : "—"}</strong>
            <em>all time</em>
          </div>
        ))}
        <div className="kpi">
          <span title="Model cost + call fees + analyst fee of jobs quoted but never paid (gas and margin were never spent)">lost compute</span>
          <strong className="warn">{summary ? Object.entries(summary.lostCompute).map(([n, v]) => (live.networks.length > 1 ? `${n} $${v}` : `$${v}`)).join(" · ") || "$0.000000" : "—"}</strong>
          <em>expired jobs</em>
        </div>
        <div className="kpi">
          <span>jobs shown</span>
          <strong>{jobs.length}</strong>
          <em>this session</em>
        </div>
      </div>
      <div className="panel tw">
        <table className="wide">
          <thead>
            <tr>
              <th>time</th>
              <th>job</th>
              <th>payer</th>
              <th>network</th>
              <th className="r">
                total <Reported by="console" />
              </th>
              <th>state</th>
              <th>
                reconcile <Measured />
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty">
                  No paid jobs yet. They appear when the private-ai test console runs with --paid-jobs on and --job-feed-url pointing at near-watch.
                </td>
              </tr>
            ) : (
              jobs.map((j) => (
                <tr key={j.jobId} className={j.state === "expired" ? "unacc" : ""} onClick={() => setPicked(j.jobId)} style={{ cursor: "pointer" }} aria-selected={j === sel}>
                  <td>{clock(when(j))}</td>
                  <td title={j.jobId}>{j === sel ? <b>{short(j.jobId, 8, 4)}</b> : short(j.jobId, 8, 4)}</td>
                  <td title={j.payer ?? undefined}>{labelOf(live, j.network, j.payer)}</td>
                  <td>{j.network}</td>
                  <td className="r">{usd(j.totalUsd)}</td>
                  <td className={`st ${j.state}`}>{stateText(j)}</td>
                  <td className={`st ${recon(j) ?? ""}`}>{recon(j)?.replaceAll("_", " ") ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {sel && (
        <>
          <div className="inset">
            <strong>
              Job {sel.jobId} · {stateText(sel)}
            </strong>
            quoted {clock(sel.quotedMs)} · expires {clock(sel.expiresMs)} · paid {clock(sel.paidMs)} · {sel.state === "expired" ? `expired ${clock(sel.expiredMs)}` : `released ${clock(sel.releasedMs)}`}
            {sel.invoiceId && <> · invoice {short(sel.invoiceId, 8, 4)}</>}
            {sel.txHash && (
              <>
                {" "}
                · tx {tx ? <TxLink t={tx} /> : <span title={sel.txHash}>{short(sel.txHash, 6, 4)}</span>} · reconcile <span className={`st ${recon(sel) ?? ""}`}>{recon(sel)?.replaceAll("_", " ") ?? "—"}</span>
              </>
            )}
          </div>
          <Strip j={sel} />
          <StepTable j={sel} />
          <Breakdown j={sel} decimalsOf={decimalsOf} />
        </>
      )}
      <div className="inset">
        <strong>Where this comes from (near-watch src/jobs.ts)</strong>
        Steps, models, tokens, masking counts and the breakdown are the test console&apos;s <code>job_quoted</code> event (kinds and counts only: near-watch refuses an event
        that carries any text). Paid = the paywall&apos;s claim for <code>POST /v1/jobs/&lt;jobId&gt;/release</code>; reconcile is that claim against the chain transfer, as on
        the Reconcile tab. Released = the console confirmed the paywall took the result; expired = the quote passed its expiry unpaid. Lost compute = model cost + call fees +
        analyst fee of expired jobs.
      </div>
    </section>
  );
}
