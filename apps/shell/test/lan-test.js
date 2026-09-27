/**
 * 局域网手机点歌服务：单测
 * ==========================
 * 用假的 handler 起真实 HTTP 服务，测路由、参数、去重透传、端口回退。
 * 不需要曲库，也不碰真实用户状态。
 */
'use strict';

const assert = require('assert');
const { LanServer, lanAddresses, DEFAULT_PORT } = require('../src/lanserver');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  [PASS] ${name}`); pass++; }
  catch (e) { console.log(`  [FAIL] ${name} - ${e.message}`); fail++; }
}

function makeServer(port, overrides = {}) {
  const calls = [];
  const s = new LanServer({
    port,
    status: () => ({ song: { name: '测试歌' }, playing: true, time: 1000, length: 2000,
      volume: 80, hasNext: true,
      queue: [{ entryId: 'e1', songId: 's1', name: '测试歌', singer: '张三', status: 'playing' }] }),
    hot: async (opts) => { calls.push(['hot', opts]); return { songs: [{ id: 's1', name: '热歌' }], hasMore: false }; },
    search: async (opts) => { calls.push(['search', opts]); return { songs: [{ id: 's2', name: '搜到的' }], hasMore: true }; },
    order: async (songId, opts) => { calls.push(['order', songId, opts]); return { ok: true, startedImmediately: false, song: { id: songId } }; },
    removeEntry: async (entryId) => { calls.push(['remove', entryId]); return true; },
    control: async (action, value) => {
      calls.push(['control', action, value]);
      if (action === 'boom') throw new Error('播放器炸了');
      if (action === 'unknown') return { ok: false, error: '未知操作: unknown' };
      return { ok: true, action, value };
    },
    ...overrides,
  });
  return { s, calls };
}

async function get(port, path, init) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（HTML/SVG） */ }
  return { status: res.status, text, json, type: res.headers.get('content-type') };
}

(async () => {
  console.log('\n局域网手机点歌测试');

  await t('能列出本机非回环 IPv4', () => {
    const a = lanAddresses();
    assert.ok(Array.isArray(a));
    for (const x of a) assert.ok(!x.address.startsWith('127.'), '不应含回环地址');
  });

  const { s, calls } = makeServer(18088);
  const info = await s.start();
  const port = info.port;

  await t('启动后 info 给出可用的局域网 URL', () => {
    assert.strictEqual(s.running, true);
    assert.ok(port > 0);
    assert.ok(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(info.url), 'URL 形状不对: ' + info.url);
  });

  await t('GET / 返回点歌页（HTML）', async () => {
    const r = await get(port, '/');
    assert.strictEqual(r.status, 200);
    assert.ok(r.type.includes('text/html'));
    assert.ok(r.text.includes('<title>KTV 点歌</title>'), '页面里应有标题');
    assert.ok(r.text.includes('/api/order'), '页面应调用点歌接口');
  });

  await t('GET /api/info', async () => {
    const r = await get(port, '/api/info');
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.port, port);
  });

  await t('GET /api/status 带出正在播放与队列', async () => {
    const r = await get(port, '/api/status');
    assert.strictEqual(r.json.song.name, '测试歌');
    assert.strictEqual(r.json.queue.length, 1);
    assert.strictEqual(r.json.queue[0].status, 'playing');
  });

  await t('GET /api/hot 透传 limit/offset', async () => {
    const r = await get(port, '/api/hot?limit=5&offset=10');
    assert.strictEqual(r.json.songs.length, 1);
    const c = calls.find((x) => x[0] === 'hot');
    assert.deepStrictEqual(c[1], { limit: 5, offset: 10 });
  });

  await t('GET /api/hot 的 limit 被夹到 1..50', async () => {
    await get(port, '/api/hot?limit=9999');
    const c = calls.filter((x) => x[0] === 'hot').pop();
    assert.strictEqual(c[1].limit, 50);
    await get(port, '/api/hot?limit=-3');
    assert.strictEqual(calls.filter((x) => x[0] === 'hot').pop()[1].limit, 1);
  });

  await t('GET /api/search 空关键词直接返回空，不打后端', async () => {
    const before = calls.filter((x) => x[0] === 'search').length;
    const r = await get(port, '/api/search?kw=');
    assert.deepStrictEqual(r.json.songs, []);
    assert.strictEqual(calls.filter((x) => x[0] === 'search').length, before, '不该调用后端搜索');
  });

  await t('GET /api/search 透传关键词', async () => {
    await get(port, '/api/search?kw=' + encodeURIComponent('海阔天空'));
    const c = calls.filter((x) => x[0] === 'search').pop();
    assert.strictEqual(c[1].keyword, '海阔天空');
  });

  await t('POST /api/order 点歌', async () => {
    const r = await get(port, '/api/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: 's9' }),
    });
    assert.strictEqual(r.json.ok, true);
    const c = calls.filter((x) => x[0] === 'order').pop();
    assert.strictEqual(c[1], 's9');
    assert.strictEqual(c[2].next, false);
  });

  await t('POST /api/order 支持"下一首"', async () => {
    await get(port, '/api/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: 's10', next: true }),
    });
    const c = calls.filter((x) => x[0] === 'order').pop();
    assert.strictEqual(c[2].next, true);
  });

  await t('POST /api/order 缺 songId 时给出可读错误', async () => {
    const r = await get(port, '/api/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.strictEqual(r.json.ok, false);
    assert.ok(r.json.error.includes('songId'));
  });

  await t('POST /api/order 收到坏 JSON 不崩', async () => {
    const r = await get(port, '/api/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops',
    });
    assert.strictEqual(r.json.ok, false);
  });

  await t('后端抛错时返回可读错误而不是 500 崩掉', async () => {
    const { s: s2 } = makeServer(18089, { hot: async () => { throw new Error('曲库服务未就绪'); } });
    await s2.start();
    const r = await get(s2.info().port, '/api/hot');
    assert.strictEqual(r.json.ok, false);
    assert.ok(r.json.error.includes('曲库服务未就绪'));
    await s2.stop();
  });

  await t('GET /api/qr.svg 返回 SVG', async () => {
    const r = await get(port, '/api/qr.svg');
    assert.ok(r.type.includes('svg'), 'content-type: ' + r.type);
    assert.ok(r.text.startsWith('<svg'), '应是 SVG');
  });

  await t('未知接口返回可读错误', async () => {
    const r = await get(port, '/api/nope');
    assert.strictEqual(r.json.ok, false);
    assert.ok(r.json.error.includes('未知接口'));
  });

  await t('POST /api/remove 删歌', async () => {
    const r = await get(port, '/api/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId: 'e1' }),
    });
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(calls.filter((x) => x[0] === 'remove').pop()[1], 'e1');
  });

  await t('POST /api/control 播放/暂停', async () => {
    const r = await get(port, '/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle' }),
    });
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(calls.filter((x) => x[0] === 'control').pop()[1], 'toggle');
  });

  await t('POST /api/control 切歌', async () => {
    await get(port, '/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'next' }),
    });
    assert.strictEqual(calls.filter((x) => x[0] === 'control').pop()[1], 'next');
  });

  await t('POST /api/control 音量带值', async () => {
    await get(port, '/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'volume', value: 66 }),
    });
    const c = calls.filter((x) => x[0] === 'control').pop();
    assert.strictEqual(c[1], 'volume');
    assert.strictEqual(c[2], 66);
  });

  await t('未知控制动作返回可读错误', async () => {
    const r = await get(port, '/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unknown' }),
    });
    assert.strictEqual(r.json.ok, false);
    assert.ok(r.json.error.includes('未知操作'));
  });

  await t('控制动作抛错时不崩，返回可读错误', async () => {
    const r = await get(port, '/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'boom' }),
    });
    assert.strictEqual(r.json.ok, false);
    assert.ok(/boom|播放器炸了/.test(r.json.error), r.json.error);
  });

  await t('状态原样透出音量和"还有没有下一首"（手机端要用）', async () => {
    const r = await get(port, '/api/status');
    assert.strictEqual(r.json.volume, 80, '音量要透出来');
    assert.strictEqual(r.json.hasNext, true, '要有"还有下一首"的标记');
  });

  await s.stop();
  await t('stop() 后不再监听', async () => {
    assert.strictEqual(s.running, false);
    let refused = false;
    try { await get(port, '/api/info'); } catch { refused = true; }
    assert.ok(refused, '端口应该已经释放');
  });

  await t('端口被占用时自动往后试', async () => {
    const a = makeServer(18100).s;
    await a.start();
    const b = makeServer(18100).s;
    const bi = await b.start();
    assert.notStrictEqual(bi.port, a.info().port, '应该换了一个端口');
    assert.strictEqual(bi.port, a.info().port + 1);
    await a.stop(); await b.stop();
  });

  await t('默认端口常量可用', () => {
    assert.strictEqual(DEFAULT_PORT, 8088);
  });

  console.log(`\n局域网手机点歌测试：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
