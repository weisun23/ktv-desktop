'use strict';
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = process.argv[2];
const EXTRA = JSON.parse(process.argv[3] || '[]');
const LABEL = process.argv[4] || 'x';
(async () => {
  const hwnd = playerMod.createHostWindow({ title: 'v', width: 800, height: 450, visible: false });
  const player = new playerMod.KtvPlayer({ vlcArgs: ['--avcodec-hw=none', ...EXTRA] });
  player.attachSurface(hwnd);
  player.load(FILE, { accomp: 2 });
  player.play();
  let t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (player.currentTime() > 1200) break; await sleep(300); }
  const a = player.getStatus();
  console.log(`[${LABEL}] 起点 ${(a.time/1000).toFixed(0)}s`);
  let prev = a; const out = [];
  for (let k = 0; k < 13; k++) {
    await sleep(10000);
    const b = player.getStatus();
    const seg = (key) => (b.stats?.[key] || 0) - (prev.stats?.[key] || 0);
    out.push(`${(b.time/1000).toFixed(0)}s:+${seg('i_played_abuffers')}/丢${b.stats?.i_lost_abuffers||0}/帧+${seg('i_displayed_pictures')}`);
    prev = b;
  }
  console.log('  ' + out.join('\n  '));
  player.dispose(); playerMod.destroyHostWindow(hwnd);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });