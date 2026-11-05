# BUILD_LOG (chainaim-adminUI-NEAR)

## 2026-11-05 — Jobs tab (architecture-adminui-jobs.md ARCH-201, ARCH-206..210)
- Before (ARCH-201): `npm --prefix services\near-watch test` → tests 34, pass 34, fail 0. `npm --prefix apps\admin-console test` → tests 39, pass 39, fail 0. `npm --prefix apps\admin-console run build` → OK.
- ARCH-206: new `services/near-watch/src/jobs.ts` holds the strict job-event parser (unknown fields, wrong types, negative or fractional numbers, model ids or entity kinds that look like text, more than 6 USD decimals: all refused whole, `job_refused`) and `JobBook`. `store.ts` gets a new `jobs` table (CREATE IF NOT EXISTS; no existing table altered; schema stays 2). `server.ts` gets `POST /ingest/job`, with the same key, content type, size and batch rules as /ingest/claim, and 404 without an ingest key. `liveops.ts` gets `ingestJob`.
- ARCH-207: claim ↔ job by the route `POST /v1/jobs/<32 hex>/release`. quoted → paid → released, or expired only while no claim is linked. A late job_quoted fills a claim-only row. `job_unknown` is raised once per job. Lost compute = modelUsd + callFeesUsd + analystUsd of expired jobs, in bigint micro-dollars. Bus/SSE event `job` = {job, summary}, re-sent when the job's transfer changes reconcile state.
- ARCH-208: `GET /api/jobs?limit=&network=&state=` (state outside quoted|paid|released|expired → 400) and `GET /api/job/<jobId>` (job, claim, tx, reconcile; 404 unknown). The snapshot gets `jobs` only when a job exists.
- ARCH-209: watch role `relayer`. `--gas-per-payment-near` is required with one and `--relayer-min-payments` defaults to 500. `LowGasRule` (alerts.ts) does exact yoctoNEAR division and raises `low_gas` at most once per `--alert-every-sec`. Recorded relayer balance (x402-near-payment.json view_account): 9.998670422279634399999996 NEAR = 30026 payments at 0.000333.
- ARCH-210: the console's `lib/types.ts` (Job*, EVENT_NAMES + job), `lib/proxy.ts` (`jobs: 1`, `job: 2`) and `lib/live-store.ts` (`job` event, hello.jobs, `jobs`/`jobSummary`, a change-log line per state change) were changed. New `components/tabs/jobs.tsx`. `live-console.tsx` TABS gets "Jobs" (#jobs). `globals.css` gets 2 lines (job state colours, chip done/off).
- Tests: `services/near-watch/test/jobs.test.ts` (16) runs the real app over the recorded-data doubles, with the H3ZFsVY1… payment matched by the rpc road. `apps/admin-console/test/jobs.test.ts` (4) streams the real near-watch WatchServer through proxyStream and proxyGet.
- After: near-watch → tests 50, pass 50, fail 0; `npx tsc -p .` OK. admin-console → tests 43, pass 43, fail 0; `npx tsc -p .` OK; `npm run build` OK (routes /, /api/watch/[...path], /api/watch/stream).
- Not done: the Jobs tab has not been rendered in a browser (owner M-UI, ARCH-211). The live paid and unpaid jobs are owner steps M-G, M-P, M-W, M-C and M-UI.

## 2026-11-06: near-watch in Docker (DOCKERIZE-PLAN.md N0, N1, N2, N4)
- N0, before: near-watch tests 50/50, admin-console tests 43/43 (the plan's 34/39 predate the jobs build). The `dockerize` branch was not created: no git command was run. Every edit is a new file or an added doc line.
- N1: services/near-watch/src/server.ts was read in full. It has no Host-header, CORS or loopback check, only the admin key on /api and /stream and the ingest key on /ingest. So no code change was needed and nothing under services/ or apps/ was edited.
- New files:
  - `services/near-watch/Dockerfile`: node:24-slim; copies near-watch and chain-core package.json and src only; no npm install; runs as the node user; /data is owned by node.
  - `.dockerignore`.
  - `docker-compose.yml`: service near-watch, container ca-near-watch, external network chainaim-test, port 127.0.0.1:8790, named volume near-watch-data, healthcheck on /healthz. The command is today's M-W command plus `--bind 0.0.0.0 --store /data/watch.sqlite`.
  - `up.ps1` and `down.ps1`.
- Departure from the plan: the secrets file is mounted read-only at /run/secrets/near-watch.env and read with `node --env-file`, rather than through compose `env_file`. It is the same parser as start-live.ps1 today, and the values stay out of the container env, `docker compose config` and `docker inspect`.
- N2, run here:
  - `.\up.ps1 -ImportStore` copied watch.sqlite and its -wal into the volume. The PC file was only read.
  - The container is healthy. Start-up backfilled from the stored cursor (276385366..276386119). `stack.ps1`: near-watch ok=True, rpc live, reconcile counts returned (matched 256, only_on_ledger 1). Admin UI `/` answers 200.
  - `/api/feeds` shows hosts only; the QuickNode token is in neither /api/feeds nor the container log. `/api/snapshot` without the key answers 401.
  - `docker compose restart near-watch`: it backfilled 276386206..276386211 from the cursor. 257 txs before and after, all unique.
  - From the chainaim-test network: near-watch:8790, ca-near-watch:8790 and host.docker.internal:8790 all answer /healthz 200, and /ingest/claim without the key answers 401. The running ca-paywall posts to host.docker.internal:8790/ingest/claim with the same key as NEAR_WATCH_INGEST_KEY (compared by hash), so claims reach the container with no paywall change.
- External conditions seen, not caused by Docker: QuickNode answers "daily request limit reached", so qn-rpc and the backfill road are down. neardata answers HTTP 429 (no NEARDATA_API_KEY). The public rpc road carries the blocks.
- After: near-watch 50/50 and admin-console 43/43, with the container on 8790.
- Not done (private-ai's plan P5, owner run): point the paywall at `http://near-watch:8790/ingest/claim` and the console at `--job-feed-url http://near-watch:8790/ingest/job`. Then make one paid NEAR call and one paid job (N3).
