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

## 2026-11-06 — near-watch watch list from a setting (chainiam-private-ai architecture-tab03-agent-mode.md ARCH-313)
- New config/near-watch-watch.conf (WATCH=label=role=account lines, GAS_PER_PAYMENT_NEAR; committed, not secret) with today's exact values. up.ps1: -WatchFile (default that file), -Watch / -GasPerPaymentNear (one start), -DryRun (writes runtime/compose/near-watch.yml, checks it with compose, prints near-watch's command only, starts nothing). Without the file and without -Watch, docker-compose.yml's own command runs. .gitignore: runtime/. cmd.md A4 updated. near-watch source unchanged.
- Compose alone → `--bind 0.0.0.0 --port 8790 --store /data/watch.sqlite --watch buyer1=buyer=chainaim-buyer-seller.testnet --watch relayer=relayer=chainaim-relayer-seller.testnet --gas-per-payment-near 0.000333`; `.\up.ps1 -DryRun` → the same command; `-Watch buyer1=...,t02=buyer=chainaim-t02-seller.testnet,t03=buyer=chainaim-t03-seller.testnet,relayer=...` → four --watch entries; `-Watch "bad entry"` → refused.
- Tests: services/near-watch 50/50, apps/admin-console 43/43. ca-near-watch was not restarted. Owner: add the tenant lines (M4 in chainiam-private-ai MANUAL_SETUP.md), then .\down.ps1; .\up.ps1.

## 2026-11-06: NEAR AI model attestation per paid job (PLAN-adminui-nearai-attestation.md ARCH-501..505)
- Before: near-watch 50/50, admin-console 43/43. Re-read jobs.ts, store.ts, server.ts, liveops.ts, events.ts, lib/types.ts, lib/live-store.ts and components/tabs/jobs.tsx. The job row and its table are in store.ts (CREATE IF NOT EXISTS, schema 2). Copies of the originals are in the session scratchpad (attest-before/).
- ARCH-501 (`services/near-watch/src/jobs.ts`): JOB_EVENTS gains `job_attested`, with a strict parser in the shape of the companion plan's ARCH-412. Unknown fields are refused; each bad field is refused (400) with the field named; the ingest key is unchanged.
  - Choices the plan left open: `step` is `query` | `answer` (the model steps job_quoted carries). The ed25519 key is 64 hex, with or without 0x. `reason` is printable ASCII.
  - `reportFetchedAt` is stored as `reportFetchedMs`, the same naming as the job row's ms fields.
- ARCH-502 (`store.ts`): new table `job_attestations` (job_id PK, network, ts_ms, summary, calls_json, received_ms). No existing table is altered; schema stays 2.
  - The newest event per job replaces the stored one; an older or identical one counts as a repeat.
  - An attestation is kept even before its job is known, and no job row is made from it.
- ARCH-503: `JobBook.view` adds `attestation` only when one is stored; `summary` adds `attestation` counts (known jobs per summary) only once any is stored. So /api/jobs, /api/job/<id>, SSE `job` and the snapshot are unchanged otherwise. server.ts changed by a comment only.
- ARCH-504:
  - `lib/types.ts`: JobAttestation, AttestedCall, ATTEST_SUMMARIES.
  - `lib/live-store.ts`: asJob checks an attestation when one is present; the summary keeps its `attestation` counts.
  - `components/tabs/jobs.tsx`:
    - an "attested" column (✓ attested · ◐ partial · ✗ unverified · – not applicable · blank = no data);
    - an "attested jobs N of M" tile, with KPIs changed from `six` to `seven` (an existing CSS class);
    - a per-call attestation table with a cloud.near.ai/verify link.
  - globals.css is unchanged.
- Tests:
  - `services/near-watch/test/attestation.test.ts` (9): real app over the recorded-data doubles, real SQLite file, restart.
  - `apps/admin-console/test/attestation.test.ts` (5): the real near-watch WatchServer through proxyStream and proxyGet.
  - Existing tests unchanged.
