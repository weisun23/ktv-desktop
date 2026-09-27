<#
.SYNOPSIS
  下载便携版 libVLC（Windows x64）到 resources/runtime/vlc。
  本项目不把 libVLC 提交进 git，首次使用前执行一次即可。

.EXAMPLE
  pwsh -File poc/player/fetch-vlc.ps1
#>
param(
    [string]$Version = '3.0.21'
)

$ErrorActionPreference = 'Stop'
$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtimeDir = Join-Path $repoRoot 'resources\runtime'
$targetDir  = Join-Path $runtimeDir "vlc\vlc-$Version"
$zipPath    = Join-Path $runtimeDir "vlc-$Version-win64.zip"

if (Test-Path (Join-Path $targetDir 'libvlc.dll')) {
    Write-Host "libVLC 已就绪: $targetDir"
    exit 0
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$file = "vlc-$Version-win64.zip"
# 国内镜像优先（get.videolan.org 会 302 到镜像页，直连拿到的是 HTML）
$mirrors = @(
    "https://mirrors.tuna.tsinghua.edu.cn/videolan-ftp/vlc/$Version/win64/$file",
    "https://mirror.nju.edu.cn/videolan-ftp/vlc/$Version/win64/$file",
    "https://mirrors.ustc.edu.cn/videolan-ftp/vlc/$Version/win64/$file"
)

$downloaded = $false
foreach ($url in $mirrors) {
    try {
        Write-Host "下载 $url"
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 900
        $magic = [System.IO.File]::ReadAllBytes($zipPath)[0..3] -join ','
        if ($magic -ne '80,75,3,4') { throw "不是合法 zip (magic=$magic)" }
        $downloaded = $true
        break
    } catch {
        Write-Warning "镜像失败: $($_.Exception.Message)"
    }
}
if (-not $downloaded) { throw "所有镜像均下载失败" }

Write-Host "解压到 $targetDir"
Expand-Archive -LiteralPath $zipPath -DestinationPath (Join-Path $runtimeDir 'vlc') -Force
Remove-Item -LiteralPath $zipPath -Force

if (-not (Test-Path (Join-Path $targetDir 'libvlc.dll'))) {
    throw "解压后未找到 libvlc.dll，请检查目录结构: $targetDir"
}
Write-Host "完成: $targetDir"
