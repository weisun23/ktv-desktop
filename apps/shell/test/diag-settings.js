/** 设置弹窗渲染验证：加载应用 -> 点设置按钮 -> 截图 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false });
  await win.loadFile(path.join(REPO, 'apps', 'web', 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  // 点开设置
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.gear');
    if (!b) return 'no gear button';
    b.click();
    return 'clicked';
  })()`);

  await new Promise((r) => setTimeout(r, 1200));

  const state = await win.webContents.executeJavaScript(`(() => {
    const dlg = document.querySelector('.dlg');
    const secs = [...document.querySelectorAll('.dlg section h3')].map(h => h.textContent.trim());
    const rows = [...document.querySelectorAll('.dlg .row label')].map(l => l.textContent.trim()).filter(Boolean);
    return { gear: !!document.querySelector('.gear'), dialogOpen: !!dlg, sections: secs, rowLabels: rows };
  })()`);

  console.log('click:', clicked);
  console.log(JSON.stringify(state, null, 1));

  // 截图
  const img = await win.webContents.capturePage();
  const fs = require('fs');
  const out = path.join(process.env.TEMP, 'ktv-settings.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('screenshot:', out);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
