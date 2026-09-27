'use strict';
const playerMod = require('@ktv/player');
const vlc = require('@ktv/player/src/vlc-ffi');
const ktvApi = require('@ktv/ktv-api');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const r = await ktvApi.resolvePlayUrl({ musicNo: '7789715', filename: '7789715.ts' });
  const hwnd = playerMod.createHostWindow({ title: 's4', width: 800, height: 450 });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(hwnd);
  player.load(r.url, { accomp: 2, isStream: true });
  player.play();
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (player.currentTime() > 300) break; await sleep(100); }
  await sleep(6000);
  console.log('getStats ->', JSON.stringify(vlc.getStats(player.mp)));
  player.dispose(); playerMod.destroyHostWindow(hwnd);
})();
