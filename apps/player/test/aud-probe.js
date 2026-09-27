'use strict';
/** 跨过 ~110s，逐秒看音频块是否停止增长 */
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = process.argv[2];
(async () => {
  const hwnd = playerMod.createHostWindow({ title: 'aud', width: 800, height: 450, visible: false });
  const player = new playerMod.KtvPlayer({ vlcArgs: ['--avcodec-hw=none'] });
  player.attachSurface(hwnd);
  player.load(FILE, { accomp: 2 });
  player.play();
  let t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (player.currentTime() > 1200) break; await sleep(300); }
  player.seek(100000);
  const d = Date.now() + 25000;
  while (Date.now() < d) { if (player.currentTime() > 101000) break; await sleep(300); }
  await sleep(800);
  console.log('秒 | 媒体时间 | 播放音频块 | 解码音频 | 显示帧 | 状态');
  let prev = null;
  for (let i = 0; i < 28; i++) {
    const s = player.getStatus();
    const st = s.stats || {};
    const dPb = prev ? st.i_played_abuffers - prev.pb : 0;
    const dDa = prev ? st.i_decoded_audio - prev.da : 0;
    const dDp = prev ? st.i_displayed_pictures - prev.dp : 0;
    console.log(`${String(i).padStart(2)} | ${(s.time/1000).toFixed(1)}s | ${st.i_played_abuffers} (+${dPb}) | ${st.i_decoded_audio} (+${dDa}) | ${st.i_displayed_pictures} (+${dDp}) | ${s.stateName}`);
    prev = { pb: st.i_played_abuffers, da: st.i_decoded_audio, dp: st.i_displayed_pictures };
    await sleep(1000);
  }
  player.dispose(); playerMod.destroyHostWindow(hwnd);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });