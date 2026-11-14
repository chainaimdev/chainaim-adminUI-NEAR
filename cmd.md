# cmd.md — every command to run the NEAR admin UI (Windows PowerShell)

near-watch in Docker, the admin UI on your PC. Run from the repository folder in a standalone PowerShell window.
Never paste a key, `docker inspect` or `docker compose config` output into a chat.

This repo runs together with **chainaim-private-ai**. Start this one **first**, so its payments and paid jobs are
recorded from the first call.

| Part | When | What |
|---|---|---|
| **PART 1 — One-time setup** | once per PC | tools, clone, build the admin UI, the secrets file, accounts to watch |
| **PART 2 — Run all containers and both UIs** | every day | two commands, this repo first, then private-ai |
| PART 3 — Check, stop, tests, troubleshooting | as needed | |

---

# PART 1 — One-time setup (once per PC)

Do this before private-ai's one-time setup (its `cmd.md`, PART 1): it needs `near-watch.env` from A3.

## A. One time on a new PC

### A1. Tools and clone

Git, Node.js 24 (22.22+), Docker Desktop running.

```powershell
cd <your-folder>
git clone https://github.com/chainaimdev/chainaim-adminUI-NEAR.git
cd chainaim-adminUI-NEAR
```

### A2. Build the admin UI (it runs on the PC)

```powershell
npm --prefix apps\admin-console install
npm --prefix apps\admin-console run build
```

near-watch needs no install for Docker (its image runs the sources directly). For its tests only:
`npm --prefix services\near-watch install`.

### A3. The secrets file, shared with private-ai

```powershell
New-Item -ItemType Directory -Force -Path C:\PRIV-AI-SECRETS | Out-Null
Copy-Item .env.example C:\PRIV-AI-SECRETS\near-watch.env
$k1 = node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
$k2 = node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
(Get-Content C:\PRIV-AI-SECRETS\near-watch.env) -replace '^ADMIN_API_KEY=$', "ADMIN_API_KEY=$k1" -replace '^NEAR_WATCH_INGEST_KEY=$', "NEAR_WATCH_INGEST_KEY=$k2" | Set-Content -Encoding ascii C:\PRIV-AI-SECRETS\near-watch.env
Remove-Variable k1, k2
notepad C:\PRIV-AI-SECRETS\near-watch.env
```

In Notepad fill:
- `NEAR_PAY_TO_TESTNET`: the paywall's NEAR pay-to account (the same as in private-ai's `near-testnet.env`).
- `QUICKNODE_NEAR_HTTP_TESTNET` (optional): without it the `qn-rpc` road is skipped.
- `NEARDATA_API_KEY` (optional, recommended): without it neardata may answer HTTP 429.

Leave the rest as they are. Check which names are filled (prints names only):

```powershell
Get-Content C:\PRIV-AI-SECRETS\near-watch.env | Where-Object { $_ -match '^\s*([A-Z_0-9]+)\s*=\s*(.*)$' } | ForEach-Object { "{0,-32} {1}" -f $Matches[1], $(if ($Matches[2].Trim()) {'set'} else {'EMPTY'}) }
```

`ADMIN_API_KEY`, `NEAR_WATCH_INGEST_KEY`, `NEAR_USDC_CONTRACT_TESTNET` and `NEAR_PAY_TO_TESTNET` must say `set`.
private-ai reads `NEAR_WATCH_INGEST_KEY` from this same file.

### A4. Accounts to watch

The watched buyer and relayer accounts and the relayer's gas per payment are in `config\near-watch-watch.conf`
(committed, not secret; chainiam-private-ai architecture-tab03-agent-mode.md ARCH-313). `nearadminup.ps1` reads it and starts
near-watch with it; its default is exactly the command `docker-compose.yml` has always run:

```
WATCH=buyer1=buyer=chainaim-buyer-seller.testnet
WATCH=relayer=relayer=chainaim-relayer-seller.testnet
GAS_PER_PAYMENT_NEAR=0.000333
```

Edit that file if yours differ (the pay-to comes from `NEAR_PAY_TO_TESTNET`). For private-ai's tab 03 agent mode add one
buyer line per tenant, e.g. `WATCH=t02=buyer=chainaim-t02-seller.testnet` and `WATCH=t03=buyer=chainaim-t03-seller.testnet`
(t01 is `buyer1`), plus your manual wallet account. For one start only: `.\nearadminup.ps1 -Watch a=buyer=x.testnet,relayer=relayer=y.testnet
-GasPerPaymentNear 0.000333`. Check first, starting nothing: `.\nearadminup.ps1 -DryRun` prints near-watch's command.

---

