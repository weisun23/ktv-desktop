/**
 * muse.db 读取层
 * ==============
 * 直接复用 maidong 的曲库 schema，只读打开，不做任何写入。
 *
 * 表关系：
 *   songs                    670k 首（曲目元数据）
 *   singers                  136k 位
 *   song_singer_relations    songs <-> singers 多对多
 *   song_langs               语种字典
 *
 * 两个必须知道的坑：
 *   1. songs.singer_names 在库里恒为空，歌手名必须 JOIN song_singer_relations 取。
 *   2. songs.accomp 不是布尔值，是"原伴唱声道模式"：
 *        accomp = 1 -> 左声道=伴奏, 右声道=原唱
 *        accomp = 2 -> 左声道=原唱, 右声道=伴奏
 *        accomp <= 0 -> 不做声道切换
 *      本层只负责原样返回 accomp，具体声道映射由播放器解释
 *      （见 apps/player/src/player.js 的 channelMapForAccomp）。
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 200;

function clampPage(limit, offset) {
  const l = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(limit) || PAGE_SIZE_DEFAULT));
  const o = Math.max(0, Number(offset) || 0);
  return { limit: l, offset: o };
}

/** songs 行的统一投影：歌手名从关联表兜底取。 */
const SONG_COLUMNS = `
  s.id, s.name, s.name_cap, s.name_full, s.lang, s.filename, s.filename_prefix,
  s.accomp, s.hot_score, s.rec_score, s.cloud_url, s.lyrics,
  COALESCE(NULLIF(s.singer_names, ''),
    (SELECT group_concat(sg.name, '、') FROM song_singer_relations ssr
       INNER JOIN singers sg ON sg.id = ssr.singer_id
      WHERE ssr.song_id = s.id), '') AS singer`;

const RECOMMEND_ORDER = 'ORDER BY s.rec_score DESC, s.local_hot_score DESC, s.hot_score DESC';

function toSong(row) {
  if (!row) return null;
  const filename = row.filename || '';
  return {
    id: row.id,
    name: row.name || '',
    singer: row.singer || '',
    lang: row.lang || '',
    filename,
    // 取流接口用"文件名去扩展名"作为 musicNo
    musicNo: filename.replace(/\.[^.]+$/, ''),
    accomp: Number(row.accomp ?? 0),
    hotScore: Number(row.hot_score || 0),
    recScore: row.rec_score == null ? null : Number(row.rec_score),
    hasCloudUrl: !!(row.cloud_url && row.cloud_url.length),
    hasLyrics: !!(row.lyrics && row.lyrics.length),
    source: 'muse',
  };
}

class MuseCatalog {
  /** @param {string} dbPath muse.db 路径 */
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this._stmts = new Map();
  }

  open() {
    if (this.db) return this;
    this.db = new DatabaseSync(this.dbPath, { readOnly: true });
    // 只读 + 大库：给它更宽松的缓存
    try { this.db.exec('PRAGMA cache_size = -32768'); } catch { /* 只读库可能不允许 */ }
    return this;
  }

  close() {
    if (this.db) { this.db.close(); this.db = null; this._stmts.clear(); }
  }

  get isOpen() { return !!this.db; }

  /** 预编译并缓存语句（SQLite 准备语句有一定开销，曲库查询很频繁）。 */
  _stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this._stmts.set(sql, s); }
    return s;
  }

  stats() {
    const songs = this._stmt('SELECT COUNT(*) c FROM songs WHERE deleted_at IS NULL').get().c;
    const singers = this._stmt("SELECT COUNT(*) c FROM singers WHERE deleted_at IS NULL AND name != '' AND name != '#0000FF'").get().c;
    const withUrl = this._stmt("SELECT COUNT(*) c FROM songs WHERE deleted_at IS NULL AND cloud_url IS NOT NULL AND cloud_url != ''").get().c;
    return { songs: Number(songs), singers: Number(singers), songsWithCloudUrl: Number(withUrl) };
  }

  languages() {
    return this._stmt('SELECT name FROM song_langs WHERE deleted_at IS NULL ORDER BY sort_no ASC')
      .all().map((r) => r.name).filter(Boolean);
  }

  /**
   * 搜索歌曲：歌名 / 拼音首字母 / 歌手名 三路匹配。
   * @param {{keyword?:string, lang?:string, limit?:number, offset?:number}} opts
   */
  searchSongs(opts = {}) {
    const { limit, offset } = clampPage(opts.limit, opts.offset);
    const keyword = String(opts.keyword || '').trim();
    const lang = opts.lang && opts.lang !== '全部' ? String(opts.lang) : '';

    if (!keyword) return this.hotSongs({ lang, limit, offset });

    const like = `%${keyword}%`;
    const capLike = `${keyword.toUpperCase()}%`;
    const conditions = [
      '(s.name LIKE ? OR s.name_trim LIKE ? OR s.name_cap LIKE ? OR s.name_full LIKE ?',
      ` OR EXISTS (SELECT 1 FROM song_singer_relations r2
                     INNER JOIN singers g2 ON g2.id = r2.singer_id
                    WHERE r2.song_id = s.id AND g2.name LIKE ?))`,
    ].join('');
    const params = [like, like, capLike, like, like];
    let where = `s.deleted_at IS NULL AND ${conditions}`;
    if (lang) { where += ' AND s.lang = ?'; params.push(lang); }

    // 多取一条判断"还有更多"，避免为了精确总数去 COUNT 全表
    // （实测 countSearch 在 66k 结果时要 ~4s，而 LIMIT 查询只要几毫秒）
    const sql = `SELECT ${SONG_COLUMNS} FROM songs s WHERE ${where} ${RECOMMEND_ORDER} LIMIT ? OFFSET ?`;
    const rows = this._stmt(sql).all(...params, limit + 1, offset);
    return { songs: rows.slice(0, limit).map(toSong), hasMore: rows.length > limit };
  }

  /**
   * 搜索结果总数。
   * ⚠️ 很慢：带歌手 EXISTS 条件时无法走索引，66k 结果约 4s。
   * 分页请用 searchSongs 返回的 hasMore，不要调它。
   */
  countSearch(keyword, lang) {
    const kw = String(keyword || '').trim();
    if (!kw) return this.countSongs(lang);
    const like = `%${kw}%`;
    const capLike = `${kw.toUpperCase()}%`;
    const params = [like, like, capLike, like, like];
    let where = `s.deleted_at IS NULL AND (s.name LIKE ? OR s.name_trim LIKE ? OR s.name_cap LIKE ? OR s.name_full LIKE ?
      OR EXISTS (SELECT 1 FROM song_singer_relations r2 INNER JOIN singers g2 ON g2.id = r2.singer_id
                  WHERE r2.song_id = s.id AND g2.name LIKE ?))`;
    if (lang && lang !== '全部') { where += ' AND s.lang = ?'; params.push(lang); }
    return Number(this._stmt(`SELECT COUNT(*) c FROM songs s WHERE ${where}`).get(...params).c);
  }

  countSongs(lang) {
    if (lang && lang !== '全部') {
      return Number(this._stmt('SELECT COUNT(*) c FROM songs WHERE deleted_at IS NULL AND lang = ?').get(lang).c);
    }
    return Number(this._stmt('SELECT COUNT(*) c FROM songs WHERE deleted_at IS NULL').get().c);
  }

  /** 热歌榜（走 idx_rec_score 索引，很快）。 */
  hotSongs(opts = {}) {
    const { limit, offset } = clampPage(opts.limit, opts.offset);
    const lang = opts.lang && opts.lang !== '全部' ? String(opts.lang) : '';
    const where = lang ? 's.deleted_at IS NULL AND s.lang = ?' : 's.deleted_at IS NULL';
    const params = lang ? [lang, limit + 1, offset] : [limit + 1, offset];
    const sql = `SELECT ${SONG_COLUMNS} FROM songs s WHERE ${where} ${RECOMMEND_ORDER} LIMIT ? OFFSET ?`;
    const rows = this._stmt(sql).all(...params);
    return { songs: rows.slice(0, limit).map(toSong), hasMore: rows.length > limit };
  }

  /**
   * 按 id 批量取曲目。
   *
   * 为什么要有这个：收藏/歌单/已唱都是"一串 id → 一堆曲目"。
   * 逐个调 songById 的话，200 首就是 200 次 HTTP 往返 + 200 次 SQL 编译，
   * 实测列表要等好几秒。一条 IN 查询搞定。
   *
   * 返回值保持**传入顺序**（调用方按 id 顺序展示），查不到的跳过（已下架）。
   * @param {string[]} ids
   */
  songsByIds(ids) {
    const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
    if (!list.length) return [];
    const out = new Map();
    // SQLite 的变量上限是 999，分批查
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const holes = chunk.map(() => '?').join(',');
      const rows = this._stmt(`SELECT ${SONG_COLUMNS} FROM songs s WHERE s.id IN (${holes})`).all(...chunk);
      for (const r of rows) { const s = toSong(r); if (s) out.set(String(s.id), s); }
    }
    return list.map((id) => out.get(id)).filter(Boolean);
  }

  songById(id) {
    const row = this._stmt(`SELECT ${SONG_COLUMNS} FROM songs s WHERE s.id = ? LIMIT 1`).get(String(id));
    return toSong(row);
  }

  /** 按文件名（musicNo）查曲目，本地文件入库时用。 */
  songByMusicNo(musicNo) {
    const row = this._stmt(`SELECT ${SONG_COLUMNS} FROM songs s
      WHERE s.deleted_at IS NULL AND (s.filename = ? OR s.filename_prefix = ?) LIMIT 1`)
      .get(`${musicNo}.ts`, String(musicNo));
    return toSong(row);
  }

  // ── 歌手 ──────────────────────────────────────────────
  /**
   * 把首字母筛选转成 SQL 条件。
   *
   * ⚠️ 必须用**范围比较**而不是 `upper(substr(name_cap,1,1)) = ?` 或 `LIKE 'Z%'`：
   * 那两种写法在列上套了函数/大小写折叠，SQLite 用不上索引 ——
   * 实测 29ms / 17ms，而范围写法走 idx_name_cap 只要 **4.3ms**。
   * （实测库里没有小写 name_cap，所以直接按大写范围切是安全的。）
   */
  _letterCond(letter) {
    const L = String(letter || '').toUpperCase();
    if (L === '#') return { sql: "(name_cap < 'A' OR name_cap >= '[')", params: [] };
    if (L.length !== 1 || L < 'A' || L > 'Z') return null;
    const next = String.fromCharCode(L.charCodeAt(0) + 1);
    return { sql: '(name_cap >= ? AND name_cap < ?)', params: [L, next] };
  }

  /**
   * 歌手首字母分布（A-Z + #），给字母索引用。
   * 支持和列表一样的地区/类型筛选 —— 否则筛完之后字母条上的计数是假的，
   * 会出现"这个字母明明有 1000 位，点进去却是空的"。
   */
  singerLetters(opts = {}) {
    const params = [];
    const conds = ["deleted_at IS NULL", "name != ''", "name != '#0000FF'", "name_cap <> ''"];
    if (opts.area) { conds.push('area = ?'); params.push(opts.area); }
    if (opts.type) { conds.push('type = ?'); params.push(opts.type); }
    const rows = this._stmt(`SELECT upper(substr(name_cap, 1, 1)) AS letter, COUNT(*) AS n
      FROM singers
      WHERE ${conds.join(' AND ')}
      GROUP BY letter`).all(...params);
    const buckets = new Map();
    let other = 0;
    for (const r of rows) {
      const c = String(r.letter || '');
      if (c >= 'A' && c <= 'Z') buckets.set(c, (buckets.get(c) || 0) + Number(r.n));
      else other += Number(r.n);
    }
    const out = [];
    for (let i = 0; i < 26; i++) {
      const c = String.fromCharCode(65 + i);
      out.push({ letter: c, count: buckets.get(c) || 0 });
    }
    if (other) out.push({ letter: '#', count: other });
    return out;
  }

  singers(opts = {}) {
    const { limit, offset } = clampPage(opts.limit, opts.offset);
    const keyword = String(opts.keyword || '').trim();
    const params = [];
    const conds = ["deleted_at IS NULL", "name != ''", "name != '#0000FF'"];
    if (keyword) {
      conds.push('(name LIKE ? OR name_cap LIKE ? OR name_trim LIKE ?)');
      params.push(`%${keyword}%`, `${keyword.toUpperCase()}%`, `%${keyword}%`);
    }
    const letterCond = opts.letter ? this._letterCond(opts.letter) : null;
    if (letterCond) {
      conds.push(letterCond.sql);
      params.push(...letterCond.params);
    }
    if (opts.area) { conds.push('area = ?'); params.push(opts.area); }
    if (opts.type) { conds.push('type = ?'); params.push(opts.type); }
    const sql = `SELECT id, name, name_cap, type, area, hot_score, image FROM singers
      WHERE ${conds.join(' AND ')} ORDER BY hot_score DESC LIMIT ? OFFSET ?`;
    return this._stmt(sql).all(...params, limit, offset).map((r) => ({
      id: r.id, name: r.name || '', nameCap: r.name_cap || '',
      type: r.type || '', area: r.area || '',
      hotScore: Number(r.hot_score || 0),
      image: r.image || '',
      imageUrl: this.singerImageUrl(r.image),
    }));
  }

  songsBySinger(singerId, opts = {}) {
    const { limit, offset } = clampPage(opts.limit, opts.offset);
    const sql = `SELECT ${SONG_COLUMNS} FROM songs s
      INNER JOIN song_singer_relations ssr ON ssr.song_id = s.id
      WHERE s.deleted_at IS NULL AND ssr.singer_id = ?
      ${RECOMMEND_ORDER} LIMIT ? OFFSET ?`;
    return this._stmt(sql).all(String(singerId), limit, offset).map(toSong);
  }

  /**
   * 图片 CDN 根地址。
   * 曲库里的 singers.image 只是个文件名（ip1_singer_image_1030），
   * 真实地址要拼 CDN 前缀 —— 参考 maidong 的 MuseDatabase.resolveSingerImageUrl()：
   * 前缀优先取 global_confs.cdn_path，没有就用默认值。
   */
  cdnPath() {
    if (this._cdnPath != null) return this._cdnPath;
    let base = 'https://pub.mcdn.cherryonline.cn/';
    try {
      const r = this._stmt("SELECT cdn_path FROM global_confs WHERE cdn_path IS NOT NULL AND TRIM(cdn_path) != '' LIMIT 1").get();
      if (r && r.cdn_path) base = String(r.cdn_path);
    } catch { /* 表不存在就用默认 */ }
    // ⚠️ 不能用 trimEnd('/')：V8 的 trimEnd 不接收参数，'/' 会被忽略（空操作），
    // 结果拼出 'https://cdn//ip1_...' 这种双斜杠地址。
    this._cdnPath = String(base).replace(/\/+$/, '') + '/';
    return this._cdnPath;
  }

  /**
   * 歌手头像完整 URL；没有 image 返回空串。
   *
   * 曲库里存的是**文件名**（ip1_singer_image_1030），要拼 CDN 前缀；
   * 拼出来的自家 CDN 地址再加七牛的处理参数（缩到 100x100 webp，省流量）。
   *
   * ⚠️ 已经是完整 URL 的原样返回 —— 那些不是自家 CDN，加七牛参数会直接 404。
   * （maidong 是无条件加的，因为它的 image 只可能是自家文件名。）
   */
  singerImageUrl(image) {
    const v = String(image || '').trim();
    if (!v) return '';
    if (v.startsWith('/')) return v;                 // 本地绝对路径
    if (/^https?:\/\//.test(v)) return v;            // 已经是完整 URL
    return this.cdnPath() + encodeURI(v) + '?imageView2/1/w/100/h/100/q/95!/format/webp';
  }

  singerAreas() {
    return this._stmt("SELECT DISTINCT area FROM singers WHERE deleted_at IS NULL AND area != '' ORDER BY area")
      .all().map((r) => r.area);
  }

  singerTypes() {
    return this._stmt("SELECT DISTINCT type FROM singers WHERE deleted_at IS NULL AND type != '' ORDER BY type")
      .all().map((r) => r.type);
  }
}

module.exports = { MuseCatalog, toSong };
