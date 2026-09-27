/** 量原生视频子窗口的【真实】Win32 矩形，和预期位置对比 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { createRequire } = require('module');
const koffi = createRequire(require.resolve('@ktv/player'))('koffi');
const playerMod = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');

const REPO = path.resolve(__dirname, '..', '..', '..');
const user32 = koffi.load('user32.dll');
const GetWindowRect = user32.func('int GetWindowRect(void *h, void *r)');
const GetClientRect = user32.func('int GetClientRect(void *h, void *r)');
const IsWindowVisible = user32.func('int IsWindowVisible(void *h)');
const GetParent = user32.func('void *GetParent(void *h)');
const RECT = koffi.struct('RECT2', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const rectOf = (h) => { const b = Buffer.alloc(16); GetWindowRect(h, b); const r = koffi.decode(b, RECT);
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: true });
  await win.loadFile(path.join(REPO, 'apps', 'web', 'dist', 'index.html'));
  await sleep(2000);

  const rect = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.video-stage');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);

  const buf = win.getNativeWindowHandle();
  const parentHwnd = process.arch === 'x64' ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  const surface = new playerMod.VideoSurface(parentHwnd, { scaleFactor: 1.5 });
  surface.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  surface.show();
  await sleep(500);

  const parentRect = rectOf(parentHwnd);
  const childRect = rectOf(surface.handle());
  console.log('父窗口(物理)   =', JSON.stringify(parentRect));
  console.log('视频区(CSS)    =', JSON.stringify(rect));
  console.log('期望(×1.5)     =', JSON.stringify({ x: rect.x * 1.5, y: rect.y * 1.5, w: rect.w * 1.5, h: rect.h * 1.5 }));
  console.log('子窗口实际     =', JSON.stringify(childRect));
  console.log('子窗口可见     =', IsWindowVisible(surface.handle()) !== 0);
  console.log('父窗口是父级   =', GetParent(surface.handle()) === parentHwnd);
  console.log('尺寸是否吻合   =', Math.abs(childRect.w - rect.w * 1.5) < 4 && Math.abs(childRect.h - rect.h * 1.5) < 4 ? '是 ✅' : '否 ❌');
  playerMod.destroyHostWindow(parentHwnd);
  surface.destroy();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
