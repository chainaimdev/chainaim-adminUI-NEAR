# Status of the local stack: near-watch health and the console's view of it (no keys printed).
#   .\test-console\stack.ps1 [-WatchPort 8790] [-ConsolePort 8800]
param([int]$WatchPort = 8790, [int]$ConsolePort = 8800)
$ErrorActionPreference = "Continue"
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$WatchPort/healthz" -TimeoutSec 5
  Write-Host ("near-watch: ok={0}  " -f $h.ok) ($h.feeds | ConvertTo-Json -Compress)
} catch { Write-Host "near-watch: not answering on $WatchPort ($($_.Exception.Message))" }
try {
  $f = Invoke-RestMethod -Uri "http://127.0.0.1:$ConsolePort/api/watch/feeds" -TimeoutSec 5
  foreach ($n in $f.networks.PSObject.Properties) {
    foreach ($r in $n.Value.roads) { Write-Host ("  {0,-9} {1,-10} block {2}  lag {3}  errors {4}" -f $r.road, $r.state, $r.lastBlock, $r.lagBlocks, $r.errors) }
    if ($n.Value.skipped) { foreach ($s in $n.Value.skipped) { Write-Host ("  {0,-9} skipped: {1}" -f $s.road, $s.reason) } }
  }
  $rc = Invoke-RestMethod -Uri "http://127.0.0.1:$ConsolePort/api/watch/reconcile?limit=5" -TimeoutSec 5
  Write-Host "reconcile:" ($rc.counts | ConvertTo-Json -Compress)
} catch { Write-Host "console: not answering on $ConsolePort ($($_.Exception.Message))" }
