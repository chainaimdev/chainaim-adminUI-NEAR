# Setup and run commands (Windows PowerShell)

You need Git and Node.js 24 (22.22 or later). Optionally, run `chainiam-private-ai` with its paywall on `PAY_RAILS=near` so there are claims to reconcile.

## 1. Install, test, build

```powershell
cd chainaim-adminUI-NEAR
npm --prefix services\near-watch install
npm --prefix services\near-watch test          # 34 pass
npm --prefix apps\admin-console install
npm --prefix apps\admin-console test           # 39 pass
npm --prefix apps\admin-console run build
```

## 2. One time: the secrets file (outside the repo)

```powershell
$SECRETS = "$HOME\chainaim-secrets"
New-Item -ItemType Directory -Force -Path $SECRETS | Out-Null
Copy-Item .env.example $SECRETS\near-watch.env
$k1 = node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
$k2 = node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
(Get-Content $SECRETS\near-watch.env) -replace '^ADMIN_API_KEY=$', "ADMIN_API_KEY=$k1" -replace '^NEAR_WATCH_INGEST_KEY=$', "NEAR_WATCH_INGEST_KEY=$k2" | Set-Content -Encoding ascii $SECRETS\near-watch.env
notepad $SECRETS\near-watch.env
```

In Notepad, fill in these values:
- `NEAR_PAY_TO_TESTNET`: the paywall's pay-to account.
- `NEAR_CAIP2_TESTNET`: leave empty. It defaults to `near:testnet`, which is what the paywall writes (docs/NEAR-GATES.md A5). Set it only to override.
- `QUICKNODE_NEAR_HTTP_TESTNET`: optional. Without it the `qn-rpc` road is skipped and reported.

On the paywall side, point its payment log at near-watch. Use either `PAYMENT_LOG_URL=http://127.0.0.1:8790/ingest/claim` with the ingest key, or `PAYMENT_LOG_FILE` together with `-PaywallLog`.

## 3. Run

```powershell
.\test-console\start-live.ps1 -Watch "buyer1=buyer=<buyer>.testnet"
.\test-console\stack.ps1
start http://127.0.0.1:8800
```

## 4. Or: near-watch in Docker, the admin UI on the PC (DOCKERIZE-PLAN.md)

You need Docker Desktop. It uses the same secrets file, mounted read-only into the container and read by Node's `--env-file` as it is today.

```powershell
# Stop the PC near-watch first: it holds port 8790 and the SQLite file.
.\up.ps1 -Secrets C:\PRIV-AI-SECRETS -ImportStore   # first time: copies data\near-watch\watch.sqlite into volume near-watch-data
.\up.ps1 -Secrets C:\PRIV-AI-SECRETS                # later
.\test-console\stack.ps1
.\down.ps1                                         # stops the admin UI and the container; the volume is kept
```

- The `--watch` entries and `--gas-per-payment-near` are set in the `command` of `docker-compose.yml`. Edit them there if yours differ.
- On the `chainaim-test` network, private-ai's paywall and console-api reach near-watch at `http://near-watch:8790/ingest/claim` and `/ingest/job`. The old `http://host.docker.internal:8790/ingest/claim` still works.
- Rollback: run `.\down.ps1`, then section 3 as before. It uses the untouched `data\near-watch\watch.sqlite`.
- Never paste `docker compose config` or `docker inspect` output.
