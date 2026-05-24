# Downloads FFmpeg + ffprobe Windows builds and installs them as Tauri sidecars.
# Requires: PowerShell 7+, rustc (for target triple), curl or Invoke-WebRequest

$ErrorActionPreference = "Stop"

$rustInfo = rustc -vV
if ($LASTEXITCODE -ne 0) {
    throw "rustc is required to determine the target triple"
}
$triple = ($rustInfo | Select-String "host: (\S+)").Matches.Groups[1].Value
if (-not $triple) {
    throw "Failed to parse host triple from rustc -vV"
}

$binDir = Join-Path $PSScriptRoot ".." "src-tauri" "binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$zipUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
$zipPath = Join-Path $env:TEMP "ffmpeg-win64-gpl.zip"
$extractDir = Join-Path $env:TEMP "ffmpeg-win64-gpl"

Write-Host "Downloading FFmpeg from $zipUrl ..."
Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

if (Test-Path $extractDir) {
    Remove-Item -Recurse -Force $extractDir
}
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

$ffmpegSrc = Get-ChildItem -Path $extractDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
$ffprobeSrc = Get-ChildItem -Path $extractDir -Recurse -Filter "ffprobe.exe" | Select-Object -First 1
if (-not $ffmpegSrc -or -not $ffprobeSrc) {
    throw "Could not find ffmpeg.exe / ffprobe.exe in the downloaded archive"
}

$ffmpegDest = Join-Path $binDir "ffmpeg-$triple.exe"
$ffprobeDest = Join-Path $binDir "ffprobe-$triple.exe"

Copy-Item -Force $ffmpegSrc.FullName $ffmpegDest
Copy-Item -Force $ffprobeSrc.FullName $ffprobeDest

Write-Host "Installed:"
Write-Host "  $ffmpegDest"
Write-Host "  $ffprobeDest"
