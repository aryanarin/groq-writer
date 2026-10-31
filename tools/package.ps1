# SPDX-License-Identifier: GPL-3.0-or-later
# Builds dist\fluenttext-chrome-<version>.zip and dist\fluenttext-firefox-<version>.zip.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File tools\package.ps1
# Syncs firefox\ from chrome\ first so the two builds cannot drift.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot 'sync-firefox.ps1') | Out-Null

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

foreach ($browser in 'chrome', 'firefox') {
  $dir = Join-Path $root $browser
  $manifest = Get-Content (Join-Path $dir 'manifest.json') -Raw | ConvertFrom-Json
  $zip = Join-Path $dist "fluenttext-$browser-$($manifest.version).zip"
  if (Test-Path $zip) { Remove-Item $zip }
  # Zip the folder contents so manifest.json sits at the archive root.
  # Entry names must use forward slashes; Compress-Archive writes backslashes on Windows.
  $stream = [System.IO.File]::Open($zip, [System.IO.FileMode]::CreateNew)
  try {
    $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      Get-ChildItem -Path $dir -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($dir.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $relative) | Out-Null
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
  Write-Host "Created $zip"
}
