/**
 * 局域网手机点歌服务
 * ==================
 * 在 KTV 主机上开一个 HTTP 服务，手机连同一个 Wi-Fi 就能：
 *   - 扫码/输网址打开点歌页
 *   - 搜歌、看热歌榜
 *   - 点歌入队（走的是和主机界面**完全相同**的排队/缓存/播放链路）
 *
 * 设计取舍：
 *   - 只监听局域网，不做登录。KTV 场景里"同一个 Wi-Fi"就是信任边界；
 *     真需要管控的话关掉这个开关即可（设置页可关）。
 *   - 页面是**单文件内联**的（无构建、无外链），手机端零依赖、断网也能开。
 *   - 端口被占用时自动往后试几个，避免和别的软件抢 8088。
 */
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 8088;
const PORT_TRIES = 10;
/** 请求体上限，防止有人往接口灌大包 */
const MAX_BODY = 64 * 1024;

/** 本机所有非回环 IPv4 地址（手机要用的就是这些） */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ iface: name, address: ni.address });
    }
  }
  // 常见的家用/办公网段排前面，方便用户一眼认出来
  const score = (a) => (/^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  return out.sort((a, b) => score(a.address) - score(b.address));
}

function readPage() {
  try {
    return fs.readFileSync(path.join(__dirname, 'lan', 'index.html'), 'utf8');
  } catch (e) {
    return `<h1>点歌页缺失</h1><p>${e.message}</p>`;
  }
}

class LanServer {
  /**
   * @param {{
   *   port?: number,
   *   status: () => any,
   *   hot: (opts:any) => Promise<any>,
   *   search: (opts:any) => Promise<any>,
   *   order: (songId:string, opts:any) => Promise<any>,
   *   removeEntry?: (entryId:string) => Promise<any>,
   * }} opts
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.port = Number(opts.port) || DEFAULT_PORT;
    this.server = null;
    this.actualPort = null;
    this.startedAt = null;
    this.error = null;
    this._hits = 0;
  }

  get running() { return !!this.server; }

  /** 给界面看的连接信息 */
  info() {
    const addrs = lanAddresses();
    const primary = addrs[0]?.address || '127.0.0.1';
    return {
      running: this.running,
      port: this.actualPort || this.port,
      addresses: addrs.map((a) => a.address),
      ifaces: addrs,
      url: `http://${primary}:${this.actualPort || this.port}`,
      error: this.error,
      hits: this._hits,
      startedAt: this.startedAt,
    };
  }

  start() {
    if (this.server) return Promise.resolve(this.info());
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryPort = (port) => {
        const server = http.createServer((req, res) => this._handle(req, res));
        server.on('error', (e) => {
          if (e.code === 'EADDRINUSE' && attempt < PORT_TRIES) {
            attempt++;
            tryPort(port + 1);
            return;
          }
          this.error = e.message;
          reject(e);
        });
        // 只绑 0.0.0.0：局域网可达，且不会暴露到公网（家用路由器 NAT 之外进不来）
        server.listen(port, '0.0.0.0', () => {
          this.server = server;
          this.actualPort = server.address().port;
          this.startedAt = Date.now();
          this.error = null;
          resolve(this.info());
        });
      };
      tryPort(this.port);
    });
  }

  stop() {
    if (!this.server) return Promise.resolve();
    const s = this.server;
    this.server = null;
    this.actualPort = null;
    return new Promise((resolve) => s.close(() => resolve()));
  }

  // ── 路由 ────────────────────────────────────────────────────
  async _handle(req, res) {
    this._hits++;
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        return this._send(res, 200, 'text/html; charset=utf-8', readPage());
      }
      if (req.method === 'GET' && p === '/api/info') {
        return this._json(res, { ok: true, name: 'KTV 点歌系统', port: this.actualPort });
      }
      if (req.method === 'GET' && p === '/api/status') {
        return this._json(res, { ok: true, ...(await this.opts.status()) });
      }
      if (req.method === 'GET' && p === '/api/hot') {
        const limit = clamp(url.searchParams.get('limit'), 20, 1, 50);
        const r = await this.opts.hot({ limit, offset: clamp(url.searchParams.get('offset'), 0, 0, 100000) });
        return this._json(res, { ok: true, songs: r.songs || r, hasMore: !!r.hasMore });
      }
      if (req.method === 'GET' && p === '/api/search') {
        const kw = String(url.searchParams.get('kw') || '').trim();
        if (!kw) return this._json(res, { ok: true, songs: [], hasMore: false });
        const r = await this.opts.search({
          keyword: kw,
          limit: clamp(url.searchParams.get('limit'), 20, 1, 50),
          offset: clamp(url.searchParams.get('offset'), 0, 0, 100000),
        });
        return this._json(res, { ok: true, songs: r.songs || [], hasMore: !!r.hasMore });
      }
      if (req.method === 'GET' && p === '/api/qr.svg') {
        return this._send(res, 200, 'image/svg+xml; charset=utf-8', this._qr());
      }
      if (req.method === 'POST' && p === '/api/order') {
        const body = await this._body(req);
        if (!body.songId) return this._json(res, { ok: false, error: '缺少 songId' });
        const r = await this.opts.order(String(body.songId), { next: !!body.next });
        return this._json(res, r);
      }
      if (req.method === 'POST' && p === '/api/control' && this.opts.control) {
        const body = await this._body(req);
        return this._json(res, await this.opts.control(String(body.action || ''), body.value));
      }
      if (req.method === 'POST' && p === '/api/remove' && this.opts.removeEntry) {
        const body = await this._body(req);
        const ok = await this.opts.removeEntry(String(body.entryId || ''));
        return this._json(res, { ok: !!ok });
      }
      this._json(res, { ok: false, error: '未知接口: ' + p });
    } catch (e) {
      this._json(res, { ok: false, error: e.message || String(e) });
    }
  }

  /** 点歌页的二维码（手机扫一下就能打开） */
  _qr() {
    try {
      const qr = require('qrcode-generator');
      const url = this.info().url;
      const q = qr(0, 'M');
      q.addData(url);
      q.make();
      return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch (e) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="6" y="34" fill="#888">二维码不可用：${e.message}</text></svg>`;
    }
  }

  _body(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
      });
      req.on('error', reject);
    });
  }

  _json(res, obj) {
    this._send(res, 200, 'application/json; charset=utf-8', JSON.stringify(obj));
  }

  _send(res, code, type, body) {
    if (res.writableEnded) return;
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }
}

function clamp(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

module.exports = { LanServer, lanAddresses, DEFAULT_PORT };
