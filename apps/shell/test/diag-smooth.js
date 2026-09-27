/**
 * 播放流畅度诊断
 * ==============
 * 光看"总时长/总时间"会被平均掉，看不出卡顿。这里每 100ms 采一次时间轴，
 * 统计停顿次数与最长停顿——这才是"卡"的真实度量。
 *
 * 用法:
 *   node test/diag-smooth.js [musicNo] [--cache=1500] [--download] [--child] [--seconds=20]
 */
'use strict';

const path = require('path');
const { createRequire } = require('module');
const koffi = createRequire(require.resolve('@ktv/player'))('koffi');
const playerMod = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');
const { DownloadManager } = require('../src/downloads');

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const flag = (name) => process.argv.includes(`--${name}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const musicNo = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '7789715';
  const cacheMs = Number(arg('cache', 1500));
  const seconds = Number(arg('seconds', 20));
  const withDownload = flag('download');
  const useChild = flag('child');

  const cfg = ktvApi.loadConfig();
  if (!ktvApi.availableProviders(cfg).length) { console.log('未配置 provider'); return 1; }

  const resolved = await ktvApi.resolvePlayUrl({ musicNo, filename: `${musicNo}.ts` });
  console.log(`片源: ${resolved.url.slice(0, 88)}`);
  console.log(`参数: network-caching=${cacheMs}ms  并发下载=${withDownload}  子窗口=${useChild}\n`);

  let parent = null, surface = null, hwnd;
  if (useChild) {
    parent = koffi.load('user32.dll').func(
      'void *CreateWindowExW(uint32, const char16_t *, const char16_t *, uint32, int, int, int, int, void *, void *, void *, void *)'
    )(0, 'Static', 'smooth', 0x00cf0000, 60, 60, 1100, 620, null, null, null, null);
    surface = new playerMod.VideoSurface(parent, { scaleFactor: 1 });
    surface.setBounds({ x: 0, y: 0, width: 1002, height: 505 });
    hwnd = surface.handle();
  } else {
    hwnd = playerMod.createHostWindow({ title: 'smooth', width: 1002, height: 505 });
  }

  const player = new playerMod.KtvPlayer({ vlcArgs: [`--network-caching=${cacheMs}`] });
  player.attachSurface(hwnd);
  player.load(resolved.url, { accomp: 2, isStream: true });

  let dm = null;
  if (withDownload) {
    const os = require('os'), fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-smooth-'));
    dm = new DownloadManager({ mediaRoot: dir, resolveUrl: (s) => ktvApi.resolvePlayUrl(s) }).init();
  }

  player.play();
  if (dm) dm.enqueue({ id: 'x', name: 'x', filename: `${musicNo}.ts`, musicNo });

  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    if (player.currentTime() > 300) break;
    await sleep(100);
  }

  const samples = [];
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    // 采样必须用轻量读取——用 getStatus() 会自己把播放搞卡，测出来的是测量误差
    samples.push({ wall: Date.now(), time: player.currentTime() });
    await sleep(100);
  }

  // 实测 libvlc_media_player_get_time 约每 300ms 才更新一次，
  // 所以 <600ms 的"没推进"是上报粒度，不能算卡顿。只有 >600ms 才是真停顿。
  const REAL_STALL_MS = 600;
  let stalls = 0, longest = 0, run = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].time - samples[i - 1].time;
    const wall = samples[i].wall - samples[i - 1].wall;
    if (d < 50) { run += wall; if (run > longest) longest = run; }
    else { if (run >= REAL_STALL_MS) stalls++; run = 0; }
  }
  if (run >= REAL_STALL_MS) stalls++;
  const wallTotal = (samples.at(-1).wall - samples[0].wall) / 1000;
  const mediaTotal = (samples.at(-1).time - samples[0].time) / 1000;

  // 打印增量分布，区分"量化误差"和"真卡顿"
  const deltas = [];
  for (let i = 1; i < samples.length; i++) deltas.push(samples[i].time - samples[i - 1].time);
  const buckets = { '<50': 0, '50-150': 0, '150-300': 0, '>=300': 0 };
  for (const d of deltas) {
    if (d < 50) buckets['<50']++;
    else if (d < 150) buckets['50-150']++;
    else if (d < 300) buckets['150-300']++;
    else buckets['>=300']++;
  }
  console.log(`增量分布: ${Object.entries(buckets).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  console.log(`前 30 个增量: ${deltas.slice(0, 30).join(' ')}`);

  console.log(`采样 ${samples.length} 次 / ${wallTotal.toFixed(1)}s`);
  console.log(`时间轴推进: ${mediaTotal.toFixed(1)}s  => ${(mediaTotal / wallTotal).toFixed(2)}x`);
  console.log(`停顿次数: ${stalls}   最长停顿: ${longest}ms`);
  console.log(`真停顿(>${REAL_STALL_MS}ms): ${stalls} 次`);
  console.log(`判定: ${stalls === 0 ? '流畅' : stalls <= 2 ? '轻微卡顿' : '明显卡顿'}`);

  player.dispose();
  if (surface) surface.destroy();
  playerMod.destroyHostWindow(useChild ? parent : hwnd);
  return stalls < 5 ? 0 : 2;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
