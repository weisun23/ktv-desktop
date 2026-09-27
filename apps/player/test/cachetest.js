'use strict';
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = '.tmp-diag/angel-R.ts';
const CASES = [
  ['cache=5000', ['--file-caching=5000']],
  ['cache=500',  ['--file-caching=500']],
  ['cache=10000',['--file-caching=10000']],
];
(async () => {
  for (const [tag, args] of CASES) {
    const hwnd = playerMod.createHostWindow({ title: tag, width: 640, height: 360, visible: false });
    const p = new playerMod.KtvPlayer({ vlcArgs: args, softwareDecode: true });
    p.attachSurface(hwnd);
    p.load(FILE, { accomp: 2 });
    p.play();
    let t0 = Date.now();
    while (Date.now() - t0 < 20000) { if (p.currentTime() > 1500) break; await sleep(300); }
    let prev = p.getStatus(); const out = [];
    for (let k = 0; k < 11; k++) {
      await sleep(10000);
      const b = p.getStatus();
      const seg = (key) => (b.stats?.[key] || 0) - (prev.stats?.[key] || 0);
      out.push(`${(b.time/1000).toFixed(0)}s:+${seg('i_played_abuffers')}/丢${b.stats?.i_lost_abuffers||0}`);
      prev = b;
    }
    console.log(`[${tag}] ${out.join('  ')}`);
    p.dispose(); playerMod.destroyHostWindow(hwnd);
    await sleep(400);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });