'use strict';
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = 'process.env.KTV_TEST_FILE || 'testmedia/sample.ts'';
(async () => {
  const hwnd = playerMod.createHostWindow({ title: 'end', width: 800, height: 450, visible: false });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(hwnd);
  player.load(FILE, { accomp: 2 });
  player.play();
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (player.currentTime() > 1500) break; await sleep(300); }
  player.seek(228000);
  const d = Date.now() + 25000;
  while (Date.now() < d) { if (player.currentTime() > 229000) break; await sleep(300); }
  await sleep(1200);
  const a = player.getStatus();
  const s0 = Date.now();
  const rows = [];
  while (Date.now() - s0 < 14000) {
    const st = player.getStatus();
    rows.push({ t: st.time, st: st.stateName, dp: st.stats?.i_displayed_pictures, pb: st.stats?.i_played_abuffers, lb: st.stats?.i_lost_abuffers });
    await sleep(1000);
  }
  const b = player.getStatus();
  const dw = (b.time - a.time) / 1000;
  const dd = (k) => (b.stats?.[k] || 0) - (a.stats?.[k] || 0);
  console.log(`末尾 ${(a.time/1000).toFixed(0)}s→${(b.time/1000).toFixed(0)}s  推进 ${dw.toFixed(1)}s  状态=${b.stateName}`);
  console.log(`  显示帧 ${dd('i_displayed_pictures')} (${(dd('i_displayed_pictures')/dw).toFixed(1)}fps)  丢帧 ${dd('i_lost_pictures')}`);
  console.log(`  播放音频块 ${dd('i_played_abuffers')}  丢音频块 ${dd('i_lost_abuffers')}  解码音频 ${dd('i_decoded_audio')}`);
  console.log('  逐秒: ' + rows.map(r => `${(r.t/1000).toFixed(0)}s/${r.st}`).join(' '));
  player.dispose(); playerMod.destroyHostWindow(hwnd);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });