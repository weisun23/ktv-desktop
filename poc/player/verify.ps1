<#
.SYNOPSIS
  跑阶段 0 的全部验证，任一项失败即以非零码退出。

  1. 环境自检    vlc_poc.py --selftest     播放/枚举音轨/切音轨/切声道/seek
  2. 音频级验证  vlc_ktv_verify.py         录下切换后的 PCM 做频谱分析
  3. 窗口嵌入    vlc_embed_verify.py       渲染进外部 HWND（Tauri 的嵌入方式）

.EXAMPLE
  pwsh -File poc/player/verify.ps1
#>
$ErrorActionPreference = 'Stop'
$repoRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$playerDir = Join-Path $repoRoot 'poc\player'

if (-not (Test-Path (Join-Path $repoRoot 'resources\runtime\vlc\vlc-3.0.21\libvlc.dll'))) {
    Write-Host "libVLC 缺失，先执行 fetch-vlc.ps1"
    & (Join-Path $playerDir 'fetch-vlc.ps1')
}
if (-not (Test-Path (Join-Path $repoRoot 'testmedia\ktv_lr.ts'))) {
    Write-Host "测试片缺失，先执行 make-testmedia.ps1"
    & (Join-Path $playerDir 'make-testmedia.ps1')
}

$failed = @()

Write-Host "`n########## 1/3 环境自检 ##########"
python (Join-Path $playerDir 'vlc_poc.py') --selftest --report (Join-Path $playerDir 'selftest-report.json')
if ($LASTEXITCODE -ne 0) { $failed += 'vlc_poc.py --selftest' }

Write-Host "`n########## 2/3 音频级端到端验证 ##########"
python (Join-Path $playerDir 'vlc_ktv_verify.py') --report (Join-Path $playerDir 'ktv-verify-report.json')
if ($LASTEXITCODE -ne 0) { $failed += 'vlc_ktv_verify.py' }

Write-Host "`n########## 3/3 窗口嵌入验证 ##########"
python (Join-Path $playerDir 'vlc_embed_verify.py') --report (Join-Path $playerDir 'embed-verify-report.json')
if ($LASTEXITCODE -ne 0) { $failed += 'vlc_embed_verify.py' }

Write-Host ''
if ($failed.Count) {
    Write-Host "阶段 0 验证失败: $($failed -join ', ')"
    exit 1
}
Write-Host "阶段 0 验证全部通过"
