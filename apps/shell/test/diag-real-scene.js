/**
 * 真实场景流畅度测试
 * ==================
 * 之前的测试都是「隐藏窗口 + 空页面」，而用户实际是「可见窗口 + 完整界面 + 子窗口」。
 * 这个测试复现真实场景：可见窗口、加载真实前端、原生子窗口承载视频。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const playerMod = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');

const REPO = path.resolve(__dirname, '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: true });
  await win.loadFile(path.join(REPO, 'apps', 'web', 'dist', 'index.html'));
  await sleep(2000);

  // 按真实布局取视频区
  const rect = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.video-stage');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  console.log('视频区(CSS):', JSON.stringify(rect));

  const buf = win.getNativeWindowHandle();
  const parentHwnd = process.arch === 'x64' ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  const surface = new playerMod.VideoSurface(parentHwnd, { scaleFactor: 1.5 });
  surface.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  surface.show();

  const r = await ktvApi.resolvePlayUrl({ musicNo: '7789715', filename: '7789715.ts' });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(surface.handle());
  player.load(r.url, { accomp: 2, isStream: true });
  player.play();

  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (player.currentTime() > 300) break; await sleep(100); }

  const samples = [];
  const start = Date.now();
  while (Date.now() - start < 20000) {
    samples.push({ wall: Date.now(), time: player.currentTime() });
    await sleep(100);
  }
  let stalls = 0, run = 0, longest = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].time - samples[i - 1].time;
    const wall = samples[i].wall - samples[i - 1].wall;
    if (d < 50) { run += wall; longest = Math.max(longest, run); } else { if (run >= 600) stalls++; run = 0; }
  }
  const wallTotal = (samples.at(-1).wall - samples[0].wall) / 1000;
  const mediaTotal = (samples.at(-1).time - samples[0].time) / 1000;
  const st = player.getStatus();
  console.log('=== 真实场景（可见窗口 + 完整界面 + 子窗口）===');
  console.log('时间轴推进:', mediaTotal.toFixed(1) + 's / ' + wallTotal.toFixed(1) + 's => ' + (mediaTotal / wallTotal).toFixed(2) + 'x');
  console.log('真停顿(>600ms):', stalls, ' 最长:', longest + 'ms');
  console.log('视频尺寸:', st.videoSize.width + 'x' + st.videoSize.height);
  console.log('判定:', stalls === 0 ? '流畅' : stalls <= 2 ? '轻微卡顿' : '明显卡顿');
  player.dispose(); surface.destroy();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
