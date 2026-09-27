/**
 * 在线取流端到端验证（需要网络 + 已配置 provider）
 * ==============================================
 * 完整走一遍：曲目 -> 实时取地址 -> libVLC 播放 -> 原伴唱切换
 *
 * 这是阶段 3 的核心验证：证明"从曲库点一首歌，能在线播起来并切原伴唱"。
 * 未配置 provider 时会跳过并以 0 退出，便于放进回归而不误报失败。
 *
 * 用法: node test/live-play-test.js [musicNo]
 */
'use strict';

const path = require('path');
const { KtvPlayer, VideoSurface, createHostWindow, destroyHostWindow } = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = pred(); if (v) return v; } catch { /* 尚未就绪 */ }
    await sleep(step);
  }
  return null;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  return !!ok;
}

async function main() {
  const cfg = ktvApi.loadConfig();
  const providers = ktvApi.availableProviders(cfg);
  if (!providers.length) {
    console.log('未配置取流 provider，跳过在线端到端验证。');
    console.log(`配置位置: ${ktvApi.CONFIG_FILE}`);
    return 0;
  }

  const musicNo = process.argv[2] || '7789715';
  console.log(`取流 provider: ${providers.map((p) => p.name).join(',')}   测试曲目 musicNo=${musicNo}\n`);

  // ── 1. 实时取地址 ──
  const t0 = Date.now();
  let resolved;
  try {
    resolved = await ktvApi.resolvePlayUrl({ musicNo, filename: `${musicNo}.ts`, name: musicNo });
  } catch (e) {
    check('实时获取播放地址', false, e.message);
    return 1;
  }
  check('实时获取播放地址', true, `${Date.now() - t0}ms  ${resolved.url.slice(0, 96)}`);
  check('地址带有效期', typeof resolved.expiresAt === 'number' && resolved.expiresAt > Date.now(),
    resolved.expiresAt ? new Date(resolved.expiresAt).toISOString() : '无');

  // ── 2. 播放 ──
  const parent = createHostWindow({ title: 'KTV live test', width: 960, height: 540 });
  const surface = new VideoSurface(parent, { scaleFactor: 1 });
  surface.setBounds({ x: 0, y: 0, width: 960, height: 540 });

  const player = new KtvPlayer();
  player.attachSurface(surface.handle());
  player.load(resolved.url, { accomp: 2, isStream: true });
  player.play();

  const started = await waitFor(() => player.getStatus().time > 300, 45000);
  check('在线流起播', !!started, `state=${player.getStatus().stateName} time=${player.getStatus().time}ms`);

  const vout = await waitFor(() => player.getStatus().hasVout, 15000);
  const st = player.getStatus();
  check('建立视频输出', !!vout, `${st.videoSize.width}x${st.videoSize.height}`);

  // ── 3. 音轨与原伴唱 ──
  await waitFor(() => player.getTracks().length >= 2, 20000);
  const tracks = player.getTracks();
  check('在线片源含多条音轨', tracks.length >= 2, JSON.stringify(tracks));

  const strategy = player.resolveStrategy();
  check('判定为音轨型（原伴唱走切音轨）', strategy === 'track', `strategy=${strategy}`);

  const map = player.getTrackMap();
  player.setVocalMode('accompaniment');
  await sleep(900);
  const t1 = player.getTrack();
  check('切伴唱命中音轨', t1 === map.accompaniment, `current=${t1} expect=${map.accompaniment}`);

  player.setVocalMode('original');
  await sleep(900);
  const t2 = player.getTrack();
  check('切原唱命中音轨', t2 === map.original, `current=${t2} expect=${map.original}`);

  // 切完继续播（不中断）
  const stillPlaying = await waitFor(() => player.getStatus().playing, 8000);
  check('切换后仍在播放', !!stillPlaying, `time=${player.getStatus().time}ms`);

  player.dispose();
  surface.destroy();
  destroyHostWindow(parent);

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`在线端到端验证失败 ${failed.length}/${results.length} 项`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    return 1;
  }
  console.log(`在线端到端验证全部通过（${results.length} 项）`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error('异常:', e); process.exit(1); });
