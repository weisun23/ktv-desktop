/**
 * 封面服务测试
 * ============
 * 曲库没有封面数据，封面是按歌名去网易云查的 —— 所以这套东西必须：
 *   - 查过一次就不再请求（否则每翻一页都重查）
 *   - 查不到也记一笔（否则每次翻回来都白试一遍）
 *   - 严格限速（一页 30 首，不限速会被风控）
 * 这里用假的 fetchCover，不联网。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CoverService } = require('../src/covers');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  [PASS] ' + name); pass++; }
  catch (e) { console.log('  [FAIL] ' + name + ' - ' + e.message); fail++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('');
  console.log('封面服务测试');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-covers-'));
  const cacheFile = path.join(dir, 'covers.json');

  await t('没缓存时 lookup 返回空，并把未知项入队', async () => {
    const calls = [];
    const svc = new CoverService({
      cacheFile,
      fetchCover: async (n, s) => { calls.push(n + '/' + s); return 'https://img/' + n + '.jpg'; },
    }).init();
    const known = svc.lookup([{ id: 'a', name: '阴天', singer: '莫文蔚' }]);
    assert.deepStrictEqual(known, {}, '第一次不该有已知封面');
    await sleep(600);
    assert.deepStrictEqual(calls, ['阴天/莫文蔚']);
    assert.strictEqual(svc.stats().count, 1);
  });

  await t('解析完会回调 onReady', async () => {
    const ready = [];
    const svc = new CoverService({
      cacheFile: path.join(dir, 'c2.json'),
      fetchCover: async () => 'https://img/x.jpg',
    }).init();
    svc.onReady = (id, url) => ready.push([id, url]);
    svc.lookup([{ id: 'z', name: '歌', singer: '' }]);
    await sleep(600);
    assert.deepStrictEqual(ready, [['z', 'https://img/x.jpg']]);
  });

  await t('第二次 lookup 直接命中，不再请求', async () => {
    const cacheFile2 = path.join(dir, 'c3.json');
    let calls = 0;
    const svc = new CoverService({
      cacheFile: cacheFile2,
      fetchCover: async () => { calls++; return 'https://img/a.jpg'; },
    }).init();
    svc.lookup([{ id: 'a', name: '歌A', singer: '' }]);
    await sleep(600);
    assert.strictEqual(calls, 1);
    const known = svc.lookup([{ id: 'a', name: '歌A', singer: '' }]);
    assert.deepStrictEqual(known, { a: 'https://img/a.jpg' }, '第二次应直接返回');
    await sleep(500);
    assert.strictEqual(calls, 1, '不该再发请求');
  });

  await t('查不到也记一笔（不重复重试）', async () => {
    let calls = 0;
    const svc = new CoverService({
      cacheFile: path.join(dir, 'c4.json'),
      fetchCover: async () => { calls++; return null; },
    }).init();
    svc.lookup([{ id: 'nope', name: '查不到的歌', singer: '' }]);
    await sleep(600);
    assert.strictEqual(calls, 1);
    const known = svc.lookup([{ id: 'nope', name: '查不到的歌', singer: '' }]);
    assert.deepStrictEqual(known, {}, '查不到就不返回 URL');
    await sleep(500);
    assert.strictEqual(calls, 1, '查不到也不该重复请求');
  });

  await t('同一首并发 lookup 只入队一次', async () => {
    let calls = 0;
    const svc = new CoverService({
      cacheFile: path.join(dir, 'c5.json'),
      fetchCover: async () => { calls++; return 'https://img/d.jpg'; },
    }).init();
    svc.lookup([{ id: 'd', name: '并发歌', singer: '' }]);
    svc.lookup([{ id: 'd', name: '并发歌', singer: '' }]);
    svc.lookup([{ id: 'd', name: '并发歌', singer: '' }]);
    await sleep(700);
    assert.strictEqual(calls, 1, '应只请求一次，实际 ' + calls);
  });

  await t('限速：多个请求之间有间隔', async () => {
    const stamps = [];
    const svc = new CoverService({
      cacheFile: path.join(dir, 'c6.json'),
      fetchCover: async () => { stamps.push(Date.now()); return 'https://img/e.jpg'; },
    }).init();
    svc.lookup([
      { id: 'r1', name: 'A', singer: '' },
      { id: 'r2', name: 'B', singer: '' },
      { id: 'r3', name: 'C', singer: '' },
    ]);
    await sleep(1600);
    assert.strictEqual(stamps.length, 3, '三次都应完成');
    const gap1 = stamps[1] - stamps[0];
    const gap2 = stamps[2] - stamps[1];
    assert.ok(gap1 >= 300 && gap2 >= 300, '间隔应 >= 300ms，实际 ' + gap1 + '/' + gap2);
  });

  await t('缓存落盘后新实例能直接命中', async () => {
    const f = path.join(dir, 'c7.json');
    let calls = 0;
    const s1 = new CoverService({ cacheFile: f, fetchCover: async () => { calls++; return 'https://img/f.jpg'; } }).init();
    s1.lookup([{ id: 'f1', name: '持久化', singer: '' }]);
    await sleep(600);
    await s1.save();
    const s2 = new CoverService({ cacheFile: f, fetchCover: async () => { calls++; return 'https://img/f2.jpg'; } }).init();
    assert.deepStrictEqual(s2.lookup([{ id: 'f1', name: '持久化', singer: '' }]), { f1: 'https://img/f.jpg' });
    assert.strictEqual(calls, 1, '不该再请求');
  });

  await t('fetchCover 抛错不会卡住队列', async () => {
    const svc = new CoverService({
      cacheFile: path.join(dir, 'c8.json'),
      fetchCover: async () => { throw new Error('网络炸了'); },
    }).init();
    svc.lookup([{ id: 'x1', name: '会失败', singer: '' }, { id: 'x2', name: '下一首', singer: '' }]);
    await sleep(1200);
    assert.strictEqual(svc.stats().queued, 0, '队列应清空');
    assert.strictEqual(svc.stats().count, 2, '失败也要记账，避免反复重试');
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('');
  console.log('封面服务测试：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
