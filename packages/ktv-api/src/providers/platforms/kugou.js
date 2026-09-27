'use strict';

const {
  cleanKeyword, unescapeHtml, httpsUrl, normalizeSong, okSongs, fail, authError,
  noPlayable, notSupported, errorReason, fetchJson,
} = require('./common');

const SEARCH_API = 'http://mobilecdn.kugou.com/api/v3/search/song';
const HOT_API = 'http://mobilecdn.kugou.com/api/v3/rank/song';
const AUDIO_API = 'https://trackercdnbj.kugou.com/i/v2/';
const AUDIO_FALLBACK = 'https://wwwapi.kugou.com/yy/index.php';
const MV_API = 'http://m.kugou.com/app/i/mv.php';
const REFERER = 'https://www.kugou.com';

function cookieHeaders(ctx = {}) {
  return ctx.cookie ? { Cookie: ctx.cookie } : {};
}

function parseSong(song = {}) {
  const title = unescapeHtml(song.songname || song.songName || song.name || '');
  const id = song.hash || song.Hash || song.filehash || '';
  if (!title || !id) return null;
  let cover = song.image || song.album_img || song.pic || '';
  if (cover) cover = cover.replace('{size}', '300');
  const mvId = song.mvhash && song.mvhash !== '0' ? song.mvhash : null;
  return normalizeSong({
    platform: 'kugou',
    id,
    title,
    artist: unescapeHtml(song.singername || song.singer || '未知'),
    duration: song.duration || 0,
    hasMv: !!mvId,
    mvId,
    album: unescapeHtml(song.album_name || song.albumname || ''),
    cover: httpsUrl(cover),
  });
}

async function search(keyword, opts = {}, ctx = {}) {
  const kw = cleanKeyword(keyword);
  if (!kw) return fail('请输入搜索词', 'PLATFORM_UNAVAILABLE');
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 20));
  try {
    const u = new URL(SEARCH_API);
    u.searchParams.set('keyword', kw);
    u.searchParams.set('page', String(page));
    u.searchParams.set('pagesize', String(pageSize));
    const json = await fetchJson(u, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const list = json?.data?.info || [];
    const songs = list.map(parseSong).filter(Boolean);
    return okSongs(opts.onlyMv ? songs.filter((s) => s.hasMv) : songs, list.length >= pageSize);
  } catch (e) {
    return fail('酷狗搜索失败: ' + e.message, errorReason(e.message));
  }
}

async function hot(opts = {}, ctx = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 20));
  try {
    const u = new URL(HOT_API);
    u.searchParams.set('rankid', '8888');
    u.searchParams.set('page', String(page));
    u.searchParams.set('pagesize', String(pageSize));
    const json = await fetchJson(u, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const list = json?.data?.info || [];
    const songs = list.map(parseSong).filter(Boolean);
    return okSongs(opts.onlyMv ? songs.filter((s) => s.hasMv) : songs, list.length >= pageSize);
  } catch (e) {
    return fail('酷狗热门榜失败: ' + e.message, errorReason(e.message));
  }
}

async function resolveAudio(id, opts = {}, ctx = {}) {
  if (!id) return noPlayable('缺少酷狗歌曲 hash');
  try {
    const u = new URL(AUDIO_API);
    u.searchParams.set('cmd', '25');
    u.searchParams.set('hash', String(id));
    u.searchParams.set('pid', '1');
    u.searchParams.set('behavior', 'play');
    const json = await fetchJson(u, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const url = json?.url?.[0];
    if (url) return { ok: true, url };
    const msg = json?.error || '酷狗没有返回播放地址';
    if (/empty key|login|登录|auth/i.test(msg) || !ctx.cookie) return authError('酷狗需要登录后才能播放');
  } catch (e) {
    if (/empty key|login|登录|auth/i.test(e.message) || !ctx.cookie) return authError('酷狗需要登录后才能播放');
  }
  try {
    const u = new URL(AUDIO_FALLBACK);
    u.searchParams.set('r', 'play/getdata');
    u.searchParams.set('hash', String(id));
    u.searchParams.set('mid', '68a3d1b0f68e4dffafb4e23f3a1b8b76');
    u.searchParams.set('platid', '4');
    u.searchParams.set('album_id', '');
    const json = await fetchJson(u, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const url = json?.data?.play_url;
    if (url) return { ok: true, url };
    return noPlayable(json?.data?.play_url || '酷狗没有返回可播放地址');
  } catch (e) {
    return fail('取酷狗地址失败: ' + e.message, errorReason(e.message));
  }
}

async function resolveMv(mvId, opts = {}, ctx = {}) {
  if (!mvId) return notSupported('该酷狗条目没有 MV');
  try {
    const u = new URL(MV_API);
    u.searchParams.set('cmd', '100');
    u.searchParams.set('hash', String(mvId));
    u.searchParams.set('ismp3', '1');
    const json = await fetchJson(u, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const url = json?.mvdata;
    if (!url) return ctx.cookie ? noPlayable('酷狗没有返回可播放 MV') : authError('酷狗 MV 需要登录后才能播放');
    return { ok: true, url: httpsUrl(url), quality: '720' };
  } catch (e) {
    return fail('取酷狗 MV 地址失败: ' + e.message, errorReason(e.message));
  }
}

module.exports = { id: 'kugou', label: '酷狗', needsAuth: true, mv: true, search, hot, resolveAudio, resolveMv, parseSong };
