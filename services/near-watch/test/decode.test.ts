import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateTxs, decodeOutcome, ftTransferEvents, headerTimeMs, neardataBlock, txStatusOutcomes, type ReceiptOutcome } from "../src/decode.ts";
import { EMPTY_ROOT } from "../src/feeds/rpc-poll.ts";
import { AMOUNT, clone, ctx, fixture as f, RECEIVER, RELAYER, SENDER, VALUE } from "./fixtures.ts";

const ndOutcomes = (fx = f): ReceiptOutcome[] => neardataBlock(fx.neardata[String(fx.receiptHeight)], fx.contract).outcomes;
const rpcOutcomes = (fx = f): ReceiptOutcome[] => {
  const heights = new Map(Object.values(fx.blocks).map((b) => [b.header.hash, { height: b.header.height, timeMs: headerTimeMs(b.header as never) }]));
  return txStatusOutcomes(fx.txStatus, fx.contract, (h) => heights.get(h));
};

test("neardata block: the recorded x402 NEAR payment decodes to one x402 row with no memo", () => {
  const rows = ndOutcomes().flatMap((o) => decodeOutcome(o, ctx()));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.hash, f.tx);
  assert.equal(r.blockHeight, f.receiptHeight, "row block = the block the receipt executed in, not the inclusion block");
  assert.notEqual(f.receiptHeight, f.inclusionHeight);
  assert.equal(r.from, SENDER);
  assert.equal(r.to, RECEIVER);
  assert.equal(r.amount, AMOUNT);
  assert.equal(r.value, VALUE);
  assert.equal(r.memo, null, "the x402 NEAR exact scheme defines no memo (private-ai NEAR-GATES G3)");
  assert.equal(r.status, "success");
  assert.equal(r.method, "ft_transfer");
  assert.equal(r.events, 1);
  assert.equal(r.isX402, true, "success + watched token + one ft_transfer event into a watched pay-to");
});

test("RPC tx status and neardata give the identical row", () => {
  const a = ndOutcomes().flatMap((o) => decodeOutcome(o, ctx()));
  const b = rpcOutcomes().flatMap((o) => decodeOutcome(o, ctx()));
  assert.deepEqual(b, a);
});

test("x402 needs a watched pay-to and exactly one event; a memo is neither needed nor matched", () => {
  const [notPayTo] = ndOutcomes().flatMap((o) => decodeOutcome(o, ctx({ payTo: new Set() })));
  assert.equal(notPayTo.isX402, false, "into a watched account that is not a pay-to");

  const withMemo = clone(ndOutcomes()[0]);
  withMemo.logs = withMemo.logs.map((l) => l.replace('"amount":"10000"}', '"amount":"10000","memo":"any text at all"}'));
  const [m] = decodeOutcome(withMemo, ctx());
  assert.equal(m.memo, "any text at all", "a memo, when present, is kept as data");
  assert.equal(m.isX402, true, "and does not change the verdict");

  const twice = clone(ndOutcomes()[0]);
  twice.logs = [...twice.logs, ...twice.logs];
  assert.equal(decodeOutcome(twice, ctx())[0].isX402, false, "two transfer events in one receipt");

  const call = clone(ndOutcomes()[0]);
  call.calls = call.calls.map((c) => ({ ...c, method: "ft_transfer_call" }));
  assert.equal(decodeOutcome(call, ctx())[0].isX402, false, "ft_transfer_call is not the x402 transfer");
});

test("unwatched accounts and other contracts yield nothing", () => {
  assert.deepEqual(ndOutcomes().flatMap((o) => decodeOutcome(o, ctx({ watched: new Set(["someone.testnet"]), payTo: new Set() }))), []);
  assert.deepEqual(ndOutcomes().flatMap((o) => decodeOutcome(o, ctx({ usdcContract: "usdc.fakes.testnet" }))), []);
  assert.equal(neardataBlock(f.neardata[String(f.receiptHeight)], "usdc.fakes.testnet").outcomes.length, 0);
});

test("a failed transfer receipt becomes a failure row that is never x402", () => {
  const o = clone(ndOutcomes()[0]);
  o.status = { Failure: { ActionError: { index: 0 } } };
  o.logs = [];
  const [r] = decodeOutcome(o, ctx());
  assert.equal(r.status, "failure");
  assert.equal(r.isX402, false);
  assert.equal(r.amount, AMOUNT, "from the recorded call's own args");
  assert.equal(r.to, RECEIVER);
  assert.equal(r.from, SENDER, "the receipt's predecessor: the delegate sender");
});

test("ftTransferEvents reads only nep141 ft_transfer events", () => {
  const log = (ndOutcomes()[0].logs.find((l) => l.startsWith("EVENT_JSON:")) as string) ?? "";
  assert.equal(ftTransferEvents(log).length, 1);
  assert.deepEqual(ftTransferEvents(log.replace('"nep141"', '"nep171"')), []);
  assert.deepEqual(ftTransferEvents("not an event"), []);
});

test("recorded chunk headers: an empty tx_root means no transactions", () => {
  for (const b of Object.values(f.blocks) as unknown as { header: { height: number }; chunks: { chunk_hash: string; tx_root: string; height_included: number }[] }[]) {
    for (const c of b.chunks) {
      if (c.height_included !== b.header.height) continue;
      if (c.tx_root === EMPTY_ROOT) assert.equal(f.chunks[c.chunk_hash], undefined);
      else assert.ok(((f.chunks[c.chunk_hash] as { transactions: unknown[] }).transactions.length ?? 0) > 0);
    }
  }
  // and in the neardata block of the inclusion height: chunks with the empty root carry no transactions
  const nd = f.neardata[String(f.inclusionHeight)] as { block: { chunks: { shard_id: number; tx_root: string }[] }; shards: { shard_id: number; chunk: { transactions: unknown[] } | null }[] };
  for (const c of nd.block.chunks) {
    const s = nd.shards.find((x) => x.shard_id === c.shard_id);
    if (c.tx_root === EMPTY_ROOT) assert.equal(s?.chunk?.transactions.length ?? 0, 0);
  }
});

test("candidateTxs: the relayed NEP-366 delegate payment is found with only the pay-to watched", () => {
  const chunk = Object.values(f.chunks).find((c) => (c as { transactions: { hash: string }[] }).transactions.some((t) => t.hash === f.tx));
  const tx = (chunk as { transactions: { hash: string; signer_id: string; receiver_id: string }[] }).transactions.find((t) => t.hash === f.tx);
  assert.equal(tx?.signer_id, RELAYER);
  assert.equal(tx?.receiver_id, SENDER, "a delegate transaction is sent to the delegate's sender");
  const want = [{ hash: f.tx, signer: RELAYER }];
  assert.deepEqual(candidateTxs(chunk, f.contract, new Set([RECEIVER])), want, "Delegate -> USDC ft_transfer naming the pay-to");
  assert.deepEqual(candidateTxs(chunk, f.contract, new Set([SENDER])), want, "sent to a watched account");
  assert.deepEqual(candidateTxs(chunk, f.contract, new Set([RELAYER])), want, "signed by a watched account");
  assert.deepEqual(candidateTxs(chunk, f.contract, new Set(["nobody.testnet"])), []);
  assert.deepEqual(candidateTxs(chunk, "other-token.testnet", new Set([RECEIVER])), [], "a delegate to another contract is not a USDC payment");
});
