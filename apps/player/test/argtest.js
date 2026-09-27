'use strict';
/** 验证我们传给 libVLC 的参数是否真的生效：用 --no-audio 做探针 */
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = '.tmp-diag/nomws.ts';
(async () => {
  for (const extra of [[], ['--no-audio'], ['--avcodec-hw=none']]) {
    const hwnd = playerMod.createHostWindow({ title: 'argtest', width: 640, height: 360, visible: false });
    const player = new playerMod.KtvPlayer({ vlcArgs: extra });
    player.attachSurface(hwnd);
    player.load(FILE, { accomp: 2 });
    player.play();
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) { if (player.currentTime() > 4000) break; await sleep(300); }
    await sleep(2000);
    const s = player.getStatus();
    console.log(`vlcArgs=${JSON.stringify(extra)}  →  播放音频块=${s.stats?.i_played_abuffers}  显示帧=${s.stats?.i_displayed_pictures}  音轨数=${s.tracks.length}`);
    player.dispose(); playerMod.destroyHostWindow(hwnd);
    await sleep(600);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });