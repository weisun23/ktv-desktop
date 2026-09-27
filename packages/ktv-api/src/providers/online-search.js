/**
 * 在线搜歌 / 搜 MV
 * =================
 * 本地曲库（muse.db）只有 KTV 片源；曲库里搜不到的歌，走这里在线找。
 *
 * 主源：**网易云公开接口**（无需登录、无需凭证）
 *   搜歌     GET /api/cloudsearch/pc?s=<kw>&type=1&limit=N&offset=M
 *            —— 用 cloudsearch 而不是老的 search/get/web：**它直接返回完整封面 URL**
 *               （al.picUrl），老接口只给一个需要自己算加密串的 picId。
 *   搜 MV    GET /api/cloudsearch/pc?s=<kw>&type=1004
 *            —— 返回真正的 MV 条目（mvs），带 cover 封面、时长、歌手，
 *               而且 id 就是 mvId，可以直接拿去取播放地址。
 *   MV 直链  GET /api/mv/detail?id=<mvId>
 *            —— data.brs 是「按清晰度分的可直接播放的 mp4 直链」
 *               （实测 240/480/720/1080 四档，video/mp4，支持 Range）
 *
 * 备源：**酷我**（同样免登录）
 *   搜歌     http://search.kuwo.cn/r.s
 *   音频直链 http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=MUSIC_<id>&format=mp3&response=url
 *            —— 酷我的 MV 接口需要浏览器生成的 token，取不到，所以只用它补音频。
 *
 * 注意：这类公开接口随时可能变；失败时给可读错误，不要静默返回空。
 */
'use strict';

const NETEASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://music.163.com',
};
const KUWO_UA = 'okhttp/3.10.0';
const TIMEOUT_MS = 12000;

/** 清掉歌名里的修饰，提高搜索命中率。 */
function cleanKeyword(kw) {
  return String(kw || '')
    .replace(/\((HD|MV|DJ版|Live|伴奏|原版|国语|粤语|日语|英语)[^)]*\)/gi, '')
    .replace(/（[^）]*(HD|MV|DJ版|Live|伴奏|原版)[^）]*）/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
}

function unescapeHtml(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, '')
    .trim();
}

function neteaseHeaders(ctx = {}) {
  return ctx?.cookie ? { ...NETEASE_HEADERS, Cookie: ctx.cookie } : NETEASE_HEADERS;
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 网易云搜歌。
 * @param {string} keyword
 * @param {{page?:number, pageSize?:number, onlyMv?:boolean}} [opts]
 */
/** 封面 URL 统一升到 https（接口给的是 http，混合内容容易被拦） */
function httpsUrl(u) {
  const s = String(u || '').trim();
  return s.startsWith('http://') ? 'https://' + s.slice(7) : s;
}

/**
 * 搜歌（网易云）。
 *
 * 用 cloudsearch 而不是老的 search/get/web：**它直接返回完整封面 URL**（al.picUrl）。
 * 老接口只给 picId，要自己算那个加密路径段才能拼出图片地址。
 */
async function searchNetease(keyword, opts = {}, ctx = {}) {
  const kw = cleanKeyword(keyword);
  if (!kw) return { ok: false, error: '请输入搜索词' };
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 20));
  try {
    const url = 'https://music.163.com/api/cloudsearch/pc?s=' + encodeURIComponent(kw)
      + `&type=1&limit=${pageSize}&offset=${(page - 1) * pageSize}`;
    const json = await getJson(url, neteaseHeaders(ctx));
    const raw = json?.result?.songs || [];
    const songs = raw.map((s) => ({
      platform: 'netease',
      id: String(s.id),
      title: s.name || '',
      artist: (s.ar || []).map((a) => a.name).join('/'),
      duration: Math.round((s.dt || 0) / 1000),
      hasMv: Number(s.mv) > 0,
      mvId: Number(s.mv) > 0 ? String(s.mv) : null,
      album: s.al?.name || '',
      cover: httpsUrl(s.al?.picUrl),
    }));
    return { ok: true, songs, hasMore: raw.length >= pageSize };
  } catch (e) {
    return { ok: false, error: `网易云搜索失败: ${e.message}` };
  }
}

/**
 * 搜 MV（网易云）。
 *
 * 用 cloudsearch 的 type=1004：返回的是**真正的 MV 条目**，
 * 带封面（cover）、时长、歌手，而且 id 就是 mvId。
 *
 * 早先的做法是"搜歌再筛 mvid>0"，那样拿到的是歌曲条目、没有 MV 封面，
 * 而且 MV 数量比真实 MV 少（很多 MV 没有对应的单曲条目）。
 */
async function searchNeteaseMv(keyword, opts = {}, ctx = {}) {
  const kw = cleanKeyword(keyword);
  if (!kw) return { ok: false, error: '请输入搜索词' };
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 20));
  try {
    const url = 'https://music.163.com/api/cloudsearch/pc?s=' + encodeURIComponent(kw)
      + `&type=1004&limit=${pageSize}&offset=${(page - 1) * pageSize}`;
    const json = await getJson(url, neteaseHeaders(ctx));
    const raw = json?.result?.mvs || [];
    const songs = raw.map((m) => ({
      platform: 'netease',
      id: String(m.id),
      mvId: String(m.id),
      title: m.name || '',
      artist: m.artistName || (m.artists || []).map((a) => a.name).join('/'),
      duration: Math.round((m.duration || 0) / 1000),
      hasMv: true,
      album: '',
      cover: httpsUrl(m.cover),
    }));
    return { ok: true, songs, hasMore: raw.length >= pageSize };
  } catch (e) {
    return { ok: false, error: `网易云搜 MV 失败: ${e.message}` };
  }
}

/**
 * 取 MV 直链（网易云）。返回各清晰度，挑一个默认。
 * @param {string|number} mvId
 * @param {{quality?:string}} [opts] 240/480/720/1080，默认取可用的最高
 */
async function resolveMvUrl(mvId, opts = {}, ctx = {}) {
  if (!mvId) return { ok: false, error: '缺少 MV id' };
  try {
    const json = await getJson(`https://music.163.com/api/mv/detail?id=${encodeURIComponent(mvId)}`, neteaseHeaders(ctx));
    if (json.code !== 200 || !json.data) return { ok: false, error: json.message || 'MV 不存在' };
    const brs = json.data.brs || {};
    const qualities = Object.keys(brs).filter((k) => brs[k]);
    if (!qualities.length) return { ok: false, error: '这个 MV 没有可用清晰度' };
    const want = opts.quality && brs[opts.quality] ? opts.quality
      : qualities.sort((a, b) => Number(b) - Number(a))[0];
    return {
      ok: true,
      url: brs[want],
      quality: want,
      available: qualities.sort((a, b) => Number(b) - Number(a)),
      name: json.data.name || '',
      duration: Math.round((json.data.duration || 0) / 1000),
    };
  } catch (e) {
    return { ok: false, error: `取 MV 地址失败: ${e.message}` };
  }
}

/**
 * 酷我搜歌（备源）。只用于补歌，不提供 MV。
 */
async function searchKuwo(keyword, opts = {}) {
  const kw = cleanKeyword(keyword);
  if (!kw) return { ok: false, error: '请输入搜索词' };
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 20));
  const qs = new URLSearchParams({
    all: kw, ft: 'music', itemset: 'web_2013', client: 'kt',
    pn: String(page - 1), rn: String(pageSize),
    rformat: 'json', encoding: 'utf8', show_copyright_off: '1', pcmp4: '1', mobi: '1',
  });
  try {
    const res = await fetch(`http://search.kuwo.cn/r.s?${qs}`, {
      headers: { 'User-Agent': KUWO_UA, 'Accept': '*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `酷我搜索 HTTP ${res.status}` };
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = JSON.parse(text.slice(text.indexOf('{'))); }
    const list = Array.isArray(json.abslist) ? json.abslist : [];
    const songs = list.map((it) => {
      let rid = String(it.MUSICRID || '');
      if (rid.startsWith('MUSIC_')) rid = rid.slice(6);
      const hasMv = String(it.MVFLAG || '') === '1';
      let cover = it.web_albumpic_short || it.albumpic || '';
      if (cover && !/^https?:/i.test(cover)) cover = 'https://img1.kuwo.cn/star/albumcover/' + cover;
      return {
        platform: 'kuwo', id: rid,
        title: unescapeHtml(it.SONGNAME), artist: unescapeHtml(it.ARTIST || '未知'),
        duration: Number(it.DURATION) || 0, hasMv, mvId: hasMv ? rid : null,
        album: unescapeHtml(it.ALBUM || it.album || ''), cover: httpsUrl(cover),
      };
    }).filter((s) => s.id);
    return { ok: true, songs: opts.onlyMv ? songs.filter((s) => s.hasMv) : songs, hasMore: list.length >= pageSize };
  } catch (e) {
    return { ok: false, error: `酷我搜索失败: ${e.message}` };
  }
}

/**
 * 取酷我的可播放音频直链（备源用）。
 */
async function resolveKuwoAudioUrl(rid) {
  if (!rid) return { ok: false, error: '缺少曲目 id' };
  try {
    const id = String(rid).startsWith('MUSIC_') ? String(rid) : `MUSIC_${rid}`;
    const url = `http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=${id}&format=mp3&response=url`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://kuwo.cn' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = (await res.text()).trim();
    if (!/^https?:\/\//i.test(text)) return { ok: false, error: '酷我没有返回可播放地址' };
    return { ok: true, url: text };
  } catch (e) {
    return { ok: false, error: `取酷我地址失败: ${e.message}` };
  }
}

/**
 * 网易云热歌榜。
 */
async function hotNetease(opts = {}, ctx = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 20));
  try {
    const json = await getJson('https://music.163.com/api/playlist/detail?id=3778678', neteaseHeaders(ctx));
    const raw = json?.result?.tracks || [];
    const start = (page - 1) * pageSize;
    const slice = raw.slice(start, start + pageSize);
    const songs = slice.map((s) => ({
      platform: 'netease',
      id: String(s.id),
      title: s.name || '',
      artist: (s.ar || s.artists || []).map((a) => a.name).join('/'),
      duration: Math.round((s.dt || s.duration || 0) / 1000),
      hasMv: Number(s.mv) > 0,
      mvId: Number(s.mv) > 0 ? String(s.mv) : null,
      album: s.al?.name || s.album?.name || '',
      cover: httpsUrl(s.al?.picUrl || s.album?.picUrl),
    }));
    return { ok: true, songs: opts.onlyMv ? songs.filter((s) => s.hasMv) : songs, hasMore: start + pageSize < raw.length };
  } catch (e) {
    return { ok: false, error: '网易云热门榜失败: ' + e.message };
  }
}

/**
 * 酷我热歌榜。
 */
async function hotKuwo(opts = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 20));
  const qs = new URLSearchParams({
    from: 'pc', fmt: 'json', pn: String(page - 1), rn: String(pageSize),
    type: 'bang', data: 'content', id: '93',
  });
  try {
    const res = await fetch('http://kbangserver.kuwo.cn/ksong.s?' + qs, {
      headers: { 'User-Agent': KUWO_UA, Accept: '*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: '酷我热门榜 HTTP ' + res.status };
    const json = JSON.parse(await res.text());
    const list = Array.isArray(json.musiclist) ? json.musiclist : [];
    const songs = list.map((it) => {
      let id = String(it.id || it.MUSICRID || '');
      if (id.startsWith('MUSIC_')) id = id.slice(6);
      const mvId = it.mvpayinfo?.vid && String(it.mvpayinfo.vid) !== '0' ? String(it.mvpayinfo.vid) : null;
      let cover = it.web_albumpic_short || it.albumpic || '';
      if (cover && !/^https?:/i.test(cover)) cover = 'https://img1.kuwo.cn/star/albumcover/' + cover;
      return {
        platform: 'kuwo', id,
        title: unescapeHtml(it.name || it.SONGNAME),
        artist: unescapeHtml(it.artist || it.ARTIST || '未知'),
        duration: Number(it.song_duration || it.DURATION || 0),
        hasMv: !!mvId, mvId, album: unescapeHtml(it.album || ''),
        cover: httpsUrl(cover),
      };
    }).filter((s) => s.id && s.title);
    return { ok: true, songs: opts.onlyMv ? songs.filter((s) => s.hasMv) : songs, hasMore: list.length >= pageSize };
  } catch (e) {
    return { ok: false, error: '酷我热门榜失败: ' + e.message };
  }
}

module.exports = {
  searchNetease, searchNeteaseMv, searchKuwo, hotNetease, hotKuwo,
  resolveMvUrl, resolveKuwoAudioUrl, cleanKeyword, unescapeHtml,
};