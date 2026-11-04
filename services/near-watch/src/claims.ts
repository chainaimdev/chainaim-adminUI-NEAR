/**
 * Claims: what the paywall says it settled. Same contract as ledger-watch: one `payment_settled` JSON line per
 * settled payment (chainiam-private-ai services/paywall/src/app.ts onAfterSettle), sent to POST /ingest/claim or
 * appended to the file this service tails (--paywall-log-file). For the NEAR rail the line's fields are
 * (DESIGN private-ai-NEAR §5.2):
 *   network      the NEAR CAIP-2 id: near:testnet / near:mainnet (near-watch's default, NEAR_CAIP2_<NET> overrides)
 *   transaction  the base58 tx hash            asset  the USDC contract id
 *   amount       x402 requirements.amount = integer base units (6 decimals for USDC)
 *   payer        NEAR account id               invoiceId  the paywall's invoice id (optional; shown, never matched:
 *                                              an x402 NEAR transfer carries no memo, chainiam-private-ai NEAR-GATES G3)
 * Only these fields are kept; anything else on the line is dropped. A line never carries request or answer text.
 */
import { isUnits } from "../../../packages/chain-core/src/money.ts";
import { isAccountId, isNearHash } from "../../../packages/chain-core/src/near.ts";
import { isObj } from "./decode.ts";

/** Invoice ids the paywall issues are 32 uppercase hex characters; anything id-like up to 128 characters is accepted. */
export const INVOICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export { isObj };

const CONTROL = /[\x00-\x1f\x7f]/;

export class IngestError extends Error {}

export type ClaimInput = { network: string; hash: string; invoiceId: string | null; amount: string; asset: string | null; payer: string | null; route: string | null; tsMs: number };

/** CAIP-2 id -> network name, built from config (never defaulted: GATE A5). */
export type CaipMap = Readonly<Record<string, string>>;

export function watchedNetwork(caip: unknown, caips: CaipMap): string {
  if (typeof caip !== "string") throw new IngestError("network must be the NEAR CAIP-2 id");
  const name = caips[caip];
  if (!name) throw new IngestError(`network ${caip} is not watched (known: ${Object.keys(caips).join(", ") || "none"})`);
  return name;
}

export function isoMs(v: unknown, field: string): number {
  const ms = typeof v === "string" ? Date.parse(v) : Number.NaN;
  if (Number.isNaN(ms)) throw new IngestError(`${field} must be an ISO-8601 time`);
  return ms;
}

export function txHash(v: unknown, field: string): string {
  if (!isNearHash(v)) throw new IngestError(`${field} must be a base58 NEAR transaction hash`);
  return v;
}

export function optionalInvoice(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !INVOICE_ID.test(v)) throw new IngestError("invoiceId must be 1-128 letters, digits or . _ : -");
  return v;
}

export function optionalAccount(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (!isAccountId(v)) throw new IngestError(`${field} must be a NEAR account id`);
  return v;
}

export function optionalText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > max || CONTROL.test(v)) throw new IngestError(`${field} must be text of at most ${max} characters`);
  return v;
}

export function parseClaim(input: unknown, caips: CaipMap): ClaimInput {
  if (!isObj(input)) throw new IngestError("a claim must be a JSON object");
  if (input.event !== "payment_settled") throw new IngestError('event must be "payment_settled"');
  const network = watchedNetwork(input.network, caips);
  const hash = txHash(input.transaction, "transaction");
  if (!isUnits(input.amount)) throw new IngestError("amount must be an integer string of token base units (x402 requirements.amount)");
  const amount = BigInt(input.amount as string).toString();
  if (amount === "0") throw new IngestError("amount must be above zero");
  return {
    network,
    hash,
    invoiceId: optionalInvoice(input.invoiceId),
    amount,
    asset: optionalText(input.asset, "asset", 128),
    payer: optionalAccount(input.payer, "payer"),
    route: optionalText(input.route, "route", 200),
    tsMs: isoMs(input.ts, "ts"),
  };
}
