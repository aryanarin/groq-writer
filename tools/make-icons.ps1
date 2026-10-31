# SPDX-License-Identifier: GPL-3.0-or-later
# Generates the FluentText icons: a blue-to-teal rounded square with a white "F" and a flowing underline.
# Also writes the padded 128x128 Chrome Web Store icon.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'icon-art.ps1')

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'chrome\icons'
$storeDir = Join-Path $root 'docs\store-assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $storeDir | Out-Null

function New-Icon([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  Add-AppArtwork $g 0 0 $size ($size -ge 32)
  $file = Join-Path $outDir "icon$size.png"
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "Wrote $file"
}

foreach ($s in 16, 48, 128) { New-Icon $s }

# Chrome Web Store icon: 96x96 artwork with 16px transparent padding on a 128x128 canvas.
$storeBmp = New-Object System.Drawing.Bitmap 128, 128
$storeGraphics = [System.Drawing.Graphics]::FromImage($storeBmp)
$storeGraphics.Clear([System.Drawing.Color]::Transparent)
Add-AppArtwork $storeGraphics 16 16 96 $true
$storeFile = Join-Path $storeDir 'store-icon-128.png'
$storeBmp.Save($storeFile, [System.Drawing.Imaging.ImageFormat]::Png)
$storeGraphics.Dispose(); $storeBmp.Dispose()
Write-Host "Wrote $storeFile"
