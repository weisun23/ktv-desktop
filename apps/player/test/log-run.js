'use strict';
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = process.argv[2];
const LOG = '.tmp-diag/vlc-raw.log';
(async () => {
  const hwnd = playerMod.createHostWindow({ title: 'log', width: 800, height: 450, visible: false });
  const player = new playerMod.KtvPlayer({ vlcArgs: ['--avcodec-hw=none', '--verbose=2', '--file-logging', '--logfile=' + LOG] });
  player.attachSurface(hwnd);
  player.load(FILE, { accomp: 2 });
  player.play();
  let t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (player.currentTime() > 1200) break; await sleep(300); }
  console.log('开始记录，播 125 秒...');
  for (let k = 0; k < 13; k++) {
    await sleep(10000);
    const s = player.getStatus();
    console.log(`  ${(s.time/1000).toFixed(0)}s  播放音频块=${s.stats?.i_played_abuffers} 丢=${s.stats?.i_lost_abuffers}`);
  }
  player.dispose(); playerMod.destroyHostWindow(hwnd);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });