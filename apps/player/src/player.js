/**
 * KtvPlayer —— 高层播放器
 * =======================
 * 把 libVLC 的裸 API 包装成 KTV 业务需要的语义，屏蔽"两种原伴唱载体"的差异：
 *
 *   音轨型（新式 KTV TS）：原唱/伴唱各一条音轨 -> 切音轨
 *   声道型（老式 KTV TS）：左声道伴唱、右声道原唱 -> 切声道
 *
 * 上层 UI 只需要调用 setVocalMode('original' | 'accompaniment')，
 * 由本类根据片源自动选择策略。
 */
'use strict';

const { EventEmitter } = require('events');
const vlc = require('./vlc-ffi');

const { classifyTrackName, channelMapForAccomp, isTsSource } = require('./vocal');

const POLL_INTERVAL_MS = 250;

/**
 * 在线流卡死判定：处于 Playing 但播放位置连续这么久没有推进，就认为流断了。
 * 取流地址约 1 小时过期，过期后 libVLC 往往不报 Error 而是"卡住不动"，
 * 所以光看状态是不够的，必须盯住时间轴是否推进。
 */
const STALL_THRESHOLD_MS = 6000;

/**
 * 判定"确实播放过"的时间阈值。
 * 实测：取流地址返回 403 时，libVLC 不报 Error，而是直接进入 Ended。
 * 正常播完和"根本没播起来就结束"都表现为 Ended，只能靠时间轴是否推进过来区分。
 */
const PROGRESS_THRESHOLD_MS = 1000;

const CHANNEL_CODE = { left: vlc.AudioChannel.Left, right: vlc.AudioChannel.Right, stereo: vlc.AudioChannel.Stereo };

class KtvPlayer extends EventEmitter {
  constructor(options = {}) {
    super();
    this._vlcArgs = options.vlcArgs || [];
    // 是否强制软件解码。注意：实例级 --avcodec-hw=none 实测**会被 avcodec 模块忽略**
    // （日志里依然 using hw decoder "d3d11va"），必须用媒体级 :avcodec-hw=none 才生效
    // （日志变成 looking for hw decoder module "none"，hw 用量 0）。
    this._softwareDecode = !!options.softwareDecode;
    this._videoText = null;   // 当前画在视频里的那行歌词
    this._tsMode = null;
    this.instance = null;
    this.mp = null;
    this.media = null;
    this.filePath = null;
    this.isStream = false;
    this.surfaceHwnd = null;
    this._recreateInstance(false);

    this._strategy = 'channel';       // 'track' | 'channel'
    this._trackMap = null;            // { accompaniment: id, original: id }
    this._accomp = 0;                 // 曲库 songs.accomp
    this._channelMap = channelMapForAccomp(0); // { original:'left'|'right', accompaniment:... }
    this._vocalMode = 'original';     // 'original' | 'accompaniment' | 'stereo'
    this._lastState = null;
    this._timer = null;
    this._lastTime = 0;
    this._stallMs = 0;
    this._stallReported = false;
    this._hasProgressed = false;

    this._startPolling();
  }

  // ── 视频输出 ────────────────────────────────────────────────
  /** 绑定视频承载窗口句柄（来自 win32.VideoSurface）。 */
  attachSurface(hwnd) {
    this.surfaceHwnd = hwnd;
    vlc.setHwnd(this.mp, hwnd);
  }

  /**
   * 切换实例的 ts 模式（重建 libVLC 实例）。
   *
   * 背景：maidong 的 .ts 片源开头带 136 字节非 TS 数据，libVLC 的格式探测
   * 会判定 "TS module discarded (lost sync)"，回退到 ps 解复用器并持续
   * "garbage at input ... trying to resync"，最终表现为花屏或纯黑。
   * 实测只有**实例级** `--demux=ts` 能让它正常解码（媒体级 `:demux=ts` 无效），
   * 但实例级选项会影响所有片源（mp4/mkv 会被 ts 解复用器毁掉），
   * 所以这里按片源类型切换实例。
   */
  _recreateInstance(tsMode) {
    if (this.media) { vlc.releaseMedia(this.media); this.media = null; }
    if (this.mp) { vlc.releaseMediaPlayer(this.mp); this.mp = null; }
    if (this.instance) { vlc.releaseInstance(this.instance); this.instance = null; }
    const args = (this._vlcArgs || []).slice();
    if (tsMode) args.push('--demux=ts');
    this.instance = vlc.newInstance(args);
    this.mp = vlc.newMediaPlayer(this.instance);
    if (this.surfaceHwnd) vlc.setHwnd(this.mp, this.surfaceHwnd);
    this._tsMode = tsMode;
    this._lastState = null;
  }

  // ── 片源 ────────────────────────────────────────────────────
  /**
   * 载入片源。source 可以是本地路径，也可以是 http(s) URL（在线取流）。
   * @param {string} source
   * @param {{accomp?: number, isStream?: boolean}} [opts] accomp 来自曲库，决定原伴唱声道映射
   */
  load(source, opts = {}) {
    this.stop();
    // maidong 的 .ts 片源开头带非 TS 数据，libVLC 的格式探测会 'lost sync' 并
    // 回退到 ps 解复用器，表现为花屏或纯黑。实测媒体级 :demux=ts 无效，
    // 只有实例级 --demux=ts 才生效；而它会毁掉 mp4/mkv，所以按片源类型切实例。
    const isTs = isTsSource(source);
    if (isTs !== this._tsMode) this._recreateInstance(isTs);
    if (this.media) { vlc.releaseMedia(this.media); this.media = null; }
    this.filePath = source;
    this.isStream = /^https?:\/\//i.test(String(source)) || !!opts.isStream;
    this.media = this.isStream
      ? vlc.newMediaLocation(this.instance, source)
      : vlc.newMediaPath(this.instance, source);
    // 软件解码必须走媒体级选项，实例级参数会被忽略（见构造函数里的说明）
    if (this._softwareDecode) vlc.addMediaOption(this.media, ':avcodec-hw=none');
    vlc.setMedia(this.mp, this.media);
    this._trackMap = null;
    this._strategy = 'channel';
    this._vocalMode = 'original';
    this._accomp = Number(opts.accomp ?? 0);
    // 分离出来的伴奏文件是「单音轨立体声」，本身就是伴奏，
    // 再套原曲的声道/音轨映射会把其中一个声道当原唱切掉。所以强制立体声输出。
    this._forceStereo = !!opts.separatedAccompaniment;
    this._channelMap = channelMapForAccomp(this._accomp);
    this._lastTime = 0;
    this._stallMs = 0;
    this._stallReported = false;
    this._hasProgressed = false;
    this._statusCache = null;
    if (this.surfaceHwnd) vlc.setHwnd(this.mp, this.surfaceHwnd);
    this.emit('media', { source, isStream: this.isStream });
  }

  play() { return vlc.play(this.mp); }
  pause() { vlc.pause(this.mp); }
  togglePlay() { return vlc.isPlaying(this.mp) ? this.pause() : this.play(); }
  stop() {
    if (this.mp) vlc.stop(this.mp);
  }

  seek(ms) { vlc.setTime(this.mp, ms); }
  seekRelative(deltaMs) { vlc.setTime(this.mp, Math.max(0, vlc.getTime(this.mp) + deltaMs)); }

  setVolume(v) { vlc.setVolume(this.mp, v); }
  getVolume() { return vlc.getVolume(this.mp); }

  // ── 视频内嵌文字（歌词） ─────────────────────────────────────
  /**
   * 把一行歌词渲染到**视频画面里**（libVLC marquee）。
   *
   * 为什么不用 HTML 叠：视频是原生子窗口、永远在 HTML 之上，叠不上去。
   * marquee 是 libVLC 自己画进视频输出的，所以能做到「歌词在画面里」。
   * 传空字符串 = 清除。同一行重复调用会被忽略，避免每 250ms 重设一次。
   */
  setVideoText(text) {
    if (!this.mp) return;
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s === this._videoText) return;
    this._videoText = s;
    if (!s) { vlc.setMarqueeInt(this.mp, vlc.Marquee.Enable, 0); return; }
    vlc.setMarqueeInt(this.mp, vlc.Marquee.Enable, 1);
    vlc.setMarqueeInt(this.mp, vlc.Marquee.Color, 0xFFFFFF);   // 白字
    vlc.setMarqueeInt(this.mp, vlc.Marquee.Opacity, 255);
    vlc.setMarqueeInt(this.mp, vlc.Marquee.Position, 8);       // 8 = 底部
    vlc.setMarqueeInt(this.mp, vlc.Marquee.Size, 28);
    vlc.setMarqueeInt(this.mp, vlc.Marquee.Timeout, 0);        // 不自动消失
    vlc.setMarqueeInt(this.mp, vlc.Marquee.Y, 64);             // 距底部 64px
    vlc.setMarqueeString(this.mp, vlc.Marquee.Text, s);
  }

  // ── 音轨 ────────────────────────────────────────────────────
  getTracks() { return vlc.getTracks(this.mp); }

  selectTrack(id) {
    const rc = vlc.setTrack(this.mp, id);
    if (rc === 0) this._strategy = 'track';
    return rc;
  }

  getTrack() { return vlc.getTrack(this.mp); }

  // ── 声道 ────────────────────────────────────────────────────
  getChannel() { return vlc.getChannel(this.mp); }
  setChannel(code) { return vlc.setChannel(this.mp, code); }

  /**
   * 推断该片源用哪种原伴唱载体，并建立模式->轨道/声道的映射。
   * 需要片源已被解析（音轨数 > 0），所以在播放开始后再调用。
   */
  resolveStrategy() {
    const tracks = this.getTracks();
    if (tracks.length >= 2) {
      this._strategy = 'track';
      if (!this._trackMap) {
        let accompaniment = null;
        let original = null;
        for (const t of tracks) {
          const kind = classifyTrackName(t.name);
          if (kind === 'accompaniment' && accompaniment == null) accompaniment = t.id;
          if (kind === 'original' && original == null) original = t.id;
        }
        // 命名认不出来时按「第一条原唱、第二条伴唱」兜底。
        // 依据 maidong 自己的实现（KtvVideoView.kt:273）：
        //   val targetTrack = if (original) audioTracks[0] else audioTracks[1]
        // 注意：这里曾经写反过（把 tracks[0] 当伴唱），症状是「点原唱出伴唱」。
        if (original == null) original = tracks[0].id;
        if (accompaniment == null) accompaniment = (tracks.find((t) => t.id !== original) || tracks[1]).id;
        this._trackMap = { accompaniment, original };
      }
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

  /** 播放统计（丢帧等），诊断卡顿时用。 */
  getStats() { return this.media ? vlc.getStats(this.media) : null; }
  getAccomp() { return this._accomp; }

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
    // 分离伴奏：直接立体声输出（见 load() 里的说明）
    if (this._forceStereo) return vlc.setChannel(this.mp, vlc.AudioChannel.Stereo);
    if (this._strategy === 'track' && this._trackMap) {
      const id = this._vocalMode === 'original' ? this._trackMap.original : this._trackMap.accompaniment;
      // libvlc 换音轨要重建 aout，中间会有一段静音（实测 1~2 秒）。
      // 换完立刻 seek 回当前播放位置，让新音轨从这个点马上开始解码输出，
      // 而不是等内部缓冲重新填满。maidong 也这么做
      // （KtvVideoView.kt:337 注释提到切轨后要 seek 回 rendered position）。
      const pos = vlc.getTime(this.mp);
      const wasPlaying = vlc.isPlaying(this.mp);
      const rc = vlc.setTrack(this.mp, id);
      if (wasPlaying && pos > 0) vlc.setTime(this.mp, pos);
      return rc;
    }
    // 声道型：左右哪个是原唱由曲库 accomp 决定（见 channelMapForAccomp）
    const key = this._vocalMode === 'stereo' ? 'stereo' : this._channelMap[this._vocalMode];
    const code = CHANNEL_CODE[key] ?? vlc.AudioChannel.Stereo;
    return vlc.setChannel(this.mp, code);
  }

  // ── 变调 ────────────────────────────────────────────────────
  /**
   * libVLC 3 **没有变调滤波器**（只有 scaletempo 变速，改不了音高）。
   * 所以这个内核不支持变调，界面会按 supportsPitch() 把控件藏起来，
   * 并提示切到 mpv 内核。
   */
  supportsPitch() { return false; }
  /** libVLC 侧没接外部 ASS 字幕，逐字歌词只在 mpv 内核下生效。 */
  supportsAssLyrics() { return false; }
  setSubtitleFile() { return false; }
  setPitch() { return false; }
  getPitch() { return 0; }

  // ── 状态 ────────────────────────────────────────────────────
  /**
   * 轻量读取：只取当前播放位置。
   * 高频轮询（进度条、卡顿检测）必须走这里，不能走 getStatus()。
   */
  currentTime() { return vlc.getTime(this.mp); }

  /**
   * 最近一次轮询得到的状态（不触发任何 libVLC 调用）。
   * 主进程推送界面状态时用它，避免和播放器内部轮询重复查询 libVLC。
   */
  lastStatus() { return this._lastStatus || null; }
  isPlayingNow() { return vlc.isPlaying(this.mp); }

  /**
   * 完整状态。
   *
   * 注意：枚举音轨、查询视频尺寸这类调用会进 libVLC 内部锁，**高频调用会直接
   * 造成播放卡顿**（实测：每 100ms 调一次，150 次采样里 99 次时间轴停顿）。
   * 所以这些"昂贵字段"做了节流：2 秒或播放状态变化时才刷新。
   */
  getStatus() {
    const state = vlc.getState(this.mp);
    const now = Date.now();
    const cache = this._statusCache;
    // 视频尺寸在 vout 就绪前是 0x0，这种"还没拿到"的值不能缓存，
    // 否则会在缓存有效期内一直显示 0x0。
    const sizeReady = cache && cache.videoSize && cache.videoSize.width > 0;
    if (!cache || now - cache.at > 2000 || state !== cache.state || !sizeReady) {
      this._statusCache = {
        at: now,
        state,
        tracks: vlc.getTracks(this.mp),
        videoSize: vlc.getVideoSize(this.mp),
      };
    }
    // getStats 同样要进 libVLC 内部锁，而且只用于诊断，没必要每次都读。
    // 之前每 250ms 一次（两个轮询叠加 = 每秒 8 次），属于白白拖慢解码。
    if (!this._statsCache || now - this._statsAt > 2000) {
      this._statsCache = this.getStats();
      this._statsAt = now;
    }
    const cached = this._statusCache;
    return {
      filePath: this.filePath,
      isStream: this.isStream,
      state,
      stateName: vlc.StateName[state] || 'Unknown',
      playing: vlc.isPlaying(this.mp),
      time: vlc.getTime(this.mp),
      length: vlc.getLength(this.mp),
      volume: vlc.getVolume(this.mp),
      hasVout: vlc.hasVout(this.mp),
      stats: this._statsCache,
      videoSize: cached.videoSize,
      tracks: cached.tracks,
      channel: this.getChannel(),
      channelName: vlc.AudioChannelName[this.getChannel()] || 'Unknown',
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
    if (!shouldCount || advancing) {
      this._stallMs = 0;
      this._stallReported = false;
      return;
    }

    this._stallMs += POLL_INTERVAL_MS;
    if (this._stallMs >= STALL_THRESHOLD_MS && !this._stallReported) {
      this._stallReported = true;
      this.emit('stalled', { ...status, reason: 'no-progress', stalledMs: this._stallMs });
    }
  }

  _startPolling() {
    this._timer = setInterval(() => {
      if (!this.mp) return;
      // 没在播就什么都不做：空闲时每秒 4 次 libVLC 加锁调用纯属浪费，
      // 而这些调用会和正在解码的线程抢锁。
      if (!this.media) return;
      let status;
      try { status = this.getStatus(); } catch { return; }
      if (!status.playing && status.stateName !== 'Opening' && status.stateName !== 'Buffering') {
        this._lastStatus = status;
        return;
      }

      // 片源解析出音轨后自动判定策略（只做一次，之后尊重用户手动选择）
      if (status.tracks.length > 0 && this._strategy === 'channel' && !this._trackMap) {
        const before = this._strategy;
        this.resolveStrategy();
        if (this._strategy !== before) this._applyVocalMode();
      }

      if (status.time > PROGRESS_THRESHOLD_MS) this._hasProgressed = true;

      if (status.state !== this._lastState) {
        this._lastState = status.state;
        this.emit('state', status);

        if (status.state === vlc.State.Ended) {
          // 网络流"没播起来就 Ended"是取流失败（如 403），不是正常播完
          if (this.isStream && !this._hasProgressed) {
            this.emit('error', { ...status, reason: 'ended-without-progress' });
          } else {
            this.emit('ended', status);
          }
        }
        if (status.state === vlc.State.Error) this.emit('error', { ...status, reason: 'libvlc-error' });
      }

      this._checkStall(status);
      this._lastStatus = status;
      this.emit('status', status);
    }, POLL_INTERVAL_MS);
  }

  dispose() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    try { this.stop(); } catch { /* 忽略 */ }
    if (this.media) { vlc.releaseMedia(this.media); this.media = null; }
    if (this.mp) { vlc.releaseMediaPlayer(this.mp); this.mp = null; }
    if (this.instance) { vlc.releaseInstance(this.instance); this.instance = null; }
    this.removeAllListeners();
  }
}

module.exports = { KtvPlayer, classifyTrackName, channelMapForAccomp, isTsSource };
