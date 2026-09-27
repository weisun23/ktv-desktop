/**
 * 取流 provider 配置
 * ==================
 * 凭证**不写死在代码里、也不入库**，只从本地配置文件读取：
 *
 *   resources/config/providers.json
 *
 * 这个文件被 .gitignore 排除。原因：maidong 代码里内嵌的 APP_ID / APP_KEY /
 * SDK_KEY 属于**第三方 KTV 服务**，是授权问题而不是版权问题（见
 * docs/00-architecture.md §4）。使用者需要自行确认是否有权使用，并自行配置。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// 打包后由 shell 通过 KTV_CONFIG_DIR 指向用户数据目录（安装目录通常不可写）
const CONFIG_DIR = process.env.KTV_CONFIG_DIR || path.join(REPO_ROOT, 'resources', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'providers.json');

/** 配置模板：只留字段，不含任何真实凭证。 */
function template() {
  return {
    _comment: '取流服务配置。凭证需自行填写，请确认有权使用对应服务。本文件不入库。',
    maidong: {
      enabled: false,
      hosts: [],
      appId: '',
      appKey: '',
      sdkKey: '',
      ver: '2.0',
      vn: '',
      resolution: '720',
      deviceIp: '',
    },
  };
}

/** 读取配置；文件不存在时返回模板（不写盘）。 */
function loadConfig() {
  try {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return { ...template(), ...parsed, maidong: { ...template().maidong, ...(parsed.maidong || {}) } };
  } catch {
    return template();
  }
}

/** 写配置（用于界面上的设置页）。 */
function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  return CONFIG_FILE;
}

/** 首次运行时落一份模板，方便用户知道该填什么。 */
function ensureTemplate() {
  if (fs.existsSync(CONFIG_FILE)) return CONFIG_FILE;
  return saveConfig(template());
}

module.exports = { loadConfig, saveConfig, ensureTemplate, template, CONFIG_FILE, CONFIG_DIR };
