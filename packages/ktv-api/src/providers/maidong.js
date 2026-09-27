/**
 * 取流 provider 协议客户端
 * ========================
 * 复刻的是 maidong 的**接口调用流程**（自研实现，未复制其源码）：
 *
 *   1. 取 token:  GET {host}/i.php
 *        appid, mac, sn, time, ver, vn  +  sign = md5(params + appKey)
 *   2. 取播放地址: GET {host}/music/do.php
 *        appid, device, ish265, ls, musicno, resolution, sn, time, token
 *        +  sign = md5(params + sdkKey)
 *
 * 两个实测要点：
 *   - **地址有效期很短（约 1 小时）**，所以必须每次播放前实时获取，不能缓存。
 *   - **必须先做 MWS 授权登录**（见 mwsLogin 的说明）：代理有多个上游节点，
 *     (musicno+ls+device) 的哈希决定路由，用随机设备标识会被分到差的节点。
 *   - 服务端部分节点只返回 demo 地址，需要按 host/ls/设备 组合重试并校验结果。
 *
 * 凭证不写死在代码里：由 resources/config/providers.json 提供（该文件不入库）。
 */
'use strict';

const crypto = require('crypto');
const os = require('os');

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const randomHex = (n) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

/** 取本机首个非回环 IPv4；MWS 授权需要局域网 IP，但不能写死开发者机器地址。 */
function localIpv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

/** 已知的 demo / 占位 / 广告地址特征。 */
function isLikelyDemoUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return true; }
  const host = parsed.hostname;
  const full = parsed.href.toLowerCase();

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;      // 纯 IP
  if (/^pub-[a-z0-9]+\.r2\.dev$/i.test(host)) return true;     // Cloudflare R2 demo 桶
  if (/example\.com$/i.test(host)) return true;

  // 广告/占位片：实测接口会返回 ad_files/my_ad_video.ts（2560x1440，且只有 1 条音轨）
  if (/\/ad[_-]?files?\//i.test(full)) return true;
  if (/my_ad_video|ad_video|advert/i.test(full)) return true;

  return false;
}

/**
 * 判断返回的地址是否**真的对应所请求的曲目**。
 *
 * 实测：接口会返回 `http://gz.ac16.vip/ad_files/my_ad_video.ts` 这种广告片，
 * 它不是"无效 URL"，能正常播放，但内容是广告（而且往往是 4K，软解直接卡死）。
 * 真片源的 URL 路径里一定带 musicNo（如 `.../480p/7789715.ts`），广告不带。
 *
 * 这是比黑名单更可靠的判据，作为取流的主要校验。
 */
function looksLikeRequestedSong(url, musicNo) {
  if (!musicNo) return true;
  try {
    return new URL(url).pathname.includes(String(musicNo));
  } catch {
    return false;
  }
}

/** 从地址的 t 参数解析过期时间（十六进制或十进制秒）。 */
function parseExpiry(url) {
  const m = /[?&]t=([0-9a-fA-F]+)/.exec(url || '');
  if (!m) return null;
  const raw = m[1];
  const secs = /^\d{10}$/.test(raw) ? Number(raw) : parseInt(raw, 16);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return secs * 1000;
}

/** 服务端会在 JSON 前打印 PHP 警告，这里容错提取 JSON 对象。 */
function parseLooseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 继续尝试 */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* 放弃 */ }
  }
  return null;
}

class MaidongProvider {
  /**
   * @param {object} config
   * @param {string[]} config.hosts      接口节点，按优先级排列
   * @param {string} config.appId
   * @param {string} config.appKey
   * @param {string} config.sdkKey
   * @param {string} [config.ver='2.0']
   * @param {string} [config.vn]
   * @param {string} [config.resolution='720']
   * @param {number} [config.maxAttempts=6]  host×ls 组合的最大尝试次数
   * @param {number} [config.timeoutMs=20000]
   */
  constructor(config = {}) {
    this.config = {
      ver: '2.0',
      resolution: '720',
      maxAttempts: 6,
      timeoutMs: 20000,
      ...config,
    };
    this.mac = randomHex(16);
    this.sn = randomHex(16);
    this.tokens = new Map();
  }

  get name() { return 'maidong'; }

  isConfigured() {
    const c = this.config;
    return !!(c.hosts?.length && c.appId && c.appKey && c.sdkKey);
  }

  _require() {
    if (!this.isConfigured()) {
      throw new Error('取流凭证未配置。请在 resources/config/providers.json 里填入 maidong 节点与凭证。');
    }
  }

