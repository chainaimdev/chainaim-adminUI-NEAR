# Start near-watch (NEAR testnet) and the admin console, each in its own window.
#   .\test-console\start-live.ps1 [-Secrets $HOME\chainaim-secrets] [-Watch "buyer1=buyer=<buyer>.testnet"] [-PaywallLog <path>]
# Reads every secret from $Secrets\near-watch.env (see .env.example); nothing secret is passed on a command line.
param(
  [string]$Secrets = "$HOME\chainaim-secrets",
  [string[]]$Watch = @(),
  [string]$PaywallLog = "",
  [int]$WatchPort = 8790,
  [int]$ConsolePort = 8800
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $Secrets "near-watch.env"
if (-not (Test-Path $envFile)) { throw "missing $envFile (copy .env.example there and fill it in)" }
if (-not (Test-Path (Join-Path $root "apps\admin-console\.next"))) { throw "build the console first: npm --prefix apps\admin-console run build" }

$nwArgs = @("--env-file=$envFile", "src\main.ts", "--port", "$WatchPort")
foreach ($w in $Watch) { $nwArgs += @("--watch", $w) }
if ($PaywallLog) { $nwArgs += @("--paywall-log-file", $PaywallLog) }
Start-Process -FilePath "node" -ArgumentList $nwArgs -WorkingDirectory (Join-Path $root "services\near-watch")

Start-Process -FilePath "node" -ArgumentList @("--env-file=$envFile", "scripts\console.ts", "--mode", "start", "--port", "$ConsolePort", "--near-watch-url", "http://127.0.0.1:$WatchPort") -WorkingDirectory (Join-Path $root "apps\admin-console")

Write-Host "near-watch  http://127.0.0.1:$WatchPort/healthz"
Write-Host "console     http://127.0.0.1:$ConsolePort"
