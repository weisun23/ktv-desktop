/**
 * 卡顿诊断：量起播耗时、实际播放速率、视频输出模块
 * 用法: node test/diag-lag.js [musicNo]
 */
'use strict';

const { KtvPlayer, VideoSurface, createHostWindow, destroyHostWindow } = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const musicNo = process.argv[2] || '7789715';
  const cfg = ktvApi.loadConfig();
  if (!ktvApi.availableProviders(cfg).length) { console.log('未配置 provider'); return 1; }

  const t0 = Date.now();
  const r = await ktvApi.resolvePlayUrl({ musicNo, filename: `${musicNo}.ts` });
  console.log(`取地址: ${Date.now() - t0}ms`);
  console.log(`URL: ${r.url}\n`);

  const hwnd = createHostWindow({ title: 'lag diag', width: 1002, height: 505 });
  const surface = new VideoSurface(hwnd, { scaleFactor: 1 });
  surface.setBounds({ x: 0, y: 0, width: 1002, height: 505 });

  const player = new KtvPlayer();
  player.attachSurface(surface.handle());

  const tPlay = Date.now();
  player.load(r.url, { accomp: 2, isStream: true });
  player.play();

  // 起播耗时
  let firstFrameAt = null;
  while (Date.now() - tPlay < 40000) {
    const st = player.getStatus();
    if (st.hasVout && st.time > 0) { firstFrameAt = Date.now() - tPlay; break; }
    await sleep(100);
  }
  console.log(`起播耗时（play -> 首帧）: ${firstFrameAt ?? '超时'} ms`);

  // 播放速率：采样 12 秒，看时间轴推进了多少
  await sleep(1500);
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const st = player.getStatus();
    samples.push({ wall: Date.now(), time: st.time, state: st.stateName });
    await sleep(1000);
  }
  const first = samples[0], last = samples[samples.length - 1];
  const wallDelta = (last.wall - first.wall) / 1000;
  const mediaDelta = (last.time - first.time) / 1000;
  console.log(`\n播放速率: 真实 ${wallDelta.toFixed(1)}s 内时间轴推进 ${mediaDelta.toFixed(1)}s`
    + `  => ${(mediaDelta / wallDelta).toFixed(2)}x`);
  console.log(`时间轴采样: ${samples.map((s) => (s.time / 1000).toFixed(1)).join(' ')}`);
  console.log(`状态采样:   ${[...new Set(samples.map((s) => s.state))].join(',')}`);

  const st = player.getStatus();
  console.log(`\n视频尺寸: ${st.videoSize.width}x${st.videoSize.height}`);
  console.log(`音轨数: ${st.tracks.length}`);

  player.dispose(); surface.destroy(); destroyHostWindow(hwnd);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
