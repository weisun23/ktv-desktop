/** vout 后端对照探针：真实 Electron 窗口 + Static 子窗口 + libVLC 播本地文件，抓真实屏幕 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const playerMod = require('@ktv/player');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const LOCAL = arg('file', 'process.env.KTV_TEST_FILE || 'testmedia/sample.ts'');
const TAG = arg('tag', 'probe');

app.whenReady().then(async () => {
  const vlcArgs = [];
  if (arg('vout', '')) vlcArgs.push('--vout=' + arg('vout', ''));
  if (arg('dec', '')) vlcArgs.push('--avcodec-hw=' + arg('dec', ''));
  if (arg('demux', '')) vlcArgs.push('--demux=' + arg('demux', ''));
  if (arg('log', '')) vlcArgs.push('--verbose=2', '--file-logging', '--logfile=' + arg('log', ''));
  console.log('vlcArgs =', JSON.stringify(vlcArgs));

  const win = new BrowserWindow({ width: 1280, height: 800, show: true, backgroundColor: '#0b1016' });
  await win.loadFile(path.join(REPO, 'apps', 'web', 'dist', 'index.html'));
  win.show(); win.focus(); win.moveTop();
  await sleep(2500);

  const rect = await win.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('.video-stage').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  console.log('video rect (DIP) =', JSON.stringify(rect));

  const buf = win.getNativeWindowHandle();
  const parent = process.arch === 'x64' ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  const surface = new playerMod.VideoSurface(parent, { scaleFactor: Number(arg('scale', '1.5')) });
  surface.setBounds({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  surface.show();

  const player = new playerMod.KtvPlayer({ vlcArgs });
  player.attachSurface(surface.handle());
  player.load(LOCAL, { accomp: 2 });
  player.play();

  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (player.currentTime() > 4000) break; await sleep(200); }
  await sleep(2500);
  const st = player.getStatus();
  console.log('time =', st.time, 'ms  vout =', st.hasVout, ' size =', st.videoSize.width + 'x' + st.videoSize.height);

  win.moveTop(); win.focus();
  await sleep(800);
  const ps = 'path.join(process.env.TEMP || '.', 'ktv-screen.ps1')';
  execFileSync('pwsh', ['-NoProfile', '-File', ps], { timeout: 60000 });
  const out = path.join(REPO, '.tmp-diag', 'shot-' + TAG + '.png');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(process.env.TEMP, 'ktv-screen.png'), '-vf', 'scale=1024:-1', out]);
  console.log('shot saved:', out);

  player.dispose(); surface.destroy();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
