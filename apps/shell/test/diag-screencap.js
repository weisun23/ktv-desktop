/** 在真实应用布局里播放视频，然后抓真实屏幕（不是 PrintWindow） */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const playerMod = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: true });
  await win.loadFile(path.join(REPO, 'apps', 'web', 'dist', 'index.html'));
  await sleep(2500);

  const rect = await win.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('.video-stage').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);

  const buf = win.getNativeWindowHandle();
  const parent = process.arch === 'x64' ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  const surface = new playerMod.VideoSurface(parent, { scaleFactor: 1.5 });
  surface.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  surface.show();

  const r = await ktvApi.resolvePlayUrl({ musicNo: '7789715', filename: '7789715.ts' });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(surface.handle());
  player.load(r.url, { accomp: 2, isStream: true });
  player.play();

  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (player.currentTime() > 2000) break; await sleep(200); }
  await sleep(3000);

  console.log('播放位置:', player.currentTime(), 'ms   hasVout:', player.getStatus().hasVout,
    ' 尺寸:', player.getStatus().videoSize.width + 'x' + player.getStatus().videoSize.height);

  // 抓真实屏幕（DPI 感知）
  const ps = 'path.join(process.env.TEMP || '.', 'ktv-screen.ps1')';
  try { execFileSync('pwsh', ['-NoProfile', '-File', ps], { timeout: 60000 }); console.log('屏幕截图已保存'); }
  catch (e) { console.log('截图失败:', e.message); }

  player.dispose(); surface.destroy();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
