/**
 * 多曲目流畅度抽查
 * ================
 * 逐首播放并测量，找出"哪些歌卡"——如果是普遍现象说明环境问题，
 * 如果集中在个别歌曲/CDN，说明是片源问题。
 *
 * 用法: node test/diag-multi.js
 */
'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const playerMod = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(__dirname, '..', '..', '..');

async function measure(song, seconds = 8) {
  const musicNo = String(song.filename).replace(/\.[^.]+$/, '');
  const resolved = await ktvApi.resolvePlayUrl({ musicNo, filename: song.filename, name: song.name });

  const hwnd = playerMod.createHostWindow({ title: 'multi', width: 800, height: 450 });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(hwnd);
  player.load(resolved.url, { accomp: 2, isStream: true });
  player.play();

  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (player.currentTime() > 300) break; await sleep(100); }

  const samples = [];
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
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
  const host = (() => { try { return new URL(resolved.url).hostname; } catch { return '?'; } })();

  player.dispose();
  playerMod.destroyHostWindow(hwnd);

  return {
    rate: mediaTotal / wallTotal, stalls, longest,
    size: `${st.videoSize.width}x${st.videoSize.height}`,
    tracks: st.tracks.length, host,
  };
}

(async () => {
  const db = new DatabaseSync(path.join(REPO, 'resources', 'catalog', 'muse.db'), { readOnly: true });
  const songs = db.prepare('SELECT name, filename FROM songs WHERE deleted_at IS NULL ORDER BY rec_score DESC, local_hot_score DESC, hot_score DESC LIMIT 6').all();

  let bad = 0;
  for (const s of songs) {
    try {
      const r = await measure(s);
      const verdict = r.stalls === 0 ? '流畅' : r.stalls <= 2 ? '轻微' : '卡顿';
      if (r.stalls > 2) bad++;
      console.log(`${verdict.padEnd(4)} ${s.name.slice(0, 16).padEnd(18)} ${r.rate.toFixed(2)}x  停顿${r.stalls}  最长${r.longest}ms  ${r.size}  ${r.tracks}轨  ${r.host}`);
    } catch (e) {
      bad++;
      console.log(`FAIL ${s.name.slice(0, 16).padEnd(18)} ${e.message.slice(0, 60)}`);
    }
  }
  console.log(`\n结果: ${songs.length - bad} 首流畅 / ${bad} 首有问题`);
  process.exit(0);
})();
