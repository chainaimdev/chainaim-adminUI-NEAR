"use client";
/**
 * Feeds (ported from liveops admin-console components/tabs/feeds.tsx): which roads near-watch runs per network and how
 * each is doing, from /api/feeds (near-watch src/main.ts feedsReport). Read-only.
 *
 *   roads      per running road: state, provider, redacted host, last final block, its lag behind its own tip (blocks),
 *              errors, all-time first / total arrivals (store roadStats) and the delay behind the winner (store roadLags)
 *   adapters   the catalogue (src/feeds/adapter.ts): selected, available (or why not), what it is doing now
 *   backfill   the range read once at start-up from the stored cursor
 * Changed from liveops: push / poll / QuickNode Stream / Webhook panels are replaced by the per-road table; NEAR has
 * no documented WebSocket subscription, so qn-wss is listed as not built.
 */
import { usePoll } from "../../hooks/use-poll.ts";
import type { AttestStatus } from "../../lib/attest-status.ts";
import { feedActivity } from "../../lib/derive.ts";
import { age, blockHeight, networkLabel, ROAD_LABELS } from "../../lib/format.ts";
import type { LiveState } from "../../lib/live-store.ts";
import type { FeedsNetwork, FeedsReport, Road } from "../../lib/types.ts";
import { Ext, Via } from "../ui.tsx";

const STATE_CLASS: Record<string, string> = { live: "ok", stale: "warn", connecting: "", down: "bad" };

function NetworkFeeds({ name, f, live, now }: { name: string; f: FeedsNetwork; live: LiveState; now: number }) {
  const st = live.status[name];
  const running = new Map(feedActivity(f).map((a) => [a.id, a]));
  const best = st?.provider ?? null;
  return (
    <div className="panel">
      <h3>
        NEAR {networkLabel(name)} <small>selected: {f.selected.join(" · ") || "none"} · token {f.token.symbol} ({f.token.decimals} decimals) · {f.caip2}</small>
      </h3>
      <div className="kpis four">
        <div className="kpi">
          <span>network</span>
          <strong className={st ? STATE_CLASS[st.state] : ""}>{st?.state ?? "—"}</strong>
          <em>{st ? `best road ${st.provider} · failovers ${st.failovers}` : "no status yet"}</em>
        </div>
        <div className="kpi">
          <span>last final block</span>
          <strong>{blockHeight(st?.lastLedger ?? null)}</strong>
          <em>{st && st.lastLedgerAgeMs !== null ? `delivered ${age(now - (st.at - st.lastLedgerAgeMs))} ago` : "—"}</em>
        </div>
        <div className="kpi">
          <span>backfill</span>
          <strong>{f.backfill ? (f.backfill.done ? "done" : "running") : "—"}</strong>
          <em>
            {f.backfill
              ? `${blockHeight(f.backfill.from)} → ${blockHeight(f.backfill.to)} via ${f.backfill.source}${f.backfill.truncated > 0 ? ` · ${f.backfill.truncated} older blocks not read` : ""}`
              : "nothing to catch up at start-up"}
          </em>
        </div>
        <div className="kpi">
          <span>explorer</span>
          <strong style={{ fontSize: 13 }}>{f.explorer ? <Ext href={f.explorer}>{new URL(f.explorer).host}</Ext> : "none"}</strong>
          <em>links on every row (built by near-watch)</em>
        </div>
      </div>
      {f.roads.some((r) => r.reset) && (
        <div className="attn error">
          <div>
            <strong>Network reset detected</strong>
            <span>A road stopped: the final tip is far below its stored cursor (--reset-blocks). Restart near-watch with a new --store to follow the new chain.</span>
          </div>
        </div>
      )}
      <div className="eyebrow" style={{ margin: "12px 0 6px" }}>
        Roads · first road wins, later roads recorded with their delay
      </div>
      <div className="tw">
        <table className="wide">
          <thead>
            <tr>
              <th>road</th>
              <th>state</th>
              <th>provider</th>
              <th>host</th>
              <th className="r">last block</th>
              <th className="r">behind tip</th>
              <th>last block seen</th>
              <th className="r">errors</th>
              <th className="r">won / seen</th>
              <th className="r">later: mean / max behind</th>
            </tr>
          </thead>
          <tbody>
            {f.roads.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty">
                  No road is running.
                </td>
              </tr>
            ) : (
              f.roads.map((r) => {
                const s = f.stats[r.road as Road];
                const l = f.lags[r.road];
                return (
                  <tr key={r.road}>
                    <td title={ROAD_LABELS[r.road as Road]}>
                      <span className="via">
                        <Via road={r.road as Road} />
                      </span>
                      {best === r.road ? <span className="muted"> · best</span> : null}
                    </td>
                    <td className={r.reset ? "bad" : STATE_CLASS[r.state]}>{r.reset ? "reset (stopped)" : r.road === "backfill" && r.done ? "done" : r.state}</td>
                    <td>{r.provider}</td>
                    <td className="muted">{r.host ?? "—"}</td>
                    <td className="r">{blockHeight(r.lastBlock)}</td>
                    <td className="r">{r.lagBlocks !== null ? `${r.lagBlocks} block(s)` : "—"}</td>
                    <td>{r.lastBlockAgeMs !== null ? `${age(r.lastBlockAgeMs)} ago` : "—"}</td>
                    <td className={`r ${r.errors > 0 ? "warn" : ""}`}>{r.errors}</td>
                    <td className="r">{s ? `${s.first} / ${s.total}` : "—"}</td>
                    <td className="r">{l && l.later > 0 ? `${l.meanMs ?? "—"} / ${l.maxMs ?? "—"} ms (${l.later})` : "—"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="eyebrow" style={{ margin: "12px 0 6px" }}>
        Adapters
      </div>
      <div className="tw">
        <table className="wide">
          <thead>
            <tr>
              <th>adapter</th>
              <th>kind</th>
              <th>provider</th>
              <th>selected</th>
              <th>now</th>
              <th>available</th>
              <th>what it is</th>
            </tr>
          </thead>
          <tbody>
            {f.adapters.map((a) => {
              const now = running.get(a.id);
              return (
                <tr key={a.id} className={a.available ? "" : "off"}>
                  <td>
                    <b>{a.id}</b>
                  </td>
                  <td>{a.kind}</td>
                  <td>{a.provider}</td>
                  <td>{a.selected ? "yes" : "no"}</td>
                  <td className={now?.state === "on" ? "" : "muted"}>
                    {now ? (
                      <>
                        <b>{now.state}</b> · {now.text}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={a.available ? "" : "muted"}>{a.available ? "yes" : `no — ${a.reason ?? ""}`}</td>
                  <td className="muted">{a.description}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {f.skipped.length > 0 && (
        <div className="inset">
          <strong>Skipped at start-up</strong>
          {f.skipped.map((s) => `${s.road}: ${s.reason}`).join(" · ")}
        </div>
      )}
    </div>
  );
}

export function FeedsTab({ live, feeds, error, now }: { live: LiveState; feeds: FeedsReport | null; error: string | null; now: number }) {
  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow">Roads per network · read-only</div>
          <h2 className="q">Where does each row come from?</h2>
        </div>
      </div>
      {error && <div className="empty bad">Feeds report not available: {error}</div>}
      {!feeds ? (
        <div className="empty">Loading /api/feeds…</div>
      ) : (
        <div className="col">
          {Object.entries(feeds.networks).map(([n, f]) => (
            <NetworkFeeds key={n} name={n} f={f} live={live} now={now} />
          ))}
        </div>
      )}
      <AttestService />
      <div className="inset read-me">
        <strong>Rules</strong>
        <ul>
          <li>
            <b>Chosen at start-up:</b> roads are set when near-watch starts (<code>--feeds neardata,qn-rpc,rpc</code>, <code>--backfill on</code>). This page shows
            them and never changes them.
          </li>
          <li>
            <b>One count per transfer:</b> every road walks final block heights in order. The first road to deliver a transfer wins; later roads are recorded with
            their delay and never counted twice.
          </li>
          <li>
            <b>Hosts redacted:</b> QuickNode URLs carry a token, so hosts are shown redacted and the browser never sees an endpoint URL.
          </li>
        </ul>
      </div>
    </section>
  );
}

/**
 * The attestation service (owner 2026-11-07): private-ai's ca-attest, read through /api/attest every 30 s. Up or down,
 * and per NEAR AI model when its enclave report was last checked, the verdict and the reasons: the early warning before
 * paid jobs start coming back unverified.
 */
function AttestService() {
  const p = usePoll<AttestStatus>("/api/attest", 30_000);
  const s = p.data;
  if (!s || !s.configured) return null;
  const yes = (v: boolean | null) => (v === true ? "✓" : v === false ? "✗" : "not checked");
  return (
    <div className="panel tw">
      <h3>
        Attestation service · private-ai ca-attest <small>{s.up ? (s.ready ? "up · every model has a checked report" : "up · not every model has a report yet") : "down"}</small>
      </h3>
      {!s.up ? (
        <div className="empty bad">{s.error}. Paid jobs still run; their NEAR AI step will show as pending until it is back.</div>
      ) : s.models.length === 0 ? (
        <div className="empty">ca-attest attests no model (no "attest": "nearai" model in the gateway&apos;s mode).</div>
      ) : (
        <table className="wide">
          <thead>
            <tr>
              <th>NEAR AI model</th>
              <th>report checked</th>
              <th>enclave signer</th>
              <th title="Intel TDX quote of the model's enclave">TDX</th>
              <th title={s.gpuCheck === false ? "the GPU check is off (-AttestGpuCheck off)" : "NVIDIA GPU attestation (NRAS)"}>GPU</th>
              <th title="The report holds the fresh nonce ca-attest sent (not a replay)">fresh</th>
              <th>verdict</th>
            </tr>
          </thead>
          <tbody>
            {s.models.flatMap((m) =>
              m.error || m.attestations.length === 0
                ? [
                    <tr key={m.model}>
                      <td>{m.model}</td>
                      <td>{m.fetchedAt ? new Date(m.fetchedAt).toLocaleTimeString() : "—"}</td>
                      <td colSpan={4}>—</td>
                      <td className="st mismatch">{m.error ?? "no attestation in the report"}</td>
                    </tr>,
                  ]
                : m.attestations.map((a, i) => (
                    <tr key={`${m.model}-${i}`}>
                      <td>{m.model}</td>
                      <td>{m.fetchedAt ? new Date(m.fetchedAt).toLocaleTimeString() : "—"}</td>
                      <td title={a.signingAddress}>{a.signingAddress.length > 16 ? `${a.signingAddress.slice(0, 8)}…${a.signingAddress.slice(-6)}` : a.signingAddress}</td>
                      <td>{yes(a.tdx)}</td>
                      <td>{yes(a.gpu)}</td>
                      <td>{yes(a.bindsNonce)}</td>
                      <td className={`st ${a.verified ? "matched" : "mismatch"}`}>
                        {a.verified ? "verified" : "not verified"}
                        {a.reasons.length > 0 && <span className="muted"> · {a.reasons.join("; ")}</span>}
                      </td>
                    </tr>
                  )),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
