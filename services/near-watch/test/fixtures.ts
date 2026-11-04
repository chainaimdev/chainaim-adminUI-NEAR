/** The recorded REAL testnet fixture (scripts/record-fixture.ts) and helpers to vary it for tests. */
import { readFileSync } from "node:fs";
import type { DecodeContext } from "../src/decode.ts";

export type Fixture = {
  network: string;
  contract: string;
  tx: string;
  signer: string;
  inclusionHeight: number;
  receiptHeight: number;
  txStatus: Record<string, unknown> & { transaction: { hash: string } };
  blocks: Record<string, { header: { height: number; hash: string } }>;
  chunks: Record<string, unknown>;
  neardata: Record<string, unknown>;
};

/**
 * A real x402 NEAR payment, recorded with
 *   node scripts/record-fixture.ts --tx H3ZFsVY1zDSQKsL3dktYBcNHSLiE8GpR5JtytFLjnbqD --signer chainaim-relayer-seller.testnet
 *     --contract 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af --name x402-near-payment
 * 0.01 USDC (10000 base units) from the buyer to the paywall's pay-to. The relayer signed a transaction to the buyer
 * holding a NEP-366 Delegate {receiver_id: <USDC>, actions: [ft_transfer {receiver_id, amount}]}: no memo
 * (chainiam-private-ai docs/NEAR-GATES.md G3).
 */
export const fixture: Fixture = JSON.parse(readFileSync(new URL("./fixtures/x402-near-payment.json", import.meta.url), "utf8"));
/** The buyer (delegate sender, NEP-141 old_owner_id). */
export const SENDER = "chainaim-buyer-seller.testnet";
/** The paywall's pay-to (NEP-141 new_owner_id). */
export const RECEIVER = "chainaim-payto-seller.testnet";
/** The relayer that signed the outer transaction. */
export const RELAYER = "chainaim-relayer-seller.testnet";
/** Amount of the recorded payment, base units and decimal (USDC, 6 decimals). */
export const AMOUNT = "10000";
export const VALUE = "0.01";

export const ctx = (over: Partial<DecodeContext> = {}): DecodeContext => ({
  network: "testnet",
  usdcContract: fixture.contract,
  decimals: 6,
  watched: new Set([RECEIVER, SENDER]),
  payTo: new Set([RECEIVER]),
  ...over,
});

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * A second real x402 NEAR payment, whose claim reached near-watch before its transfer and was marked only_in_log
 * (live, 2026-11-04). Recorded with
 *   node scripts/record-fixture.ts --tx BFEX1KAHiitSFGZPYHUbs34V79Xb71xXQepgMo7aipgS --signer chainaim-relayer-seller.testnet
 *     --contract 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af --name x402-late-claim
 * `LATE_LIVE` holds what the live near-watch store held for it (data/near-watch/watch.sqlite: claims, txs, roads).
 */
export const lateFixture: Fixture = JSON.parse(readFileSync(new URL("./fixtures/x402-late-claim.json", import.meta.url), "utf8"));
export const LATE_LIVE = {
  invoiceId: "9421B9B4396F4B228F899F1C3E523F13",
  claimTsMs: 1793802727725,
  claimReceivedMs: 1793802727767,
  /** near-watch's final tip when the claim arrived (63 blocks behind the transfer's block: the roads were behind). */
  claimSeenBlock: 276207436,
  rpcSeenMs: 1793802783306,
  qnRpcSeenMs: 1793802838514,
} as const;
