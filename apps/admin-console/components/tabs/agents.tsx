"use client";
/**
 * Private AI agents: every call chainiam-private-ai's quote-agents answered for Signatory's quote flow (Tommy's
 * tommyBuyerAgent / TommyTreasuryAgent and Jupiter's hub, Inventory, Logistics, Treasury and seller synthesis), as
 * near-watch stored them (services/near-watch/src/agent-calls.ts). Polled from /api/watch/agent-calls every 3 s.
 *
 * Only ids, the endpoint, the status, the duration and the source are received: near-watch refuses any record that
 * carries anything else, so no SKU, price, budget, cost or message can appear here.
 */
import { useState } from "react";
import { usePoll } from "../../hooks/use-poll.ts";
import { clock } from "../../lib/format.ts";

export type AgentCall = {
  id: number; tsMs: number; tenant: string | null; alias: string | null; path: string; status: number; ms: number;
  source: "rules" | "ai" | null; requestId: string | null; code: string | null; receivedMs: number;
};
export type AgentCalls = { total: number; failed: number; byTenant: Record<string, number>; calls: AgentCall[] };

const TENANTS = ["all", "tommy-hilfiger-europe", "jupiter-knitting"] as const;
const ok = (s: number): boolean => s >= 200 && s <= 299;

export function AgentsTab() {
  const [tenant, setTenant] = useState<(typeof TENANTS)[number]>("all");
  const poll = usePoll<AgentCalls>(`/api/watch/agent-calls?limit=200${tenant === "all" ? "" : `&tenant=${tenant}`}`, 3000);
  const d = poll.data;
  const calls = d?.calls ?? [];
  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow">Private AI agents · chainiam-private-ai quote-agents</div>
          <h2 className="q">Which private-AI agent endpoints did the quote flow call?</h2>
        </div>
      </div>
      <div className="kpis seven">
        <div className="kpi">
          <span>calls</span>
          <strong>{d ? d.total : "—"}</strong>
          <em>last {calls.length} shown</em>
        </div>
        <div className="kpi">
          <span title="Calls OutcomeAI answered with a status other than 2xx (refused: token, alias, LEI or body)">not 2xx</span>
          <strong className={d && d.failed > 0 ? "warn" : "ok"}>{d ? d.failed : "—"}</strong>
          <em>refused or failed</em>
        </div>
        {Object.entries(d?.byTenant ?? {}).map(([t, n]) => (
          <div className="kpi" key={t}>
            <span>{t}</span>
            <strong>{n}</strong>
            <em>calls</em>
          </div>
        ))}
        <div className="kpi">
          <span>tenant</span>
          <strong>
            <select value={tenant} onChange={(e) => setTenant(e.target.value as (typeof TENANTS)[number])} aria-label="tenant">
              {TENANTS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </strong>
          <em>filter</em>
        </div>
      </div>
      <div className="panel tw">
        <table className="wide">
          <thead>
            <tr>
              <th>time</th>
              <th>tenant</th>
              <th>agent (X-Agent-Alias)</th>
              <th>endpoint</th>
              <th className="r">status</th>
              <th className="r">ms</th>
              <th title="seller/synthesize and buyer/synthesize: rules, or ai (a NEAR AI model through the ChainAim gateway)">source</th>
              <th>request id</th>
            </tr>
          </thead>
          <tbody>
            {calls.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty">
                  {poll.error
                    ? `No data: ${poll.error}.`
                    : "No agent calls yet. They appear when quote-agents runs with --feed-url pointing at near-watch and a quote runs (Signatory console ▶ S01…S10 or scripts/quote-rig)."}
                </td>
              </tr>
            ) : (
              calls.map((c) => (
                <tr key={c.id}>
                  <td>{clock(c.tsMs)}</td>
                  <td>{c.tenant ?? "—"}</td>
                  <td>{c.alias ?? "—"}</td>
                  <td>
                    <code>{c.path}</code>
                  </td>
                  <td className={`r st ${ok(c.status) ? "matched" : "mismatch"}`} title={c.code ?? undefined}>
                    {c.status}
                    {c.code ? ` ${c.code}` : ""}
                  </td>
                  <td className="r">{c.ms}</td>
                  <td>{c.source ?? ""}</td>
                  <td className="muted" title={c.requestId ?? undefined}>
                    {c.requestId ? c.requestId.slice(0, 8) : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
