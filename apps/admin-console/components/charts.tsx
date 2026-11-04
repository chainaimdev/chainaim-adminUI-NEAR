"use client";
/**
 * Canvas charts in the liveops demo's style (ported from liveops admin-console components/charts.tsx). They draw what
 * they are given; no smoothing, no estimates. Bar heights come from lib/format.ts ratios (bigint), so no amount is
 * parsed as a float.
 */
import { useEffect, useRef } from "react";
import { decimals, ratios } from "../lib/format.ts";
import type { LedgerEvent } from "../lib/types.ts";

function useCanvas(draw: (g: CanvasRenderingContext2D, w: number, h: number, css: (v: string) => string) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const paint = (): void => {
      const d = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      c.width = w * d;
      c.height = h * d;
      const g = c.getContext("2d");
      if (!g) return;
      g.scale(d, d);
      const css = (v: string): string => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      draw(g, w, h, css);
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(c);
    const mo = new MutationObserver(paint);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** Token settled per final block (near-watch `ledger.ourAmount`: our x402 transfers in that block, measured). */
export function ThroughputChart({ ledgers, token }: { ledgers: LedgerEvent[]; token: string }) {
  const last = ledgers.slice(-30);
  const ref = useCanvas(
    (g, w, h, css) => {
      const r = ratios(last.map((l) => l.ourAmount));
      const bw = w / 30;
      g.strokeStyle = css("--line2");
      g.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        g.beginPath();
        g.moveTo(0, (h * i) / 4);
        g.lineTo(w, (h * i) / 4);
        g.stroke();
      }
      r.forEach((v, i) => {
        if (v <= 0) return;
        const bh = Math.max(2, v * (h - 14));
        const grd = g.createLinearGradient(0, h - bh, 0, h);
        grd.addColorStop(0, css("--gold"));
        grd.addColorStop(1, css("--accent2"));
        g.fillStyle = grd;
        g.globalAlpha = i === r.length - 1 ? 1 : 0.8;
        g.fillRect(i * bw + 2, h - bh, bw - 4, bh);
      });
      g.globalAlpha = 1;
      g.fillStyle = css("--muted");
      g.font = '10px "IBM Plex Mono"';
      const top = r.indexOf(1);
      g.fillText(top >= 0 ? `max ${decimals(last[top].ourAmount)} ${token} / block` : `no x402 payment in the last ${last.length} blocks`, 4, 11);
    },
    [token, last.map((l) => `${l.index}:${l.ourAmount}`).join(",")],
  );
  return <canvas ref={ref} className="chart" aria-label={`${token} settled per final block`} />;
}

/** One buyer's recent payments (decimal strings), oldest → newest. */
export function Spark({ values }: { values: string[] }) {
  const ref = useCanvas(
    (g, w, h, css) => {
      const r = ratios(values);
      if (!r.some((v) => v > 0)) return;
      g.fillStyle = css("--accent");
      const bw = w / 24;
      r.forEach((v, i) => {
        const bh = Math.max(2, v * (h - 2));
        g.globalAlpha = 0.35 + 0.65 * (i / r.length);
        g.fillRect(i * bw + 1, h - bh, bw - 2, bh);
      });
    },
    [values.join(",")],
  );
  return <canvas ref={ref} className="spark" aria-hidden="true" />;
}
