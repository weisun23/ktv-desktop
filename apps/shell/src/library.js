/**
 * 本地曲库扫描
 * ============
 * 阶段 1 只做本地文件夹扫描，让"点歌 -> 播放 -> 切原伴唱"这条链路能独立跑通，
 * 不依赖任何第三方取流接口。
 *
 * 后续接入在线曲库时，这里会扩展成 provider 接口
 * （local / muse-db / 在线平台），但对外返回的 Song 结构保持一致。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 可播放的媒体扩展名 */
const MEDIA_EXTENSIONS = new Set(['.ts', '.mp4', '.mkv', '.avi', '.mov', '.mpg', '.mpeg', '.flv', '.webm', '.mp3', '.flac', '.wav', '.m4a', '.aac']);

/**
 * @typedef {Object} Song
 * @property {string} id          稳定 id（基于路径）
 * @property {string} filePath    绝对路径
 * @property {string} name        显示名（文件名去扩展名）
 * @property {string} ext         扩展名（小写，含点）
 * @property {number} size        字节数
 * @property {number} mtime       修改时间戳
 */

function stableId(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
}

function toSong(filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    id: stableId(filePath),
    filePath,
    name: path.basename(filePath, path.extname(filePath)),
    ext,
    size: stat.size,
    mtime: Math.round(stat.mtimeMs),
  };
}

/**
 * 扫描目录下的媒体文件（不递归子目录，避免误扫整块硬盘）。
 * @param {string} dir
 * @returns {Song[]}
 */
function scanLibrary(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(ext)) continue;
    const full = path.join(dir, entry.name);
    try {
      out.push(toSong(full, fs.statSync(full)));
    } catch {
      // 单个文件读取失败不应影响整体扫描
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return out;
}

/**
 * 解析曲库曲目对应的本地文件。
 *
 * 文件布局沿用 maidong 的约定：媒体文件按 songs.filename 命名，
 * 统一放在 <mediaRoot>/<filename>（maidong 里是 .../MaidongKTV/video/cloud-song/）。
 * 曲库只提供元数据，能不能播取决于本地有没有这个文件。
 *
 * @param {string} mediaRoot
 * @param {string} filename songs.filename，例如 "4100007.ts"
 * @returns {string|null} 存在的绝对路径，否则 null
 */
function resolveLocalMedia(mediaRoot, filename) {
  if (!mediaRoot || !filename) return null;
  // 防目录穿越：只取文件名部分
  const safe = path.basename(String(filename));
  const full = path.join(mediaRoot, safe);
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/**
 * 列出媒体目录里已有的文件名（小写）。
 * 界面用它来标注"哪些曲库曲目本地已下载、可以直接唱"。
 * @param {string} mediaRoot
 * @returns {Set<string>}
 */
function listLocalFilenames(mediaRoot) {
  const out = new Set();
  if (!mediaRoot || !fs.existsSync(mediaRoot)) return out;
  try {
    for (const name of fs.readdirSync(mediaRoot)) out.add(name.toLowerCase());
  } catch { /* 目录不可读 */ }
  return out;
}

module.exports = { scanLibrary, stableId, MEDIA_EXTENSIONS, resolveLocalMedia, listLocalFilenames };
