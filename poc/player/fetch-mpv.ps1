<#
.SYNOPSIS
  下载便携版 mpv（Windows x64）到 resources/runtime/mpv。
  本项目不把 mpv 提交进 git，首次使用前执行一次即可。

.DESCRIPTION
  为什么需要 mpv：maidong 分发的 .ts 片源里有周期性损坏段，libVLC 处理这种片源
  要么把视频丢到 15fps，要么让音频在 ~100 秒后彻底停摆。mpv 用 ffmpeg 系
  解复用/解码（和 Android 端 IJK 同源），同一份片源实测满帧、丢帧 0、音频全程正常。
  详见 docs/16-mv-stutter-root-cause.md。

  只需要 mpv.exe 一个文件（静态链接，无额外依赖）。

.EXAMPLE
  pwsh -File poc/player/fetch-mpv.ps1
#>
param(
    [string]$Release = '20260923',
    [string]$Asset = 'mpv-x86_64-20260923-git-6fd80b2003.7z'
)

$ErrorActionPreference = 'Stop'
$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtimeDir = Join-Path $repoRoot 'resources\runtime'
$targetDir  = Join-Path $runtimeDir 'mpv'
$targetExe  = Join-Path $targetDir 'mpv.exe'

if (Test-Path $targetExe) {
    Write-Host "mpv 已就绪: $targetExe"
    exit 0
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

# 找 7z 解压工具（mpv 官方 Windows 包是 .7z）
$sevenZip = $null
foreach ($c in @('7z', "$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe")) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { $sevenZip = $cmd.Source; break }
    if (Test-Path $c) { $sevenZip = $c; break }
}
if (-not $sevenZip) {
    throw "没找到 7z。请先装 7-Zip（或把 7z.exe 放进 PATH）再跑本脚本。"
}

$url = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$Release/$Asset"
$archive = Join-Path $runtimeDir $Asset
Write-Host "下载 $url"
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing -TimeoutSec 1800

$tmp = Join-Path $runtimeDir 'mpv-extract'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
& $sevenZip x $archive "-o$tmp" -y | Out-Null

$found = Get-ChildItem -Path $tmp -Recurse -Filter 'mpv.exe' | Select-Object -First 1
if (-not $found) { throw "解压后没找到 mpv.exe" }
Copy-Item $found.FullName $targetExe -Force
Remove-Item -Recurse -Force $tmp
Remove-Item -Force $archive

Write-Host "mpv 已安装: $targetExe"
