# SPDX-License-Identifier: GPL-3.0-or-later
# Builds dist\groq-writer-chrome-<version>.zip and dist\groq-writer-firefox-<version>.zip.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File tools\package.ps1
# Syncs firefox\ from chrome\ first so the two builds cannot drift.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot 'sync-firefox.ps1') | Out-Null

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

foreach ($browser in 'chrome', 'firefox') {
  $dir = Join-Path $root $browser
  $manifest = Get-Content (Join-Path $dir 'manifest.json') -Raw | ConvertFrom-Json
  $zip = Join-Path $dist "groq-writer-$browser-$($manifest.version).zip"
  if (Test-Path $zip) { Remove-Item $zip }
  # Zip the folder contents so manifest.json sits at the archive root.
  Compress-Archive -Path (Join-Path $dir '*') -DestinationPath $zip
  Write-Host "Created $zip"
}
