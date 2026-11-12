"use client";
/**
 * Reconcile (ported from liveops admin-console components/tabs/reconcile.tsx): the paywall's claims (reported) against
 * final-block transfers (measured), as near-watch decided them (/api/reconcile, src/reconcile.ts). The console only
 * joins in the amounts to show them side by side.
 *
 * Amounts: a claim's amount is BASE UNITS (x402 requirements.amount); it is shown as a decimal with the token's
 * decimals (`decimals` prop: /api/feeds token.decimals, else the Seller Wallet's asset.decimals) by bigint, and as base
 * units when the decimals are not known yet. The chain side shows Row.value (decimal) with Row.amount (base units) on
 * hover, so both sides can be compared in the same unit near-watch compared them in.
 */
import { useState } from "react";
import { usePoll } from "../../hooks/use-poll.ts";
import { graceLine, mergeTxs, reconDetail } from "../../lib/derive.ts";
import { clock, decimals, short, unitsToDecimal } from "../../lib/format.ts";
import { labelOf, txKey, type LiveState } from "../../lib/live-store.ts";
import { GAP_STATES, RECON_STATES, type ClaimRow, type GraceReport, type ReconRow, type ReconState, type SnapshotTx } from "../../lib/types.ts";
import { Measured, Reported, Roads, TxLink } from "../ui.tsx";
import { attestView, jobsByTx } from "../../lib/attest-view.ts";

type ReconResp = { counts: Record<ReconState, number>; rows: ReconRow[] };

function claimed(c: ClaimRow, dec: number | null): { text: string; title: string } {
  const d = unitsToDecimal(c.amount, dec);
  return d !== null ? { text: decimals(d), title: `${c.amount} base units (${dec} decimals)` } : { text: `${c.amount} units`, title: "token decimals not known yet: base units as claimed" };
}

/** "late: …" = near-watch matched this payment after it had been a one-sided gap (src/reconcile.ts lateness). */
const isLate = (r: ReconRow): boolean => r.detail?.startsWith("late: ") ?? false;

