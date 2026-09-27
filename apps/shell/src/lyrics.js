/**
 * 歌词服务
 * ========
 * 曲库的 songs.lyrics 字段大多是空的，所以歌词要单独取。
 *
 * 来源：网易云公开接口（与 karaoke-companion 的 LyricService 同源，MIT 授权）
 *   搜索: GET https://music.163.com/api/search/get/web?s=<歌名+歌手>&type=1&limit=N
 *   歌词: GET https://music.163.com/api/song/lyric?id=<id>&lv=1&kv=1&tv=-1
 *
 * 取到后按曲目 id 缓存到 <dataRoot>/lyrics/<songId>.lrc，
 * 之后同一首歌不再请求网络。
 *
 * **逐字（卡拉OK）歌词**：v1 接口的 `yrc` 字段带每个字的时间轴，格式是
 * NDJSON + YRC：
 *   {"t":0,"c":[...]}                      ← 元数据行（作词/作曲等），跳过
 *   [行起始ms,行时长ms](字起始ms,字时长ms,0)字(字起始ms,字时长ms,0)字...
 * 解析结果缓存到 <songId>.yrc.json，用来生成视频里的 ASS 卡拉OK字幕。
 *
 * ⚠️ 同曲多版本陷阱（实测踩过）：
 * 网易云上同一首歌往往有多个版本，**其中个别版本的歌词被平台做了星号替换**。
 * 例如《阴天》莫文蔚：
 *   id=108640  ->  [00:26.600]爱情究竟是精神**      ← 被替换
 *   id=277775  ->  [00:26.679]爱情究竟是精神鸦片    ← 完整
 * 早期实现只取"第一条歌手匹配"，恰好命中被替换的那个版本，于是用户无论重取
 * 多少次看到的都是星号。现在改为：按匹配度取一批候选，**优先选用没有被替换的
 * 版本**，只有全部候选都被替换时才退而用星号版（并标记 censored）。
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const SEARCH_API = 'https://music.163.com/api/search/get/web';
const LYRIC_API = 'https://music.163.com/api/song/lyric';
/** v1 接口才带 yrc（逐字时间轴），老接口只有逐行 */
const LYRIC_API_V1 = 'https://music.163.com/api/song/lyric/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 12000;

/** 搜索取回多少条候选（多取一些才有换版本挑干净歌词的余地） */
const SEARCH_LIMIT = 10;
/** 最多为几首候选去拉歌词，避免极端情况下打太多请求 */
const MAX_CANDIDATES = 5;

const HEADERS = { 'User-Agent': UA, 'Referer': 'https://music.163.com/' };

/** 清掉曲库歌名里常见的修饰，提高搜索命中率。 */
function cleanTitle(name) {
  return String(name || '')
    .replace(/\((HD|MV|DJ版|Live|伴奏|原版|国语|粤语|日语|英语)[^)]*\)/gi, '')
    .replace(/（[^）]*(HD|MV|DJ版|Live|伴奏|原版)[^）]*）/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
}

/** 歌手名可能是一串（"莫文蔚、李宗盛"），搜索时只取第一个。 */
function primarySinger(singer) {
  return String(singer || '').split(/[、,，/&]/)[0].trim();
}

/**
 * 歌词是否被平台做了星号替换。
 * 判据是出现连续两个及以上的 `*`——正常歌词里极少出现。
 */
function looksCensored(lrc) {
  return /\*{2,}/.test(String(lrc || ''));
}

/**
 * 解析 yrc 文本 -> [{ time, duration, words: [{ t, d, text }] }]
 *
 * yrc 是 NDJSON：元数据行是 JSON，歌词行是 YRC。两种混在一起，按首字符区分。
 * 注意字数不固定：一个 "(t,d,0)" 后面跟到下一个 "(" 之前的所有字符都属于这个字，
 * 可能包含空格（例如 "人 "）。
 */
function parseYrc(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('{')) continue;      // JSON 元数据行
    const head = s.match(/^\[(\d+),(\d+)\]/);
    if (!head) continue;
    const rest = s.slice(head[0].length);
    const words = [];
    const re = /\((\d+),(\d+),(\d+)\)([^()]*)/g;
    let m;
    while ((m = re.exec(rest)) !== null) {
      words.push({ t: Number(m[1]), d: Number(m[2]), text: m[4] });
    }
    if (words.length) {
      out.push({ time: Number(head[1]), duration: Number(head[2]), words });
    }
  }
  return out;
}

/**
 * 解析 LRC 文本 -> [{ time: 毫秒, duration, text }]
 *
 * 和渲染进程里那份的区别：这里是**给画面歌词用的**，所以时间统一成毫秒，
 * 并且顺手把 duration 补上（用下一行的开始时间），这样 ASS 滚动事件
 * 不需要再自己算行尾。
 *
 * 支持一行多个时间标签（`[00:10.00][01:20.00]副歌`），也忽略 [ar:]/[ti:] 这类元信息。
 */
function parseLrc(raw) {
  const rows = [];
  const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of String(raw || '').split(/\r?\n/)) {
    const tags = [...line.matchAll(re)];
    if (!tags.length) continue;
    const text = line.replace(re, '').trim();
    if (!text) continue;
    for (const t of tags) {
      const frac = t[3] ? Number('0.' + t[3]) : 0;
      rows.push({ time: Math.round((Number(t[1]) * 60 + Number(t[2]) + frac) * 1000), text });
    }
  }
  rows.sort((a, b) => a.time - b.time);
  for (let i = 0; i < rows.length; i++) {
    const next = rows[i + 1];
    rows[i].duration = next && next.time > rows[i].time ? next.time - rows[i].time : 5000;
  }
  return rows;
}
function synthesizeWordsFromLrc(raw) {
  const rows = parseLrc(raw);
  const tokenize = (text) => String(text || '').match(/[\u4e00-\u9fff]|[a-zA-Z0-9]+|[^\s]/g) || [];
  const out = [];
  for (const row of rows) {
    const tokens = tokenize(row.text);
    if (!tokens.length) continue;
    const duration = Math.max(300, Number(row.duration) || 3000);
    const step = duration / tokens.length;
    out.push({
      time: row.time,
      duration,
      words: tokens.map((text, i) => ({
        t: Math.round(row.time + i * step),
        d: Math.max(80, Math.round(step)),
        text,
      })),
    });
  }
  return out;
}

/**
 * 标题归一化：去掉空格/标点/大小写差异，只留字。
 * "阴天(HD)" 和 "阴天" 归一化后都是 "阴天"。
 */
function normalizeTitle(s) {
  // 先走一遍 cleanTitle：曲库名带 (HD)/(Live) 这类后缀，候选那边也可能带，
  // 不先清掉的话「阴天」和「阴天 (Live)」会被判成不匹配。
  return cleanTitle(s).toLowerCase()
    .replace(/[\s\-_·、，,。.！!？?（）()\[\]【】「」"'’“”~～:：;；/\\]/g, '');
}

/** 两个字串的相似度（Dice 系数，按字符多重集算）。0~1。 */
function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  const count = (s) => { const m = new Map(); for (const ch of s) m.set(ch, (m.get(ch) || 0) + 1); return m; };
  const ma = count(a), mb = count(b);
  let hit = 0;
  for (const [ch, n] of ma) hit += Math.min(n, mb.get(ch) || 0);
  return (2 * hit) / (a.length + b.length);
}

/**
 * 候选的标题是否算"匹配"。
 *
 * ⚠️ 网易云的搜索是**模糊**的：拿一个根本不存在的歌名去搜，它照样会返回一堆无关结果
 * （实测搜「这首歌肯定不存在zzzqqq123」返回了另一首歌）。
 * 不自己核对标题的话，用户会看到**别人的歌词** —— 而且歌词条本身没问题、
 * 时间轴也对得上，几乎不可能发现。所以这里必须卡一道。
 */
function titleMatches(query, candidate) {
  const a = normalizeTitle(query);
  const b = normalizeTitle(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  // 包含关系要**长度占比达标**才算：
  // 「这首歌肯定不存在zzzqqq123」里含「存在」，不卡占比就会匹配到《存在》——
  // 实测就是这个例子，用户会拿到完全无关的歌词。
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 2 && long.includes(short) && short.length / long.length >= 0.7) return true;
  return titleSimilarity(a, b) >= 0.7;
}
/**
 * QQ 音乐歌词（**兜底源**）
 * ========================
 * 网易云的库对冷门歌经常搜不到（或者搜到的是另一首歌）。QQ 音乐的曲库更大，
 * 而且它的歌词接口**只要带 Referer 就能用**，不需要登录、不需要 cookie。
 *
 * 代价：这个接口只给**逐行 LRC**，没有逐字（QRC）。所以只在网易云那条路走不通时用，
 * 界面上的"逐字上色"会自动退化成整行高亮 —— 有歌词总比没有强。
 */
const QQ_SEARCH_API = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
const QQ_LYRIC_API = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
const QQ_HEADERS = {
  Referer: 'https://y.qq.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
};

/** QQ 的搜索接口会包一层 `callback(...)`，剥掉再 parse。 */
function parseQQJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch { /* 继续 */ }
  const m = /^[^(]*\((.*)\)[;\s]*$/s.exec(s);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
class LyricsService {
  constructor({ cacheDir }) {
    this.cacheDir = cacheDir;
    this._pending = new Map();   // songId -> Promise，避免同一首并发重复请求
  }

  init() {
    try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch { /* 忽略 */ }
    this._purgeCensoredCache();
    return this;
  }

  /**
   * 清掉早期版本缓存下来的"被星号替换"的歌词。
   *
   * 不做这一步的话，用户升级后仍然命中旧缓存，看起来像"修了没用"。
   * 删掉之后下次点歌会重新走候选优选，拿到干净版本。
   */
  _purgeCensoredCache() {
    let names;
    try { names = fs.readdirSync(this.cacheDir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.lrc')) continue;
      const full = path.join(this.cacheDir, name);
      try {
        if (looksCensored(fs.readFileSync(full, 'utf8'))) {
          fs.rmSync(full, { force: true });
          console.log('[lyrics] 已清除被屏蔽的歌词缓存:', name);
        }
      } catch { /* 读不了就跳过 */ }
    }
  }

  _cachePath(songId) { return path.join(this.cacheDir, String(songId).replace(/[^\w-]/g, '_') + '.lrc'); }
  _wordsPath(songId) { return path.join(this.cacheDir, String(songId).replace(/[^\w-]/g, '_') + '.yrc.json'); }
  _metaPath(songId) { return path.join(this.cacheDir, String(songId).replace(/[^\w-]/g, '_') + '.lyric-meta.json'); }

  /** 逐字歌词缓存；没有/坏了都返回 null。 */
  readWordsCache(songId) {
    try {
      const arr = JSON.parse(fs.readFileSync(this._wordsPath(songId), 'utf8'));
      return Array.isArray(arr) && arr.length ? arr : null;
    } catch { return null; }
  }

  readMeta(songId) {
    try { return JSON.parse(fs.readFileSync(this._metaPath(songId), 'utf8')); } catch { return null; }
  }

  /** 读本地缓存；没有返回 null。 */
  readCache(songId) {
    try { return fs.readFileSync(this._cachePath(songId), 'utf8'); } catch { return null; }
  }

  async _getJson(url) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  /**
   * 搜索网易云，返回按匹配度排序的候选 songId 列表（歌手匹配的排前面）。
   * @returns {Promise<Array<string|number>>}
   */
  async searchCandidates(name, singer) {
    const title = cleanTitle(name);
    const artist = primarySinger(singer);
    const keyword = (title + ' ' + artist).trim();
    const url = SEARCH_API + '?s=' + encodeURIComponent(keyword)
      + '&type=1&offset=0&limit=' + SEARCH_LIMIT;
    const json = await this._getJson(url);
    const songs = json?.result?.songs || [];
    if (!songs.length) return [];

    const matched = [];
    const rest = [];
    for (const s of songs) {
      // 标题不像的直接丢 —— 否则「搜不到」会变成「拿到别人的歌词」
      if (!titleMatches(title, s.name)) continue;
      const hit = !!artist && (s.artists || []).some((a) =>
        String(a.name || '').includes(artist) || artist.includes(String(a.name || '')));
      (hit ? matched : rest).push(s.id);
    }
    return [...matched, ...rest];
  }

  /**
   * 网易云这条路走不通时的兜底：去 QQ 音乐再试一次。
   * 走不通的三种情况：网易云没候选 / 候选没歌词 / 候选全是星号屏蔽版。
   */
  async _fallbackQQ(song) {
    const miss = '网易云和 QQ 音乐都没搜到匹配的歌词';
    try {
      const r = await this.fetchFromQQ(song.name, song.singer);
      if (!r) return { ok: false, error: miss };
      const words = synthesizeWordsFromLrc(r.lrc);
      await fsp.writeFile(this._cachePath(song.id), r.lrc, 'utf8');
      await fsp.writeFile(this._metaPath(song.id), JSON.stringify({ qqMid: r.qqMid }), 'utf8');
      if (words.length) await fsp.writeFile(this._wordsPath(song.id), JSON.stringify(words), 'utf8');
      return { ok: true, lrc: r.lrc, words: words.length ? words : null, cached: false, source: 'qq' };
    } catch {
      return { ok: false, error: miss };
    }
  }
  /**
   * 从 QQ 音乐取歌词（兜底）。拿不到就返回 null，绝不抛。
   * @returns {Promise<{lrc:string, qqMid:string}|null>}
   */
  async fetchFromQQ(name, singer) {
    const title = cleanTitle(name);
    const artist = primarySinger(singer);
    const keyword = (title + ' ' + artist).trim();
    if (!keyword) return null;
    const url = QQ_SEARCH_API + '?w=' + encodeURIComponent(keyword) + '&format=json&n=8&p=1&aggr=0&cr=1&new_json=1';
    const res = await fetch(url, { headers: QQ_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = parseQQJson(await res.text());
    const list = (json && json.data && json.data.song && json.data.song.list) || [];
    if (!list.length) return null;

    // 和网易云那条路一样：**标题必须像**，否则宁可不给（给错歌词比没歌词更糟）
    const pick = list.find((s) => titleMatches(title, s.title || s.songname))
      || list.find((s) => titleMatches(title, s.name));
    if (!pick) return null;
    const mid = pick.songmid || pick.mid;
    if (!mid) return null;

    const lres = await fetch(`${QQ_LYRIC_API}?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1&g_tk=5381`,
      { headers: QQ_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!lres.ok) return null;
    const ljson = parseQQJson(await lres.text());
    const lrc = (ljson && ljson.lyric) || '';
    if (!lrc.trim()) return null;
    return { lrc, qqMid: mid };
  }
  /** 只取最匹配的一个候选（保留给需要单一结果的调用方）。 */
  async searchSongId(name, singer) {
    const list = await this.searchCandidates(name, singer);
    return list.length ? list[0] : null;
  }

  /** 拉取 LRC 文本（老接口，只有逐行）。 */
  async fetchLrc(neteaseId) {
    const url = LYRIC_API + '?id=' + neteaseId + '&lv=1&kv=1&tv=-1';
    const json = await this._getJson(url);
    return json?.lrc?.lyric || '';
  }

  /**
   * 一次请求同时拿逐行 + 逐字。
   * 只有 v1 接口返回 yrc；拿不到 yrc 时 yrc 为空字符串，不影响逐行歌词。
   */
  async fetchBundle(neteaseId) {
    const url = LYRIC_API_V1 + '?id=' + neteaseId
      + '&lv=-1&kv=-1&tv=-1&rv=-1&yv=-1&ytv=-1&yrv=-1';
    const json = await this._getJson(url);
    return {
      lrc: json?.lrc?.lyric || '',
      yrc: json?.yrc?.lyric || '',
      // 有逐行没逐字时，klyric 是逐行版的"逐字"，质量差一些，暂时不用
    };
  }

  /**
   * 取歌词（先查缓存）。
   *
   * 候选里优先返回**没有被星号替换**的版本；全都带星号时退而用第一份，
   * 并在结果里带 censored: true，让界面有机会提示用户。
   *
   * 同时会尽量带回**逐字时间轴**（words），拿不到就是 null —— 逐行歌词照常用。
   *
   * @param {{id:string, name:string, singer:string}} song
   * @returns {Promise<{ok:boolean, lrc?:string, words?:Array|null, cached?:boolean, censored?:boolean, error?:string}>}
   */
  async get(song) {
    if (!song || !song.id) return { ok: false, error: '缺少曲目信息' };

    const cached = this.readCache(song.id);
    if (cached) {
      const words = this.readWordsCache(song.id);
      // 老缓存只有逐行。有 neteaseId 就后台补一次逐字，补到了再通知上层刷新字幕，
      // 不阻塞这次返回（否则每次点老歌都要多等一个网络往返）。
      if (!words) {
        // 老缓存连 neteaseId 都没记（早期版本没写 meta），这时让回填自己搜一次
        const meta = this.readMeta(song.id);
        this._backfillWords(song.id, meta?.neteaseId || null, song);
      }
      return { ok: true, lrc: cached, words: words || null, cached: true };
    }

    if (this._pending.has(song.id)) return this._pending.get(song.id);

    const task = (async () => {
      try {
        // QQ 在线歌曲优先用 QQ 自己的歌词：MV 与音频版常有时间差，
        // 先拿源站歌词通常更接近视频本身。
        if (song.platform === 'qq') {
          const qq = await this.fetchFromQQ(song.name, song.singer).catch(() => null);
          if (qq && qq.lrc.trim()) {
            const words = synthesizeWordsFromLrc(qq.lrc);
            await fsp.writeFile(this._cachePath(song.id), qq.lrc, 'utf8');
            await fsp.writeFile(this._metaPath(song.id), JSON.stringify({ qqMid: qq.qqMid }), 'utf8');
            if (words.length) await fsp.writeFile(this._wordsPath(song.id), JSON.stringify(words), 'utf8');
            return { ok: true, lrc: qq.lrc, words: words.length ? words : null, cached: false, source: 'qq' };
          }
        }
        const candidates = await this.searchCandidates(song.name, song.singer);
        if (!candidates.length) return await this._fallbackQQ(song);

        // 先取最匹配的那条。正常情况只发一次请求。
        const first = await this.fetchBundle(candidates[0]);
        if (!first.lrc.trim()) return await this._fallbackQQ(song);

        let chosen = first;
        let chosenId = candidates[0];
        let censored = looksCensored(first.lrc);

        // 只有第一候选被星号替换时才往后找干净版本，
        // 这样"没搜到"的语义不会被放宽（否则乱搜也能命中别的歌）。
        if (censored) {
          for (const id of candidates.slice(1, MAX_CANDIDATES)) {
            let bundle;
            try { bundle = await this.fetchBundle(id); } catch { continue; }
            if (!bundle.lrc.trim() || looksCensored(bundle.lrc)) continue;
            chosen = bundle; chosenId = id; censored = false;
            break;
          }
        }

        // 网易云这边全是星号屏蔽版时，去 QQ 碰碰运气（那边经常有干净版）
        if (censored) {
          const qq = await this.fetchFromQQ(song.name, song.singer).catch(() => null);
          if (qq && !looksCensored(qq.lrc)) {
            await fsp.writeFile(this._cachePath(song.id), qq.lrc, 'utf8');
            await fsp.writeFile(this._metaPath(song.id), JSON.stringify({ qqMid: qq.qqMid }), 'utf8');
            return { ok: true, lrc: qq.lrc, words: null, cached: false, source: 'qq' };
          }
        }

        let words = parseYrc(chosen.yrc);
        if (!words.length) words = synthesizeWordsFromLrc(chosen.lrc);
        await fsp.writeFile(this._cachePath(song.id), chosen.lrc, 'utf8');
        await fsp.writeFile(this._metaPath(song.id), JSON.stringify({ neteaseId: chosenId }), 'utf8');
        if (words.length) {
          await fsp.writeFile(this._wordsPath(song.id), JSON.stringify(words), 'utf8');
        }
        return {
          ok: true, lrc: chosen.lrc, words: words.length ? words : null,
          cached: false, neteaseId: chosenId, censored,
        };
      } catch (e) {
        return { ok: false, error: e.message };
      } finally {
        this._pending.delete(song.id);
      }
    })();

    this._pending.set(song.id, task);
    return task;
  }

  /**
   * 后台补逐字歌词（老缓存升级用）。补到就缓存并通知上层。
   * neteaseId 缺失时自己搜一次（早期缓存没记 id）。
   */
  _backfillWords(songId, neteaseId, song) {
    const key = 'w:' + songId;
    if (this._pending.has(key)) return this._pending.get(key);
    const task = (async () => {
      try {
        let id = neteaseId;
        if (!id) {
          if (!song) return null;
          const cands = await this.searchCandidates(song.name, song.singer);
          if (!cands.length) return null;
          id = cands[0];
        }
        const bundle = await this.fetchBundle(id);
        let words = parseYrc(bundle.yrc);
        if (!words.length) words = synthesizeWordsFromLrc(this.readCache(songId) || bundle.lrc);
        if (!words.length) return null;
        await fsp.writeFile(this._metaPath(songId), JSON.stringify({ neteaseId: id }), 'utf8');
        await fsp.writeFile(this._wordsPath(songId), JSON.stringify(words), 'utf8');
        try { this.onWordsReady?.(songId, words); } catch { /* 回调失败不影响缓存 */ }
        return words;
      } catch { return null; } finally { this._pending.delete(key); }
    })();
    this._pending.set(key, task);
    return task;
  }
}

module.exports = { LyricsService, cleanTitle, primarySinger, looksCensored, parseYrc, parseLrc, synthesizeWordsFromLrc,
  normalizeTitle, titleSimilarity, titleMatches };