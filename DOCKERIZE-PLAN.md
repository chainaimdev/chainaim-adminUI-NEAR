# DOCKERIZE-PLAN — chainaim-adminUI-NEAR (near-watch in Docker, admin UI local)

Status: PLAN ONLY. No code has been changed. Written 2026-11-06.
Companion plan: `chainiam-private-ai/DOCKERIZE-PLAN.md` (its paywall and console send claims and job events here).

## 1. Goal

Run near-watch (the backend) in Docker with one command, keep the 8800 admin UI on the PC, and keep every
current working exactly as it is. Local step before NEAR TEE (Phala Cloud / dstack).

Hard rules:
- Nothing that works today may break; defaults stay today's behaviour.
- No mocks in production code (the recorded testnet fixtures and doubles stay test-only).
- No hardcoding: everything through the existing flags and env vars.
- No new features. No change to roads, reconcile, jobs, alerts, the console's proxy or its pages.
- Files are read in full before any edit; unverified items are in section 9.

## 2. What runs today (verified from the files)

| Part | How it runs | Port | Source |
|---|---|---|---|
| near-watch | Node, `test-console/start-live.ps1` (`node --env-file=$Secrets\near-watch.env src\main.ts`) | 127.0.0.1:8790 | `services/near-watch/src/config.ts`: `--bind` default 127.0.0.1, `--port` 8790, `--store` default `../../data/near-watch/watch.sqlite` |
| admin-console (Next.js UI + server-side proxy holding `ADMIN_API_KEY`) | Node, `start-live.ps1` (`scripts/console.ts --mode start`) | 127.0.0.1:8800 | `apps/admin-console/scripts/console.ts`, `lib/config.ts` |

Facts that shape the plan:
- near-watch already has `--bind`, `--port`, `--store`, `--watch`, `--paywall-log-file`, `--ingest-key-env`;
  secrets and chain values come from env only (`ADMIN_API_KEY`, `NEAR_WATCH_INGEST_KEY`,
  `NEAR_USDC_CONTRACT_TESTNET`, `NEAR_PAY_TO_TESTNET`, optional `QUICKNODE_NEAR_HTTP_TESTNET`, `NEARDATA_API_KEY`).
- near-watch uses `node:sqlite` (no native module) and imports `../../../packages/chain-core`, so its image
  build context must be the repo root. No npm runtime dependencies (`package.json` has devDependencies only).
- admin-console refuses a non-loopback `--bind` and plain-http non-loopback `NEAR_WATCH_URL` (`lib/config.ts`).
  Keeping the UI on the PC and publishing near-watch on `127.0.0.1:8790` satisfies both rules unchanged.
- A watched relayer needs `--gas-per-payment-near` (config.ts ARCH-209).

## 3. Target

```
YOUR PC                                         DOCKER (network chainaim-test, shared with private-ai)
---------------------------------------         -------------------------------------------------------
Browser                                         near-watch  :8790  (published 127.0.0.1:8790)
8800 admin UI (Node, unchanged)                   <- paywall    POST /ingest/claim (PAYMENT_LOG_URL)
  NEAR_WATCH_URL=http://127.0.0.1:8790 -------->  <- console-api POST /ingest/job  (--job-feed-url)
                                                  -> neardata / QuickNode / public RPC (internet)
                                                volume near-watch-data -> /data/watch.sqlite
```

### 3.1 Node -> Docker

| Service | Today | In Docker | Port on PC |
|---|---|---|---|
| near-watch | Node 127.0.0.1:8790 | service `near-watch`, container `ca-near-watch` | 127.0.0.1:8790 |
| admin-console | Node 127.0.0.1:8800 | stays on the PC (no change) | 127.0.0.1:8800 |

### 3.2 URLs

| Caller -> callee | Today | After | Set by |
|---|---|---|---|
| admin UI -> near-watch | `http://127.0.0.1:8790` | unchanged | `--near-watch-url` |
| paywall (Docker) -> near-watch | `host.docker.internal:8790` | `http://near-watch:8790/ingest/claim` | paywall `PAYMENT_LOG_URL` |
| console-api (Docker) -> near-watch | `http://127.0.0.1:8790/ingest/job` | `http://near-watch:8790/ingest/job` | console `--job-feed-url` |

## 4. Code changes

Expected: NONE in this repo. near-watch already exposes `--bind` and `--store`; the admin UI stays local with
its current settings. If reading `services/near-watch/src/server.ts` (section 9) shows a Host-header or
loopback check that refuses `near-watch:8790`, the fix is a new flag (default = today) with tests, decided
then — not assumed now.

## 5. New files (build phase)

| File | Notes |
|---|---|
| `services/near-watch/Dockerfile` | `node:24-slim`; context = repo root; copies `services/near-watch/{package.json,src}` and `packages/chain-core/src`; no `npm ci` needed for runtime (devDependencies only); runs as `node` user; `CMD node src/main.ts` with flags from compose |
| `.dockerignore` (repo root) | exclude `node_modules`, `.next`, `data`, `.git`, `.env*`, tests |
| `docker-compose.yml` (repo root) | service `near-watch`; network `chainaim-test` (external); `env_file: C:\PRIV-AI-SECRETS\near-watch.env` (or `$HOME\chainaim-secrets\near-watch.env`, whichever you use today); port `127.0.0.1:8790:8790`; volume `near-watch-data:/data`; healthcheck on `/healthz` |
| `up.ps1` / `down.ps1` | compose up, wait for `/healthz`, start the admin UI window as `start-live.ps1` does today (console part only); down stops both |

near-watch command in compose:
`--bind 0.0.0.0 --port 8790 --store /data/watch.sqlite` + the same `--watch label=role=account` entries and
`--gas-per-payment-near` you use today (copied from your current start command, not invented).

Existing data: today's SQLite is `data/near-watch/watch.sqlite`. Plan: keep it as is for rollback, and copy it
once into the volume so history and cursors carry over (backfill would otherwise rebuild from the chain within
`--backfill-max-blocks`).

## 6. Phases

| Phase | Work | Who | Gate |
|---|---|---|---|
| N0 | Branch `dockerize`; `npm --prefix services\near-watch test` (34) and `npm --prefix apps\admin-console test` (39); record your current start-live command | Manual | Both pass, recorded |
| N1 | Read `services/near-watch/src/server.ts` (and any Host check); write Dockerfile, `.dockerignore`, compose | AI | Review done; no code change needed or a flagged one agreed |
| N2 | Stop Node near-watch; `docker compose up -d`; copy the SQLite once; start the admin UI unchanged | You run | `stack.ps1` (this repo) shows roads live and block heights moving; UI shows blocks |
| N3 | Point private-ai's paywall and console-api at `http://near-watch:8790` (their plan P5) | AI writes, you run | One paid NEAR call: claim + chain tx + `matched`; one paid job: quoted → released |
| N4 | Docs: README, SETUP-COMMANDS.md | AI | Docs match what ran |

## 7. Verification

- Tests before and after: near-watch 34/34, admin-console 39/39 (README).
- `test-console\stack.ps1` (this repo): near-watch ok, every configured road `live`, reconcile counts returned.
- `curl /api/feeds` with the admin key shows hosts only, no QuickNode token (existing guarantee, re-checked).
- Restart test: `docker compose restart near-watch` → log shows `backfill <cursor>..<tip>`, no duplicate rows.

## 8. Rollback

1. `docker compose down` (the volume is kept).
2. `.\test-console\start-live.ps1` exactly as today (it uses the untouched `data/near-watch/watch.sqlite`).
3. Point the paywall back with `stack.ps1 -Recreate paywall -PaymentLogUrl http://host.docker.internal:8790/ingest/claim ...` if it was changed.

## 9. Open items to verify before building

1. `services/near-watch/src/server.ts`: Host-header checks, CORS, how `/ingest/*` authenticates — not read yet.
2. Your current near-watch start command (`--watch` entries, `--gas-per-payment-near`, `--paywall-log-file`),
   and which secrets folder holds `near-watch.env`.
3. SQLite on a Docker named volume vs a Windows bind mount: plan uses a named volume (bind mounts of SQLite
   files from Windows are a known locking risk — to confirm with Docker Desktop docs before relying on a bind mount).
4. The admin key stays in the local admin UI's server (by design for now); decide before the TEE step whether
   the UI moves inside or gets a login.

Do not paste `docker compose config` or `docker inspect` output into chat: both print environment values
(admin key, ingest key, QuickNode URL with token).
