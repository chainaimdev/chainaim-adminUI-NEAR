"use client";
/**
 * Seller Wallet (ported from liveops admin-console components/seller-wallet.tsx), one per pay-to near-watch watches
 * (near-watch src/seller.ts, `seller` event and hello.seller):
 *
 *   Seller wallet   the pay-to's token balance from the last final-state read (big), the token received in the window,
 *                   then NEAR (its own figure: storage and gas, never converted), received, in flight, expected
 *   Active buyers   watched buyers with a counted transfer in the window, of all watched buyers
 *   Payments        counted transfers whose block is in the window
 *   <TOKEN> received their decimal amount in the window
 *   Books agree     near-watch's reconcile counts (x402 transfers against the paywall's claims)
 *   Recent payments the pay-to's latest counted transfers: kind (x402 / manual), memo, explorer link, reconcile state for
 *                   x402; a manual transfer has no paywall claim, so it is never shown as matched
 *
 * Used twice: the compact row on Live ops (SellerWalletRow + SellerPayments) and the Seller wallet tab (SellerWalletTab:
 * the same plus every buyer and the unwatched transfers, which are listed and never counted).
 *
 * Changed from liveops: `outstanding` / `last` / per-window x402 split are gone (near-watch sends inFlight, expected and
 * window {count, amount, buyers}); `registered` (NEP-145 storage) replaces the XRPL trust line. Every figure is a decimal
 * string from near-watch: nothing is added up in the browser. Explorer links come only from near-watch's tx entries.
 */
import { useEffect, useRef, useState } from "react";
import { usePoll } from "../hooks/use-poll.ts";
import { mergeTxs } from "../lib/derive.ts";
import { account, age, blockHeight, decimals, short, stamp } from "../lib/format.ts";
import { txKey, type LiveState } from "../lib/live-store.ts";
import type { Links, SellerPayment, SellerWallet, SnapshotTx } from "../lib/types.ts";
import { Ext, Measured, Via } from "./ui.tsx";
import { attestShare, usdcOf } from "../lib/attest-view.ts";

/** How long the card stays highlighted after a new payment or balance. */
const PULSE_MS = 1600;

function tooltip(w: SellerWallet, now: number): string {
  const token = w.asset.code;
  const read = w.balance.at !== null ? ` (read ${age(now - w.balance.at)} ago)` : "";
  const since = w.received.fromBlock !== null ? ` since block ${w.received.fromBlock.toLocaleString("en-US")}` : "";
  const est = w.inFlight.estimated ? ", rig calls estimated at the call price" : "";
  const unw = w.unwatched.count > 0 ? ` Not counted: ${w.unwatched.count} transfer(s), ${w.unwatched.amount} ${token} from unwatched accounts.` : "";
  const reg = w.balance.registered === false ? " NOT registered with the token contract (storage_deposit): it cannot be paid." : "";
  return (
    `${w.label} ${w.address} (${w.network}). Balance: ft_balance_of on ${w.asset.contract} (${w.asset.decimals} decimals), final state${read}${w.balance.error ? `; last read failed: ${w.balance.error}` : ""}.${reg} ` +
    `Received: successful ${token} transfers from watched buyers${since}: ${w.received.x402Count} x402 (${w.received.x402Amount}), ${w.received.manualCount} manual (${w.received.manualAmount}). ` +
    `In flight: ${w.inFlight.claims} claimed by the paywall with no transfer yet, ${w.inFlight.rig} signed/sent by the rig${est}.${unw}`
  );
}

/** Highlight and the amount just counted, when a new payment is counted or the balance changes. */
function usePulse(w: SellerWallet | null, now: number): { hot: boolean; delta: string | null } {
  const lastHash = w?.recent[0]?.hash ?? null;
  const lastAmount = w?.recent[0]?.amount ?? null;
  const balance = w?.balance.amount ?? null;
  const seen = useRef<{ hash: string | null; balance: string | null } | null>(null);
  const [pulse, setPulse] = useState<{ until: number; delta: string | null }>({ until: 0, delta: null });
  useEffect(() => {
    const prev = seen.current;
    seen.current = { hash: lastHash, balance };
    if (prev === null) return; // the first figures after loading are not news
    const newPayment = lastHash !== null && lastHash !== prev.hash;
    if (newPayment || balance !== prev.balance) {
      setPulse((p) => ({ until: Date.now() + PULSE_MS, delta: newPayment ? lastAmount : p.delta }));
    }
  }, [lastHash, lastAmount, balance]);
  return { hot: now < pulse.until, delta: pulse.delta };
}

export type Books = { agreePct: number | null; decided: number | null; gaps: number | null };

/** One Seller Wallet row. `wallet` null = no Seller Wallet yet (waiting for near-watch, or no pay-to watched). */
export function SellerWalletRow({ live, now, wallet: w, books }: { live: LiveState; now: number; wallet: SellerWallet | null; books: Books | null }) {
  const pulse = usePulse(w, now);
  const token = w?.asset.code ?? "";
  const win = w ? `last ${Math.round(w.window.sec / 60)} min` : "last window";
  const last = w?.recent[0] ?? null;
  const lastAt = last ? (last.blockTimeMs ?? last.firstSeenMs) : null;
  return (
    <div className="swrow">
      <div className={`kpi swcard main${pulse.hot ? " hot" : ""}`} title={w ? tooltip(w, now) : undefined}>
        <span>
          Seller wallet{token ? ` · ${token}` : ""} <Measured />
          {w ? (
            <small className="swaddr" title={w.address}>
              {w.label} · {account(w.address)} · {w.network}
            </small>
          ) : null}
        </span>
        <strong className="gold">
          {w ? decimals(w.balance.amount) : "—"}
          <small>{token}</small>
          {pulse.hot && pulse.delta ? <b className="kdelta">+{decimals(pulse.delta)}</b> : null}
        </strong>
        {w ? (
          <>
            <em className="swgain">
              +{decimals(w.window.amount)} {token} {win}
              {w.balance.registered === false ? " · not registered with the token contract" : ""}
            </em>
            <div className="swminis">
              <div>
                <span>NEAR</span>
                <b>{decimals(w.balance.near)}</b>
                <em>storage + gas</em>
              </div>
              <div>
                <span>Received</span>
                <b className="ok">{decimals(w.received.amount)}</b>
                <em>{w.received.count} paid</em>
                {(() => { const s = attestShare(live.jobs, w.network); return s.paidJobs ? <em title="Of the paid tab 03 jobs near-watch holds: the money of those whose NEAR AI step was attested (private-ai ca-attest). Bedrock / local jobs have no enclave proof.">of tab 03 jobs: {usdcOf(s.attestedBase)} of {usdcOf(s.paidBase)} for AI-verified jobs ({s.attestedJobs}/{s.paidJobs}{s.pendingJobs ? ` · ${s.pendingJobs} pending` : ""})</em> : null; })()}
              </div>
              <div>
                <span>In flight</span>
                <b className="warn">{decimals(w.inFlight.amount)}</b>
                <em>{w.inFlight.estimated ? `${w.inFlight.count} · incl. estimate` : `${w.inFlight.count} in flight`}</em>
              </div>
              <div>
                <span>Expected</span>
                <b>{decimals(w.expected)}</b>
                <em>received + in flight</em>
              </div>
            </div>
            <em className="swlast">{last && lastAt !== null ? `last +${decimals(last.amount)} ${token} from ${last.label ?? account(last.from)} · ${age(now - lastAt)} ago` : "no transfer from a watched buyer yet"}</em>
          </>
        ) : (
          <em className="swlast">{live.hasHello ? "near-watch sends no Seller Wallet (no pay-to watched)" : "waiting for near-watch…"}</em>
        )}
      </div>
      <div className="kpi swcard">
        <span>Active buyers · {w?.network ?? "—"}</span>
        <strong>
          {w ? w.window.buyers : "—"}
          <small>of {w ? w.buyers.length : "—"}</small>
        </strong>
        <em>
          paid {token} in {win}
        </em>
      </div>
      <div className="kpi swcard">
        <span>
          Payments <Measured />
        </span>
        <strong>{w ? w.window.count : "—"}</strong>
        <em>final blocks · {win}</em>
      </div>
      <div className="kpi swcard">
        <span>
          {token || "Token"} received <Measured />
        </span>
        <strong className="gold">{w ? decimals(w.window.amount) : "—"}</strong>
        <em>ft_transfer amount · {win}</em>
      </div>
      <div className="kpi swcard">
        <span>Books agree</span>
        {books ? (
          <>
            <strong className={books.gaps ? "warn" : "ok"}>{books.agreePct !== null ? `${books.agreePct}%` : "—"}</strong>
            <em>{books.decided !== null && books.gaps !== null ? `${books.decided - books.gaps} of ${books.decided} · ${books.gaps} gap${books.gaps === 1 ? "" : "s"}` : "no payment judged yet"}</em>
          </>
        ) : (
          <>
            <strong className="muted">—</strong>
            <em>no reconcile figures yet (/api/metrics)</em>
          </>
        )}
      </div>
    </div>
  );
}

/** Reconcile state of a payment, honestly: only x402 transfers from watched buyers are reconciled against claims. */
function booksOf(live: LiveState, network: string, p: SellerPayment): { text: string; cls: string; title?: string } {
  if (!p.watched) return { text: "unwatched · not counted", cls: "muted" };
  if (!p.isX402) return { text: "manual · not reconciled", cls: "muted", title: "no paywall claim exists for a transfer made outside x402" };
  const r = live.recon[txKey(network, p.hash)];
  if (!r) return { text: "—", cls: "muted", title: "no reconcile state for this transfer in this session (paid before reconciling started, or not yet judged)" };
  return { text: r.state.replace(/_/g, " "), cls: `st ${r.state}`, title: r.detail ?? undefined };
}

function PaymentsTable({ live, w, rows, links }: { live: LiveState; w: SellerWallet; rows: SellerPayment[]; links: (hash: string) => Links | null }) {
  return (
    <div className="tw">
      <table>
        <thead>
          <tr>
            <th>Time (UTC)</th>
            <th>From</th>
            <th>Kind</th>
            <th className="r">{w.asset.code}</th>
            <th>Memo</th>
            <th>Block</th>
            <th>First road</th>
            <th>Tx</th>
            <th>Books</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const l = links(p.hash);
            const b = booksOf(live, w.network, p);
            const at = p.blockTimeMs ?? p.firstSeenMs;
            return (
              <tr key={p.hash}>
                <td title={`block time · ${new Date(at).toISOString()}`}>{stamp(at)}</td>
                <td title={p.from}>
                  <Ext href={l?.account}>{p.label ?? account(p.from)}</Ext>
                </td>
                <td>
                  <b className={`badge ${p.isX402 ? "x402" : "manual"}`}>{p.isX402 ? "x402" : "manual"}</b>
                </td>
                <td className="r gold" title={`${p.units} base units`}>
                  {decimals(p.amount)}
                </td>
                <td className="muted" title={p.memo ?? undefined}>
                  {p.memo ? short(p.memo, 8, 4) : "—"}
                </td>
                <td>{blockHeight(p.blockHeight)}</td>
                <td>
                  <span className="via">
                    <Via road={p.firstVia} />
                  </span>
                </td>
                <td>
                  <Ext href={l?.tx} title={`${w.network} · ${p.hash}`}>
                    {short(p.hash, 6, 4)}
                    {l?.tx ? " ↗" : ""}
                  </Ext>
                </td>
                <td className={b.cls} title={b.title}>
                  {b.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Explorer links by hash from the live transfers (near-watch decorates every tx entry); never built here. */
const liveLinks = (live: LiveState, network: string) => (hash: string): Links | null => live.txs.find((x) => x.key === txKey(network, hash))?.links ?? null;

export function SellerPayments({ live, wallet: w }: { live: LiveState; wallet: SellerWallet | null }) {
  const rows = w?.recent ?? [];
  const token = w?.asset.code ?? "";
  return (
    <div className="panel swpays">
      <h3>
        Recent {token} payments to seller{w ? ` · ${w.network}` : ""}{" "}
        <small>{w ? `final · newest first · ${w.received.count} counted${w.unwatched.count ? ` · ${w.unwatched.count} from unwatched accounts, not counted` : ""}` : "—"}</small>
      </h3>
      {!w || rows.length === 0 ? <div className="empty">No final {token} transfer from a watched buyer into this pay-to yet.</div> : <PaymentsTable live={live} w={w} rows={rows} links={liveLinks(live, w.network)} />}
    </div>
  );
}

/** The Seller wallet tab: every pay-to with its figures, every watched buyer, recent counted and unwatched transfers. */
export function SellerWalletTab({ live, now, wallets, books, x402Net }: { live: LiveState; now: number; wallets: SellerWallet[]; books: Books | null; x402Net: string | null }) {
  // Older transfers' explorer links: /api/txs carries them for rows that are no longer in the live list.
  const rest = usePoll<{ txs: SnapshotTx[] }>("/api/watch/txs?limit=500", 15_000);
  const all = mergeTxs(live.txs, rest.data?.txs ?? []);
  const linksFor = (network: string) => (hash: string): Links | null => all.find((t) => t.key === txKey(network, hash))?.links ?? null;
  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow">Seller wallet · near-watch src/seller.ts · measured on final blocks</div>
          <h2 className="q">What did the seller actually receive?</h2>
        </div>
      </div>
      {rest.error && <div className="empty bad">Explorer links for older rows not loaded: {rest.error}</div>}
      {wallets.length === 0 ? (
        <SellerWalletRow live={live} now={now} wallet={null} books={null} />
      ) : (
        wallets.map((w) => (
          <div key={`${w.network}:${w.address}`} className="col">
            <SellerWalletRow live={live} now={now} wallet={w} books={w.network === x402Net ? books : null} />
            <div className="panel">
              <h3>
                Buyers · {w.network} <small>{w.buyers.length} watched · received is every counted transfer, x402 and manual</small>
              </h3>
              {w.buyers.length === 0 ? (
                <div className="empty">near-watch watches no buyer account (--watch label=buyer=account).</div>
              ) : (
                <div className="tw">
                  <table>
                    <thead>
                      <tr>
                        <th>Buyer</th>
                        <th>Account</th>
                        <th className="r">received {w.asset.code}</th>
                        <th className="r">paid</th>
                        <th className="r">x402</th>
                        <th className="r">manual</th>
                        <th className="r">in flight</th>
                        <th>last paid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {w.buyers.map((b) => (
                        <tr key={b.address}>
                          <td>
                            <b>{b.label}</b>
                          </td>
                          <td title={b.address}>{account(b.address)}</td>
                          <td className="r gold">{decimals(b.received)}</td>
                          <td className="r">{b.count}</td>
                          <td className="r">{b.x402Count}</td>
                          <td className="r">{b.manualCount}</td>
                          <td className="r">{b.inFlightCount > 0 ? `${decimals(b.inFlight)} · ${b.inFlightCount}` : "—"}</td>
                          <td>{b.lastMs !== null ? `${age(now - b.lastMs)} ago` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="panel swpays">
              <h3>
                Recent counted payments <small>newest first · {w.received.count} counted since block {blockHeight(w.received.fromBlock)}</small>
              </h3>
              {w.recent.length === 0 ? <div className="empty">No counted transfer yet.</div> : <PaymentsTable live={live} w={w} rows={w.recent} links={linksFor(w.network)} />}
            </div>
            <div className="panel swpays">
              <h3>
                From unwatched accounts · not counted{" "}
                <small>
                  {w.unwatched.count} transfer(s) · {decimals(w.unwatched.amount)} {w.asset.code}
                </small>
              </h3>
              {w.unwatched.recent.length === 0 ? <div className="empty">None.</div> : <PaymentsTable live={live} w={w} rows={w.unwatched.recent} links={linksFor(w.network)} />}
            </div>
          </div>
        ))
      )}
      <div className="inset read-me">
        <strong>Counting rule</strong>
        <ul>
          <li>
            <b>Counted:</b> a successful NEP-141 transfer of the watched token into the pay-to, from a watched buyer, in a final block.
          </li>
          <li>
            <b>x402:</b> <code>ft_transfer</code> with exactly one transfer event (no memo needed: the x402 NEAR scheme sends none). Anything else from a buyer is
            <i> manual</i>.
          </li>
          <li>
            <b>Other accounts:</b> their transfers are listed here and never counted.
          </li>
          <li>
            <b>In flight:</b> paywall claims with no transfer yet, plus rig calls signed or sent (estimated at <code>--call-price</code> when{" "}
            <code>--inflight-estimate</code> is on).
          </li>
        </ul>
        <p className="src">Source: near-watch src/seller.ts, DESIGN §5.1</p>
      </div>
    </section>
  );
}
