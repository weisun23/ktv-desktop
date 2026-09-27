'use strict';
/** 连续播 130s，看音频输出是否在某点开始丢块 */
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = process.argv[2];
const LABEL = process.argv[3] || 'file';
(async () => {
  const hwnd = playerMod.createHostWindow({ title: 'aout', width: 800, height: 450, visible: false });
  const player = new playerMod.KtvPlayer({ vlcArgs: ['--avcodec-hw=none'] });
  player.attachSurface(hwnd);
  player.load(FILE, { accomp: 2 });
  player.play();
  let t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (player.currentTime() > 1200) break; await sleep(300); }
  const a = player.getStatus();
  console.log(`[${LABEL}] 起点 ${(a.time/1000).toFixed(0)}s`);
  console.log('媒体时间 | 播放音频块(近10s) | 丢音频块(累计) | 解码音频(近10s) | 显示帧(近10s)');
  let prev = a;
  const T0 = Date.now();
  for (let k = 0; k < 13; k++) {
    await sleep(10000);
    const b = player.getStatus();
    const seg = (key) => (b.stats?.[key] || 0) - (prev.stats?.[key] || 0);
    console.log(`${(b.time/1000).toFixed(0)}s | +${seg('i_played_abuffers')} | ${(b.stats?.i_lost_abuffers||0)} | +${seg('i_decoded_audio')} | +${seg('i_displayed_pictures')}`);
    prev = b;
    if (Date.now() - T0 > 135000) break;
  }
  player.dispose(); playerMod.destroyHostWindow(hwnd);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });