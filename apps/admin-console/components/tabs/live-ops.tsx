"use client";
/**
 * Live ops (ported from liveops admin-console components/tabs/live-ops.tsx): the demo's layout, every figure from
 * near-watch. Read-only: no controls. Deck (what is running), Seller wallet row, payment-flow canvas, feed race (first
 * road wins, later roads' delay), throughput per final block, needs attention, buyer cards, transfer tape, change log.
 * Changed from liveops: one network and one token (no RLUSD / TUSD groups, no Devnet direct lane); block heights in
 * place of ledger indexes; NEP-145 storage registration in place of trust lines.
 */
import type { LiveListener } from "../../hooks/use-live.ts";
import {
  attention,
  blockInterval,
  buyers,
  feedActivity,
  inFlight,
  kpis,
  payToOf,
  roadRows,
  sellerWallets,
  sides,
  tokenOf,
  x402Network,
  type Attention,
  type Buyer,
  type FeedNow,
} from "../../lib/derive.ts";
import { account, age, blockHeight, clock, decimals, ROAD_COLOR, unitsToDecimal } from "../../lib/format.ts";
import { lastLedger, type LiveState } from "../../lib/live-store.ts";
import { STEP_NAMES, type FeedsReport, type Metrics } from "../../lib/types.ts";
import { Spark, ThroughputChart } from "../charts.tsx";
import { FlowCanvas } from "../flow-canvas.tsx";
import { SellerPayments, SellerWalletRow } from "../seller-wallet.tsx";
import { Measured, Reported, Roads, TxLink } from "../ui.tsx";
import { attestShare, attestView, jobsByTx } from "../../lib/attest-view.ts";
import { txKey } from "../../lib/live-store.ts";

