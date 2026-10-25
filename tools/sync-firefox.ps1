# SPDX-License-Identifier: GPL-3.0-or-later
# Copies the shared extension files from chrome/ into firefox/.
#
# Both builds run byte-identical JS, HTML, CSS and icons. Only manifest.json differs,
# so that one file is never touched here:
#
#   chrome/manifest.json   -> "background": { "service_worker": ..., "type": "module" }
#   firefox/manifest.json  -> "background": { "scripts": [...], "type": "module" }
#                             + browser_specific_settings (gecko id, min version, data collection)
#
# Run this after any change under chrome/, then re-run the checks:
#
#   powershell -ExecutionPolicy Bypass -File .\tools\sync-firefox.ps1
#   node tools\check-wiring.js

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'chrome'
$dst  = Join-Path $root 'firefox'

$shared = @(
  'background.js', 'content.js', 'shared.js',
  'popup.html', 'popup.js', 'popup.css',
  'options.html', 'options.js', 'options.css',
  'privacy.html',
  'ui.css',
  'icons\icon16.png', 'icons\icon48.png', 'icons\icon128.png', 'icons\upi-qr.png'
)

New-Item -ItemType Directory -Force -Path (Join-Path $dst 'icons') | Out-Null

$copied = 0
foreach ($rel in $shared) {
  $from = Join-Path $src $rel
  $to   = Join-Path $dst $rel
  if (-not (Test-Path $from)) {
    Write-Host ("MISSING  {0} (skipped)" -f $rel) -ForegroundColor Yellow
    continue
  }
  Copy-Item -Path $from -Destination $to -Force
  Write-Host ("synced   {0}" -f $rel)
  $copied++
}

Write-Host ""
Write-Host ("{0} file(s) synced into firefox\. manifest.json left alone." -f $copied)
