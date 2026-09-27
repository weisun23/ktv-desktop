'use strict';
const path = require('path');
const playerMod = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = 'process.env.KTV_TEST_FILE || 'testmedia/sample.ts'';

async function probe(label, source, opts) {
  const hwnd = playerMod.createHostWindow({ title: label, width: 1002, height: 505 });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(hwnd);
  const t0 = Date.now();
  player.load(source, opts);
  player.play();
  let firstVout = null, firstTime = null;
  while (Date.now() - t0 < 20000) {
    const st = player.getStatus();
    if (!firstVout && st.hasVout) firstVout = Date.now() - t0;
    if (!firstTime && st.time > 0) firstTime = Date.now() - t0;
    if (firstVout && firstTime) break;
    await sleep(100);
  }
  await sleep(3000);
  const st = player.getStatus();
  console.log(`[${label}]`);
  console.log(`  source      : ${String(source).slice(0, 90)}`);
  console.log(`  isStream    : ${st.isStream}`);
  console.log(`  firstVout   : ${firstVout ?? 'TIMEOUT'} ms`);
  console.log(`  firstTime   : ${firstTime ?? 'TIMEOUT'} ms`);
  console.log(`  time        : ${st.time} ms`);
  console.log(`  playing     : ${st.playing}   state=${st.state}`);
  console.log(`  videoSize   : ${st.videoSize.width}x${st.videoSize.height}`);
  console.log(`  tracks      : ${st.tracks.length}`);
  console.log(`  lastError   : ${st.lastError || '-'}`);
  player.dispose();
  playerMod.destroyHostWindow(hwnd);
  await sleep(500);
}

(async () => {
  await probe('LOCAL', LOCAL, { accomp: 0 });
  const r = await ktvApi.resolvePlayUrl({ musicNo: '7789715', filename: '7789715.ts', name: 't' });
  await probe('ONLINE', r.url, { accomp: 0, isStream: true });
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
