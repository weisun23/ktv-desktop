'use strict';
/** 分段测量：开头 vs 后段，看是否越播越差 */
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = 'process.env.KTV_TEST_FILE || 'testmedia/sample.ts'';

async function measureAt(seekSec, seconds, label) {
  const hwnd = playerMod.createHostWindow({ title: 'seg', width: 800, height: 450, visible: false });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(hwnd);
  player.load(FILE, { accomp: 2 });
  player.play();
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (player.currentTime() > 1500) break; await sleep(300); }
  if (seekSec > 0) {
    player.seek(seekSec * 1000);
    const d = Date.now() + 20000;
    while (Date.now() < d) { const t = player.currentTime(); if (t > seekSec * 1000 + 800) break; await sleep(300); }
  }
  await sleep(1500);
  const a = player.getStatus();
  const s0 = Date.now();
  while (Date.now() - s0 < seconds * 1000) await sleep(500);
  const b = player.getStatus();
  const dw = (b.time - a.time) / 1000;
  const d = (k) => (b.stats?.[k] || 0) - (a.stats?.[k] || 0);
  console.log(`[${label}] 位置 ${(a.time/1000).toFixed(0)}s→${(b.time/1000).toFixed(0)}s  推进 ${dw.toFixed(1)}s (${(dw/((b.time-a.time)/1000)).toFixed(2)}x)`);
  console.log(`   显示帧 ${d('i_displayed_pictures')} (${(d('i_displayed_pictures')/dw).toFixed(1)}fps)  丢帧 ${d('i_lost_pictures')}  不连续 ${d('i_demux_discontinuity')}`);
  console.log(`   播放音频块 ${d('i_played_abuffers')}  丢音频块 ${d('i_lost_abuffers')}  解码音频 ${d('i_decoded_audio')}`);
  player.dispose(); playerMod.destroyHostWindow(hwnd);
  await sleep(600);
}

(async () => {
  await measureAt(0, 20, '开头');
  await measureAt(200, 20, '后段(200s起)');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });