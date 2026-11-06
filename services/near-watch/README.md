# near-watch

near-watch follows NEAR USDC (NEP-141) payments into the paywall's pay-to account. It gets them from up to four independent roads. It also takes the paywall's own claims (`payment_settled`), reconciles the two, and serves everything to the admin console over HTTP and SSE.

| Road | How | Sees |
|---|---|---|
| `neardata` | FastNear neardata, `GET /v0/block/<h>`. The server waits for blocks near the tip | every receipt outcome executed by the USDC contract |
| `qn-rpc` | QuickNode RPC: `block` + `chunk`, then `EXPERIMENTAL_tx_status` (FINAL) for candidates | transactions signed by, or sent to, a watched account, or USDC transfer calls that name one |
| `rpc` | the same, against a public RPC | same as `qn-rpc` |
| `backfill` | from the furthest stored cursor to the start-up tip, run once at start | same as its source |

The first road to deliver a transaction wins. Later roads are stored with their lag behind it, and repeats are dropped. The x402 rule: success, token = `NEAR_USDC_CONTRACT`, receiver = a watched pay-to, and a single `ft_transfer` event. No memo is needed: the x402 NEAR scheme sends none (docs/NEAR-GATES.md A7). Any other transfer is listed but never counted. Claims join transfers by tx hash only; a claim's `invoiceId` is shown, never matched. The RPC roads also find payments relayed as a NEP-366 `Delegate`.

```powershell
npm install
npm test                 # 59 tests: decoder, store, reconcile (incl. late arrival), config (CAIP-2 default), RPC read-ahead, paid jobs, NEAR AI attestation per job, relayer gas, chain-core, end-to-end over the recorded-data doubles
npx tsc -p .             # typecheck
node --env-file=$SECRETS\near-watch.env src/main.ts --watch buyer1=buyer=<buyer>.testnet
node src/main.ts --help  # every flag and its default
```

Endpoints: `/healthz`, `/api/snapshot`, `/api/txs`, `/api/tx/<hash>`, `/api/feeds`, `/api/claims`, `/api/reconcile`, `/api/metrics`, `/api/trace/<invoiceId>`, `/api/seller`, `/api/jobs`, `/api/job/<jobId>`, SSE `/stream`, and `POST /ingest/claim|trace|job`.

**Paid jobs** (architecture-adminui-jobs.md ARCH-206..208, `src/jobs.ts`). `POST /ingest/job` takes the private-ai test console's `job_quoted` / `job_released` / `job_expired` events (`--job-feed-url` there). Each event is parsed strictly: every field is typed and bounded, unknown fields are refused, and a bad event is refused whole and alerted `job_refused`. So only ids, times, amounts, model ids, zones and counts are stored. A job is joined to the paywall's claim for `POST /v1/jobs/<jobId>/release`, and through it to the transfer and its reconcile state. States: `quoted` → `paid` → `released`, or `expired` if no claim is linked. A claim for a job never quoted here is shown as `paid` with no job event, and raises `job_unknown` once. Lost compute = model cost + call fees + analyst fee of expired jobs. The snapshot has `jobs` and SSE sends `job` only once a job exists. Everything else is unchanged; the new `jobs` table is created with IF NOT EXISTS.

**NEAR AI model attestation** (PLAN-adminui-nearai-attestation.md ARCH-501..503). `POST /ingest/job` also takes `job_attested` `{v:1, event, ts, jobId, network, summary, calls[]}`. It is the result private-ai's `ca-attest` verified; near-watch verifies nothing and never holds the NEAR AI key.
- **Values:**
  - `summary`: `attested` | `partial` | `unverified` | `not_applicable`.
  - Per call:
    - `step` (`query` | `answer`) and `model`.
    - `servedModel` and `providerId` (chat id): `[A-Za-z0-9_.:-]`, at most 128.
    - `signatureKind` (`provider_tee` | `gateway`) and `signingAlgo` (`ecdsa` | `ed25519`).
    - `signingAddress`: 0x + 40 hex for ecdsa, a 32-byte hex key for ed25519.
    - `reportFetchedAt`: ISO time.
    - `tdx`, `gpu`, `signature`, `hashes`: `true` / `false`, or `null` = not checked.
    - `status`: `verified` | `unverified` | `unavailable` | `not_applicable`.
    - `reason`: printable ASCII, one line, at most 200.
- **Strict:** unknown fields are refused, as for the other job events.
- **Storage:** the result goes in the new table `job_attestations`. The newest event per job wins; an older or identical one is a repeat. It is kept even before the job is known.
- **Output:** a job's view carries `attestation`, and the jobs summary carries `attestation` counts, only once one is stored. Otherwise every response is as before.

**Relayer gas** (ARCH-209). `--watch relayer=relayer=<account> --gas-per-payment-near D` reads the relayer's NEAR balance like the others. It raises `low_gas` (warn) when that covers fewer than `--relayer-min-payments` payments (default 500), at most once per `--alert-every-sec`. A watched relayer without `--gas-per-payment-near` stops start-up. The Seller wallet and Live ops panels ignore the role.

**Keeping up.** One RPC height is a `block` call plus about 1.8 `chunk` calls, at 270–370 ms each on testnet. Done one after another, that is 770–970 ms per height, while testnet makes a final block every ~580 ms. So the RPC roads read `--rpc-prefetch` heights at once (default 4; 1 = serial; forced to 1 by `--rpc-min-ms`), and still hand them in strictly in height order. Measured live on 2026-11-04, starting 100 blocks behind: fastnear went from 1.53 to 5.17 heights/s, and QuickNode from 1.00 to 4.90/s, against a chain making ~1.7/s.

**Late arrivals.** A claim marked `only_in_log` (or a transfer marked `only_on_ledger`) turns `matched` when the other side lands. It stays on the same (network, hash) row, its detail starts `late: …`, and a `reconcile_late_match` info alert is raised. `/api/feeds` → `reconcile` shows `--settle-grace-blocks`, its default (30), the grace in seconds at the measured block time, how far the roads trail the chain, and a warning when that trail is at least the grace.

Use the admin key for `/api` and `/stream`. Use the ingest key for `/ingest`.
