/**
 * 缓存下载管理器
 * ==============
 * 点过的歌在后台自动下载到本地，下次点同一首直接播本地文件，不再走网络。
 *
 * 几个刻意的设计：
 *
 * 1. **下载时实时取地址，不用播放时那个**。取流地址约 1 小时过期，
 *    队列里排了半小时才轮到的歌，播放时的地址早就不能用于下载了。
 *
 * 2. **先写 .part 再原子改名**。中途断网/退出不会留下半个文件被误当成完整缓存；
 *    下次启动时残留的 .part 会被清掉重下。
 *
 * 3. **并发为 1**。播放正在吃带宽和 CPU，下载抢资源会直接表现为"唱歌卡"。
 *    排在后面的等前面的下完。
 *
 * 4. **有容量上限，先删最早下载的**。KTV 机长期跑会把盘塞满，所以超过上限
 *    就按下载时间从旧到新删（正在播的那首不动）。
 *    注：Windows 默认不更新 atime，所以这里用 mtime 而不是"最近访问"。
 *    将来可结合已唱历史做"常唱的歌优先保留"。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { repairTsFile, cleanupRepairTemp, clearMarks } = require('./repair');
const { decryptInPlace, cleanupDecryptTemp, markPlain } = require('./tsdecrypt');

const DEFAULT_MAX_CACHE_BYTES = 20 * 1024 * 1024 * 1024;   // 20GB
const PART_SUFFIX = '.part';
/** 分离过程留下的中间文件（<name>.accomp.src.wav / .sep.wav），不算缓存 */
const INTERMEDIATE_RE = /\.accomp\.(src|sep)\.wav$/i;

/**
 * 默认下载限速：512 KB/s。
 *
 * 这是**必须**的：后台缓存若不限速会吃满带宽，和正在播放的流抢资源，
 * 表现就是"视频卡、声音断续甚至没有"。
 * 512KB/s 意味着 35MB 的 MV 约 70 秒缓存完——对后台任务够用，
 * 而只占典型家庭宽带的很小一部分。
 */
const DEFAULT_MAX_BYTES_PER_SECOND = 512 * 1024;

/** 缓存统计的短缓存时长：状态推送每 250ms 会问一次，不能每次都扫目录 */
const STATS_TTL_MS = 2000;

class DownloadManager {
  /**
   * @param {object} deps
   * @param {string} deps.mediaRoot                 缓存目录
   * @param {(song:object)=>Promise<{url:string}>} deps.resolveUrl  实时取地址
   * @param {(task:object)=>void} [deps.onProgress] 进度回调
   * @param {number} [deps.maxCacheBytes]
   * @param {()=>string|null} [deps.currentFilename] 正在播放的文件名（淘汰时保护）
   */
  constructor({ mediaRoot, resolveUrl, onProgress, maxCacheBytes, maxBytesPerSecond, currentFilename, ffmpegPath, repairMode }) {
    this.ffmpegPath = ffmpegPath;
    this.repairMode = repairMode || 'remux';
    this.mediaRoot = mediaRoot;
    this.resolveUrl = resolveUrl;
    this.onProgress = onProgress || (() => {});
    this.maxCacheBytes = maxCacheBytes || DEFAULT_MAX_CACHE_BYTES;
    // 0 或负数表示不限速（不建议：会和播放抢带宽）
    this.maxBytesPerSecond = maxBytesPerSecond === undefined
      ? DEFAULT_MAX_BYTES_PER_SECOND
      : Number(maxBytesPerSecond);
    this.currentFilename = currentFilename || (() => null);
    // 播放中是否暂停下载。设成 true 就只在空闲时缓存，
    // 对网络敏感的环境最有效。
    this.pauseWhilePlaying = false;
    this.isPlaying = () => false;

    /** @type {Map<string, object>} filename -> task */
    this._statsCache = null;
    this._statsCacheAt = 0;

    this.tasks = new Map();
    this.queue = [];
    this.running = false;
  }

  init() {
    try { cleanupDecryptTemp(this.mediaRoot); } catch { /* 忽略 */ }
    this._sweepIntermediates();
    fs.mkdirSync(this.mediaRoot, { recursive: true });
    this._cleanupPartials();
    cleanupRepairTemp(this.mediaRoot);
    return this;
  }

  /** 清掉上次异常退出留下的半成品。 */
  _cleanupPartials() {
    try {
      for (const name of fs.readdirSync(this.mediaRoot)) {
        if (name.endsWith(PART_SUFFIX)) {
          fs.rmSync(path.join(this.mediaRoot, name), { force: true });
        }
      }
    } catch { /* 目录不可读就跳过 */ }
  }

  _finalPath(filename) { return path.join(this.mediaRoot, path.basename(String(filename))); }
  _partPath(filename) { return this._finalPath(filename) + PART_SUFFIX; }

  /**
   * 启动时扫一遍，清掉上次异常退出（被强杀 / 断电）留下的分离中间文件。
   * 启动那一刻不可能有分离在跑，所以这些必然是垃圾 —— 实测单个就有 50MB+。
   */
  _sweepIntermediates() {
    let names;
    try { names = fs.readdirSync(this.mediaRoot); } catch { return; }
    let freed = 0, count = 0;
    for (const name of names) {
      if (!INTERMEDIATE_RE.test(name)) continue;
      try {
        const full = path.join(this.mediaRoot, name);
        freed += fs.statSync(full).size;
        fs.rmSync(full, { force: true });
        count++;
      } catch { /* 忽略 */ }
    }
    if (count) console.log(`[downloads] 清理分离中间文件 ${count} 个，释放 ${(freed / 1048576).toFixed(1)}MB`);
  }

  /** 本地是否已有这个文件（不含半成品）。 */
  isDownloaded(filename) {
    if (!filename) return false;
    try { return fs.statSync(this._finalPath(filename)).isFile(); } catch { return false; }
  }

  /** 加入下载队列；已在下载或已缓存则忽略。 */
  enqueue(song) {
    const filename = song && song.filename;
    if (!filename) return { queued: false, reason: 'NO_FILENAME' };
    if (this.isDownloaded(filename)) return { queued: false, reason: 'ALREADY_CACHED' };
    if (this.tasks.has(filename)) return { queued: false, reason: 'ALREADY_QUEUED' };

    const task = {
      songId: song.id,
      filename,
      name: song.name || filename,
      state: 'queued',      // queued | downloading | done | failed
      received: 0,
      total: 0,
      error: null,
      queuedAt: Date.now(),
    };
    this.tasks.set(filename, task);
    this.queue.push(task);
    this.onProgress(task);
    this._pump();
    return { queued: true, task };
  }

  /**
   * 列出缓存目录里的文件（给"缓存管理"用）。
   *
   * 半成品 .part 不算——它们要么正在下、要么是上次异常退出的残留，
   * 都不该出现在用户能删的列表里。
   */
  listFiles() {
    const out = [];
    let names;
    try { names = fs.readdirSync(this.mediaRoot); } catch { return out; }
    for (const name of names) {
      if (name.endsWith(PART_SUFFIX)) continue;
      // 分离过程的中间产物（抽出的 wav、插件产出的 wav）不是"缓存"，
      // 它们要么正在被用、要么会在分离结束时清掉，不该出现在用户能删的列表里
      if (INTERMEDIATE_RE.test(name)) continue;
      const full = path.join(this.mediaRoot, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        out.push({ filename: name, bytes: st.size, mtime: st.mtimeMs, playing: name === this.currentFilename?.() });
      } catch { /* 读不到就跳过 */ }
    }
    out.sort((a, b) => b.mtime - a.mtime);   // 最近缓存的排前面
    return out;
  }

  /**
   * 删掉一个缓存文件。
   * 正在播的那首会被播放器占着句柄，Windows 上删不掉 —— 这时返回可读原因，
   * 而不是抛一个 EBUSY 上去。
   */
  removeFile(filename) {
    const safe = path.basename(String(filename || ''));
    if (!safe || safe.endsWith(PART_SUFFIX)) return { ok: false, error: '文件名不合法' };
    if (this.currentFilename?.() === safe) {
      return { ok: false, error: '这首歌正在播放，先切歌再删' };
    }
    const full = path.join(this.mediaRoot, safe);
    if (!fs.existsSync(full)) return { ok: false, error: '文件不存在' };
    try {
      fs.rmSync(full, { force: true });
      // 分离出来的伴奏也一起删，否则留着会占空间而且下次不会再生成
      for (const ext of ['.accomp.ts', '.accomp.mkv', '.accomp.wav', '.accomp.mp3']) {
        const a = path.join(this.mediaRoot, path.basename(safe, path.extname(safe)) + ext);
        try { if (fs.existsSync(a)) fs.rmSync(a, { force: true }); } catch { /* 忽略 */ }
      }
      this._invalidateStats();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.code === 'EBUSY' || e.code === 'EPERM'
        ? '文件被占用（可能正在播放），先切歌再删'
        : e.message };
    }
  }

  /** 队列状态快照（给界面用）。 */
  list() {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  /** 让下一次 stats() 重新扫描（下载完成/淘汰/清空后调用）。 */
  _invalidateStats() { this._statsCache = null; this._statsCacheAt = 0; }

  /**
   * 缓存统计。
   * ⚠️ 这里要 readdir + 每个文件一次 statSync，是实打实的磁盘 I/O；
   * 而主进程的状态推送每 250ms 就会调一次（见 main.js 的 statusWithSong），
   * 所以结果做 2 秒短缓存，避免每秒 4 次全量扫缓存目录。
   */
  stats() {
    const now = Date.now();
    if (this._statsCache && now - this._statsCacheAt < STATS_TTL_MS) return this._statsCache;
    let bytes = 0;
    let count = 0;
    try {
      for (const name of fs.readdirSync(this.mediaRoot)) {
        if (name.endsWith(PART_SUFFIX)) continue;
        try { const st = fs.statSync(path.join(this.mediaRoot, name)); if (st.isFile()) { bytes += st.size; count++; } } catch { /* 跳过 */ }
      }
    } catch { /* 目录不存在 */ }
    this._statsCache = { count, bytes, maxBytes: this.maxCacheBytes };
    this._statsCacheAt = now;
    return this._statsCache;
  }

  async _pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        // 播放中且要求「仅空闲时缓存」就等一等
        while (this.pauseWhilePlaying && this.isPlaying()) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        const task = this.queue.shift();
        if (this.isDownloaded(task.filename)) {
          task.state = 'done';
          this.onProgress(task);
          continue;
        }
        await this._download(task);
      }
    } finally {
      this.running = false;
    }
  }

  async _download(task) {
    task.state = 'downloading';
    task.error = null;
    this.onProgress(task);

    const part = this._partPath(task.filename);
    try {
      // 关键：下载用的地址是**现在**取的，不是播放时那个（约 1 小时过期）
      const resolved = await this.resolveUrl(task.song || { filename: task.filename, name: task.name });
      const res = await fetch(resolved.url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      task.total = Number(res.headers.get('content-length') || 0);

      const out = fs.createWriteStream(part);
      const reader = res.body.getReader();
      const startedAt = Date.now();
      // 限速只对『后台边播边下』有意义——那时怕抢带宽。
      // 而『先缓存再播』是阻塞等待、没有播放要保护，再限速就纯属让用户干等：
      // 实测同一首歌限速 1MB/s 要等 56 秒，不限速约 5 秒。
      const limit = task.noThrottle ? 0 : this.maxBytesPerSecond;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          task.received += value.length;
          if (!out.write(Buffer.from(value))) {
            await new Promise((r) => out.once('drain', r));
          }
          this.onProgress(task);
          if (limit > 0) await this._throttle(task.received, startedAt, limit);
        }
      } finally {
        await new Promise((r) => out.end(r));
      }

      if (task.total && task.received !== task.total) {
        throw new Error(`大小不符: ${task.received} != ${task.total}`);
      }

      await fsp.rename(part, this._finalPath(task.filename));
      // ⚠️ 顺序很重要：**先解密，再修复**。
      // maidong 分发的 .ts 是迅雷加密文件，不解密的话"修复"只会把密文重新封装一遍，
      // 播放器拿到的还是密文 → 周期性马赛克 + 解复用器反复重同步（卡顿）。
      // 和修复一样，都放在标记 done 之前 —— done 的含义是"已经可以直接顺畅播放"。
      clearMarks(this._finalPath(task.filename));
      await this._decryptFile(this._finalPath(task.filename));
      await this._repairFile(this._finalPath(task.filename));
      task.state = 'done';
      this.onProgress(task);
      this._evictIfNeeded();
      this._invalidateStats();
    } catch (err) {
      task.state = 'failed';
      task.error = err.message;
      this.onProgress(task);
      try { await fsp.rm(part, { force: true }); } catch { /* 忽略 */ }
    }
  }

  /**
   * 修复片源（见 repair.js）。失败不影响文件可用性，只是继续卡。
   */
  /**
   * 解密迅雷加密的 .ts（maidong 的片源都是这种）。
   * 不是加密文件就直接跳过；解密失败只记日志、**不阻断播放**（宁可留着密文也不丢文件）。
   */
  async _decryptFile(filePath) {
    if (!/\.ts$/i.test(filePath)) return { ok: true, skipped: true };
    try {
      const r = await decryptInPlace(filePath);
      if (r.ok) markPlain(filePath);   // 打了标记，下次不用再查"是不是老缓存"
      if (r.ok && r.decrypted) console.log('[downloads] 片源已解密:', path.basename(filePath));
      else if (!r.ok) console.warn('[downloads] 片源解密失败:', path.basename(filePath), r.error);
      return r;
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async _repairFile(filePath) {
    if (this.repairMode === 'off' || !/\.ts$/i.test(filePath)) return { ok: true, skipped: true };
    try {
      const r = await repairTsFile(filePath, { mode: this.repairMode, ffmpegPath: this.ffmpegPath });
      if (r.ok && r.repaired) console.log(`[downloads] 片源已修复(${r.mode}):`, path.basename(filePath));
      else if (!r.ok) console.warn('[downloads] 片源修复跳过:', r.error);
      return r;
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /**
   * 立即下载并修复，等到真正可播才返回。给『点歌后先缓存再播』用。
   * @returns {Promise<{ok:boolean, path?:string, cached?:boolean, error?:string}>}
   */
  async fetchNow(song, opts = {}) {
    const filename = song && song.filename;
    if (!filename) return { ok: false, error: '缺少文件名' };
    const finalPath = this._finalPath(filename);
    if (opts.force) {
      // 强制重下：旧缓存已被判定是坏的（早期版本把加密 TS 直接重封装了）。
      // 先删干净再下，避免半成品和旧文件混在一起。
      try { await fsp.rm(finalPath, { force: true }); } catch { /* 忽略 */ }
      try { await fsp.rm(finalPath + PART_SUFFIX, { force: true }); } catch { /* 忽略 */ }
      this.tasks.delete(filename);
    } else if (this.isDownloaded(filename)) {
      await this._decryptFile(finalPath);   // 历史缓存可能是密文，补一次
      await this._repairFile(finalPath);    // 历史缓存可能还没修过，补一次
      return { ok: true, path: finalPath, cached: true };
    }
    const task = {
      songId: song.id, filename, name: song.name || filename,
      state: 'queued', received: 0, total: 0, error: null, queuedAt: Date.now(),
      noThrottle: true,   // 阻塞式下载，见 _download 里的说明
    };
    this.tasks.set(filename, task);
    this.onProgress(task);
    await this._download(task);
    if (task.state !== 'done') return { ok: false, error: task.error || '下载失败' };
    return { ok: true, path: finalPath, cached: false };
  }

  /**
   * 限速：按"已下载字节数 / 目标速率"算出应该花的时间，
   * 实际跑太快就 sleep 补上差额。简单但足够准。
   */
  async _throttle(receivedBytes, startedAt, bytesPerSecond) {
    const targetMs = (receivedBytes / bytesPerSecond) * 1000;
    const actualMs = Date.now() - startedAt;
    const waitMs = targetMs - actualMs;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, Math.min(waitMs, 1000)));
  }

  /** 超过容量上限就删最久没用过的缓存（不动正在播的）。 */
  _evictIfNeeded() {
    const st = this.stats();
    if (st.bytes <= this.maxCacheBytes) return;

    const protectedName = this.currentFilename();
    let entries;
    try {
      entries = fs.readdirSync(this.mediaRoot)
        .filter((n) => !n.endsWith(PART_SUFFIX))
        .map((n) => {
          const full = path.join(this.mediaRoot, n);
          try { const s = fs.statSync(full); return { n, full, size: s.size, atime: s.mtimeMs }; } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => a.atime - b.atime);   // 最早下载的在前
    } catch { return; }

    let freed = 0;
    const need = st.bytes - this.maxCacheBytes;
    for (const e of entries) {
      if (freed >= need) break;
      if (e.n === protectedName) continue;
      try { fs.rmSync(e.full, { force: true }); freed += e.size; } catch { /* 跳过 */ }
    }
    if (freed > 0) { this._invalidateStats(); console.log(`[downloads] 缓存超限，已清理 ${(freed / 1024 / 1024).toFixed(1)} MB`); }
  }

  /** 清空已完成/失败的任务记录（不删文件）。 */
  clearFinished() {
    for (const [k, v] of this.tasks) if (v.state === 'done' || v.state === 'failed') this.tasks.delete(k);
  }
}

module.exports = { DownloadManager, DEFAULT_MAX_CACHE_BYTES, DEFAULT_MAX_BYTES_PER_SECOND };
