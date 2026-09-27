'use strict';
const { createRequire } = require('module');
const koffi = createRequire(require.resolve('@ktv/player'))('koffi');
const playerMod = require('@ktv/player');
const vlc = require('@ktv/player/src/vlc-ffi');
const ktvApi = require('@ktv/ktv-api');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const r = await ktvApi.resolvePlayUrl({ musicNo: '7789715', filename: '7789715.ts' });
  const hwnd = playerMod.createHostWindow({ title: 'stats3', width: 800, height: 450 });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(hwnd);
  player.load(r.url, { accomp: 2, isStream: true });
  player.play();
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (player.currentTime() > 300) break; await sleep(100); }
  await sleep(8000);

  console.log('vlc.getStats 存在:', typeof vlc.getStats);
  const st = vlc.getStats(player.mp);
  console.log('结果:', st === null ? 'null（rc 非 0 或抛异常）' : JSON.stringify(st));
  player.dispose();
  playerMod.destroyHostWindow(hwnd);
})();
