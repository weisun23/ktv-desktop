'use strict';
/** 卡顿硬指标：按时间采样 libvlc 统计，算显示帧率 / 丢帧率 / 解复用损坏率 */
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = process.argv[2] || 'process.env.KTV_TEST_FILE || 'testmedia/sample.ts'';
const SECONDS = Number(process.argv[3] || 30);

(async () => {
  const hwnd = playerMod.createHostWindow({ title: 'stutter probe', width: 1002, height: 505, visible: false });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(hwnd);
  player.load(FILE, { accomp: 2 });
  player.play();
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) { if (player.currentTime() > 6000) break; await sleep(300); }

  const rows = [];
  const start = Date.now();
  while (Date.now() - start < SECONDS * 1000) {
    const s = player.getStatus();
    rows.push({ w: Date.now(), t: s.time, st: s.stateName, stats: s.stats });
    await sleep(1000);
  }
  const first = rows[0], last = rows[rows.length - 1];
  const dw = (last.w - first.w) / 1000;
  console.log(`时长 ${dw.toFixed(1)}s  状态=${last.st}`);
  if (!first.stats || !last.stats) { console.log('stats 不可用:', first.stats, last.stats); }
  else {
    const d = (k) => last.stats[k] - first.stats[k];
    console.log(`媒体时间推进 ${((last.t - first.t) / 1000).toFixed(2)}s  (${(((last.t - first.t) / 1000) / dw).toFixed(3)}x)`);
    console.log(`解码视频帧 ${d('i_decoded_video')}   显示帧 ${d('i_displayed_pictures')}   丢帧 ${d('i_lost_pictures')}`);
    console.log(`  -> 显示帧率 ${(d('i_displayed_pictures') / dw).toFixed(1)} fps   丢帧率 ${(d('i_lost_pictures') / dw).toFixed(2)} fps`);
    console.log(`解码音频块 ${d('i_decoded_audio')}   播放音频块 ${d('i_played_abuffers')}   丢音频块 ${d('i_lost_abuffers')}`);
    console.log(`解复用损坏 ${d('i_demux_corrupted')}   不连续 ${d('i_demux_discontinuity')}   读取字节 ${(d('i_read_bytes') / 1048576).toFixed(1)}MB`);
  }
  player.dispose(); playerMod.destroyHostWindow(hwnd);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });