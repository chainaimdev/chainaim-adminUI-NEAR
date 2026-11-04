/** Decimal strings without floating point: sums of token values for display (base units stay in chain-core money.ts). */

function split(v: string): [bigint, string] {
  const [w, f = ""] = v.split(".");
  return [BigInt(w), f];
}

export function addDecimal(a: string, b: string): string {
  const [aw, af] = split(a);
  const [bw, bf] = split(b);
  const n = Math.max(af.length, bf.length);
  const scale = 10n ** BigInt(n);
  const total = aw * scale + BigInt(af.padEnd(n, "0") || "0") + bw * scale + BigInt(bf.padEnd(n, "0") || "0");
  if (n === 0) return total.toString();
  const whole = total / scale;
  const frac = (total % scale).toString().padStart(n, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function sumDecimal(values: readonly string[]): string {
  return values.reduce((t, v) => addDecimal(t, v), "0");
}
