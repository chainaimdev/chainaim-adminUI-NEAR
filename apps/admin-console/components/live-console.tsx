"use client";
/**
 * The NEAR Live Ops console (ported from liveops admin-console components/live-console.tsx): header (feed chips,
 * pay-to balance, theme), tabs, and the shared data:
 *   /api/watch/stream    every live event (hooks/use-live.ts)
 *   /api/watch/metrics   every 10 s, KPIs (hello carries a first copy)
 *   /api/watch/feeds     every 5 s, flow lanes, token decimals, Feeds tab
 * Tabs (DESIGN §5): Live ops · Ledger · Reconcile · Jobs (paid jobs, architecture-adminui-jobs.md ARCH-210) · Feeds · Seller wallet. liveops' Lending tab is dropped (XRPL Devnet
 * lending has no NEAR counterpart). The selected tab is kept in the URL (#reconcile, …) so a link opens the same view.
 */
import { useEffect, useState } from "react";
import { useLive, useNow, type Conn } from "../hooks/use-live.ts";
import { usePoll } from "../hooks/use-poll.ts";
import { kpis, buyers, payToOf, sellerWallets, tokenOf, x402Network } from "../lib/derive.ts";
import { clock, decimals, DISPLAY_TIME_ZONE } from "../lib/format.ts";
import { tokenDecimals, type LiveState } from "../lib/live-store.ts";
import type { FeedsReport, Metrics } from "../lib/types.ts";
import { FeedChips } from "./feed-chips.tsx";
import { SellerWalletTab } from "./seller-wallet.tsx";
import { FeedsTab } from "./tabs/feeds.tsx";
import { JobsTab } from "./tabs/jobs.tsx";
import { LedgerTab } from "./tabs/ledger.tsx";
import { LiveOpsTab } from "./tabs/live-ops.tsx";
import { ReconcileTab } from "./tabs/reconcile.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

export const TABS = ["Live ops", "Ledger", "Reconcile", "Jobs", "Feeds", "Seller wallet"] as const;
type Tab = (typeof TABS)[number];
const slug = (t: Tab): string => t.toLowerCase().replace(/\s+/g, "-");
const fromHash = (h: string): Tab => TABS.find((t) => `#${slug(t)}` === h) ?? "Live ops";

function Session({ live, conn }: { live: LiveState; conn: Conn }) {
  const applied = Object.entries(live.stats.applied);
  const ignored = Object.entries(live.stats.ignored);
  return (
    <div className="inset">
      <strong>This console session</strong>
      near-watch {live.version ?? "—"}, started {clock(live.startedAt)} · events received: {applied.length === 0 ? "none" : applied.map(([k, v]) => `${k} ${v}`).join(", ")}
      {ignored.length > 0 && <> · unknown events ignored: {ignored.map(([k, v]) => `${k} ${v}`).join(", ")}</>}
      {live.stats.errors > 0 && (
        <>
          {" "}
          · <b style={{ color: "var(--bad)" }}>refused {live.stats.errors}</b> (last: {live.stats.lastError})
        </>
      )}
      {conn.reason && <> · stream: {conn.reason}</>}
    </div>
  );
}

export function LiveConsole() {
  const { live, conn, subscribe } = useLive();
  const now = useNow(1000);
  const [tab, setTab] = useState<Tab>("Live ops");
  const metricsPoll = usePoll<Metrics>("/api/watch/metrics", 10_000, live.hasHello);
  const feedsPoll = usePoll<FeedsReport>("/api/watch/feeds", 5000, live.hasHello);
  const metrics = metricsPoll.data ?? live.metrics;
  const feeds = feedsPoll.data;

  useEffect(() => {
    const sync = (): void => setTab(fromHash(window.location.hash));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const go = (t: string): void => {
    const next = TABS.find((x) => x === t) ?? "Live ops";
    window.location.hash = slug(next);
    setTab(next);
  };

  const net = x402Network(live);
  const token = tokenOf(live, net);
  const payTo = net ? payToOf(live, net)[0] : undefined;
  const payBal = payTo ? live.balances.find((b) => b.address === payTo.address && b.network === payTo.network) : undefined;
  /** Token decimals for base-unit claim amounts: /api/feeds token.decimals, else the Seller Wallet's asset.decimals. */
  const decimalsOf = (network: string): number | null => feeds?.networks[network]?.token.decimals ?? tokenDecimals(live, network);
  const k = kpis(live, now, metrics, buyers(live, now, metrics));
  const books = { agreePct: k.reconDecided && k.reconDecided > 0 && k.reconGaps !== null ? Math.round((100 * (k.reconDecided - k.reconGaps)) / k.reconDecided) : null, decided: k.reconDecided, gaps: k.reconGaps };

  return (
    <>
      <header className="top">
        <div className="brand">
          <div className="mark">CA</div>
          <h1>
            ChainAim NEAR <small>· Live Ops</small>
          </h1>
        </div>
        <FeedChips live={live} conn={conn} now={now} />
        <div className="hright">
          {payTo && (
            <span title={`${payTo.label} ${payTo.address} · ${net} · measured`}>
              payTo <b style={{ color: "var(--gold)" }}>{payBal?.asset.value != null ? decimals(payBal.asset.value) : "—"}</b> {token}
            </span>
          )}
          <ThemeToggle />
        </div>
      </header>
      <nav className="tabs" aria-label="Views">
        <span className="navclock" title={`The current time in ${DISPLAY_TIME_ZONE}, from this computer's clock. Every other time is the event's block time (or when near-watch saw it).`}>
          Now <b suppressHydrationWarning>{clock(now)}</b>
        </span>
        {TABS.map((t) => (
          <button type="button" key={t} className={t === tab ? "active" : ""} onClick={() => go(t)} aria-current={t === tab ? "page" : undefined}>
            {t}
          </button>
        ))}
      </nav>
      <main className="page">
        {!live.hasHello ? (
          <div className={conn.state === "down" ? "empty bad" : "empty"} role="status">
            {conn.state === "down" ? `No data: ${conn.reason ?? "the stream is down"}. Retrying.` : "Waiting for near-watch's first message (hello)…"}
          </div>
        ) : tab === "Live ops" ? (
          <LiveOpsTab live={live} now={now} metrics={metrics} feeds={feeds} subscribe={subscribe} go={go} />
        ) : tab === "Ledger" ? (
          <LedgerTab live={live} />
        ) : tab === "Reconcile" ? (
          <ReconcileTab live={live} decimalsOf={decimalsOf} grace={Object.fromEntries(Object.entries(feeds?.networks ?? {}).map(([n, f]) => [n, f.reconcile]))} />
        ) : tab === "Jobs" ? (
          <JobsTab live={live} decimalsOf={decimalsOf} />
        ) : tab === "Feeds" ? (
          <FeedsTab live={live} feeds={feeds} error={feedsPoll.error} now={now} />
        ) : (
          <SellerWalletTab live={live} now={now} wallets={sellerWallets(live)} books={metrics ? books : null} x402Net={net} />
        )}
        {(metricsPoll.error || feedsPoll.error) && live.hasHello && (
          <div className="empty bad">
            {metricsPoll.error && `metrics: ${metricsPoll.error}. `}
            {feedsPoll.error && `feeds: ${feedsPoll.error}.`}
          </div>
        )}
        <Session live={live} conn={conn} />
        <div className="inset">
          <strong>Privacy boundary</strong>
          This console sees money, routes and chain ids only — never prompts, answers, decision ids or restore maps. near-watch&apos;s address, RPC / QuickNode endpoints and admin
          keys stay on the console&apos;s server; this page talks to /api/watch only and is told road names and redacted hosts, never URLs with tokens.
        </div>
      </main>
    </>
  );
}
