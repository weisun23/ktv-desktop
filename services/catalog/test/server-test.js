/**
 * 曲库 HTTP 服务测试
 * ==================
 * 真实拉起服务进程，等它就绪信号，再逐个端点验证。
 * 用法: node --experimental-sqlite --no-warnings test/server-test.js
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SRC = path.resolve(__dirname, '..', 'src', 'server.js');
const DB = process.env.KTV_CATALOG_DB || path.resolve(__dirname, '..', '..', '..', 'resources', 'catalog', 'muse.db');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  return !!ok;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', SRC, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('等待服务就绪超时')), 20000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = /KTV_CATALOG_READY (\{.*\})/.exec(buf);
      if (m) { clearTimeout(timer); resolve({ child, info: JSON.parse(m[1]) }); }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`服务提前退出 code=${code}`)); });
  });
}

async function main() {
  if (!fs.existsSync(DB)) { console.error(`找不到曲库: ${DB}`); process.exit(1); }

  const { child, info } = await startServer();
  const base = `http://127.0.0.1:${info.port}`;
  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json() };
  };

  try {
    check('服务启动并报告端口', info.port > 0, `port=${info.port}`);

    const health = await get('/health');
    check('GET /health', health.status === 200 && health.body.ok === true);

    const stats = await get('/stats');
    check('GET /stats', stats.body.songs > 600000, `${stats.body.songs} 首 / ${stats.body.singers} 位歌手`);

    const langs = await get('/languages');
    check('GET /languages', langs.body.languages?.length >= 6, (langs.body.languages || []).join('、'));

    const hot = await get('/songs/hot?limit=10');
    check('GET /songs/hot', hot.body.songs?.length === 10,
      `首条 ${hot.body.songs?.[0]?.name} - ${hot.body.songs?.[0]?.singer}`);

    const search = await get('/songs/search?q=' + encodeURIComponent('周杰伦') + '&limit=5');
    check('GET /songs/search（歌手名）', search.body.songs?.length > 0 && search.body.hasMore !== undefined,
      `${search.body.songs?.length} 条 hasMore=${search.body.hasMore}`);

    const byId = await get('/songs/' + encodeURIComponent(hot.body.songs[0].id));
    check('GET /songs/:id', byId.body.id === hot.body.songs[0].id,
      `${byId.body.name} accomp=${byId.body.accomp} musicNo=${byId.body.musicNo}`);

    const notFound = await get('/songs/not-a-real-id');
    check('GET /songs/:id 不存在返回 404', notFound.status === 404);

    const singers = await get('/singers?q=' + encodeURIComponent('周杰伦'));
    check('GET /singers', singers.body.singers?.length > 0, singers.body.singers?.[0]?.name);

    if (singers.body.singers?.length) {
      const bySinger = await get(`/singers/${encodeURIComponent(singers.body.singers[0].id)}/songs?limit=5`);
      check('GET /singers/:id/songs', bySinger.body.songs?.length > 0, `${bySinger.body.songs.length} 首`);
    }

    const areas = await get('/singers/areas');
    check('GET /singers/areas', areas.body.areas?.length > 0, (areas.body.areas || []).join('、'));

    // 首字母索引
    const letters = await get('/singers/letters');
    check('GET /singers/letters 返回 A-Z',
      letters.status === 200 && (letters.body.letters || []).filter((l) => /^[A-Z]$/.test(l.letter)).length === 26);
    const zBucket = (letters.body.letters || []).find((l) => l.letter === 'Z');
    check('Z 桶有数量', zBucket && zBucket.count > 0, zBucket ? zBucket.count + ' 位' : '');

    const byLetter = await get('/singers?letter=Z&limit=10');
    check('GET /singers?letter=Z 按首字母筛',
      byLetter.body.singers?.length === 10
      && byLetter.body.singers.every((s) => (s.nameCap || '').toUpperCase().startsWith('Z')),
      byLetter.body.singers?.slice(0, 3).map((s) => s.name).join(', '));

    // 字母索引支持地区/类型筛选
    const allL = await get('/singers/letters');
    const hkL = await get('/singers/letters?area=%E6%B8%AF%E5%8F%B0');
    const sum = (r) => (r.body.letters || []).reduce((a, l) => a + l.count, 0);
    check('GET /singers/letters?area= 计数变小',
      sum(hkL) > 0 && sum(hkL) < sum(allL), sum(allL) + ' -> ' + sum(hkL));

    const hkFemale = await get('/singers?area=%E6%B8%AF%E5%8F%B0&type=%E5%A5%B3&limit=5');
    check('GET /singers 支持 area+type 叠加',
      hkFemale.body.singers?.length === 5
      && hkFemale.body.singers.every((s) => s.area === '港台' && s.type === '女'),
      hkFemale.body.singers?.slice(0, 3).map((s) => s.name).join(', '));

    // 批量接口：收藏/歌单/已唱列表一次拿完
    const someIds = hot.body.songs.slice(0, 5).map((s) => s.id);
    const post = async (p, body) => {
      const r = await fetch(base + p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    const batch = await post('/songs/batch', { ids: someIds });
    check('POST /songs/batch 批量取曲目',
      batch.status === 200 && batch.body.songs?.length === someIds.length,
      (batch.body.songs?.length || 0) + ' 条');
    check('批量接口保持传入顺序', (batch.body.songs || []).every((s, i) => s.id === someIds[i]));

    const emptyBatch = await post('/songs/batch', { ids: [] });
    check('批量接口空数组返回空列表',
      Array.isArray(emptyBatch.body.songs) && emptyBatch.body.songs.length === 0);

    const bad = await get('/nope');
    check('未知路径返回 404', bad.status === 404);
  } finally {
    child.kill();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`服务测试失败 ${failed.length}/${results.length} 项`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
  console.log(`服务测试全部通过（${results.length} 项）`);
}

main().catch((e) => { console.error('测试异常:', e.message); process.exit(1); });
