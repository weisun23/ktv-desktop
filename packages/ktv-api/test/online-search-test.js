'use strict';
const assert = require('assert');
const p = require('E:/project/ktv-desktop/packages/ktv-api/src/providers/online-search.js');
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  [PASS] ' + name); pass++; }
  catch (e) { console.log('  [FAIL] ' + name + ' - ' + e.message); fail++; }
}
(async () => {
  console.log('');
  console.log('在线搜索：封面与 MV 专用搜索（联网）');
  let songRes = null, mvRes = null;
  // 先探一次：没网就整体跳过，别让 npm test 在离线环境下变红
  songRes = await p.searchNetease('海阔天空', { pageSize: 5 });
  if (!songRes.ok && /fetch failed|timeout|ENOTFOUND|EAI_AGAIN|network/i.test(songRes.error || '')) {
    console.log('  [SKIP] 连不上网易云，跳过联网测试（' + songRes.error + '）');
    process.exit(0);
  }
  await t('搜歌返回结果', async () => {
    assert.strictEqual(songRes.ok, true, songRes.error);
    assert.ok(songRes.songs.length > 0);
  });
  await t('搜歌结果带封面且是 https', async () => {
    const withCover = songRes.songs.filter((s) => s.cover);
    assert.ok(withCover.length > 0, '一条封面都没有');
    assert.ok(withCover.every((s) => s.cover.startsWith('https://')), '封面 URL 应为 https');
  });
  await t('搜歌结果字段完整', async () => {
    const s = songRes.songs[0];
    for (const k of ['platform', 'id', 'title', 'artist', 'duration', 'hasMv']) {
      assert.ok(s[k] !== undefined, '缺字段 ' + k);
    }
  });
  await t('MV 专用搜索返回结果', async () => {
    mvRes = await p.searchNeteaseMv('海阔天空', { pageSize: 5 });
    assert.strictEqual(mvRes.ok, true, mvRes.error);
    assert.ok(mvRes.songs.length > 0);
  });
  await t('MV 结果都标了 hasMv 且带 mvId', async () => {
    assert.ok(mvRes.songs.every((s) => s.hasMv === true && s.mvId), '有 MV 没标 hasMv/mvId');
  });
  await t('MV 结果带封面', async () => {
    assert.ok(mvRes.songs.filter((s) => s.cover).length > 0, 'MV 一条封面都没有');
  });
  await t('MV 的 id 能直接取到播放地址', async () => {
    const r = await p.resolveMvUrl(mvRes.songs[0].mvId);
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(/^https?:\/\//.test(r.url), '地址不对: ' + r.url);
  });
  await t('空关键词给出可读错误', async () => {
    const a = await p.searchNetease('   ');
    const b = await p.searchNeteaseMv('');
    assert.ok(!a.ok && /搜索词/.test(a.error), a.error);
    assert.ok(!b.ok && /搜索词/.test(b.error), b.error);
  });
  console.log('');
  console.log('在线搜索测试：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
