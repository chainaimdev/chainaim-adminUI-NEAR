# near-watch in Docker + the admin UI on the PC (DOCKERIZE-PLAN.md).
#   .\nearadminup.ps1 [-Secrets C:\PRIV-AI-SECRETS] [-ImportStore] [-NoConsole] [-WatchPort 8790] [-ConsolePort 8800]
# -ImportStore  once: copy data\near-watch\watch.sqlite (+ its -wal) into the volume, only if the volume has none.
#               The PC file is only read, so .\test-console\start-live.ps1 still works on it (rollback).
# Secrets stay in $Secrets\near-watch.env: mounted read-only into the container, read by the console with
# --env-file; no value is printed or put on a command line.
# Watched accounts (chainiam-private-ai architecture-tab03-agent-mode.md ARCH-313): the --watch entries and
# --gas-per-payment-near come from -WatchFile (default config\near-watch-watch.conf, committed, not secret: today's
# values), or from -Watch / -GasPerPaymentNear for one start. They are written to runtime\compose\near-watch.yml
# (commands only) and compose starts with it. Without that file and without -Watch, docker-compose.yml's own command runs.
#   .\nearadminup.ps1 -Watch buyer1=buyer=chainaim-buyer-seller.testnet,t02=buyer=chainaim-t02-seller.testnet,relayer=relayer=chainaim-relayer-seller.testnet
#   .\nearadminup.ps1 -DryRun     write the command file, check it with compose and print near-watch's command; start nothing
param(
  [string]$Secrets = "C:\PRIV-AI-SECRETS",
  [switch]$ImportStore,
  [switch]$NoConsole,
  [int]$WatchPort = 8790,
  [int]$ConsolePort = 8800,
  [int]$WaitSec = 120,
  [string]$WatchFile = "config\near-watch-watch.conf",
  [string[]]$Watch,
  [string]$GasPerPaymentNear,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$envFile = Join-Path $Secrets "near-watch.env"
if (-not (Test-Path $envFile)) { throw "missing $envFile (copy .env.example there and fill it in)" }
if (-not $DryRun -and -not $NoConsole -and -not (Test-Path (Join-Path $root "apps\admin-console\.next"))) { throw "build the console first: npm --prefix apps\admin-console run build" }

# The watch list: -Watch, else the file's WATCH lines; the gas: -GasPerPaymentNear, else the file's value.
$watchPath = if ([IO.Path]::IsPathRooted($WatchFile)) { $WatchFile } else { Join-Path $root $WatchFile }
$fileWatch = @(); $fileGas = $null
if (Test-Path $watchPath) {
  foreach ($line in Get-Content $watchPath) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -match '^\s*WATCH\s*=\s*(\S+)\s*$') { $fileWatch += $Matches[1]; continue }
    if ($line -match '^\s*GAS_PER_PAYMENT_NEAR\s*=\s*(\S+)\s*$') { $fileGas = $Matches[1]; continue }
    throw "${watchPath}: a line is neither WATCH=label=role=account nor GAS_PER_PAYMENT_NEAR=D: $line"
  }
}
$watchList = @(if ($Watch) { $Watch | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim() } | Where-Object { $_ } } else { $fileWatch })
$gas = if ($GasPerPaymentNear) { $GasPerPaymentNear } else { $fileGas }
$override = $null
if ($watchList.Count -gt 0) {
  foreach ($w in $watchList) { if ($w -notmatch '^[A-Za-z0-9_.-]+=(payto|buyer|relayer|other)=[a-z0-9._-]+$') { throw "watch entry '$w' must be label=role=account, role payto|buyer|relayer|other" } }
  # docker-compose.yml's command, with this watch list and gas.
  $cmd = @("--bind", "0.0.0.0", "--port", "8790", "--store", "/data/watch.sqlite")
  foreach ($w in $watchList) { $cmd += @("--watch", $w) }
  if ($gas) { $cmd += @("--gas-per-payment-near", $gas) }
  $outDir = Join-Path $root "runtime\compose"
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $override = Join-Path $outDir "near-watch.yml"
  # JSON is YAML: compose reads it as an override of docker-compose.yml.
  [IO.File]::WriteAllText($override, ([ordered]@{ services = [ordered]@{ "near-watch" = [ordered]@{ command = $cmd } } } | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
  Write-Host "watch list: $($watchList.Count) account(s)$(if ($gas) { ", $gas NEAR gas per payment" }) from $(if ($Watch) { '-Watch' } else { $watchPath })"
} else {
  Write-Host "watch list: docker-compose.yml's own command (no $watchPath and no -Watch)"
}
$composeFiles = @("-f", "docker-compose.yml") + $(if ($override) { @("-f", $override) } else { @() })

function Invoke-Docker([string[]]$DockerArgs) {
  # docker writes progress to stderr; in Windows PowerShell 5.1 that must not count as a failure, the exit code does.
  $ErrorActionPreference = "Continue"
  & docker @DockerArgs
  if ($LASTEXITCODE -ne 0) { throw "docker $($DockerArgs -join ' ') failed ($LASTEXITCODE)" }
}

# A near-watch already running on the PC holds the port and the SQLite file: stop it first.
$holder = Get-NetTCPConnection -LocalPort $WatchPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($holder) {
  $p = Get-Process -Id $holder.OwningProcess -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq "node") { throw "port $WatchPort is held by node (pid $($p.Id)): stop the PC near-watch first" }
}

$env:NEAR_WATCH_ENV_FILE = ($envFile -replace '\\', '/')
$env:NEAR_WATCH_PORT = "$WatchPort"
Push-Location $root
try {
  $ErrorActionPreference = "Continue"
  & docker network inspect chainaim-test *> $null
  $ErrorActionPreference = "Stop"
  if ($DryRun) {
    # The command only: `docker compose config` itself is never printed whole (it can carry values).
    $ErrorActionPreference = "Continue"
    $json = & docker @(@("compose") + $composeFiles + @("config", "--format", "json")) 2>$null
    if ($LASTEXITCODE -ne 0) { throw "docker compose rejected the configuration (docker compose $($composeFiles -join ' ') config -q)" }
    $ErrorActionPreference = "Stop"
    Write-Host ("near-watch command: " + (@((($json -join "`n") | ConvertFrom-Json).services.'near-watch'.command) -join " "))
    Write-Host "dry run: nothing started"
    return
  }
  if ($LASTEXITCODE -ne 0) { Invoke-Docker @("network", "create", "chainaim-test") }
  Invoke-Docker (@("compose") + $composeFiles + @("build", "near-watch"))

  if ($ImportStore) {
    $src = Join-Path $root "data\near-watch"
    if (-not (Test-Path (Join-Path $src "watch.sqlite"))) { throw "-ImportStore: $src\watch.sqlite does not exist" }
    Invoke-Docker (@("compose") + $composeFiles + @("stop", "near-watch"))
    # Copies only into an empty volume; the -shm index is rebuilt by SQLite from the -wal on first open.
    # No double quotes inside: Windows PowerShell 5.1 strips them when it passes arguments to docker.
    $copy = 'if [ -e /data/watch.sqlite ]; then echo volume already has watch.sqlite, not copied; else cp /import/watch.sqlite /data/watch.sqlite && if [ -e /import/watch.sqlite-wal ]; then cp /import/watch.sqlite-wal /data/watch.sqlite-wal; fi && echo copied watch.sqlite into volume near-watch-data; fi'
    Invoke-Docker (@("compose") + $composeFiles + @("run", "--rm", "--no-deps", "-v", "$(($src -replace '\\', '/')):/import:ro", "--entrypoint", "sh", "near-watch", "-c", $copy))
  }

  Invoke-Docker (@("compose") + $composeFiles + @("up", "-d", "near-watch"))
} finally {
  Pop-Location
  Remove-Item Env:NEAR_WATCH_ENV_FILE, Env:NEAR_WATCH_PORT -ErrorAction SilentlyContinue
}

# Wait for /healthz to answer (200 = every road live, 503 = still catching up).
$deadline = (Get-Date).AddSeconds($WaitSec)
$answered = $false
while ((Get-Date) -lt $deadline) {
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$WatchPort/healthz" -TimeoutSec 5
    Write-Host ("near-watch: ok={0} " -f $h.ok) ($h.feeds | ConvertTo-Json -Compress)
    $answered = $true
    break
  } catch {
    if ($_.Exception.Response) { Write-Host "near-watch: answering, not live yet ($([int]$_.Exception.Response.StatusCode))"; $answered = $true; break }
    Start-Sleep -Seconds 2
  }
}
if (-not $answered) { throw "near-watch did not answer on 127.0.0.1:$WatchPort within $WaitSec s: docker logs ca-near-watch" }

if (-not $NoConsole) {
  if (Get-NetTCPConnection -LocalPort $ConsolePort -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "console: port $ConsolePort already in use, not started"
  } else {
    # The console part of start-live.ps1, unchanged.
    Start-Process -FilePath "node" -ArgumentList @("--env-file=$envFile", "scripts\console.ts", "--mode", "start", "--port", "$ConsolePort", "--near-watch-url", "http://127.0.0.1:$WatchPort") -WorkingDirectory (Join-Path $root "apps\admin-console")
  }
}
Write-Host "near-watch  http://127.0.0.1:$WatchPort/healthz  (docker: ca-near-watch, volume near-watch-data)"
Write-Host "console     http://127.0.0.1:$ConsolePort"
