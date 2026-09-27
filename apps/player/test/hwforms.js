'use strict';
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = '.tmp-diag/nomws.ts';
const VARIANTS = [
  ['two-arg', ['--verbose=2', '--avcodec-hw', 'none', '--file-logging', '--logfile=.tmp-diag/hw-twoarg.log']],
  ['colon',   ['--verbose=2', '--file-logging', '--logfile=.tmp-diag/hw-colon.log']],
];
(async () => {
  for (const [tag, args] of VARIANTS) {
    const hwnd = playerMod.createHostWindow({ title: tag, width: 640, height: 360, visible: false });
    const p = new playerMod.KtvPlayer({ vlcArgs: args });
    p.attachSurface(hwnd);
    p.load(FILE, { accomp: 2 });
    if (tag === 'colon') {
      // 媒体级选项（和 demux 一样的位置）
      const { addMediaOption } = require('../src/vlc-ffi');
      addMediaOption(p.media, ':avcodec-hw=none');
    }
    p.play();
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) { if (p.currentTime() > 3000) break; await sleep(300); }
    await sleep(1200);
    p.dispose(); playerMod.destroyHostWindow(hwnd);
    await sleep(400);
  }
  console.log('done'); process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });