# chainaim-adminUI-NEAR: live operator console for NEAR USDC x402 payments

This console shows, as they happen, the NEAR TestNet USDC payments and paid jobs of
[ChainAim Private AI](https://github.com/chainaimdev/chainaim-private-ai), from two independent sources:
- **what the paywall says it settled**: its `payment_settled` claims, and the console's paid-job events
  (`job_quoted`, `job_released`, `job_expired`)
- **what the chain shows**: NEP-141 USDC transfers in final blocks, read over up to three independent roads

The two are reconciled payment by payment (`matched`, `pending`, `only_in_log`, `only_on_ledger`, `mismatch`).

## How to run it

Full commands with expected output: **[cmd.md](cmd.md)**. This repo runs together with
[chainaim-private-ai](https://github.com/chainaimdev/chainaim-private-ai).

**1. One-time setup (once per PC):** [cmd.md PART 1](cmd.md) — tools, clone, build the admin UI
(`npm --prefix apps\admin-console install` and `run build`), the secrets file `C:\PRIV-AI-SECRETS\near-watch.env`, and
the accounts to watch. Then private-ai's one-time setup.

**2. Run all containers and both UIs (every day):** two commands, this repo first.

```powershell
cd C:\SATHYA\CHAINAIM3003\mcp-servers\chainaim-adminUI-NEAR
.\up.ps1                       # ca-near-watch + admin UI http://127.0.0.1:8800
cd C:\SATHYA\CHAINAIM3003\mcp-servers\chainiam-private-ai
.\test-console\up.ps1          # six backend containers + console UI http://127.0.0.1:8730
```

Stop: `.\test-console\down.ps1` in private-ai, then `.\down.ps1` here.

## What runs where

| Part | Runs as | Port | Role |
|---|---|---|---|
| near-watch | Docker, container `ca-near-watch` (network `chainaim-test`, volume `near-watch-data`) | 127.0.0.1:8790 | Reads the chain, stores in SQLite, takes claims and job events on `/ingest/*`, reconciles, serves `/api/*` and SSE to the console (admin key) |
| admin UI | Node on your PC (Next.js, `apps/admin-console`) | **127.0.0.1:8800** | The pages; a server-side proxy holds the admin key, the browser never sees it |

```
private-ai paywall ──POST /ingest/claim──▶ near-watch (Docker) ◀── neardata · QuickNode RPC · public RPC · backfill
private-ai console ──POST /ingest/job────▶   SQLite: txs · roads · cursors · claims · recon · jobs
                                               /api/*  SSE /stream (admin key)
                                                     ▼
                                         admin UI 8800 (PC): Live ops · Ledger · Reconcile · Jobs · Feeds · Seller wallet
```

Inside Docker, the private-ai containers reach near-watch as `http://near-watch:8790` (the shared network
`chainaim-test`). The admin UI reaches it as `http://127.0.0.1:8790`.

## Roads

| Road | Needs | Notes |
|---|---|---|
| `neardata` | optional `NEARDATA_API_KEY` | Without a key the public limit is 180 requests/minute; it answers HTTP 429 when exceeded |
| `qn-rpc` | `QUICKNODE_NEAR_HTTP_TESTNET` | Skipped and reported when not set; down when the plan's daily quota is used |
| `rpc` | `NEAR_RPC_FALLBACK_URL_TESTNET` (default in `.env.example`) | Public FastNEAR RPC |

The first road to deliver a transfer wins; the others are recorded with their lag. One live road is enough.

## Do X → see Y

| Do | See |
|---|---|
| `npm --prefix services\near-watch test` | 50 tests pass, over a recorded real TestNet x402 NEAR payment (`H3ZFsVY1…`, 0.01 USDC, a relayed NEP-366 delegate `ft_transfer` with no memo): roads, reconcile, late claims and late transfers, restart without duplicates, paid jobs, relayer gas alert, no key in any API response |
| `npm --prefix apps\admin-console test` | 43 tests pass (proxy rules, SSE pass-through, store and derive over a real near-watch, jobs) |
| `.\up.ps1`, then open http://127.0.0.1:8800 | Header chips show each road and the final block height; blocks stream in about every second |
| One paid call or paid job in private-ai | **Live ops** shows a `claim` and a chain `tx`; **Jobs** shows `quoted` → `released`; **Reconcile** shows `matched` within `--settle-grace-blocks` (30) |
| `docker compose restart near-watch` | It backfills from its saved cursor; no transfer appears twice |
| `curl /api/feeds` with the admin key | Provider hosts only; QuickNode tokens and `?apiKey=` never appear |

## Layout

- `services/near-watch`: the watcher. `node src/main.ts --help` lists every flag. Its Docker image is
  `services/near-watch/Dockerfile` (build context: the repository root).
- `apps/admin-console`: the console (Next.js).
- `packages/chain-core`: shared code: money in bigint base units, CAIP-2 ids, redaction, NEAR ids, the signer interface.
- `docker-compose.yml`, `up.ps1`, `down.ps1`: near-watch in Docker plus the admin UI on the PC.
- `docs/NEAR-GATES.md`: every NEAR fact this repo relies on, with its source. CAIP-2 ids default to `near:testnet` /
  `near:mainnet` (A5). **x402 NEAR payments carry no memo** (A7), so claims match transfers by tx hash only.
- `architecture-adminui-jobs.md`: the paid-jobs requirements (ARCH-201..210).
- `DOCKERIZE-PLAN.md`: why and how near-watch moved into Docker.
- `services/custody`: OutLayer TEE wallets, deferred.
- `HACKATHON-DISCLOSURE.md`: what was ported and what was built in the hackathon window.

Never paste `docker inspect` or `docker compose config` output anywhere: they can print secret values.

MIT licensed.
