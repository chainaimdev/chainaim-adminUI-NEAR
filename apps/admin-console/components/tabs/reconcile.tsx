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
import { mergeTxs } from "../../lib/derive.ts";
import { clock, decimals, short, unitsToDecimal } from "../../lib/format.ts";
import { labelOf, txKey, type LiveState } from "../../lib/live-store.ts";
import { GAP_STATES, RECON_STATES, type ClaimRow, type GraceReport, type ReconRow, type ReconState, type SnapshotTx } from "../../lib/types.ts";
import { Measured, Reported, Roads, TxLink } from "../ui.tsx";

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
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="empty">
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
                    <td className="muted">{r.detail ?? ""}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="inset">
        <strong>Matching rule (near-watch src/reconcile.ts, DESIGN §5.3)</strong>
        Reported = the paywall&apos;s <code>payment_settled</code> line (amount in base units). Measured = a successful <code>ft_transfer</code> of the watched token contract into
        a watched pay-to in a final block, with exactly one transfer event. No memo is required: the x402 NEAR exact scheme&apos;s transfer is{" "}
        <code>ft_transfer {"{receiver_id, amount}"}</code> with no memo (chainiam-private-ai docs/NEAR-GATES.md G3). Claims join chain transfers by transaction hash only (base58,
        exact); the claim&apos;s invoiceId is shown when it has one and is not compared with anything on chain. Amount, payer and token are compared, amounts in base units. A side still alone after the grace (near-watch <code>--settle-grace-blocks</code>, counted in final
        blocks) becomes <i>only in log</i> or <i>only on ledger</i>; both seen but disagreeing is <i>mismatch</i>. When the missing side lands later, the same row turns
        <i> matched</i> and is marked <i>late</i>, with how late in the detail. Transfers from before reconciling first started are not judged.
      </div>
      <div className="inset">
        <strong>Grace (near-watch --settle-grace-blocks)</strong>
        {Object.keys(grace).length === 0
          ? " Loading /api/feeds…"
          : Object.entries(grace).map(([n, g]) =>
              g ? (
                <span key={n}>
                  {" "}
                  {n}: {g.tradeoff}
                  {g.trailBlocks !== null ? ` Now the newest block read is ~${g.trailBlocks} block(s) old.` : ""}
                </span>
              ) : (
                <span key={n}> {n}: near-watch did not report its grace.</span>
              ),
            )}
      </div>
    </section>
  );
}