- After (ARCH-505):
  - near-watch 59/59, `npx tsc -p .` OK.
  - admin-console 48/48, `npx tsc -p .` OK.
  - `npm run build` OK in a copy of the app, because the live admin UI (8800) serves apps/admin-console/.next and was not touched.
- Not done:
  - The tab has not been rendered in a browser.
  - ca-near-watch was not rebuilt and the 8800 UI was not restarted; both are owner steps.
  - private-ai has no `job_attested` sender yet (its plan ARCH-412). Until then the column stays blank.
  - ARCH-506 (live) is an owner step.

## 2026-11-11: signed quote and receipt per paid job (ARCH-701..703; chainaim-private-ai privateAI-design-33 section 7, chat near-ai-impl-8)
- ARCH-IDs new here (unused before): ARCH-701 job_receipt ingest, ARCH-702 job_quoted.ap2, ARCH-703 Jobs tab display.
- ARCH-701 (`services/near-watch/src/jobs.ts`): JOB_EVENTS gains `job_receipt` {receiptId 32 hex, keyId 32 hex, resultSha256
  and filesRoot 64 hex, settled, transaction base58 or null; settled iff transaction}; unknown fields refused. Stored in a
  new table `job_receipts` (no table altered, schema stays 2), before its job too; a settled receipt replaces an unsettled
  one, never the reverse. JobView.receipt only when stored.
- ARCH-702: job_quoted may carry `ap2 {kid 32 hex, merchantAuthSha256 64 hex}`, stored in new table `job_signed_quotes`;
  JobView.signedQuote only when stored. A job without either is exactly as before.
- ARCH-703 (`apps/admin-console`): lib/proof-view.ts (pure), Jobs tab columns "signed quote" (✓ key id / –) and "receipt"
  (✓ settled / ⧗ pending / –), job detail table (key id, quote hash, receipt id, signing key, result hash, files root,
  settlement), "Where this comes from" rows; lib/types.ts; live-store.ts asJob checks both shapes when present.
- Tests (Linux workspace): near-watch 72/72 incl. new test/proofs.test.ts 7; `tsc -p .` OK. admin-console 64/64 incl. new
  test/proof-view.test.ts 3 and jobs.test.ts +1; `tsc -p .` OK. `next build` not run here (owner: desk.ps1 -All rebuilds
  the UI when its source changed; nearadminup.ps1 rebuilds ca-near-watch).
- Private side: the console sends job_receipt with --job-feed-receipts on and ap2 with --job-feed-ap2 on; private-ai
  up.ps1 now turns both on when the feed is on. Its test-console/test/job-feed-ap2.test.ts posts both to this near-watch's
  real code and finds them stored.

## 2026-11-14: the tenant's checkout mandate per paid job (ARCH-704..705; chainaim-private-ai privateAI-design-42 ARCH-710, chat near-ai-impl-15)

- ARCH-704 (`services/near-watch`): job_receipt may carry `mandate {kid 32 hex, tenant ^[a-z0-9_-]{1,32}$, sha256 64 hex}`;
  any other field (accountId, nonce, the token) is refused with the whole event. New table `job_mandates`, written and
  cleared with the job's receipt; JobView.mandate only when stored. A job without one is exactly as before.
- ARCH-705 (`apps/admin-console`): lib/proof-view.ts mandateCell + dealText + three detail rows; Jobs table column
  "tenant mandate" (colSpan 11); "Where this comes from" row; lib/types.ts; live-store.ts asJob refuses a malformed mandate.
- Tests (Linux workspace): near-watch 77/78 (1 skip, as before) incl. new test/mandate.test.ts 5; `tsc -p .` OK.
  admin-console 68/68 incl. new test/mandate-view.test.ts 4; `tsc -p .` OK. `next build` not run here (desk.ps1 -All
  rebuilds the UI; nearadminup.ps1 rebuilds ca-near-watch). Private side: test-console/test/job-feed-mandate.test.ts posts
  the mandate to this near-watch's real code and finds it stored.