# PART 2 — Run all containers and both UIs (every day)

## B. Start everything: two commands, in this order

```powershell
# 1. This repo: near-watch container + admin UI (8800)
cd <your-folder>\chainaim-adminUI-NEAR
.\nearadminup.ps1

# 2. private-ai repo: the six backend containers + the console UI (8730)
cd <your-folder>\chainaim-private-ai
.\test-console\up.ps1
```

| Command | Containers it starts | UI it starts |
|---|---|---|
| 1. this repo `.\nearadminup.ps1` | `ca-near-watch` | admin UI http://127.0.0.1:8800 (own window) |
| 2. private-ai `.\test-console\up.ps1` | `ca-presidio`, `ca-gateway`, `ca-paywall`, `ca-analyst`, `ca-chain-query`, `ca-console-api` | console UI http://127.0.0.1:8730 (own window, opens the browser) |

`.\nearadminup.ps1` builds the image when needed, starts `ca-near-watch`, waits for `/healthz`, then starts the admin UI in its
own window. Open **http://127.0.0.1:8800** (`127.0.0.1`, not `localhost`). The private-ai side is described in its
`cmd.md`, PART 2.

| Situation | Command |
|---|---|
| Moving from the old PC near-watch: copy its store once | `.\nearadminup.ps1 -ImportStore` (only into an empty volume) |
| near-watch only, no admin UI window | `.\nearadminup.ps1 -NoConsole` |
| Secrets in another folder | `.\nearadminup.ps1 -Secrets <folder>` |

---

# PART 3 — Check, stop, tests, troubleshooting

## C. Check that it works

```powershell
.\test-console\stack.ps1
docker ps --filter name=ca-near-watch --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

Expected: `near-watch: ok=True`, at least one road `live` with lag near 0, the reconcile counts; the container
`Up (healthy)` on `127.0.0.1:8790`.

After a paid call or paid job in private-ai: the counts in `stack.ps1` go up, and the admin UI shows the claim, the
chain transfer, the job (`quoted` → `released`) and `matched`.

After a paid job that used the NEAR AI model (with private-ai's `ca-attest` on, its PLAN-private-ai-nearai-attestation.md):
open http://127.0.0.1:8800/#jobs. The job's **attested** column shows ✓ (or ◐ partial, ✗ unverified, – not applicable).
The **attested jobs** tile counts it. The job's attestation table shows the chat id and signer address that tab 03 shows.
To check one reply yourself, paste its chat id at https://cloud.near.ai/verify. A job with no attestation data has a
blank column, which is normal for jobs that did not use NEAR AI or were run before this feature.

---

## D. Stop

```powershell
# 1. private-ai repo first: console UI + six containers
cd <your-folder>\chainaim-private-ai
.\test-console\down.ps1

# 2. This repo: admin UI + ca-near-watch
cd <your-folder>\chainaim-adminUI-NEAR
.\down.ps1
```

`.\down.ps1` stops the admin UI and the container; the volume `near-watch-data` (all history) is kept.

---

## E. Tests

```powershell
npm --prefix services\near-watch test
npm --prefix apps\admin-console test
```

Expected: 59 and 48 pass.

---

## F. Troubleshooting

| What you see | Fix |
|---|---|
| `neardata down`, errors growing | HTTP 429: set `NEARDATA_API_KEY`, then `.\down.ps1` and `.\nearadminup.ps1` |
| `qn-rpc down` / `backfill down` | QuickNode daily quota used, or no URL set. The `rpc` road still carries every block |
| `port 8790 is held by node` | The old PC near-watch is running: close its window, run `.\nearadminup.ps1` again |
| Admin UI page does not open | Use http://127.0.0.1:8800; if nothing listens on 8800, run `.\nearadminup.ps1` again (near-watch keeps running) |
| A container log | `docker logs ca-near-watch --tail 40` |
| `ca-near-watch` shows `(unhealthy)` | Its health check passes only when every road is live; with `qn-rpc` / `neardata` down it stays unhealthy. It still works while one road (`rpc`) is live: check with `.\test-console\stack.ps1` |
| A tenant or wallet has no buyer card | Add its `WATCH=<label>=buyer=<account>` line to `config\near-watch-watch.conf` (A4), then `.\down.ps1` and `.\nearadminup.ps1` |

## G. Back to the old way (near-watch as a Node process)

```powershell
.\down.ps1
.\test-console\start-live.ps1 -Secrets C:\PRIV-AI-SECRETS -Watch "buyer1=buyer=chainaim-buyer-seller.testnet"
```

It uses the PC store `data\near-watch\watch.sqlite`, which Docker never changes.
