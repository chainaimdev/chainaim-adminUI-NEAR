# chainaim-adminUI-NEAR: a live operator console for NEAR USDC x402 payments

This console shows NEAR testnet USDC payments to an x402 paywall as they happen. They come from two independent sources:
- **what the paywall says it settled**: its `payment_settled` claims
- **what the chain shows**: NEP-141 transfers in final blocks, read over up to three independent roads

The two are reconciled payment by payment.

```
paywall ──POST /ingest/claim──▶ services/near-watch ◀── neardata (long-poll) · QuickNode RPC · public RPC · backfill
                                  SQLite: txs · roads · cursors · claims · recon
                                  /api/*  SSE /stream (admin key)
                                        ▼
                         apps/admin-console (Next.js; key held server-side)
                         Live ops · Ledger · Reconcile · Feeds · Seller wallet
```

## Do X → see Y

| Do | See |
|---|---|
| `npm --prefix services\near-watch test` | 34 tests pass. The doubles serve a **recorded real testnet x402 NEAR payment** (`H3ZFsVY1…`, 0.01 USDC, a relayed NEP-366 delegate `ft_transfer` with no memo). The tests cover: two roads, where the first wins and the second is recorded with its lag; a claim reconciling to `matched` by tx hash alone; a claim that went `only_in_log` before its transfer was read turning `matched`, marked late (real tx `BFEX1KAH…`); the RPC road's read-ahead against serial; the neardata road down while RPC still records; a restart that backfills with no duplicates; and no key in any API response |
| `npm --prefix apps\admin-console test` | 39 tests pass (proxy rules, SSE pass-through, store and derive over a real near-watch server) |
| Follow SETUP-COMMANDS.md, then open http://127.0.0.1:8800 | Header chips show each road's state and final block height. Blocks stream in about every second |
| Make one paid call with the paywall on `PAY_RAILS=near` | It shows on **Live ops** as a `claim` and as a chain `tx`. **Ledger** shows which road won and how far behind the others were. **Reconcile** shows `matched` within `--settle-grace-blocks` |
| Remove `neardata` from `--feeds`, or block it | **Feeds** shows it `down`. The transfer is still recorded via `qn-rpc` / `rpc` |
| Restart near-watch | It logs `backfill <cursor>..<tip>`. No transfer appears twice (the roads table keeps one row per road) |
| Post a claim whose tx never lands, or make an x402 payment to the pay-to with no claim | After the grace: `only_in_log` or `only_on_ledger`, with an alert |
| `curl /api/feeds` with the admin key | Provider hosts only. QuickNode tokens and `?apiKey=` never appear |

## Layout

- `services/near-watch`: the watcher. See its README, and `node src/main.ts --help` for every flag.
- `apps/admin-console`: the console. See its README.
- `packages/chain-core`: shared code: money in bigint base units, CAIP-2 ids, redaction, NEAR ids, and the signer interface.
- `docs/NEAR-GATES.md`: every NEAR fact this repo relies on, with its source. The NEAR CAIP-2 ids default to `near:testnet` / `near:mainnet`, the only two `@x402/near` accepts (A5). **x402 NEAR payments carry no memo** (A7), so claims match transfers by tx hash only.
- `services/custody`: step 4, OutLayer TEE wallets. Deferred.
- `HACKATHON-DISCLOSURE.md`: what was ported from liveops and what was built in the window.

MIT licensed.
