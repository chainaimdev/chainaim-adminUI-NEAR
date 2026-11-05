# ChainAim admin UI (NEAR): Jobs tab — Architecture

Build plan for a live **Jobs** tab in `chainaim-adminUI-NEAR` that shows every **paid** tab 03 job of `chainiam-private-ai` from Ask to result released: steps, models, tokens, masking counts, full cost breakdown, payment, reconcile, and jobs that were quoted but never paid.
Written 2026-11-05. **[read]** = read in the repositories on 2026-11-05. **[owner]** = manual step. No mocks: anything that cannot be proven locally is an owner step with a live acceptance.

Requirement IDs start at **ARCH-201** so they never collide with `ARCH-001…018` (`architecture-xrpl-migration.md`) or `ARCH-101…115` (paid jobs, `architecture.md`).

## 1. What this is

Today the admin UI (port 8800) shows only the payment half of a paid job: the paywall's claim, the chain transfer and their reconcile state. It knows nothing about the job behind a payment. This build adds a job event feed from the test console to near-watch and a **Jobs** tab that joins each job to its claim and chain transfer, plus a relayer gas alert.

Decisions taken (owner, 2026-11-05):
- Full cost breakdown per job.
- Masking counts included, delivered by the gateway as a response header (option A), **kinds and counts only**; the paywall strips that header from public responses.
- Quoted-but-not-paid and expired jobs shown, with a running "lost compute" total.
- Paid jobs only (free tab 03 runs and tab 02 chats are not shown).
- Relayer balance alert.

## 2. Stack and constraints

- near-watch: Node 24, TypeScript run directly, `node:sqlite` `DatabaseSync` [read: `services/near-watch/src/store.ts`].
- Admin console: Next.js, server-side proxy to near-watch, GET only, allowlisted routes [read: `apps/admin-console/lib/proxy.ts`].
- Private-ai: console `test-console/console/{server.ts,jobs.ts}`, `packages/crossask`, gateway `services/gateway`, paywall `services/paywall`.
- Hard constraints:
  1. **Off by default, nothing else changes.** Every new behaviour sits behind a flag or env var that defaults off; with them off, every existing route, event, table, log line and page is unchanged.
  2. **Surgical, additive edits.** New files where possible; existing files gain only flag-gated branches.
  3. **Never text.** No question, SQL, result row, answer, placeholder, placeholder map, file path or key reaches near-watch, the admin UI, or any log. Model ids, zones, counts, kinds, times, amounts, ids and hashes only.
  4. **Fail closed on ingest.** A malformed job event is refused (400) and alerted (`job_refused`), never partially stored.
  5. **No key in the browser.** The console sends to `/ingest/job` with the ingest key; the admin console reads through its server-side proxy with the admin key, as today.

## 3. Facts this plan relies on (read 2026-11-05)

| # | Fact | Source |
|---|---|---|
| F1 | near-watch takes `POST /ingest/claim` and `POST /ingest/trace` with `x-ingest-key` (must differ from the admin key), batches up to `INGEST_MAX_ITEMS`, answers 202 `{accepted, repeats, refused}`; `/ingest` is 404 when no ingest key is set. | `near-watch/src/server.ts` lines 1-27, 157-196 |
| F2 | Ingest is parsed by a strict parser that throws `IngestError`; `LiveOps.ingestClaim/ingestTrace` store, count repeats, emit on the bus (`claim`, `trace`) and alert refusals through `AlertGate`. | `liveops.ts`, `traces.ts`, `claims.ts` |
| F3 | The store is SQLite with tables `meta, txs, roads, cursors, claims, traces, recon` created with `CREATE TABLE IF NOT EXISTS`. | `store.ts` lines 92-126 |
| F4 | Every paywall claim for a job carries the route `POST /v1/jobs/<32-hex jobId>/release`, its invoice id and tx hash (seen live: claim for job `9001b38e…141b`, tx `6RoFLY…BtZ8`, reconcile `matched`). | admin UI Reconcile tab, 2026-11-05; `paywall/src/app.ts` `onAfterSettle` |
| F5 | Watchlist roles are `payto`, `buyer`, `other` (`--watch label=role=account`); `BalanceWatch` reads balances of watched entries; `LowCallsRule` raises `low_calls` for buyers. | `config.ts` line 113, `balances.ts`, `alerts.ts` |
| F6 | Admin console tabs are `["Live ops","Ledger","Reconcile","Feeds","Seller wallet"]`, selected by URL hash; SSE events handled in `live-store.ts` (`hello, ledger, status, balances, alert, tx, road, claim, trace, reconcile, seller`). | `components/live-console.tsx` line 26, `lib/live-store.ts` |
| F7 | The proxy allows only listed first path segments with fixed arity (`ALLOWED_ROUTES`) and query keys `limit, network, state`. | `lib/proxy.ts` lines 14-46 |
| F8 | The console already holds per job `{jobId, amount, breakdown, expiresAt}` and logs `job_quoted` (ids and amounts only); `crossAsk` returns `served[]` with `model, zone, usage`. | private-ai `test-console/console/jobs.ts`, `server.ts` 545-577, `packages/crossask/src/index.ts` |
| F9 | The gateway computes `entityCounts` and `residual` per chat call (`ChatRecord`) and already sends `x-chainaim-model`, `x-chainaim-zone`, `x-chainaim-restored`, `x-chainaim-decision-id` headers. | `gateway/src/chat.ts` 60-85, `server.ts` chat() |
| F10 | The paywall passes every `x-chainaim-*` gateway header back to the public caller (`PASS_BACK = /^(content-type|retry-after|x-chainaim-[a-z-]+)$/`). | `paywall/src/app.ts` |
| F11 | Measured gas per x402 NEAR payment: 0.000332587 NEAR (tx `H3ZFsVY1…`); the live job on 2026-11-05 cost the relayer 0.000332202 NEAR. Relayer `chainaim-relayer-seller.testnet` held 9.9148 NEAR after it. | NEAR TestNet RPC, 2026-11-05 |

Not verified here: how Next.js renders the new tab under the current theme (checked in the owner run, M-UI).

## 4. Components

| Component | Repo | Change | Responsibility |
|---|---|---|---|
| Gateway | private-ai | edit, flag `--expose-entity-counts on|off` (default off) | Adds `x-chainaim-entity-counts: {"PERSON":3,…}` and `x-chainaim-residual: pass|refused` to chat replies. Counts and kinds only. |
| Paywall | private-ai | edit (always on, one line) | Drops `x-chainaim-entity-counts` and `x-chainaim-residual` from responses to public callers. |
| crossask | private-ai | edit (additive) | `ChatReply` gains optional `entityCounts` and `residual`, copied from those headers; crossAsk records per-step timings (`relationsMs`, `queryMs`, `sqlMs`, `answerMs`). |
| Console job feed | private-ai | new `test-console/console/job-feed.ts` + flag-gated edits in `server.ts`, `jobs.ts` | Sends `job_quoted`, `job_released`, `job_expired` to near-watch `/ingest/job`. |
| near-watch jobs | adminUI | new `src/jobs.ts` + edits in `server.ts`, `store.ts`, `liveops.ts`, `events.ts` | Parses, stores and streams jobs; joins job ↔ claim ↔ transfer; lost-compute total; `GET /api/jobs`, `GET /api/job/<jobId>`. |
| Relayer gas alert | adminUI | new rule in `alerts.ts`; new watch role `relayer` | `low_gas` alert when the relayer's NEAR covers fewer than `--relayer-min-payments` payments. |
| Admin console | adminUI | new `components/tabs/jobs.tsx`; edits in `live-console.tsx`, `live-store.ts`, `lib/types.ts`, `lib/proxy.ts` | The **Jobs** tab, live over the existing SSE. |

## 5. Data flow

```
Tab 03 Ask (paid) ─▶ console: crossAsk ─▶ gateway (per call: usage + x-chainaim-entity-counts + x-chainaim-residual)
   console: quote, hold ─▶ POST near-watch /ingest/job {v:1, event:"job_quoted", jobId, network, amount, totalUsd,
                                                       expiresAt, steps[…], breakdown{…}}
Pay ─▶ paywall settles ─▶ POST near-watch /ingest/claim (unchanged; route carries the jobId)
   paywall ─▶ console /internal/jobs/:id/released ─▶ console ─▶ POST /ingest/job {event:"job_released", jobId, ts}
Expiry (no payment) ─▶ console ─▶ POST /ingest/job {event:"job_expired", jobId, ts}

near-watch: jobs table ⟵ job events; job ↔ claim by jobId parsed from claim.route; claim ↔ tx ↔ reconcile (unchanged)
   bus "job" event ─▶ SSE ─▶ admin console Jobs tab
```

Job states: `quoted` → `paid` (claim seen) → `released` (console confirmed) | `expired` (no payment before expiresAt). A claim for a job near-watch has never seen is shown as `paid (no job event)` and alerted `job_unknown`.

## 6. External dependencies

| Service | Used for | Real local option | Credential |
|---|---|---|---|
| near-watch + admin console | ingest, store, UI | `test-console\start-live.ps1 -Secrets C:\PRIV-AI-SECRETS` (as today) | `ADMIN_API_KEY`, `NEAR_WATCH_INGEST_KEY` (existing) |
| private-ai stack | jobs | `stack.ps1`, `switch-models.ps1 -To ollama-cpu-8gb-all`, console with `--paid-jobs on` (as on 2026-11-05) | `PAID_JOBS_KEY` (existing); console also needs `NEAR_WATCH_INGEST_KEY` |
| NEAR TestNet | payment, relayer balance | public RPC / QuickNode (as today) | none for reads |

Baseline (before the first edit and after every task, must pass unchanged):
adminUI: `npm --prefix services\near-watch test` (34), `npm --prefix apps\admin-console test` (39), `npm --prefix apps\admin-console run build`.
private-ai: `npm test`, `npm run test:paywall`, `npm --prefix packages/crossask test`, `npm --prefix services/web test` (counts as recorded in BUILD_LOG.md on 2026-11-05).

---

# Requirements

### ARCH-201 — Off by default, nothing else changes
**Requirement:** With `--expose-entity-counts` off (gateway), `--job-feed-url` unset (console), and no `jobs` ingest traffic, every existing route, SSE event, table, log line and console tab MUST behave as today. New SQLite tables are created with `IF NOT EXISTS` and existing tables are not altered.
**Acceptance:** Full baseline (§6) passes with the same counts before and after, recorded in each repo's BUILD_LOG. Test `ARCH-201: gateway reply headers unchanged without --expose-entity-counts`. Test `ARCH-201: snapshot keys unchanged when no job was ingested` (near-watch).

### ARCH-202 — Gateway masking-count headers (flag-gated)
**Requirement:** With `--expose-entity-counts on`, a successful chat reply carries `x-chainaim-entity-counts` = compact JSON of `record.entityCounts` (entity kind → integer, `{}` when none) and `x-chainaim-residual` = `pass` or `refused`. No value, placeholder or text is ever in these headers. Off: neither header is sent.
**Acceptance:** `npm test` (gateway): `ARCH-202:` tests with the real gateway server and Presidio stand-in used by existing tests: headers present and equal to the ledger line's counts for the same `decisionId`; absent with the flag off; a synthetic marker value in the prompt never appears in any header.

### ARCH-203 — Paywall never forwards masking counts to the public
**Requirement:** The paywall drops `x-chainaim-entity-counts` and `x-chainaim-residual` from every response it proxies; all other `x-chainaim-*` headers pass back as today.
**Acceptance:** `npm run test:paywall`: `ARCH-203:` a gateway double sending both headers; the paid response to the caller lacks both and still carries `x-chainaim-model`.

### ARCH-204 — crossAsk carries counts and step timings
**Requirement:** `ChatReply` gains optional `entityCounts?: Record<string, number>` and `residual?: "pass" | "refused"`, parsed from the headers (malformed header → field absent). `CrossAskResult` gains optional `timings: { relationsMs, queryMs, sqlMs, answerMs }` (whole milliseconds; `answerMs` absent with phrase `none`). Existing fields unchanged.
**Acceptance:** `npm --prefix packages/crossask test`: `ARCH-204:` header parsing (valid, absent, malformed) and timings present with phrase `llm`; existing crossask tests unchanged.

### ARCH-205 — Console job feed
**Requirement:** With `--paid-jobs on` and `--job-feed-url URL` (e.g. `http://127.0.0.1:8790/ingest/job`) and the ingest key in the env var named by `--job-feed-key-env` (default `NEAR_WATCH_INGEST_KEY`, ≥ 24 chars; start-up refuses otherwise), the console sends one JSON event per job transition to near-watch, not awaited by the request path (a feed failure never blocks or fails a job), timeout `--job-feed-timeout-ms` (default 5000), at most `--job-feed-max-inflight` (default 20) concurrent posts; a failed post is logged once as `job_feed_failed` (job id and reason only).
Events (`v: 1`, `ts` ISO, `jobId` 32 hex, `network` CAIP-2):
- `job_quoted`: `amount` (USDC base units), `totalUsd`, `expiresAt`, `steps` = `[{name:"analyst", ms, files, relations}, {name:"query"|"answer", ms, model, zone, promptTokens, completionTokens, usd, entityCounts?, residual?}, {name:"sql", ms, rows}]`, `breakdown` = the quote's breakdown (calls, modelUsd, callFeesUsd, analystUsd, nearGasUsd, marginPct, minPriceUsd, minApplied).
- `job_released`: on `POST /internal/jobs/:id/released`.
- `job_expired`: when a held job passes `expiresAt` without release (checked every `--job-expiry-check-sec`, default 30).
**Acceptance:** `ARCH-205:` tests in `test-console/test/` with a real near-watch server started from its code (as `apps/admin-console/test/watch-server.ts` does): each event arrives once and is accepted; a near-watch that is down does not change the `/jobs/crossask` response; the posted bodies contain no question, SQL, rows, answer or path (synthetic marker check).

### ARCH-206 — near-watch: job ingest and store
**Requirement:** `POST /ingest/job` (same key, content type, size and batch rules as `/ingest/claim`, F1) parses each event strictly (`src/jobs.ts`, `IngestError` on any unknown field type, unknown event, bad id, negative number or text-like field longer than its limit) and stores it in new tables `jobs (job_id PK, network, state, amount, total_usd, quoted_ms, expires_ms, released_ms, expired_ms, breakdown_json, steps_json, received_ms)`. A repeat event is accepted and dropped (202, counted as repeat). Refusals are alerted `job_refused` through `AlertGate`. Off (404) when no ingest key, like the other ingest routes.
**Acceptance:** `npm --prefix services\near-watch test`: `ARCH-206:` accepted, repeat, each refusal reason, 401 without key, 404 without ingest key, restart keeps jobs (same SQLite file).

### ARCH-207 — near-watch: join, states and lost compute
**Requirement:** A claim whose route matches `^POST /v1/jobs/([0-9a-f]{32})/release$` is linked to that job (`paid`, with invoice, tx hash, payer); the job then shows the claim's reconcile state (unchanged reconciler). State rules: `quoted` → `paid` on a linked claim; → `released` on `job_released`; → `expired` on `job_expired` only if no claim is linked. A claim for an unknown job raises `job_unknown` once. **Lost compute** = sum of `breakdown` model cost + call fees + analyst fee of `expired` jobs, per network, in the snapshot and `/api/jobs`. Every job change is emitted on the bus as event `job` and streamed over SSE.
**Acceptance:** `ARCH-207:` tests with the recorded real testnet payment fixture already used by near-watch tests: quoted → paid → released; quoted → expired with lost compute; claim before job event (late `job_quoted`) still links; unknown-job claim alerts once; SSE carries `job` events.

### ARCH-208 — near-watch read API
**Requirement:** `GET /api/jobs?limit=&network=&state=` (newest first, counts per state, lost compute) and `GET /api/job/<jobId>` (job, steps, breakdown, linked claim, tx, reconcile) with the admin key, as the other `/api` routes. Snapshot gains `jobs: {counts, recent, lostCompute}` only when at least one job exists (ARCH-201).
**Acceptance:** `ARCH-208:` tests: 401 without admin key; limit and state filters; unknown id 404.

