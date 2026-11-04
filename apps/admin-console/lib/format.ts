/**
 * Display helpers (ported from liveops admin-console lib/format.ts). Money is never converted to a float: decimal
 * strings are shown as near-watch sent them, and base units (claim amounts) are turned into decimals with bigint.
 */
import type { Road } from "./types.ts";

/** near-stocks.testnet -> "near-…stnet" for long account ids and hashes; short strings unchanged. */
export function short(s: string, head = 5, tail = 4): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

/** A NEAR account id: kept whole up to `max` characters (named accounts are read by people), else shortened. */
export function account(s: string | null | undefined, max = 28): string {
  if (!s) return "—";
  return s.length <= max ? s : short(s, 8, 6);
}

/** 270414460 -> "270,414,460" (fixed locale so server and browser render the same text). */
export function blockHeight(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

/**
 * A duration in ms as "0.4 s", "12 s", "3 min", "2 h". A small negative value (an event stamped a moment after
 * the page's last clock tick, or a few ms of clock difference between near-watch and this browser) reads as 0.
 */
export function age(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 0) ms = 0;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

/** A decimal string as sent, or "—". */
export function money(v: string | null | undefined): string {
  return typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? v : "—";
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const UNITS = /^\d{1,78}$/;

/** Exact sum of decimal strings (no floating point); invalid entries are skipped. "0" for none. */
export function sumDecimal(values: readonly (string | null | undefined)[]): string {
  const parsed = values.flatMap((v) => {
    const m = typeof v === "string" ? DECIMAL.exec(v) : null;
    return m ? [{ neg: m[1] === "-", int: m[2], frac: m[3] ?? "" }] : [];
  });
  const scale = Math.max(0, ...parsed.map((p) => p.frac.length));
  let total = 0n;
  for (const p of parsed) {
    const n = BigInt(p.int + p.frac.padEnd(scale, "0"));
    total += p.neg ? -n : n;
  }
  const neg = total < 0n;
  const digits = (neg ? -total : total).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = scale > 0 ? digits.slice(digits.length - scale).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/**
 * Base units (an integer string, e.g. a claim's x402 `amount`) as a decimal string with `decimals` token decimals,
 * by bigint: unitsToDecimal("10000", 6) = "0.01". null when the input is not base units or decimals is unknown, so a
 * figure is never shown in the wrong scale.
 */
export function unitsToDecimal(units: string | null | undefined, decimals: number | null | undefined): string | null {
  if (typeof units !== "string" || !UNITS.test(units)) return null;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const n = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const frac = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${n / base}${frac ? `.${frac}` : ""}`;
}

/**
 * Each decimal string's size relative to the largest, from 0 to 1, for drawing bars only. Computed with bigint at a
 * common scale, so no amount is ever parsed as a float; invalid or negative entries read as 0.
 */
export function ratios(values: readonly (string | null | undefined)[]): number[] {
  const parsed = values.map((v) => {
    const m = typeof v === "string" ? DECIMAL.exec(v) : null;
    return m && m[1] === "" ? { int: m[2], frac: m[3] ?? "" } : null;
  });
  const scale = Math.max(0, ...parsed.map((p) => p?.frac.length ?? 0));
  const ints = parsed.map((p) => (p ? BigInt(p.int + p.frac.padEnd(scale, "0")) : 0n));
  const max = ints.reduce((a, b) => (b > a ? b : a), 0n);
  if (max === 0n) return ints.map(() => 0);
  return ints.map((n) => Number((n * 10_000n) / max) / 10_000);
}

/** A decimal string with at least `min` fraction digits (padding only; never rounds a value away). */
export function decimals(v: string | null | undefined, min = 2): string {
  if (typeof v !== "string") return "—";
  const m = DECIMAL.exec(v);
  if (!m) return "—";
  const frac = (m[3] ?? "").padEnd(min, "0");
  return `${m[1]}${BigInt(m[2]).toLocaleString("en-US")}.${frac}`;
}

/**
 * The time zone of every time of day the console shows, on every tab (liveops owner decision 2026-10-30: UTC). A fixed
 * zone also makes the server render and the browser agree, whatever zone the viewer's machine is in.
 */
export const DISPLAY_TIME_ZONE = "UTC";

/** "30 Oct, 06:31:08 UTC": every time on every tab, as date, 24 h time and the zone's name in DISPLAY_TIME_ZONE. */
export function clock(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: DISPLAY_TIME_ZONE, timeZoneName: "short" });
}

/** The same as clock(); kept for the Seller Wallet payments column. */
export const stamp = clock;

/** Upper-case network name for chips: "testnet" -> "TESTNET". */
export const networkLabel = (n: string): string => n.toUpperCase();

/** What each road is (near-watch road names, DESIGN §5.2), for filters and titles. */
export const ROAD_LABELS: Readonly<Record<Road, string>> = {
  neardata: "FastNear neardata long-poll (push-like)",
  "qn-rpc": "QuickNode NEAR JSON-RPC poll",
  rpc: "public NEAR JSON-RPC poll (fallback)",
  backfill: "catch-up from the stored cursor after a (re)start",
};

/** CSS class of a road chip (app/globals.css .via b.*): neardata green, qn-rpc orange, rpc amber, backfill muted. */
export const ROAD_CLASS: Readonly<Record<Road, string>> = { neardata: "push", "qn-rpc": "webhook", rpc: "poll", backfill: "backfill" };

/** CSS colour variable of a road (flow canvas, feed race). */
export const ROAD_COLOR: Readonly<Record<Road, string>> = { neardata: "--ok", "qn-rpc": "--accent2", rpc: "--warn", backfill: "--muted" };
