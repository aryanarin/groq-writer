# SPDX-License-Identifier: GPL-3.0-or-later
# Generates docs\store-assets\marquee-1400x560.png for the Chrome Web Store.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File tools\make-marquee.ps1
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'icon-art.ps1')

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'docs\store-assets\marquee-1400x560.png'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null

$w = 1400
$h = 560
$bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

$bgRect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $bgRect,
  ([System.Drawing.Color]::FromArgb(255, 11, 18, 33)),
  ([System.Drawing.Color]::FromArgb(255, 26, 43, 74)), 30
$g.FillRectangle($bg, $bgRect)

# Soft brand glows behind the hero icon, with a radial falloff.
$glowBluePath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowBluePath.AddEllipse(820, -110, 620, 620)
$glowBlue = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowBluePath)
$glowBlue.CenterColor = [System.Drawing.Color]::FromArgb(72, 37, 99, 235)
$glowBlue.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0, 37, 99, 235))
$g.FillPath($glowBlue, $glowBluePath)

$glowTealPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowTealPath.AddEllipse(-160, 340, 480, 480)
$glowTeal = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowTealPath)
$glowTeal.CenterColor = [System.Drawing.Color]::FromArgb(44, 13, 148, 136)
$glowTeal.SurroundColors = [System.Drawing.Color[]]@([System.Drawing.Color]::FromArgb(0, 13, 148, 136))
$g.FillPath($glowTeal, $glowTealPath)

# Concentric halos around the icon.
$ring1 = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(26, 255, 255, 255)), 2
$ring2 = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(38, 124, 176, 255)), 1.5
$g.DrawEllipse($ring1, 880, 40, 480, 480)
$g.DrawEllipse($ring2, 918, 78, 404, 404)

# Hero icon and brand mark, drawn at their native resolution.
Add-AppArtwork $g 980 140 280 $true
Add-AppArtwork $g 88 64 84 $true

$nameFont = New-Object System.Drawing.Font 'Segoe UI', 46, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$nameBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 244, 248, 255))
$g.DrawString('FluentText', $nameFont, $nameBrush, 192, 64)

$subFont = New-Object System.Drawing.Font 'Segoe UI', 13, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$subBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 124, 176, 255))
$g.DrawString('WRITING ASSISTANT', $subFont, $subBrush, 196, 124)

# Headline and supporting copy.
$headlineFont = New-Object System.Drawing.Font 'Segoe UI', 52, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('Write with confidence', $headlineFont, $nameBrush, 88, 205)

$bodyFont = New-Object System.Drawing.Font 'Segoe UI', 21, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$bodyBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 169, 185, 208))
$g.DrawString('Proofread as you type. Rewrite and translate on any site.', $bodyFont, $bodyBrush, 90, 282)

# Feature chips.
$chipFont = New-Object System.Drawing.Font 'Segoe UI', 15.5, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$chipTextBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 219, 230, 246))
$chipFill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(16, 255, 255, 255))
$chipPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(60, 255, 255, 255)), 1
$chipX = 90
$chipY = 346
$chipH = 40
foreach ($label in 'Proofread as you type', 'Rewrite', 'Translate') {
  $textW = $g.MeasureString($label, $chipFont).Width
  $chipW = [single]([Math]::Ceiling($textW) + 34)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $rad = 10
  $path.AddArc($chipX, $chipY, $rad * 2, $rad * 2, 180, 90)
  $path.AddArc($chipX + $chipW - $rad * 2, $chipY, $rad * 2, $rad * 2, 270, 90)
  $path.AddArc($chipX + $chipW - $rad * 2, $chipY + $chipH - $rad * 2, $rad * 2, $rad * 2, 0, 90)
  $path.AddArc($chipX, $chipY + $chipH - $rad * 2, $rad * 2, $rad * 2, 90, 90)
  $path.CloseFigure()
  $g.FillPath($chipFill, $path)
  $g.DrawPath($chipPen, $path)
  $g.DrawString($label, $chipFont, $chipTextBrush, $chipX + 17, $chipY + 8)
  $path.Dispose()
  $chipX += $chipW + 10
}

# Provider footer, gradient rule and license line.
$footFont = New-Object System.Drawing.Font 'Segoe UI', 15, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$footBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 125, 142, 168))
$g.DrawString('Groq, OpenAI and any OpenAI-compatible API', $footFont, $footBrush, 90, 444)

$ruleC1 = [System.Drawing.Color]::FromArgb(255, 59, 130, 246)
$ruleC2 = [System.Drawing.Color]::FromArgb(255, 13, 148, 136)
$ruleRect = New-Object System.Drawing.RectangleF 90, 486, 760, 4
$rule = New-Object System.Drawing.Drawing2D.LinearGradientBrush $ruleRect, $ruleC1, $ruleC2, 0
$g.FillRectangle($rule, $ruleRect)

$smallFont = New-Object System.Drawing.Font 'Segoe UI', 13, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('Open source under GPL-3.0. No tracking, no analytics.', $smallFont, $footBrush, 90, 506)

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$bg.Dispose(); $glowBlue.Dispose(); $glowBluePath.Dispose(); $glowTeal.Dispose(); $glowTealPath.Dispose()
$ring1.Dispose(); $ring2.Dispose()
$nameFont.Dispose(); $nameBrush.Dispose(); $subFont.Dispose(); $subBrush.Dispose()
$headlineFont.Dispose(); $bodyFont.Dispose(); $bodyBrush.Dispose()
$chipFont.Dispose(); $chipTextBrush.Dispose(); $chipFill.Dispose(); $chipPen.Dispose()
$footFont.Dispose(); $footBrush.Dispose(); $rule.Dispose(); $smallFont.Dispose()
Write-Host "Wrote $out"
