'use strict';

const TIMEOUT_MS = 12000;

function cleanKeyword(kw) {
  return String(kw || '')
    .replace(/\((HD|MV|DJ版|Live|伴奏|原版|国语|粤语|日语|英语)[^)]*\)/gi, '')
    .replace(/（[^）]*(HD|MV|DJ版|Live|伴奏|原版)[^）]*）/gi, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
}

function httpsUrl(u) {
  const s = String(u || '').trim();
  if (s.startsWith('//')) return 'https:' + s;
  return s.startsWith('http://') ? 'https://' + s.slice(7) : s;
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

function normalizeSong(item = {}) {
  return {
    platform: String(item.platform || ''),
    id: String(item.id || ''),
    title: String(item.title || item.name || '').trim(),
    artist: String(item.artist || item.singer || '').trim(),
    duration: Math.max(0, Number(item.duration) || 0),
    hasMv: !!item.hasMv,
    mvId: item.mvId ? String(item.mvId) : null,
    album: String(item.album || '').trim(),
    cover: httpsUrl(item.cover || ''),
  };
}

function okSongs(songs, hasMore = false) {
  return { ok: true, songs, hasMore: !!hasMore };
}

function fail(error, reason = 'PLATFORM_UNAVAILABLE') {
  return { ok: false, error: String(error || '平台请求失败'), reason };
}

function authError(message = '需要登录该平台后才能播放') {
  return { ok: false, error: message, reason: 'AUTH_REQUIRED' };
}

function noPlayable(message = '该曲目暂无可播放资源') {
  return { ok: false, error: message, reason: 'NO_PLAYABLE_RESOURCE' };
}

function notSupported(message = '该平台不支持此功能') {
  return { ok: false, error: message, reason: 'NOT_SUPPORTED' };
}

function errorReason(message) {
  const s = String(message || '');
  if (/login|登录|auth|invalidq|empty key|201007|20010|未登录|需要登录/i.test(s)) return 'AUTH_REQUIRED';
  if (/timeout|fetch failed|ENOTFOUND|EAI_AGAIN|network|HTTP 5/i.test(s)) return 'PLATFORM_UNAVAILABLE';
  return 'NO_PLAYABLE_RESOURCE';
}

async function fetchText(url, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持 fetch');
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...(opts.headers || {}) };
  const res = await fetchImpl(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    signal: AbortSignal.timeout(Number(opts.timeoutMs) || TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 160));
  return text;
}

async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    if (start >= 0) return JSON.parse(text.slice(start));
    throw new Error('接口返回的不是 JSON');
  }
}

async function postJson(url, body, opts = {}) {
  return fetchJson(url, {
    ...opts,
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}

module.exports = {
  TIMEOUT_MS,
  cleanKeyword,
  httpsUrl,
  unescapeHtml,
  normalizeSong,
  okSongs,
  fail,
  authError,
  noPlayable,
  notSupported,
  errorReason,
  fetchText,
  fetchJson,
  postJson,
};
