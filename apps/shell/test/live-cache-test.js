/**
 * 缓存链路端到端验证（真实网络）
 * ==============================
 * 验证"点过的歌自动缓存到本地，下次不用重新下载"：
 *   1. 在线取流播放 -> 后台自动缓存
 *   2. 缓存完成后文件落地、无 .part 残留
 *   3. 再次点同一首 -> 走本地文件，不再请求接口
 *
 * 用临时目录，不污染真实缓存。
 * 用法: node test/live-cache-test.js [musicNo]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ktvApi = require('@ktv/ktv-api');
const { DownloadManager } = require('../src/downloads');
const { resolveLocalMedia } = require('../src/library');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, step = 300) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = pred(); if (v) return v; await sleep(step); }
  return null;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  return !!ok;
}

async function main() {
  const cfg = ktvApi.loadConfig();
  if (!ktvApi.availableProviders(cfg).length) {
    console.log('未配置取流 provider，跳过缓存链路验证。');
    return 0;
  }

  const musicNo = process.argv[2] || '7789715';
  const filename = `${musicNo}.ts`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-cache-'));
  console.log(`临时缓存目录: ${dir}\n`);

  const song = { id: 'cache-test', name: '缓存测试', filename, musicNo };

  // ── 1. 在线解析（模拟点歌时的取流） ──
  const resolved = await ktvApi.resolvePlayUrl(song);
  check('在线取流成功', !!resolved.url, resolved.url.slice(0, 80));
  check('本地此时还没有缓存', resolveLocalMedia(dir, filename) === null);

  // ── 2. 后台缓存 ──
  const dm = new DownloadManager({
    mediaRoot: dir,
    resolveUrl: (s) => ktvApi.resolvePlayUrl(s),
  }).init();
  const enq = dm.enqueue(song);
  check('自动入队缓存', enq.queued === true, enq.reason || '');

  const done = await waitFor(() => dm.list().find((t) => t.filename === filename)?.state === 'done', 180000, 500);
  const task = dm.list().find((t) => t.filename === filename);
  check('缓存完成', !!done, `state=${task?.state} ${task?.error || ''}`);

  const full = path.join(dir, filename);
  const size = fs.existsSync(full) ? fs.statSync(full).size : 0;
  check('缓存文件已落盘', size > 0, `${(size / 1024 / 1024).toFixed(1)} MB`);
  check('无 .part 残留', !fs.existsSync(full + '.part'));

  // ── 3. 再次点歌应走本地 ──
  const localPath = resolveLocalMedia(dir, filename);
  check('再次点歌命中本地缓存', localPath === full, localPath || '未命中');

  // ── 4. 已缓存不重复下载 ──
  const again = dm.enqueue(song);
  check('已缓存不重复下载', again.queued === false && again.reason === 'ALREADY_CACHED', again.reason);

  const st = dm.stats();
  check('缓存统计正确', st.count === 1 && st.bytes === size, `${st.count} 个 / ${(st.bytes / 1024 / 1024).toFixed(1)} MB`);

  fs.rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`缓存链路验证失败 ${failed.length}/${results.length} 项`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    return 1;
  }
  console.log(`缓存链路验证全部通过（${results.length} 项）`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error('异常:', e); process.exit(1); });
