/**
 * 曲库读取测试
 * ============
 * 对着真实的 muse.db（670k 曲目）跑，同时测量各查询耗时——
 * 曲库查询在点歌界面里是高频操作，性能必须可接受。
 *
 * 用法: node --experimental-sqlite --no-warnings test/db-test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { MuseCatalog } = require('../src/db');

const DB_PATH = process.env.KTV_CATALOG_DB
  || path.resolve(__dirname, '..', '..', '..', 'resources', 'catalog', 'muse.db');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  return !!ok;
}
function timed(label, fn) {
  const t0 = Date.now();
  const value = fn();
  const ms = Date.now() - t0;
  console.log(`        ${label.padEnd(34)} ${String(ms).padStart(5)}ms`);
  return { value, ms };
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`找不到曲库: ${DB_PATH}\n请先执行: npm --prefix services/catalog run install:db -- --manifest <清单> --target resources/catalog`);
    process.exit(1);
  }
  console.log(`曲库: ${DB_PATH}  (${(fs.statSync(DB_PATH).size / 1024 / 1024 / 1024).toFixed(2)} GB)\n`);

  const cat = new MuseCatalog(DB_PATH).open();
  check('打开只读曲库', cat.isOpen);

  const { value: stats } = timed('stats()', () => cat.stats());
  check('统计信息', stats.songs > 600000 && stats.singers > 100000,
    `${stats.songs} 首 / ${stats.singers} 位歌手 / ${stats.songsWithCloudUrl} 首带 cloud_url`);

  const { value: langs } = timed('languages()', () => cat.languages());
  check('语种字典', langs.length >= 6, langs.join('、'));

  const { value: hotPage, ms: hotMs } = timed('hotSongs(20)', () => cat.hotSongs({ limit: 20 }));
  const hot = hotPage.songs;
  check('热歌榜', hot.length === 20 && !!hot[0].name, `首条: ${hot[0]?.name} - ${hot[0]?.singer}`);
  check('热歌榜性能 < 300ms', hotMs < 300, `${hotMs}ms`);

  // 歌名搜索
  const { value: namePage, ms: nameMs } = timed('searchSongs("爱")', () => cat.searchSongs({ keyword: '爱', limit: 20 }));
  const byName = namePage.songs;
  check('按歌名搜索', byName.length > 0, `${byName.length} 条, hasMore=${namePage.hasMore}, 例: ${byName[0]?.name} - ${byName[0]?.singer}`);
  check('歌名搜索性能 < 800ms', nameMs < 800, `${nameMs}ms`);

  // 歌手名搜索（走关联表）
  const { value: singerPage } = timed('searchSongs("周杰伦")', () => cat.searchSongs({ keyword: '周杰伦', limit: 20 }));
  const bySinger = singerPage.songs;
  check('按歌手名搜索', bySinger.length > 0 && bySinger.some((s) => s.singer.includes('周杰伦')),
    `${bySinger.length} 条, 例: ${bySinger[0]?.name} - ${bySinger[0]?.singer}`);

  // 拼音首字母
  const sample = hot[0];
  if (sample && sample.name) {
    const cap = (sample.name || '').slice(0, 1);
    const { value: capPage } = timed(`searchSongs(中文关键词)`, () => cat.searchSongs({ keyword: sample.name.slice(0, 2), limit: 10 }));
    const byCap = capPage.songs;
    check('按中文关键词命中', byCap.length > 0, `"${sample.name.slice(0,2)}" -> ${byCap.length} 条`);
  }

  // 语种筛选
  const { value: yuePage } = timed('searchSongs(粤语)', () => cat.searchSongs({ keyword: '爱', lang: '粤语', limit: 10 }));
  const yue = yuePage.songs;
  check('语种筛选', yue.every((s) => s.lang === '粤语'), `${yue.length} 条`);

  // 分页总数
  // countSearch 很慢（全表 COUNT），只验证它能工作，不放进点歌热路径
  const { value: total, ms: countMs } = timed('countSearch("爱") [慢, 不推荐]', () => cat.countSearch('爱'));
  check('搜索结果总数（慢查询可用）', total > 0, `${total} 条, ${countMs}ms`);

  // 单曲
  const { value: one } = timed('songById()', () => cat.songById(hot[0].id));
  check('按 id 取单曲', one && one.id === hot[0].id, `${one?.name} / accomp=${one?.accomp}`);

  // 批量取：收藏/歌单/已唱列表用。逐个 songById 的话 200 首要 200 次往返。
  const ids = hot.slice(0, 8).map((s) => s.id);
  const { value: many, ms: manyMs } = timed('songsByIds(8)', () => cat.songsByIds(ids));
  check('批量取曲目返回同样条数', many.length === ids.length, many.length + ' 条 / ' + manyMs + 'ms');
  check('批量取保持传入顺序', many.every((s, i) => s.id === ids[i]), many.map((s) => s.name).join(' / '));
  check('批量取会跳过不存在的 id', cat.songsByIds([ids[0], 'no-such-id-xxx', ids[1]]).length === 2);
  check('批量取空数组 / null 返回空', cat.songsByIds([]).length === 0 && cat.songsByIds(null).length === 0);
  check('批量取 600 个 id 也不报错（内部分批查）',
    Array.isArray(cat.songsByIds(Array.from({ length: 600 }, (_, i) => ids[i % ids.length]))));

  // 首字母索引：13 万歌手靠搜索不现实，A-Z 一按就到
  {
    const { value: letters, ms: lettersMs } = timed('singerLetters()', () => cat.singerLetters());
    check('首字母分布有 A-Z', letters.filter((l) => /^[A-Z]$/.test(l.letter)).length === 26,
      letters.length + ' 个桶 / ' + lettersMs + 'ms');
    check('分布按字母升序', letters.slice(0, 26).every((l, i) => l.letter === String.fromCharCode(65 + i)));
    check('每个桶都有数量', letters.every((l) => typeof l.count === 'number' && l.count >= 0));
    const total = letters.reduce((a, l) => a + l.count, 0);
    check('各桶之和接近歌手总数', total > 100000, total + ' 位');

    const { value: zs, ms: zMs } = timed("singers({letter:'Z'})", () => cat.singers({ letter: 'Z', limit: 20 }));
    check('按字母筛选能取到歌手', zs.length === 20, zs.length + ' 位 / ' + zMs + 'ms');
    check('筛出来的确实是该字母开头',
      zs.every((s) => (s.nameCap || '').toUpperCase().startsWith('Z')),
      zs.slice(0, 3).map((s) => s.name + '(' + s.nameCap + ')').join(', '));

    // 接口对 limit 有上限（clampPage 卡在 200），所以这里只能验"取满且全是 Z"
    const zCount = letters.find((l) => l.letter === 'Z').count;
    const { value: allZ } = timed("singers({letter:'Z', limit:100000})", () => cat.singers({ letter: 'Z', limit: 100000 }));
    check('筛选能取满上限且全是该字母', allZ.length === 200 && allZ.every((s) => s.nameCap.startsWith('Z')),
      allZ.length + ' 位（该字母共 ' + zCount + ' 位）');

    check('非法字母不筛选（当没传）', cat.singers({ letter: '??', limit: 5 }).length === 5);
  }

  // 字母索引：筛选后计数要跟着变，否则点进去是空的
  {
    const all = cat.singerLetters();
    const hk = cat.singerLetters({ area: '港台' });
    const allTotal = all.reduce((a, l) => a + l.count, 0);
    const hkTotal = hk.reduce((a, l) => a + l.count, 0);
    check('带筛选的字母分布总数变小', hkTotal > 0 && hkTotal < allTotal,
      '全部 ' + allTotal + ' -> 港台 ' + hkTotal);

    const hkFemale = cat.singerLetters({ area: '港台', type: '女' });
    const hkfTotal = hkFemale.reduce((a, l) => a + l.count, 0);
    check('地区+类型叠加筛选再变小', hkfTotal > 0 && hkfTotal < hkTotal,
      '港台 ' + hkTotal + ' -> 港台女 ' + hkfTotal);

    // 分布计数必须和真实列表条数一致（这是这套筛选最容易出错的地方）
    const zBucket = hk.find((l) => l.letter === 'Z').count;
    const zList = cat.singers({ area: '港台', letter: 'Z', limit: 200 });
    check('分布计数与列表条数一致（港台 Z）', zList.length === Math.min(200, zBucket),
      '列表 ' + zList.length + ' vs 分布 ' + zBucket);
    check('筛出来的确实都是港台', zList.every((s) => s.area === '港台'));
    check('筛出来的确实都是 Z 开头', zList.every((s) => s.nameCap.startsWith('Z')));
  }

  // 歌手头像：曲库里只存文件名，URL 要拼 CDN 前缀
  {
    const url = cat.singerImageUrl('ip1_singer_image_1030');
    check('头像 URL 拼上了 CDN 前缀', url.startsWith('https://') && url.includes('ip1_singer_image_1030'), url);
    check('头像 URL 没有双斜杠', !url.replace('https://', '').includes('//'), url);
    check('头像 URL 带七牛处理参数', url.includes('imageView2'), url);
    check('空 image 返回空串', cat.singerImageUrl('') === '' && cat.singerImageUrl(null) === '');
    check('已经是完整 URL 就原样返回',
      cat.singerImageUrl('https://x.cn/a.jpg') === 'https://x.cn/a.jpg');
    check('本地绝对路径原样返回', cat.singerImageUrl('/data/a.jpg') === '/data/a.jpg');

    const withImg = cat.singers({ limit: 20 }).filter((s) => s.imageUrl);
    check('列表里带 imageUrl 字段', withImg.length > 0, withImg.length + '/20 位有头像');
    check('CDN 根地址从 global_confs 读，末尾只有一个斜杠',
      cat.cdnPath().endsWith('/') && !cat.cdnPath().endsWith('//'), cat.cdnPath());
  }

  // 歌手
  const { value: singers } = timed('singers("周杰伦")', () => cat.singers({ keyword: '周杰伦', limit: 10 }));
  check('歌手检索', singers.length > 0, `${singers.length} 位, 例: ${singers[0]?.name} (${singers[0]?.area}/${singers[0]?.type})`);

  if (singers.length) {
    const { value: songs } = timed('songsBySinger()', () => cat.songsBySinger(singers[0].id, { limit: 20 }));
    // songsBySinger 返回数组
    check('按歌手取歌', songs.length > 0, `${songs.length} 首`);
  }

  const { value: areas } = timed('singerAreas()', () => cat.singerAreas());
  check('歌手地区字典', areas.length > 0, areas.join('、'));

  cat.close();

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`曲库测试失败 ${failed.length}/${results.length} 项`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
  console.log(`曲库测试全部通过（${results.length} 项）`);
}

main();
