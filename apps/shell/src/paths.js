/**
 * 路径解析（开发 / 打包两种形态）
 * ==============================
 * 打包后目录结构和开发时完全不同，必须区分三类路径：
 *
 *   runtimeRoot  只读，随包分发：libVLC、node.exe
 *   dataRoot     可写，用户数据：曲库、用户状态、取流配置、缓存
 *   appRoot      应用代码：services/catalog 等
 *
 * 开发时：runtimeRoot = <repo>/resources/runtime，dataRoot = <repo>/resources
 * 打包后：runtimeRoot = <安装目录>/resources，dataRoot = %APPDATA%/<appName>
 *
 * 为什么不把曲库放安装目录：Program Files 通常不可写，
 * 而且 988MB 的曲库塞进安装包会让安装包大到没人愿意下。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

/** 是否运行在打包后的应用里（electron-builder 打出的包）。 */
function isPackaged() {
  try {
    // 只在 Electron 主进程里可用；单独跑 node 时退回开发形态
    const { app } = require('electron');
    return !!app?.isPackaged;
  } catch {
    return false;
  }
}

/** 开发时的仓库根目录（apps/shell/src -> ../../..） */
const DEV_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * 选一个合适的数据目录。
 *
 * **优先非系统盘**：曲库 988MB + 缓存（每首 30-40MB）会很快把 C 盘吃掉，
 * 而 KTV 机的系统盘通常很小。所以按 D-Z 顺序找第一个剩余空间够的固定盘。
 *
 * 也支持显式指定：
 *   KTV_DATA_DIR 环境变量，或命令行 --data-dir=<路径>
 */
/**
 * 列出**本地固定磁盘**（排除网络盘/可移动盘/光驱）。
 *
 * 为什么不用 fs.statfs 直接扫盘符：网络盘（Z:）会返回荒谬的可用空间
 * （实测报 8.5e9 GB），会被"选空间最大的盘"逻辑选中。
 * 所以先用 Windows 的 DriveType 过滤（3 = 本地固定）。
 */
function listFixedDrives() {
  try {
    const out = execFileSync('wmic',
      ['logicaldisk', 'get', 'DeviceID,DriveType,FreeSpace', '/format:csv'],
      { encoding: 'utf8', timeout: 5000 });
    const drives = [];
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (!t || /^Node,/i.test(t)) continue;
      const parts = t.split(',');
      if (parts.length < 4) continue;
      const [, deviceId, driveType, freeSpace] = parts;
      if (driveType !== '3') continue;                 // 3 = 本地固定磁盘
      const free = Number(freeSpace);
      if (!Number.isFinite(free) || free <= 0) continue;
      drives.push({ root: deviceId + '\\', free });
    }
    return drives;
  } catch {
    // wmic 不可用时退回 statfs，但要求可用空间在合理范围内
    const drives = [];
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXY') {
      const root = letter + ':\\';
      try {
        const st = fs.statfsSync(root);
        const free = Number(st.bavail) * Number(st.bsize);
        if (free > 0 && free < 100 * 1024 ** 4) drives.push({ root, free });
      } catch { /* 无此盘 */ }
    }
    return drives;
  }
}

function pickDataRoot(app) {
  const explicit = process.env.KTV_DATA_DIR
    || (process.argv.find((a) => a.startsWith('--data-dir=')) || '').slice('--data-dir='.length);
  if (explicit) return explicit;

  const MIN_FREE_BYTES = 20 * 1024 * 1024 * 1024;   // 留 20GB 余量
  const candidates = listFixedDrives()
    .filter((d) => d.root[0].toUpperCase() !== 'C' && d.free >= MIN_FREE_BYTES)
    .sort((a, b) => b.free - a.free);               // 取剩余空间最大的

  if (candidates.length) return path.join(candidates[0].root, 'KTV点歌系统');

  // 没有合适的非系统盘，退回 AppData（会在 C 盘，但至少能跑）
  return app.getPath('userData');
}

function resolvePaths() {
  if (isPackaged()) {
    const { app } = require('electron');
    const resources = process.resourcesPath;          // <安装目录>/resources
    return {
      packaged: true,
      appRoot: path.join(resources, 'app'),           // 额外打包进去的代码
      runtimeRoot: path.join(resources, 'runtime'),   // libVLC / node.exe
      dataRoot: pickDataRoot(app),                    // 可写数据（优先非系统盘）
      repoRoot: null,
    };
  }
  return {
    packaged: false,
    appRoot: DEV_REPO_ROOT,
    runtimeRoot: path.join(DEV_REPO_ROOT, 'resources', 'runtime'),
    dataRoot: path.join(DEV_REPO_ROOT, 'resources'),
    repoRoot: DEV_REPO_ROOT,
  };
}

const P = resolvePaths();

/** 曲库服务脚本所在目录（打包后是 app/services/catalog）。 */
function catalogServiceDir() {
  return P.packaged
    ? path.join(P.appRoot, 'services', 'catalog')
    : path.join(P.repoRoot, 'services', 'catalog');
}

/** 曲库服务要用的 node 可执行文件。 */
function nodeBin() {
  if (process.env.KTV_NODE_BIN) return process.env.KTV_NODE_BIN;
  const bundled = path.join(P.runtimeRoot, 'node', 'node.exe');
  if (fs.existsSync(bundled)) return bundled;
  return null;   // 交给调用方回退到系统 node
}

/** 内置 libVLC 目录。 */
function vlcDir() {
  if (process.env.KTV_VLC_DIR) return process.env.KTV_VLC_DIR;
  const base = path.join(P.runtimeRoot, 'vlc');
  // 兼容 vlc-<version> 子目录与直接平铺两种布局
  try {
    const entries = fs.readdirSync(base, { withFileTypes: true });
    const sub = entries.find((e) => e.isDirectory() && e.name.startsWith('vlc-'));
    if (sub) return path.join(base, sub.name);
  } catch { /* 目录不存在 */ }
  return base;
}

/** 前端构建产物目录。 */
function webDistDir() {
  return P.packaged ? path.join(P.appRoot, 'web')
    : path.join(P.repoRoot, 'apps', 'web', 'dist');
}

/** 曲库安装目录。 */
function catalogDir() { return path.join(P.dataRoot, 'catalog'); }
/** 用户状态目录。 */
function stateDir() { return path.join(P.dataRoot, 'state'); }
/** 取流配置目录。 */
function configDir() { return path.join(P.dataRoot, 'config'); }
/** 默认缓存/媒体目录。 */
function mediaDir() { return path.join(catalogDir(), 'video', 'cloud-song'); }

module.exports = {
  P, isPackaged, resolvePaths,
  catalogServiceDir, nodeBin, vlcDir,
  webDistDir,
  catalogDir, stateDir, configDir, mediaDir,
  DEV_REPO_ROOT,
};
