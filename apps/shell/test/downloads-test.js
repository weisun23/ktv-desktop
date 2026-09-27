/**
 * 缓存下载管理器测试（本地 HTTP 服务，不联网）
 * 用法: node test/downloads-test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { DownloadManager } = require('../src/downloads');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(50); }
  return false;
}

/** 假片源服务：可指定大小、是否返回错误 */
function startServer({ bytes = 200000, fail = false, delay = 0 } = {}) {
  const server = http.createServer(async (req, res) => {
    if (fail) { res.writeHead(500); return res.end('boom'); }
    if (delay) await sleep(delay);
    res.writeHead(200, { 'Content-Type': 'video/MP2T', 'Content-Length': String(bytes) });
    const chunk = Buffer.alloc(8192, 7);
    let sent = 0;
    while (sent < bytes) {
      const n = Math.min(chunk.length, bytes - sent);
      if (!res.write(chunk.subarray(0, n))) await new Promise((r) => res.once('drain', r));
      sent += n;
    }
    res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-dl-'));

  // ── 1. 正常下载 ──
  {
    const { server, port } = await startServer({ bytes: 200000 });
    const progress = [];
    const dm = new DownloadManager({
      mediaRoot: dir,
      resolveUrl: async () => ({ url: `http://127.0.0.1:${port}/song.ts` }),
      onProgress: (t) => progress.push(t.state),
    }).init();

    const r = dm.enqueue({ id: 's1', name: '测试歌', filename: 's1.ts' });
    check('入队成功', r.queued === true);

    const done = await waitFor(() => dm.list()[0]?.state === 'done');
    check('下载完成', done, `state=${dm.list()[0]?.state}`);

    const f = path.join(dir, 's1.ts');
    check('文件已落盘且大小正确', fs.existsSync(f) && fs.statSync(f).size === 200000,
      fs.existsSync(f) ? `${fs.statSync(f).size} bytes` : '文件不存在');
    check('没有残留 .part', !fs.existsSync(f + '.part'));
    check('进度回调有 downloading/done', progress.includes('downloading') && progress.includes('done'));

    // ── 2. 已缓存不重复下载 ──
    const again = dm.enqueue({ id: 's1', name: '测试歌', filename: 's1.ts' });
    check('已缓存则跳过', again.queued === false && again.reason === 'ALREADY_CACHED', again.reason);
    check('isDownloaded 为真', dm.isDownloaded('s1.ts') === true);

    const st = dm.stats();
    check('缓存统计', st.count === 1 && st.bytes === 200000, `${st.count} 个 / ${st.bytes} bytes`);
    server.close();
  }

  // ── 3. 下载失败要清理 ──
  {
    const { server, port } = await startServer({ fail: true });
    const dm = new DownloadManager({
      mediaRoot: dir, resolveUrl: async () => ({ url: `http://127.0.0.1:${port}/bad.ts` }),
    }).init();
    dm.enqueue({ id: 'bad', name: '坏片源', filename: 'bad.ts' });
    const failed = await waitFor(() => dm.list().find((t) => t.filename === 'bad.ts')?.state === 'failed');
    check('失败被记录', failed, dm.list().find((t) => t.filename === 'bad.ts')?.error);
    check('失败后不留 .part', !fs.existsSync(path.join(dir, 'bad.ts.part')));
    check('失败后不产生正式文件', !fs.existsSync(path.join(dir, 'bad.ts')));
    server.close();
  }

  // ── 4. 启动时清理残留 .part ──
  {
    fs.writeFileSync(path.join(dir, 'stale.ts.part'), 'garbage');
    const dm = new DownloadManager({ mediaRoot: dir, resolveUrl: async () => ({ url: 'x' }) }).init();
    check('启动时清理残留 .part', !fs.existsSync(path.join(dir, 'stale.ts.part')));
  }

  // ── 5. 容量上限触发淘汰 ──
  {
    const { server, port } = await startServer({ bytes: 100000 });
    const dm = new DownloadManager({
      mediaRoot: dir,
      resolveUrl: async () => ({ url: `http://127.0.0.1:${port}/x.ts` }),
      maxCacheBytes: 250000,          // 只放得下 2 个（每个 100KB）
    }).init();

    for (const n of ['e1.ts', 'e2.ts', 'e3.ts']) {
      dm.enqueue({ id: n, name: n, filename: n });
      await waitFor(() => dm.list().find((t) => t.filename === n)?.state === 'done');
      await sleep(30);   // 让 mtime 有区分度
    }
    const st = dm.stats();
    check('超限后触发淘汰', st.bytes <= 250000, `当前 ${st.bytes} bytes / 上限 250000`);
    check('最早下载的被删', !fs.existsSync(path.join(dir, 'e1.ts')), 'e1.ts 应被淘汰');
    check('最新的保留', fs.existsSync(path.join(dir, 'e3.ts')));
    server.close();
  }

  // ── 6. 限速生效（后台缓存不能和播放抢带宽）──
  let throttledElapsed = 0;
  {
    const bytes = 400 * 1024;          // 400KB
    const rate = 200 * 1024;           // 限到 200KB/s -> 理论约 2s
    const { server, port } = await startServer({ bytes });
    const dm = new DownloadManager({
      mediaRoot: dir,
      resolveUrl: async () => ({ url: `http://127.0.0.1:${port}/throttle.ts` }),
      maxBytesPerSecond: rate,
    }).init();

    const t0 = Date.now();
    dm.enqueue({ id: 'th', name: 'th', filename: 'throttle.ts' });
    await waitFor(() => dm.list().find((t) => t.filename === 'throttle.ts')?.state === 'done', 20000);
    const elapsed = Date.now() - t0;
    throttledElapsed = elapsed;
    const theoretical = (bytes / rate) * 1000;

    check('限速生效（耗时接近理论值）', elapsed >= theoretical * 0.8,
      `实际 ${elapsed}ms / 理论 ${Math.round(theoretical)}ms`);
    check('限速后仍能完整下载', fs.existsSync(path.join(dir, 'throttle.ts'))
      && fs.statSync(path.join(dir, 'throttle.ts')).size === bytes);
    server.close();
  }

  // ── 7. 不限速（0）应明显更快 ──
  {
    const bytes = 400 * 1024;
    const { server, port } = await startServer({ bytes });
    const dm = new DownloadManager({
      mediaRoot: dir,
      resolveUrl: async () => ({ url: `http://127.0.0.1:${port}/fast.ts` }),
      maxBytesPerSecond: 0,
    }).init();
    const t0 = Date.now();
    dm.enqueue({ id: 'fast', name: 'fast', filename: 'fast.ts' });
    await waitFor(() => dm.list().find((t) => t.filename === 'fast.ts')?.state === 'done', 20000);
    const fastElapsed = Date.now() - t0;
    // 用相对比较而不是绝对阈值——机器忙时绝对耗时不可靠
    check('0 表示不限速（明显快于限速）', fastElapsed < throttledElapsed / 2,
      `不限速 ${fastElapsed}ms vs 限速 ${throttledElapsed}ms`);
    server.close();
  }

  // ── 缓存管理：列表 / 单曲删除 ──
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-cache-mgmt-'));
    fs.writeFileSync(path.join(dir2, 'a.ts'), Buffer.alloc(2048, 1));
    fs.writeFileSync(path.join(dir2, 'b.ts'), Buffer.alloc(4096, 2));
    fs.writeFileSync(path.join(dir2, 'a.accomp.ts'), Buffer.alloc(1024, 3));
    fs.writeFileSync(path.join(dir2, 'half.ts.part'), Buffer.alloc(512, 4));   // 半成品
    // 分离过程的中间产物：单个可能 50MB+，不该出现在缓存列表里
    fs.writeFileSync(path.join(dir2, 'x.accomp.src.wav'), Buffer.alloc(1024, 7));
    fs.writeFileSync(path.join(dir2, 'x.accomp.sep.wav'), Buffer.alloc(1024, 8));

    let playing = 'a.ts';
    const dm = new DownloadManager({
      mediaRoot: dir2,
      resolveUrl: async () => ({ url: 'http://127.0.0.1:1/x' }),
      currentFilename: () => playing,
    }).init();

    const files = dm.listFiles();
    check('缓存列表只列成品，不含 .part 和分离中间文件',
      files.length === 3 && !files.some((f) => f.filename.endsWith('.part') || /\.accomp\.(src|sep)\.wav$/.test(f.filename)),
      files.map((f) => f.filename).join(','));
    check('缓存列表带大小', files.find((f) => f.filename === 'b.ts')?.bytes === 4096);
    check('标出正在播放的那首', files.find((f) => f.filename === 'a.ts')?.playing === true);
    check('按时间倒序（最近在前）', files[0].mtime >= files[files.length - 1].mtime);

    check('正在播放的不让删', dm.removeFile('a.ts').ok === false && /正在播放/.test(dm.removeFile('a.ts').error));
    check('不存在的文件给出可读错误', dm.removeFile('nope.ts').ok === false);
    check('文件名里的路径分隔符会被剥掉', dm.removeFile('../evil.ts').ok === false, '不该越出缓存目录');

    const del = dm.removeFile('a.accomp.ts');
    check('能删普通文件', del.ok === true, del.error || '');
    check('删完列表里就没了', !dm.listFiles().some((f) => f.filename === 'a.accomp.ts'));

    // 删主文件时，同名分离伴奏要一起清掉，否则白占空间
    fs.writeFileSync(path.join(dir2, 'c.ts'), Buffer.alloc(1024, 5));
    fs.writeFileSync(path.join(dir2, 'c.accomp.ts'), Buffer.alloc(1024, 6));
    playing = 'b.ts';
    dm.removeFile('c.ts');
    check('删主文件时连带删掉它的分离伴奏',
      !fs.existsSync(path.join(dir2, 'c.ts')) && !fs.existsSync(path.join(dir2, 'c.accomp.ts')));

    // 启动时应该把上次异常退出留下的中间文件扫掉
    const dm2 = new DownloadManager({ mediaRoot: dir2, resolveUrl: async () => ({ url: 'http://127.0.0.1:1/x' }) }).init();
    check('启动时清理分离中间文件',
      !fs.existsSync(path.join(dir2, 'x.accomp.src.wav')) && !fs.existsSync(path.join(dir2, 'x.accomp.sep.wav')));
    check('清理不影响正常缓存文件', fs.existsSync(path.join(dir2, 'b.ts')));
    void dm2;

    fs.rmSync(dir2, { recursive: true, force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`下载管理测试失败 ${failed.length}/${results.length} 项`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
  console.log(`下载管理测试全部通过（${results.length} 项）`);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
