# BUILD-TIME: render logo.png into the per-size PNGs that scripts/build-icon.mjs
# packs into build/icon.ico, plus the two standalone icons the app loads.
#
# Run after changing the source artwork:
#   powershell -ExecutionPolicy Bypass -File scripts/render-icons.ps1
#   node scripts/build-icon.mjs
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'logo.png'
if (-not (Test-Path $source)) { throw "Source artwork not found: $source" }

$iconsDir = Join-Path $root 'build\icons'
New-Item -ItemType Directory -Force $iconsDir | Out-Null

$src = [System.Drawing.Image]::FromFile($source)
try {
  function Save-Rendition($image, [int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $bmp.SetResolution(96, 96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($image, 0, 0, $size, $size)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }

  foreach ($s in 16, 24, 32, 48, 64, 128, 256) {
    Save-Rendition $src $s (Join-Path $iconsDir "$s.png")
  }
  # electron-builder's own source, and the renderer's favicon / inlined mark.
  Copy-Item $source (Join-Path $root 'build\icon.png') -Force
  Save-Rendition $src 128 (Join-Path $root 'packages\ui\public\logo.png')
  Write-Host "Rendered icon sizes into build/icons and refreshed build/icon.png."
} finally {
  $src.Dispose()
}
