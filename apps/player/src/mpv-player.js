/**
 * MpvPlayer —— 基于 mpv 的播放内核
 * =================================
 * 为什么要做这个后端：maidong 分发的 .ts 片源里有周期性损坏段（详见
 * docs/16-mv-stutter-root-cause.md）。libVLC 的 TS 解复用器遇到这种片源，
 * 要么丢帧（视频 15fps），要么让音频输出在 ~100 秒后彻底停摆，两条路都不可用。
 * mpv 用的是 ffmpeg 系解复用/解码（和 Android 端 IJK 同源），同一份片源
 * 实测 29.1fps、丢帧 0、音频全程正常。
 *
 * 本类对外暴露与 KtvPlayer **完全一致**的接口，上层业务（队列、缓存、歌词、
 * 原伴唱切换）不需要知道底下换过内核。
 *
 * 通信方式：mpv 的 JSON IPC（Windows 命名管道）。
 *   - 命令行参数只在启动时生效（--wid/--hwdec 等）
 *   - 播放中要改的东西一律走 IPC（aid / af / volume / pause / osd-msg1）
 */
'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { State, AudioChannel } = require('./vlc-ffi');
const { channelMapForAccomp, resolveTrackMap } = require('./vocal');

/** mpv 可执行文件：优先环境变量，其次随包分发的运行时 */
function resolveMpvPath() {
  if (process.env.MPV_PATH && fs.existsSync(process.env.MPV_PATH)) return process.env.MPV_PATH;
  const repo = path.resolve(__dirname, '..', '..', '..');
  const candidates = [
    path.join(repo, 'resources', 'runtime', 'mpv', 'mpv.exe'),
    path.join(process.resourcesPath || '', 'runtime', 'mpv', 'mpv.exe'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

/** 声道 -> mpv 的 pan 滤镜。用等值 pan 代替"清空"，避免 af clr 的兼容问题。 */
/** 半音 -> 频率比（+12 半音 = 2 倍频） */
function pitchRatio(semitones) {
  return Math.pow(2, Number(semitones) / 12);
}

const PAN_GRAPH = {
  left: 'pan=stereo|c0=c0|c1=c0',
  right: 'pan=stereo|c0=c1|c1=c1',
  stereo: 'pan=stereo|c0=c0|c1=c1',
  // 在线 MV 通常只有一条立体声音轨，人声居中。切伴唱时做中置消除兜底，
  // 让在线 MV 的「伴唱」也有实际效果；本地左右声道型片源仍走原声道映射。
  centerCancel: 'pan=stereo|c0=0.75*c0-0.25*c1|c1=0.75*c1-0.25*c0,volume=1.35',
};

/**
 * mpv JSON IPC 客户端。
 * 命令与事件都是「一行一个 JSON」，用 request_id 对应请求。
 */
class MpvIpc extends EventEmitter {
  constructor(pipeName) {
    super();
    this.pipeName = pipeName;
    this.sock = null;
    this._buf = '';
    this._seq = 0;
    this._pending = new Map();
    this._observers = new Map();
    this._closed = false;
  }

  connect(timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tryOnce = () => {
        if (this._closed) return reject(new Error('IPC 已关闭'));
        const sock = net.connect(this.pipeName);
        const onErr = () => {
          sock.destroy();
          if (Date.now() > deadline) return reject(new Error('连接 mpv IPC 超时'));
          setTimeout(tryOnce, 200);
        };
        sock.once('error', onErr);
        sock.once('connect', () => {
          sock.removeListener('error', onErr);
          this._attach(sock);
          resolve();
        });
      };
      tryOnce();
    });
  }

  _attach(sock) {
    this.sock = sock;
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => this.emit('socket-error', e));
    sock.on('close', () => { this.sock = null; this.emit('closed'); });
  }

  _onData(d) {
    this._buf += d.toString('utf8');
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).trim();
      this._buf = this._buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.event) {
        this.emit('event', msg);
        if (msg.event === 'property-change' && msg.id != null) {
          this._observers.set(msg.id, msg.data);
          this.emit('property:' + msg.id, msg.data);
        }
        continue;
      }
      const rid = msg.request_id;
      if (rid != null && this._pending.has(rid)) {
        this._pending.get(rid)(msg);
        this._pending.delete(rid);
      }
    }
  }

  /** 发一条命令，resolve 出 { data, error }。 */
  send(command, timeoutMs = 8000) {
    if (!this.sock) return Promise.resolve({ error: 'ipc-not-connected' });
    const id = ++this._seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); resolve({ error: 'timeout' }); }
      }, timeoutMs);
      this._pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      try { this.sock.write(JSON.stringify({ command, request_id: id }) + '\n'); }
      catch (e) { clearTimeout(timer); this._pending.delete(id); resolve({ error: e.message }); }
    });
  }

  getProp(name) { return this.send(['get_property', name]).then((r) => r.data); }

  observe(id, name) {
    this._observers.set(id, undefined);
    return this.send(['observe_property', id, name]);
  }

  observed(id) { return this._observers.get(id); }

  close() {
    this._closed = true;
    try { this.sock?.destroy(); } catch { /* 忽略 */ }
    this.sock = null;
    for (const [, fn] of this._pending) fn({ error: 'closed' });
    this._pending.clear();
  }
}

module.exports = { resolveMpvPath, PAN_GRAPH, MpvIpc };

