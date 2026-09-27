'use strict';
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = '.tmp-diag/nomws.ts';
(async () => {
  const cases = [
    ['none', ['--avcodec-hw=none']],
    ['noopt', []],
    ['zero', ['--avcodec-hw=0']],
    ['d3d11va', ['--avcodec-hw=d3d11va']],
  ];
  for (const [tag, extra] of cases) {
    const log = `.tmp-diag/hw-${tag}.log`;
    const hwnd = playerMod.createHostWindow({ title: 'hw', width: 640, height: 360, visible: false });
    const player = new playerMod.KtvPlayer({ vlcArgs: [...extra, '--verbose=2', '--file-logging', '--logfile=' + log] });
    player.attachSurface(hwnd);
    player.load(FILE, { accomp: 2 });
    player.play();
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) { if (player.currentTime() > 3000) break; await sleep(300); }
    await sleep(1500);
    player.dispose(); playerMod.destroyHostWindow(hwnd);
    await sleep(400);
  }
  console.log('done');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });