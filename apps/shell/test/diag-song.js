/**
 * 单曲播放诊断
 * ============
 * 按歌名或 musicNo 找歌、取流、播放，并输出流畅度数据。
 * 卡的时候跑这个，把输出发出来即可定位。
 *
 * 用法:
 *   npm run diag -- "歌名"
 *   npm run diag -- 7789715
 */
'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const playerMod = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');

const REPO = path.resolve(__dirname, '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.log('用法: npm run diag -- "歌名"   或   npm run diag -- <musicNo>');
    return 1;
  }
  const secsArg = process.argv.find((a) => a.startsWith('--seconds='));
  const seconds = secsArg ? Number(secsArg.split('=')[1]) : 15;

  const db = new DatabaseSync(path.join(REPO, 'resources', 'catalog', 'muse.db'), { readOnly: true });
  let song;
  if (/^\d+$/.test(query)) {
    song = db.prepare('SELECT name, filename FROM songs WHERE deleted_at IS NULL AND filename LIKE ? LIMIT 1')
      .get(`${query}.%`);
  } else {
    song = db.prepare('SELECT name, filename FROM songs WHERE deleted_at IS NULL AND name LIKE ? ORDER BY hot_score DESC LIMIT 1')
      .get(`%${query}%`);
  }
  if (!song) { console.log(`曲库里找不到: ${query}`); return 1; }

  const musicNo = String(song.filename).replace(/\.[^.]+$/, '');
  console.log(`曲目: ${song.name}  (musicNo=${musicNo})`);

  const t0 = Date.now();
  const resolved = await ktvApi.resolvePlayUrl({ musicNo, filename: song.filename, name: song.name });
  console.log(`取流: ${Date.now() - t0}ms  ls=${resolved.ls}`);
  console.log(`地址: ${resolved.url}`);
  console.log(`有效期至: ${resolved.expiresAt ? new Date(resolved.expiresAt).toISOString() : '未知'}`);

  const hwnd = playerMod.createHostWindow({ title: 'diag', width: 1002, height: 505 });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(hwnd);

  const tPlay = Date.now();
  player.load(resolved.url, { accomp: 2, isStream: true });
  player.play();

  let firstFrame = null;
  while (Date.now() - tPlay < 40000) {
    const st = player.getStatus();
    if (st.hasVout && st.time > 0) { firstFrame = Date.now() - tPlay; break; }
    await sleep(100);
  }
  const st0 = player.getStatus();
  console.log(`\n起播: ${firstFrame ?? '超时'}ms`);
  console.log(`视频: ${st0.videoSize.width}x${st0.videoSize.height}   音轨: ${st0.tracks.length} 条`);

  const samples = [];
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    samples.push({ wall: Date.now(), time: player.currentTime() });
    await sleep(100);
  }

  let stalls = 0, run = 0, longest = 0;
  const deltas = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].time - samples[i - 1].time;
    const wall = samples[i].wall - samples[i - 1].wall;
    deltas.push(d);
    if (d < 50) { run += wall; longest = Math.max(longest, run); } else { if (run >= 600) stalls++; run = 0; }
  }
  const wallTotal = (samples.at(-1).wall - samples[0].wall) / 1000;
  const mediaTotal = (samples.at(-1).time - samples[0].time) / 1000;

  console.log(`\n采样 ${samples.length} 次 / ${wallTotal.toFixed(1)}s`);
  console.log(`时间轴推进 ${mediaTotal.toFixed(1)}s => ${(mediaTotal / wallTotal).toFixed(2)}x`);
  console.log(`真停顿(>600ms): ${stalls} 次   最长 ${longest}ms`);
  console.log(`增量样本: ${deltas.slice(0, 20).join(' ')}`);
  console.log(`判定: ${stalls === 0 ? '流畅' : stalls <= 2 ? '轻微卡顿' : '明显卡顿'}`);

  player.dispose();
  playerMod.destroyHostWindow(hwnd);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error('异常:', e); process.exit(1); });
