'use strict';

const onlineSearch = require('./online-search');
const qq = require('./platforms/qq');
const kugou = require('./platforms/kugou');
const migu = require('./platforms/migu');
const { authError, notSupported } = require('./platforms/common');

function wrapNetease() {
  return {
    id: 'netease', label: '网易云', needsAuth: false, auth: true, mv: true,
    search: (keyword, opts, ctx) => (opts?.onlyMv ? onlineSearch.searchNeteaseMv(keyword, opts, ctx) : onlineSearch.searchNetease(keyword, opts, ctx)),
    hot: (opts, ctx) => onlineSearch.hotNetease(opts, ctx),
    resolveAudio: () => notSupported('网易云当前只提供 MV 播放'),
    resolveMv: (mvId, opts, ctx) => onlineSearch.resolveMvUrl(mvId, opts, ctx),
  };
}

function wrapKuwo() {
  return {
    id: 'kuwo', label: '酷我', needsAuth: false, mv: false,
    search: (keyword, opts) => onlineSearch.searchKuwo(keyword, opts),
    hot: (opts) => onlineSearch.hotKuwo(opts),
    resolveAudio: (id) => onlineSearch.resolveKuwoAudioUrl(id),
    resolveMv: () => notSupported('酷我当前只提供音频播放'),
  };
}

const adapters = {
  netease: wrapNetease(),
  kuwo: wrapKuwo(),
  qq,
  kugou,
  migu,
};

function listPlatforms() {
  return Object.values(adapters).map((p) => ({ id: p.id, label: p.label, needsAuth: !!p.needsAuth, auth: !!p.auth, mv: !!p.mv }));
}

function getPlatform(id) {
  return adapters[String(id || '')] || null;
}

async function searchPlatform(id, keyword, opts = {}, ctx = {}) {
  const p = getPlatform(id);
  if (!p) return { ok: false, error: '未知在线平台: ' + id, reason: 'PLATFORM_UNAVAILABLE' };
  return p.search(keyword, opts, ctx);
}

async function hotPlatform(id, opts = {}, ctx = {}) {
  const p = getPlatform(id);
  if (!p) return { ok: false, error: '未知在线平台: ' + id, reason: 'PLATFORM_UNAVAILABLE' };
  return p.hot(opts, ctx);
}

async function resolveAudio(id, platformId, opts = {}, ctx = {}) {
  const p = getPlatform(platformId);
  if (!p) return authError('未知在线平台');
  return p.resolveAudio(id, opts, ctx);
}

async function resolveMv(id, platformId, opts = {}, ctx = {}) {
  const p = getPlatform(platformId);
  if (!p) return notSupported('未知在线平台');
  return p.resolveMv(id, opts, ctx);
}

module.exports = { listPlatforms, getPlatform, searchPlatform, hotPlatform, resolveAudio, resolveMv };
