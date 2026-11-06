/**
 * CONSOLE-RECON-DETAIL: the Reconcile tab's detail cell (lib/derive.ts reconDetail). A re-judged row (near-watch
 * src/reconcile.ts rejudge) shows a short marker with the full audit text on hover; a real gap's detail is shown whole.
 * The live texts below are the two rows the owner's near-watch held on 2026-11-06 (jobs 09ebdf3d... and bef914c0...),
 * and the shorter form near-watch writes from now on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { REJUDGED } from "../../../services/near-watch/src/reconcile.ts";
import { graceLine, reconDetail, REJUDGED_PREFIX } from "../lib/derive.ts";

const LIVE_2026_11_06 =
  "re-judged 2026-11-06T15:41:33.779Z by operator: was mismatch (the chain transfer is not a valid x402 NEAR USDC payment (status success, method ft_transfer, 1 transfer event(s))); reason: receiver checked on nearblocks; near-watch pay-to was misconfigured earlier on 2026-11-06";
const NOW_FORM =
  "re-judged by operator: was mismatch (the chain transfer is not a valid x402 NEAR USDC payment (status success, method ft_transfer, 1 transfer event(s); into chainaim-payto-seller.testnet, which was not a watched pay-to when near-watch read the transfer)); reason: receiver checked on nearblocks";

test("CONSOLE-RECON-DETAIL the console's marker prefix is near-watch's own", () => {
  assert.equal(REJUDGED_PREFIX, REJUDGED);
});

test("CONSOLE-RECON-DETAIL a re-judged row: short marker in the cell, the whole audit text on hover (live and current forms)", () => {
  for (const detail of [LIVE_2026_11_06, NOW_FORM]) {
    const d = reconDetail(detail);
    assert.equal(d.text, "re-judged by operator");
    assert.equal(d.rejudged, true);
    assert.equal(d.title, detail, "nothing of the record is dropped");
  }
});

test("CONSOLE-RECON-DETAIL the grace in one plain line (owner screen 2026-11-06: 30 blocks, about 18 s, 2 blocks behind)", () => {
  const g = { graceBlocks: 30, defaultBlocks: 30, blockMs: 603, graceMs: 18_090, trailMs: 1200, trailBlocks: 2, tradeoff: "long text", warning: null };
  assert.equal(graceLine("testnet", g), "testnet: 30 blocks (about 18 s). Reading 2 block(s) behind the chain.");
  assert.equal(graceLine("testnet", { ...g, graceMs: null, trailBlocks: null }), "testnet: 30 blocks.", "nothing measured yet: no guess");
});

test("CONSOLE-RECON-DETAIL a real gap and a late match keep their detail in the cell; no detail is empty", () => {
  const gap = "chain moved 10000 base units, the log says 4500000";
  assert.deepEqual(reconDetail(gap), { text: gap, title: undefined, rejudged: false });
  const late = "late: was only_in_log for 16.5 s; the transfer was recorded 55.5 s after the claim (via rpc, 58.2 s after its block), past the 30-block grace";
  assert.equal(reconDetail(late).text, late);
  assert.deepEqual(reconDetail(null), { text: "", title: undefined, rejudged: false });
});
