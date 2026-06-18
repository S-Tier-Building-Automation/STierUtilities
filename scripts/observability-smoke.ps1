# Live Observability Pack smoke test.
# Installs (if needed), starts InfluxDB/Telegraf/Grafana, writes + queries a metric,
# and exits non-zero on failure. First run may download ~400 MB.
param(
  [switch]$Dev
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

Write-Host "Observability smoke test — first run may download ~400 MB of pack binaries."
Write-Host ""

$cmd = if ($Dev) {
  "npm run tauri -- dev -- --observability-smoke"
} else {
  "cargo run --manifest-path src-tauri/Cargo.toml -- --observability-smoke"
}
Write-Host "Running: $cmd"
Invoke-Expression $cmd
$exitCode = $LASTEXITCODE

$resultPath = Join-Path $env:APPDATA "com.stierbuildings.utilities\observability-smoke-result.json"
if (Test-Path $resultPath) {
  Write-Host ""
  Write-Host "Result file:"
  Get-Content $resultPath
} else {
  Write-Host ""
  Write-Host "Warning: smoke result file not found at $resultPath"
}

if ($exitCode -ne 0) {
  Write-Host ""
  Write-Host "Observability smoke test FAILED (exit $exitCode)" -ForegroundColor Red
  exit $exitCode
}

Write-Host ""
Write-Host "Observability smoke test PASSED" -ForegroundColor Green
exit 0
