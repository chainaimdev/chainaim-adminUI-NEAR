/**
 * CAIP-2 chain ids (https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md): `namespace:reference`.
 *
 * The CAIP registry has no ratified NEAR profile yet, but the NEAR ids are fixed by x402: near:testnet / near:mainnet are
 * the only two @x402/near accepts (GATE A5, closed by chainiam-private-ai NEAR-GATES G4). near-watch defaults to them
 * (services/near-watch/src/config.ts NEAR_CAIP2_DEFAULT); this module only checks the syntax.
 */

/** CAIP-2 syntax: namespace [-a-z0-9]{3,8}, reference [-_a-zA-Z0-9]{1,32}. */
export const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

export function isCaip2(v: unknown): v is string {
  return typeof v === "string" && CAIP2.test(v);
}

export function parseCaip2(v: string): { namespace: string; reference: string } {
  if (!isCaip2(v)) throw new Error(`${v} is not a CAIP-2 chain id (namespace:reference)`);
  const i = v.indexOf(":");
  return { namespace: v.slice(0, i), reference: v.slice(i + 1) };
}
