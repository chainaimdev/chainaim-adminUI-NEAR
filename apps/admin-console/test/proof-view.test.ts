/** lib/proof-view.ts (ARCH-703): the Jobs tab's signed quote and receipt columns and detail rows, from near-watch's JobView (ARCH-701/702). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { proofRows, receiptCell, signedQuoteCell } from "../lib/proof-view.ts";
import type { JobView } from "../lib/types.ts";

const job = (o: Partial<JobView> = {}): JobView => ({
  jobId: "a".repeat(32), network: "near:testnet", state: "released", amount: "20000", totalUsd: "0.020000", quotedMs: 1, expiresMs: 2, paidMs: 1, releasedMs: 1, expiredMs: null,
  txHash: "tx", breakdown: null, steps: null, receivedMs: 1, noJobEvent: false, invoiceId: null, payer: null, reconcile: null, ...o,
});
const KID = "83816e6fd32b879fd96d0318a40cd40d";
const TX = "6RoFLYdZ3q8m4hWbKcBtZ8x1yNvP2sTuQwErAa";
const rc = (settled: boolean) => ({ tsMs: 1, receiptId: "b".repeat(32), keyId: "d27d1e9f17a0104e34c46cf3e5233f23", resultSha256: "c".repeat(64), filesRoot: "d".repeat(64), settled, transaction: settled ? TX : null, receivedMs: 2 });

test("ARCH-703: signed quote column: ✓ with the first 8 of the key id, – when the job has none", () => {
  assert.deepEqual([signedQuoteCell(job({ signedQuote: { kid: KID, merchantAuthSha256: "e".repeat(64) } })).mark, signedQuoteCell(job({ signedQuote: { kid: KID, merchantAuthSha256: "e".repeat(64) } })).text], ["✓", "83816e6f…"]);
  assert.match(signedQuoteCell(job({ signedQuote: { kid: KID, merchantAuthSha256: "e".repeat(64) } })).title, new RegExp(`key id ${KID} · signature sha256 e{64}`));
  const none = signedQuoteCell(job());
  assert.deepEqual([none.mark, none.text, none.tone], ["–", "", "none"]);
});

test("ARCH-703: receipt column: ✓ settled, ⧗ pending before its settlement, – none", () => {
  assert.deepEqual([receiptCell(job({ receipt: rc(true) })).mark, receiptCell(job({ receipt: rc(true) })).text, receiptCell(job({ receipt: rc(true) })).tone], ["✓", "settled", "ok"]);
  assert.match(receiptCell(job({ receipt: rc(true) })).title, new RegExp(`settlement transaction ${TX}`));
  assert.deepEqual([receiptCell(job({ receipt: rc(false) })).text, receiptCell(job({ receipt: rc(false) })).tone], ["pending", "warn"]);
  assert.equal(receiptCell(job()).mark, "–");
});

test("ARCH-703: job detail rows: key id, quote hash, receipt id, result hash (full values in the title); none for a job without either", () => {
  assert.deepEqual(proofRows(job()), []);
  const rows = proofRows(job({ signedQuote: { kid: KID, merchantAuthSha256: "e".repeat(64) }, receipt: rc(true) }));
  assert.deepEqual(rows.map((r) => r[0]), ["quote signing key id", "quote hash (merchantAuthSha256)", "receipt id", "receipt signing key id", "result hash", "files root", "receipt settlement"]);
  assert.equal(rows[1][2], "e".repeat(64));
  assert.equal(rows[4][2], "c".repeat(64));
  assert.equal(proofRows(job({ receipt: rc(false) })).at(-1)![1], "not attached yet");
});
