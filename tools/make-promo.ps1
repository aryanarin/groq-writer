# SPDX-License-Identifier: GPL-3.0-or-later
# Generates docs\store-assets\promo-440x280.png for the Chrome Web Store.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File tools\make-promo.ps1
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'icon-art.ps1')

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'docs\store-assets\promo-440x280.png'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null

$w = 440
$h = 280
$bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

$bgRect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $bgRect,
  ([System.Drawing.Color]::FromArgb(255, 12, 19, 34)),
  ([System.Drawing.Color]::FromArgb(255, 24, 39, 64)), 35
$g.FillRectangle($bg, $bgRect)

# Soft brand glows with a radial falloff.
$glowBluePath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowBluePath.AddEllipse(250, -120, 300, 300)
$glowBlue = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowBluePath)
$glowBlue.CenterColor = [System.Drawing.Color]::FromArgb(68, 37, 99, 235)
$glowBlue.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0, 37, 99, 235))
$g.FillPath($glowBlue, $glowBluePath)

$glowTealPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowTealPath.AddEllipse(-100, 170, 260, 260)
$glowTeal = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowTealPath)
$glowTeal.CenterColor = [System.Drawing.Color]::FromArgb(46, 13, 148, 136)
$glowTeal.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0, 13, 148, 136))
$g.FillPath($glowTeal, $glowTealPath)

# Icon and wordmark.
Add-AppArtwork $g 30 30 62 $true

$nameFont = New-Object System.Drawing.Font 'Segoe UI', 30, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$nameBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 244, 248, 255))
$g.DrawString('FluentText', $nameFont, $nameBrush, 106, 34)

$subFont = New-Object System.Drawing.Font 'Segoe UI', 9.5, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$subBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 124, 176, 255))
$g.DrawString('WRITING ASSISTANT', $subFont, $subBrush, 108, 78)

$headlineFont = New-Object System.Drawing.Font 'Segoe UI', 19, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('Write with confidence', $headlineFont, $nameBrush, 30, 115)

$bodyFont = New-Object System.Drawing.Font 'Segoe UI', 12.5, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$bodyBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 169, 185, 208))
$g.DrawString('Proofreading, rewriting and translation on any site.', $bodyFont, $bodyBrush, 30, 145)

# Feature chips.
$chipFont = New-Object System.Drawing.Font 'Segoe UI', 10.5, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$chipTextBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 219, 230, 246))
$chipFill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(16, 255, 255, 255))
$chipPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(60, 255, 255, 255)), 1
$chipX = 30
$chipY = 188
$chipH = 27
foreach ($label in 'Proofread as you type', 'Rewrite', 'Translate') {
  $textW = $g.MeasureString($label, $chipFont).Width
  $chipW = [single]([Math]::Ceiling($textW) + 22)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $rad = 8
  $path.AddArc($chipX, $chipY, $rad * 2, $rad * 2, 180, 90)
  $path.AddArc($chipX + $chipW - $rad * 2, $chipY, $rad * 2, $rad * 2, 270, 90)
  $path.AddArc($chipX + $chipW - $rad * 2, $chipY + $chipH - $rad * 2, $rad * 2, $rad * 2, 0, 90)
  $path.AddArc($chipX, $chipY + $chipH - $rad * 2, $rad * 2, $rad * 2, 90, 90)
  $path.CloseFigure()
  $g.FillPath($chipFill, $path)
  $g.DrawPath($chipPen, $path)
  $g.DrawString($label, $chipFont, $chipTextBrush, $chipX + 11, $chipY + 5)
  $path.Dispose()
  $chipX += $chipW + 8
}

# Footer line and a gradient rule that echoes the icon.
$footFont = New-Object System.Drawing.Font 'Segoe UI', 9.5, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$footBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 125, 142, 168))
$g.DrawString('Groq, OpenAI and any OpenAI-compatible API', $footFont, $footBrush, 30, 238)

$ruleC1 = [System.Drawing.Color]::FromArgb(255, 59, 130, 246)
$ruleC2 = [System.Drawing.Color]::FromArgb(255, 13, 148, 136)
$ruleRect = New-Object System.Drawing.RectangleF 30, 260, 380, 3
$rule = New-Object System.Drawing.Drawing2D.LinearGradientBrush $ruleRect, $ruleC1, $ruleC2, 0
$g.FillRectangle($rule, $ruleRect)

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$bg.Dispose(); $glowBlue.Dispose(); $glowBluePath.Dispose(); $glowTeal.Dispose(); $glowTealPath.Dispose()
$nameFont.Dispose(); $nameBrush.Dispose(); $subFont.Dispose(); $subBrush.Dispose()
$headlineFont.Dispose(); $bodyFont.Dispose(); $bodyBrush.Dispose()
$chipFont.Dispose(); $chipTextBrush.Dispose(); $chipFill.Dispose(); $chipPen.Dispose()
$footFont.Dispose(); $footBrush.Dispose(); $rule.Dispose()
Write-Host "Wrote $out"
