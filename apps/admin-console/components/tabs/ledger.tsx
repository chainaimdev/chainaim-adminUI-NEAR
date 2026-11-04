"use client";
/**
 * Ledger (ported from liveops admin-console components/tabs/ledger.tsx): every NEP-141 transfer near-watch recorded
 * (final blocks, watched accounts), with the road that won and every later road's delay behind it.
 * Columns follow near-watch src/decode.ts Row: block height, method, from / to account ids, decimal value (base units
 * on hover), memo, status success | failure. Links are near-watch's own (src/links.ts).
 */
import { useState } from "react";
import { usePoll } from "../../hooks/use-poll.ts";
import { mergeTxs, sides, tokenOf } from "../../lib/derive.ts";
import { blockHeight, clock, decimals, ROAD_LABELS, short } from "../../lib/format.ts";
import type { LiveState } from "../../lib/live-store.ts";
import { ROADS, type SnapshotTx } from "../../lib/types.ts";
import { Ext, Roads, TxLink } from "../ui.tsx";

export function LedgerTab({ live }: { live: LiveState }) {
  const [network, setNetwork] = useState("all");
  const [road, setRoad] = useState("all");
  const [x402Only, setX402Only] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const rest = usePoll<{ txs: SnapshotTx[] }>("/api/watch/txs?limit=1000", 15_000);
  const all = mergeTxs(live.txs, rest.data?.txs ?? []);
  const rows = all
    .filter((t) => network === "all" || t.network === network)
    .filter((t) => road === "all" || t.firstVia === road || t.roads.some((r) => r.via === road))
    .filter((t) => !x402Only || t.row.isX402)
    .filter((t) => !failedOnly || t.row.status === "failure")
    .slice(0, 300);

  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow">All rows · near-watch store · NEAR {live.networks.join(" + ")} · final blocks</div>
          <h2 className="q">What happened on chain?</h2>
        </div>
        <div className="filters">
          <select className="btn" value={network} onChange={(e) => setNetwork(e.target.value)} aria-label="network">
            <option value="all">every network</option>
            {live.networks.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <select className="btn" value={road} onChange={(e) => setRoad(e.target.value)} aria-label="road">
            <option value="all">any road</option>
            {ROADS.map((r) => (
              <option key={r} value={r}>
                {r} — {ROAD_LABELS[r]}
              </option>
            ))}
          </select>
          <button type="button" className={`tgl ${x402Only ? "on" : ""}`} onClick={() => setX402Only(!x402Only)} aria-pressed={x402Only}>
            <i />
            x402 only
          </button>
          <button type="button" className={`tgl ${failedOnly ? "on" : ""}`} onClick={() => setFailedOnly(!failedOnly)} aria-pressed={failedOnly}>
            <i />
            failed only
          </button>
        </div>
      </div>
      {rest.error && <div className="empty bad">Older rows not loaded: {rest.error} (live rows still shown)</div>}
      <div className="panel tw">
        <table className="wide">
          <thead>
            <tr>
              <th>time</th>
              <th>network</th>
              <th className="r">block</th>
              <th>kind</th>
              <th>from</th>
              <th>to</th>
              <th className="r">amount</th>
              <th>memo</th>
              <th>status</th>
              <th>tx</th>
              <th>roads (first → later)</th>
              <th className="r">first arrival</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={12} className="empty">
                  {rest.loading ? "Loading…" : "No transfer matches."}
                </td>
              </tr>
            ) : (
              rows.map((t) => {
                const s = sides(live, t);
                return (
                  <tr key={t.key}>
                    <td>{clock(t.row.blockTimeMs ?? t.firstSeenMs)}</td>
                    <td>{t.network}</td>
                    <td className="r" title={`receipt ${t.row.receiptId}`}>
                      {blockHeight(t.row.blockHeight)}
                    </td>
                    <td>
                      <span className="k" title={`method ${t.row.method ?? "—"} · ${t.row.events} transfer event(s)`}>
                        {t.row.isX402 ? "x402" : (t.row.method ?? "transfer")}
                      </span>
                    </td>
                    <td title={t.row.from}>
                      <Ext href={t.links?.account}>{s.from}</Ext>
                    </td>
                    <td title={t.row.to}>
                      <Ext href={t.links?.destination}>{s.to}</Ext>
                    </td>
                    <td className="r" title={`${t.row.amount} base units · token ${t.row.contract}`}>
                      {decimals(t.row.value)} {tokenOf(live, t.network)}
                    </td>
                    <td className="muted" title={t.row.memo ?? undefined}>
                      {t.row.memo ? short(t.row.memo, 8, 4) : "—"}
                    </td>
                    <td className={t.row.status === "success" ? "" : "bad"}>{t.row.status}</td>
                    <td>
                      <TxLink t={t} />
                    </td>
                    <td>
                      <Roads t={t} />
                      {t.roads.length > 0 && <span className="muted"> {t.roads.map((r) => `${r.via} +${r.lagMs} ms`).join(", ")}</span>}
                    </td>
                    <td className="r">{t.lagMs !== null ? `${t.lagMs} ms` : "—"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="inset">
        <strong>How to read this</strong>
        Every row is a NEP-141 transfer of the watched token touching a watched account, recorded from a final block (a failed <code>ft_transfer</code> is kept as
        <i> failure</i> and never counted). &quot;first arrival&quot; is how long after the block&apos;s time the winning road delivered it (live rows only); later roads show their
        delay behind the winner (from <code>road</code> events, this session). Roads: neardata = FastNear long-poll, qn-rpc = QuickNode JSON-RPC, rpc = public RPC fallback,
        backfill = catch-up from the stored cursor. Links open the explorer near-watch is configured with; the row itself is the proof.
      </div>
    </section>
  );
}
