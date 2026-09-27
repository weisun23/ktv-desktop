'use strict';

const {
  cleanKeyword, normalizeSong, okSongs, fail, authError, noPlayable, notSupported,
  errorReason, postJson,
} = require('./common');

const API_HOST = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const REFERER = 'https://y.qq.com';
const COVER = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000%s.jpg';

function cookieHeaders(ctx = {}) {
  return ctx.cookie ? { Cookie: ctx.cookie } : {};
}

function parseSong(song = {}) {
  const title = song.title || song.name || song.songname || '';
  const id = song.mid || song.songmid || song.songMid || '';
  if (!title || !id) return null;
  const singers = Array.isArray(song.singer) ? song.singer : [];
  const album = song.album || {};
  const mv = song.mv || {};
  const mvId = mv.vid || mv.id || null;
  return normalizeSong({
    platform: 'qq',
    id,
    title,
    artist: singers.map((x) => x.name || x.title).filter(Boolean).join('/') || song.singername || '未知',
    duration: song.interval || song.duration || 0,
    hasMv: !!mvId,
    mvId,
    album: album.name || album.title || '',
    cover: album.mid ? COVER.replace('%s', album.mid) : '',
  });
}

async function search(keyword, opts = {}, ctx = {}) {
  const kw = cleanKeyword(keyword);
  if (!kw) return fail('请输入搜索词', 'PLATFORM_UNAVAILABLE');
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 20));
  try {
    const body = {
      'music.search.SearchCgiService': {
        method: 'DoSearchForQQMusicDesktop',
        module: 'music.search.SearchCgiService',
        param: { query: kw, page_num: page, num_per_page: pageSize },
      },
    };
    const json = await postJson(API_HOST, body, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const list = json?.['music.search.SearchCgiService']?.data?.body?.song?.list || [];
    const songs = list.map(parseSong).filter(Boolean);
    if (opts.onlyMv) return okSongs(songs.filter((s) => s.hasMv), list.length >= pageSize);
    return okSongs(songs, list.length >= pageSize);
  } catch (e) {
    return fail('QQ音乐搜索失败: ' + e.message, errorReason(e.message));
  }
}

async function hot(opts = {}, ctx = {}) {
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(opts.pageSize) || 20));
  try {
    const body = { detail: { module: 'musicToplist.ToplistInfoServer', method: 'GetDetail', param: { topId: 26, offset: (page - 1) * pageSize, num: pageSize } } };
    const json = await postJson(API_HOST, body, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const list = json?.detail?.data?.songInfoList || [];
    const songs = list.map(parseSong).filter(Boolean);
    return okSongs(opts.onlyMv ? songs.filter((s) => s.hasMv) : songs, list.length >= pageSize);
  } catch (e) {
    return fail('QQ音乐热门榜失败: ' + e.message, errorReason(e.message));
  }
}

async function resolveAudio(id, opts = {}, ctx = {}) {
  if (!id) return noPlayable('缺少 QQ音乐歌曲 id');
  try {
    const body = {
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid: String(Date.now()).slice(-10),
          songmid: [String(id)],
          songtype: [0],
          uin: '0',
          loginflag: 1,
          platform: '20',
        },
      },
    };
    const json = await postJson(API_HOST, body, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const data = json?.req_0?.data || {};
    const purl = data.midurlinfo?.[0]?.purl || '';
    if (!purl) {
      const msg = data.midurlinfo?.[0]?.tips || data.msg || data.login_key || 'QQ音乐没有返回播放地址';
      return /invalidq|login|登录|auth/i.test(msg) || !ctx.cookie ? authError('QQ音乐需要登录后才能播放') : noPlayable(msg);
    }
    const host = data.sip?.[0] || 'https://dl.stream.qqmusic.qq.com/';
    return { ok: true, url: host + purl };
  } catch (e) {
    return fail('取 QQ音乐地址失败: ' + e.message, errorReason(e.message));
  }
}

async function resolveMv(mvId, opts = {}, ctx = {}) {
  if (!mvId) return notSupported('该 QQ音乐条目没有 MV');
  try {
    const body = { getMvUrl: { module: 'music.stream.MvUrlProxy', method: 'GetMvUrls', param: { vids: [String(mvId)], request_type: 10003 } } };
    const json = await postJson(API_HOST, body, { headers: { Referer: REFERER, ...cookieHeaders(ctx) }, fetch: opts.fetch });
    const data = json?.getMvUrl?.data?.[mvId] || {};
    let url = data.mp4_url || '';
    if (!url && Array.isArray(data.mp4)) {
      for (let i = data.mp4.length - 1; i >= 0 && !url; i--) url = data.mp4[i]?.freeflow_url?.[0] || '';
    }
    if (!url) return ctx.cookie ? noPlayable('QQ音乐没有返回可播放 MV') : authError('QQ音乐 MV 需要登录后才能播放');
    return { ok: true, url: url.startsWith('http') ? url : 'https://' + url, quality: '720' };
  } catch (e) {
    return fail('取 QQ音乐 MV 地址失败: ' + e.message, errorReason(e.message));
  }
}

module.exports = { id: 'qq', label: 'QQ音乐', needsAuth: true, mv: true, search, hot, resolveAudio, resolveMv, parseSong };
