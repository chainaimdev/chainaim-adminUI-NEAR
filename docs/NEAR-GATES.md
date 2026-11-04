# NEAR gates (DESIGN §4): answers and sources

Each answer below comes from the source named. All were checked on 2026-11-04.

| Gate | Answer | Status | Where it is used |
|---|---|---|---|
| A1 | Neardata testnet: `https://testnet.neardata.xyz`. Mainnet: `https://mainnet.neardata.xyz` | Verified | `config.ts` `NEARDATA_DEFAULT` |
| A2 | NEP-141 transfer = an `EVENT_JSON:` log with `standard:"nep141"`, `version:"1.0.0"`, `event:"ft_transfer"`, `data[{old_owner_id,new_owner_id,amount,memo?}]`, from a receipt whose **executor_id is the token contract** | Verified | `decode.ts` |
| A3 | Receipts can execute in blocks *after* the transaction's block. Only final blocks are read. A row's block is the block where the transfer receipt executed | Verified | `decode.ts`, feed roads |
| A4 | Testnet USDC `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`, 6 decimals. Mainnet `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | Verified | `.env.example`. Not a code default: decimals are read from `ft_metadata` at start-up |
| A5 | NEAR CAIP-2 ids: `near:testnet`, `near:mainnet`, the only two `@x402/near` accepts, and so what the paywall writes (chainiam-private-ai docs/NEAR-GATES.md G4) | **Closed** by G4 | `config.ts` `NEAR_CAIP2_DEFAULT`; `NEAR_CAIP2_<NET>` is an optional override; `test/config.test.ts` |
| A6 | NearBlocks: `/txns/<hash>`, `/address/<account>` | Taken from the explorer's source; the site refuses automated fetches | `config.ts` `EXPLORER_DEFAULT`; override with `--explorer*` |
| A7 | **An x402 NEAR payment carries no memo.** It is a NEP-366 `Delegate` (relayed) holding one `ft_transfer {receiver_id, amount}` to the token contract. So x402 = a successful single-event `ft_transfer` of the watched token into a watched pay-to, and a claim joins its transfer by tx hash only | Verified | `decode.ts` (`isX402`, `candidateTxs`), `reconcile.ts`, `store.ts` (schema 2) |

## Details and sources

**A1.** The [fastnear/neardata-server README](https://github.com/fastnear/neardata-server) says:
- "Testnet: https://testnet.neardata.xyz".
- `GET /v0/block/:h`: "If the block doesn't exist it returns `null`". "If the block is not produced yet, but close to the current finalized block, the server will wait for the block to be produced and return it". The request may redirect.
- `GET /v0/last_block/final` "redirects to the latest finalized block".
- Rate limit: "180 requests per minute per IP". Add `?apiKey=` for a higher limit.

Checked live: the testnet `/v0/last_block/final` returns 302 to `/v0/block/<h>`.

The block shape is pinned by the recorded fixture `services/near-watch/test/fixtures/x402-near-payment.json`: `block.header`, then `shards[].chunk.transactions[]`, then `shards[].receipt_execution_outcomes[]{receipt, execution_outcome.outcome{executor_id, logs, status}, tx_hash}`.

**A2.**
- [NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md) (nomicon.io now redirects there) says events "MUST have `standard` set to `"nep141"`, standard version set to `"1.0.0"`". It defines `ft_transfer(receiver_id, amount, memo)` and `ft_transfer_call(receiver_id, amount, memo, msg)`.
- [docs.near.org/primitives/ft/standard](https://docs.near.org/primitives/ft/standard) confirms the same.
- [docs.near.org/integrations/fungible-tokens](https://docs.near.org/integrations/fungible-tokens) says to check `executor_id` against the token contract, because any contract can print the same log.

One point is ambiguous: neither page says that `ft_transfer_call` emits `ft_transfer`. The near-sdk reference implementation does emit it, from `internal_transfer`. near-watch records the event either way. Only a single-event `ft_transfer` counts as x402.

**A3.** [docs.near.org/integrations/blocks-and-finality](https://docs.near.org/integrations/blocks-and-finality) says:
- "Transactions can produce receipt chains that execute across multiple blocks."
- "The transaction's inclusion block can finalize before downstream receipts finish."
- FINAL means "Transaction and all receipt outcomes finalized, including refunds."

The RPC roads use `block {finality:"final"}` and `block {block_id}` + `chunk {chunk_id}` from [docs.near.org/api/rpc/block-chunk](https://docs.near.org/api/rpc/block-chunk), and `EXPERIMENTAL_tx_status` with `wait_until: "FINAL"`. The recorded fixture shows this: the transaction is in block 276202561 and its USDC receipt runs in 276202563.

**A4.** [developers.circle.com/stablecoins/usdc-contract-addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses) lists both contract ids. Decimals were read on-chain from `ft_metadata`: `{"spec":"ft-1.0.0","name":"USDC","symbol":"USDC","decimals":6}`. The value is also recorded in the fixture's `views`.

**A5.**
- [namespaces.chainagnostic.org/near/caip2](https://namespaces.chainagnostic.org/near/caip2) returns 404.
- The [ChainAgnostic/namespaces](https://github.com/ChainAgnostic/namespaces) repo has no `near/` folder.
- An open PR, [#203](https://github.com/ChainAgnostic/namespaces/pull/203), proposes `near:mainnet` / `near:testnet`.

**Closed (2026-11-04) by chainiam-private-ai `docs/NEAR-GATES.md` G4**: "`near:testnet`, `near:mainnet`. These are the only two `@x402/near` accepts" (source there: the x402 NEAR exact spec and `@x402/near` `NEAR_NETWORKS`). The CAIP registry is still unratified, but that no longer matters here. The paywall cannot write any other id: its `services/paywall/src/config.ts` `NEAR_NETWORKS` table feeds `payment_settled.network`. So these ids are a fact from an official source (DESIGN §0.4), not a guess. near-watch defaults to them (`config.ts` `NEAR_CAIP2_DEFAULT`), and `NEAR_CAIP2_<NET>` stays as an optional override (it must still be a `near:` CAIP-2 id). `test/config.test.ts` checks two things: that the default equals the paywall's table (read from the sibling checkout when present), and that a claim with the paywall's `network` is accepted with no env var set.

**A6.** testnet.nearblocks.io answers 403 to automated clients. The routes come from the [Nearblocks/nearblocks](https://github.com/Nearblocks/nearblocks) frontend source, `apps/frontend/src/app/[lang]/txns/[tid]` and `.../address/[address]`. Circle's page also links `testnet.nearblocks.io/token/<id>`. Change them with `--explorer`, `--explorer-tx-path` and `--explorer-account-path`.

**A7.**
- chainiam-private-ai `docs/NEAR-GATES.md` G3 (x402 NEAR exact spec `specs/schemes/exact/scheme_exact_near.md` and `@x402/near`, read there): "one `ft_transfer {receiver_id, amount}` inside a NEP-366 SignedDelegate … The spec defines no `memo`, so the delegate does not name the invoice".
- Recorded on chain: `H3ZFsVY1zDSQKsL3dktYBcNHSLiE8GpR5JtytFLjnbqD`, 0.01 USDC (10000 base units) from `chainaim-buyer-seller.testnet` to `chainaim-payto-seller.testnet`. The transaction is signed by the relayer `chainaim-relayer-seller.testnet` and sent to the buyer. Its action is `Delegate {delegate_action: {receiver_id: <USDC>, actions: [FunctionCall ft_transfer]}}`, with args `{"receiver_id":"chainaim-payto-seller.testnet","amount":"10000"}`. The NEP-141 event has no `memo` field. This is `test/fixtures/x402-near-payment.json`, from `node scripts/record-fixture.ts --tx H3ZFsVY1… --signer chainaim-relayer-seller.testnet --contract <USDC> --name x402-near-payment`.
- What follows. The invoice never reaches the chain, so it cannot be matched there. The claim's `invoiceId` is display only. The RPC roads must look inside `Delegate` actions to find the payment when only the pay-to is watched, because the outer transaction names neither the token nor the pay-to. A schema-1 store, which judged x402 by memo, is re-judged on open.

**Public RPC.** [docs.near.org/api/rpc/providers](https://docs.near.org/api/rpc/providers) lists FastNear testnet at `https://test.rpc.fastnear.com`. A POST of `block {finality:"final"}` worked against it. The archival `https://archival-rpc.testnet.near.org` is "severely rate limited", and is used only by `scripts/record-fixture.ts`.
