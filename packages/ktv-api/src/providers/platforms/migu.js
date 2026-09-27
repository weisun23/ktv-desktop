'use strict';

const {
  cleanKeyword, httpsUrl, normalizeSong, okSongs, fail, authError, noPlayable,
  notSupported, errorReason, fetchJson,
} = require('./common');

const SEARCH_API = 'https://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do';
const HOT_API = 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/querycontentbyId.do';
const AUDIO_API = 'https://app.c.nf.migu.cn/MIGUM2.0/strategy/listen-url/v2.4';
const MV_API = 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do';
const REFERER = 'https://music.migu.cn';

function cookieHeaders(ctx = {}) {
  return ctx.cookie ? { Cookie: ctx.cookie } : {};
}

function parseSong(song = {}) {
  const title = song.name || song.songName || '';
  const id = song.copyrightId || song.id || song.songId || '';
  if (!title || !id) return null;
  const singers = Array.isArray(song.singers) ? song.singers : [];
  const mvList = Array.isArray(song.mvList) ? song.mvList : [];
  const mvId = mvList[0]?.copyrightId || mvList[0]?.id || null;
  const img = Array.isArray(song.imgItems) ? song.imgItems[0]?.img : '';
  return normalizeSong({
    platform: 'migu',
    id,
    title,
    artist: singers.map((x) => x.name).filter(Boolean).join('/') || song.singer || '未知',
    duration: song.duration || 0,
    hasMv: !!mvId,
    mvId,
    album: song.albumName || '',
    cover: httpsUrl(img),
  });
}

async function search(keyword, opts = {}, ctx = {}) {
  const kw = cleanKeyword(keyword);
  if (!kw) return fail('请输入搜索词', 'PLATFORM_UNAVAILABLE');
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 20));
  try {
    const u = new URL(SEARCH_API);
    const params = { ua: 'Android_migu', version: '5.0.1', text: kw, pageNo: page, pageSize, searchSwitch: '{"song":1}' };
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
    const json = await fetchJson(u, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const list = json?.songResultData?.result || [];
    const songs = list.map(parseSong).filter(Boolean);
    return okSongs(opts.onlyMv ? songs.filter((s) => s.hasMv) : songs, list.length >= pageSize);
  } catch (e) {
    return fail('咪咕搜索失败: ' + e.message, errorReason(e.message));
  }
}

async function hot(opts = {}, ctx = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 20));
  try {
    const u = new URL(HOT_API);
    u.searchParams.set('columnId', '27553319');
    const json = await fetchJson(u, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const list = (json?.columnInfo?.contents || []).map((x) => x?.objectInfo).filter(Boolean);
    const start = (page - 1) * pageSize;
    const slice = list.slice(start, start + pageSize);
    return okSongs(slice.map(parseSong).filter(Boolean), start + pageSize < list.length);
  } catch (e) {
    return fail('咪咕热门榜失败: ' + e.message, errorReason(e.message));
  }
}

async function resolveAudio(id, opts = {}, ctx = {}) {
  if (!id) return noPlayable('缺少咪咕歌曲 id');
  try {
    const u = new URL(AUDIO_API);
    const params = { netType: '01', resourceType: 'E', songId: String(id), toneFlag: 'HQ' };
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
    const json = await fetchJson(u, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    if (json?.code && String(json.code) !== '000000') {
      if (String(json.code) === '201007' || /登录|auth|login/i.test(json.info || '')) return authError('咪咕需要登录后才能播放');
      return fail(json.info || ('咪咕返回 code ' + json.code), errorReason(json.info));
    }
    const url = json?.data?.url;
    if (!url) return ctx.cookie ? noPlayable('咪咕没有返回可播放地址') : authError('咪咕需要登录后才能播放');
    return { ok: true, url: httpsUrl(url) };
  } catch (e) {
    return fail('取咪咕地址失败: ' + e.message, errorReason(e.message));
  }
}

async function resolveMv(mvId, opts = {}, ctx = {}) {
  if (!mvId) return notSupported('该咪咕条目没有 MV');
  try {
    const u = new URL(MV_API);
    u.searchParams.set('resourceType', 'MV');
    u.searchParams.set('resourceId', String(mvId));
    const json = await fetchJson(u, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const resource = json?.resource?.[0] || json?.data?.resource?.[0] || {};
    const list = resource.newMvList || resource.mvList || [];
    let url = '';
    for (let i = list.length - 1; i >= 0 && !url; i--) url = list[i]?.url || '';
    if (!url) return ctx.cookie ? noPlayable('咪咕没有返回可播放 MV') : authError('咪咕 MV 需要登录后才能播放');
    return { ok: true, url: httpsUrl(url), quality: '720' };
  } catch (e) {
    return fail('取咪咕 MV 地址失败: ' + e.message, errorReason(e.message));
  }
}

module.exports = { id: 'migu', label: '咪咕', needsAuth: true, mv: true, search, hot, resolveAudio, resolveMv, parseSong };
