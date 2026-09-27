'use strict';
const assert = require('assert');
const path = require('path');
const registry = require(path.resolve(__dirname, '..', 'src', 'providers', 'platform-registry'));
const qq = require(path.resolve(__dirname, '..', 'src', 'providers', 'platforms', 'qq'));
const kugou = require(path.resolve(__dirname, '..', 'src', 'providers', 'platforms', 'kugou'));
const migu = require(path.resolve(__dirname, '..', 'src', 'providers', 'platforms', 'migu'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  [PASS] ' + name); pass++; }
  catch (e) { console.log('  [FAIL] ' + name + ' - ' + e.message); fail++; }
}

console.log('');
console.log('在线平台注册表与解析');
t('平台列表固定为五个来源', () => {
  const ids = registry.listPlatforms().map((x) => x.id).sort();
  assert.deepStrictEqual(ids, ['kugou', 'kuwo', 'migu', 'netease', 'qq']);
});
t('QQ/酷狗/咪咕标记需要登录', () => {
  const map = Object.fromEntries(registry.listPlatforms().map((x) => [x.id, x]));
  assert.strictEqual(map.qq.needsAuth, true);
  assert.strictEqual(map.kugou.needsAuth, true);
  assert.strictEqual(map.migu.needsAuth, true);
  assert.strictEqual(map.netease.needsAuth, false);
});
t('QQ 搜索条目解析', () => {
  const s = qq.parseSong({ mid: '0039MnYb0qxYhV', title: '晴天', singer: [{ name: '周杰伦' }], interval: 269, album: { mid: '002iWKlh2DcjFL', name: '叶惠美' }, mv: { vid: 'g0090J2cwr9' } });
  assert.strictEqual(s.platform, 'qq');
  assert.strictEqual(s.id, '0039MnYb0qxYhV');
  assert.strictEqual(s.artist, '周杰伦');
  assert.strictEqual(s.hasMv, true);
  assert.ok(s.cover.startsWith('https://'));
});
t('酷狗搜索条目解析', () => {
  const s = kugou.parseSong({ hash: 'b3a52a7a958bf0aed0ebfba2e9a818b7', songname: '晴天', singername: '周杰伦', duration: 269, mvhash: 'abc', image: 'http://img/{size}.jpg' });
  assert.strictEqual(s.platform, 'kugou');
  assert.strictEqual(s.id, 'b3a52a7a958bf0aed0ebfba2e9a818b7');
  assert.strictEqual(s.hasMv, true);
  assert.strictEqual(s.cover, 'https://img/300.jpg');
});
t('咪咕搜索条目解析', () => {
  const s = migu.parseSong({ copyrightId: '60054701923', name: '晴天', singers: [{ name: '周杰伦' }], mvList: [{ copyrightId: 'mv-1' }], imgItems: [{ img: '//img.example/cover.jpg' }] });
  assert.strictEqual(s.platform, 'migu');
  assert.strictEqual(s.id, '60054701923');
  assert.strictEqual(s.mvId, 'mv-1');
  assert.ok(s.cover.startsWith('https://'));
});
t('无凭证解析播放地址返回需要登录', async () => {
  const fakeFetch = async () => ({ ok: true, text: async () => JSON.stringify({ req_0: { data: { midurlinfo: [{ purl: '' }], sip: [] } } }) });
  const r = await qq.resolveAudio('0039MnYb0qxYhV', { fetch: fakeFetch }, { cookie: '' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'AUTH_REQUIRED');
});
console.log('');
console.log('在线平台测试：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
