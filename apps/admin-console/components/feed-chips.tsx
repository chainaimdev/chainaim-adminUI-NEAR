"use client";
/**
 * Header chips (ported from liveops admin-console components/feed-chips.tsx). A network chip shows only what
 * near-watch's `status` says (it applies the stale rule itself): live = green, stale = amber, down = red,
 * connecting = hollow. One small chip per live road (status.feeds: neardata, qn-rpc, rpc) follows it, so a road that
 * dropped out of the race is visible at a glance. While the console's own stream is not open, chips are hollow and
 * say "unknown": the page cannot vouch for data it is not receiving.
 * (liveops' QuickNode STREAM / WEBHOOK chips are dropped: near-watch has no such receivers.)
 */
import type { Conn } from "../hooks/use-live.ts";
import { age, blockHeight, networkLabel } from "../lib/format.ts";
import { lastLedger, type LiveState } from "../lib/live-store.ts";
import type { ProviderState } from "../lib/types.ts";
import { cn } from "../lib/utils.ts";

const DOT: Record<ProviderState, string> = { live: "live", stale: "poll", down: "down", connecting: "off" };

export function FeedChips({ live, conn, now }: { live: LiveState; conn: Conn; now: number }) {
  const online = conn.state === "open";
  return (
    <div className="chips" aria-label="Feed status">
      {live.networks.map((n) => {
        const st = live.status[n];
        const blockAt = st && st.lastLedgerAgeMs !== null ? st.at - st.lastLedgerAgeMs : null;
        const roads = (st?.feeds ?? []).filter((f) => f.road !== "backfill");
        return [
          <div className="chip" key={n} title={st ? `best road ${st.provider} · ${st.providerUrl} · failovers ${st.failovers}` : "no status from near-watch yet"}>
            <span className={cn("dot", online && st ? DOT[st.state] : "off")} />
            <b>NEAR {networkLabel(n)}</b>
            {online && st ? (
              <>
                <span>{st.provider}</span>
                <span className="sep">·</span>
                <span>{st.state}</span>
                <span className="sep">·</span>
                <span>block {blockHeight(lastLedger(live, n))}</span>
                <span className="sep">·</span>
                <span>{blockAt === null ? "no block yet" : `${age(now - blockAt)} ago`}</span>
              </>
            ) : (
              <span>{online ? "waiting for status" : "unknown — console stream not open"}</span>
            )}
          </div>,
          ...roads.map((f) => (
            <div className="chip" key={`${n}-${f.road}`} title={`${f.road} via ${f.provider} · ${f.state}${f.lagBlocks !== null ? ` · ${f.lagBlocks} block(s) behind its tip` : ""} · ${f.errors} error(s)${f.reset ? " · stopped: network reset" : ""}`}>
              <span className={cn("dot", online ? (f.reset ? "down" : DOT[f.state]) : "off")} />
              <b>{f.road}</b>
              <span>{online ? (f.reset ? "reset" : f.state) : "unknown"}</span>
            </div>
          )),
        ];
      })}
      <div className="chip" title={conn.reason ?? "browser ↔ console stream"}>
        <span className={cn("dot", conn.state === "open" ? "live" : conn.state === "down" ? "down" : "poll")} />
        <b>CONSOLE SSE</b>
        <span>
          {conn.state === "open"
            ? conn.lastEventAt === null
              ? "connected"
              : `last event ${age(now - conn.lastEventAt)} ago`
            : conn.state === "down"
              ? `down · retry ${conn.attempts}`
              : conn.state}
        </span>
      </div>
    </div>
  );
}
