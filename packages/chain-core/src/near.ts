/**
 * NEAR identifiers.
 *   account id   docs.near.org/protocol/accounts-contracts/account-id: 2-64 chars, lowercase a-z, digits,
 *                separators - _ inside a part, parts joined by "."; 64-hex implicit accounts match the same rule.
 *   hash         base58 of 32 bytes (tx hash, block hash, receipt id): 43 or 44 characters, case-sensitive.
 */

export const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isAccountId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT_ID.test(v);
}

export const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export function isNearHash(v: unknown): v is string {
  return typeof v === "string" && BASE58_HASH.test(v);
}

/** yoctoNEAR (10^-24 NEAR) decimals. */
export const NEAR_DECIMALS = 24;
