"use client";
/**
 * The payment-flow map (ported from liveops admin-console components/flow-canvas.tsx), driven only by near-watch events:
 *   trace step 1 (quoted)       grey dot   buyer → paywall          reported by the rig
 *   trace step 3 (sent)         blue dot   paywall → NEAR           reported by the rig
 *   tx (x402 into pay-to)       gold dot   NEAR → payTo             measured (final-block transfer row)
 *   tx / road                   lane dot   NEAR → near-watch, on the lane of the road that delivered it
 *                               (tx = the road that won; road = a later road, recorded but not counted twice)
 *   ledger                      the NEAR node pulses on each final block, "+N" = our x402 transfers in it
 * Lanes: neardata, qn-rpc, rpc (backfill arrivals ride the rpc lane in grey). A lane is drawn live, down or unknown from
 * /api/feeds roads. Nothing is scheduled or invented: no event, no dot.
 * Changed from liveops: no t54 facilitator node (XRPL only); three road lanes instead of push / webhook / poll.
 */
import { useEffect, useRef } from "react";
import type { LiveListener } from "../hooks/use-live.ts";
import { blockHeight, decimals, short } from "../lib/format.ts";
import type { FeedsNetwork, LedgerEvent, Road, RoadEvent, TraceEvent, TxEvent, WatchEntry } from "../lib/types.ts";

type Lane = "neardata" | "qn-rpc" | "rpc";
const LANES: readonly Lane[] = ["neardata", "qn-rpc", "rpc"];
const laneOf = (via: Road): Lane => (via === "backfill" ? "rpc" : via);

export type FlowProps = {
  network: string;
  buyers: WatchEntry[];
  payTo: WatchEntry | null;
  payToBalance: string | null;
  token: string;
  lastBlock: number | null;
  feeds: FeedsNetwork | null;
  subscribe: (fn: LiveListener) => () => void;
};

type Pt = { x: number; y: number };
type Particle = { pts: Pt[]; t0: number; dur: number; color: string; r: number; glow: boolean };

export function FlowCanvas(props: FlowProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const live = useRef(props);
  live.current = props;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const cx = cv.getContext("2d");
    if (!cx) return;
    let W = 0;
    let H = 0;
    let N: Record<string, Pt & { l: string; s: string }> = {};
    const pos = new Map<string, Pt>();
    let P: Particle[] = [];
    let blockPulse = 0;
    let blockBatch = 0;
    let accFlash = 0;
    let dupFlash = 0;
    let C: Record<string, string> = {};
    let raf = 0;
    const css = (v: string): string => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    const readColors = (): void => {
      C = Object.fromEntries(["text", "text2", "muted", "line", "line2", "accent", "accent2", "gold", "ok", "warn", "bad", "panel", "blue"].map((k) => [k, css(`--${k}`)]));
    };
    const layout = (): void => {
      const r = cv.getBoundingClientRect();
      const d = window.devicePixelRatio || 1;
      W = r.width;
      H = r.height;
      cv.width = W * d;
      cv.height = H * d;
      cx.setTransform(d, 0, 0, d, 0, 0);
      const m = W < 640;
      const list = live.current.buyers;
      pos.clear();
      list.forEach((b, i) => pos.set(b.address, { x: m ? 28 : 46, y: 30 + (H - 60) * (list.length === 1 ? 0.5 : i / Math.max(1, list.length - 1)) }));
      N = {
        pay: { x: W * (m ? 0.36 : 0.32), y: H * 0.38, l: "x402 paywall", s: "NEAR USDC rail" },
        led: { x: W * 0.58, y: H * 0.6, l: `NEAR ${live.current.network}`, s: "" },
        to: { x: W * (m ? 0.86 : 0.88), y: H * 0.2, l: "payTo", s: live.current.payTo ? short(live.current.payTo.address, 10, 6) : "—" },
        nw: { x: W * (m ? 0.84 : 0.88), y: H * 0.88, l: "near-watch", s: "first road wins · SQLite · SSE" },
      };
    };
    const lanePts = (v: Lane): Pt[] => {
      const a = N.led;
      const b = N.nw;
      const off = v === "neardata" ? -60 : v === "qn-rpc" ? 0 : 60;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      const mx = (a.x + b.x) / 2 + (-dy / L) * off * 1.4;
      const my = (a.y + b.y) / 2 + (dx / L) * off * 1.4;
      const pts: Pt[] = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        pts.push({ x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mx + t * t * b.x, y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * my + t * t * b.y });
      }
      return pts;
    };
    const along = (pts: Pt[], f: number): Pt => {
      const seg: number[] = [];
      let L = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        seg.push(d);
        L += d;
      }
      let x = f * L;
      for (let i = 0; i < seg.length; i++) {
        if (x <= seg[i]) {
          const t = seg[i] ? x / seg[i] : 0;
          return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
        }
        x -= seg[i];
      }
      return pts[pts.length - 1];
    };
    const add = (pts: Pt[], dur: number, color: string, r: number, glow: boolean): void => {
      if (P.length < 400) P.push({ pts, t0: performance.now(), dur, color, r, glow });
    };
    const laneColor = (l: Lane): string => (l === "neardata" ? C.ok : l === "qn-rpc" ? C.accent2 : C.warn);
    const roadColor = (via: Road): string => (via === "backfill" ? C.muted : laneColor(via));
    const buyerPt = (t: TraceEvent["trace"]): Pt | null => {
      const byPayer = t.payer ? pos.get(t.payer) : undefined;
      if (byPayer) return byPayer;
      const w = live.current.buyers.find((b) => b.label === t.tenant);
      return w ? (pos.get(w.address) ?? null) : null;
    };

    const onEvent: LiveListener = (name, data) => {
      const net = live.current.network;
      if (name === "trace") {
        const t = (data as TraceEvent | undefined)?.trace;
        if (!t || (t.network !== null && t.network !== net)) return;
        const from = buyerPt(t);
        if (t.step === 1 && from) add([from, N.pay], 650, C.text2, 3, false);
        if (t.step === 3) add([N.pay, N.led], 900, C.blue, 4, true);
      } else if (name === "tx") {
        const e = data as TxEvent | undefined;
        if (!e?.row || (e.network ?? e.row.network) !== net) return;
        const pay = live.current.payTo?.address;
        if (e.row.isX402 && e.row.status === "success" && pay && e.row.to === pay) add([N.led, N.to], 800, C.gold, 5, true);
        add(lanePts(laneOf(e.via)), e.via === "neardata" ? 380 : 900, roadColor(e.via), 3.5, true);
        accFlash = performance.now();
      } else if (name === "road") {
        const e = data as RoadEvent | undefined;
        if (!e || e.network !== net) return;
        add(lanePts(laneOf(e.via)), 900, roadColor(e.via), 3, true);
        dupFlash = performance.now();
      } else if (name === "ledger") {
        const e = data as LedgerEvent | undefined;
        if (!e || e.network !== net) return;
        blockPulse = performance.now();
        blockBatch = e.ourCount;
      }
    };

    const rr = (x: number, y: number, w: number, h: number, r: number): void => {
      cx.beginPath();
      cx.moveTo(x + r, y);
      cx.arcTo(x + w, y, x + w, y + h, r);
      cx.arcTo(x + w, y + h, x, y + h, r);
      cx.arcTo(x, y + h, x, y, r);
      cx.arcTo(x, y, x + w, y, r);
      cx.closePath();
    };
    const line = (pts: Pt[], color: string, w: number, dash: number[] = []): void => {
      cx.beginPath();
      cx.setLineDash(dash);
      cx.strokeStyle = color;
      cx.lineWidth = w;
      pts.forEach((p, i) => (i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y)));
      cx.stroke();
      cx.setLineDash([]);
    };
    const node = (n: Pt & { l: string; s: string }, color?: string, extra?: string): void => {
      cx.font = '10px "IBM Plex Mono"';
      const sub = extra ?? n.s;
      const w = Math.max(132, cx.measureText(sub).width + 26);
      const h = 44;
      cx.fillStyle = C.panel;
      cx.strokeStyle = color ?? C.line;
      cx.lineWidth = 1.2;
      rr(n.x - w / 2, n.y - h / 2, w, h, 9);
      cx.fill();
      cx.stroke();
      cx.fillStyle = C.text;
      cx.font = '600 12px "Instrument Sans"';
      cx.textAlign = "center";
      cx.fillText(n.l, n.x, n.y - 3);
      cx.fillStyle = C.muted;
      cx.font = '10px "IBM Plex Mono"';
      cx.fillText(sub, n.x, n.y + 12);
    };
    /** on = the road is live; false = selected but not live (or not running); null = no /api/feeds yet. */
    const laneState = (f: FeedsNetwork | null, l: Lane): boolean | null => {
      if (!f) return null;
      const r = f.roads.find((x) => x.road === l);
      return r ? r.state === "live" && !r.reset : false;
    };
    const draw = (): void => {
      const t = performance.now();
      const p = live.current;
      cx.clearRect(0, 0, W, H);
      for (const b of p.buyers) {
        const at = pos.get(b.address);
        if (at) line([at, N.pay], C.line2, 1);
      }
      line([N.pay, N.led], C.line, 1.4);
      line([N.led, N.to], C.line, 1.4);
      for (const l of LANES) {
        const on = laneState(p.feeds, l);
        const col = laneColor(l);
        const pts = lanePts(l);
        line(pts, on ? `${col}66` : C.line2, on ? 2 : 1, on === true ? (l === "neardata" ? [] : [4, 5]) : [3, 6]);
        const mid = pts[12];
        cx.fillStyle = on ? col : C.muted;
        cx.font = '600 10px "IBM Plex Mono"';
        cx.textAlign = "right";
        cx.fillText(l + (on === false ? " ✕" : on === null ? " ?" : ""), mid.x - 8, mid.y - 5);
      }
      cx.save();
      P = P.filter((q) => {
        const f = (t - q.t0) / q.dur;
        if (f >= 1) return false;
        const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
        const at = along(q.pts, e);
        cx.shadowColor = q.color;
        cx.shadowBlur = q.glow ? 14 : 0;
        cx.fillStyle = q.color;
        cx.beginPath();
        cx.arc(at.x, at.y, q.r, 0, 7);
        cx.fill();
        return true;
      });
      cx.restore();
      node(N.pay);
      const lp = Math.max(0, 1 - (t - blockPulse) / 900);
      if (lp > 0) {
        cx.save();
        cx.strokeStyle = C.gold;
        cx.globalAlpha = lp;
        cx.lineWidth = 2;
        rr(N.led.x - 66 - 14 * (1 - lp), N.led.y - 22 - 14 * (1 - lp), 132 + 28 * (1 - lp), 44 + 28 * (1 - lp), 12);
        cx.stroke();
        cx.restore();
      }
      node(N.led, lp > 0 ? C.gold : C.line, `final block ${blockHeight(p.lastBlock)}${lp > 0 && blockBatch ? ` · +${blockBatch} x402` : ""}`);
      node(N.to, C.gold, p.payToBalance !== null ? `${decimals(p.payToBalance)} ${p.token} (measured)` : N.to.s);
      const af = Math.max(0, 1 - (t - accFlash) / 700);
      const df = Math.max(0, 1 - (t - dupFlash) / 700);
      node(N.nw, af > 0 ? C.ok : df > 0 ? C.muted : C.line, df > 0 && af <= 0 ? "later road recorded" : N.nw.s);
      cx.fillStyle = C.muted;
      cx.font = '10px "IBM Plex Mono"';
      cx.textAlign = "right";
      cx.fillText("→ console (SSE)", N.nw.x + 66, N.nw.y + 36);
      for (const b of p.buyers) {
        const at = pos.get(b.address);
        if (!at) continue;
        cx.fillStyle = C.accent;
        cx.beginPath();
        cx.arc(at.x, at.y, 8, 0, 7);
        cx.fill();
        cx.fillStyle = C.text;
        cx.font = '600 11px "IBM Plex Mono"';
        cx.textAlign = "left";
        cx.fillText(b.label, at.x + 16, at.y + 4);
      }
      raf = requestAnimationFrame(draw);
    };

    readColors();
    layout();
    const ro = new ResizeObserver(() => layout());
    ro.observe(cv);
    const mo = new MutationObserver(() => readColors());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const off = props.subscribe(onEvent);
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      off();
    };
    // Layout depends on the buyer list and network; the rest is read live through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.subscribe, props.network, props.buyers.map((b) => b.address).join(",")]);

  return <canvas ref={ref} className="flow" aria-label={`Payment flow on NEAR ${props.network}: animated from live near-watch events`} />;
}