export function ReconcileTab({ live, decimalsOf, grace }: { live: LiveState; decimalsOf: (network: string) => number | null; grace: Record<string, GraceReport | undefined> }) {
  const [gapsOnly, setGapsOnly] = useState(false);
  const [state, setState] = useState<"all" | ReconState>("all");
  const recon = usePoll<ReconResp>(`/api/watch/reconcile?limit=500${state === "all" ? "" : `&state=${state}`}`, 5000);
  const claims = usePoll<{ claims: ClaimRow[] }>("/api/watch/claims?limit=500", 10_000);
  const txs = usePoll<{ txs: SnapshotTx[] }>("/api/watch/txs?limit=500", 15_000);
  const claimBy = new Map<string, ClaimRow>();
  for (const c of [...(claims.data?.claims ?? []), ...live.claims]) claimBy.set(txKey(c.network, c.hash), c);
  const txBy = new Map(mergeTxs(live.txs, txs.data?.txs ?? []).map((t) => [t.key, t]));
  const byTx = jobsByTx(live.jobs);
  const rows = (recon.data?.rows ?? []).filter((r) => !gapsOnly || (GAP_STATES as readonly string[]).includes(r.state));
  const counts = recon.data?.counts ?? null;

  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow">Two books · reported vs measured</div>
          <h2 className="q">Did we get paid for every call?</h2>
        </div>
        <div className="filters">
          <select className="btn" value={state} onChange={(e) => setState(e.target.value as "all" | ReconState)} aria-label="state">
            <option value="all">every state</option>
            {RECON_STATES.map((s) => (
              <option key={s} value={s}>
                {s.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          <button type="button" className={`tgl ${gapsOnly ? "on" : ""}`} onClick={() => setGapsOnly(!gapsOnly)} aria-pressed={gapsOnly}>
            <i />
            Gaps only
          </button>
        </div>
      </div>
      {Object.entries(grace).map(([n, g]) =>
        g?.warning ? (
          <div key={n} className="empty bad">
            {n}: {g.warning}
          </div>
        ) : null,
      )}
      {recon.error && <div className="empty bad">Reconcile not available: {recon.error}</div>}
      {claims.error && <div className="empty bad">Claims not available: {claims.error}</div>}
      <div className="kpis six">
        <div className="kpi">
          <span>
            claims <Reported by="paywall" />
          </span>
          <strong>{claimBy.size}</strong>
          <em>latest 500</em>
        </div>
        {RECON_STATES.map((s) => (
          <div className="kpi" key={s}>
            <span>{s.replaceAll("_", " ")}</span>
            <strong className={s === "matched" ? "ok" : s === "pending" ? "" : s === "only_on_ledger" ? "warn" : "bad"}>{counts ? (counts[s] ?? 0) : "—"}</strong>
            <em>all time</em>
          </div>
        ))}
      </div>
      <div className="panel tw">
        <table className="wide">
          <thead>
            <tr>
              <th>updated</th>
              <th>network</th>
              <th>payer</th>
              <th>route</th>
              <th title="From the paywall's claim. An x402 NEAR transfer carries no memo, so the chain side has no invoice.">invoice</th>
              <th className="r">
                claimed <Reported />
              </th>
              <th className="r">
                transferred <Measured />
              </th>
              <th>tx</th>
              <th>first road</th>
              <th>state</th>
              <th>detail</th>
              <th title="Paid and settled is the column before; this says whether the job's NEAR AI step is provable (private-ai ca-attest). A row paid but not provable is the one to look at.">compute proof</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={12} className="empty">
                  {recon.loading ? "Loading…" : gapsOnly ? "No gaps — every claim is on chain and every x402 transfer was claimed." : "No reconcile rows yet."}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const key = txKey(r.network, r.hash);
                const c = claimBy.get(key);
                const t = txBy.get(key);
                const gap = (GAP_STATES as readonly string[]).includes(r.state);
                const cl = c ? claimed(c, decimalsOf(r.network)) : null;
                const invoice = r.invoiceId ?? c?.invoiceId ?? null;
                const note = reconDetail(r.detail);
                return (
                  <tr key={key} className={r.state === "only_on_ledger" ? "unacc" : gap ? "gap" : ""}>
                    <td>{clock(r.updatedMs)}</td>
                    <td>{r.network}</td>
                    <td title={c?.payer ?? t?.row.from ?? undefined}>{labelOf(live, r.network, c?.payer ?? t?.row.from)}</td>
                    <td>{c?.route ?? "—"}</td>
                    <td className="muted" title={invoice ?? undefined}>
                      {invoice ? short(invoice, 8, 4) : "—"}
                    </td>
                    <td className="r" title={cl?.title}>
                      {cl?.text ?? "—"}
                    </td>
                    <td className="r" title={t ? `${t.row.amount} base units · ${t.row.status}` : undefined}>
                      {t ? decimals(t.row.value) : "—"}
                    </td>
                    <td>{t ? <TxLink t={t} /> : <span title={r.hash}>{short(r.hash, 6, 4)}</span>}</td>
                    <td>{t ? <Roads t={t} /> : "—"}</td>
                    <td className={`st ${r.state}`} title={`side ${r.side} · since ${clock(r.sinceMs)}`}>
                      {r.state.replaceAll("_", " ")}
                      {isLate(r) && <span className="muted"> · late</span>}
                    </td>
                    <td className="muted" title={note.title}>
                      {note.text}
                      {note.rejudged && <span aria-hidden="true"> ⓘ</span>}
                    </td>
                    <td>{(() => { const j = byTx.get(txKey(r.network, r.hash)); const v = attestView(j); return v ? <span className={v.tone === "bad" ? "bad" : v.tone === "warn" ? "warn" : v.tone === "ok" ? "ok" : "muted"} title={`job ${j!.jobId.slice(0, 8)}… · ${v.sentence}`}>{v.label}</span> : j ? <span className="muted" title={`job ${j.jobId.slice(0, 8)}…`}>paid job · no proof yet</span> : <span className="muted">—</span>; })()}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="inset read-me" title="near-watch src/reconcile.ts: rows join by transaction hash; amount, payer and token are compared in base units; transfers from before reconciling started are not judged.">
        <strong>How to read this</strong>
        <p>
          Each row is one payment, seen twice: what the paywall says it was paid (<i>reported</i>) and the USDC transfer on the chain (<i>measured</i>).
        </p>
        <table>
          <thead>
            <tr><th>State</th><th>Meaning</th></tr>
          </thead>
          <tbody>
            <tr><td>matched</td><td>Both agree.</td></tr>
            <tr><td>pending</td><td>Waiting for the other side.</td></tr>
            <tr><td>only in log</td><td>The paywall says paid; no transfer found.</td></tr>
            <tr><td>only on ledger</td><td>A transfer with no paywall record.</td></tr>
            <tr><td>mismatch</td><td>Both found, but they disagree.</td></tr>
            <tr><td>late</td><td>Matched after a delay.</td></tr>
            <tr><td>re-judged by operator</td><td>A false mismatch an operator cleared; hover the row for why.</td></tr>
          </tbody>
        </table>
      </div>
      <div className="inset" title={Object.values(grace).map((g) => g?.tradeoff ?? "").join(" ")}>
        <strong>Wait before flagging a gap</strong>
        {Object.keys(grace).length === 0
          ? " loading…"
          : Object.entries(grace).map(([n, g]) => (
              <span key={n}>
                {" "}
                {g ? graceLine(n, g) : `${n}: not reported by near-watch.`}
              </span>
            ))}
      </div>
    </section>
  );
}
