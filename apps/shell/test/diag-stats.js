'use strict';
const { createRequire } = require('module');
const playerMod = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const r = await ktvApi.resolvePlayUrl({ musicNo: '7789715', filename: '7789715.ts' });
  const hwnd = playerMod.createHostWindow({ title: 'stats', width: 1002, height: 505 });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(hwnd);
  player.load(r.url, { accomp: 2, isStream: true });
  player.play();
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (player.currentTime() > 300) break; await sleep(100); }
  await sleep(15000);
  const st = player.getStatus();
  console.log('视频尺寸:', st.videoSize.width + 'x' + st.videoSize.height);
  console.log('时间轴:', (st.time / 1000).toFixed(1) + 's');
  if (st.stats) {
    console.log('解码视频帧:', st.stats.i_decoded_video);
    console.log('显示帧:', st.stats.i_displayed_pictures);
    console.log('丢帧:', st.stats.i_lost_pictures, '  <-- 卡顿的硬指标');
    console.log('数据损坏:', st.stats.i_demux_corrupted);
    console.log('输入码率:', st.stats.f_input_bitrate.toFixed(2), 'kbps');
  } else console.log('stats 不可用');
  player.dispose();
  playerMod.destroyHostWindow(hwnd);
})();
