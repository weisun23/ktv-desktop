/**
 * 封面服务
 * ========
 * 曲库里**没有封面数据**（songs 表没这个字段，albums.image_url 是空的），
 * 所以封面只能按「歌名 + 歌手」去网易云查。
 *
 * 设计取舍：
 *
 * 1. **按 songId 永久缓存**（只存解析出的 URL，不落地图片）
 *    同一个歌查过一次就不再请求；图片本身交给 Electron 的 HTTP 缓存。
 *
 * 2. **严格限速**（默认 1 并发、每 400ms 一个请求）
 *    翻一页热歌榜就是 30 首，不限速会被网易云风控；
 *    限速后封面是"一个一个冒出来"，体验可接受。
 *
 * 3. **查不到也记一笔**（存空字符串）
 *    否则每次翻到同一页都会把查不到的歌重试一遍。
 *
 * 4. 缓存文件是 JSON，超过上限按访问时间淘汰（LRU）。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/** 缓存上限（条）。一条只有几十字节，一万条也就几百 KB。 */
const MAX_ENTRIES = 10000;
/** 请求间隔：太密会被网易云风控 */
const MIN_GAP_MS = 400;
const TIMEOUT_MS = 10000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

class CoverService {
  /**
   * @param {{ cacheFile: string, fetchCover: (name:string, singer:string)=>Promise<string|null> }} opts
   */
  constructor({ cacheFile, fetchCover }) {
    this.cacheFile = cacheFile;
    this.fetchCover = fetchCover;
    this.map = new Map();       // songId -> { url, at }  url='' 表示查过但没找到
    this.queue = [];
    this.running = false;
    this.pending = new Set();   // 正在排队的 songId，防重复入队
    this.onReady = null;        // (songId, url) => void
    this._lastRequestAt = 0;
    this._dirty = false;
  }

  init() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      for (const [id, v] of Object.entries(raw || {})) {
        this.map.set(id, { url: String(v.url || ''), at: Number(v.at) || 0 });
      }
      console.log('[covers] 缓存载入', this.map.size, '条');
    } catch { /* 首次运行没有缓存文件 */ }
    return this;
  }

  /** 查一批（同步返回已知的，未知的入队后台解析）。 */
  lookup(items) {
    const known = {};
    for (const it of items || []) {
      const id = String(it?.id || '');
      if (!id) continue;
      const hit = this.map.get(id);
      if (hit) {
        hit.at = Date.now();
        if (hit.url) known[id] = hit.url;
        continue;
      }
      if (this.pending.has(id)) continue;
      if (!it.name) continue;
      this.pending.add(id);
      this.queue.push({ id, name: it.name, singer: it.singer || '' });
    }
    this._pump();
    return known;
  }

  async _pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        const wait = MIN_GAP_MS - (Date.now() - this._lastRequestAt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this._lastRequestAt = Date.now();
        let url = '';
        try { url = (await this.fetchCover(job.name, job.singer)) || ''; }
        catch { url = ''; }
        this.map.set(job.id, { url, at: Date.now() });
        this.pending.delete(job.id);
        this._dirty = true;
        try { this.onReady?.(job.id, url); } catch { /* 回调失败不影响缓存 */ }
      }
    } finally {
      this.running = false;
      if (this._dirty) { this._dirty = false; this.save().catch(() => {}); }
    }
  }

  async save() {
    // 超上限就按访问时间淘汰
    if (this.map.size > MAX_ENTRIES) {
      const sorted = [...this.map.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [id] of sorted.slice(0, this.map.size - MAX_ENTRIES)) this.map.delete(id);
    }
    const out = {};
    for (const [id, v] of this.map) out[id] = v;
    await fsp.mkdir(path.dirname(this.cacheFile), { recursive: true });
    await fsp.writeFile(this.cacheFile, JSON.stringify(out), 'utf8');
  }

  stats() { return { count: this.map.size, queued: this.queue.length, running: this.running }; }
}

/**
 * 按歌名+歌手去网易云查封面。
 * 用 cloudsearch（和在线搜索同源），拿 al.picUrl。
 */
async function fetchNeteaseCover(name, singer) {
  const kw = String(name || '').trim();
  if (!kw) return null;
  const artist = String(singer || '').split(/[、,，/&]/)[0].trim();
  const url = 'https://music.163.com/api/cloudsearch/pc?s=' + encodeURIComponent((kw + ' ' + artist).trim())
    + '&type=1&limit=1&offset=0';
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const json = await res.json();
  const pic = json?.result?.songs?.[0]?.al?.picUrl;
  if (!pic) return null;
  const s = String(pic);
  return s.startsWith('http://') ? 'https://' + s.slice(7) : s;
}

module.exports = { CoverService, fetchNeteaseCover, MAX_ENTRIES, MIN_GAP_MS };
