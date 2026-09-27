'use strict';
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  console.log('display:', JSON.stringify({ size: d.size, workArea: d.workArea, scaleFactor: d.scaleFactor }));
  const win = new BrowserWindow({ width: 1280, height: 800, show: false });
  await win.loadFile(path.join(REPO, 'apps', 'web', 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1000));
  console.log('bounds(DIP):', JSON.stringify(win.getBounds()));
  console.log('contentBounds(DIP):', JSON.stringify(win.getContentBounds()));
  const v = await win.webContents.executeJavaScript(`({ dpr: window.devicePixelRatio, innerW: window.innerWidth, screenW: window.screen.width })`);
  console.log('renderer:', JSON.stringify(v));
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
