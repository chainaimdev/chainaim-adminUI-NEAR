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
