'use strict';
/** 切原唱/伴唱后，音频还回得来吗 */
const playerMod = require('../src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = process.argv[2];
(async () => {
  const hwnd = playerMod.createHostWindow({ title: 'sw', width: 800, height: 450, visible: false });
  const player = new playerMod.KtvPlayer({ vlcArgs: ['--avcodec-hw=none'] });
  player.attachSurface(hwnd);
  player.load(FILE, { accomp: 2 });
  player.play();
  let t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (player.currentTime() > 1200) break; await sleep(300); }
  player.seek(100000);
  const d = Date.now() + 25000;
  while (Date.now() < d) { if (player.currentTime() > 101000) break; await sleep(300); }
  await sleep(1500);

  const snap = () => { const s = player.getStatus(); const st = s.stats || {};
    return { t: s.time, pb: st.i_played_abuffers, da: st.i_decoded_audio, st: s.stateName, trk: s.currentTrack, vol: s.volume }; };

  const before = snap();
  console.log(`切换前: 位置=${(before.t/1000).toFixed(1)}s 播放音频块=${before.pb} 音轨=${before.trk} 音量=${before.vol} 状态=${before.st}`);

  console.log('\n>>> 切到「伴唱」');
  player.setVocalMode('accompaniment');
  let prev = before;
  for (let i = 1; i <= 12; i++) {
    await sleep(1000);
    const s = snap();
    console.log(`  +${i}s 位置=${(s.t/1000).toFixed(1)}s 音频块=${s.pb} (+${s.pb - prev.pb}) 解码音频=${s.da} (+${s.da - prev.da}) 音轨=${s.trk} 状态=${s.st}`);
    prev = s;
  }

  console.log('\n>>> 切回「原唱」');
  player.setVocalMode('original');
  for (let i = 1; i <= 12; i++) {
    await sleep(1000);
    const s = snap();
    console.log(`  +${i}s 位置=${(s.t/1000).toFixed(1)}s 音频块=${s.pb} (+${s.pb - prev.pb}) 解码音频=${s.da} (+${s.da - prev.da}) 音轨=${s.trk} 状态=${s.st}`);
    prev = s;
  }
  player.dispose(); playerMod.destroyHostWindow(hwnd);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });