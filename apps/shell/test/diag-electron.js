/**
 * Electron 环境内的播放流畅度诊断
 * ==============================
 * 前面的诊断都跑在纯 Node 进程里，而用户实际用的是 Electron。
 * 差异在于：libVLC 的 D3D11 输出与 Chromium 的 GPU/合成器同进程共存。
 *
 * 用法: electron . --diag-smooth [musicNo]
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const { KtvPlayer, VideoSurface } = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const idx = process.argv.indexOf('--diag-smooth');
  const musicNo = (process.argv[idx + 1] && !process.argv[idx + 1].startsWith('-'))
    ? process.argv[idx + 1] : '7789715';

  const win = new BrowserWindow({
    width: 1200, height: 700, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadURL('data:text/html,<h1>diag</h1>');
  await sleep(500);

  const hwndBuf = win.getNativeWindowHandle();
  const parentHwnd = process.arch === 'x64' ? hwndBuf.readBigUInt64LE(0) : BigInt(hwndBuf.readUInt32LE(0));
  const surface = new VideoSurface(parentHwnd, { scaleFactor: 1 });
  surface.setBounds({ x: 0, y: 0, width: 1000, height: 560 });

  const resolved = await ktvApi.resolvePlayUrl({ musicNo, filename: `${musicNo}.ts` });
  console.log(`片源: ${resolved.url.slice(0, 88)}`);

  const player = new KtvPlayer();
  player.attachSurface(surface.handle());
  player.load(resolved.url, { accomp: 2, isStream: true });
  player.play();

  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    if (player.currentTime() > 300) break;
    await sleep(100);
  }

  const samples = [];
  const start = Date.now();
  while (Date.now() - start < 15000) {
    samples.push({ wall: Date.now(), time: player.currentTime() });
    await sleep(100);
  }

  let stalls = 0, run = 0, longest = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].time - samples[i - 1].time;
    const wall = samples[i].wall - samples[i - 1].wall;
    if (d < 50) { run += wall; longest = Math.max(longest, run); }
    else { if (run >= 600) stalls++; run = 0; }
  }
  const wallTotal = (samples.at(-1).wall - samples[0].wall) / 1000;
  const mediaTotal = (samples.at(-1).time - samples[0].time) / 1000;

  console.log(`Electron 内播放: ${mediaTotal.toFixed(1)}s / ${wallTotal.toFixed(1)}s => ${(mediaTotal / wallTotal).toFixed(2)}x`);
  console.log(`真停顿(>600ms): ${stalls} 次   最长: ${longest}ms`);
  console.log(`判定: ${stalls === 0 ? '流畅' : stalls <= 2 ? '轻微卡顿' : '明显卡顿'}`);

  player.dispose();
  surface.destroy();
  app.exit(stalls <= 2 ? 0 : 2);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
