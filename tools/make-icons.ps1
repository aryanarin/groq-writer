# SPDX-License-Identifier: GPL-3.0-or-later
# Generates the FluentText icons: a blue-to-teal rounded square with a white "F" and a flowing underline.
# Also writes the padded 128x128 Chrome Web Store icon.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'chrome\icons'
$storeDir = Join-Path $root 'docs\store-assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $storeDir | Out-Null

function Add-AppArtwork($g, [single]$x, [single]$y, [single]$size, [bool]$underline) {
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $r = [single]($size * 0.22)
  $d = $r * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $size - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $size - $d, $y + $size - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $size - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $rect = New-Object System.Drawing.RectangleF $x, $y, $size, $size
  $c1 = [System.Drawing.Color]::FromArgb(255, 59, 130, 246)
  $c2 = [System.Drawing.Color]::FromArgb(255, 13, 148, 136)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $c1, $c2, 45
  $g.FillPath($brush, $path)

  # A soft highlight across the top-left corner.
  $glow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(38, 255, 255, 255))
  $g.FillEllipse($glow, $x - $size * 0.25, $y - $size * 0.35, $size * 0.95, $size * 0.8)

  # Letter F
  $fontSize = [single]($size * 0.63)
  $font = New-Object System.Drawing.Font 'Segoe UI', $fontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'
  $sf.LineAlignment = 'Center'
  $textRect = New-Object System.Drawing.RectangleF $x, ($y + [single]($size * 0.01)), $size, $size
  $g.DrawString('F', $font, [System.Drawing.Brushes]::White, $textRect, $sf)

  if ($underline) {
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(235, 255, 255, 255)), ([single][Math]::Max(1.5, $size * 0.045))
    $pen.StartCap = 'Round'
    $pen.EndCap = 'Round'
    $pts = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
    $y0 = $y + $size * 0.83
    $amp = $size * 0.03
    $x0 = $x + $size * 0.23
    $x1 = $x + $size * 0.77
    $steps = 28
    for ($i = 0; $i -le $steps; $i++) {
      $t = $i / $steps
      $px = $x0 + ($x1 - $x0) * $t
      $py = $y0 + $amp * [Math]::Sin($t * 4 * [Math]::PI)
      $pts.Add((New-Object System.Drawing.PointF ([single]$px), ([single]$py)))
    }
    $g.DrawLines($pen, $pts.ToArray())
    $pen.Dispose()
  }

  $glow.Dispose(); $brush.Dispose(); $font.Dispose(); $sf.Dispose(); $path.Dispose()
}

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