// ── 属性观察 id（mpv observe_property 用整数 id 回传）──
const OBS = {
  timePos: 1, duration: 2, pause: 3, eofReached: 4, idleActive: 5,
  trackList: 6, videoParams: 7, volume: 8, aid: 9,
  pausedForCache: 10, coreIdle: 11, frameDrop: 12, decoderDrop: 13, path: 14, frameNumber: 15,
};

const POLL_INTERVAL_MS = 250;
const STALL_THRESHOLD_MS = 6000;
const PROGRESS_THRESHOLD_MS = 1000;

/** 按枚举值反查名字（State/AudioChannel 都是 value -> name） */
function nameOf(enumObj, value) {
  const key = Object.keys(enumObj).find((k) => enumObj[k] === value);
  return key || 'Unknown';
}

let pipeSeq = 0;

class MpvPlayer extends EventEmitter {
  constructor(options = {}) {
    super();
    this._mpvPath = options.mpvPath || resolveMpvPath();
    this._softwareDecode = !!options.softwareDecode;
    this._hwdec = options.hwdec || (this._softwareDecode ? 'no' : 'auto');
    this._networkCachingMs = Number(options.networkCachingMs || 0);
    // 流畅模式：显示刷新率不是片源帧率的整数倍时（例如 30fps 片源 + 75Hz 显示器），
    // 每帧停留的刷新次数变成 3:2:3:2 的锯齿 —— 肉眼就是"一卡一卡的"。
    // 打开插值 + display-resample 让 mpv 按显示节奏补帧，抖动消失。
    // 实测本机 display-fps=74.97、片源 30fps，开之前有明显的规律性顿挫。
    this._smooth = options.smoothPlayback !== false;
    this._volume = Number.isFinite(options.volume) ? options.volume : 80;

    this.surfaceHwnd = null;
    this.filePath = null;
    this.isStream = false;

    this.proc = null;
    this.ipc = null;
    this._ready = null;          // Promise，等待 mpv 起来并连上 IPC

    this._strategy = 'channel';
    this._trackMap = null;
    this._accomp = 0;
    this._channelMap = channelMapForAccomp(0);
    this._vocalMode = 'original';
    this._forceStereo = false;
    this._videoText = null;
    this._pitchSemitones = 0;   // 变调（半音），0 = 不变调
    this._panKey = 'stereo';
    this._afGraph = PAN_GRAPH.stereo;

    this._lastState = null;
    this._lastStatus = null;
    this._lastTime = 0;
    this._stallMs = 0;
    this._stallReported = false;
    this._hasProgressed = false;
    this._endError = null;
    this._eof = false;
    this._pendingSeek = 0;
    this._loaded = false;      // 当前片源是否已经 file-loaded
    this._loadWaiters = [];
    this._accompFile = null;   // 外挂的分离伴奏文件
    this._accompAid = null;    // 它在 mpv 里的 aid
    this._accompApplying = null;
    // 期望的暂停态。main.js 是 load()/play() 同步连调、不等 Promise，
    // 所以不能靠"loadfile 之后再无条件 set pause"，必须记一个期望值。
    this._desiredPaused = true;

    this._timer = null;
  }

  // ── 进程与 IPC ──────────────────────────────────────────────
  _ensureProc() {
    if (this._ready) return this._ready;
    if (!this._mpvPath) {
      this._ready = Promise.reject(new Error('找不到 mpv.exe（可设 MPV_PATH 环境变量）'));
      this._ready.catch(() => {});
      return this._ready;
    }
    const pipe = `\\\\.\\pipe\\ktv-mpv-${process.pid}-${++pipeSeq}`;
    const args = [
      // ⚠️ 必须关掉终端输出：mpv 会把状态行写到 stdout/stderr，
      // 管道缓冲写满后 mpv 会阻塞（表现为播到 2 分钟左右整个冻住）。
      '--terminal=no',
      '--no-config',
      '--idle=yes',
      '--force-window=no',
      '--osc=no', '--osd-bar=no',
      '--input-default-bindings=no', '--input-vo-keyboard=no',
      '--keep-open=no',
      '--pause=yes',                       // load 后停住，由 play() 决定何时开始
      '--input-ipc-server=' + pipe,
      // 歌词条：贴底、留边距，和 libVLC 版 marquee(Position=8, Y=64) 的观感对齐
      '--osd-level=1', '--osd-duration=3600000', '--osd-font-size=44',
      '--osd-align-y=bottom', '--osd-margin-y=48',
      '--hwdec=' + this._hwdec,
      '--volume=' + this._volume,
      // ⚠️ 必须关掉 mpv 的自动隐藏光标。
      // mpv 默认 --cursor-autohide=1000：鼠标停在画面上 1 秒就 SetCursor(NULL)，
      // 内嵌子窗口里这套隐藏/恢复很容易和系统抢光标，表现为"鼠标卡住不动/看不见"。
      '--cursor-autohide=no',
    ];
    if (this._smooth) {
      args.push('--interpolation=yes', '--video-sync=display-resample', '--tscale=oversample');
    }
    if (process.env.KTV_MPV_LOG) {
      args.push('--log-file=' + process.env.KTV_MPV_LOG, '--msg-level=all=v');
    }
    if (this.surfaceHwnd) args.push('--wid=' + this.surfaceHwnd);
    if (this._networkCachingMs) {
      // ⚠️ 两个坑：
      //   1. 不要 `--cache=yes`。mpv 默认的 `--cache=auto` 已经是"网络流开缓存、
      //      本地文件不开"，强制 yes 只会给本地文件套一层没用的缓存线程。
      //   2. 不要把设置里的 networkCachingMs（默认 1500）直接当 --cache-secs。
      //      那等于在线 MV 只有 **2 秒**缓冲 —— 网络一抖就卡成幻灯片。
      //      mpv 自己对网络流的默认是 10 秒，这里以 10 秒为下限。
      const secs = Math.max(10, Math.round(this._networkCachingMs / 1000));
      args.push('--cache-secs=' + secs, '--demuxer-max-bytes=150MiB');
    }
    const proc = spawn(this._mpvPath, args, { windowsHide: true });
    proc.on('exit', (code) => { this.proc = null; console.warn('[mpv] 进程退出 code=' + code); });
    this._mpvLog = [];
    proc.stdout.on('data', () => { /* 必须排空，否则管道满了会阻塞 mpv */ });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      for (const line of s.split('\n')) {
        if (!line.trim()) continue;
        this._mpvLog.push(line);
        if (this._mpvLog.length > 200) this._mpvLog.shift();
        if (/error|fail|warn/i.test(line)) console.warn('[mpv] ' + line.slice(0, 200));
      }
    });
    this.proc = proc;

    const ipc = new MpvIpc(pipe);
    this.ipc = ipc;
    ipc.on('event', (ev) => this._onMpvEvent(ev));
    ipc.on('closed', () => { console.warn('[mpv] IPC 连接关闭'); if (this._ready) this.emit('ipc-closed'); });
    ipc.on('socket-error', (e) => console.warn('[mpv] IPC 错误: ' + e.message));

    this._ready = (async () => {
      await ipc.connect();
      await Promise.all([
        ipc.observe(OBS.timePos, 'time-pos'),
        ipc.observe(OBS.duration, 'duration'),
        ipc.observe(OBS.pause, 'pause'),
        ipc.observe(OBS.eofReached, 'eof-reached'),
        ipc.observe(OBS.idleActive, 'idle-active'),
        ipc.observe(OBS.trackList, 'track-list'),
        ipc.observe(OBS.videoParams, 'video-params'),
        ipc.observe(OBS.volume, 'volume'),
        ipc.observe(OBS.aid, 'aid'),
        ipc.observe(OBS.pausedForCache, 'paused-for-cache'),
        ipc.observe(OBS.coreIdle, 'core-idle'),
        ipc.observe(OBS.frameDrop, 'frame-drop-count'),
        ipc.observe(OBS.decoderDrop, 'decoder-frame-drop-count'),
        ipc.observe(OBS.path, 'path'),
      ]);
      if (!this._timer) this._startPolling();
      // 歌词可能比播放器先就绪（点歌那一刻就去取歌词了），起来后补挂一次
      await this._applySubtitle().catch(() => {});
      return true;
    })();
    this._ready.catch(() => {});
    return this._ready;
  }

  _onMpvEvent(ev) {
    if (ev.event === 'end-file') {
      const reason = ev.reason || '';
      if (reason === 'error') {
        this._endError = ev.error || 'mpv-end-file-error';
        this.emit('error', { ...(this._lastStatus || {}), reason: this._endError });
      } else if (reason === 'eof') {
        this._eof = true;
      }
    } else if (ev.event === 'start-file') {
      this._endError = null;
      this._eof = false;
      this._hasProgressed = false;
    } else if (ev.event === 'file-loaded') {
      this._loaded = true;
      for (const w of this._loadWaiters.splice(0)) w(true);
      this._applyAccompaniment().catch(() => {});
      // ⚠️ 外挂字幕必须等新片源**真正就绪**之后再挂。
      // loadfile 之后立刻 sub-add，有时会挂到正在被替换掉的旧播放项上，
      // 表现就是"切到伴唱之后画面歌词没了"。
      this._applySubtitle().catch(() => {});
    }
  }

  /** 绑定视频承载窗口句柄（来自 win32.VideoSurface）。 */
  attachSurface(hwnd) {
    if (this.surfaceHwnd === hwnd) return;
    this.surfaceHwnd = hwnd;
    // --wid 只在启动时生效，换了宿主窗口就得重启进程
    if (this._ready) this._restartProc();
  }

  _restartProc() {
    const wasPlaying = this.isPlayingNow();
    const pos = this._timePos || 0;
    const file = this.filePath;
    const accomp = this._accomp;
    const forceStereo = this._forceStereo;
    this._killProc();
    if (file) {
      this.load(file, { accomp, separatedAccompaniment: forceStereo });
      if (wasPlaying) this.play();
      if (pos > 0) this.seek(pos);
    }
  }

  _killProc() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    try { this.ipc?.close(); } catch { /* 忽略 */ }
    try { this.proc?.kill(); } catch { /* 忽略 */ }
    this.ipc = null;
    this.proc = null;
    this._ready = null;
    this._subId = null;      // 新进程没有旧字幕轨，别留着一个失效的 id
    this._accompAid = null;  // 外挂音轨同理
    this._loaded = false;
    for (const w of this._loadWaiters.splice(0)) w(false);
  }

  // ── 片源 ────────────────────────────────────────────────────
  /**
   * 载入片源。source 可以是本地路径，也可以是 http(s) URL（在线取流）。
   * @param {string} source
   * @param {{accomp?: number, isStream?: boolean, separatedAccompaniment?: boolean}} [opts]
   */
  load(source, opts = {}) {
    const prevAccompAid = this._accompAid;
    const keepAccompaniment = !!opts.keepAccompaniment;
    this._desiredPaused = true;   // 与 libVLC 语义一致：load 不自动播
    this.filePath = source;
    this.isStream = /^https?:\/\//i.test(String(source)) || !!opts.isStream;
    this._accomp = Number(opts.accomp ?? 0);
    this._channelMap = channelMapForAccomp(this._accomp);
    this._forceStereo = !!opts.separatedAccompaniment;
    this._trackMap = null;
    this._strategy = 'channel';
    this._vocalMode = 'original';
    this._videoText = null;
    // ⚠️ 换片源会把外挂字幕一起丢掉，这里要同步记账。
    // 默认连"想要哪条"也清掉 —— 否则上一首的歌词会挂到新的一首上（时间轴全错）。
    // 但**原伴唱切换是同一首歌换文件**，歌词必须留着，调用方传 keepSubtitles: true。
    this._subId = null;
    if (!opts.keepSubtitles) this._subFile = null;
    // 换片源会丢掉外挂音轨（和字幕同理）；伴奏由调用方在片源就绪后重新挂
    this._accompAid = null;
    if (!opts.keepAccompaniment) this._accompFile = null;
    this._eof = false;
    this._endError = null;
    this._lastTime = 0;
    this._stallMs = 0;
    this._stallReported = false;
    this._hasProgressed = false;
    this._timePos = null;
    this._duration = null;
    this._trackList = [];
    this._loaded = false;

    const run = async () => {
      await this._ensureProc();
      // ⚠️ mpv 的 loadfile replace 不一定会清掉通过 audio-add 挂上的外挂音轨。
      // 换到新歌前先主动移除上一首的伴奏，否则它会混进新片源的 track-list，
      // 让"双音轨片源"被误判成三音轨，原伴唱切换就会选错 aid。
      if (!keepAccompaniment && prevAccompAid != null) {
        try { await this.ipc.send(['audio-remove', prevAccompAid]); } catch { /* 已经被 mpv 清掉 */ }
      }
      // replace: 顶掉当前播放项；pause 由实例参数 --pause=yes 保证
      // 换片源会连带丢掉外挂字幕，先清掉记录，挂完新片源再重新挂
      this._subId = null;
      await this.ipc.send(['loadfile', source, 'replace']);
      // 双保险：如果 mpv 仍保留 external 音轨，按 track-list 再清一次。
      if (!keepAccompaniment) {
        try {
          const list = await this.ipc.getProp('track-list');
          for (const t of (list || []).filter((x) => x.type === 'audio' && x.external)) {
            await this.ipc.send(['audio-remove', t.id]).catch?.(() => {});
          }
        } catch { /* track-list 还没准备好时留给后续策略过滤 */ }
      }
      // 用**当前**的期望值，这样紧跟着调用的 play() 不会被这里重新按回暂停
      await this.ipc.send(['set_property', 'pause', this._desiredPaused]);
      this._applyVocalMode();
      await this._applySubtitle().catch(() => {});
      await this._applyAccompaniment().catch(() => {});
      this.emit('media', { source, isStream: this.isStream });
    };
    return run().catch((e) => {
      this._endError = e.message;
      this.emit('error', { reason: e.message });
    });
  }

  play() {
    this._desiredPaused = false;
    if (!this._ready) return Promise.resolve();
    return this._ready.then(() => this.ipc.send(['set_property', 'pause', false]));
  }

  pause() {
    this._desiredPaused = true;
    if (!this.ipc) return Promise.resolve();
    return this.ipc.send(['set_property', 'pause', true]);
  }

  togglePlay() { return this.isPlayingNow() ? this.pause() : this.play(); }

  stop() {
    if (!this.ipc) return Promise.resolve();
    return this.ipc.send(['stop']);
  }

  /**
   * 等当前片源**真正就绪**（mpv 的 file-loaded 事件）。
   *
   * ⚠️ 换片源之后**不能**用 currentTime() 判断"起没起来"：
   *   load() 之后 mpv 推过来的 time-pos 还是**上一个**播放项的值，
   *   于是"等 currentTime > 200"会立刻通过，紧接着的 seek 落在正在被替换掉的
   *   旧播放项上 —— 用户看到的就是"点伴唱之后从头开始播"。
   * 返回 true = 已就绪，false = 超时。
   */
  waitForLoaded(timeoutMs = 15000) {
    if (this._loaded || !this.filePath) return Promise.resolve(!!this.filePath);
    return new Promise((resolve) => {
      const done = (ok) => { clearTimeout(timer); resolve(ok); };
      const timer = setTimeout(() => {
        this._loadWaiters = this._loadWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      this._loadWaiters.push(done);
    });
  }

  seek(ms) {
    const sec = Math.max(0, Number(ms) || 0) / 1000;
    this._pendingSeek = Date.now();
    if (!this.ipc) return Promise.resolve();
    return this.ipc.send(['seek', sec, 'absolute+exact']);
  }

  seekRelative(deltaMs) { return this.seek((this.currentTime() || 0) + deltaMs); }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(200, Math.round(Number(v) || 0)));
    if (!this.ipc) return Promise.resolve();
    return this.ipc.send(['set_property', 'volume', this._volume]);
  }

  getVolume() { return this._volume; }

  // ── 视频内嵌文字（歌词） ─────────────────────────────────────
  /**
   * 把一行歌词渲染到**视频画面里**。
   * mpv 的 osd-msg1 + 超长 osd-duration 就是"常驻字幕条"，实测能稳定显示。
   * 传空字符串 = 清除。同一行重复调用会被忽略。
   */
  setVideoText(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s === this._videoText) return;
    this._videoText = s;
    if (!this.ipc) return;
    this.ipc.send(['set_property', 'osd-msg1', s]);
  }

  // ── 外部字幕（逐字歌词用 ASS 卡拉OK） ───────────────────────
  /**
   * 加载外部字幕文件。传 null 表示移除我们加的那条。
   *
   * 为什么用字幕而不是 osd-msg1：mpv 的 OSD **不解析** ASS 覆盖码
   * （实测 `{\b1}` 原样显示、`{\c&H...&}` 报 "broken escape sequences"），
   * 而 ASS 字幕天生支持 \k 卡拉OK标签。详见 docs/19-word-lyrics.md。
   */
  async setSubtitleFile(file) {
    this._subFile = file || null;
    await this._applySubtitle();
  }

  /**
   * 把 _subFile 真正挂到 mpv 上。
   *
   * ⚠️ 这里必须能被**反复调用**：
   *   1. 点歌那一刻歌词可能比播放器先就绪（mpv 进程都还没起来，ipc 为 null）——
   *      老写法直接 return，字幕就永远不显示了，用户看到的是"有些歌没歌词"；
   *   2. loadfile 换片源会把外挂字幕一起丢掉，换完必须重新挂。
   * 所以"想要哪条字幕"记在 _subFile 里，谁就绪谁负责再调一次。
   */
  async _applySubtitle() {
    // load() 与 file-loaded 事件都会调这里，加个在途保护，免得同一条字幕挂两遍
    if (this._subApplying) return this._subApplying;
    this._subApplying = this._applySubtitleNow().finally(() => { this._subApplying = null; });
    return this._subApplying;
  }

  async _applySubtitleNow() {
    const want = this._subFile || null;
    if (!this.ipc) return;                 // 进程还没起来，_ensureProc / load 会再调
    if (!want) {
      if (this._subId != null) {
        try { await this.ipc.send(['sub-remove', this._subId]); } catch { /* 忽略 */ }
        this._subId = null;
      }
      return;
    }
    if (this._subId != null) return;       // 已经挂着同一条了
    await this.ipc.send(['sub-add', want, 'select']);
    // mpv 不回传新字幕的 id，从 track-list 里按文件名认回来，方便之后精确移除
    const list = await this.ipc.getProp('track-list');
    const base = String(want).split(/[\\/]/).pop();
    const mine = (list || []).find((t) => t.type === 'sub' && t.external
      && String(t['external-filename'] || '').split(/[\\/]/).pop() === base);
    this._subId = mine ? mine.id : null;
  }

  supportsAssLyrics() { return true; }

  // ── 音轨 ────────────────────────────────────────────────────
  /** mpv 的 track-list -> 与 libVLC 版一致的 { id, name } 列表（只取音频）。 */
  getTracks() {
    const list = this._trackList || [];
    // ⚠️ 只返回**片源自带**的音轨。AI 分离出来的伴奏是外挂音轨，
    // 换片后可能仍留在 mpv 的 track-list 里；把它算进来会把双音轨片源
    // 误判成三音轨，进而选错 aid。外挂伴奏由 _accompAid 单独管理。
    return list.filter((t) => t.type === 'audio' && !t.external)
      .map((t) => ({ id: t.id, name: t.title || t.lang || t['codec-desc'] || '' }));
  }

  /**
   * 当前挂着的外挂字幕。
   * ⚠️ 字幕**不在** getTracks() 里 —— 那个只返回音频轨（原伴唱映射要用）。
   * 画面歌词的挂载/摘除要靠这个看，否则到底有没有字幕根本观察不到。
   */
  getSubtitleTracks() {
    return (this._trackList || []).filter((t) => t.type === 'sub')
      .map((t) => ({ id: t.id, external: !!t.external, file: t['external-filename'] || '' }));
  }

  selectTrack(id) {
    this._strategy = 'track';
    if (!this.ipc) return Promise.resolve();
    return this.ipc.send(['set_property', 'aid', Number(id)]);
  }

  getTrack() {
    const aid = this.ipc?.observed(OBS.aid);
    return typeof aid === 'number' ? aid : 0;
  }

  // ── 外挂伴奏音轨（AI 分离出来的"伴唱"） ─────────────────────
  /**
   * 把分离出来的伴奏挂成**外挂音轨**（不选中），而不是"再开一个文件"。
   *
   * 为什么必须这样：maidong 的 `.ts` 时间戳是坏的，**seek 会偏几秒**
   * （实测 seek 60s 落到 66.4s，seek 120s 落到 121.7s，重封装也修不好）。
   * 老做法是"换文件 + seek 回原位置"，于是每次切原伴唱都会把音频**快进**过去，
   * 还会有一两秒的静音。
   * 挂成外挂音轨之后，原伴唱切换就是 `aid` 热切换：不 seek、不断音、位置纹丝不动。
   */
  async attachAccompaniment(file) {
    if (!file) { this._accompFile = null; this._accompAid = null; return false; }
    this._accompFile = file;
    this._accompAid = null;
    return this._applyAccompaniment();
  }

  /** 外挂伴奏音轨是否已经挂上（决定走"切 aid"还是老的"换文件"）。 */
  hasAccompanimentTrack() { return this._accompAid != null; }

  async _applyAccompaniment() {
    const want = this._accompFile;
    if (!this.ipc || !want) return false;
    if (this._accompAid != null) return true;
    // ⚠️ 必须挡住在途调用：load() 之后和 mpv 的 file-loaded 事件都会调这里，
    // 两个调用都看到 _accompAid 为空就会 audio-add 两次 —— 音轨表里会出现
    // 两条一模一样的外挂伴奏，切 aid 时可能切到没被记账的那条。
    if (this._accompApplying) return this._accompApplying;
    this._accompApplying = this._applyAccompanimentNow(want).finally(() => { this._accompApplying = null; });
    return this._accompApplying;
  }

  async _applyAccompanimentNow(want) {
    try {
      await this.ipc.send(['audio-add', want, 'auto']);   // auto = 挂上但不选中
      const list = await this.ipc.getProp('track-list');
      const base = String(want).split(/[\\/]/).pop();
      const mine = (list || []).filter((t) => t.type === 'audio' && t.external
        && String(t['external-filename'] || '').split(/[\\/]/).pop() === base);
      this._accompAid = mine.length ? mine[mine.length - 1].id : null;
    } catch { this._accompAid = null; }
    return this._accompAid != null;
  }

  /** 片源**自带**的音频轨（排除外挂的分离伴奏）。 */
  _ownAudioTracks() {
    return (this._trackList || []).filter((t) => t.type === 'audio' && !t.external);
  }
  // ── 声道 ────────────────────────────────────────────────────
  getChannel() {
    const g = this._panGraph;
    if (g === PAN_GRAPH.left) return AudioChannel.Left;
    if (g === PAN_GRAPH.right) return AudioChannel.Right;
    return AudioChannel.Stereo;
  }

  setChannel(code) {
    const key = code === AudioChannel.Left ? 'left' : code === AudioChannel.Right ? 'right' : 'stereo';
    return this._setPan(key);
  }

  _setPan(key) {
    this._panKey = key;
    return this._applyAudioFilters();
  }

  /**
   * 变调（半音，-6 ~ +6）。0 = 不变调。
   *
   * 用 ffmpeg 的 rubberband 滤镜：它是**时长不变、只改音高**的算法
   * （和 Android 端 SoundTouch 同类）。不能用 asetrate+atempo 那种土办法，
   * 那会把共振峰一起搬走，人声会变"花栗鼠"。
   *
   * 实测（440Hz 纯音）：+7 半音 -> 660Hz，-5 半音 -> 331Hz，时长不变。
   */
  setPitch(semitones) {
    this._pitchSemitones = Math.max(-6, Math.min(6, Math.round(Number(semitones) || 0)));
    return this._applyAudioFilters();
  }

  getPitch() { return this._pitchSemitones || 0; }
  supportsPitch() { return true; }

  /**
   * 重建音频滤镜链：声道隔离（pan）和变调（rubberband）必须合成**一条** graph，
   * 因为 mpv 的 `af set` 是整体替换而不是叠加。
   */
  _applyAudioFilters() {
    const pan = PAN_GRAPH[this._panKey] || PAN_GRAPH.stereo;
    this._panGraph = pan;
    const semi = this._pitchSemitones || 0;
    const graph = semi === 0 ? pan : `${pan},rubberband=pitch=${pitchRatio(semi).toFixed(6)}`;
    this._afGraph = graph;
    if (!this.ipc) return Promise.resolve();
    return this.ipc.send(['af', 'set', `lavfi=[${graph}]`]);
  }

  /**
   * 推断该片源用哪种原伴唱载体，并建立模式->轨道/声道的映射。
   * 需要片源已被解析（音轨数 > 0），所以在播放开始后再调用。
   */
  resolveStrategy() {
    const tracks = this.getTracks();
    if (tracks.length >= 2) {
      this._strategy = 'track';
      if (!this._trackMap) this._trackMap = resolveTrackMap(tracks);
    } else {
      this._strategy = 'channel';
    }
    return this._strategy;
  }

  /** 手动覆盖声道映射（片源与曲库标记不符时由 UI 触发）。 */
  setChannelMapping(map) {
    if (map && (map.original === 'left' || map.original === 'right')) {
      this._channelMap = { original: map.original, accompaniment: map.original === 'left' ? 'right' : 'left' };
      this._strategy = 'channel';
      this._applyVocalMode();
    }
  }

  getChannelMap() { return this._channelMap; }

  getAccomp() { return this._accomp; }

  /** mpv 最近的 stderr（诊断用） */
  getMpvLog() { return (this._mpvLog || []).slice(-50); }
  getStrategy() { return this._strategy; }
  getTrackMap() { return this._trackMap; }

  /** 手动指定哪条音轨是原唱/伴唱（片源命名不规范时由 UI 覆盖）。 */
  setTrackMapping({ accompaniment, original }) {
    this._trackMap = { accompaniment, original };
    this._strategy = 'track';
    this._applyVocalMode();
  }

  /**
   * 切换原唱/伴唱。这是 KTV 的核心操作。
   * @param {'original'|'accompaniment'|'stereo'} mode
   */
  setVocalMode(mode) {
    if (!['original', 'accompaniment', 'stereo'].includes(mode)) {
      throw new Error('非法原伴唱模式: ' + mode);
    }
    this._vocalMode = mode;
    return this._applyVocalMode();
  }

  getVocalMode() { return this._vocalMode; }

  _applyVocalMode() {
    // ① 有外挂伴奏（AI 分离）：原伴唱 = 切 aid。
    //    ⚠️ 这里**绝对不能 seek** —— 这类片源时间戳是坏的，seek 会偏几秒，
    //    用户听到的就是"切一下伴唱，音频快进过去了"。
    if (this._accompAid != null) {
      const own = this._ownAudioTracks();
      if (this._vocalMode === 'accompaniment') {
        this._setPan('stereo');                  // 分离出来的伴奏是完整立体声混音
        return this.selectTrack(this._accompAid);
      }
      if (own.length >= 2) {
        // 片源自带两条音轨：原唱 = 它自己那条
        this._setPan('stereo');
        if (!this._trackMap) {
          this._trackMap = resolveTrackMap(own.map((t) => ({ id: t.id, name: t.title || t.lang || '' })));
        }
        return this.selectTrack(this._trackMap.original || own[0].id);
      }
      // 单音轨片源：原唱在某个声道里，用 pan 隔离
      return this._setPan(this._vocalMode === 'stereo' ? 'stereo' : this._channelMap.original);
    }
    // ② 分离伴奏：直接立体声输出（见 load() 里的说明）
    if (this._forceStereo) return this._setPan('stereo');
    if (this._strategy === 'track' && this._trackMap) {
      // ⚠️ 必须把声道型留下的 pan 滤镜复位成等值立体声，
      // 否则切到音轨模式后，那条音轨会被上一个 pan 掐掉一个声道。
      this._setPan('stereo');
      const id = this._vocalMode === 'original' ? this._trackMap.original : this._trackMap.accompaniment;
      // ⚠️ 这里也**不要 seek**。
      // mpv 的 aid 切换是热切换，位置根本不动；老注释说"切完 seek 回原位置让新音轨
      // 立刻出声"是 libVLC 的坑。在坏时间戳的 .ts 上，这一 seek 反而会把音频快进几秒。
      return this.selectTrack(id);
    }
    // ③ 声道型：左右哪个是原唱由曲库 accomp 决定（见 channelMapForAccomp）
    const key = this._vocalMode === 'stereo' ? 'stereo'
      : (this.isStream && this._vocalMode === 'accompaniment' ? 'centerCancel' : this._channelMap[this._vocalMode]);
    return this._setPan(key);
  }

  // ── 状态 ────────────────────────────────────────────────────
  currentTime() {
    const t = this.ipc?.observed(OBS.timePos);
    return Number.isFinite(t) ? Math.round(t * 1000) : Math.round(this._lastTime || 0);
  }

  lastStatus() { return this._lastStatus || null; }
  isPlayingNow() {
    const paused = this.ipc?.observed(OBS.pause);
    if (this._eof || this._endError) return false;
    if (paused === undefined) return !this._desiredPaused;
    return paused === false;
  }

  /** mpv 的状态 -> libVLC 的状态枚举，保证 UI 不用改。 */
  _state() {
    if (this._endError) return State.Error;
    if (this._eof) return State.Ended;
    const paused = this.ipc?.observed(OBS.pause);
    const idle = this.ipc?.observed(OBS.idleActive);
    if (this._pausedForCache) return State.Buffering;
    if (paused === true) return State.Paused;
    if (idle === true && !this.filePath) return State.Stopped;
    if (!Number.isFinite(this.ipc?.observed(OBS.timePos))) return State.Opening;
    return State.Playing;
  }

  /**
   * 播放统计。mpv 暴露的计数器比 libVLC 少（没有 demux 损坏/音频块计数），
   * 这里把能拿到的映射到同名键，拿不到的填 0 —— 只为诊断，不参与业务判断。
   */
  getStats() {
    const drop = Number(this.ipc?.observed(OBS.frameDrop) || 0);
    const frames = Number(this._frameNumber || 0);
    const ddrop = Number(this.ipc?.observed(OBS.decoderDrop) || 0);
    return {
      i_displayed_pictures: frames,
      i_lost_pictures: drop,
      i_decoded_video: frames + ddrop,
      i_decoded_audio: 0,
      i_played_abuffers: 0,
      i_lost_abuffers: 0,
      i_demux_corrupted: 0,
      i_demux_discontinuity: 0,
      i_read_bytes: 0,
    };
  }

  getStatus() {
    const state = this._state();
    const time = this.currentTime();
    const duration = Number.isFinite(this._duration) ? Math.round(this._duration * 1000) : 0;
    const vp = this.ipc?.observed(OBS.videoParams);
    const videoSize = { width: Number(vp?.w) || 0, height: Number(vp?.h) || 0 };
    const tracks = this.getTracks();
    const channel = this.getChannel();
    return {
      filePath: this.filePath,
      isStream: this.isStream,
      state,
      stateName: nameOf(State, state),
      playing: this.isPlayingNow(),
      time,
      length: duration,
      volume: this._volume,
      hasVout: videoSize.width > 0,
      stats: this.getStats(),
      videoSize,
      tracks,
      channel,
      channelName: nameOf(AudioChannel, channel),
      strategy: this._strategy,
      vocalMode: this._vocalMode,
      trackMap: this._trackMap,
      accomp: this._accomp,
      channelMap: this._channelMap,
      currentTrack: this.getTrack(),
      pitch: this.getPitch(),
      pitchSupported: this.supportsPitch(),
    };
  }

  /**
   * 卡死检测：Playing 状态下时间轴不推进即视为流异常。
   * 只在网络流上启用——本地文件暂停/缓冲的语义不同，误报会打扰用户。
   */
  _checkStall(status) {
    if (!this.isStream) { this._stallMs = 0; return; }
    const advancing = status.time > this._lastTime;
    this._lastTime = status.time;
    const shouldCount = status.playing && status.stateName === 'Playing';
    if (!shouldCount || advancing) { this._stallMs = 0; this._stallReported = false; return; }
    this._stallMs += POLL_INTERVAL_MS;
    if (this._stallMs >= STALL_THRESHOLD_MS && !this._stallReported) {
      this._stallReported = true;
      this.emit('stalled', { ...status, reason: 'no-progress', stalledMs: this._stallMs });
    }
  }

  _startPolling() {
    if (this._timer) return;
    let tick = 0;
    this._timer = setInterval(() => {
      if (!this.ipc) return;
      // 帧数只用于诊断，2 秒拉一次就够（observe 拿不到它的后续变化）
      if (++tick % 8 === 0) {
        this.ipc.getProp('estimated-frame-number').then((v) => {
          if (Number.isFinite(v)) this._frameNumber = v;
        }).catch(() => {});
      }
      // 观察值都是 mpv 主动推过来的，这里只读本地缓存，不做 IPC 往返
      const t = this.ipc.observed(OBS.timePos);
      this._timePos = Number.isFinite(t) ? t : null;
      const dur = this.ipc.observed(OBS.duration);
      this._duration = Number.isFinite(dur) ? dur : null;
      this._pausedForCache = this.ipc.observed(OBS.pausedForCache) === true;
      // ⚠️ 换片源之后、mpv 把**新**的 track-list 推过来之前，observed() 拿到的还是
      // **上一个文件**的列表。用它判"音轨型 / 声道型"会把上一首的结论安到这一首上，
      // 而且判错之后再也不会纠正（`_strategy==='channel' && !_trackMap` 这个条件不再成立）——
      // 用户看到的就是**点了「伴唱」没反应**。
      // 所以只认 file-loaded 之后的那一份（mpv 在加载文件期间就会推新列表）。
      this._trackList = this._loaded ? (this.ipc.observed(OBS.trackList) || []) : [];

      let status;
      try { status = this.getStatus(); } catch { return; }
      if (status.time > PROGRESS_THRESHOLD_MS) this._hasProgressed = true;

      // 片源解析出音轨后自动判定策略（只做一次，之后尊重用户手动选择）
      if (status.tracks.length > 0 && this._strategy === 'channel' && !this._trackMap) {
        const before = this._strategy;
        this.resolveStrategy();
        if (this._strategy !== before) this._applyVocalMode();
      }

      if (status.state !== this._lastState) {
        const prev = this._lastState;
        this._lastState = status.state;
        this.emit('state', status);
        if (status.state === State.Ended && prev !== State.Ended) {
          // 网络流"没播起来就 Ended"是取流失败（如 403），不是正常播完
          if (this.isStream && !this._hasProgressed) {
            this.emit('error', { ...status, reason: 'ended-without-progress' });
          } else {
            this.emit('ended', status);
          }
        }
        if (status.state === State.Error) this.emit('error', { ...status, reason: this._endError || 'mpv-error' });
      }

      this._checkStall(status);
      this._lastStatus = status;
      this.emit('status', status);
    }, POLL_INTERVAL_MS);
  }

  dispose() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    const ipc = this.ipc;
    const proc = this.proc;
    this.ipc = null;
    this.proc = null;
    this._ready = null;
    try { ipc?.send(['quit']); } catch { /* 忽略 */ }
    setTimeout(() => {
      try { ipc?.close(); } catch { /* 忽略 */ }
      try { proc?.kill(); } catch { /* 忽略 */ }
    }, 200);
    this.removeAllListeners();
  }
}

/**
 * 按设置选播放内核。
 *   'mpv'    -> mpv（ffmpeg 系，推荐；maidong 的坏片源只有它扛得住）
 *   'libvlc' -> libVLC（老内核，保留作为回退）
 * 默认 mpv；mpv 不可用时自动回退到 libVLC。
 */
function createPlayer(options = {}) {
  const core = String(options.core || process.env.KTV_PLAYER_CORE || 'mpv').toLowerCase();
  if (core === 'libvlc') {
    const { KtvPlayer } = require('./player');
    return new KtvPlayer(options);
  }
  if (!resolveMpvPath()) {
    const { KtvPlayer } = require('./player');
    return new KtvPlayer(options);
  }
  return new MpvPlayer(options);
}

module.exports = { MpvPlayer, MpvIpc, createPlayer, resolveMpvPath, PAN_GRAPH, pitchRatio };
