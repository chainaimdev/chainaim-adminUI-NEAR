/**
 * lib/proof-view.ts and lib/live-store.ts (ARCH-705): the Jobs tab's "tenant mandate" column, the deal line and detail
 * rows from near-watch's JobView.mandate (near-watch ARCH-704; private-ai privateAI-design-42 ARCH-710).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dealText, mandateCell, proofRows } from "../lib/proof-view.ts";
import { applyEvent, emptyState } from "../lib/live-store.ts";
import type { JobView } from "../lib/types.ts";

const job = (o: Partial<JobView> = {}): JobView => ({
  jobId: "a".repeat(32), network: "near:testnet", state: "released", amount: "20000", totalUsd: "0.020000", quotedMs: 1, expiresMs: 2, paidMs: 1, releasedMs: 1, expiredMs: null,
  txHash: "tx", breakdown: null, steps: null, receivedMs: 1, noJobEvent: false, invoiceId: null, payer: null, reconcile: null, ...o,
});
const MANDATE = { kid: "964b1199a73a9b22e6be8bc2e4b2ce26", tenant: "t01", sha256: "7cd12328f2e8e1d0fee66764ba5e84b80858e194fafe9c31d4caa578884d1250" };
const SQ = { kid: "83816e6fd32b879fd96d0318a40cd40d", merchantAuthSha256: "e".repeat(64) };

test("ARCH-705: tenant mandate column: ✓ and the tenant, with key id and hash in the title; – when the job has none", () => {
  const c = mandateCell(job({ mandate: MANDATE }));
  assert.deepEqual([c.mark, c.text, c.tone], ["✓", "t01", "ok"]);
  assert.match(c.title, new RegExp(`tenant t01 \\(AP2, key id ${MANDATE.kid}\\).*mandate sha256 ${MANDATE.sha256}`));
  const none = mandateCell(job());
  assert.deepEqual([none.mark, none.text, none.tone], ["–", "", "none"]);
});

test("ARCH-705: the deal line names both signatures; null for a job with neither", () => {
  assert.equal(dealText(job()), null);
  assert.equal(dealText(job({ signedQuote: SQ, mandate: MANDATE })), "ChainAim signed the quote ✓ · tenant t01 signed the mandate ✓");
  assert.equal(dealText(job({ signedQuote: SQ })), "ChainAim signed the quote ✓ · no tenant mandate –");
});

test("ARCH-705: detail rows: the mandate's tenant, key id and hash (full value in the title) between the quote and the receipt", () => {
  const rows = proofRows(job({ signedQuote: SQ, mandate: MANDATE }));
  assert.deepEqual(rows.map((r) => r[0]), ["quote signing key id", "quote hash (merchantAuthSha256)", "mandate tenant", "mandate signing key id", "mandate hash (sha256)"]);
  assert.equal(rows[4][2], MANDATE.sha256);
});

test("ARCH-705: a job event's mandate is kept when well formed; a malformed one is refused, the state unchanged", () => {
  const s = emptyState();
  const good = applyEvent(s, "job", { job: job({ mandate: MANDATE }), summary: { counts: { quoted: 0, paid: 0, released: 1, expired: 0 }, lostCompute: {} } });
  assert.equal(good.stats.errors, s.stats.errors);
  assert.deepEqual(good.jobs["a".repeat(32)].mandate, MANDATE);
  for (const bad of [{ ...MANDATE, kid: "KID" }, { ...MANDATE, tenant: "Tenant One" }, { ...MANDATE, sha256: "x" }, "eyJh..sig"]) {
    const next = applyEvent(s, "job", { job: { ...job(), mandate: bad }, summary: { counts: { quoted: 0, paid: 0, released: 1, expired: 0 }, lostCompute: {} } });
    assert.equal(next.stats.errors, s.stats.errors + 1, JSON.stringify(bad));
    assert.equal(next.jobs, s.jobs);
  }
});
