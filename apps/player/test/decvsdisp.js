'use strict';
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (const [tag, file] of [['原始文件', '.tmp-diag/nomws.ts'], ['remux后', '.tmp-diag/R.ts']]) {
    const hwnd = playerMod.createHostWindow({ title: tag, width: 800, height: 450, visible: false });
    const p = new playerMod.KtvPlayer({ softwareDecode: true });
    p.attachSurface(hwnd);
    p.load(file, { accomp: 2 });
    p.play();
    let t0 = Date.now();
    while (Date.now() - t0 < 20000) { if (p.currentTime() > 1500) break; await sleep(300); }
    const a = p.getStatus(); const s0 = Date.now();
    await sleep(25000);
    const b = p.getStatus();
    const dw = (Date.now() - s0) / 1000;
    const d = (k) => (b.stats?.[k] || 0) - (a.stats?.[k] || 0);
    console.log(`[${tag}] ${dw.toFixed(0)}s  解码视频 ${d('i_decoded_video')} (${(d('i_decoded_video')/dw).toFixed(1)}fps)  显示 ${d('i_displayed_pictures')} (${(d('i_displayed_pictures')/dw).toFixed(1)}fps)  丢 ${d('i_lost_pictures')}`);
    console.log(`          解码音频 ${d('i_decoded_audio')}  播放音频 ${d('i_played_abuffers')}  丢音频 ${d('i_lost_abuffers')}  不连续 ${d('i_demux_discontinuity')}`);
    p.dispose(); playerMod.destroyHostWindow(hwnd);
    await sleep(500);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });