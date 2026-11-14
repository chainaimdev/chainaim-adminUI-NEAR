# chainaim-adminUI-NEAR: live operator console for NEAR USDC x402 payments

This console shows, as they happen, the NEAR TestNet USDC payments and paid jobs of
[ChainAim Private AI](https://github.com/chainaimdev/chainaim-private-ai), from two independent sources:
- **what the paywall says it settled**: its `payment_settled` claims, and the console's paid-job events
  (`job_quoted`, `job_released`, `job_expired`)
- **what the chain shows**: NEP-141 USDC transfers in final blocks, read over up to three independent roads

The two are reconciled payment by payment (`matched`, `pending`, `only_in_log`, `only_on_ledger`, `mismatch`). For each
paid job it also shows the deal: ChainAim's signed quote, the tenant's signed checkout mandate, the signed receipt and
the NEAR AI attestation.

Built at **NEAR HACKATHON** (1 to 14 Nov 2026) as the companion of
[ChainAim Outcome AI (chainaim-private-ai)](https://github.com/chainaimdev/chainaim-private-ai). What was ported from the
earlier XRPL console and what was built in the window: [HACKATHON-DISCLOSURE.md](HACKATHON-DISCLOSURE.md).

## How to run it

Full commands with expected output: **[cmd.md](cmd.md)**. This repo runs together with
[chainaim-private-ai](https://github.com/chainaimdev/chainaim-private-ai).

**1. One-time setup (once per PC):** [cmd.md PART 1](cmd.md) — tools, clone, build the admin UI
(`npm --prefix apps\admin-console install` and `run build`), the secrets file `C:\PRIV-AI-SECRETS\near-watch.env`, and
the accounts to watch. Then private-ai's one-time setup.

**2. Run all containers and both UIs (every day):** two commands, this repo first.

```powershell
cd <your-folder>\chainaim-adminUI-NEAR
.\nearadminup.ps1              # ca-near-watch + admin UI http://127.0.0.1:8800
cd <your-folder>\chainaim-private-ai
.\test-console\up.ps1          # six backend containers + console UI http://127.0.0.1:8730
```

Stop: `.\test-console\down.ps1` in private-ai, then `.\down.ps1` here.

The accounts near-watch watches (buyers, the relayer) and the relayer's gas per payment are in
`config\near-watch-watch.conf` (committed, not secret). For private-ai's tab 03 agent mode, add one buyer line per tenant
and your Intear wallet account there ([cmd.md](cmd.md) A4); `.\nearadminup.ps1 -DryRun` prints the resulting command.

What a teammate needs for this repo: Git, Node.js 24, Docker Desktop, and `C:\PRIV-AI-SECRETS\near-watch.env`
([cmd.md](cmd.md) A3: the two keys are generated on the PC; `NEAR_PAY_TO_TESTNET` and the optional QuickNode / neardata
values come from the owner).

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
| `npm --prefix services\near-watch test` (no install needed: no runtime dependencies) | 77 tests pass, 1 skipped (v1.1.0), over a recorded real TestNet x402 NEAR payment (`H3ZFsVY1…`, 0.01 USDC, a relayed NEP-366 delegate `ft_transfer` with no memo): roads, reconcile, late claims and late transfers, restart without duplicates, paid jobs, NEAR AI attestation per job, relayer gas alert, no key in any API response |
| `npm --prefix apps\admin-console install`, then `npm --prefix apps\admin-console test` | 68 tests pass (v1.1.0: proxy rules, SSE pass-through, store and derive over a real near-watch, jobs, attestation, the deal) |
| A paid job using the NEAR AI model, with private-ai's `ca-attest` on | **Jobs** shows it **attested ✓** (◐ partial · ✗ unverified · – not applicable; blank = no data), the "attested jobs N of M" tile, and per model call the chat id, signer, report time and TDX / GPU / signature / hashes checks, with a link to https://cloud.near.ai/verify. near-watch only stores and shows the result; it never holds the NEAR AI key (PLAN-adminui-nearai-attestation.md) |
| A paid job whose buyer agent signed an AP2 checkout mandate (private-ai v2.0.0 and later, `--job-feed-mandate on`) | **Jobs** shows **signed quote ✓** (ChainAim's key id), **tenant mandate ✓** (the tenant, e.g. t02) and **receipt ✓ settled**; the job's panel says "The deal: ChainAim signed the quote ✓ · tenant t02 signed the mandate ✓". A counter-offer job shows its smaller price (e.g. $0.010000) |
| `.\nearadminup.ps1`, then open http://127.0.0.1:8800 | Header chips show each road and the final block height; blocks stream in about every second |
| One paid call or paid job in private-ai | **Live ops** shows a `claim` and a chain `tx`; **Jobs** shows `quoted` → `released`; **Reconcile** shows `matched` within `--settle-grace-blocks` (30) |
| `docker compose restart near-watch` | It backfills from its saved cursor; no transfer appears twice |
| `curl /api/feeds` with the admin key | Provider hosts only; QuickNode tokens and `?apiKey=` never appear |

## Built with: AI assistance and libraries

**AI assistance.** Claude (Anthropic) was used to design, write, test and document this repository, under the team's
direction and review; each change was run and tested before release (BUILD_LOG.md).

**Libraries:** the admin UI uses Next.js, React (`react`, `react-dom`), Tailwind CSS (`tailwindcss`, `@tailwindcss/postcss`,
`postcss`), `clsx` and `tailwind-merge`. near-watch has no runtime dependencies (Node.js 24 built-ins, including
`node:sqlite`); it reads NEAR through public RPC, neardata and optional QuickNode endpoints. Runtime: Node.js 24, Docker
Compose. Ported code is listed in [HACKATHON-DISCLOSURE.md](HACKATHON-DISCLOSURE.md).

## Layout

- `services/near-watch`: the watcher. `node src/main.ts --help` lists every flag. Its Docker image is
  `services/near-watch/Dockerfile` (build context: the repository root).
- `apps/admin-console`: the console (Next.js).
- `packages/chain-core`: shared code: money in bigint base units, CAIP-2 ids, redaction, NEAR ids, the signer interface.
- `docker-compose.yml`, `nearadminup.ps1`, `down.ps1`: near-watch in Docker plus the admin UI on the PC.
- `docs/NEAR-GATES.md`: every NEAR fact this repo relies on, with its source. CAIP-2 ids default to `near:testnet` /
  `near:mainnet` (A5). **x402 NEAR payments carry no memo** (A7), so claims match transfers by tx hash only.
- `architecture-adminui-jobs.md`: the paid-jobs requirements (ARCH-201..210).
- `DOCKERIZE-PLAN.md`: why and how near-watch moved into Docker.
- `services/custody`: OutLayer TEE wallets, deferred.
- `HACKATHON-DISCLOSURE.md`: what was ported and what was built in the hackathon window.

Never paste `docker inspect` or `docker compose config` output anywhere: they can print secret values.

MIT licensed.
