/**
 * 用户状态存储
 * ============
 * 已点队列、已唱历史、收藏、歌单、设置。
 *
 * 为什么用 JSON 而不是 SQLite：这些都是**小数据**（几十到几千条），
 * 读写频率低，JSON 足够且便于用户备份/排查。曲库那 670k 条才需要 SQLite。
 *
 * 文件位置：resources/state/user-state.json（已 gitignore）
 *
 * 队列条目只存"够显示 + 够定位"的字段，播放时再按 songId 去曲库取最新详情——
 * 这样曲库更新后队列里的歌不会变成脏数据。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 3;
/** 搜索历史最多留几条（遥控器输入麻烦，常用词点一下比重新输强） */
const SEARCH_HISTORY_MAX = 20;
/** 在线收藏上限 */
const ONLINE_SAVE_MAX = 200;

/** 在线条目的唯一键：同 id 不同平台算两条 */
function onlineKey(it) {
  const p = String(it?.platform || '');
  const id = String(it?.id || '');
  return p && id ? p + ':' + id : '';
}
const MAX_HISTORY = 300;
const SAVE_DEBOUNCE_MS = 400;

/** 队列条目状态 */
const QueueStatus = Object.freeze({
  Waiting: 'waiting',
  Playing: 'playing',
  Played: 'played',
});

/**
 * 已唱去重：同一首只保留最近一次（按 playedAt 倒序后取首个）。
 * 老版本会累积重复条目，所以载入时也要过一遍。
 */
function dedupeHistory(list) {
  const seen = new Set();
  const out = [];
  for (const h of [...list].sort((a, b) => (b.playedAt || 0) - (a.playedAt || 0))) {
    if (!h || !h.songId || seen.has(h.songId)) continue;
    seen.add(h.songId);
    out.push(h);
  }
  return out;
}

function emptyState() {
  return {
    version: SCHEMA_VERSION,
    queue: [],
    history: [],
    favorites: [],
    playlists: { 我的收藏: [] },
    searchHistory: [],
    onlineSaves: [],
    settings: {
      volume: 100,
      defaultVocalMode: 'original',   // original | accompaniment
      autoPlayNext: true,
      streamResolution: '720',

      // 视频解码：auto（让 libVLC 自己选）/ hardware（强制硬解）/ software（强制软解）
      // 硬解省 CPU，但部分老显卡/驱动会花屏或卡顿，此时切软解可解决。
      // 默认软解。依据 maidong 自己的实现（KtvVideoView.kt:350）：
      //   // Old KTV MPEG-TS files corrupt reference frames in emulator/device OMX decoders.
      //   // Keep the whole playback path on IJK's bundled FFmpeg decoder.
      //   player.setOption(..., "mediacodec", 0L)
      // 也就是说这批老 KTV TS 的损坏参考帧会把**硬件解码器**搞坏（马赛克），
      // 播放内核：mpv（ffmpeg 系，默认）/ libvlc（老内核，回退）
      //
      // 为什么默认 mpv：maidong 分发的 .ts 片源里有周期性损坏段（87 处），
      // libVLC 遇到这种片源要么丢帧（视频 15fps），要么让音频输出在 ~100 秒后
      // 彻底停摆；mpv 用 ffmpeg 系解复用/解码（与 Android 端 IJK 同源），
      // 同一份片源实测 29.1fps、丢帧 0、音频全程正常。
      // 详见 docs/16-mv-stutter-root-cause.md
      playbackCore: 'mpv',

      // 必须整条链路走软件解码。auto 会让 libVLC 选 d3d11va 硬解，正好踩坑。
      videoDecoder: 'software',
      // 网络流缓冲（毫秒）。网络抖动大时调大更稳，但起播会慢一点。
      networkCachingMs: 1500,
      onlineMvQuality: 'auto',

      // 后台缓存限速（字节/秒）。默认 1MB/s，避免和播放抢带宽；0 = 不限速
      cacheMaxBytesPerSecond: 1024 * 1024,
      // 缓存容量上限（字节）。默认 20GB，超限先删最早下载的
      cacheMaxBytes: 20 * 1024 * 1024 * 1024,
      // 缓存目录；空字符串表示用默认目录
      cacheDir: '',
      // true = 播放时暂停后台缓存（对网络敏感的环境最有效）
      cacheOnlyWhenIdle: false,

      // 音频分离：off | instant（中置声道消除，内置）/ plugin（AI 分离，需插件）
      separationMode: 'off',
      // AI 分离插件（如 setup-demucs.ps1 生成的 separate.cmd）的完整路径
      separatorPluginPath: '',
      // AI 分离用哪个设备：auto（装了 CUDA 版 torch 就用显卡）/ cpu / cuda
      // 实测同一首歌 CPU 约 2 分钟、RTX 3060 Ti 约 10 秒 —— 差一个数量级。
      separatorDevice: 'auto',
      // AI 分离模型：htdemucs（快）/ htdemucs_ft（4 个模型集成，质量更好，慢约 4 倍）
      separatorModel: 'htdemucs',

      // 队列预下载：点歌后立刻后台缓存**接下来要唱的几首**，
      // 这样轮到它们时已经是本地文件，不会出现"边下边播"的卡顿。
      // 0 = 关闭（只缓存正在播的那首）。默认 3 首，兼顾体验和带宽。
      prefetchDepth: 3,

      // 列表每页显示多少条（曲库侧和已唱/收藏/歌单共用）
      pageSize: 30,

      // 曲库列表显示封面。曲库本身没有封面数据，是按歌名去网易云查的，
      // 有限速 + 永久缓存；不想让它发请求就关掉。
      showCovers: true,

      // 点歌后先等缓存（含片源修复）完成再播放。
      // 关：立刻播在线流（起播快，但首次会卡 + 可能有马赛克）
      // 开：等本地缓存好再播（起播慢几秒到十几秒，但首次就顺）
      // 默认开：maidong 的片源几乎都带损坏包，直接播在线流基本一定会卡。
      cacheBeforePlay: true,

      // 底部 HTML 歌词条开关。
      //
      // ⚠️ 默认 **false**，而且从 v1 升上来的用户会被**强制关掉一次**（见 _migrate）。
      // 歌词默认画在**视频画面里**（lyricsOnVideo），底部条再开一份就会同一句歌词
      // 上下各显示一遍 —— 用户会以为这是 bug（"画面下方的歌词为什么还在"）。
      // 真需要"画面 + 底部"两份时，在设置页里手动打开。
      showLyrics: false,
      uiDensity: 'auto',       // auto | comfortable | tv
      rightPanelWidth: null,   // null = 按窗口自动；数字 = 用户拖拽固定
      catalogDir: null,        // null = 使用默认数据目录；字符串 = 曲库 muse.db 所在目录

      // 把歌词画进**视频画面里**（ASS 字幕：居中 + 滚动 + 逐字上色）。
      // 视频是原生子窗口、盖在 HTML 之上，HTML 叠不上去，只能让播放器自己画。
      lyricsOnVideo: true,
      // 画面歌词的位置：bottom（默认，**画面底部居中**）/ center（屏幕正中）
      //
      // ⚠️ 默认是 bottom。曾经默认成 center，用户的反馈是
      // 「歌词是画面底部居中，不是屏幕正中央」——KTV 的画面本身常带自己的歌词，
      // 叠在正中间会挡住人脸。
      lyricsPos: 'bottom',
      // 画面歌词的滚动特效（滑入 + 下一行预览 + 换行淡出）
      lyricsScroll: true,
      lyricsOffsetMs: 0,

      // 流畅模式（去抖动）：interpolation + display-resample。
      //
      // ⚠️ 默认**关**。它的前提是"显示器刷新率能被准确测出来"，而实测这台机器
      // 同一个显示器上 mpv 报出来的 display-fps 一会儿 74.968、一会儿 60 ——
      // 说明 vsync 时钟（DWM + 虚拟显示器驱动）并不稳定。
      // display-resample 会**把音视频节奏锁到这个测出来的时钟上**，时钟错了就是
      // 持续的顿挫/音画漂移，比原来的 3:2 抖动更糟。
      // 想要去掉 30fps 片源在 75Hz 屏上的抖动时再手动打开。
      smoothPlayback: false,

      // 界面主题：dark（默认）/ midnight / warm / light。
      // 所有颜色都在 styles.css 里走 CSS 变量，切换只改 <html data-theme>。
      theme: 'dark',

      // 数据源模式：maidong（麦动曲库 + 它的取流）/ online（只用在线的搜索与取流）。
      // 两套环境**二选一**：maidong 的 MV 片源本身带损坏包，视频会卡；
      // 在线的源流畅但曲库没那么多冷门歌。分开之后用户不会误点到卡的那套。
      sourceMode: 'maidong',

      // 片源修复方式：off | remux | transcode
      //
      // ⚠️ 默认 off，这是实测后的结论（详见 docs/16-mv-stutter-root-cause.md）：
      //   - 片源里有 87 处周期性损坏段（约 8KB，均匀分布），内容是随机字节，不可恢复；
      //   - 在 libVLC 上：重封装能修好视频帧率，却让音频输出在 ~100 秒后彻底停摆
      //     （"太晚 → flush → WASAPI reset" 循环，i_lost_abuffers 一路涨到 1500+）；
      //   - 在 mpv 上：原始文件直接就能满帧播完（实测 239 秒、丢帧 0、音频全程正常），
      //     根本不需要重封装。
      //   所以修复管线弊大于利，保持关闭。
      //   （马赛克是坏段里真的没数据了，任何修复都变不出来。）
      repairMode: 'off',

      // 局域网手机点歌：同一 Wi-Fi 下的手机扫码即可点歌
      // 关掉它就不会监听任何端口
      lanEnabled: true,
      lanPort: 8088,
      // 已点歌曲的**相对**变调（半音）。0 = 原调。
      // 只有 mpv 内核支持（rubberband 滤镜）。
      pitchSemitones: 0,

      // 曲库来源：http(s) URL 或本地目录（目录里要有 manifest.json + 分片）
      // Gitee 对大文件 raw 下载要求登录，所以要么配 token，要么用本地目录
      catalogSource: 'https://gitee.com/yangyachao-X/maidong-ktv/raw/master/database_publish/database/manifest.json',
      catalogToken: '',
    },
  };
}

class UserState {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = emptyState();
    this._saveTimer = null;
    this._loaded = false;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = this._migrate(raw);
      // 刚启动时不可能有东西在播，但上次退出时正在播的条目状态是 playing。
      // 不降级的话它会一直挂着「已点」标：既不会被播放（takeNext 会跳过 playing），
      // 用户也没法重新点（重复校验拦下），等于卡死一首。
      for (const q of this.data.queue) {
        if (q.status === QueueStatus.Playing) q.status = QueueStatus.Waiting;
      }
      this._loaded = true;
    } catch {
      this.data = emptyState();
      this._loaded = true;
    }
    return this;
  }

  /** 兼容旧版本结构；缺字段一律补默认值。 */
  _migrate(raw) {
    const base = emptyState();
    if (!raw || typeof raw !== 'object') return base;
    const settings = { ...base.settings, ...(raw.settings || {}) };
    // v1 -> v2 的一次性迁移：
    //   1. 画面歌词位置默认从"屏幕正中"改成"画面底部居中"（用户明确要求）
    //   2. 底部 HTML 歌词条关掉 —— 它和画面里的歌词重复，用户会以为出了 bug
    // 只对旧版本生效；用户之后自己改过的值不会被反复覆盖。
    const ver = Number(raw.version) || 0;
    if (ver < 2) {
      settings.lyricsPos = 'bottom';
      settings.showLyrics = false;
      // 3. 关掉"流畅模式"：实测 display-fps 读数不稳定，锁错时钟反而更卡
      settings.smoothPlayback = false;
    }
    // v2 -> v3：硬解改回软解。
    // 分发的片源用 d3d11va 硬解会出马赛克（docs/16 里查过），在线流遇到坏包时
    // 硬解也不做错误掩盖。只有 auto 会被改；用户显式选了"硬解"就尊重他的选择。
    if (ver < 3 && settings.videoDecoder === 'auto') settings.videoDecoder = 'software';
    return {
      version: SCHEMA_VERSION,
      queue: Array.isArray(raw.queue) ? raw.queue : [],
      history: dedupeHistory(Array.isArray(raw.history) ? raw.history : []),
      favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
      playlists: (raw.playlists && typeof raw.playlists === 'object') ? raw.playlists : base.playlists,
      searchHistory: Array.isArray(raw.searchHistory) ? raw.searchHistory.slice(0, SEARCH_HISTORY_MAX) : [],
      onlineSaves: Array.isArray(raw.onlineSaves) ? raw.onlineSaves : [],
      settings,
    };
  }

  /** 合并写入，避免频繁小改动反复落盘。 */
  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);   // 原子替换，避免写一半损坏
    } catch (e) {
      console.error('[state] 保存失败:', e.message);
    }
  }

  // ── 队列 ────────────────────────────────────────────────
  /**
   * 加入已点队列。
   *
   * **同一首歌不能重复点**：已在队列里（等待中或播放中）就直接拒绝，
   * 否则"已点"列表会出现同一首歌好几条，看起来像 bug。
   * 唱完之后它会被移出队列并进入已唱历史，那时可以再点。
   *
   * @returns {{entry: object|null, duplicate: boolean, existing?: object}}
   */
  addToQueue(song, opts = {}) {
    const existing = this.data.queue.find(
      (q) => q.songId === song.id && (q.status === QueueStatus.Waiting || q.status === QueueStatus.Playing)
    );
    if (existing) return { entry: null, duplicate: true, existing };

    const entry = {
      entryId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      songId: song.id,
      name: song.name || '',
      singer: song.singer || '',
      lang: song.lang || '',
      filename: song.filename || '',
      accomp: Number(song.accomp || 0),
      playSource: song.playSource || null,
      platform: song.platform || null,
      platformId: song.platformId || null,
      mvId: song.mvId || null,
      cover: song.cover || '',
      duration: song.duration || 0,
      artist: song.artist || song.singer || '',
      title: song.title || song.name || '',
      online: !!song.online,
      addedAt: Date.now(),
      status: QueueStatus.Waiting,
    };
    if (opts.next) {
      // 插到"正在播放"之后的第一个位置
      const playingIdx = this.data.queue.findIndex((q) => q.status === QueueStatus.Playing);
      this.data.queue.splice(playingIdx >= 0 ? playingIdx + 1 : 0, 0, entry);
    } else {
      this.data.queue.push(entry);
    }
    this._scheduleSave();
    return { entry, duplicate: false };
  }

  /** 这首歌是否已在队列里（等待中或播放中）。 */
  isQueued(songId) {
    return this.data.queue.some(
      (q) => q.songId === songId && (q.status === QueueStatus.Waiting || q.status === QueueStatus.Playing)
    );
  }

  removeFromQueue(entryId) {
    const before = this.data.queue.length;
    this.data.queue = this.data.queue.filter((q) => q.entryId !== entryId);
    this._scheduleSave();
    return this.data.queue.length !== before;
  }

  /** 置顶：挪到"正在播放"之后（不是打断当前这首）。 */
  moveToNext(entryId) {
    const idx = this.data.queue.findIndex((q) => q.entryId === entryId);
    if (idx < 0) return false;
    const [entry] = this.data.queue.splice(idx, 1);
    const playingIdx = this.data.queue.findIndex((q) => q.status === QueueStatus.Playing);
    this.data.queue.splice(playingIdx >= 0 ? playingIdx + 1 : 0, 0, entry);
    this._scheduleSave();
    return true;
  }

  /**
   * 在队列里上移/下移一格。
   *
   * 只允许在 waiting 之间换位 —— 正在播的那条不能被挪走，
   * 也不能把别人挪到它前面（那样"当前正在唱"的语义就乱了）。
   * @param {string} entryId
   * @param {number} delta  -1 上移，+1 下移
   */
  moveInQueue(entryId, delta) {
    const d = Number(delta) > 0 ? 1 : -1;
    const q = this.data.queue;
    const idx = q.findIndex((x) => x.entryId === entryId);
    if (idx < 0) return false;
    if (q[idx].status !== QueueStatus.Waiting) return false;
    // 找相邻的另一个 waiting（中间可能夹着 playing）
    let j = idx + d;
    while (j >= 0 && j < q.length && q[j].status !== QueueStatus.Waiting) j += d;
    if (j < 0 || j >= q.length) return false;
    const [entry] = q.splice(idx, 1);
    q.splice(j, 0, entry);
    this._scheduleSave();
    return true;
  }

  /**
   * 把队列里某条移到"另一个 waiting 的位置"（拖拽用）。
   * 按钮走 moveInQueue(±1)，拖拽一次跨很多格，用这个一次到位。
   */
  moveInQueueTo(entryId, targetEntryId) {
    const q = this.data.queue;
    const from = q.findIndex((x) => x.entryId === entryId);
    const to = q.findIndex((x) => x.entryId === targetEntryId);
    if (from < 0 || to < 0 || from === to) return false;
    if (q[from].status !== QueueStatus.Waiting || q[to].status !== QueueStatus.Waiting) return false;
    const [entry] = q.splice(from, 1);
    q.splice(to, 0, entry);
    this._scheduleSave();
    return true;
  }

  clearQueue(keepPlaying = true) {
    this.data.queue = keepPlaying
      ? this.data.queue.filter((q) => q.status === QueueStatus.Playing)
      : [];
    this._scheduleSave();
  }

  /**
   * 取下一首待播。
   *
   * 注意：**唱完的条目会从队列里移除**（它已经进了已唱历史）。
   * 之前是把状态标成 played 留在列表里，结果队列越滚越长、
   * 还让"已点不能重复点"的校验失效。
   */
  takeNext() {
    this.data.queue = this.data.queue.filter((q) => q.status !== QueueStatus.Playing);
    const next = this.data.queue.find((q) => q.status === QueueStatus.Waiting);
    if (next) next.status = QueueStatus.Playing;
    this._scheduleSave();
    return next || null;
  }

  /** 标记当前正在播的条目（用于"直接点播"场景）。 */
  markPlaying(entryId) {
    this.data.queue = this.data.queue.filter((q) => q.status !== QueueStatus.Playing);
    const target = this.data.queue.find((q) => q.entryId === entryId);
    if (target) target.status = QueueStatus.Playing;
    this._scheduleSave();
  }

  /** 队列里正在播放的条目。 */
  currentEntry() {
    return this.data.queue.find((q) => q.status === QueueStatus.Playing) || null;
  }

  getQueue() {
    return this.data.queue.map((q) => ({ ...q }));
  }

  // ── 已唱 ────────────────────────────────────────────────
  markPlayed(song) {
    if (!song || !song.id) return;
    // 同一首只保留最近一次。反复唱同一首时，否则已唱列表会被它刷满、
    // 也看不出到底唱过哪些歌。
    this.data.history = this.data.history.filter((h) => h.songId !== song.id);
    this.data.history.unshift({
      songId: song.id,
      name: song.name || '',
      singer: song.singer || '',
      cover: song.cover || '',
      platform: song.platform || null,
      platformId: song.platformId || null,
      mvId: song.mvId || null,
      duration: song.duration || 0,
      artist: song.artist || song.singer || '',
      title: song.title || song.name || '',
      playedAt: Date.now(),
    });
    if (this.data.history.length > MAX_HISTORY) {
      this.data.history = this.data.history.slice(0, MAX_HISTORY);
    }
    this._scheduleSave();
  }

  getHistory() { return this.data.history.map((h) => ({ ...h })); }
  removeHistory(songId) {
    const before = this.data.history.length;
    this.data.history = this.data.history.filter((h) => h.songId !== songId);
    this._scheduleSave();
    return this.data.history.length !== before;
  }
  clearHistory() { this.data.history = []; this._scheduleSave(); }

  // ── 收藏 ────────────────────────────────────────────────
  toggleFavorite(songId) {
    const id = String(songId);
    const idx = this.data.favorites.indexOf(id);
    if (idx >= 0) this.data.favorites.splice(idx, 1);
    else this.data.favorites.unshift(id);
    this._scheduleSave();
    return idx < 0;   // true = 已收藏
  }

  /**
   * 收藏里上移/下移一格。
   * 收藏是 unshift 进去的（最新的在最前），所以"上移"= 往 idx-1 挪。
   */
  moveFavorite(songId, delta) {
    const d = Number(delta) > 0 ? 1 : -1;
    const list = this.data.favorites;
    const idx = list.indexOf(String(songId));
    if (idx < 0) return false;
    const j = idx + d;
    if (j < 0 || j >= list.length) return false;
    [list[idx], list[j]] = [list[j], list[idx]];
    this._scheduleSave();
    return true;
  }

  /** 收藏拖拽：把 songId 移到 targetSongId 的位置 */
  moveFavoriteTo(songId, targetSongId) {
    const list = this.data.favorites;
    const from = list.indexOf(String(songId));
    const to = list.indexOf(String(targetSongId));
    if (from < 0 || to < 0 || from === to) return false;
    const [id] = list.splice(from, 1);
    list.splice(to, 0, id);
    this._scheduleSave();
    return true;
  }

  isFavorite(songId) { return this.data.favorites.includes(String(songId)); }
  getFavorites() { return [...this.data.favorites]; }

  // ── 歌单 ────────────────────────────────────────────────
  getPlaylists() {
    return Object.entries(this.data.playlists).map(([name, ids]) => ({ name, count: ids.length }));
  }

  createPlaylist(name) {
    const n = String(name || '').trim();
    if (!n) throw new Error('歌单名不能为空');
    if (this.data.playlists[n]) throw new Error(`歌单「${n}」已存在`);
    this.data.playlists[n] = [];
    this._scheduleSave();
    return n;
  }

  deletePlaylist(name) {
    if (name === '我的收藏') throw new Error('默认歌单不可删除');
    if (!this.data.playlists[name]) return false;
    delete this.data.playlists[name];
    this._scheduleSave();
    return true;
  }

  addToPlaylist(name, songId) {
    const list = this.data.playlists[name];
    if (!list) throw new Error(`歌单「${name}」不存在`);
    const id = String(songId);
    if (!list.includes(id)) { list.push(id); this._scheduleSave(); }
    return list.length;
  }

  removeFromPlaylist(name, songId) {
    const list = this.data.playlists[name];
    if (!list) return false;
    const id = String(songId);
    const idx = list.indexOf(id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this._scheduleSave();
    return true;
  }

  /** 歌单里上移/下移一格。 */
  moveInPlaylist(name, songId, delta) {
    const list = this.data.playlists[name];
    if (!list) return false;
    const d = Number(delta) > 0 ? 1 : -1;
    const idx = list.indexOf(String(songId));
    if (idx < 0) return false;
    const j = idx + d;
    if (j < 0 || j >= list.length) return false;
    [list[idx], list[j]] = [list[j], list[idx]];
    this._scheduleSave();
    return true;
  }

  /** 歌单拖拽：把 songId 移到 targetSongId 的位置 */
  moveInPlaylistTo(name, songId, targetSongId) {
    const list = this.data.playlists[name];
    if (!list) return false;
    const from = list.indexOf(String(songId));
    const to = list.indexOf(String(targetSongId));
    if (from < 0 || to < 0 || from === to) return false;
    const [id] = list.splice(from, 1);
    list.splice(to, 0, id);
    this._scheduleSave();
    return true;
  }

  getPlaylistSongs(name) { return [...(this.data.playlists[name] || [])]; }

  // ── 搜索历史 ────────────────────────────────────────────
  /**
   * 记一条搜索词。
   * 遥控器/小键盘输字很麻烦，常用的几个词能直接点比重新输一遍强得多。
   * 同一个词再搜一次会**挪到最前**（而不是产生重复项）。
   */
  addSearchHistory(keyword) {
    const kw = String(keyword || '').trim();
    if (!kw) return false;
    const list = this.data.searchHistory;
    const idx = list.indexOf(kw);
    if (idx >= 0) list.splice(idx, 1);
    list.unshift(kw);
    if (list.length > SEARCH_HISTORY_MAX) list.length = SEARCH_HISTORY_MAX;
    this._scheduleSave();
    return true;
  }

  getSearchHistory() { return [...this.data.searchHistory]; }

  removeSearchHistory(keyword) {
    const list = this.data.searchHistory;
    const idx = list.indexOf(String(keyword));
    if (idx < 0) return false;
    list.splice(idx, 1);
    this._scheduleSave();
    return true;
  }

  clearSearchHistory() { this.data.searchHistory = []; this._scheduleSave(); }

  // ── 在线收藏 ────────────────────────────────────────────
  /**
   * 收藏一首**在线**搜到的歌。
   *
   * 和曲库收藏的区别：这些歌不在本地曲库里（670k 曲库里没有），
   * 每次都得重新搜。收藏之后在「在线」标签下（不输关键词时）直接能点到。
   *
   * 用 platform:id 做唯一键 —— 同一首歌在不同平台是两条记录。
   */
  addOnlineSave(item) {
    const it = item || {};
    const key = onlineKey(it);
    if (!key) return false;
    const list = this.data.onlineSaves;
    const idx = list.findIndex((x) => onlineKey(x) === key);
    if (idx >= 0) list.splice(idx, 1);
    list.unshift({
      platform: String(it.platform || ''),
      id: String(it.id || ''),
      mvId: it.mvId ? String(it.mvId) : null,
      title: String(it.title || it.name || ''),
      artist: String(it.artist || it.singer || ''),
      duration: Number(it.duration) || 0,
      cover: String(it.cover || ''),
      savedAt: Date.now(),
    });
    if (list.length > ONLINE_SAVE_MAX) list.length = ONLINE_SAVE_MAX;
    this._scheduleSave();
    return true;
  }

  removeOnlineSave(key) {
    const list = this.data.onlineSaves;
    const idx = list.findIndex((x) => onlineKey(x) === String(key));
    if (idx < 0) return false;
    list.splice(idx, 1);
    this._scheduleSave();
    return true;
  }

  getOnlineSaves() { return this.data.onlineSaves.map((x) => ({ ...x })); }

  // ── 设置 ────────────────────────────────────────────────
  getSettings() { return { ...this.data.settings }; }

  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...(patch || {}) };
    this._scheduleSave();
    return this.getSettings();
  }
}

module.exports = { UserState, QueueStatus, emptyState, SCHEMA_VERSION, SEARCH_HISTORY_MAX, ONLINE_SAVE_MAX, onlineKey };
