# Stop what .\up.ps1 started: the admin UI on the PC and the near-watch container. The volume near-watch-data is kept.
#   .\down.ps1 [-ConsolePort 8800] [-KeepConsole]
param([int]$ConsolePort = 8800, [switch]$KeepConsole)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if (-not $KeepConsole) {
  # Only the admin console (node scripts\console.ts ... --port $ConsolePort), nothing else on the PC.
  $consoles = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'scripts\\console\.ts' -and $_.CommandLine -match "--port\s+$ConsolePort(\s|$)" }
  foreach ($c in $consoles) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($c.ProcessId)" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "console: stopped pid $($c.ProcessId)"
  }
  if (-not $consoles) { Write-Host "console: not running on $ConsolePort" }
}

Push-Location $root
try {
  $ErrorActionPreference = "Continue"   # docker progress goes to stderr; the exit code decides
  & docker compose down
  if ($LASTEXITCODE -ne 0) { throw "docker compose down failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}
Write-Host "near-watch: container removed; volume near-watch-data kept"
