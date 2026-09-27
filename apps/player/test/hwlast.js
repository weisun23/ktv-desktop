'use strict';
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = '.tmp-diag/nomws.ts';
(async () => {
  // 把 avcodec-hw 放到最后一个参数，看是不是参数传递被截断
  const log = '.tmp-diag/hw-last.log';
  const hwnd = playerMod.createHostWindow({ title: 'hw', width: 640, height: 360, visible: false });
  const player = new playerMod.KtvPlayer({ vlcArgs: ['--verbose=2', '--file-logging', '--logfile=' + log, '--avcodec-hw=none'] });
  player.attachSurface(hwnd);
  player.load(FILE, { accomp: 2 });
  player.play();
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (player.currentTime() > 3000) break; await sleep(300); }
  await sleep(1500);
  player.dispose(); playerMod.destroyHostWindow(hwnd);
  console.log('done');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });