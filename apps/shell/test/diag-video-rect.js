/**
 * 视频子窗口对齐诊断
 * ==================
 * 量出：渲染进程的 CSS 像素 vs Win32 物理像素 的换算关系，
 * 以及原生视频子窗口的实际位置尺寸是否和界面上报的视频区一致。
 */
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const { createRequire } = require('module');
const koffi = createRequire(require.resolve('@ktv/player'))('koffi');
const { VideoSurface } = require('@ktv/player');

const REPO = path.resolve(__dirname, '..', '..', '..');
const user32 = koffi.load('user32.dll');
const GetWindowRect = user32.func('int GetWindowRect(void *h, void *r)');
const RECT = koffi.struct('RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
function rectOf(hwnd) {
  const buf = Buffer.alloc(16);
  GetWindowRect(hwnd, buf);
  const r = koffi.decode(buf, RECT);
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: false });
  await win.loadFile(path.join(REPO, 'apps', 'web', 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));

  const disp = screen.getPrimaryDisplay();
  const bounds = win.getBounds();
  const content = win.getContentBounds();
  const buf = win.getNativeWindowHandle();
  const parentHwnd = process.arch === 'x64' ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));

  const dom = await win.webContents.executeJavaScript(`(() => {
    const st = document.querySelector('.video-stage');
    const right = document.querySelector('.right');
    const r1 = st ? st.getBoundingClientRect() : null;
    const r2 = right ? right.getBoundingClientRect() : null;
    return {
      dpr: window.devicePixelRatio,
      innerW: window.innerWidth, innerH: window.innerHeight,
      stage: r1 ? { x: Math.round(r1.left), y: Math.round(r1.top), w: Math.round(r1.width), h: Math.round(r1.height) } : null,
      right: r2 ? { x: Math.round(r2.left), w: Math.round(r2.width) } : null,
    };
  })()`);

  console.log('=== 渲染进程（CSS 像素）===');
  console.log('devicePixelRatio =', dom.dpr, ' innerWidth =', dom.innerW, ' innerHeight =', dom.innerH);
  console.log('视频区 rect  =', JSON.stringify(dom.stage));
  console.log('右栏 rect    =', JSON.stringify(dom.right));
  console.log('');
  console.log('=== Electron（DIP）===');
  console.log('window bounds   =', JSON.stringify(bounds));
  console.log('content bounds  =', JSON.stringify(content));
  console.log('display scale   =', disp.scaleFactor, ' size =', JSON.stringify(disp.size));
  console.log('');
  console.log('=== Win32（物理像素）===');
  const pr = rectOf(parentHwnd);
  console.log('父窗口 rect     =', JSON.stringify(pr));

  // 用 1.5 倍换算视频区，看会不会越界
  const s = disp.scaleFactor;
  const scaled = {
    x: Math.round(dom.stage.x * s), y: Math.round(dom.stage.y * s),
    w: Math.round(dom.stage.w * s), h: Math.round(dom.stage.h * s),
  };
  console.log('视频区 x1.5 后  =', JSON.stringify(scaled), ' 右边缘 =', scaled.x + scaled.w);
  console.log('父窗口宽度      =', pr.w, ' 右栏起点(物理) =', Math.round(dom.right.x * s));
  console.log('');
  console.log('结论: ' + (scaled.x + scaled.w > Math.round(dom.right.x * s)
    ? '视频窗口会盖住右栏 ❌' : '不重叠 ✅'));
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
