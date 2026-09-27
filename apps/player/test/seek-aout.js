'use strict';
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = process.argv[2], SEEK = Number(process.argv[3] || 0), LABEL = process.argv[4] || 'x';
(async () => {
  const hwnd = playerMod.createHostWindow({ title: 'seek', width: 800, height: 450, visible: false });
  const player = new playerMod.KtvPlayer({ vlcArgs: ['--avcodec-hw=none'] });
  player.attachSurface(hwnd);
  player.load(FILE, { accomp: 2 });
  player.play();
  let t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (player.currentTime() > 1200) break; await sleep(300); }
  if (SEEK > 0) {
    player.seek(SEEK * 1000);
    const d = Date.now() + 25000;
    while (Date.now() < d) { if (player.currentTime() > SEEK * 1000 + 1000) break; await sleep(300); }
  }
  await sleep(1200);
  const a = player.getStatus();
  console.log(`[${LABEL}] 起点 ${(a.time/1000).toFixed(0)}s`);
  console.log('媒体时间 | 播放音频块(近10s) | 丢音频块(累计) | 显示帧(近10s)');
  let prev = a;
  for (let k = 0; k < 14; k++) {
    await sleep(10000);
    const b = player.getStatus();
    const seg = (key) => (b.stats?.[key] || 0) - (prev.stats?.[key] || 0);
    console.log(`${(b.time/1000).toFixed(0)}s | +${seg('i_played_abuffers')} | ${b.stats?.i_lost_abuffers||0} | +${seg('i_displayed_pictures')}`);
    prev = b;
  }
  player.dispose(); playerMod.destroyHostWindow(hwnd);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });