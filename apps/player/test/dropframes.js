'use strict';
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = '.tmp-diag/nomws.ts';
const CASES = [
  ['inst', ['--no-drop-late-frames', '--no-skip-frames']],
  ['media', []],
];
(async () => {
  for (const [tag, args] of CASES) {
    const hwnd = playerMod.createHostWindow({ title: tag, width: 800, height: 450, visible: false });
    const p = new playerMod.KtvPlayer({ vlcArgs: args, softwareDecode: true });
    p.attachSurface(hwnd);
    p.load(FILE, { accomp: 2 });
    if (tag === 'media') {
      const { addMediaOption } = require('../src/vlc-ffi');
      addMediaOption(p.media, ':drop-late-frames=0');
      addMediaOption(p.media, ':skip-frames=0');
    }
    p.play();
    let t0 = Date.now();
    while (Date.now() - t0 < 20000) { if (p.currentTime() > 1500) break; await sleep(300); }
    const a = p.getStatus(); let prev = a; const out = [];
    for (let k = 0; k < 7; k++) {
      await sleep(10000);
      const b = p.getStatus();
      const seg = (key) => (b.stats?.[key] || 0) - (prev.stats?.[key] || 0);
      out.push(`帧+${seg('i_displayed_pictures')}/丢${seg('i_lost_pictures')}`);
      prev = b;
    }
    console.log(`[${tag}] ${out.join('  ')}`);
    p.dispose(); playerMod.destroyHostWindow(hwnd);
    await sleep(500);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });