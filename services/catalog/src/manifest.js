/**
 * 曲库清单（manifest.json）读取与校验
 * ===================================
 * 清单格式（与 maidong 的 database_publish 一致）：
 * {
 *   "version": "20260717.211050",
 *   "original_size": 1036038144,      // 解压后的 muse.db 字节数
 *   "compressed_size": 439666679,     // 所有分片字节数之和
 *   "sha256": "...",                  // 解压后 muse.db 的 sha256
 *   "files": [ { "file": "muse.db.gz.000", "size": 47185920, "md5": "..." }, ... ]
 * }
 *
 * 分片按 files 数组顺序拼接成一个完整的 gzip 流，解压即得 muse.db。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

/** 判断字符串是否为 http(s) URL */
function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

/** 判断字符串是否为 file:// URL */
function isFileUrl(value) {
  return /^file:\/\//i.test(String(value || ''));
}

/** 把相对分片名解析成绝对来源 URL/路径（相对清单所在位置）。 */
function resolveSource(manifestSource, file) {
  if (isHttpUrl(file) || isFileUrl(file) || path.isAbsolute(file)) return file;
  if (isHttpUrl(manifestSource)) return new URL(file, manifestSource).toString();
  if (isFileUrl(manifestSource)) return new URL(file, manifestSource).toString();
  return path.resolve(path.dirname(manifestSource), file);
}

/**
 * 读取清单。
 * @param {string} source http(s) URL、file:// URL 或本地路径
 * @returns {Promise<{raw:object, source:string, version:string, originalSize:number,
 *   compressedSize:number, sha256:string, files:{file:string,size:number,md5:string}[]}>}
 */
async function loadManifest(source, headers) {
  if (!source) throw new Error('未指定曲库清单来源');

  let text;
  if (isHttpUrl(source)) {
    const res = await fetch(source, { redirect: 'follow', headers });
    if (!res.ok) throw new Error(`清单请求失败 HTTP ${res.status}: ${source}`);
    text = await res.text();
  } else {
    const filePath = isFileUrl(source) ? new URL(source).pathname.replace(/^\/([A-Za-z]:)/, '$1') : source;
    text = await fsp.readFile(filePath, 'utf8');
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`清单不是合法 JSON: ${e.message}`);
  }

  const files = Array.isArray(raw.files) ? raw.files : [];
  if (!files.length) throw new Error('清单里没有任何分片');

  const parsed = {
    raw,
    source,
    version: String(raw.version || ''),
    originalSize: Number(raw.original_size || 0),
    compressedSize: Number(raw.compressed_size || 0),
    sha256: String(raw.sha256 || '').toLowerCase(),
    files: files.map((f, i) => ({
      file: String(f.file || ''),
      size: Number(f.size || -1),
      md5: String(f.md5 || '').toLowerCase(),
      index: i,
      source: resolveSource(source, String(f.file || '')),
    })),
  };

  validateManifest(parsed);
  return parsed;
}

/** 做一次结构自检，尽早暴露坏清单。 */
function validateManifest(m) {
  if (!m.files.length) throw new Error('清单分片列表为空');

  const sum = m.files.reduce((acc, f) => acc + (f.size > 0 ? f.size : 0), 0);
  if (m.compressedSize > 0 && sum !== m.compressedSize) {
    throw new Error(`清单自相矛盾：分片大小合计 ${sum} != compressed_size ${m.compressedSize}`);
  }
  for (const f of m.files) {
    if (!f.file) throw new Error('清单存在没有 file 字段的分片');
    if (f.size < 0) throw new Error(`分片 ${f.file} 缺少 size`);
  }
  if (!m.originalSize) throw new Error('清单缺少 original_size');
  return m;
}

module.exports = { loadManifest, validateManifest, resolveSource, isHttpUrl, isFileUrl };
