'use strict';
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = process.argv[2];
const SOFT = process.argv[3] === 'soft';
(async () => {
  const log = `.tmp-diag/sw-${SOFT ? 'on' : 'off'}.log`;
  const hwnd = playerMod.createHostWindow({ title: 'sw', width: 800, height: 450, visible: false });
  const p = new playerMod.KtvPlayer({
    softwareDecode: SOFT,
    vlcArgs: ['--verbose=2', '--file-logging', '--logfile=' + log],
  });
  p.attachSurface(hwnd);
  p.load(FILE, { accomp: 2 });
  p.play();
  let t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (p.currentTime() > 1500) break; await sleep(300); }
  const a = p.getStatus();
  let prev = a; const out = [];
  for (let k = 0; k < 8; k++) {
    await sleep(10000);
    const b = p.getStatus();
    const seg = (key) => (b.stats?.[key] || 0) - (prev.stats?.[key] || 0);
    out.push(`${(b.time/1000).toFixed(0)}s:帧+${seg('i_displayed_pictures')} 丢帧${seg('i_lost_pictures')} 音频+${seg('i_played_abuffers')} 丢音${b.stats?.i_lost_abuffers||0}`);
    prev = b;
  }
  console.log(`[softwareDecode=${SOFT}]`);
  console.log('  ' + out.join('\n  '));
  p.dispose(); playerMod.destroyHostWindow(hwnd);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });