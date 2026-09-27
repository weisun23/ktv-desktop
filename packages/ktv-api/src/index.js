/**
 * @ktv/ktv-api —— 取流 provider
 * ============================
 * 把"曲目 -> 可播放地址"这件事抽象出来，播放器不关心地址从哪来。
 *
 * 已实现：
 *   maidong  参考 maidong 的接口流程自行实现（凭证由本地配置提供，不内置）
 *
 * 规划中：
 *   local    本地文件（当前由 shell 直接处理）
 *   online   接 karaoke-companion 的在线音乐聚合（网易/QQ/酷狗等，MIT）
 */
'use strict';

const { MaidongProvider } = require('./providers/maidong');
const onlinePlatforms = require('./providers/platform-registry');
const { loadConfig, saveConfig, ensureTemplate, CONFIG_FILE } = require('./config');

/** 按配置构造 provider 实例。 */
function createProvider(name, config) {
  if (name === 'maidong') return new MaidongProvider(config.maidong || {});
  throw new Error(`未知的取流 provider: ${name}`);
}

/** 列出当前可用的 provider（已配置且启用）。 */
function availableProviders(config) {
  const cfg = config || loadConfig();
  const out = [];
  if (cfg.maidong && cfg.maidong.enabled) {
    const p = createProvider('maidong', cfg);
    if (p.isConfigured()) out.push(p);
  }
  return out;
}

/**
 * 为曲目解析播放地址。
 * @param {{musicNo:string, filename:string, name:string}} song
 * @param {{provider?:string, config?:object}} [opts]
 * @returns {Promise<{url:string, provider:string, expiresAt:number|null, host:string, ls:number}>}
 */
async function resolvePlayUrl(song, opts = {}) {
  const config = opts.config || loadConfig();
  const providers = opts.provider
    ? [createProvider(opts.provider, config)]
    : availableProviders(config);

  if (!providers.length) {
    const err = new Error('没有可用的取流服务。请在 resources/config/providers.json 里配置并启用。');
    err.code = 'NO_PROVIDER';
    throw err;
  }

  const musicNo = song.musicNo || String(song.filename || '').replace(/\.[^.]+$/, '');
  const errors = [];
  for (const p of providers) {
    try {
      const r = await p.getPlayUrl(musicNo);
      return { ...r, provider: p.name };
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
    }
  }
  const err = new Error(errors.join('；'));
  err.code = 'RESOLVE_FAILED';
  throw err;
}

module.exports = {
  MaidongProvider,
  createProvider,
  availableProviders,
  resolvePlayUrl,
  loadConfig,
  saveConfig,
  ensureTemplate,
  CONFIG_FILE,
  onlinePlatforms,
};
