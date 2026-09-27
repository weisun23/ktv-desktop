<#
.SYNOPSIS
  用 ffmpeg 生成两份 KTV 测试片，覆盖原伴唱切换的两种载体。

  440Hz 代表"伴唱"，880Hz 代表"原唱"，这样用频谱分析就能判断切换是否真的生效。

  ktv_lr.ts       老式 KTV：单音轨立体声，左=伴唱(440) 右=原唱(880)
  ktv_2tracks.ts  新式 KTV：双音轨，Track0=伴唱(440) Track1=原唱(880)

.EXAMPLE
  pwsh -File poc/player/make-testmedia.ps1
#>
param(
    [int]$Seconds = 30
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$outDir   = Join-Path $repoRoot 'testmedia'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    throw "未找到 ffmpeg，请先安装并加入 PATH"
}

$common = @(
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000'
)
$venc = @('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1500k', '-pix_fmt', 'yuv420p', '-g', '50')
$aenc = @('-c:a', 'mp2', '-b:a', '128k', '-ac', '2')

# A. 声道型：把两路正弦合并成一条立体声（L=440 伴唱, R=880 原唱）
$lr = Join-Path $outDir 'ktv_lr.ts'
& ffmpeg @common -filter_complex '[1:a][2:a]amerge=inputs=2[a]' -map 0:v -map '[a]' -t $Seconds `
    @venc @aenc -metadata:s:a:0 title='LR-KTV' -f mpegts $lr
if ($LASTEXITCODE -ne 0) { throw "生成 ktv_lr.ts 失败" }
Write-Host "生成 $lr"

# B. 音轨型：两条独立音轨（Track0=440 伴唱, Track1=880 原唱）
$two = Join-Path $outDir 'ktv_2tracks.ts'
& ffmpeg @common -map 0:v -map 1:a -map 2:a -t $Seconds `
    @venc @aenc -metadata:s:a:0 title='accompaniment' -metadata:s:a:0 language=eng `
    -metadata:s:a:1 title='original' -metadata:s:a:1 language=chi -f mpegts $two
if ($LASTEXITCODE -ne 0) { throw "生成 ktv_2tracks.ts 失败" }
Write-Host "生成 $two"
