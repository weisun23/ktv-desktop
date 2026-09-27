/** 纯 node + koffi + libVLC：独立顶层窗口播放，完全脱离 Electron/Chromium */
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const playerMod = require('@ktv/player');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const LOCAL = arg('file', 'process.env.KTV_TEST_FILE || 'testmedia/sample.ts'');
const TAG = arg('tag', 'host');

(async () => {
  const vlcArgs = [];
  if (arg('vout', '')) vlcArgs.push('--vout=' + arg('vout', ''));
  if (arg('log', '')) vlcArgs.push('--verbose=2', '--file-logging', '--logfile=' + arg('log', ''));
  if (arg('demux', '')) vlcArgs.push('--demux=' + arg('demux', ''));
  console.log('vlcArgs =', JSON.stringify(vlcArgs), ' file =', path.basename(LOCAL));

  let src = LOCAL;
  if (arg('musicno', '')) {
    const ktvApi = require('@ktv/ktv-api');
    const r = await ktvApi.resolvePlayUrl({ musicNo: arg('musicno', ''), filename: arg('musicno', '') + '.ts' });
    src = r.url;
    console.log('resolved online url, ls =', r.ls);
  }
  const hwnd = playerMod.createHostWindow({ title: 'KTV host probe', width: 1200, height: 700, visible: true });
  playerMod.showHostWindow(hwnd);
  const player = new playerMod.KtvPlayer({ vlcArgs });
  player.attachSurface(hwnd);
  player.load(src, { accomp: 2 });
  player.play();

  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (player.currentTime() > 4000) break; await sleep(200); }
  await sleep(2000);
  const st = player.getStatus();
  console.log('time =', st.time, ' vout =', st.hasVout, ' size =', st.videoSize.width + 'x' + st.videoSize.height);

  execFileSync('pwsh', ['-NoProfile', '-File', 'path.join(process.env.TEMP || '.', 'ktv-screen.ps1')'], { timeout: 60000 });
  const out = path.join('.tmp-diag', 'shot-' + TAG + '.png');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(process.env.TEMP, 'ktv-screen.png'), '-vf', 'scale=1024:-1', out]);
  console.log('shot saved:', out);

  player.dispose();
  playerMod.destroyHostWindow(hwnd);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
