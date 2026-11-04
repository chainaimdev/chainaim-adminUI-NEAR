/**
 * Token amounts. On chain an amount is an integer count of base units (USDC on NEAR: 6 decimals,
 * read from the contract's ft_metadata); people read a decimal string. Both are strings in transit and
 * `bigint` while computing: never floating point.
 */

export class MoneyError extends Error {}

const UNITS = /^\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A non-negative integer base-unit string, normalised (no leading zeros). Throws MoneyError otherwise. */
export function parseUnits(v: unknown, field = "amount"): string {
  if (typeof v !== "string" || !UNITS.test(v) || v.length > 78) throw new MoneyError(`${field} must be an integer string of base units`);
  return BigInt(v).toString();
}

export const isUnits = (v: unknown): v is string => typeof v === "string" && UNITS.test(v) && v.length <= 78;

/** Base units to a decimal string: formatUnits("10000", 6) = "0.01"; trailing zeros dropped. */
export function formatUnits(units: string | bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new MoneyError(`decimals ${decimals} out of range`);
  let n = typeof units === "bigint" ? units : BigInt(parseUnits(units));
  const neg = n < 0n;
  if (neg) n = -n;
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** A decimal string to base units: toUnits("0.01", 6) = "10000". More fraction digits than `decimals` is an error. */
export function toUnits(decimal: string, decimals: number): string {
  if (typeof decimal !== "string" || !DECIMAL.test(decimal) || decimal.startsWith("-")) throw new MoneyError(`${decimal} is not a non-negative decimal`);
  const [w, f = ""] = decimal.split(".");
  if (f.length > decimals) throw new MoneyError(`${decimal} has more than ${decimals} decimal places`);
  return (BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0")).toString();
}

export function sumUnits(values: readonly string[]): string {
  let t = 0n;
  for (const v of values) t += BigInt(v);
  return t.toString();
}

export function compareUnits(a: string, b: string): -1 | 0 | 1 {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
