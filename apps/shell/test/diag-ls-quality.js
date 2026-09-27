'use strict';
/** 对比 maidong 不同 ls（线路）返回的片源质量：解复用不连续 / 丢帧 / 实际帧率 */
const playerMod = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');
const { MaidongProvider } = require('@ktv/ktv-api/src/providers/maidong');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MUSICNO = process.argv[2] || '7789715';
const SECONDS = Number(process.argv[3] || 12);

async function measure(url, label) {
  const hwnd = playerMod.createHostWindow({ title: 'ls probe', width: 800, height: 450, visible: false });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(hwnd);
  player.load(url, { accomp: 2, isStream: true });
  player.play();
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) { if (player.currentTime() > 4000) break; await sleep(300); }
  const first = player.getStatus();
  const s0 = Date.now();
  while (Date.now() - s0 < SECONDS * 1000) await sleep(500);
  const last = player.getStatus();
  const dw = (last.time - first.time) / 1000;
  const st = last.stats || {};
  const st0 = first.stats || {};
  const d = (k) => (st[k] || 0) - (st0[k] || 0);
  console.log(`[${label}] 状态=${last.stateName} 媒体推进=${dw.toFixed(1)}s`);
  console.log(`   显示帧 ${d('i_displayed_pictures')}  丢帧 ${d('i_lost_pictures')}  解复用损坏 ${d('i_demux_corrupted')}  不连续 ${d('i_demux_discontinuity')}`);
  console.log(`   -> 显示帧率 ${(d('i_displayed_pictures') / dw).toFixed(1)}fps   丢帧率 ${(d('i_lost_pictures') / dw).toFixed(2)}fps   不连续 ${(d('i_demux_discontinuity') / dw * 60).toFixed(1)}次/分`);
  player.dispose(); playerMod.destroyHostWindow(hwnd);
  await sleep(500);
}

(async () => {
  const cfg = ktvApi.loadConfig();
  const p = new MaidongProvider(cfg.maidong || {});
  const hosts = p.config.hosts || [];
  for (const host of hosts.slice(0, 1)) {
    let token;
    try { token = await p.getToken(host); } catch (e) { console.log(`${host} 取 token 失败: ${e.message}`); continue; }
    if (!token) { console.log(`${host} 取 token 被拒`); continue; }
    for (const ls of [0, 1, 2]) {
      let url;
      try { url = await p._fetchUrl(host, MUSICNO, token, ls); } catch (e) { console.log(`ls=${ls} 取地址失败: ${e.message}`); continue; }
      if (!url) { console.log(`ls=${ls} 无地址`); continue; }
      console.log(`\n--- ls=${ls}  ${String(url).split('/').slice(-1)[0].slice(0, 40)} ---`);
      try { await measure(url, `ls=${ls}`); } catch (e) { console.log(`   播放失败: ${e.message}`); }
    }
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });