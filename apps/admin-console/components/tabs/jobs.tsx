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
import { JOB_STATES, type AttestSummary, type JobStep, type JobView } from "../../lib/types.ts";
import { Measured, Reported, TxLink } from "../ui.tsx";
import { attestView } from "../../lib/attest-view.ts";
import { dealText, mandateCell, proofRows, receiptCell, signedQuoteCell } from "../../lib/proof-view.ts";

/**
 * NEAR AI model attestation (PLAN-adminui-nearai-attestation.md ARCH-504). Verified by private-ai's ca-attest, only shown
 * here. No data yet → blank, never "unverified".
 */
const ATTEST_MARK: Record<AttestSummary, [string, string]> = {
  attested: ["✓", "attested: every NEAR AI call verified (TEE report, reply signature, hashes)"],
  partial: ["◐", "partial: some NEAR AI calls verified"],
  unverified: ["✗", "unverified: a NEAR AI call failed verification"],
  unavailable: ["⧗", "unavailable: the evidence could not be obtained yet (signature not ready or ca-attest unreachable); not a failed check, not attested; a later re-check replaces it"],
  not_applicable: ["–", "not applicable: no NEAR AI model call in this job"],
};
const ATTEST_CLASS: Record<AttestSummary, string> = { attested: "matched", partial: "only_on_ledger", unverified: "mismatch", unavailable: "only_in_log", not_applicable: "pending" };
/** A check result: passed, failed, or not checked. */
const tick = (v: boolean | null): string => (v === null ? "not checked" : v ? "✓" : "✗");
/** NEAR AI's own checker for one reply (docs.near.ai/cloud/verification). */
const NEAR_AI_VERIFY = "https://cloud.near.ai/verify";
const wrap = { wordBreak: "break-all" as const };

/**
 * Fix 4: the signature evidence of each call that has it: the exact text NEAR AI's TEE signed (a model id and the
 * SHA-256 of the request and response bytes, never the text itself) and the signature, so anyone can recover the
 * signer (EIP-191 for ecdsa) and compare it with the signer column above.
 */
