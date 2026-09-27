/**
 * 曲库服务客户端
 * ==============
 * 在子进程里拉起 services/catalog 的 HTTP 服务，并提供一个简单的查询封装。
 *
 * 为什么用子进程而不是在 Electron 主进程里直接开库：
 *   Electron 内置的是 Node 20，没有 node:sqlite；而 better-sqlite3 这类原生模块
 *   需要按 Electron ABI 重编译（本机没有 C++ 工具链）。用独立的 Node 进程跑曲库，
 *   既能用上内置 SQLite，也让曲库服务将来可以独立部署给手机点歌页用。
 *
 * 生产打包时需随包带一个 node.exe（见 docs/03-phase2-catalog.md）。
 */
'use strict';

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const paths = require('./paths');
const REPO_ROOT = paths.DEV_REPO_ROOT;
const SERVER_JS = path.join(paths.catalogServiceDir(), 'src', 'server.js');
const DEFAULT_DB = path.join(paths.catalogDir(), 'muse.db');

/** 找到可用的 node 可执行文件。 */
function resolveNodeBin() {
  if (process.env.KTV_NODE_BIN && fs.existsSync(process.env.KTV_NODE_BIN)) return process.env.KTV_NODE_BIN;
  // 打包时随包带一个 node.exe（Electron 自带的是 20.x，没有 node:sqlite）
  const bundled = paths.nodeBin();
  if (bundled) return bundled;
  // Electron 自带的 node 是 20.x，没有 node:sqlite，不能用来跑曲库服务
  if (!process.versions.electron) return process.execPath;
  try {
    const out = execFileSync('where', ['node'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (out && fs.existsSync(out)) return out;
  } catch { /* 没装 node */ }
  return 'node';
}

class CatalogService {
  constructor(opts = {}) {
    this.dbPath = opts.dbPath || process.env.KTV_CATALOG_DB || DEFAULT_DB;
    this.nodeBin = opts.nodeBin || resolveNodeBin();
    this.child = null;
    this.base = null;
    this.ready = false;
    this.lastError = null;
  }

  /** 启动服务并等待就绪。失败时抛出可读错误。 */
  start(timeoutMs = 30000) {
    if (this.ready) return Promise.resolve(this);
    if (!fs.existsSync(this.dbPath)) {
      return Promise.reject(new Error(
        `未找到曲库数据库：${this.dbPath}\n` +
        '请先安装曲库：npm --prefix services/catalog run install:db -- ' +
        '--manifest <manifest.json> --target resources/catalog'
      ));
    }
    if (!fs.existsSync(SERVER_JS)) return Promise.reject(new Error(`未找到曲库服务：${SERVER_JS}`));

    // Node 22/23 需要 --experimental-sqlite，24+ 已稳定（带该标志会报未知选项）
    const tryStart = (extraArgs) => new Promise((resolve, reject) => {
      const child = spawn(this.nodeBin, [...extraArgs, SERVER_JS, '--port', '0', '--db', this.dbPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let settled = false;
      let buf = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('曲库服务启动超时'));
      }, timeoutMs);

      child.stdout.on('data', (d) => {
        buf += d.toString();
        const m = /KTV_CATALOG_READY (\{.*\})/.exec(buf);
        if (m && !settled) {
          settled = true;
          clearTimeout(timer);
          this.child = child;
          this.base = `http://127.0.0.1:${JSON.parse(m[1]).port}`;
          this.ready = true;
          resolve(this);
        }
      });
      child.stderr.on('data', (d) => { this.lastError = d.toString().trim(); });
      child.on('error', (err) => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(err);
      });
      child.on('exit', (code) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(new Error(`曲库服务退出 code=${code}${this.lastError ? ' ' + this.lastError : ''}`));
      });
    });

    return tryStart(['--experimental-sqlite', '--no-warnings']).catch((err) => {
      // Node 24+ 不认 --experimental-sqlite，去掉标志再试一次
      if (/bad option|unknown option|not allowed/i.test(err.message)) return tryStart([]);
      throw err;
    });
  }

  async _get(pathname, params) {
    if (!this.ready) throw new Error('曲库服务尚未就绪');
    const url = new URL(this.base + pathname);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`曲库查询失败 HTTP ${res.status}: ${pathname}`);
    return res.json();
  }

  stats() { return this._get('/stats'); }
  languages() { return this._get('/languages').then((r) => r.languages); }
  hot(opts) { return this._get('/songs/hot', opts); }
  search(opts) { return this._get('/songs/search', { q: opts.keyword, lang: opts.lang, limit: opts.limit, offset: opts.offset }); }
  songById(id) { return this._get('/songs/' + encodeURIComponent(id)); }
  /**
   * 批量取曲目（收藏/歌单/已唱列表用）。
   * 逐个 songById 的话 200 首要 200 次往返，实测要等好几秒。
   */
  async songsByIds(ids) {
    if (!this.ready) throw new Error('曲库服务尚未就绪');
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (!list.length) return [];
    const res = await fetch(this.base + '/songs/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: list }),
    });
    if (!res.ok) throw new Error('曲库批量查询失败 HTTP ' + res.status);
    const r = await res.json();
    return r.songs || [];
  }
  songByMusicNo(musicNo) { return this._get('/songs/by-musicno/' + encodeURIComponent(musicNo)); }
  singers(opts) { return this._get('/singers', opts).then((r) => r.singers); }
  /** 首字母分布；传 area/type 让计数跟着筛选走 */
  singerLetters(opts) { return this._get('/singers/letters', opts).then((r) => r.letters || []); }
  singerFacets() { return this._get('/singers/areas'); }
  songsBySinger(id, opts) { return this._get(`/singers/${encodeURIComponent(id)}/songs`, opts).then((r) => r.songs); }

  stop() {
    if (this.child) {
      try { this.child.kill(); } catch { /* 已退出 */ }
      this.child = null;
    }
    this.ready = false;
    this.base = null;
  }
}

module.exports = { CatalogService, resolveNodeBin, DEFAULT_DB };
