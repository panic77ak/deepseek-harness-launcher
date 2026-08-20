# make-icons.ps1 — generate app icons from a source image.
#
# Converts a square source image into the icon set electron-builder needs:
#   build/icon.png   (512x512, generic / Linux)
#   build/icon.ico   (multi-size 16..256, Windows)
#   build/icon.icns  (16..512, macOS)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/make-icons.ps1 -SourceImage <path>
#
# The source should be square-ish (it is center-cropped to square). JPG/PNG/BMP all work.

param(
    [Parameter(Mandatory = $true)]
    [string]$SourceImage,
    [string]$OutDir = "build"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $SourceImage)) { throw "Source image not found: $SourceImage" }

$srcPath = (Resolve-Path $SourceImage).Path
$outFull = Join-Path (Get-Location) $OutDir
New-Item -ItemType Directory -Force -Path $outFull | Out-Null

$src = [System.Drawing.Image]::FromFile($srcPath)
Write-Host "source: $($src.Width)x$($src.Height) $($src.PixelFormat)"

# Center-crop to square, then resize to `size`, returning PNG bytes.
function New-PngBytes([int]$size) {
    $side = [Math]::Min($src.Width, $src.Height)
    $cx = [int](($src.Width - $side) / 2)
    $cy = [int](($src.Height - $side) / 2)

    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)), $cx, $cy, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
    $tmp = Join-Path $env:TEMP ("dsh-icon-{0}.png" -f $size)
    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $bytes = [System.IO.File]::ReadAllBytes($tmp)
    Remove-Item $tmp -Force
    return ,$bytes
}

# 1. Generic PNG (512).
[System.IO.File]::WriteAllBytes((Join-Path $outFull "icon.png"), (New-PngBytes 512))
Write-Host "wrote icon.png (512)"

# 2. Windows ICO: PNG-compressed entries for 16,24,32,48,64,128,256.
$icoSizes = 16, 24, 32, 48, 64, 128, 256
$pngMap = @{}
foreach ($s in $icoSizes) { $pngMap[$s] = New-PngBytes $s }

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0)                     # reserved
$bw.Write([uint16]1)                     # type: icon
$bw.Write([uint16]$icoSizes.Count)       # image count
$offset = 6 + 16 * $icoSizes.Count
foreach ($s in $icoSizes) {
    $data = $pngMap[$s]
    $dim = $s -band 0xFF                 # 256 -> 0 as the spec requires
    $bw.Write([byte]$dim)                # width
    $bw.Write([byte]$dim)                # height
    $bw.Write([byte]0)                   # palette colors
    $bw.Write([byte]0)                   # reserved
    $bw.Write([uint16]1)                 # color planes
    $bw.Write([uint16]32)                # bits per pixel
    $bw.Write([uint32]$data.Length)      # data size
    $bw.Write([uint32]$offset)           # data offset
    $offset += $data.Length
}
foreach ($s in $icoSizes) { $bw.Write($pngMap[$s]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $outFull "icon.ico"), $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
Write-Host "wrote icon.ico ($($icoSizes -join '/'))"

# 3. macOS ICNS: PNG entries keyed by OSType.
#    icp4=16 icp5=32 icp6=64 ic07=128 ic08=256 ic09=512
$icnsMap = [ordered]@{
    "icp4" = 16
    "icp5" = 32
    "icp6" = 64
    "ic07" = 128
    "ic08" = 256
    "ic09" = 512
}
$entries = @()
foreach ($type in $icnsMap.Keys) {
    $data = New-PngBytes $icnsMap[$type]
    $entries += ,@($type, $data)
}
$totalLen = 8  # 'icns' + length header
foreach ($e in $entries) { $totalLen += 8 + $e[1].Length }

$ms2 = New-Object System.IO.MemoryStream
$bw2 = New-Object System.IO.BinaryWriter($ms2)
$bw2.Write([System.Text.Encoding]::ASCII.GetBytes("icns"))
$bw2.Write([uint32]$totalLen) -band 0  # placeholder handled below
foreach ($e in $entries) {
    $bw2.Write([System.Text.Encoding]::ASCII.GetBytes($e[0]))
    $bw2.Write([uint32](8 + $e[1].Length))
    $bw2.Write($e[1])
}
$bw2.Flush()
$buf = $ms2.ToArray()
# Patch the total length (big-endian uint32 at offset 4).
$len = $buf.Length
$buf[4] = [byte](($len -shr 24) -band 0xFF)
$buf[5] = [byte](($len -shr 16) -band 0xFF)
$buf[6] = [byte](($len -shr 8) -band 0xFF)
$buf[7] = [byte]($len -band 0xFF)
[System.IO.File]::WriteAllBytes((Join-Path $outFull "icon.icns"), $buf)
$bw2.Dispose(); $ms2.Dispose()
Write-Host "wrote icon.icns ($($icnsMap.Count) entries)"

$src.Dispose()
Write-Host "done -> $outFull"
