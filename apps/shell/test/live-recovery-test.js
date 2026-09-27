/**
 * 断流恢复端到端验证（真实网络）
 * ==============================
 * 故意用一个**已知过期**的播放地址起播（曲库里那条签名失效的 URL，实测 403），
 * 看监管器能否发现失败、实时重取地址、并成功续播。
 *
 * 这验证的是最容易踩的坑：地址约 1 小时过期后播放会中断。
 *
 * 用法: node test/live-recovery-test.js
 */
'use strict';

const { KtvPlayer, VideoSurface, createHostWindow, destroyHostWindow } = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');
const { PlaybackSupervisor } = require('../src/supervisor');

// 曲库里真实存在但签名已过期（403）的地址
const EXPIRED_URL = 'http://download.origjoy.com/E/ts/0.0/240p/4102967.ts'
  + '?sign=149a9b9baa411909cdce9c7cd09c4c7f&t=6a59aefe';
const MUSIC_NO = '4102967';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, step = 300) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = pred(); if (v) return v; } catch { /* 未就绪 */ }
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
  if (!ktvApi.availableProviders(cfg).length) {
    console.log('未配置取流 provider，跳过断流恢复验证。');
    return 0;
  }

  console.log('先用已知过期的地址起播，等监管器救回来…\n');

  const parent = createHostWindow({ title: 'KTV recovery test', width: 640, height: 360 });
  const surface = new VideoSurface(parent, { scaleFactor: 1 });
  surface.setBounds({ x: 0, y: 0, width: 640, height: 360 });

  const player = new KtvPlayer();
  player.attachSurface(surface.handle());

  const notices = [];
  const song = { id: 'x', name: '过期地址恢复测试', musicNo: MUSIC_NO, accomp: 2, playSource: 'online' };
  const sup = new PlaybackSupervisor({
    player,
    resolveUrl: () => ktvApi.resolvePlayUrl(song),
    notify: (n) => { notices.push(n); console.log(`    [notice] ${n.text}`); },
  });
  sup.setSong(song);
  player.on('status', (st) => sup.onStatus(st));
  player.on('error', (st) => sup.onFailure(st.reason || 'libvlc-error'));
  player.on('stalled', (st) => sup.onFailure(st.reason || 'stalled'));

  player.load(EXPIRED_URL, { accomp: 2, isStream: true });
  player.play();

  // 过期地址应当失败或卡住，随后监管器介入
  const recovered = await waitFor(() => notices.some((n) => n.kind === 'ok' && /重新取流/.test(n.text)), 60000, 500);
  check('监管器检测到失败并重新取流', !!recovered, recovered ? '' : `未恢复，提示: ${notices.map((n) => n.text).join(' | ') || '无'}`);

  const playing = await waitFor(() => {
    const st = player.getStatus();
    return st.playing && st.time > 500 && st.stateName === 'Playing';
  }, 40000);
  const st = player.getStatus();
  check('恢复后正常播放', !!playing, `state=${st.stateName} time=${st.time}ms`);

  const vout = await waitFor(() => player.getStatus().hasVout, 15000);
  check('恢复后建立视频输出', !!vout, `${st.videoSize.width}x${st.videoSize.height}`);

  await waitFor(() => player.getTracks().length >= 2, 20000);
  const tracks = player.getTracks();
  check('恢复后的片源仍含原伴唱音轨', tracks.length >= 2, JSON.stringify(tracks));

  if (tracks.length >= 2) {
    player.resolveStrategy();
    const map = player.getTrackMap();
    player.setVocalMode('accompaniment');
    await sleep(900);
    check('恢复后原伴唱切换仍可用', player.getTrack() === map.accompaniment,
      `current=${player.getTrack()} expect=${map.accompaniment}`);
  }

  player.dispose();
  surface.destroy();
  destroyHostWindow(parent);

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`断流恢复验证失败 ${failed.length}/${results.length} 项`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    return 1;
  }
  console.log(`断流恢复验证全部通过（${results.length} 项）`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error('异常:', e); process.exit(1); });
