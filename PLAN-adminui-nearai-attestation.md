# chainaim-adminUI-NEAR — show NEAR AI model attestation per paid job (Jobs tab) — Plan

Written 2026-11-06. PLAN ONLY: no code is changed by this file. Companion plan (private AI side, where the evidence is
collected and verified): `PLAN-private-ai-nearai-attestation.md` (ARCH-401…414).

Labels: **[read]** = read in the repo on 2026-11-05/06 · **[verify]** = checked first in the build · **[owner]** = manual step.

Requirement IDs: **ARCH-501 … ARCH-506**. Taken here: ARCH-201…211 (Jobs tab), ARCH-313 (watch list).

## 1. Goal and decisions

- The admin UI shows, for each paid tab 03 job, whether its NEAR AI model calls were **attested** (TEE report verified,
  reply signature verified, hashes match), with the evidence identifiers — and a count of attested vs not attested jobs.
- **Nothing is verified here.** The verification happens in private-ai's `ca-attest` container (it holds `NEARAI_API_KEY`).
  near-watch only **stores and shows** the result it receives on the existing job feed. This repo never gets the NEAR AI key.
- **Docker only, UI outside:** near-watch stays the `ca-near-watch` container; the 8800 admin UI stays on the PC. No new
  container, no new process.
- Defaults unchanged: a job without attestation data shows exactly as today. No mocks, no hardcoding.

## 2. Facts this plan relies on

| # | Fact | Source |
|---|---|---|
| F1 | private-ai's console posts job events to near-watch `POST /ingest/job` with `x-ingest-key`; events today: `job_quoted`, `job_released`, `job_expired`; near-watch answers 202. | private-ai `test-console/console/job-feed.ts` [read 11-06] |
| F2 | near-watch validates each event field by field with an allowlist (`only(...)`, `parseBreakdown`) and stores jobs in SQLite; the admin UI reads `/api/jobs` through its server-side proxy (admin key) and renders `components/tabs/jobs.tsx`. | `services/near-watch/src/jobs.ts`, `store.ts`; `apps/admin-console/lib/types.ts`, `components/tabs/jobs.tsx` [read 11-05, edited then for subtotal rows] |
| F3 | The new event from the companion plan (ARCH-412): `job_attested` `{v:1, event, ts, jobId, network, summary, calls:[{step, model, servedModel, providerId, signatureKind, signingAlgo, signingAddress, reportFetchedAt, tdx, gpu, signature, hashes, status, reason}]}` — ids, addresses, booleans and short reasons; never text. | companion plan |
| F4 | NEAR AI's own checker for one reply: `https://cloud.near.ai/verify` (Verification Center). | docs.near.ai/cloud/verification [read 11-06] |

[verify] before coding: re-read the current `jobs.ts`, `store.ts`, `server.ts`, `types.ts`, `jobs.tsx` (the Docker build
changed files around them on 2026-11-06) and confirm where the job row and its migration live.

## 3. Design

```
private-ai ca-console-api ──POST /ingest/job {event:"job_attested", ...}──▶ ca-near-watch (validate, store)
                                                                                 │  /api/jobs (+ attestation)
                                                                                 ▼
                                                     admin UI 8800 (PC) ── Jobs tab: column + detail + count
```

`job_attested` may arrive before or after `job_released` (verification is asynchronous), or for a job near-watch has not
seen yet (restart): it is stored against the job id either way and shown when the job is.

## 4. Components

| Component | Change | Responsibility |
|---|---|---|
| `services/near-watch/src/jobs.ts` | edit | accept `job_attested`; strict validation: `summary` ∈ `attested | partial | unverified | not_applicable`; per call `status` ∈ `verified | unverified | unavailable | not_applicable`; `signatureKind` ∈ `provider_tee | gateway`; `signingAlgo` ∈ `ecdsa | ed25519`; `signingAddress` 0x + 40 hex (ecdsa) or hex public key (ed25519); `providerId` / ids length-capped `[A-Za-z0-9_.:-]`; booleans for `tdx`, `gpu`, `signature`, `hashes` (or `null` = not checked); `reason` ≤ 200 chars, no newlines; unknown fields refused (as `only(...)` does today). |
| `services/near-watch/src/store.ts` | edit | additive migration: table `job_attestations` (jobId, ts, summary, calls JSON); latest event per job wins; existing tables untouched. |
| `services/near-watch/src/server.ts` | edit | `/api/jobs` (and its SSE `job` event) include `attestation` when present; no new route needed. |
| `apps/admin-console/lib/types.ts` | edit | `JobAttestation`, `AttestedCall` types (optional on `Job`). |
| `apps/admin-console/components/tabs/jobs.tsx` | edit (UI) | list: an **Attested** column (✓ attested · ◐ partial · ✗ unverified · – not applicable · blank = no data yet); job detail: one row per model call — step, model, NEAR AI model id, chat id, signature kind, signer address, report time, TDX / GPU / signature / hashes ticks, status and reason, plus "Check it yourself: cloud.near.ai/verify"; header tile: "attested jobs N of M". |
| Docs | edit | `README.md` (Jobs tab line), `cmd.md` (check step), `architecture-adminui-jobs.md` reference to this plan, `BUILD_LOG.md`. |

No change to: roads, reconcile, claims, alerts, the proxy's key handling, `nearadminup.ps1`, `docker-compose.yml`.

---

# Requirements

**ARCH-501 — Accept and validate `job_attested`.** As section 4. Acceptance: `ARCH-501:` tests — a valid event stored
(202); each invalid field refused (400) naming the field; an event with any text-like extra field refused; the ingest key
still required.

**ARCH-502 — Store.** Additive migration; restart keeps attestation; a second event for the same job replaces the first.
Acceptance: tests on a real SQLite file (as the existing store tests).

**ARCH-503 — API.** `/api/jobs` and the SSE `job` event carry `attestation` only when stored; jobs without it are
byte-identical to today's JSON. Acceptance: tests; existing jobs tests unchanged and passing.

**ARCH-504 — Jobs tab.** Column, detail rows and tile as section 4; no data → blank (not "unverified"). Acceptance:
`ARCH-504:` admin-console tests over a real near-watch (style of the existing store/derive tests); `npm run typecheck`
and `npm run build` pass.

**ARCH-505 — Nothing else changes.** near-watch 50/50 and admin-console 43/43 still pass, plus the new tests.

**ARCH-506 — Live [owner].** After companion ARCH-414: the job shows **Attested ✓** with the same chat id and signer
address as tab 03; the same chat id checked once at `https://cloud.near.ai/verify`.

## 5. AI work vs owner work

**AI can do:** re-read the five files, ARCH-501…505 code and tests, docs, BUILD_LOG.

**Owner (one step at a time):** after the build, `.\down.ps1` then `.\nearadminup.ps1` (rebuilds `ca-near-watch`),
`npm --prefix apps\admin-console run build`, open http://127.0.0.1:8800/#jobs, ARCH-506.

## 6. Build order

1. Baseline: `npm --prefix services\near-watch test` (50), `npm --prefix apps\admin-console test` (43).
2. ARCH-501 → 502 → 503 (near-watch). 3. ARCH-504 (UI). 4. ARCH-505 "after". 5. Owner ARCH-506.

This plan can be built in parallel with the private-ai plan once its event shape (ARCH-412) is fixed; events from an
older console simply never carry attestation.

Rollback: an older near-watch ignores nothing — it refuses `job_attested` with 400, which the console logs once as
`job_feed_failed` and never fails a job (job-feed.ts behaviour, F1).
