/**
 * 曲库安装管线
 * ============
 * 分片下载 -> 逐片校验(size+md5) -> 拼接 -> gunzip -> 整库校验(sha256)
 * -> 原子替换 -> 记录版本
 *
 * 设计要点（对齐 maidong 的分发方案）：
 *   - 全程流式处理，1GB 的库不会整体读进内存
 *   - 每个分片独立重试；任一步失败都清理临时文件，绝不动到现有曲库
 *   - 安装用"先备份再改名"，中途断电也不会留下半个 muse.db
 *   - 安装前检查可用空间（解压后大小 + 最大分片 + 余量）
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const { loadManifest, isHttpUrl, isFileUrl } = require('./manifest');

const DOWNLOAD_RETRIES = 3;
const MIN_FREE_MARGIN = 256 * 1024 * 1024; // 留 256MB 余量

/** 把 http(s)/file:///本地路径 统一成可读流。 */
async function openReadStream(source, headers) {
  if (isHttpUrl(source)) {
    const res = await fetch(source, { redirect: 'follow', headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('响应没有 body');
    return Readable.fromWeb(res.body);
  }
  const filePath = isFileUrl(source)
    ? new URL(source).pathname.replace(/^\/([A-Za-z]:)/, '$1')
    : source;
  return fs.createReadStream(filePath);
}

/** 计算文件摘要。 */
function digestFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** 可用空间（字节）。statfs 不可用时返回 null，跳过检查而不是误报失败。 */
async function freeSpace(dir) {
  try {
    const st = await fsp.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/**
 * 顺序拼接多个文件为一个字节流。
 * 注意：不能用 Readable.from([stream1, stream2])——那会把"流对象"当成数据块发出，
 * 必须用 async generator 逐块 yield。
 */
async function* concatFiles(paths) {
  for (const p of paths) {
    for await (const chunk of fs.createReadStream(p)) yield chunk;
  }
}

function human(bytes) {
  if (!bytes && bytes !== 0) return '未知';
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 这个分片是不是已经下好了（断点续传用）。
 * 大小对上 + md5 对上才算 —— 中途断电留下的半截文件必须重下。
 */
async function shardLooksComplete(partPath, shard) {
  try {
    const st = await fsp.stat(partPath);
    if (!st.isFile() || st.size === 0) return false;
    if (shard.size >= 0 && st.size !== shard.size) return false;
    if (shard.md5) return (await digestFile(partPath, 'md5')) === shard.md5;
    return true;
  } catch { return false; }
}
/** 下载（或复制）单个分片并校验。 */
async function fetchShard(shard, destPath, onBytes, headers) {
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    try {
      await fsp.rm(destPath, { force: true });
      let written = 0;
      const out = fs.createWriteStream(destPath);
      const src = await openReadStream(shard.source, headers);
      src.on('data', (chunk) => { written += chunk.length; onBytes?.(written); });
      await pipeline(src, out);

      const st = await fsp.stat(destPath);
      if (shard.size >= 0 && st.size !== shard.size) {
        throw new Error(`分片大小不符: ${st.size} != ${shard.size}`);
      }
      if (shard.md5) {
        const actual = await digestFile(destPath, 'md5');
        if (actual !== shard.md5) throw new Error(`分片 md5 不符: ${actual} != ${shard.md5}`);
      }
      return st.size;
    } catch (err) {
      lastError = err;
      await fsp.rm(destPath, { force: true });
      if (attempt < DOWNLOAD_RETRIES) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw new Error(`分片 ${shard.file} 获取失败（重试 ${DOWNLOAD_RETRIES} 次）: ${lastError?.message}`);
}

/**
 * 安装曲库。
 * @param {object} opts
 * @param {string} opts.manifestSource  清单来源（http(s) / file:// / 本地路径）
 * @param {string} opts.targetDir       安装目录
 * @param {(p:{phase:string,percent:number,detail?:string})=>void} [opts.onProgress]
 * @param {boolean} [opts.force]        版本相同也强制重装
 * @returns {Promise<{dbPath:string, version:string, bytes:number}>}
 */
async function installCatalog(opts) {
  const { manifestSource, targetDir } = opts;
  const onProgress = opts.onProgress || (() => {});
  if (!targetDir) throw new Error('未指定安装目录');

  await fsp.mkdir(targetDir, { recursive: true });

  const manifest = await loadManifest(manifestSource, opts.headers);
  onProgress({ phase: 'manifest', percent: 0, detail: `版本 ${manifest.version}` });

  const dbPath = path.join(targetDir, 'muse.db');
  const versionPath = path.join(targetDir, 'db_version.txt');
  const tempDb = `${dbPath}.download`;
  const partsDir = `${dbPath}.parts`;
  const backupDb = `${dbPath}.backup`;

  // 版本一致则跳过（除非 force）
  if (!opts.force) {
    try {
      const current = (await fsp.readFile(versionPath, 'utf8')).trim();
      if (current === manifest.version && fs.existsSync(dbPath)) {
        const st = await fsp.stat(dbPath);
        onProgress({ phase: 'done', percent: 100, detail: `已是版本 ${current}，跳过` });
        return { dbPath, version: current, bytes: st.size, skipped: true };
      }
    } catch { /* 没有版本文件，继续安装 */ }
  }

  // 空间检查
  const largest = Math.max(...manifest.files.map((f) => (f.size > 0 ? f.size : 0)));
  const need = manifest.originalSize + largest + MIN_FREE_MARGIN;
  const free = await freeSpace(targetDir);
  if (free !== null && free < need) {
    throw new Error(`磁盘空间不足：需要 ${human(need)}，可用 ${human(free)}`);
  }

  /**
   * 清理临时文件。
   * ⚠️ keepParts=true 时**保留已完成的分片** —— 这是断点续传的关键：
   * 以前失败时会把整个 parts 目录删掉，439MB 的分片白下，下次从零开始。
   * 曲库是「一个 gzip 流切成若干片」，改一个字节后面全变，所以**没法只下差异**；
   * 但「已经下完的片不重下」是能做的，而且对断网/断电场景是实打实的省事。
   */
  const cleanup = async ({ keepParts = false } = {}) => {
    await fsp.rm(tempDb, { force: true });
    if (!keepParts) await fsp.rm(partsDir, { recursive: true, force: true });
  };

  try {
    await cleanup({ keepParts: true });   // 保留上次没下完的分片
    await fsp.mkdir(partsDir, { recursive: true });

    // ── 1. 逐片获取 ──
    const partPaths = [];
    let doneBytes = 0;
    let resumed = 0;
    for (const shard of manifest.files) {
      const partPath = path.join(partsDir, `part-${String(shard.index).padStart(5, '0')}`);
      // 断点续传：这片已经下完且 md5 对得上就直接用
      if (await shardLooksComplete(partPath, shard)) {
        resumed++;
        doneBytes += shard.size > 0 ? shard.size : (await fsp.stat(partPath)).size;
        onProgress({
          phase: 'download',
          percent: Math.min(70, Math.floor((doneBytes / Math.max(1, manifest.compressedSize)) * 70)),
          detail: `${shard.file}（已下载，跳过）`,
        });
        partPaths.push(partPath);
        continue;
      }
      await fetchShard(shard, partPath, (written) => {
        const pct = Math.floor(((doneBytes + written) / Math.max(1, manifest.compressedSize)) * 70);
        onProgress({ phase: 'download', percent: Math.min(70, pct), detail: shard.file });
      }, opts.headers);
      doneBytes += shard.size > 0 ? shard.size : (await fsp.stat(partPath)).size;
      partPaths.push(partPath);
    }
    if (resumed) onProgress({ phase: 'download', percent: 70, detail: `续传：${resumed}/${manifest.files.length} 片已存在` });

    // ── 2. 拼接 + 解压（流式） ──
    onProgress({ phase: 'extract', percent: 72, detail: '合并分片并解压' });
    const gunzip = zlib.createGunzip();
    const out = fs.createWriteStream(tempDb);
    await pipeline(Readable.from(concatFiles(partPaths)), gunzip, out);

    // ── 3. 整库校验 ──
    onProgress({ phase: 'verify', percent: 90, detail: '校验 sha256' });
    const st = await fsp.stat(tempDb);
    if (manifest.originalSize && st.size !== manifest.originalSize) {
      throw new Error(`解压后大小不符: ${st.size} != ${manifest.originalSize}`);
    }
    if (manifest.sha256) {
      const actual = await digestFile(tempDb, 'sha256');
      if (actual !== manifest.sha256) throw new Error(`整库 sha256 不符: ${actual}`);
    }

    // ── 4. 原子替换 ──
    onProgress({ phase: 'install', percent: 96, detail: '原子替换' });
    await fsp.rm(backupDb, { force: true });
    if (fs.existsSync(dbPath)) await fsp.rename(dbPath, backupDb);
    try {
      await fsp.rename(tempDb, dbPath);
    } catch (err) {
      if (fs.existsSync(backupDb)) await fsp.rename(backupDb, dbPath);
      throw err;
    }
    await fsp.rm(backupDb, { force: true });
    await fsp.writeFile(versionPath, manifest.version, 'utf8');

    await cleanup();
    onProgress({ phase: 'done', percent: 100, detail: `版本 ${manifest.version}` });
    return { dbPath, version: manifest.version, bytes: st.size };
  } catch (err) {
    // ⚠️ 失败时**保留已下完的分片**，下次点「下载曲库」能接着下
    await cleanup({ keepParts: true });
    throw err;
  }
}

module.exports = { installCatalog, fetchShard, digestFile, freeSpace, human };
