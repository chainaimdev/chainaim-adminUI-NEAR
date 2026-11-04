# Hackathon disclosure: what was ported and what was built in the window

**Baseline (before the window).** This came from `chainaim-liveops`, which is ChainAim's XRPL operator console: `services/ledger-watch` and `apps/admin-console`. It already had the patterns this repo reuses:
- several roads per transaction, where the first road wins and later roads are recorded with their lag
- SQLite tables for `txs`, `roads`, `cursors`, `claims`, `traces` and `recon`
- the claim contract (`payment_settled` lines over `POST /ingest/claim`, or a tailed log file)
- the reconcile states `matched`, `pending`, `only_in_log`, `only_on_ledger` and `mismatch`
- the HTTP routes, SSE event names, admin/ingest key rules and the console's server-side proxy

**Ported with minimal change.** These keep the same contracts, with NEAR names, base58 hashes and NEAR account ids:
- `services/near-watch/src/`: `store.ts`, `events.ts`, `roads.ts`, `reconcile.ts`, `liveops.ts`, `claims.ts`, `traces.ts`, `alerts.ts`, `metrics.ts`, `links.ts`, `seller.ts` (same policy, rewritten for base units), `tail.ts` and `entry.ts` (copied)
- `server.ts`: routes unchanged, with the `/api/tx/<hash>` pattern now matching base58 hashes
- `apps/admin-console`: ported from liveops `apps/admin-console`. The lending tab was dropped and the data types are now NEAR. Its README lists the details.

**Built in the window (new for NEAR).**
- `docs/NEAR-GATES.md`: gates A1–A6 resolved from official sources, including the open CAIP-2 question.
- `src/decode.ts`: NEP-141 / NEP-297 `ft_transfer` events taken from receipt outcomes, checked against the token contract as executor. It also handles failed transfer calls, RPC `EXPERIMENTAL_tx_status` decoding and candidate selection from chunks.
- `src/feeds/adapter.ts`: the final-height block loop. It covers forward-only cursors, skipped heights, long-poll at the tip, network-reset detection and backoff.
- `src/feeds/neardata.ts`: the neardata long-poll road.
- `src/feeds/rpc-poll.ts` and `quicknode-rpc.ts`: the block, chunk and tx-status road. It skips chunks whose `tx_root` is empty.
- `src/backfill.ts`, `src/tx-status.ts`, `src/rpc.ts`, `src/balances.ts`, `src/config.ts`, `src/main.ts`, `src/watchlist.ts`.
- `packages/chain-core`: `money.ts` (bigint base units), `caip.ts`, `redact.ts`, `near.ts` and `signer.ts` (the interface for the step-4 TEE seam).
- `scripts/record-fixture.ts` and the recorded **real** testnet fixture. It holds transaction `H3ZFsVY1zDSQKsL3dktYBcNHSLiE8GpR5JtytFLjnbqD`: a real x402 NEAR payment of 0.01 USDC, relayed as a NEP-366 delegate `ft_transfer` with no memo. The transaction is in block 276202561 and its USDC receipt executes in 276202563.
- `test/neardata-double.ts`, `test/near-rpc-double.ts` and every test under `services/near-watch/test`.

**Not built.** `services/custody`, the OutLayer TEE work, is step 4 and is deferred by design. `qn-wss` is not built either, because no NEAR WebSocket subscription is documented.