  async _get(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(this.config.timeoutMs) });
    const text = await res.text();
    return { status: res.status, text, json: parseLooseJson(text) };
  }

  /**
   * MWS 授权登录。
   *
   * 依据 maidong 自己的实现（app/src/main/assets/mobile/ktv_api.js:202）：
   *   - 把 {device_id} 用 RSA/PKCS#1 v1.5 加密后 POST 到 {MWS}/mls-api/v1/login
   *   - 服务端返回 authorized + device_id，**用下发的 device_id 覆盖本地 mac，
   *     并把 sn 也设成同一个值**
   *
   * 为什么重要：代理节点的注释写明「(musicno+ls+device) 的哈希决定路由，
   * 部分节点有真源，部分返回 demo」。我们之前直接用随机 mac/sn 调老接口，
   * 会被路由到差的节点。
   *
   * 没配置 mws/rsaPubKey 时直接跳过，退回旧行为。
   */
  async mwsLogin() {
    const c = this.config;
    if (!c.mws || !c.rsaPubKey) return false;
    try {
      const pem = '-----BEGIN PUBLIC KEY-----\n'
        + String(c.rsaPubKey).replace(/(.{64})/g, '$1\n').trim()
        + '\n-----END PUBLIC KEY-----';
      const encrypted = crypto.publicEncrypt(
        { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(JSON.stringify({ device_id: this.mac }), 'utf8'),
      ).toString('base64');

      const body = JSON.stringify({
        encrypted_data: encrypted, ip: c.deviceIp || localIpv4(), dns: '', router: '',
        subnet_mask: '255.255.255.0', channel: 'common', mode: 'ott',
      });
      const res = await fetch(c.mws + '/mls-api/v1/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Accept': '*/*',
          'User-Agent': 'Dalvik/2.1.0',
        },
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      const data = parseLooseJson(await res.text());
      if (data && data.authorized) {
        if (data.device_id) { this.mac = String(data.device_id); this.sn = String(data.device_id); }
        this.tokens.clear();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** 取 token（同一 host 内缓存，避免每首歌都重新握手）。 */
  async getToken(host) {
    this._require();
    if (this.tokens.has(host)) return this.tokens.get(host);

    const c = this.config;
    const ts = Math.floor(Date.now() / 1000);
    const params = `appid=${c.appId}&mac=${this.mac}_${this.sn}&sn=${this.sn}`
      + `&time=${ts}&ver=${c.ver}` + (c.vn ? `&vn=${c.vn}` : '');
    const { json } = await this._get(`${host}/i.php?${params}&sign=${md5(params + c.appKey)}`);
    if (json && json.code === 200 && json.token) {
      this.tokens.set(host, json.token);
      return json.token;
    }
    return null;
  }

  /** 请求一首歌的播放地址（单次尝试）。 */
  async _fetchUrl(host, musicNo, token, ls) {
    const c = this.config;
    const ts = Math.floor(Date.now() / 1000);
    const params = `appid=${c.appId}&device=${this.mac}_${this.sn}&ish265=0&ls=${ls}`
      + `&musicno=${musicNo}&resolution=${c.resolution}&sn=${this.sn}&time=${ts}&token=${token}`;
    const { json } = await this._get(`${host}/music/do.php?${params}&sign=${md5(params + c.sdkKey)}`);
    if (json && json.code === 200 && typeof json.data === 'string') return json.data;
    return null;
  }

  /**
   * 实时获取可播放地址。
   * @param {string} musicNo songs.filename 去扩展名，例如 "7789715"
   * @returns {Promise<{url:string, host:string, ls:number, expiresAt:number|null}>}
   */
  async getPlayUrl(musicNo) {
    this._require();
    if (!musicNo) throw new Error('缺少 musicNo');

    // 先授权：拿到服务端下发的 device_id 才可能被路由到有真源的节点
    if (!this._mwsTried) {
      this._mwsTried = true;
      this._mwsOk = await this.mwsLogin();
    }

    const hosts = this.config.hosts;
    let attempts = 0;
    let lastDemo = null;
    const errors = [];

    for (const host of hosts) {
      let token;
      try { token = await this.getToken(host); }
      catch (e) { errors.push(`${host} 取 token 失败: ${e.message}`); continue; }
      if (!token) { errors.push(`${host} 取 token 被拒`); continue; }

      for (const ls of [0, 1, 2]) {
        if (attempts >= this.config.maxAttempts) break;
        attempts++;
        let url;
        try { url = await this._fetchUrl(host, musicNo, token, ls); }
        catch (e) { errors.push(`${host} ls=${ls}: ${e.message}`); continue; }
        if (!url) continue;

        // 广告/占位片，或返回的地址压根不是这首歌 -> 换下一个 ls 再试
        if (isLikelyDemoUrl(url) || !looksLikeRequestedSong(url, musicNo)) {
          lastDemo = { host, ls, url };
          continue;
        }

        const expiresAt = parseExpiry(url);
        if (expiresAt && expiresAt < Date.now()) { lastDemo = { host, ls, url }; continue; }

        return { url, host, ls, expiresAt };
      }
    }

    // 换设备再试一轮（maidong 的做法：(musicno+ls+device) 的哈希决定路由）
    if (lastDemo) {
      this.mac = randomHex(16);
      this.sn = randomHex(16);
      this.tokens.clear();
      throw new Error(`接口只返回了广告/占位地址（${lastDemo.host} ls=${lastDemo.ls}，`
        + `地址 ${String(lastDemo.url).slice(0, 60)}… 不含曲目号 ${musicNo}）。`
        + '已重置设备标识，可重试；若持续失败说明该曲目当前无可用源。');
    }
    throw new Error(`未取得播放地址。${errors.slice(0, 3).join('；')}`);
  }
}

module.exports = { MaidongProvider, isLikelyDemoUrl, looksLikeRequestedSong, parseExpiry, parseLooseJson };
