/**
 * Electron 主进程
 * ===============
 * 职责：
 *   - 创建主窗口，并在其中嵌入一块原生视频区（Win32 子窗口 + libVLC）
 *   - 拉起曲库服务子进程，把曲库查询能力通过 IPC 暴露给界面
 *   - 维护用户状态（已点队列 / 已唱 / 收藏 / 歌单 / 设置）
 *   - 定时把播放状态推给渲染进程
 *
 * 点歌语义按 KTV 惯例：**点歌是入队，不是立刻插播**。
 * 队列播完当前这首后自动接下一首；想插播用"下一首播放"。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { app, BrowserWindow, ipcMain, screen, dialog, Menu, globalShortcut, shell, safeStorage, session } = require('electron');

const paths = require('./paths');

// ⚠️ 必须关掉 Chromium 的"原生窗口遮挡计算"。
// 我们的视频画面是一个**跨进程的原生子窗口**（mpv 画在自己的 HWND 上，盖在网页之上）。
// Chromium 的 CalculateNativeWinOcclusion 会周期性去问系统"我这个窗口是不是被挡住了"，
// 遇到这种"别人的子窗口压在我上面"的情况它算不对，于是反复改窗口的可见性/节流状态，
// 表现出来就是：**鼠标在窗口上发飘、点了没反应**，而主进程/渲染进程的 CPU 都看不出问题
// （实测主线程 WM_NULL 往返 p99 7.5ms、rAF 稳定 13ms，但鼠标依旧发卡）。
// 关掉之后窗口不再被误判遮挡。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ⚠️ 必须在其它模块 require 之前设好环境变量：
// ktv-api 的 CONFIG_DIR、player 的 VLC_DIR 都是在模块加载时就算出来的，
// 放到 app.whenReady() 里设置已经太晚，会退回开发态路径。
process.env.KTV_VLC_DIR = paths.vlcDir();
process.env.KTV_CONFIG_DIR = paths.configDir();
if (!process.env.KTV_NODE_BIN) {
  const nb = paths.nodeBin();
  if (nb) process.env.KTV_NODE_BIN = nb;
}
const { createPlayer, VideoSurface, cursorPos, leftButtonDown, windowRect } = require('@ktv/player');
const ktvApi = require('@ktv/ktv-api');
const { scanLibrary, resolveLocalMedia, listLocalFilenames } = require('./library');
const { CatalogService } = require('./catalog');
// 曲库安装管线：打包后它在 resources/app/services/catalog，不能用相对仓库路径
const catalogInstaller = require(path.join(paths.catalogServiceDir(), 'src', 'install'));
const { PlaybackSupervisor } = require('./supervisor');
const { LanServer } = require('./lanserver');
const { PlatformAuthService } = require('./platform-auth');
const { CoverService, fetchNeteaseCover } = require('./covers');
const { UserState } = require('./state');
const { LyricsService, parseLrc } = require('./lyrics');
const { writeAssFile } = require('./ass-lyrics');
const { DownloadManager } = require('./downloads');
const separator = require('./separator');
const { repairDir, clearMarks } = require('./repair');
const { isEncrypted, decryptInPlace, markPlain, isPlainMarked } = require('./tsdecrypt');
const onlinePlatforms = require('@ktv/ktv-api/src/providers/platform-registry');
const { runSmoke } = require('./smoke');

const DEV = process.argv.includes('--dev');
const SMOKE = process.argv.includes('--smoke');
// 开发/打包两种形态下的路径解析统一走 paths.js
const REPO_ROOT = paths.DEV_REPO_ROOT;

/** 默认媒体/缓存目录；可在设置里改 */
const DEFAULT_MEDIA_ROOT = paths.mediaDir();
let MEDIA_ROOT = DEFAULT_MEDIA_ROOT;
const DEMO_MEDIA_DIR = path.join(REPO_ROOT, 'testmedia');
const STATE_FILE = path.join(paths.stateDir(), 'user-state.json');

/** 曲库分片清单地址（maidong 公开仓库，不需要凭证） */
const CATALOG_MANIFEST_URL =
  'https://gitee.com/yangyachao-X/maidong-ktv/raw/master/database_publish/database/manifest.json';
/** 曲库安装目录 */
const CATALOG_DIR = paths.catalogDir();

/** @type {BrowserWindow|null} */ let win = null;
/** @type {VideoSurface|null} */ let surface = null;
/** @type {KtvPlayer|null} */ let player = null;
/** @type {CatalogService|null} */ let catalog = null;
/** @type {PlaybackSupervisor|null} */ let supervisor = null;
/** @type {UserState|null} */ let state = null;
/** @type {DownloadManager|null} */ let downloads = null;
/** @type {LanServer|null} */ let lanServer = null;
/** @type {PlatformAuthService|null} */ let platformAuth = null;
/** @type {CoverService|null} */ let covers = null;
let statusTimer = null;
let currentSong = null;
let currentEntryId = null;
let advancing = false;

// 在线媒体任务去重表。
//
// 同一首歌可能同时被三处触发：点歌预缓存、轮到时播放、后台补缓存。
// 没有这两张表时会重复请求接口、重复下载，甚至两个任务同时写同一个 .part 文件。
// resolveJobs 只负责“拿到可播地址”，downloadJobs 负责“整段落盘”；播放只等前者。
const onlineResolveJobs = new Map();
const onlineDownloadJobs = new Map();
// 在线任务的可视化状态：按 songId 记录解析、下载、完成、失败。
// 已点列表通过 queue:list 轮询拿到它，不再出现“点了以后一直没反馈”。
const onlineTaskStates = new Map();

// 原伴唱"双文件"模式：分离出伴奏后，切换靠换文件而不是切音轨/声道
let originalSource = null;        // 当前曲目的原始片源
let accompanimentSource = null;   // 分离出的伴奏文件（没有则为 null）
let usingAccompaniment = false;   // 当前是否在播伴奏文件
let separatingFor = null;        // 正在分离的源（同一时刻只允许一个）
// 正在切原伴唱片源。切换期间 mpv 的 EOF 不能当成"唱完"（见 switchSource）
let switchingSource = false;
let endedDuringSwitch = false;
let separatePending = null;      // 分离期间又来了请求：记下来，等这轮结束再跑
let catalogUpdating = false;     // 曲库更新中（防止并发触发）
/** @type {LyricsService|null} */ let lyrics = null;

function hwndFromBuffer(buf) {
  return process.arch === 'x64' ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

function currentScaleFactor() {
  if (!win) return 1;
  return screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
}

function notify(text, kind = 'warn') {
  if (win && !win.isDestroyed()) win.webContents.send('app:notice', { kind, text });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0b1016',
    title: 'KTV 点歌系统',
    show: !SMOKE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (DEV) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(paths.webDistDir(), 'index.html'));

  win.on('closed', () => { win = null; });
  return win;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runProcess(command, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    const child = spawn(command, args, { windowsHide: true, ...opts });
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, code: -1, out, err: err + e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, out, err }));
  });
}

function separatorSetupScript() {
  return paths.P.packaged
    ? path.join(paths.P.appRoot, 'services', 'separator', 'setup-demucs.ps1')
    : path.join(REPO_ROOT, 'services', 'separator', 'setup-demucs.ps1');
}

/** 按设置构造 libVLC 启动参数。解码方式等属于 libvlc 级选项，只能在建实例时给。 */
function vlcArgsFromSettings() {
  const args = [];
  const st = state.getSettings();
  if (st.videoDecoder === 'software') args.push('--avcodec-hw=none');
  else if (st.videoDecoder === 'hardware') args.push('--avcodec-hw=any');
  if (st.networkCachingMs) args.push(`--network-caching=${st.networkCachingMs}`);
  return args;
}

/** 创建播放器并挂好事件。切换解码方式/播放内核时会再调一次。 */
function buildPlayer() {
  const st = state.getSettings();
  // 同一个 options 同时喂给两个内核：libVLC 认 vlcArgs，mpv 认 hwdec/networkCachingMs，
  // 各自忽略不认识的字段。
  const p = createPlayer({
    core: st.playbackCore,
    vlcArgs: vlcArgsFromSettings(),
    softwareDecode: st.videoDecoder === 'software',
    hwdec: st.videoDecoder === 'software' ? 'no' : (st.videoDecoder === 'hardware' ? 'auto-safe' : 'auto'),
    smoothPlayback: st.smoothPlayback !== false,
    networkCachingMs: st.networkCachingMs,
    volume: st.volume,
  });
  p.attachSurface(surface.handle());

  // 唱完由主进程自己接下一首，不需要通知渲染进程
  // ⚠️ 切原伴唱时我们也会 loadfile。如果目标片源比当前短（AI 分离出的伴奏实测
  // 比原片短 4~7 秒），mpv 会**立刻 EOF** —— 那不是"唱完了"，绝不能顺手切下一首。
  // 用户看到的现象就是"点一下伴唱，歌被切走了"。
  p.on('ended', () => {
    if (switchingSource) { endedDuringSwitch = true; return; }
    onSongFinished('ended');
  });
  p.on('status', (st) => supervisor && supervisor.onStatus(st));
  p.on('error', (st) => supervisor && supervisor.onFailure(st.reason || 'libvlc-error'));
  p.on('stalled', (st) => supervisor && supervisor.onFailure(st.reason || 'stalled'));
  return p;
}

/**
 * 重建播放器（切换硬解/软解、改网络缓冲时用）。
 * libvlc 的这些选项是实例级的，改不了现有实例，只能重建；
 * 重建后恢复到原来的播放位置，用户基本感知不到。
 */
async function recreatePlayer() {
  const old = player;
  let resumePath = null, resumeAt = 0, wasPlaying = false;
  try {
    const st = old.getStatus();
    resumePath = st.filePath; resumeAt = st.time; wasPlaying = st.playing;
  } catch { /* 旧实例已不可用 */ }

  player = buildPlayer();
  if (supervisor) supervisor.player = player;
  try { old.dispose(); } catch { /* 忽略 */ }

  if (resumePath) {
    try {
      player.load(resumePath, { accomp: currentSong?.accomp ?? 0, isStream: /^https?:/i.test(resumePath) });
      if (wasPlaying) player.play();
      if (resumeAt > 1000) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && player.currentTime() < 200) await sleep(200);
        player.seek(resumeAt);
      }
      // 播放器实例是新的，画面歌词要重新挂一次（老的跟着旧实例一起没了）
      if (currentSong && lyrics) {
        applyVideoLyrics(currentSong.id, lyrics.readWordsCache(currentSong.id), lyrics.readCache(currentSong.id));
      }
    } catch (e) { console.warn('[player] 重建后恢复播放失败:', e.message); }
  }
  return true;
}

/**
 * 视频区双击全屏。
 *
 * 为什么不在 HTML 上直接监听：视频是原生 Win32 子窗口、盖在 HTML 之上，
 * 鼠标事件被它吃掉，渲染进程收不到。试过给子窗口加 WS_EX_TRANSPARENT，
 * 样式确实生效（exStyle=0x20）但对**子窗口的命中测试无效**，点击照样被吞。
 * 所以退一步：在主进程侧轮询光标+左键，检测到「视频区内的双击」就通知渲染进程。
 * 只在播放时跑，20ms 一次，两次系统调用，开销可忽略。
 */
let clickTimer = null;
function startClickWatcher() {
  if (clickTimer) return;
  let prevDown = false;
  let lastDownAt = 0;
  let lastX = 0, lastY = 0;
  let lastMoveX = -1, lastMoveY = -1;
  clickTimer = setInterval(() => {
    try {
      if (!surface || !win || win.isDestroyed()) return;
      // 设置/弹窗打开时原生视频窗口只是隐藏；此时绝不能再把设置页里的双击
      // 当成视频双击，否则会误进全屏并把界面锁死。
      if (typeof surface.isVisible === 'function' && !surface.isVisible()) return;
      const p = cursorPos();
      if (win.isFullScreen() && (Math.abs(p.x - lastMoveX) > 3 || Math.abs(p.y - lastMoveY) > 3)) {
        win.webContents.send('ui:activity');
        lastMoveX = p.x; lastMoveY = p.y;
      }
      const down = leftButtonDown();
      if (down && !prevDown) {
        const p = cursorPos();
        const r = windowRect(surface.handle());
        const inside = p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
        const now = Date.now();
        const near = Math.abs(p.x - lastX) < 40 && Math.abs(p.y - lastY) < 40;
        if (inside && near && now - lastDownAt < 450) {
          win.webContents.send('video:dblclick');
          lastDownAt = 0;   // 避免三击被当成两次双击
        } else {
          lastDownAt = now; lastX = p.x; lastY = p.y;
        }
      }
      prevDown = down;
    } catch { /* 窗口销毁中等情况忽略 */ }
  }, 50);
}

