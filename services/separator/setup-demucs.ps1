<#
.SYNOPSIS
  安装 AI 人声分离插件（Demucs）。
.DESCRIPTION
  Demucs 依赖 PyTorch，不适合塞进安装包，所以按需安装到数据目录。
  本脚本会：
    1. 建一个独立 venv（默认 Python 3.11，torch 的轮子覆盖最好）
    2. 装 demucs（含 CPU 版 torch）
    3. 生成 separate.cmd —— 这就是要填进「设置 → 音频分离 → 插件路径」的东西
    4. 自检：跑一次 --help

  首次真正分离时会再自动下载模型权重（htdemucs 约 80MB）。

.EXAMPLE
  pwsh -File services/separator/setup-demucs.ps1
  pwsh -File services/separator/setup-demucs.ps1 -Target D:\ktv-plugins\demucs
#>
param(
    [string]$Target = '',
    [string]$PythonVersion = '3.11',
    [switch]$Force,
    # 装 CUDA 版 PyTorch（约 2.5GB），分离速度提升一个数量级
    [switch]$Gpu
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Target) { $Target = Join-Path $repoRoot 'resources\plugins\demucs' }
$Target = [IO.Path]::GetFullPath($Target)

$venv = Join-Path $Target '.venv'
$pyExe = Join-Path $venv 'Scripts\python.exe'
$pluginPy = Join-Path $PSScriptRoot 'demucs-plugin.py'
$wrapper = Join-Path $Target 'separate.cmd'

if (-not (Test-Path $pluginPy)) { throw "找不到插件脚本: $pluginPy" }

if ((Test-Path $pyExe) -and -not $Force) {
    Write-Host "venv 已存在: $venv"
} else {
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    if (Test-Path $venv) { Remove-Item -Recurse -Force $venv }

    $uv = Get-Command uv -ErrorAction SilentlyContinue
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $uv -and -not $py) {
        Write-Host "未检测到 uv/Python，正在自动下载 uv…"
        $uvZip = Join-Path $Target 'uv.zip'
        $uvDir = Join-Path $Target 'uv'
        $urls = @(
            'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip',
            'https://ghproxy.net/https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
        )
        $ok = $false
        foreach ($u in $urls) {
            try {
                Invoke-WebRequest -Uri $u -OutFile $uvZip -UseBasicParsing
                Expand-Archive -Path $uvZip -DestinationPath $uvDir -Force
                $uv = Get-Item (Join-Path $uvDir 'uv.exe')
                $ok = $true
                break
            } catch { /* 尝试下一个镜像 */ }
        }
        if (-not $ok) { throw "uv 自动下载失败，请检查网络" }
    }
    if ($uv) {
        Write-Host "用 uv 创建 venv（Python $PythonVersion）…"
        & $uv.Source venv $venv --python $PythonVersion
        if ($LASTEXITCODE -ne 0) { throw "uv venv 失败" }
        Write-Host "安装 demucs（首次约 200-300MB，耐心等）…"
        # demucs 的依赖声明不全：实测只装 demucs 会在 import numpy 时炸，
        # 所以这里显式补上它实际 import 但没写进 metadata 的几个包。
        & $uv.Source pip install --python $pyExe demucs numpy torchaudio einops openunmix
        if ($LASTEXITCODE -ne 0) { throw "uv pip install 失败" }
    } else {
        Write-Host "使用本机 Python 创建 venv…"
        & $py.Source -m venv $venv
        if ($LASTEXITCODE -ne 0) { throw "创建 venv 失败" }
        & $pyExe -m pip install --upgrade pip
        # 同上：demucs 没声明 numpy/torchaudio/einops/openunmix
        & $pyExe -m pip install demucs numpy torchaudio einops openunmix
        if ($LASTEXITCODE -ne 0) { throw "pip install demucs 失败" }
    }
}

# 生成宿主调用的包装脚本（宿主按 <plugin> --input X --output Y 调用）
$cmd = @"
@echo off
"%~dp0.venv\Scripts\python.exe" "$pluginPy" %*
"@
Set-Content -Path $wrapper -Value $cmd -Encoding ASCII

# GPU 加速：把 CPU 版 torch 换成 CUDA 版。
# ⚠️ 这一步下载约 2.5GB，所以做成显式开关；不装的话自动回落到 CPU（只是慢）。
if ($Gpu) {
    Write-Host "安装 CUDA 版 PyTorch（约 2.5GB，慢）…" -ForegroundColor Yellow
    # ⚠️ 官方 download.pytorch.org 在国内实测 **SSL 握手直接失败**，所以用 Aliyun 的
    # pytorch-wheels 镜像（它按 cu124 分目录列出 wheel）。装不上再回退官方源。
    $uvBin = (Get-Command uv -ErrorAction SilentlyContinue)
    $mirror = 'https://mirrors.aliyun.com/pytorch-wheels/cu124/'
    $installed = $false
    if ($uvBin) {
        & $uvBin.Source pip install --python $pyExe --find-links $mirror "torch==2.6.0+cu124" "torchaudio==2.6.0+cu124"
        if ($LASTEXITCODE -eq 0) { $installed = $true }
    }
    if (-not $installed) {
        Write-Host "镜像安装失败，回退官方源…" -ForegroundColor DarkYellow
        & $pyExe -m pip install --upgrade torch torchaudio --index-url https://download.pytorch.org/whl/cu124
        if ($LASTEXITCODE -ne 0) { throw "CUDA 版 torch 安装失败" }
    }
    & $pyExe -c "import torch; print('CUDA 可用:', torch.cuda.is_available(), '| 设备:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
} else {
    & $pyExe -c "import torch; print('当前分离设备:', 'CUDA' if torch.cuda.is_available() else 'CPU')" 2>$null
    Write-Host "提示：想用显卡加速分离，重跑本脚本并加 -Gpu（约 2.5GB 下载）。" -ForegroundColor DarkGray
}

Write-Host "自检…"
& $wrapper --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw "插件自检失败" }

Write-Host ""
Write-Host "安装完成。" -ForegroundColor Green
Write-Host "把下面这个路径填到「设置 → 音频分离 → 插件路径」：" -ForegroundColor Green
Write-Host "  $wrapper" -ForegroundColor Yellow
Write-Host "然后在设置里把「分离方式」改成「AI 分离」。"