const sec = (ms: number | null | undefined): string => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)}` : "—");

/** Dot per feed state: green = receiving, red = running but not live, hollow = off. */
const FEED_DOT: Record<FeedNow["state"], string> = { on: "live", issue: "down", off: "off" };

/** The selected roads of the x402 network, each marked with what it is doing now (hover for why). */
function FeedLine({ items }: { items: FeedNow[] }) {
  return (
    <>
      {items.map((a) => (
        <span key={a.id} className={a.state === "on" ? "val" : "muted"} title={`${a.id}: ${a.text}`} style={{ marginLeft: 8, whiteSpace: "nowrap" }}>
          <i className={`dot ${FEED_DOT[a.state]}`} style={{ display: "inline-block", marginRight: 4, verticalAlign: "middle" }} />
          {a.id}
          {a.badge ? ` (${a.badge})` : ""}
        </span>
      ))}
    </>
  );
}

function BuyerCard({ b, now, token }: { b: Buyer; now: number; token: string }) {
  const calls = b.balance?.callsLeft ?? null;
  const value = b.balance?.asset.value ?? null;
  const c = b.counted;
  const meter = calls === null ? 0 : Math.min(100, (calls / 50) * 100);
  const pill = b.status === "paying" ? "busy" : b.status === "settled" ? "ok" : b.status;
  return (
    <div className="bcard">
      <div className="top">
        <div>
          <div className="name">{b.entry.label}</div>
          <div className="addr" title={b.entry.address}>
            {account(b.entry.address)} · {b.entry.network}
          </div>
        </div>
        <span className={`pillx ${pill}`}>{b.status}</span>
      </div>
      <div className="steps" title={`last call ${b.invoiceId ?? "—"}: ${[1, 2, 3, 4, 5].map((s) => `${s} ${STEP_NAMES[s]}`).join(" · ")}. Grey = reported, green = on chain (measured).`}>
        {b.steps.map((s, i) => (
          <i key={i} className={s} />
        ))}
      </div>
      <div className="bal">
        <strong>{b.balance?.registered === false ? `not registered with ${token}` : value != null ? `${decimals(value)} ${token}` : "—"}</strong>
        <span>{calls === null ? "—" : `${calls} calls left`}</span>
      </div>
      <div className={`meter ${calls === null ? "" : calls < 1 ? "empty" : calls < 6 ? "near" : ""}`}>
        <i style={{ width: `${meter}%` }} />
      </div>
      <div className="bstats">
        <div>
          x402 · window<b>{b.windowCalls ?? "—"}</b>
        </div>
        <div>
          all paid<b>{c ? `${c.count} · ${decimals(c.received)}` : "—"}</b>
        </div>
        <div>
          last call<b>{b.endToEndMs !== null ? `${sec(b.endToEndMs)} s` : "—"}</b>
        </div>
      </div>
      <Spark values={b.spark} />
      <div className="bfoot">
        {b.lastStepAt !== null
          ? `last x402 step ${age(now - b.lastStepAt)} ago${c && c.manualCount > 0 ? ` · ${c.manualCount} manual` : ""}`
          : c && c.count > 0
            ? `${c.x402Count} x402 · ${c.manualCount} manual · no x402 trace this session`
            : "no payment yet this session"}
        {b.balance?.near != null ? ` · ${decimals(b.balance.near)} NEAR` : ""}
      </div>
    </div>
  );
}

function AttentionList({ items, go }: { items: Attention[]; go: (tab: string) => void }) {
  if (items.length === 0) return <div className="empty">Nothing needs you. Roads live, books agree.</div>;
  return (
    <>
      {items.slice(0, 8).map((a, i) => (
        <div className={`attn ${a.level === "error" ? "error" : "warn"}`} key={`${a.title}-${i}`}>
          <div>
            <strong>{a.title}</strong>
            <span>{a.detail}</span>
          </div>
          {a.tab ? (
            <button type="button" className="btn" onClick={() => go(a.tab as string)}>
              Open ↗
            </button>
          ) : (
            <span>{clock(a.at)}</span>
          )}
        </div>
      ))}
    </>
  );
}

export function LiveOpsTab({ live, now, metrics, feeds, subscribe, go }: { live: LiveState; now: number; metrics: Metrics | null; feeds: FeedsReport | null; subscribe: (fn: LiveListener) => () => void; go: (tab: string) => void }) {
  const net = x402Network(live) ?? live.networks[0] ?? null;
  const token = tokenOf(live, net);
  const list = buyers(live, now, metrics);
  const k = kpis(live, now, metrics, list);
  const roads = net ? roadRows(live, net) : [];
  const totalFirst = roads.reduce((a, r) => a + r.first, 0) || 1;
  const att = attention(live, now, list);
  const payTo = net ? (payToOf(live, net)[0] ?? null) : null;
  const payBal = payTo ? (live.balances.find((b) => b.address === payTo.address && b.network === payTo.network) ?? null) : null;
  const interval = net ? blockInterval(live, net) : null;
  const tape = live.txs.slice(0, 40);
  const byTx = jobsByTx(live.jobs);
  const share = attestShare(live.jobs, net);
  const agree = k.reconDecided && k.reconDecided > 0 && k.reconGaps !== null ? Math.round((100 * (k.reconDecided - k.reconGaps)) / k.reconDecided) : null;
  const feedNet = net ? (feeds?.networks[net] ?? null) : null;
  // The last claim's price is base units: shown as a decimal only with the token's decimals from /api/feeds.
  const claimPrice = live.claims[0] ? unitsToDecimal(live.claims[0].amount, feedNet?.token.decimals ?? live.seller?.wallets[0]?.asset.decimals) : null;
  const feedNow = feedNet ? feedActivity(feedNet).filter((a) => a.selected) : null;
  const wallets = sellerWallets(live);
  const books = { agreePct: agree, decided: k.reconDecided ?? null, gaps: k.reconGaps ?? null };

  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow">
            Live payments · {token} · NEAR {net ?? "—"}
          </div>
          <h2 className="q">Every agent paying, every payment proven — live.</h2>
        </div>
      </div>

      <div className="deck" aria-label="What is running (read-only)">
        <span className="dbox">
          buyers watched <b className="val">{k.buyersWatched}</b>
        </span>
        <span className="div" />
        <span>
          active · 5 min <b className="val">{k.buyersActive}</b>
        </span>
        <span className="div" />
        <span>
          paid · last 60 s <b className="val">{k.paidLastMinute}</b> <Measured />
        </span>
        <span className="div" />
        <span>
          last claimed price <b className="val">{claimPrice ?? "—"}</b> {token} <Reported by="paywall" />
        </span>
        <span className="div" />
        <span>
          {net ?? "—"} roads {feedNow ? <FeedLine items={feedNow} /> : <b className="val">—</b>}
        </span>
        <span className="div" />
        <span title="Paid tab 03 jobs whose NEAR AI step was attested (private-ai ca-attest), of all paid jobs on this network">
          AI proof <b className="val">{share.paidJobs ? `${share.attestedJobs} of ${share.paidJobs}` : "—"}</b> paid jobs
        </span>
        <span className="deck-note">Payments run from the terminal (the paywall&apos;s rig); this page only watches.</span>
      </div>

      {wallets.length === 0 ? (
        <>
          <SellerWalletRow live={live} now={now} wallet={null} books={books} />
          <SellerPayments live={live} wallet={null} />
        </>
      ) : (
        wallets.map((w) => (
          <div key={`${w.network}:${w.address}`}>
            <SellerWalletRow live={live} now={now} wallet={w} books={w.network === net ? books : null} />
            <SellerPayments live={live} wallet={w} />
          </div>
        ))
      )}

      <div className="grid">
        <div className="panel">
          <h3>
            Payment flow · live <small>each dot is a real event; one dot per road that delivered a transfer</small>
          </h3>
          {net ? (
            <FlowCanvas
              network={net}
              buyers={live.watchlist.filter((w) => w.role === "buyer" && w.network === net)}
              payTo={payTo}
              payToBalance={payBal?.asset.value ?? null}
              token={token}
              lastBlock={lastLedger(live, net)}
              feeds={feedNet}
              subscribe={subscribe}
            />
          ) : (
            <div className="empty">near-watch watches no pay-to account, so there is no x402 flow to draw.</div>
          )}
          <div className="legend">
            <span>
              <i style={{ background: "var(--text2)" }} />
              quoted (reported by rig)
            </span>
            <span>
              <i style={{ background: "var(--blue)" }} />
              paid call sent (reported by rig)
            </span>
            <span>
              <i style={{ background: "var(--gold)" }} />
              {token} transferred (measured)
            </span>
            <span>
              <i style={{ background: "var(--ok)" }} />
              neardata
            </span>
            <span>
              <i style={{ background: "var(--accent2)" }} />
              qn-rpc
            </span>
            <span>
              <i style={{ background: "var(--warn)" }} />
              rpc
            </span>
            <span>
              <i style={{ background: "var(--muted)" }} />
              backfill
            </span>
          </div>
        </div>
        <div className="col">
          <div className="panel">
            <h3>
              Feed race · first road wins <small>{net ?? "—"} · later roads recorded, not counted twice</small>
            </h3>
            {roads.length === 0 ? (
              <div className="empty">No road has delivered a transfer yet.</div>
            ) : (
              roads.map((r) => {
                const col = `var(${ROAD_COLOR[r.road]})`;
                return (
                  <div className="road" key={r.road}>
                    <div>
                      <b style={{ color: col }}>{r.road}</b>
                      <small>{r.total} seen in all</small>
                    </div>
                    <div>
                      <div className="bar">
                        <i style={{ width: `${(r.first / totalFirst) * 100}%`, background: col }} />
                      </div>
                      <small>
                        {r.avgFirstLagMs !== null ? `won: avg ${r.avgFirstLagMs} ms after block time` : "no win this session"}
                        {r.avgBehindMs !== null ? ` · later: avg ${r.avgBehindMs} ms behind (${r.later})` : ""}
                      </small>
                    </div>
                    <div className="n">
                      {r.first}
                      <small>won</small>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="panel">
            <h3>
              Throughput <small>{token} settled per final block · measured</small>
            </h3>
            <ThroughputChart ledgers={net ? (live.ledgers[net] ?? []) : []} token={token} />
            <div className="pairs">
              <div className="pair">
                <span>block time</span>
                <b>{interval !== null ? `${(interval / 1000).toFixed(1)} s` : "—"}</b>
              </div>
              <div className="pair">
                <span>in flight · reported</span>
                <b>{inFlight(live, now)}</b>
              </div>
            </div>
          </div>
          <div className="panel">
            <h3>
              Needs attention <small>{att.length}</small>
            </h3>
            <AttentionList items={att} go={go} />
          </div>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="buyers">
          <div className="empty">near-watch watches no buyer account (--watch label=buyer=account).</div>
        </div>
      ) : (
        <>
          <div className="eyebrow" style={{ margin: "16px 0 8px" }}>
            {token} buyers · {net ?? "—"} · {list.length} watched
          </div>
          <div className="buyers">
            {list.map((b) => (
              <BuyerCard key={`${b.entry.network}:${b.entry.address}`} b={b} now={now} token={token} />
            ))}
          </div>
        </>
      )}

      <div className="grid" style={{ marginTop: 16 }}>
        <div className="panel">
          <h3>
            Transfer tape · measured <small>{live.txs.length} rows · final blocks</small>
          </h3>
          <div className="tape">
            {tape.length === 0 ? (
              <div className="empty">Waiting for the first watched transfer…</div>
            ) : (
              tape.map((t) => {
                const s = sides(live, t);
                return (
                  <div className="trow" key={t.key}>
                    <span>{clock(t.row.blockTimeMs ?? t.firstSeenMs)}</span>
                    <span className="k" title={t.row.method ?? undefined}>
                      {t.row.status === "failure" ? "failed" : t.row.isX402 ? "x402" : "manual"}
                    </span>
                    <span>
                      {s.from} → {s.to} <span className="muted">· block {blockHeight(t.row.blockHeight)}</span>
                    </span>
                    <span className="amt" title={`${t.row.amount} base units`}>
                      {decimals(t.row.value)} {token}
                    </span>
                    <span>
                      <Roads t={t} /> <TxLink t={t} />
                      {(() => { const v = attestView(byTx.get(txKey(t.network, t.row.hash))); return v ? <span className={v.tone === "bad" ? "bad" : v.tone === "warn" ? "warn" : v.tone === "ok" ? "ok" : "muted"} title={v.sentence}> · {v.tone === "ok" ? "AI verified" : v.label}</span> : null; })()}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <div className="panel">
          <h3>Change log</h3>
          <div className="rail tape" aria-live="polite">
            {live.rail.length === 0 ? (
              <div className="empty">Nothing yet.</div>
            ) : (
              live.rail.map((r) => (
                <p key={r.id} className={r.level === "error" ? "e" : r.level === "warn" ? "w" : ""}>
                  {clock(r.at)} {r.network ? `[${r.network}] ` : ""}
                  {r.text}
                </p>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