function SignatureEvidence({ calls }: { calls: NonNullable<JobView["attestation"]>["calls"] }) {
  const withSig = calls.map((c, i) => ({ c, i })).filter(({ c }) => c.signedText || c.signatureHex);
  if (withSig.length === 0) return null;
  return (
    <details>
      <summary>Signature evidence ({withSig.length} call(s)): signed text and signature, to re-check yourself</summary>
      <table className="wide">
        <thead>
          <tr>
            <th>step</th>
            <th title="&lt;served model&gt;:&lt;sha256 of the request&gt;:&lt;sha256 of the response&gt;, as NEAR AI signed it">signed text</th>
            <th>signature</th>
          </tr>
        </thead>
        <tbody>
          {withSig.map(({ c, i }) => (
            <tr key={i}>
              <td>{c.step}</td>
              <td style={wrap}>
                <code>{c.signedText ?? "—"}</code>
              </td>
              <td style={wrap}>
                <code>{c.signatureHex ?? "—"}</code>
                {c.signatureHex && c.signingAlgo && <span className="muted"> ({c.signingAlgo})</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function AttestationTable({ j }: { j: JobView }) {
  const a = j.attestation;
  if (!a) return null;
  const v = attestView(j)!;
  return (
    <div className="panel tw">
      <p className={v.tone === "bad" ? "bad" : v.tone === "warn" ? "warn" : ""}>
        <strong>{v.label}.</strong> {v.sentence}
        {v.action && <span className="muted"> What to do: {v.action}.</span>}
      </p>
      <p className="muted">This proves where and how the model ran on the masked data the gateway sent; it does not say the answer is right (that is private-ai&apos;s figure check).</p>
      <details>
        <summary className="muted">Technical evidence</summary>
      <table className="wide">
        <thead>
          <tr>
            <th>step</th>
            <th>model</th>
            <th>NEAR AI model id</th>
            <th>chat id</th>
            <th>signature kind</th>
            <th>signer</th>
            <th>report time</th>
            <th title="Intel TDX quote of the model's TEE">TDX</th>
            <th title="NVIDIA GPU evidence">GPU</th>
            <th title="Reply signature recovered to the report's signer">signature</th>
            <th title="Signed request / response hashes equal the gateway's">hashes</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {a.calls.length === 0 ? (
            <tr>
              <td colSpan={12} className="empty">
                No model calls in this attestation.
              </td>
            </tr>
          ) : (
            a.calls.map((c, i) => (
              <tr key={i}>
                <td>{c.step}</td>
                <td>{c.model}</td>
                <td>{c.servedModel ?? "—"}</td>
                <td title={c.providerId ?? undefined}>{c.providerId ? short(c.providerId, 12, 6) : "—"}</td>
                <td>{c.signatureKind ?? "—"}</td>
                <td title={c.signingAddress ?? undefined}>{c.signingAddress ? `${short(c.signingAddress, 8, 6)} (${c.signingAlgo})` : "—"}</td>
                <td>{clock(c.reportFetchedMs)}</td>
                <td>{tick(c.tdx)}</td>
                <td>{tick(c.gpu)}</td>
                <td>{tick(c.signature)}</td>
                <td>{tick(c.hashes)}</td>
                <td className={`st ${c.status === "verified" ? "matched" : c.status === "unverified" ? "mismatch" : "pending"}`}>
                  {c.status.replaceAll("_", " ")}
                  {c.reason && <span className="muted"> · {c.reason}</span>}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <SignatureEvidence calls={a.calls} />
      </details>
      <div className="muted">
        Model attestation {a.summary.replaceAll("_", " ")} · received {clock(a.receivedMs)} · Check it yourself:{" "}
        <a href={NEAR_AI_VERIFY} target="_blank" rel="noreferrer">
          cloud.near.ai/verify
        </a>{" "}
        (paste a chat id)
      </div>
    </div>
  );
}

/** ARCH-703: the job's signed quote and signed receipt (key ids and hashes as near-watch holds them). */
function ProofTable({ j }: { j: JobView }) {
  const rows = proofRows(j);
  if (rows.length === 0) return null;
  const deal = dealText(j);
  return (
    <div className="panel tw">
      {deal && <p className="src">The deal: {deal}</p>}
      <table className="wide">
        <thead>
          <tr>
            <th>signed quote, mandate and receipt</th>
            <th>value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v, full]) => (
            <tr key={k}>
              <td>{k}</td>
              <td title={full || undefined}>
                <code>{v}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
      <div className="kpis seven">
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
          <span title="Jobs whose NEAR AI model calls were all verified, of all jobs (from private-ai's ca-attest)">attested jobs</span>
          <strong className="ok">{summary?.attestation ? `${summary.attestation.attested} of ${Object.values(summary.counts).reduce((n, c) => n + c, 0)}` : "—"}</strong>
          <em>NEAR AI model</em>
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
              <th title="NEAR AI model attestation: ✓ attested · ◐ partial · ✗ unverified · ⧗ unavailable (re-checked later) · – not applicable · blank = no data yet">attested</th>
              <th title="ChainAim signed the quote as a UCP checkout (AP2 merchant authorization, ES256): ✓ key id · – not signed (AP2 off) or not reported">signed quote</th>
              <th title="The buyer agent's AP2 checkout mandate, signed with the tenant's key and verified by ChainAim's signer before the job ran: ✓ tenant · – none reported">tenant mandate</th>
              <th title="The console's signed Job Evidence Receipt: ✓ settled · ⧗ pending (settlement not attached yet) · – none reported">receipt</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={11} className="empty">
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
                  <td className={j.attestation ? `st ${ATTEST_CLASS[j.attestation.summary]}` : ""} title={j.attestation ? ATTEST_MARK[j.attestation.summary][1] : undefined}>
                    {j.attestation ? `${ATTEST_MARK[j.attestation.summary][0]} ${attestView(j)!.label}` : ""}
                  </td>
                  {[signedQuoteCell(j), mandateCell(j), receiptCell(j)].map((c, i) => (
                    <td key={i} className={c.tone === "ok" ? "st matched" : c.tone === "warn" ? "st pending" : "muted"} title={c.title}>
                      {c.mark}
                      {c.text ? ` ${c.text}` : ""}
                    </td>
                  ))}
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
          <AttestationTable j={sel} />
          <ProofTable j={sel} />
          <Breakdown j={sel} decimalsOf={decimalsOf} />
        </>
      )}
      <div className="inset read-me">
        <strong>Where this comes from</strong>
        <table>
          <thead>
            <tr><th>Shown</th><th>Comes from</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Steps, models, tokens, masking counts, breakdown</td>
              <td>The test console&apos;s <code>job_quoted</code> event: kinds and counts only (near-watch refuses an event that carries any text).</td>
            </tr>
            <tr>
              <td>Paid</td>
              <td>The paywall&apos;s claim for <code>POST /v1/jobs/&lt;jobId&gt;/release</code>.</td>
            </tr>
            <tr>
              <td>Reconcile</td>
              <td>That claim against the chain transfer, as on the Reconcile tab.</td>
            </tr>
            <tr>
              <td>Released</td>
              <td>The console confirmed the paywall took the result.</td>
            </tr>
            <tr>
              <td>Expired</td>
              <td>The quote passed its expiry unpaid.</td>
            </tr>
            <tr>
              <td>Lost compute</td>
              <td>Model cost + call fees + analyst fee of expired jobs.</td>
            </tr>
            <tr>
              <td>Signed quote</td>
              <td>
                The console&apos;s <code>job_quoted</code> event, when it runs with AP2 on: the key id that signed the quote as a UCP checkout and the
                signature&apos;s SHA-256. The buyer&apos;s agent verified the signature itself with its pinned key; near-watch holds no signature.
              </td>
            </tr>
            <tr>
              <td>Tenant mandate</td>
              <td>
                The <code>mandate</code> on the console&apos;s <code>job_receipt</code> event (with <code>--job-feed-mandate on</code>): the tenant id, the
                tenant&apos;s key id and the mandate&apos;s SHA-256. The buyer&apos;s agent signed it with the tenant&apos;s key for exactly this signed quote and one
                payment; ChainAim&apos;s signer verified it before the job ran. near-watch holds no mandate, nonce or account.
              </td>
            </tr>
            <tr>
              <td>Receipt</td>
              <td>
                The console&apos;s <code>job_receipt</code> event: receipt id, signing key id, result and files hashes, and the settlement transaction once attached.
              </td>
            </tr>
            <tr>
              <td>Attested</td>
              <td>
                The console&apos;s <code>job_attested</code> event: private-ai&apos;s ca-attest checked each NEAR AI call&apos;s TEE report, reply signature and hashes.
                near-watch and this page only show its result, plus the signed text (model id and two hashes) and the signature, so it can be re-checked.
              </td>
            </tr>
          </tbody>
        </table>
        <p className="src">Source: near-watch src/jobs.ts</p>
      </div>
    </section>
  );
}