### ARCH-209 — Relayer gas alert
**Requirement:** Watch role `relayer` (`--watch relayer=relayer=<account>`) is read by `BalanceWatch` like the others (NEAR balance). New `LowGasRule`: `warn` alert `low_gas` when the relayer's NEAR ÷ `--gas-per-payment-near` (required with a relayer entry; owner sets it from F11) is below `--relayer-min-payments` (default 500), at most once per `--alert-every-sec`. The Seller wallet and Live ops panels ignore the new role.
**Acceptance:** `ARCH-209:` tests with the RPC double: above threshold no alert; below → one `low_gas`; start-up error when a relayer is watched without `--gas-per-payment-near`.

### ARCH-210 — Admin console: Jobs tab
**Requirement:** `TABS` gains `"Jobs"` (hash `#jobs`). `ALLOWED_ROUTES` gains `jobs: 1` and `job: 2`; `live-store.ts` handles the `job` SSE event and the snapshot's `jobs`. The tab shows: counts per state, lost compute; a job list (time, job id, payer, network, total, state, reconcile); a selected job's step strip (Analyst → Query model → SQL → Answer model → Quote → Paid → Released/Expired) and step table (time, model, zone, tokens in/out, masking counts, residual, step cost) and the full breakdown (each model call's cost, call fees, analyst fee, gas fee, margin %, minimum and whether it applied, total). Text fields are never rendered because none are received.
**Acceptance:** `npm --prefix apps\admin-console test`: `ARCH-210:` proxy allows `/api/watch/jobs` and `/api/watch/job/<id>` and still refuses `/ingest`; store applies `job` events (quoted → paid → released) against the real near-watch test server; existing 39 tests pass. Build passes. Live: M-UI.

### ARCH-211 — Live proof [owner]
**Requirement:** One paid and one unpaid (left to expire) tab 03 job on NEAR TestNet appear correctly on the Jobs tab.
**Acceptance:** Owner run recorded in both BUILD_LOGs: the paid job goes quoted → paid → released, shows steps with Bedrock models, tokens, masking counts, full breakdown and reconcile `matched`, and its tx equals the receipt; the unpaid job turns `expired` after its TTL and the lost-compute total rises by its cost; with the relayer watched, no `low_gas` alert at the current balance.

---

## Owner steps (given one at a time during the build)

| ID | Step |
|---|---|
| M-G | Rebuild the gateway image and reload the mode with the new flag: `stack.ps1 -Rebuild gateway`, then `switch-models.ps1 -To ollama-cpu-8gb-all` (keys at the hidden prompts) with `--expose-entity-counts on` added to the mode's flags. |
| M-P | Rebuild the paywall (`stack.ps1 -Rebuild paywall` with the same `-PassEnv` list as 2026-11-05). |
| M-W | Restart near-watch and the console with `-Watch "relayer=relayer=chainaim-relayer-seller.testnet"` and `--gas-per-payment-near 0.000333`. |
| M-C | Restart the private-ai console with `--job-feed-url http://127.0.0.1:8790/ingest/job` and `NEAR_WATCH_INGEST_KEY` loaded from `C:\PRIV-AI-SECRETS\near-watch.env` (names only, never pasted). |
| M-UI | ARCH-211 live run, then open `http://127.0.0.1:8800/#jobs`. |

Never paste `NEAR_WATCH_INGEST_KEY`, `ADMIN_API_KEY`, `PAID_JOBS_KEY` or any wallet key into a chat.

## Build order

1. Baselines in both repos (ARCH-201 "before").
2. private-ai: ARCH-202 → ARCH-203 → ARCH-204 → ARCH-205.
3. adminUI: ARCH-206 → ARCH-207 → ARCH-208 → ARCH-209 → ARCH-210.
4. ARCH-201 "after" in both repos.
5. Owner: M-G, M-P, M-W, M-C, M-UI (ARCH-211).

## Out of scope

- Free tab 03 runs and tab 02 chats on the Jobs tab.
- XRPL jobs, and a second payment-log target for XRPL ledger-watch.
- Gateway ledger event push (the long-term production pattern), TEE pipeline and TEE wallet.
- Options B (x402 `upto`) and C (estimate first): revisit after this build (owner reminder).
- Showing anything from the job's text: question, SQL, rows, answer.
