<#
.SYNOPSIS
  下载 Node.js 便携运行时（Windows x64）到 resources/runtime/node。
  曲库服务需要 node:sqlite；Electron 自带的 Node 版本不够新，所以单独带一份。
  本项目不把 node.exe 提交进 git，首次使用前执行一次即可。

.EXAMPLE
  pwsh -File poc/player/fetch-node.ps1
#>
param(
    [string]$Version = '22.12.0'
)

$ErrorActionPreference = 'Stop'
$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtimeDir = Join-Path $repoRoot 'resources\runtime'
$targetDir  = Join-Path $runtimeDir 'node'
$targetExe  = Join-Path $targetDir 'node.exe'

if (Test-Path $targetExe) {
    Write-Host "Node.js 已就绪: $targetExe"
    exit 0
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$zipName = "node-v$Version-win-x64.zip"
$zipPath = Join-Path $runtimeDir $zipName
$urls = @(
    "https://nodejs.org/dist/v$Version/$zipName",
    "https://npmmirror.com/mirrors/node/v$Version/$zipName"
)

$downloaded = $false
foreach ($url in $urls) {
    try {
        Write-Host "下载 $url"
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 900
        $magic = [System.IO.File]::ReadAllBytes($zipPath)[0..3] -join ','
        if ($magic -ne '80,75,3,4') { throw "不是合法 zip (magic=$magic)" }
        $downloaded = $true
        break
    } catch {
        Write-Warning "下载失败: $($_.Exception.Message)"
        if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue }
    }
}
if (-not $downloaded) { throw 'Node.js 官方源和国内镜像均下载失败' }

$extractDir = Join-Path $runtimeDir "node-extract-$Version"
if (Test-Path $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

try {
    Write-Host "解压 Node.js 运行时"
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
    $found = Get-ChildItem -Path $extractDir -Recurse -Filter 'node.exe' | Select-Object -First 1
    if (-not $found) { throw '解压后未找到 node.exe' }
    Copy-Item -LiteralPath $found.FullName -Destination $targetExe -Force
} finally {
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $extractDir -Recurse -Force -ErrorAction SilentlyContinue
}

$actual = (& $targetExe --version).Trim()
if ($actual -ne "v$Version") {
    throw "node.exe 版本不匹配: 期望 v$Version，实际 $actual"
}
Write-Host "Node.js 已安装: $targetExe ($actual)"
