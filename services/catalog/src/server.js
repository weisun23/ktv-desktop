/**
 * 曲库 HTTP 服务
 * ==============
 * 只监听 127.0.0.1，给 Electron 壳（以及后续的手机点歌页）提供曲库查询。
 *
 * 设计：
 *   - 零依赖，只用 node:http
 *   - 启动后向 stdout 打印一行 KTV_CATALOG_READY {...}，父进程据此判断就绪
 *   - 端口默认 0（随机），避免和用户机器上其它服务撞端口
 *
 * 用法:
 *   node --experimental-sqlite src/server.js [--port 8899] [--db <path>]
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { MuseCatalog } = require('./db');

const DEFAULT_DB = path.resolve(__dirname, '..', '..', '..', 'resources', 'catalog', 'muse.db');

function parseArgs(argv) {
  const out = { port: 0, db: process.env.KTV_CATALOG_DB || DEFAULT_DB };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]) || 0;
    else if (argv[i] === '--db') out.db = argv[++i];
  }
  return out;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** 读请求体（限长），给批量接口用 */
function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function createServer(catalog) {
  return http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return json(res, 400, { error: 'BAD_URL' }); }

    const p = url.pathname;
    const q = url.searchParams;
    const limit = Number(q.get('limit')) || 20;
    const offset = Number(q.get('offset')) || 0;

    try {
      if (p === '/health') return json(res, 200, { ok: true, db: catalog.dbPath });
      if (p === '/stats') return json(res, 200, catalog.stats());
      if (p === '/languages') return json(res, 200, { languages: catalog.languages() });
      if (p === '/songs/hot') return json(res, 200, catalog.hotSongs({ lang: q.get('lang'), limit, offset }));
      // 批量取曲目：收藏/歌单/已唱列表用，避免逐个 id 往返
      if (p === '/songs/batch') {
        const body = req.method === 'POST' ? await readBody(req) : null;
        const ids = body?.ids || String(q.get('ids') || '').split(',').filter(Boolean);
        return json(res, 200, { songs: catalog.songsByIds(ids) });
      }
      if (p === '/songs/search') {
        return json(res, 200, catalog.searchSongs({ keyword: q.get('q'), lang: q.get('lang'), limit, offset }));
      }
      if (p === '/singers') {
        return json(res, 200, {
          singers: catalog.singers({
            keyword: q.get('q'), area: q.get('area'), type: q.get('type'),
            letter: q.get('letter'), limit, offset,
          }),
        });
      }
      // 首字母分布：界面上的 A-Z 索引条
      if (p === '/singers/letters') {
        return json(res, 200, { letters: catalog.singerLetters({ area: q.get('area'), type: q.get('type') }) });
      }
      if (p === '/singers/areas') return json(res, 200, { areas: catalog.singerAreas(), types: catalog.singerTypes() });

      let m = /^\/songs\/by-musicno\/([^/]+)$/.exec(p);
      if (m) {
        const song = catalog.songByMusicNo(decodeURIComponent(m[1]));
        return song ? json(res, 200, song) : json(res, 404, { error: 'SONG_NOT_FOUND' });
      }
      m = /^\/songs\/([^/]+)$/.exec(p);
      if (m) {
        const song = catalog.songById(decodeURIComponent(m[1]));
        return song ? json(res, 200, song) : json(res, 404, { error: 'SONG_NOT_FOUND' });
      }
      m = /^\/singers\/([^/]+)\/songs$/.exec(p);
      if (m) {
        return json(res, 200, { songs: catalog.songsBySinger(decodeURIComponent(m[1]), { limit, offset }) });
      }

      return json(res, 404, { error: 'NOT_FOUND', path: p });
    } catch (err) {
      console.error('[catalog] 查询失败', p, err.message);
      return json(res, 500, { error: 'QUERY_FAILED', message: err.message });
    }
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.db)) {
    console.error(`[catalog] 找不到曲库: ${args.db}`);
    console.error('[catalog] 请先安装：node src/cli.js --manifest <清单> --target resources/catalog');
    process.exit(2);
  }

  const catalog = new MuseCatalog(args.db).open();
  const server = createServer(catalog);

  server.listen(args.port, '127.0.0.1', () => {
    const port = server.address().port;
    // 父进程解析这一行来获知端口
    console.log(`KTV_CATALOG_READY ${JSON.stringify({ port, db: args.db })}`);
  });

  const shutdown = () => {
    server.close(() => { catalog.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('message', (m) => { if (m === 'shutdown') shutdown(); });
}

if (require.main === module) main();

module.exports = { createServer };