function startPlayer() {
  const parentHwnd = hwndFromBuffer(win.getNativeWindowHandle());
  surface = new VideoSurface(parentHwnd, { scaleFactor: currentScaleFactor() });
  win.on('resize', () => { if (surface) surface.scaleFactor = currentScaleFactor(); });

  // 先建监管器（buildPlayer 注册事件时会用到它），再建播放器
  supervisor = new PlaybackSupervisor({
    player: null,
    resolveUrl: (song) => ktvApi.resolvePlayUrl(song),
    notify: (n) => notify(n.text, n.kind === 'ok' ? 'ok' : 'warn'),
  });
  player = buildPlayer();
  supervisor.player = player;

  initDownloads();
  purgeLegacyQqFallbackCaches();
  applyVolumeFromSettings();
  startClickWatcher();
}

/** 初始化/重建缓存下载管理器（缓存路径变化时重建）。 */
function initDownloads() {
  const settings = state.getSettings();
  if (downloads) downloads.clearFinished?.();
  downloads = new DownloadManager({
    mediaRoot: MEDIA_ROOT,
    resolveUrl: (song) => ktvApi.resolvePlayUrl(song),
    currentFilename: () => (currentSong && currentSong.filename) || null,
    onProgress: (task) => pushDownload(task),
    maxBytesPerSecond: settings.cacheMaxBytesPerSecond,
    maxCacheBytes: settings.cacheMaxBytes,
    repairMode: settings.repairMode,
  }).init();
  downloads.pauseWhilePlaying = !!settings.cacheOnlyWhenIdle;
  downloads.isPlaying = () => !!(player && player.isPlayingNow());
}

// ── 局域网手机点歌 ──────────────────────────────────────────
/**
 * 起一个 HTTP 服务给手机点歌用。端口被占用会自动往后试，
 * 所以实际端口以 lanServer.info() 为准。
 */
async function startLanServer() {
  if (lanServer && lanServer.running) return lanServer.info();
  const st = state.getSettings();
  if (st.lanEnabled === false) return { running: false, disabled: true };
  if (!lanServer) {
    lanServer = new LanServer({
      port: st.lanPort,
      status: () => {
        const queue = state.getQueue().filter((q) => q.status === 'waiting' || q.status === 'playing');
        const st2 = player.lastStatus() || player.getStatus();
        return {
          song: currentSong,
          playing: !!st2.playing,
          time: st2.time || 0,
          length: st2.length || 0,
          volume: st2.volume || 0,
          hasNext: state.getQueue().some((q) => q.status === 'waiting'),
          queue: queue.map((q) => ({
            entryId: q.entryId, songId: q.songId, name: q.name, singer: q.singer, status: q.status,
          })),
        };
      },
      hot: (opts) => needCatalog().hot(opts),
      search: (opts) => needCatalog().search(opts),
      order: (songId, opts) => orderSongById(songId, opts),
      /**
       * 手机端播放控制。
       * 只放"点了不会出事"的动作：播放/暂停、切歌、音量、重唱。
       * 刻意**不提供**删除文件、改设置、退出应用这类能力。
       */
      control: async (action, value) => {
        try {
          if (action === 'toggle') { player.togglePlay(); return { ok: true, playing: player.isPlayingNow() }; }
          if (action === 'play') { player.play(); return { ok: true, playing: true }; }
          if (action === 'pause') { player.pause(); return { ok: true, playing: false }; }
          if (action === 'next') { await onSongFinished('skip'); return { ok: true }; }
          if (action === 'replay') { player.seek(0); return { ok: true }; }
          if (action === 'volume') {
            const v = Math.max(0, Math.min(150, Math.round(Number(value) || 0)));
            player.setVolume(v);
            state.updateSettings({ volume: player.getVolume() });
            return { ok: true, volume: player.getVolume() };
          }
          return { ok: false, error: '未知操作: ' + action };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      removeEntry: async (entryId) => {
        const ok = state.removeFromQueue(entryId);
        if (ok && entryId === currentEntryId) await onSongFinished('removed');
        return ok;
      },
    });
  }
  try {
    const info = await lanServer.start();
    console.log('[lan] 手机点歌已开启:', info.url);
    return info;
  } catch (e) {
    console.warn('[lan] 启动失败:', e.message);
    return { running: false, error: e.message };
  }
}

async function stopLanServer() {
  if (!lanServer) return { running: false };
  await lanServer.stop();
  return lanServer.info();
}

/** 设置里改端口/开关后调它：先停再按新配置起 */
async function restartLanServer() {
  await stopLanServer();
  lanServer = null;
  return startLanServer();
}

/** 取曲库服务；没就绪就抛可读错误（IPC 和局域网接口共用）。 */
function needCatalog() {
  if (!catalog || !catalog.ready) throw new Error('曲库服务未就绪');
  return catalog;
}

/**
 * 把逐字歌词编成 ASS 卡拉OK字幕，挂到视频画面上。
 *
 * 为什么要生成文件：mpv 的 OSD 不解析 ASS 覆盖码（见 docs/19），
 * 但 ASS **字幕**原生支持 \k 卡拉OK标签，播放器会自己逐字扫色。
 * 没有逐字数据 / 内核不支持 / 用户关了画面歌词时，回退到逐行 OSD。
 */
let assLyricsActive = false;   // 当前是否挂着逐字 ASS 字幕（决定 OSD 要不要让位）

function applyVideoLyrics(songId, words, lrc) {
  if (!player || !lyrics) return;
  const st = (state && state.getSettings()) || {};
  const on = st.lyricsOnVideo !== false;
  // 有逐字数据就用逐字（能逐字上色），没有就退回逐行 LRC —— 两条路都编成 ASS，
  // 这样"居中 + 滚动"对两种歌词都生效。
  let lines = (Array.isArray(words) && words.length) ? words : parseLrc(lrc);
  const offset = Number(st.lyricsOffsetMs) || 0;
  if (offset && lines.length) {
    lines = lines.map((line) => ({
      ...line,
      time: Math.max(0, Number(line.time || 0) + offset),
      words: Array.isArray(line.words)
        ? line.words.map((w) => ({ ...w, t: Math.max(0, Number(w.t || 0) + offset) }))
        : line.words,
    }));
  }
  const usable = on && lines.length > 0 && player.supportsAssLyrics?.();
  if (!usable) {
    assLyricsActive = false;
    try { player.setSubtitleFile?.(null); } catch { /* 忽略 */ }
    return;
  }
  try {
    const file = writeAssFile(path.join(paths.P.dataRoot, 'lyrics'), songId, lines, {
      position: st.lyricsPos === 'bottom' ? 'bottom' : 'center',
      slideMs: st.lyricsScroll === false ? 0 : undefined,
    });
    if (!file) { assLyricsActive = false; return; }
    player.setSubtitleFile(file);
    assLyricsActive = true;
    // 让 OSD 那条让位，否则和 ASS 字幕重叠成两行
    try { player.setVideoText(''); } catch { /* 忽略 */ }
  } catch (e) {
    assLyricsActive = false;
    console.warn('[lyrics] 生成 ASS 字幕失败:', e.message);
  }
}

function applyVolumeFromSettings() {
  try {
    const s = state.getSettings();
    if (typeof s.volume === 'number') player.setVolume(s.volume);
  } catch { /* 状态未就绪 */ }
}

/** 下载进度节流后推给界面（每个任务最多 2 次/秒）。 */
const lastPush = new Map();
function pushDownload(task) {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  const prev = lastPush.get(task.filename) || 0;
  const finished = task.state === 'done' || task.state === 'failed';
  if (!finished && now - prev < 500) return;
  // 下载完一首就看看队列里有没有需要提前分离的（预分离只对本地文件做）
  if (task.state === 'done') setTimeout(() => { preseparateQueue().catch(() => {}); }, 500);
  lastPush.set(task.filename, now);
  try {
    win.webContents.send('downloads:progress', {
      filename: task.filename, name: task.name, state: task.state,
      received: task.received, total: task.total, error: task.error,
    });
  } catch { /* 销毁中 */ }
}

// ─────────────────────── 播放流程 ───────────────────────

async function songFromEntry(entry) {
  try {
    if (catalog && catalog.ready) {
      const s = await catalog.songById(entry.songId);
      if (s) return s;
    }
  } catch { /* 曲库不可用时退回条目里的快照 */ }
  return {
    id: entry.songId, name: entry.name, singer: entry.singer, lang: entry.lang,
    filename: entry.filename, accomp: entry.accomp,
    playSource: entry.playSource, platform: entry.platform, platformId: entry.platformId, mvId: entry.mvId,
    cover: entry.cover, duration: entry.duration, artist: entry.artist, title: entry.title,
    online: entry.online,
  };
}

/**
 * 片源就绪后的收尾：登记原片源、查已有伴奏、按需自动分离。
 * @param {object} song
 * @param {string} source   实际播放的地址（本地路径或 URL）
 * @param {boolean} isStream
 */
function afterSourceReady(song, source, isStream) {
  originalSource = source;
  usingAccompaniment = false;
  accompanimentSource = null;

  // 在线流要等缓存到本地后才能分离（分离器只认本地文件）
  if (isStream) return;

  const st = state.getSettings();

  // 已经有分离结果就直接用
  if (separator.hasAccompaniment(source)) {
    accompanimentSource = separator.accompanimentPath(source);
    // 挂成外挂音轨（不选中）。之后切原伴唱就是热切换 aid ——
    // 不换文件、不 seek，坏时间戳的 .ts 也不会被 seek 带偏。
    if (typeof player.attachAccompaniment === 'function') {
      player.attachAccompaniment(accompanimentSource).catch(() => false);
    }
    notify("已就绪：这首可以切「伴唱」（使用已分离的伴奏）", "ok");
    // ⚠️ 已有的伴奏可能是老版本产出的残次品：AI 分离那条路会把 MV 的结尾切掉几秒，
    // 切到伴唱时 mpv 立刻 EOF，被上层当成"唱完了"直接切歌。
    // 所以后台核验一次时长；合格的话 needsSeparate 立刻返回 false，不会打扰用户。
    if (st.separationMode && st.separationMode !== 'off') autoSeparate(source, song);
    return;
  }

  if (!st.separationMode || st.separationMode === 'off') return;

  // 后台自动分离，不阻塞播放
  autoSeparate(source, song);
}

/** 后台分离当前曲目的伴奏；完成后再允许切「伴唱」。 */
async function autoSeparate(source, song) {
  // ⚠️ 分离必须**串行**。
  // 原来的判断是「同一首不重复触发」，但换一首歌就会再起一个 demucs ——
  // 两个 demucs 各跑满所有核心，正在播的视频直接被饿死。
  if (separatingFor) {
    if (separatingFor !== source) separatePending = { source, song };
    return;
  }
  // 先问清楚到底要不要做：文件是好的时候直接返回，别每次都弹"正在后台分离"
  let need = true;
  try { need = await separator.needsSeparate(source); } catch { /* 判不了就当需要 */ }
  if (!need) {
    accompanimentSource = separator.accompanimentPath(source);
    return;
  }
  separatingFor = source;
  try {
    const st = state.getSettings();
    notify(`正在后台分离《${song?.name || ""}》的伴奏…`, "ok");
    const r = await separator.separate(source, {
      mode: st.separationMode,
      pluginPath: st.separatorPluginPath,
      device: st.separatorDevice,
      model: st.separatorModel,
    });
    // 期间可能已经切歌，别把旧结果挂到新歌上
    if (originalSource !== source) return;
    if (r.ok) {
      accompanimentSource = r.output;
      notify("伴奏分离完成，可切到「伴唱」", "ok");
    } else {
      notify(`伴奏分离失败：${r.error}`, "warn");
    }
  } finally {
    if (separatingFor === source) separatingFor = null;
    // 跑完再看有没有排队的。只在它**还是当前在播的片源**时才跑：
    // 用户连按切歌时，前面几首已经不唱了，没必要把它们的伴奏也算一遍（每首好几分钟）。
    const next = separatePending;
    separatePending = null;
    if (next && next.source === originalSource) autoSeparate(next.source, next.song);
  }
}

/**
 * 原伴唱**热切换**：把分离出来的伴奏当外挂音轨挂上，然后切 aid。
 *
 * ⚠️ 为什么不换文件：maidong 的 `.ts` 时间戳是坏的，**seek 会偏几秒**
 * （实测 seek 60s 落到 66.4s、seek 120s 落到 121.7s，重封装也修不好）。
 * 老做法"换文件 + seek 回原位置"于是每次切原伴唱都会把音频**快进**过去，
 * 还带一两秒静音。挂成外挂音轨后切 aid 是热切换：不 seek、不断音、位置不动。
 *
 * @returns {Promise<boolean>} true = 已经切好了；false = 需要回退到"换文件"
 */
async function tryHotSwitchVocal(mode) {
  if (!player || typeof player.attachAccompaniment !== 'function' || !accompanimentSource) return false;
  try {
    if (!player.hasAccompanimentTrack?.()) await player.attachAccompaniment(accompanimentSource);
    if (!player.hasAccompanimentTrack?.()) return false;
    player.setVocalMode(mode);
    usingAccompaniment = mode === 'accompaniment';
    return true;
  } catch { return false; }
}
/** 切换到指定片源并把播放位置接上（老路径，libVLC 回退用）。 */
async function switchSource(target, asAccompaniment) {
  const pos = player.currentTime();
  const wasPlaying = player.isPlayingNow();
  usingAccompaniment = asAccompaniment;
  switchingSource = true;
  endedDuringSwitch = false;
  try {
    player.load(target, {
      accomp: currentSong?.accomp ?? 0,
      isStream: /^https?:/i.test(target),
      // 目标是我们自己分离出来的伴奏文件时，强制立体声
      separatedAccompaniment: !!asAccompaniment && target === accompanimentSource,
      // 同一首歌换文件：画面歌词要留着，别被 loadfile 清掉
      keepSubtitles: true,
    });
    if (wasPlaying) player.play();
    if (pos > 1000) {
      // ⚠️ 必须等新片源**真正就绪**再 seek。
      // load() 之后播放器报的 time-pos 还是上一首的值，老代码的
      // "等 currentTime > 200"会立刻通过，seek 落在正在被替换的旧播放项上 ——
      // 用户看到的是"点伴唱之后从头开始播"。
      if (typeof player.waitForLoaded === 'function') await player.waitForLoaded(15000);
      else {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && player.currentTime() < 200) await sleep(200);
      }
      // ⚠️ 目标片源可能比当前这首短。直接 seek 到超过时长的地方，mpv 会立刻 EOF，
      // 上层收到 ended 就把歌切走了（"点伴唱怎么给我切歌了"）。
      // 所以按目标时长夹一下，最多只丢最后半秒。
      let dur = 0;
      try { dur = Number(player.getStatus().duration) || 0; } catch { /* 忽略 */ }
      player.seek(Math.max(0, dur > 1000 ? Math.min(pos, dur - 500) : pos));
    }
    return true;
  } finally {
    switchingSource = false;
    // 切换期间吞掉的 EOF 要复核：真唱完了就补一次收尾，别让队列卡死
    if (endedDuringSwitch) {
      endedDuringSwitch = false;
      let ended = false;
      try { ended = player.getStatus().stateName === 'Ended'; } catch { /* 忽略 */ }
      if (ended) onSongFinished('ended');
    }
  }
}

/** 解析片源并播放：本地文件 -> 在线取流 -> 可读错误。 */
/**
 * maidong 的片源（muse 曲库里的 .ts）必须**下载 + 解密**之后才能播。
 * 在线源（网易云/酷我的 mp4/m4a）不受影响。
 */
function needsDecryptBeforePlay(song) {
  const name = String((song && song.filename) || '');
  if (!/\.ts$/i.test(name)) return false;
  // 曲库来的（source=muse）都是 maidong 的加密片源；本地导入的 .ts 走 ensureDecrypted 兜底
  return true;
}

/**
 * 播放本地文件前确保它是**明文 TS**。
 *
 * 三种情况：
 *   1. 有「已解密」标记 → 直接放行；
 *   2. 是迅雷加密文件 → 就地解密并打标记；
 *   3. **没标记、又不是加密文件** → 可疑。
 *      早期版本会把加密 TS 直接丢给 ffmpeg 重封装：容器变合法了（每 188 字节都是 0x47），
 *      但内容是密文 —— 解码错误、画面大片马赛克，而且光看文件头**分不出来**。
 *      这种情况返回 suspect，让上层重新下载。
 *
 * @returns {Promise<{ok:boolean, decrypted?:boolean, suspect?:boolean, error?:string}>}
 */
async function ensureDecrypted(filePath) {
  try {
    if (!/\.ts$/i.test(filePath)) return { ok: true };
    if (isPlainMarked(filePath)) return { ok: true };
    if (!isEncrypted(filePath)) return { ok: true, suspect: true };
    notify('正在解密片源…', 'ok');
    const r = await decryptInPlace(filePath);
    if (r.ok) {
      markPlain(filePath);
      clearMarks(filePath);            // 内容变了，旧的"已修复"标记不再适用
      if (r.decrypted) console.log('[player] 片源已解密:', path.basename(filePath));
      return { ok: true, decrypted: !!r.decrypted };
    }
    notify('片源解密失败：' + r.error, 'warn');
    return { ok: false, error: r.error };
  } catch (e) {
    console.warn('[player] 解密检查失败:', e.message);
    return { ok: false, error: e.message };
  }
}
function normalizeOnlineSong(item) {
  const id = String(item.id || '').startsWith('online:')
    ? String(item.id)
    : `online:${item.platform}:${item.id}`;
  return {
    id,
    name: item.title || item.name || '在线歌曲',
    title: item.title || item.name || '在线歌曲',
    singer: item.artist || item.singer || '',
    artist: item.artist || item.singer || '',
    lang: item.lang || '',
    filename: null,
    accomp: 0,
    playSource: 'online',
    platform: item.platform,
    platformId: item.id,
    mvId: item.mvId || null,
    cover: item.cover || '',
    duration: Number(item.duration || 0),
    online: true,
  };
}

function normalizeOnlineTitle(text) {
  return String(text || '').toLowerCase().replace(/[\s()[\]【】（）_-]/g, '');
}

async function resolveNeteaseMvFallback(song, quality = 'auto') {
  const keyword = [song.name || song.title, song.singer || song.artist].filter(Boolean).join(' ');
  if (!keyword) return { ok: false, reason: 'NO_PLAYABLE_RESOURCE', error: '没有可用于搜索 MV 的歌名' };
  const search = await onlinePlatforms.searchPlatform('netease', keyword, { page: 1, pageSize: 8, onlyMv: true }, {});
  if (!search.ok || !search.songs?.length) return { ok: false, reason: 'NO_PLAYABLE_RESOURCE', error: '没有找到可播放的 MV' };
  const target = normalizeOnlineTitle(song.name || song.title);
  const exact = search.songs.find((x) => normalizeOnlineTitle(x.title) === target);
  const loose = search.songs.find((x) => normalizeOnlineTitle(x.title).includes(target) || target.includes(normalizeOnlineTitle(x.title)));
  const match = exact || loose || search.songs[0];
  if (!match?.mvId) return { ok: false, reason: 'NO_PLAYABLE_RESOURCE', error: '没有找到可播放的 MV' };
  const r = await onlinePlatforms.resolveMv(match.mvId, 'netease', { quality }, {});
  return r.ok ? { ...r, fallbackPlatform: 'netease' } : r;
}

function safeOnlineId(value) {
  return String(value || 'song').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

function onlineCacheCandidates(song) {
  const base = `online-${safeOnlineId(song.platform)}-${safeOnlineId(song.platformId || song.id)}`;
  return [
    { kind: 'mv', path: path.join(MEDIA_ROOT, base + '-mv.mp4') },
    { kind: 'audio', path: path.join(MEDIA_ROOT, base + '-audio.mp3') },
    { kind: 'audio', path: path.join(MEDIA_ROOT, base + '-audio.m4a') },
  ];
}

function isHlsUrl(url) {
  try { return /\.m3u8$/i.test(new URL(url).pathname); } catch { return /\.m3u8(?:\?|$)/i.test(String(url || '')); }
}

function onlineCacheMetaPath(filePath) { return filePath + '.json'; }

function readOnlineCacheMeta(filePath) {
  try { return JSON.parse(fs.readFileSync(onlineCacheMetaPath(filePath), 'utf8')); } catch { return null; }
}

function writeOnlineCacheMeta(filePath, song, resolved, kind) {
  try {
    fs.writeFileSync(onlineCacheMetaPath(filePath), JSON.stringify({
      songId: song.id, platform: song.platform, sourcePlatform: resolved?.fallbackPlatform || resolved?.sourcePlatform || song.platform,
      source: resolved?.source || '', kind, savedAt: Date.now(),
    }, null, 2), 'utf8');
  } catch { /* 元数据失败不影响播放 */ }
}

function purgeLegacyQqFallbackCaches() {
  try {
    for (const name of fs.readdirSync(MEDIA_ROOT)) {
      if (!/^online-qq-.*-mv\.mp4$/i.test(name)) continue;
      const full = path.join(MEDIA_ROOT, name);
      if (fs.existsSync(onlineCacheMetaPath(full))) continue;
      try { fs.rmSync(full, { force: true }); } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在 */ }
}

function findOnlineCache(song) {
  for (const item of onlineCacheCandidates(song)) {
    try {
      if (fs.statSync(item.path).size <= 0) continue;
      const meta = readOnlineCacheMeta(item.path);
      // 旧版本把“QQ 抓流失败后的网易回退 MP4”缓存成了 online-qq-*.mp4。
      // 这种文件不能再当成 QQ 原生 MV 使用，否则会一直播网易。
      if (song.platform === 'qq' && /\.mp4$/i.test(item.path) && (!meta || meta.sourcePlatform !== 'qq')) continue;
      return item;
    } catch { /* 不存在 */ }
  }
  return null;
}

function mediaHeaders(platform, cookie = '') {
  const referers = { qq: 'https://y.qq.com', kugou: 'https://www.kugou.com', migu: 'https://music.migu.cn', netease: 'https://music.163.com', kuwo: 'https://kuwo.cn' };
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Referer: referers[platform] || referers.netease };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

async function downloadOnlineMedia(song, resolved, kind) {
  // HLS 是分段清单，单独保存 m3u8 没有意义；交给播放器在线播，避免假装“已缓存”。
  if (isHlsUrl(resolved.url)) {
    updateOnlineTask(song, { phase: 'hls', percent: 0, kind, error: '' });
    return { ok: true, stream: true, skipped: true, url: resolved.url, kind };
  }
  const extFromUrl = (() => { try { const e = path.extname(new URL(resolved.url).pathname).toLowerCase(); return e && e.length <= 6 ? e : ''; } catch { return ''; } })();
  const ext = extFromUrl || (kind === 'mv' ? '.mp4' : '.mp3');
  const base = `online-${safeOnlineId(song.platform)}-${safeOnlineId(song.platformId || song.id)}-${kind}`;
  const filename = base + ext;
  const finalPath = path.join(MEDIA_ROOT, filename);
  const partPath = finalPath + '.part';
  try {
    if (fs.statSync(finalPath).size > 0) {
      updateOnlineTask(song, { phase: 'done', percent: 100, filename, kind, cached: true, error: '' });
      if (!fs.existsSync(onlineCacheMetaPath(finalPath))) writeOnlineCacheMeta(finalPath, song, resolved, kind);
      return { ok: true, path: finalPath, filename, kind };
    }
  } catch { /* 下载 */ }
  fs.mkdirSync(MEDIA_ROOT, { recursive: true });
  try { fs.rmSync(partPath, { force: true }); } catch { /* 忽略旧残留 */ }
  updateOnlineTask(song, { phase: 'downloading', filename, kind, received: 0, total: 0, percent: 0, error: '' });
  win?.webContents?.send('downloads:progress', { filename, name: song.name || filename, state: 'downloading', received: 0, total: 0 });
  let received = 0;
  let total = 0;
  try {
    const cookie = platformAuth ? await platformAuth.getCookieHeader(song.platform) : '';
    const res = await fetch(resolved.url, { headers: mediaHeaders(song.platform, cookie), signal: AbortSignal.timeout(180000) });
    if (!res.ok || !res.body) throw new Error('缓存下载失败 HTTP ' + res.status);
    total = Number(res.headers.get('content-length')) || 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      received += chunk.length;
      const percent = total > 0 ? Math.min(99, Math.floor(received / total * 100)) : 0;
      updateOnlineTask(song, { phase: 'downloading', filename, kind, received, total, percent, error: '' });
      win?.webContents?.send('downloads:progress', { filename, name: song.name || filename, state: 'downloading', received, total });
    });
    await pipeline(body, fs.createWriteStream(partPath));
    fs.renameSync(partPath, finalPath);
    writeOnlineCacheMeta(finalPath, song, resolved, kind);
    updateOnlineTask(song, { phase: 'done', filename, kind, received, total: total || received, percent: 100, cached: true, error: '' });
    win?.webContents?.send('downloads:progress', { filename, name: song.name || filename, state: 'done', received, total: total || received });
    return { ok: true, path: finalPath, filename, kind };
  } catch (e) {
    try { fs.rmSync(partPath, { force: true }); } catch { /* 清理失败不影响原错误 */ }
    updateOnlineTask(song, { phase: 'failed', filename, kind, received, total, error: e.message });
    win?.webContents?.send('downloads:progress', { filename, name: song.name || filename, state: 'failed', received, total, error: e.message });
    throw e;
  }
}
async function selectHlsVariant(url, quality = 'auto') {
  if (!url || !quality || quality === 'auto') return { url, quality: 'auto' };
  try {
    const res = await fetch(url, { headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { url, quality: 'auto' };
    const lines = (await res.text()).split(/\r?\n/);
    const target = Number(quality) || 0;
    let best = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
      const m = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      const next = (lines[i + 1] || '').trim();
      if (!m || !next || next.startsWith('#')) continue;
      const height = Number(m[2]) || 0;
      const score = height === target ? 0 : height < target ? (target - height) + 1000 : (height - target) + 2000;
      if (!best || score < best.score) best = { score, url: new URL(next, url).href, quality: String(height) };
    }
    return best || { url, quality: 'auto' };
  } catch { return { url, quality: 'auto' }; }
}

async function resolveQqMvViaWeb(mvId, quality = 'auto') {
  if (!mvId || !BrowserWindow) return { ok: false, reason: 'NO_PLAYABLE_RESOURCE', error: '缺少 QQ MV id' };
  const loginWin = new BrowserWindow({
    show: false,
    width: 1180, height: 760,
    webPreferences: {
      partition: 'persist:ktv-auth-qq',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
  try { loginWin.setSkipTaskbar(true); } catch { /* 忽略 */ }
  let captured = '';
  const capture = (url) => {
    if (!captured && /^https?:\/\/mv\d*\.music\.tc\.qq\.com\/.+\/qmmv_/i.test(String(url || ''))) captured = url;
  };
  const qqSession = session.fromPartition('persist:ktv-auth-qq');
  const onBeforeRequest = (details, callback) => {
    capture(details?.url || '');
    callback({});
  };
  try {
    try { loginWin.webContents.setAudioMuted(true); } catch { /* 忽略 */ }
    try { loginWin.webContents.setFrameRate(1); } catch { /* 忽略 */ }
    qqSession.webRequest.onBeforeRequest({ urls: ['*://*.qq.com/*', '*://*.tc.qq.com/*'] }, onBeforeRequest);

    // 不能 await loadURL：QQ 页面会长期保持连接，实测 loadURL 可以永远不 resolve。
    try { loginWin.loadURL('https://y.qq.com/n/ryqq/mv/' + encodeURIComponent(mvId)).catch(() => {}); } catch { /* 忽略 */ }
    await Promise.race([
      new Promise((resolve) => {
        loginWin.webContents.once('dom-ready', resolve);
        loginWin.webContents.once('did-fail-load', resolve);
      }),
      sleep(2500),
    ]);
    await sleep(800);

    // 隐藏页面不会自动播放。用有限时间尝试点一次播放器 / play()，触发真实媒体请求。
    if (!captured) {
      const trigger = '(() => {'
        + 'const v=document.querySelector("video");'
        + 'if(v){v.muted=true;try{const p=v.play();if(p&&p.catch)p.catch(()=>{});}catch{}}'
        + 'const nodes=[...document.querySelectorAll("button,a,[class*=play],[class*=Play]")];'
        + 'const b=nodes.find((x)=>/播放|play/i.test((x.textContent||"")+" "+String(x.className)));'
        + 'if(b){try{b.click();}catch{}}'
        + 'return v?(v.currentSrc||v.src||""):"";'
        + '})()';
      const src = await Promise.race([
        loginWin.webContents.executeJavaScript(trigger).catch(() => ''),
        sleep(1200).then(() => ''),
      ]);
      capture(src);
    }

    const deadline = Date.now() + 3000;
    while (!captured && Date.now() < deadline) await sleep(200);
    if (!captured) return { ok: false, reason: 'NO_PLAYABLE_RESOURCE', error: 'QQ 网页播放器没有返回视频地址' };
    const selected = await selectHlsVariant(captured, quality);
    return { ok: true, url: selected.url, quality: selected.quality, source: 'qq-web' };
  } catch (e) {
    return { ok: false, reason: 'PLATFORM_UNAVAILABLE', error: 'QQ MV 网页解析失败: ' + e.message };
  } finally {
    try { qqSession.webRequest.onBeforeRequest(null); } catch { /* 忽略 */ }
    if (!loginWin.isDestroyed()) loginWin.destroy();
  }
}async function resolveKuwoAudioFallback(song) {
  const keyword = [song.name || song.title, song.singer || song.artist].filter(Boolean).join(' ');
  if (!keyword) return { ok: false, reason: 'NO_PLAYABLE_RESOURCE', error: '没有可用于搜索音频的歌名' };
  const search = await onlinePlatforms.searchPlatform('kuwo', keyword, { page: 1, pageSize: 8 }, {});
  if (!search.ok || !search.songs?.length) return { ok: false, reason: 'NO_PLAYABLE_RESOURCE', error: '没有找到可播放的音频' };
  const target = normalizeOnlineTitle(song.name || song.title);
  const exact = search.songs.find((x) => normalizeOnlineTitle(x.title) === target);
  const loose = search.songs.find((x) => normalizeOnlineTitle(x.title).includes(target) || target.includes(normalizeOnlineTitle(x.title)));
  const match = exact || loose || search.songs[0];
  const r = await onlinePlatforms.resolveAudio(match.id, 'kuwo', {}, {});
  return r.ok ? { ...r, fallbackPlatform: 'kuwo' } : r;
}

function onlineJobKey(song) {
  return safeOnlineId(song.platform) + ':' + safeOnlineId(song.platformId || song.id);
}

function onlineTaskSnapshot() {
  const out = {};
  for (const [songId, task] of onlineTaskStates) out[songId] = { ...task };
  return out;
}

function updateOnlineTask(song, patch = {}, opts = {}) {
  if (!song?.id) return null;
  const prev = onlineTaskStates.get(song.id) || {
    songId: song.id, name: song.name || song.title || '', phase: 'queued',
    received: 0, total: 0, percent: 0, error: '', updatedAt: Date.now(),
  };
  const next = {
    ...prev, ...patch, songId: song.id,
    name: song.name || song.title || prev.name || '',
    updatedAt: Date.now(),
  };
  if (next.percent == null || Number.isNaN(Number(next.percent))) {
    next.percent = next.total > 0
      ? Math.max(0, Math.min(100, Math.round((next.received || 0) / next.total * 100)))
      : 0;
  }
  onlineTaskStates.set(song.id, next);
  return next;
}

function runOnlineJob(map, key, factory) {
  const existing = map.get(key);
  if (existing) return existing;
  const job = Promise.resolve()
    .then(factory)
    .finally(() => { if (map.get(key) === job) map.delete(key); });
  map.set(key, job);
  return job;
}

function cacheOnlineMedia(song, resolved, kind) {
  const key = onlineJobKey(song);
  return runOnlineJob(onlineDownloadJobs, key, () => downloadOnlineMedia(song, resolved, kind))
    .catch((e) => {
      updateOnlineTask(song, { phase: 'failed', error: e.message || '缓存失败' });
      throw e;
    });
}

/**
 * 只解析在线媒体地址，不下载。
 * 播放链路等待这一步即可起播；QQ 网页抓流可能慢，所以调用方必须先向界面反馈“准备中”。
 */
async function resolveOnlineResource(song, opts = {}) {
  const ctx = { cookie: platformAuth ? await platformAuth.getCookieHeader(song.platform) : '' };
  const quality = state.getSettings().onlineMvQuality || 'auto';
  let r = null;
  let kind = 'audio';
  if (song.mvId) {
    if (song.platform === 'qq') {
      if (opts.announce) notify('正在解析 QQ 音乐 MV…', 'ok');
      r = await resolveQqMvViaWeb(song.mvId, quality);
      // QQ 官方 MV API 现在返回的 host+vkey 已失效（实测 403），
      // 网页也抓不到时不要再走它多等一轮超时，直接回退网易云。
      if (!r?.ok) {
        const fallback = await resolveNeteaseMvFallback(song, quality);
        if (fallback.ok) { r = fallback; kind = 'mv'; }
        else return r;
      }
    } else {
      r = await onlinePlatforms.resolveMv(song.mvId, song.platform, { quality }, ctx);
    }
    if (r.ok) kind = 'mv';
    else if (r.reason === 'AUTH_REQUIRED' || r.reason === 'AUTH_EXPIRED') return r;
    else if (song.platform !== 'netease' && song.platform !== 'qq') {
      const fallback = await resolveNeteaseMvFallback(song, quality);
      if (fallback.ok) { r = fallback; kind = 'mv'; }
    }
  }
  if (!r?.ok) {
    if (song.mvId) return r || { ok: false, reason: 'NO_PLAYABLE_RESOURCE', error: 'MV 地址获取失败' };
    if (song.platform === 'netease') {
      const fallback = await resolveKuwoAudioFallback(song);
      if (fallback.ok) { r = fallback; kind = 'audio'; }
    }
    if (!r?.ok) {
      r = await onlinePlatforms.resolveAudio(song.platformId || song.id, song.platform, {}, ctx);
      kind = 'audio';
    }
  }
  return r?.ok ? { ok: true, resolved: r, kind } : r;
}

function resolveOnlineResourceCached(song, opts = {}) {
  const key = onlineJobKey(song);
  return runOnlineJob(onlineResolveJobs, key, () => resolveOnlineResource(song, opts));
}

/**
 * 预缓存一首在线歌曲。这个函数只被后台调用，绝不能阻塞点歌 IPC。
 */
async function prefetchOnlineItem(song) {
  const cached = findOnlineCache(song);
  if (cached) {
    updateOnlineTask(song, { phase: 'done', percent: 100, kind: cached.kind, cached: true, error: '' });
    return { ok: true, cached: true, path: cached.path, kind: cached.kind };
  }
  updateOnlineTask(song, { phase: 'resolving', percent: 0, error: '' });
  const prepared = await resolveOnlineResourceCached(song, { announce: false });
  if (!prepared.ok) {
    const message = prepared.message || prepared.error || '在线地址解析失败';
    updateOnlineTask(song, { phase: 'failed', error: message });
    return { ...prepared, message };
  }
  if (isHlsUrl(prepared.resolved.url)) {
    updateOnlineTask(song, { phase: 'hls', percent: 0, kind: prepared.kind, error: '' });
    return { ok: true, stream: true, skipped: true, url: prepared.resolved.url, kind: prepared.kind };
  }
  updateOnlineTask(song, { phase: 'downloading', percent: 0, kind: prepared.kind, error: '' });
  return cacheOnlineMedia(song, prepared.resolved, prepared.kind);
}

/**
 * 预缓存已点列表里接下来要唱的在线歌曲。
 * 用户点歌后立即返回，下载在后台进行；轮到它时优先命中本地缓存。
 */
function prefetchOnlineQueue() {
  if (!state || !platformAuth) return { queued: 0 };
  const settings = state.getSettings();
  if (settings.cacheBeforePlay === false) return { queued: 0 };
  const depth = Math.max(0, Math.min(Number(settings.prefetchDepth) || 0, 5));
  if (!depth) return { queued: 0 };
  const items = state.getQueue()
    .filter((q) => q.status === 'waiting' && (q.online || q.playSource === 'online' || q.platform))
    .slice(0, depth);
  let queued = 0;
  for (const q of items) {
    const song = {
      id: q.songId, name: q.name, title: q.title || q.name, singer: q.singer,
      artist: q.artist || q.singer, lang: q.lang, playSource: 'online', online: true,
      platform: q.platform, platformId: q.platformId, mvId: q.mvId,
      cover: q.cover, duration: q.duration,
    };
    if (findOnlineCache(song) || onlineDownloadJobs.has(onlineJobKey(song))) continue;
    queued += 1;
    prefetchOnlineItem(song).catch((e) => {
      console.warn('[online-cache] 预缓存失败:', song.name, e.message);
    });
  }
  return { queued };
}

/**
 * 在线播放。
 *
 * 关键时序：
 *   1. 有本地缓存 -> 直接播本地；
 *   2. 没有缓存 -> 只等“取地址”这一步，立刻起播在线流；
 *   3. 整段缓存交给后台，绝不 await 下载完成。
 *
 * 这样首次播放响应快，第二次点同一首时缓存已经落盘；同时点歌入队会提前触发预缓存。
 */
async function resolveOnlineAndPlay(song) {
  try {
    let cached = findOnlineCache(song);
    let resolved = null;
    let kind = cached?.kind || 'audio';
    if (cached) {
      updateOnlineTask(song, { phase: 'done', percent: 100, kind, cached: true, error: '' });
    } else {
      updateOnlineTask(song, { phase: 'resolving', percent: 0, error: '' });
      const prepared = await resolveOnlineResourceCached(song, { announce: true });
      if (!prepared.ok) {
        const message = prepared.message || prepared.error || '在线地址解析失败';
        updateOnlineTask(song, { phase: 'failed', error: message });
        currentSong = null;
        return { ...prepared, message };
      }
      resolved = prepared.resolved;
      kind = prepared.kind;
      // 解析完成后缓存可能已被后台预缓存任务写好，再查一次避免白白走流。
      cached = findOnlineCache(song);
      if (cached) kind = cached.kind;
    }
    const sourceUrl = cached ? cached.path : resolved.url;
    const cachedFile = cached ? path.basename(cached.path) : null;
    if (cached) {
      updateOnlineTask(song, { phase: 'done', percent: 100, kind, cached: true, error: '' });
    } else {
      updateOnlineTask(song, { phase: isHlsUrl(resolved.url) ? 'hls' : 'streaming', percent: 0, kind, error: '' });
    }
    currentSong = {
      ...song, name: song.name || '在线歌曲', playSource: 'online',
      mediaKind: kind, cachedFile, quality: resolved?.quality || cached?.quality || null,
    };
    supervisor.setSong(currentSong);
    const isStream = !cached;
    player.load(sourceUrl, { accomp: 0, isStream });
    player.play();
    afterSourceReady(currentSong, sourceUrl, isStream);
    if (!cached && resolved && !isHlsUrl(resolved.url) && state.getSettings().cacheBeforePlay !== false) {
      cacheOnlineMedia(song, resolved, kind).catch((e) => {
        notify('在线缓存失败，下次仍会重新获取：' + e.message, 'warn');
      });
    }
    return {
      ok: true, song: currentSong, source: 'online', url: sourceUrl,
      quality: resolved?.quality, kind, cached: !!cached,
    };
  } catch (e) {
    updateOnlineTask(song, { phase: 'failed', error: e.message || '播放失败' });
    currentSong = null;
    return { ok: false, message: e.message };
  }
}

function waitForAdvanceIdle(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (!advancing || Date.now() >= deadline) return resolve(!advancing);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function scheduleOnlinePlayback({ skipCurrent = false } = {}) {
  setTimeout(async () => {
    try {
      await waitForAdvanceIdle();
      const st = player.getStatus();
      const busy = !!st.filePath && st.stateName !== 'Ended' && st.stateName !== 'Stopped';
      if (skipCurrent && busy) await onSongFinished('skip');
      else await playNextInQueue();
    } catch (e) {
      notify('在线播放启动失败：' + e.message, 'warn');
    }
  }, 0);
}

async function orderOnlineItem(item, opts = {}) {
  const song = normalizeOnlineSong(item || {});
  if (!song.platform || !song.id) return { ok: false, message: '缺少在线曲目信息' };
  const meta = onlinePlatforms.listPlatforms().find((p) => p.id === song.platform);
  const cookie = platformAuth ? await platformAuth.getCookieHeader(song.platform) : '';
  if (meta?.needsAuth && !cookie) {
    return { ok: false, reason: 'AUTH_REQUIRED', platform: song.platform, message: '请先登录该平台账号' };
  }
  const r = state.addToQueue(song, { ...opts, next: opts.playNow ? true : opts.next });
  if (r.duplicate) {
    if (!opts.playNow) {
      return { ok: false, duplicate: true, song, message: `《${song.name}》已经在已点列表里了` };
    }
    // 双击已点里的在线歌，或在已点列表里再点“立即唱”：
    // 当前就是它 -> 从头重播；只是等待中 -> 移到当前之后并立即切过去。
    if (r.existing?.status === 'playing' && currentSong?.id === song.id) {
      player.seek(0);
      player.play();
      updateOnlineTask(song, { phase: 'streaming', percent: 0, error: '' });
      return { ok: true, replay: true, song, startedImmediately: true };
    }
    if (r.existing?.status === 'waiting') {
      state.removeFromQueue(r.existing.entryId);
      const again = state.addToQueue(song, { next: true });
      updateOnlineTask(song, { phase: 'queued', percent: 0, error: '' });
      prefetchOnlineQueue();
      scheduleOnlinePlayback({ skipCurrent: true });
      return { ok: true, entry: again.entry, song, preparing: true, willPlay: true, moved: true };
    }
    return { ok: false, duplicate: true, song, message: `《${song.name}》正在播放，不能重复点` };
  }

  // 先返回、再干活：点歌和“立即唱”的 IPC 不能在 QQ MV 抓流/整段下载上等待。
  // 预缓存会覆盖接下来 prefetchDepth 首在线歌，轮到它们时优先直接播本地文件。
  updateOnlineTask(song, { phase: 'queued', percent: 0, error: '' });
  prefetchOnlineQueue();
  const st = player.getStatus();
  const busy = !!st.filePath && st.stateName !== 'Ended' && st.stateName !== 'Stopped';
  const shouldStart = opts.playNow || !busy;
  if (shouldStart) scheduleOnlinePlayback({ skipCurrent: opts.playNow && busy });
  return {
    ok: true, entry: r.entry, song,
    startedImmediately: false,
    preparing: shouldStart,
    willPlay: shouldStart,
  };
}

async function resolveAndPlay(song) {
  if (song.playSource === 'online' || song.platform) return resolveOnlineAndPlay(song);
  let filePath = resolveLocalMedia(MEDIA_ROOT, song.filename);
  if (filePath) {
    const dec = await ensureDecrypted(filePath);
    if (dec.suspect) {
      // 旧缓存：早期版本把加密 TS 直接重封装过，容器合法但内容是密文 → 必须重下
      notify(`《${song.name}》的旧缓存片源异常，正在重新下载…`, 'warn');
      const got = await downloads.fetchNow(song, { force: true });
      const again = got.ok ? resolveLocalMedia(MEDIA_ROOT, song.filename) : null;
      if (again) filePath = again;
      else notify('重新下载失败，将直接播放（画面可能有马赛克）', 'warn');
    }
    currentSong = { ...song, playSource: 'local' };
    supervisor.setSong(currentSong);
    player.load(filePath, { accomp: song.accomp });
    player.play();
    afterSourceReady(currentSong, filePath, false);
    return { ok: true, song: currentSong, source: 'local', filePath };
  }

  // 设置里要求『先缓存再播』时，先把片源下载并修复完再开始，
  // 这样第一次唱就是顺的（代价是起播前要等几秒到十几秒）。
  //
  // ⚠️ maidong 的片源是**迅雷加密 TS**，直接流式播等于把密文喂给播放器（周期性马赛克）。
  // 所以这类片源**强制**先下载 + 解密，不管设置里怎么选。
  if (state.getSettings().cacheBeforePlay || needsDecryptBeforePlay(song)) {
    notify(`正在缓存《${song.name}》…`, 'ok');
    const got = await downloads.fetchNow(song);
    const local = got.ok ? resolveLocalMedia(MEDIA_ROOT, song.filename) : null;
    if (local) {
      currentSong = { ...song, playSource: 'local' };
      supervisor.setSong(currentSong);
      assLyricsActive = false;
      player.load(local, { accomp: song.accomp });
      player.play();
      afterSourceReady(currentSong, local, false);
      return { ok: true, song: currentSong, source: 'local', filePath: local };
    }
    notify(`《${song.name}》缓存失败，改为直接播放：${got.error || '未知原因'}`, 'warn');
    // 落回在线直连
  }

  try {
    const r = await ktvApi.resolvePlayUrl(song);
    currentSong = { ...song, playSource: 'online', provider: r.provider, expiresAt: r.expiresAt };
    supervisor.setSong(currentSong);
    player.load(r.url, { accomp: song.accomp, isStream: true });
    player.play();
    // 播放不等人：后台把这个片源缓存下来，下次点同一首直接播本地
    try { downloads.enqueue(song); } catch (e) { console.warn('[downloads] 入队失败:', e.message); }
    // 在线流这里不做分离：分离器只认本地文件，等缓存完成后再说
    return { ok: true, song: currentSong, source: 'online', url: r.url, provider: r.provider, expiresAt: r.expiresAt };
  } catch (err) {
    currentSong = null;
    return {
      ok: false,
      reason: err.code === 'NO_PROVIDER' ? 'NO_PROVIDER' : 'RESOLVE_FAILED',
      song,
      message: `《${song.name}》无法播放：${err.message}`,
    };
  }
}

/**
 * 预下载队列里接下来要唱的几首。
 *
 * 不预下载的话，"点歌 → 排队 → 轮到才开下 → 边下边播"这条路在网络上稍差时
 * 就是实打实的卡顿；预下载之后轮到它时已经是本地文件，起播只要几十毫秒。
 *
 * 只取 waiting 里最前面的 N 首（N = 设置里的 prefetchDepth）：
 * 用户可能点完又删，预下载太深会白烧带宽和磁盘。
 */
/**
 * 队列预分离：把队列里接下来几首**已经下载到本地**的片源提前分离好。
 *
 * 之前是"播到才分离" —— 轮到那首时伴奏还没做好，用户切「伴唱」会没反应
 * （要么等，要么那首就没伴唱）。原来不敢提前做是因为 CPU 分离一首要 80 秒，
 * 一直占着 CPU 影响播放；现在 GPU 十几秒就完事，提前做完全划算。
 *
 * 仍然**串行**（autoSeparate 内部靠 separatingFor 串行），只对本地文件做；
 * 没下载完的等下载回调再来一次。
 */
let preseparating = false;
async function preseparateQueue() {
  if (preseparating || !state || !downloads) return { queued: 0 };
  const st = state.getSettings();
  if (!st.separationMode || st.separationMode === 'off') return { queued: 0 };
  // 最多提前做 3 首：再多也只是白占磁盘
  const depth = Math.min(Number(st.prefetchDepth) || 0, 3);
  if (depth <= 0) return { queued: 0 };

  const items = state.getQueue().filter((x) => x.status === 'waiting').slice(0, depth);
  const todo = [];
  for (const q of items) {
    const file = resolveLocalMedia(MEDIA_ROOT, q.filename);
    if (!file) continue;                          // 还没下完
    if (separator.hasAccompaniment(file)) continue; // 已经有了
    todo.push({ file, song: { id: q.songId, name: q.name } });
  }
  if (!todo.length) return { queued: 0 };

  preseparating = true;
  try {
    for (const it of todo) {
      // 播到这首了就不用提前做了（autoSeparate 自己会处理）
      if (originalSource === it.file) continue;
      await autoSeparate(it.file, it.song);
    }
  } finally {
    preseparating = false;
  }
  return { queued: todo.length };
}
function prefetchQueue() {
  if (!downloads || !state) return { queued: 0 };
  const depth = Number(state.getSettings().prefetchDepth) || 0;
  if (depth <= 0) return { queued: 0 };
  let queued = 0;
  for (const q of state.getQueue().filter((x) => x.status === 'waiting').slice(0, depth)) {
    try {
      const r = downloads.enqueue({ id: q.songId, filename: q.filename, name: q.name });
      if (r.queued) queued++;
    } catch (e) { console.warn('[downloads] 预下载入队失败:', e.message); }
  }
  return { queued };
}

/**
 * 点歌入队。主机界面（IPC）和**局域网手机点歌**（HTTP）共用这一条路径，
 * 保证去重、排队、起播、缓存的行为完全一致。
 */
async function orderSongById(songId, opts = {}) {
  const song = await needCatalog().songById(songId);
  const r = state.addToQueue(song, opts);
  // 已在队列里就不再排一次，否则"已点"列表会出现重复条目
  if (r.duplicate) {
    return { ok: false, duplicate: true, song, message: `《${song.name}》已经在已点列表里了` };
  }
  // 先预下载接下来要唱的（含刚点的这首），轮到它时就是本地文件了
  prefetchQueue();
  prefetchOnlineQueue();
  // 再把已经下好的那几首的伴奏提前分离（GPU 下一首十几秒）
  preseparateQueue();
  const st = player.getStatus();
  const busy = !!st.filePath && st.stateName !== 'Ended' && st.stateName !== 'Stopped';
  if (!busy) await playNextInQueue();
  return { ok: true, entry: r.entry, startedImmediately: !busy, song };
}

/** 立即唱：当前就是这首则从头重播；否则插到当前之后并立即切过去。 */
async function playNowById(songId) {
  let song = null;
  const queued = state.getQueue().find((q) => q.songId === songId && (q.status === 'waiting' || q.status === 'playing'));
  if (queued) song = await songFromEntry(queued);
  if (!song && String(songId).startsWith('online:')) {
    const h = state.getHistory().find((x) => x.songId === songId);
    if (h) song = { id: h.songId, name: h.name, singer: h.singer, artist: h.artist || h.singer, title: h.title || h.name, playSource: 'online', platform: h.platform, platformId: h.platformId, mvId: h.mvId, cover: h.cover, duration: h.duration, online: true };
  }
  if (!song) song = await needCatalog().songById(songId);
  if (!song) return { ok: false, message: '找不到这首歌' };
  if (currentSong && currentSong.id === songId) {
    player.seek(0);
    player.play();
    return { ok: true, replay: true, song };
  }
  const existing = state.getQueue().find((q) => q.songId === songId && (q.status === 'waiting' || q.status === 'playing'));
  if (existing) state.removeFromQueue(existing.entryId);
  const r = state.addToQueue(song, { next: true });
  prefetchQueue();
  prefetchOnlineQueue();
  preseparateQueue();
  const st = player.getStatus();
  const busy = !!st.filePath && st.stateName !== 'Ended' && st.stateName !== 'Stopped';
  const played = busy ? await onSongFinished('skip') : await playNextInQueue();
  return { ok: true, entry: r.entry, song, started: played?.ok !== false };
}

/** 播放队列里的下一首。队列空则停止。 */
async function playNextInQueue() {
  if (advancing) return { ok: false, reason: 'BUSY' };
  advancing = true;
  try {
    const entry = state.takeNext();
    if (!entry) {
      currentEntryId = null;
      currentSong = null;
      return { ok: false, reason: 'QUEUE_EMPTY' };
    }
    currentEntryId = entry.entryId;
    const song = await songFromEntry(entry);
    const r = await resolveAndPlay(song);
    if (!r.ok) {
      notify(r.message || `《${song.name}》无法播放，已跳过`);
      advancing = false;
      return playNextInQueue();
    }
    return { ok: true, ...r };
  } finally {
    advancing = false;
  }
}

/** 一首结束（自然播完或切歌）后的收尾。 */
async function onSongFinished(reason) {
  if (currentSong) state.markPlayed(currentSong);
  const r = await playNextInQueue();
  if (!r.ok && r.reason === 'QUEUE_EMPTY') {
    currentSong = null;
    player.stop();
  }
  return r;
}

async function migrateCatalog() {
  if (!win || !catalog) return { ok: false, error: '曲库服务未就绪' };
  const picked = await dialog.showOpenDialog(win, {
    title: '选择曲库迁移目标目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, canceled: true };
  const targetRoot = picked.filePaths[0];
  const currentDir = state.getSettings().catalogDir || paths.catalogDir();
  const oldDb = path.join(currentDir, 'muse.db');
  const newDir = path.join(targetRoot, 'KTV Desktop', 'catalog');
  const newDb = path.join(newDir, 'muse.db');
  if (path.resolve(currentDir).toLowerCase() === path.resolve(newDir).toLowerCase()) {
    return { ok: false, error: '目标目录和当前曲库目录相同' };
  }
  if (!fs.existsSync(oldDb)) return { ok: false, error: '当前曲库数据库不存在' };
  try {
    catalog.stop();
    fs.mkdirSync(newDir, { recursive: true });
    win.webContents.send('catalog:progress', { phase: 'migrate', percent: 20, detail: '正在复制曲库数据库…' });
    await fs.promises.copyFile(oldDb, newDb);
    const srcSize = fs.statSync(oldDb).size;
    const dstSize = fs.statSync(newDb).size;
    if (srcSize !== dstSize) throw new Error('复制后的曲库大小不一致');
    win.webContents.send('catalog:progress', { phase: 'migrate', percent: 80, detail: '正在重启曲库服务…' });
    state.updateSettings({ catalogDir: newDir });
    catalog = new CatalogService({ dbPath: newDb });
    await catalog.start();
    try { fs.unlinkSync(oldDb) } catch { /* 旧文件删除失败时保留，不影响新库 */ }
    const versionFile = path.join(currentDir, 'db_version.txt');
    if (fs.existsSync(versionFile)) {
      try { fs.copyFileSync(versionFile, path.join(newDir, 'db_version.txt')); fs.unlinkSync(versionFile) } catch { /* 忽略 */ }
    }
    win.webContents.send('catalog:progress', { phase: 'migrate', percent: 100, detail: '曲库迁移完成' });
    return { ok: true, oldDir: currentDir, newDir };
  } catch (e) {
    try {
      state.updateSettings({ catalogDir: currentDir === paths.catalogDir() ? null : currentDir });
      catalog = new CatalogService({ dbPath: oldDb });
      await catalog.start();
    } catch { /* 保持可读错误 */ }
    return { ok: false, error: e.message };
  }
}

// ─────────────────────── IPC ───────────────────────

function registerIpc() {
  ipcMain.handle('library:defaultDir', () => MEDIA_ROOT);
  ipcMain.handle('library:scan', () => {
    const seen = new Set();
    const all = [];
    for (const dir of [MEDIA_ROOT, DEMO_MEDIA_DIR]) {
      for (const s of scanLibrary(dir)) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        all.push(s);
      }
    }
    return all;
  });
  ipcMain.handle('library:mediaRoot', () => MEDIA_ROOT);
  ipcMain.handle('library:localFileSet', () => [...listLocalFilenames(MEDIA_ROOT)]);

  ipcMain.handle('catalog:migrate', () => migrateCatalog());
  ipcMain.handle('catalog:status', async () => {
    if (!catalog) return { ready: false, error: '曲库服务未启动' };
    if (!catalog.ready) return { ready: false, error: catalog.lastError || '曲库服务未就绪' };
    try { return { ready: true, ...(await catalog.stats()) }; }
    catch (e) { return { ready: false, error: e.message }; }
  });
  ipcMain.handle('catalog:languages', () => needCatalog().languages());
  ipcMain.handle('catalog:singerLetters', (_e, opts) => needCatalog().singerLetters(opts));
  ipcMain.handle('catalog:hot', (_e, opts) => needCatalog().hot(opts));
  ipcMain.handle('catalog:search', (_e, opts) => needCatalog().search(opts));
  ipcMain.handle('catalog:singers', (_e, opts) => needCatalog().singers(opts));
  ipcMain.handle('catalog:singerFacets', () => needCatalog().singerFacets());
  ipcMain.handle('catalog:singerSongs', (_e, id, opts) => needCatalog().songsBySinger(id, opts));
  /** 批量取曲目：收藏/歌单/已唱列表一次拿完，别逐首往返 */
  ipcMain.handle('catalog:songs', (_e, ids) => needCatalog().songsByIds(ids));
  ipcMain.handle('catalog:song', (_e, id) => needCatalog().songById(id));

  /** 点歌：加入队列；若当前空闲则立刻开始播第一首。 */
  ipcMain.handle('queue:order', (_e, songId, opts = {}) => orderSongById(songId, opts));
  ipcMain.handle('queue:orderOnline', (_e, item, opts = {}) => orderOnlineItem(item, opts));

  ipcMain.handle('queue:playNow', (_e, songId) => playNowById(songId));
  ipcMain.handle('queue:list', () => ({
    queue: state.getQueue(),
    currentEntryId,
    currentSong,
    onlineProgress: onlineTaskSnapshot(),
    // 界面用它给曲库列表里的歌标"已点"，避免重复点
    queuedIds: state.getQueue()
      .filter((q) => q.status === 'waiting' || q.status === 'playing')
      .map((q) => q.songId),
  }));
  ipcMain.handle('queue:remove', async (_e, entryId) => {
    const ok = state.removeFromQueue(entryId);
    if (ok && entryId === currentEntryId) await onSongFinished('removed');
    prefetchQueue();
    prefetchOnlineQueue();
    return ok;
  });
  ipcMain.handle('queue:top', (_e, entryId) => state.moveToNext(entryId));
  /** 队列内上移/下移一格（遥控器调顺序用，比拖拽可靠） */
  ipcMain.handle('queue:move', (_e, entryId, delta) => state.moveInQueue(entryId, delta));
  /** 拖拽：一次移到目标位置 */
  ipcMain.handle('queue:moveTo', (_e, entryId, targetEntryId) => state.moveInQueueTo(entryId, targetEntryId));
  ipcMain.handle('queue:clear', () => { state.clearQueue(true); prefetchQueue(); prefetchOnlineQueue(); return state.getQueue(); });

  /** 切歌：把当前记入已唱，播下一首。 */
  ipcMain.handle('player:next', async () => ({ ok: true, ...(await onSongFinished('skip')) }));

  ipcMain.handle('history:list', () => state.getHistory());
  // ── 搜索历史（遥控器输字麻烦，常用词点一下比重新输强）──
  ipcMain.handle('searchHistory:list', () => state.getSearchHistory());
  ipcMain.handle('searchHistory:add', (_e, kw) => state.addSearchHistory(kw));
  ipcMain.handle('searchHistory:remove', (_e, kw) => state.removeSearchHistory(kw));
  ipcMain.handle('searchHistory:clear', () => state.clearSearchHistory());
  // ── 在线收藏（曲库里没有的歌，收藏后不用每次重搜）──
  ipcMain.handle('onlineSaves:list', () => state.getOnlineSaves());
  ipcMain.handle('onlineSaves:add', (_e, item) => { state.addOnlineSave(item); return state.getOnlineSaves(); });
  ipcMain.handle('onlineSaves:remove', (_e, key) => { state.removeOnlineSave(key); return state.getOnlineSaves(); });
  ipcMain.handle('history:remove', (_e, songId) => state.removeHistory(songId));
  ipcMain.handle('history:clear', () => { state.clearHistory(); return true; });

  ipcMain.handle('favorites:toggle', (_e, songId) => ({ favorite: state.toggleFavorite(songId) }));
  ipcMain.handle('favorites:list', () => state.getFavorites());
  ipcMain.handle('favorites:move', (_e, songId, delta) => state.moveFavorite(songId, delta));
  ipcMain.handle('favorites:moveTo', (_e, songId, targetId) => state.moveFavoriteTo(songId, targetId));
  ipcMain.handle('favorites:is', (_e, songId) => state.isFavorite(songId));

  ipcMain.handle('playlists:list', () => state.getPlaylists());
  ipcMain.handle('playlists:create', (_e, name) => { state.createPlaylist(name); return state.getPlaylists(); });
  ipcMain.handle('playlists:delete', (_e, name) => { state.deletePlaylist(name); return state.getPlaylists(); });
  ipcMain.handle('playlists:add', (_e, name, songId) => { state.addToPlaylist(name, songId); return state.getPlaylistSongs(name); });
  /**
   * 把**在线**搜到的歌加进歌单。
   *
   * 歌单里存的是 id 字符串，而在线歌不在曲库里 —— 所以约定：
   *   1. 先把元数据存进「在线收藏」（否则以后没法按 id 还原出歌名）
   *   2. 歌单里存合成 id "online:<platform>:<id>"
   * 列表渲染时按前缀分流：online: 开头查在线收藏，其余走曲库批量查。
   */
  ipcMain.handle('playlists:addOnline', (_e, name, item) => {
    if (!item || !item.platform || !item.id) return state.getPlaylistSongs(name);
    state.addOnlineSave(item);
    state.addToPlaylist(name, 'online:' + item.platform + ':' + item.id);
    return state.getPlaylistSongs(name);
  });
  ipcMain.handle('playlists:remove', (_e, name, songId) => { state.removeFromPlaylist(name, songId); return state.getPlaylistSongs(name); });
  ipcMain.handle('playlists:move', (_e, name, songId, delta) => { state.moveInPlaylist(name, songId, delta); return state.getPlaylistSongs(name); });
  ipcMain.handle('playlists:moveTo', (_e, name, songId, targetId) => { state.moveInPlaylistTo(name, songId, targetId); return state.getPlaylistSongs(name); });
  ipcMain.handle('playlists:songs', (_e, name) => state.getPlaylistSongs(name));

  // ── 缓存下载 ──
  ipcMain.handle('downloads:list', () => downloads.list());
  ipcMain.handle('downloads:stats', () => downloads.stats());
  ipcMain.handle('downloads:clearFinished', () => { downloads.clearFinished(); return downloads.list(); });

  ipcMain.handle('settings:get', () => state.getSettings());
  ipcMain.handle('settings:update', async (_e, patch) => {
    const before = state.getSettings();
    const s = state.updateSettings(patch);

    if (patch && typeof patch.volume === 'number') player.setVolume(patch.volume);
    if (patch && patch.cacheMaxBytesPerSecond !== undefined && downloads) {
      downloads.maxBytesPerSecond = Number(patch.cacheMaxBytesPerSecond);
    }
    if (patch && patch.cacheMaxBytes !== undefined && downloads) {
      downloads.maxCacheBytes = Number(patch.cacheMaxBytes);
    }
    if (patch && patch.cacheOnlyWhenIdle !== undefined && downloads) {
      downloads.pauseWhilePlaying = !!patch.cacheOnlyWhenIdle;
    }
    if (patch && patch.repairMode !== undefined && downloads) {
      downloads.repairMode = patch.repairMode;
    }

    // 缓存目录变了：更新 MEDIA_ROOT 并重建下载管理器
    if (patch && patch.cacheDir !== undefined && patch.cacheDir !== before.cacheDir) {
      MEDIA_ROOT = s.cacheDir ? s.cacheDir : DEFAULT_MEDIA_ROOT;
      initDownloads();
    }

    // 解码方式/网络缓冲是 libvlc 实例级选项，只能重建播放器
    const needRebuild = patch && (
      (patch.videoDecoder !== undefined && patch.videoDecoder !== before.videoDecoder) ||
      (patch.playbackCore !== undefined && patch.playbackCore !== before.playbackCore) ||
      (patch.networkCachingMs !== undefined && patch.networkCachingMs !== before.networkCachingMs) ||
      (patch.smoothPlayback !== undefined && patch.smoothPlayback !== before.smoothPlayback)
    );
    if (needRebuild) await recreatePlayer();

    // 画面歌词开关：关掉就摘掉 ASS 字幕，打开就用缓存里的逐字数据重新挂上
    if (patch.lyricsOnVideo !== undefined && patch.lyricsOnVideo !== before.lyricsOnVideo) {
      if (!patch.lyricsOnVideo) {
        assLyricsActive = false;
        try { player.setSubtitleFile?.(null); } catch { /* 忽略 */ }
      } else if (currentSong && lyrics) {
        applyVideoLyrics(currentSong.id, lyrics.readWordsCache(currentSong.id), lyrics.readCache(currentSong.id));
      }
    }

    // 歌词位置（居中/底部）改了要重新生成 ASS 才生效
    if ((patch.lyricsPos !== undefined && patch.lyricsPos !== before.lyricsPos
         || patch.lyricsScroll !== undefined && patch.lyricsScroll !== before.lyricsScroll)
        && currentSong && lyrics && state.getSettings().lyricsOnVideo !== false) {
      applyVideoLyrics(currentSong.id, lyrics.readWordsCache(currentSong.id), lyrics.readCache(currentSong.id));
    }

    // 手机点歌的开关/端口改了要重启服务才生效
    if ((patch.lanEnabled !== undefined && patch.lanEnabled !== before.lanEnabled) ||
        (patch.lanPort !== undefined && patch.lanPort !== before.lanPort)) {
      await restartLanServer();
    }

    return state.getSettings();
  });

  // ── 曲库在线更新 ──
  /** 查本地版本与远端版本（只读清单，不下载分片）。 */
  ipcMain.handle('catalog:checkUpdate', async () => {
    try {
      const versionFile = path.join(CATALOG_DIR, 'db_version.txt');
      let local = '';
      try { local = fs.readFileSync(versionFile, 'utf8').trim(); } catch { /* 还没装过 */ }

      const cfg = state.getSettings();
      const src = (cfg.catalogSource || CATALOG_MANIFEST_URL).trim();
      const headers = {};
      if (cfg.catalogToken) headers.Authorization = 'Bearer ' + cfg.catalogToken;
      // 本地目录：直接读 manifest.json
      let m;
      if (/^https?:\/\//i.test(src)) {
        const res = await fetch(src, { redirect: "follow", headers, signal: AbortSignal.timeout(20000) });
        if (!res.ok) return { ok: false, error: `清单请求失败 HTTP ${res.status}` };
        m = await res.json();
      } else {
        m = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
      }
      return {
        ok: true,
        localVersion: local || null,
        remoteVersion: String(m.version || ""),
        remoteSize: Number(m.original_size || 0),
        hasUpdate: !!m.version && m.version !== local,
      };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /** 下载并安装曲库更新（分片下载 -> 校验 -> 原子替换）。 */
  ipcMain.handle('catalog:update', async () => {
    if (catalogUpdating) return { ok: false, error: "已经在更新中" };
    catalogUpdating = true;
    try {
      notify("开始更新曲库…", "ok");
      const cfg = state.getSettings();
      const src = (cfg.catalogSource || CATALOG_MANIFEST_URL).trim();
      const headers = {};
      if (cfg.catalogToken) headers.Authorization = 'Bearer ' + cfg.catalogToken;
      const r = await catalogInstaller.installCatalog({
        manifestSource: src,
        targetDir: CATALOG_DIR,
        headers,
        onProgress: (pr) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("catalog:progress", pr);
          }
        },
      });
      notify(`曲库已更新到 ${r.version}，重启应用后生效`, "ok");
      return { ok: true, ...r };
    } catch (e) {
      notify("曲库更新失败：" + e.message, "warn");
      return { ok: false, error: e.message };
    } finally { catalogUpdating = false; }
  });

  // ── 缓存目录与清理 ──
  // ── 在线搜歌 / 搜 MV ──
  /**
   * 在线搜索。曲库（muse.db）搜不到的歌走这里。
   * onlyMv=true 时只返回带官方 MV 的结果。
   */
  // ── 在线平台账号 ──
  ipcMain.handle('auth:status', () => (platformAuth ? platformAuth.status() : {}));
  ipcMain.handle('auth:openLogin', (_e, platform) => (platformAuth ? platformAuth.openLogin(platform) : { ok: false, error: '账号服务未就绪' }));
  ipcMain.handle('auth:importCookie', (_e, platform, cookie) => (platformAuth ? platformAuth.importCookie(platform, cookie) : { ok: false, error: '账号服务未就绪' }));
  ipcMain.handle('auth:logout', (_e, platform) => (platformAuth ? platformAuth.logout(platform) : { ok: false, error: '账号服务未就绪' }));

  ipcMain.handle('online:sources', async () => {
    const auth = platformAuth ? await platformAuth.status() : {};
    return onlinePlatforms.listPlatforms().map((p) => ({ ...p, loggedIn: !!auth[p.id]?.loggedIn }));
  });
  ipcMain.handle('online:hot', async (_e, { platform = 'netease', page = 1, pageSize = 20, onlyMv = false } = {}) => {
    try {
      const ctx = { cookie: platformAuth ? await platformAuth.getCookieHeader(platform) : '' };
      return await onlinePlatforms.hotPlatform(platform, { page, pageSize, onlyMv }, ctx);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('online:search', async (_e, { keyword, page = 1, pageSize = 20, onlyMv = false, platform = 'netease' } = {}) => {
    try {
      const ctx = { cookie: platformAuth ? await platformAuth.getCookieHeader(platform) : '' };
      return await onlinePlatforms.searchPlatform(platform, keyword, { page, pageSize, onlyMv }, ctx);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * 在线点播。MV 走网易云的 mp4 直链；纯歌走酷我的音频直链。
   * 播放的是在线流，不落缓存（缓存管线只认 KTV 曲库的 filename）。
   */
  ipcMain.handle('online:play', async (_e, item = {}) => {
    if (!item || !item.platform) return { ok: false, error: '缺少曲目信息' };
    currentEntryId = null;
    const r = await resolveOnlineAndPlay(normalizeOnlineSong(item));
    return r.ok ? { ok: true, url: r.url, quality: r.quality, kind: r.kind } : r;
  });
  // ── 歌词 ──
  /**
   * 把当前歌词行画到**视频画面里**（libVLC marquee）。
   * 视频是原生子窗口、盖在 HTML 之上，HTML 叠不上去，只能让 libVLC 自己画。
   */
  ipcMain.handle('lyrics:setVideoText', (_e, text) => {
    try {
      // 已经有逐字 ASS 字幕时不要再叠一条 OSD，否则画面上会出现两行歌词
      player.setVideoText(assLyricsActive ? '' : text);
      return true;
    } catch { return false; }
  });

  ipcMain.handle('lyrics:get', async (_e, songId) => {
    if (!lyrics) return { ok: false, error: "歌词服务未就绪" };
    // 优先用当前曲目的信息；否则回曲库查
    let song = currentSong && currentSong.id === songId ? currentSong : null;
    if (!song && catalog && catalog.ready) {
      try { song = await catalog.songById(songId); } catch { /* 忽略 */ }
    }
    if (!song) return { ok: false, error: "找不到曲目" };
    const r = await lyrics.get(song);
    // 拿到逐字时间轴就编成 ASS 卡拉OK字幕挂到画面上（逐行时仍走 marquee/OSD）
    if (r.ok) applyVideoLyrics(songId, r.words, r.lrc);
    return r;
  });

  /** 选 AI 分离插件（.cmd/.bat/.exe/.ps1 都认） */
  ipcMain.handle('separator:install', async () => {
    const script = separatorSetupScript();
    if (!fs.existsSync(script)) return { ok: false, error: '安装脚本未随应用打包：' + script };
    const target = path.join(paths.P.dataRoot, 'plugins', 'demucs');
    notify('正在下载并安装 Demucs，首次约 200–300MB，请稍候…', 'ok');
    const r = await runProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Target', target]);
    const wrapper = path.join(target, 'separate.cmd');
    if (!r.ok || !fs.existsSync(wrapper)) {
      const detail = (r.err || r.out || '').trim().slice(-800);
      return { ok: false, error: detail || ('安装失败（退出码 ' + r.code + '）') };
    }
    state.updateSettings({ separatorPluginPath: wrapper, separationMode: 'plugin' });
    notify('Demucs 插件安装完成', 'ok');
    return { ok: true, pluginPath: wrapper, output: (r.out || '').trim().slice(-800) };
  });

  ipcMain.handle('separator:pickPlugin', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择分离插件',
      properties: ['openFile'],
      filters: [
        { name: '分离插件', extensions: ['cmd', 'bat', 'exe', 'ps1'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return '';
    const file = r.filePaths[0];
    state.updateSettings({ separatorPluginPath: file });
    return file;
  });

  // ── 局域网手机点歌 ──
  ipcMain.handle('lan:info', () => (lanServer ? lanServer.info() : { running: false, disabled: state.getSettings().lanEnabled === false }));
  ipcMain.handle('lan:restart', () => restartLanServer());

  // ── 封面 ──
  /** 查一批封面：同步返回已知的，未知的进后台队列 */
  ipcMain.handle('covers:lookup', (_e, items) => (covers ? covers.lookup(items) : {}));
  ipcMain.handle('covers:stats', () => (covers ? covers.stats() : { count: 0, queued: 0 }));

  ipcMain.handle('cache:dir', () => MEDIA_ROOT);
  /** 缓存文件列表（缓存管理界面用） */
  ipcMain.handle('cache:listFiles', () => (downloads ? downloads.listFiles() : []));
  ipcMain.handle('cache:removeOnline', (_e, songId) => {
    const m = /^online:([^:]+):(.+)$/.exec(String(songId || ''));
    if (!m) return { ok: false, error: '不是在线歌曲' };
    const prefix = 'online-' + safeOnlineId(m[1]) + '-' + safeOnlineId(m[2]) + '-';
    let removed = 0;
    try {
      for (const name of fs.readdirSync(MEDIA_ROOT)) {
        if (!name.startsWith(prefix)) continue;
        try { fs.rmSync(path.join(MEDIA_ROOT, name), { force: true }); removed += 1; } catch { /* 单个失败 */ }
      }
    } catch { /* 目录不存在 */ }
    return { ok: true, removed };
  });

  ipcMain.handle('cache:removeFile', (_e, filename) => {
    if (!downloads) return { ok: false, error: '下载管理器未就绪' };
    const r = downloads.removeFile(filename);
    if (r.ok) {
      // 删掉的正好是当前这首的分离伴奏，就把记账一起清掉，免得下次切伴唱扑空
      if (accompanimentSource && path.basename(accompanimentSource) === path.basename(String(filename))) {
        accompanimentSource = null;
      }
    }
    return r;
  });
  /** 让界面能显示各类数据实际落在哪里 */
  ipcMain.handle('app:paths', () => ({
    packaged: paths.P.packaged,
    dataRoot: paths.P.dataRoot,
    catalogDir: state.getSettings().catalogDir || paths.catalogDir(),
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    mediaRoot: MEDIA_ROOT,
    configDir: paths.configDir(),
    vlcDir: paths.vlcDir(),
  }));
  ipcMain.handle('cache:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择缓存目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: MEDIA_ROOT,
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });
  ipcMain.handle('cache:openDir', async () => {
    try { await shell.openPath(MEDIA_ROOT); return true; } catch { return false; }
  });
  ipcMain.handle('cache:clear', async () => {
    let removed = 0, bytes = 0;
    try {
      for (const name of fs.readdirSync(MEDIA_ROOT)) {
        const full = path.join(MEDIA_ROOT, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          bytes += st.size;
          fs.rmSync(full, { force: true });
          removed++;
        } catch { /* 单个失败不影响整体 */ }
      }
    } catch (e) { return { ok: false, error: e.message }; }
    downloads?.clearFinished?.();
    return { ok: true, removed, bytes };
  });

  // ── 音频分离 ──
  ipcMain.handle('separator:status', async () => {
    const probe = await separator.probeFfmpeg();
    const s = state.getSettings();
    const st = player.getStatus();
    return {
      mode: s.separationMode || 'off',
      ffmpegAvailable: probe.ok,
      ffmpegDetail: probe.detail,
      pluginPath: s.separatorPluginPath || '',
      currentSong: currentSong
        ? { name: currentSong.name, filePath: st.filePath,
            hasAccompaniment: st.filePath ? separator.hasAccompaniment(st.filePath) : false }
        : null,
    };
  });

  /** 对当前正在播的片源做分离，产出伴奏文件。 */
  ipcMain.handle('separator:run', async () => {
    const st = player.getStatus();
    const src = st.filePath;
    if (!src) return { ok: false, error: '当前没有在播放的曲目' };
    if (st.isStream) return { ok: false, error: '在线流不支持分离，请等它缓存到本地后再试' };

    const s = state.getSettings();
    notify('正在分离伴奏，请稍候…', 'ok');
    const r = await separator.separate(src, {
      mode: s.separationMode === 'off' ? 'instant' : s.separationMode,
      pluginPath: s.separatorPluginPath,
      device: s.separatorDevice,
      model: s.separatorModel,
    });
    if (r.ok && originalSource === src) {
      accompanimentSource = r.output;
      notify('伴奏分离完成，可切换到「伴唱」', 'ok');
    } else if (!r.ok) {
      notify('分离失败：' + r.error, 'warn');
    }
    // ⚠️ 这里必须返回分离结果本身。
    // 之前这段被一段"取流服务状态"的代码覆盖了返回值（复制粘贴残留），
    // 界面拿到的是 providers 状态，既看不到成败也看不到产物路径。
    return r;
  });
  /** 取流服务状态：界面据此显示"取流：maidong"或"未配置" */
  ipcMain.handle('providers:status', () => {
    try {
      const cfg = ktvApi.loadConfig();
      const list = ktvApi.availableProviders(cfg).map((p) => p.name);
      return { available: list, configFile: ktvApi.CONFIG_FILE, maidong: cfg.maidong };
    } catch (e) {
      return { available: [], error: e.message };
    }
  });

  ipcMain.handle('providers:ensureTemplate', () => ktvApi.ensureTemplate());
  ipcMain.handle('providers:reload', () => ({
    available: ktvApi.availableProviders(ktvApi.loadConfig()).map((p) => p.name),
  }));

  ipcMain.handle('player:loadLocal', (_e, song) => {
    currentSong = { id: song.id, name: song.name, singer: '本地文件', lang: '', accomp: 0, source: 'local', filename: song.filePath };
    currentEntryId = null;
    supervisor.setSong(currentSong);
    player.load(song.filePath, { accomp: 0 });
    player.play();
    return true;
  });

  ipcMain.handle('player:play', () => { player.play(); return true; });
  ipcMain.handle('player:pause', () => { player.pause(); return true; });
  ipcMain.handle('player:toggle', () => { player.togglePlay(); return true; });
  ipcMain.handle('player:stop', () => { player.stop(); return true; });
  ipcMain.handle('player:seek', (_e, ms) => { player.seek(ms); return true; });
  ipcMain.handle('player:seekRelative', (_e, d) => { player.seekRelative(d); return true; });
  ipcMain.handle('player:setVolume', (_e, v) => {
    player.setVolume(v);
    state.updateSettings({ volume: player.getVolume() });
    return player.getVolume();
  });
  ipcMain.handle('player:setVocalMode', async (_e, mode) => {
    if (accompanimentSource && originalSource && (mode === 'accompaniment' || mode === 'original')) {
      // 优先：外挂音轨 + 切 aid（热切换，不 seek 不断音）
      if (!(await tryHotSwitchVocal(mode))) {
        // 回退（libVLC 内核没有外挂音轨能力）：换文件
        const wantAccomp = mode === 'accompaniment';
        if (wantAccomp !== usingAccompaniment) {
          await switchSource(wantAccomp ? accompanimentSource : originalSource, wantAccomp);
        }
      }
    } else {
      player.setVocalMode(mode);
    }
    if (mode === 'original' || mode === 'accompaniment') state.updateSettings({ defaultVocalMode: mode });
    return true;
  });
  ipcMain.handle('player:setTrack', (_e, id) => { player.selectTrack(id); return true; });
  ipcMain.handle('player:setTrackMapping', (_e, map) => { player.setTrackMapping(map); return true; });
  ipcMain.handle('player:setChannelMapping', (_e, map) => { player.setChannelMapping(map); return true; });
  /**
   * 变调（半音）。只有 mpv 内核支持（rubberband 滤镜）；libVLC 3 没有变调滤波器，
   * 这时返回 false，界面会提示切内核。
   */
  ipcMain.handle('player:setPitch', async (_e, semitones) => {
    // libVLC 3 没有变调滤波器（只有 scaletempo 变速）。
    // 与其让用户自己去设置里换内核，不如**自动切到 mpv** —— mpv 是默认内核、功能是超集，
    // 而且这里的片源（解密后的 TS）本来就是 mpv 处理得最好。
    if (!player.supportsPitch || !player.supportsPitch()) {
      const st = state.getSettings();
      if (st.playbackCore !== 'mpv') {
        state.updateSettings({ playbackCore: 'mpv' });
        await recreatePlayer();
        notify('变调需要 mpv 内核，已自动切换', 'ok');
      }
      if (!player.supportsPitch || !player.supportsPitch()) return { ok: false, reason: 'core-not-support' };
    }
    player.setPitch(semitones);
    return { ok: true, pitch: player.getPitch() };
  });
  /**
   * 变调的**相对**调整。
   * 界面上的 ± 按钮不能自己算 "当前值 + 1" —— 状态是 250ms 轮询推过去的，
   * 连点两下会读到同一个过期值，结果只加 1（实测踩过）。
   * 和 seekRelative 一样，把相对量交给主进程算。
   */
  ipcMain.handle('player:setPitchDelta', (_e, delta) => {
    if (!player.supportsPitch || !player.supportsPitch()) return { ok: false, reason: 'core-not-support' };
    player.setPitch(player.getPitch() + (Number(delta) || 0));
    return { ok: true, pitch: player.getPitch() };
  });
  ipcMain.handle('player:status', () => statusWithSong());

  // ── 窗口全屏 ──
  ipcMain.handle('window:setFullscreen', (_e, on) => {
    if (!win) return false;
    win.setFullScreen(!!on);
    if (on) {
      // 全屏后布局会变，等一帧再让渲染进程重新上报视频区
      setTimeout(() => { if (surface) surface.scaleFactor = currentScaleFactor(); }, 200);
    }
    return true;
  });

  ipcMain.handle('video:setBounds', (_e, rect) => { if (surface) surface.setBounds(rect); return true; });
  ipcMain.handle('video:setVisible', (_e, visible) => {
    if (!surface) return false;
    visible ? surface.show() : surface.hide();
    return true;
  });
}

function statusWithSong() {
  // 复用播放器内部轮询刚取到的状态：再调一次 getStatus() 等于把
  // 每秒对 libVLC 的加锁调用翻倍，实测会直接拖慢解码。
  const st = player.lastStatus() || player.getStatus();
  // 一次取队列，避免每 250ms 重复分配（这个函数被状态推送高频调用）
  const queued = state
    ? state.getQueue().filter((q) => q.status === 'waiting' || q.status === 'playing')
    : [];
  return {
    ...st,
    song: currentSong,
    playable: !!st.filePath,
    queueLength: queued.filter((q) => q.status === 'waiting').length,
    // 已在队列里的曲目 id：界面据此把列表里的歌标成"已点"并禁止重复点
    queuedIds: queued.map((q) => q.songId),
    cache: downloads ? downloads.stats() : null,
    hasAccompaniment: !!accompanimentSource,
    usingAccompaniment,
  };
}

let lastWindowTitle = '';
function pushStatus() {
  if (!win || win.isDestroyed() || !player) return;
  try { win.webContents.send('player:status', statusWithSong()); } catch { /* 销毁中 */ }
  // 把歌名写进窗口标题。
  // ⚠️ 控制条里那块歌名在窄窗口会被挤成 0 宽（音量/快进/变调都要位置），
  // 在线 MV 又不在任何列表里 —— 不写标题的话用户就完全看不到"正在播什么"了。
  const title = currentSong ? `KTV 点歌系统 — ${currentSong.name}` : 'KTV 点歌系统';
  if (title !== lastWindowTitle) {
    lastWindowTitle = title;
    try { win.setTitle(title); } catch { /* 销毁中 */ }
  }
}


app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  if (DEV) {
    globalShortcut.register('F12', () => {
      const w = BrowserWindow.getFocusedWindow();
      if (w) w.webContents.toggleDevTools();
    });
  }

  state = new UserState(STATE_FILE).load();
  lyrics = new LyricsService({ cacheDir: path.join(paths.P.dataRoot, 'lyrics') }).init();
  // 老缓存后台补到逐字数据时，如果正是当前这首歌，立刻把卡拉OK字幕挂上去
  lyrics.onWordsReady = (songId, words) => {
    if (currentSong && currentSong.id === songId) applyVideoLyrics(songId, words, lyrics.readCache(songId));
  };
  try { ktvApi.ensureTemplate(); } catch (e) { console.warn('[providers] 配置模板写入失败:', e.message); }

  createWindow();
  platformAuth = new PlatformAuthService({
    filePath: path.join(paths.stateDir(), 'platform-auth.json'),
    safeStorage,
    session,
    BrowserWindow,
    parentWindow: win,
  });
  try {
    startPlayer();
  } catch (err) {
    dialog.showErrorBox('播放器初始化失败',
      `${err.message}\n\n请先执行 poc/player/fetch-vlc.ps1 获取 libVLC 运行时。`);
    app.quit();
    return;
  }
  registerIpc();

  // 修复历史上缓存下来的、带损坏包的 .ts 片源（后台顺序执行，不阻塞启动）。
  // maidong 的片源普遍带损坏包，不修复就会一直一卡一卡。
  repairDir(MEDIA_ROOT, { mode: state.getSettings().repairMode })
    .then((r) => { if (r.repaired || r.failed) console.log(`[repair] 启动修复：修复 ${r.repaired} 个，失败 ${r.failed} 个`); })
    .catch(() => { /* 修复失败不影响播放 */ });

  const catalogDirOverride = state.getSettings().catalogDir;
  catalog = new CatalogService(catalogDirOverride ? { dbPath: path.join(catalogDirOverride, 'muse.db') } : {});
  catalog.start().catch((err) => { console.error('[catalog] 启动失败:', err.message); });

  // 封面服务：曲库没有封面数据，按歌名+歌手去网易云查，按 songId 永久缓存
  covers = new CoverService({
    cacheFile: path.join(paths.P.dataRoot, 'covers', 'covers.json'),
    fetchCover: fetchNeteaseCover,
  }).init();
  // 解析完一张就推给界面（封面是一个一个冒出来的，不阻塞列表）
  covers.onReady = (songId, url) => {
    try { win?.webContents?.send('covers:ready', { songId, url }); } catch { /* 销毁中 */ }
  };

  // 局域网手机点歌（失败不影响主流程）
  startLanServer().catch((e) => console.warn('[lan] 启动异常:', e.message));

  statusTimer = setInterval(pushStatus, 250);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  // 启动后如果队列里还有上次没唱完的歌，自动接着播。
  // 不做这一步的话，那些条目会一直挂着「已点」标却永远不播：
  // takeNext() 会跳过 playing 状态的条目，而用户重新点又会被重复校验拦下。
  if (state.getQueue().length) {
    // 重启后接着播之前，也把接下来几首预下载上（上次没下完的这次补上）
    setTimeout(() => { prefetchQueue(); prefetchOnlineQueue(); playNextInQueue().catch(() => {}); }, 1500);
  }

  // --play=<musicNo>：启动后自动播一首（kiosk 与自测用）
  const playArg = process.argv.find((a) => a.startsWith('--play='));
  if (playArg) {
    const musicNo = playArg.slice('--play='.length);
    setTimeout(async () => {
      try {
        const song = await catalog.songByMusicNo(musicNo);
        if (!song) { notify("找不到曲目 " + musicNo); return; }
        state.addToQueue(song, {});
        await playNextInQueue();
      } catch (e) { notify("自动播放失败：" + e.message); }
    }, 3000);
  }

  if (SMOKE) {
    runSmoke({ win, player, surface, libraryDir: DEMO_MEDIA_DIR, catalog: () => catalog, state })
      .then((code) => {
        if (statusTimer) clearInterval(statusTimer);
        player.dispose(); surface.destroy(); if (catalog) catalog.stop(); if (state) state.flush();
        app.exit(code);
      })
      .catch((err) => { console.error('冒烟测试异常:', err); app.exit(1); });
  }
});

app.on('window-all-closed', () => {
  stopLanServer().catch(() => {});
  globalShortcut.unregisterAll();
  if (clickTimer) { clearInterval(clickTimer); clickTimer = null; }
  if (statusTimer) clearInterval(statusTimer);
  if (player) player.dispose();
  if (surface) surface.destroy();
  if (catalog) catalog.stop();
  if (state) state.flush();
  app.quit();
});
