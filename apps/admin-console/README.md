# admin-console — NEAR Live Ops

Shows what `services/near-watch` sees, from its own events only. No simulated data.
Ported from liveops `apps/admin-console` (XRPL); see "Changed from liveops" below.

```
browser ──/api/watch/*──▶ console server (Next.js) ──x-admin-key──▶ near-watch :8790
```
The browser never sees near-watch's address, endpoint URLs or the admin key.

## Do X → see Y

| Do | See |
|---|---|
| `npm install` then `npm test` | 48 tests pass; proxy / stream / store / jobs / attestation tests start the real near-watch `WatchServer` on its recorded testnet x402 payment (no memo; matched by tx hash) |
| open **Jobs** (`#jobs`) | every paid tab 03 job the private-ai console reported: counts per state, lost compute, the job list (time, job, payer, network, total, state, reconcile); for the selected job the step strip, the step table (time, model, zone, tokens in/out, masking counts, residual, cost) and the full breakdown. With NEAR AI attestation (PLAN-adminui-nearai-attestation.md ARCH-504): an attested column, an "attested jobs N of M" tile and a per-call attestation table. No text is ever received (architecture-adminui-jobs.md ARCH-210) |
| `npm run build`, then `node --env-file=<private env> scripts/console.ts --mode start` (near-watch running) | console on http://127.0.0.1:8800 |
| open **Live ops** | header chip `NEAR TESTNET` (best road, state, final block height) and one chip per road (neardata, qn-rpc, rpc); Seller wallet row; flow canvas; feed race |
| make one paid call (paywall `PAY_RAILS=near`) | `claim` and `tx` in the change log; the transfer on **Ledger** with the road that won (chip) and later roads `+N ms`; **Reconcile** shows `matched` after the grace |
| stop the neardata road | its chip turns red; **Feeds** shows it `down`; the next transfer is won by `qn-rpc` |
| claim with no transfer / transfer with no claim | **Reconcile**: `only in log` / `only on ledger` after `--settle-grace-blocks` final blocks |
| open **Seller wallet** | pay-to balance, received (x402 vs manual), in flight, every buyer, unwatched transfers (listed, never counted) |
| click a tx hash or account | the explorer link near-watch sent (`links`); nothing is built in the browser |

## Settings (server only)

| Env / flag | Default | |
|---|---|---|
| `NEAR_WATCH_URL` / `--near-watch-url` | `http://127.0.0.1:8790` | plain http only to loopback |
| `ADMIN_API_KEY` (name: `--admin-key-env`) | — | required, 24+ chars; never a flag |
| `--mode dev\|start`, `--port 8800`, `--bind 127.0.0.1` | | loopback only (no login yet) |
| `--upstream-timeout-ms 5000`, `--connect-timeout-ms 10000` | | REST call / start of `/stream` |

`node --env-file` does not replace a variable already set in the shell (`Remove-Item Env:ADMIN_API_KEY`).

## Routes

| Console | near-watch |
|---|---|
| `GET /api/watch/stream` | `GET /stream` (SSE bytes passed through; leaving the page frees the slot) |
| `GET /api/watch/{snapshot,txs,feeds,claims,reconcile,metrics,seller,jobs}` | `GET /api/...`; query keys `limit`, `network`, `state` only |
| `GET /api/watch/job/<jobId>` | `GET /api/job/<jobId>` (paid jobs) |
| `GET /api/watch/{tx,trace}/<id>` | `GET /api/tx/<base58 hash>`, `/api/trace/<invoiceId>` |

Everything else (`/ingest/*`, `/healthz`) is 404; any method but GET is 405. near-watch's 401 becomes 502
"near-watch refused the admin key"; unreachable is 502 "near-watch unreachable", without its address.

## Money and ids

Decimal strings are shown as sent. Claim amounts are base units: shown as decimals with the token's decimals
(`/api/feeds` `token.decimals`, else the Seller Wallet's `asset.decimals`) by `bigint`, else as base units.
Tx hashes are base58 and case-sensitive: never case-folded.

## Changed from liveops

Dropped: the Lending tab (XRPL Devnet), RLUSD/TUSD per-network tokens, currency-code decoding, QuickNode Stream /
Webhook chips and panels, the t54 facilitator node. Renamed: `/api/lw` → `/api/watch`, `CONSOLE_LEDGER_WATCH_URL` →
`NEAR_WATCH_URL`. New: Seller wallet tab, per-road chips and table (state, lag in blocks, errors, won/seen, delay
behind the winner), `/api/seller` in the allow-list, alert clearing (`feed_live` clears `feed_down`, `low_calls_ok`
clears `low_calls`), bar charts scaled by `bigint`.

## Tests

`npm test` (Node's runner, type stripping; no `--test-force-exit`, see liveops README). `npm run typecheck` covers
app/lib/hooks/components/scripts; tests import near-watch's sources and are not type-checked. near-watch needs no
`npm install` for them (no runtime dependencies). Not covered: the browser render, and `/api/feeds` against a running
near-watch (the test server starts no roads; `feedActivity` is tested on reports built from near-watch's catalogue).
