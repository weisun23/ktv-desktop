/** 布局诊断：加载构建产物，量出各容器实际宽度，定位是谁把页面撑宽了 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: false });
  await win.loadFile(path.join(REPO, 'apps', 'web', 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const info = await win.webContents.executeJavaScript(`(() => {
    const q = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left),
        display: cs.display, cols: cs.gridTemplateColumns,
        minW: cs.minWidth, overflow: cs.overflow,
      };
    };
    return {
      viewport: { inner: window.innerWidth, body: document.body.scrollWidth, doc: document.documentElement.scrollWidth },
      app: q('#app'), appChild: q('#app > .app'),
      main: q('.main'), left: q('.left'), stage: q('.stage'), right: q('.right'),
      controls: q('.controls'),
    };
  })()`);

  console.log(JSON.stringify(info, null, 2));
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
