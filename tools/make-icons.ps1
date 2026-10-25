# SPDX-License-Identifier: GPL-3.0-or-later
# Generates icons/icon16.png, icon48.png, icon128.png (orange rounded square with a white "G" and wavy underline).
# Run from the project root:  powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'chrome\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-Icon([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)

  # Rounded square background
  $r = [int]($size * 0.22)
  $d = $r * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
  $path.CloseFigure()
  $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
  $c1 = [System.Drawing.Color]::FromArgb(255, 255, 128, 84)
  $c2 = [System.Drawing.Color]::FromArgb(255, 235, 60, 40)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $c1, $c2, 45
  $g.FillPath($brush, $path)

  # Letter G
  $fontSize = [single]($size * 0.62)
  $font = New-Object System.Drawing.Font 'Segoe UI', $fontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'
  $sf.LineAlignment = 'Center'
  $textRect = New-Object System.Drawing.RectangleF 0, ([single](-$size * 0.06)), $size, $size
  $g.DrawString('G', $font, [System.Drawing.Brushes]::White, $textRect, $sf)

  # Wavy underline (skipped on the tiny icon where it only adds noise)
  if ($size -ge 32) {
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(230, 255, 255, 255)), ([single][Math]::Max(1.5, $size * 0.045))
    $pen.StartCap = 'Round'
    $pen.EndCap = 'Round'
    $pts = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
    $y0 = $size * 0.84
    $amp = $size * 0.035
    $x0 = $size * 0.22
    $x1 = $size * 0.78
    $steps = 24
    for ($i = 0; $i -le $steps; $i++) {
      $t = $i / $steps
      $x = $x0 + ($x1 - $x0) * $t
      $y = $y0 + $amp * [Math]::Sin($t * 4 * [Math]::PI * 1.0)
      $pts.Add((New-Object System.Drawing.PointF ([single]$x), ([single]$y)))
    }
    $g.DrawLines($pen, $pts.ToArray())
    $pen.Dispose()
  }

  $file = Join-Path $outDir "icon$size.png"
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $brush.Dispose(); $font.Dispose(); $path.Dispose()
  Write-Host "Wrote $file"
}

foreach ($s in 16, 48, 128) { New-Icon $s }
