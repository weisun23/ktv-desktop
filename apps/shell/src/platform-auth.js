'use strict';

const fs = require('fs');
const path = require('path');

const PLATFORM_INFO = Object.freeze({
  netease: { label: '网易云', loginUrl: 'https://music.163.com/', cookieUrl: 'https://music.163.com/', cookies: ['MUSIC_U', '__csrf', 'NMTID', '_ntes_nuid'] },
  qq: { label: 'QQ音乐', loginUrl: 'https://y.qq.com/', cookieUrl: 'https://y.qq.com/', cookies: ['qqmusic_key', 'qm_keyst', 'skey', 'p_skey', 'uin'] },
  kugou: { label: '酷狗', loginUrl: 'https://www.kugou.com/', cookieUrl: 'https://www.kugou.com/', cookies: ['token', 'userid', 'KugooID', 'kugouid'] },
  migu: { label: '咪咕', loginUrl: 'https://music.migu.cn/', cookieUrl: 'https://music.migu.cn/', cookies: ['migu_music_token', 'music_token', 'userid', 'sessionid', 'migu_music_userid'] },
});

function cookieHeader(cookies = []) {
  return cookies
    .filter((c) => c && c.name && c.value !== undefined)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function hasAuthCookie(platform, cookies = []) {
  const names = new Set((PLATFORM_INFO[platform]?.cookies || []).map((x) => x.toLowerCase()));
  return cookies.some((c) => names.has(String(c?.name || '').toLowerCase()) && String(c?.value || '').length > 0);
}

class PlatformAuthService {
  constructor({ filePath, safeStorage, session, BrowserWindow, parentWindow } = {}) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.session = session;
    this.BrowserWindow = BrowserWindow;
    this.parentWindow = parentWindow || null;
    this.data = this._load();
    this.loginWindows = new Map();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (raw && raw.version === 1 && raw.platforms && typeof raw.platforms === 'object') return raw;
    } catch { /* 首次运行或文件损坏 */ }
    return { version: 1, platforms: {} };
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  _encrypt(cookie) {
    if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，拒绝保存明文 Cookie');
    }
    return this.safeStorage.encryptString(String(cookie)).toString('base64');
  }

  _decrypt(encoded) {
    try {
      if (!this.safeStorage || !encoded || !this.safeStorage.isEncryptionAvailable()) return '';
      return this.safeStorage.decryptString(Buffer.from(String(encoded), 'base64'));
    } catch {
      return '';
    }
  }

  async _readCookies(platform) {
    const ses = this.session?.fromPartition?.('persist:ktv-auth-' + platform);
    if (!ses?.cookies?.get) return [];
    try { return await ses.cookies.get({}); } catch { return []; }
  }

  async _setSessionCookies(platform, cookie) {
    const info = PLATFORM_INFO[platform];
    const ses = this.session?.fromPartition?.('persist:ktv-auth-' + platform);
    if (!info || !ses?.cookies?.set) return { ok: false, error: '登录会话不可用' };
    let count = 0;
    for (const part of String(cookie || '').split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!name) continue;
      try {
        await ses.cookies.set({ url: info.cookieUrl, name, value, path: '/' });
        count++;
      } catch { /* 单条 Cookie 失败不阻断其他条目 */ }
    }
    return count > 0 ? { ok: true, count } : { ok: false, error: '没有解析出有效 Cookie' };
  }

  async status() {
    const out = {};
    for (const [id, info] of Object.entries(PLATFORM_INFO)) {
      const record = this.data.platforms[id];
      const sessionCookies = await this._readCookies(id);
      const sessionLoggedIn = hasAuthCookie(id, sessionCookies);
      const fileCookie = record?.cookieEnc ? this._decrypt(record.cookieEnc) : '';
      out[id] = {
        id,
        label: info.label,
        needsAuth: true,
        loggedIn: sessionLoggedIn || !!fileCookie,
        sessionLoggedIn,
        fileLoggedIn: !!fileCookie,
        needsRelogin: !!record?.cookieEnc && !sessionLoggedIn && !fileCookie,
        updatedAt: record?.updatedAt || 0,
      };
    }
    return out;
  }

  async getCookieHeader(platform) {
    const sessionCookies = await this._readCookies(platform);
    if (hasAuthCookie(platform, sessionCookies)) return cookieHeader(sessionCookies);
    const record = this.data.platforms[platform];
    return record?.cookieEnc ? this._decrypt(record.cookieEnc) : '';
  }

  async importCookie(platform, cookie) {
    if (!PLATFORM_INFO[platform]) return { ok: false, reason: 'PLATFORM_UNAVAILABLE', error: '未知平台: ' + platform };
    const text = String(cookie || '').trim();
    if (!text) return { ok: false, reason: 'AUTH_REQUIRED', error: 'Cookie 不能为空' };

    const sessionSaved = await this._setSessionCookies(platform, text);
    let fileSaved = false;
    try {
      this.data.platforms[platform] = { cookieEnc: this._encrypt(text), updatedAt: Date.now() };
      this._save();
      fileSaved = true;
    } catch { /* 安全存储不可用时仍可使用持久化 session */ }

    if (!sessionSaved.ok && !fileSaved) {
      return { ok: false, reason: 'SAFE_STORAGE_UNAVAILABLE', error: 'Cookie 保存失败，请检查系统安全存储' };
    }
    return { ok: true, sessionOnly: !fileSaved, status: (await this.status())[platform] };
  }

  async logout(platform) {
    delete this.data.platforms[platform];
    this._save();
    try {
      const ses = this.session?.fromPartition?.('persist:ktv-auth-' + platform);
      if (ses?.clearStorageData) await ses.clearStorageData();
      if (ses?.cookies?.get && ses?.cookies?.remove) {
        const cookies = await ses.cookies.get({});
        for (const c of cookies) {
          try { await ses.cookies.remove(c.url || PLATFORM_INFO[platform]?.cookieUrl, c.name); } catch { /* 忽略单条失败 */ }
        }
      }
    } catch { /* 清理失败不影响本地凭证删除 */ }
    return { ok: true, status: (await this.status())[platform] };
  }

  async _saveSessionCookies(platform) {
    const cookies = await this._readCookies(platform);
    if (!hasAuthCookie(platform, cookies)) return { ok: false, reason: 'AUTH_REQUIRED', error: '未检测到登录状态，请先在窗口中完成登录' };
    const saved = await this.importCookie(platform, cookieHeader(cookies));
    if (!saved.ok) return saved;
    return { ok: true, status: saved.status };
  }

  async openLogin(platform) {
    const info = PLATFORM_INFO[platform];
    if (!info) return { ok: false, reason: 'PLATFORM_UNAVAILABLE', error: '未知平台: ' + platform };
    if (!this.BrowserWindow || !this.session?.fromPartition) return { ok: false, reason: 'PLATFORM_UNAVAILABLE', error: '登录窗口不可用' };
    const old = this.loginWindows.get(platform);
    if (old && !old.isDestroyed?.()) { old.focus?.(); return { ok: true, alreadyOpen: true }; }

    const partition = 'persist:ktv-auth-' + platform;
    const loginWin = new this.BrowserWindow({
      width: 980,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      title: info.label + '登录',
      parent: this.parentWindow || undefined,
      modal: false,
      autoHideMenuBar: true,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.loginWindows.set(platform, loginWin);
    loginWin.loadURL(info.loginUrl);

    const injectDoneButton = () => {
      const script = `(() => {
        if (document.getElementById('ktv-login-done')) return;
        const b = document.createElement('button');
        b.id = 'ktv-login-done';
        b.textContent = '我已登录，完成';
        b.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:10px 16px;border:0;border-radius:8px;background:#1f8fff;color:#fff;font:14px Microsoft YaHei;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25)';
        b.onclick = () => window.close();
        document.body.appendChild(b);
      })()`;
      loginWin.webContents?.executeJavaScript?.(script).catch(() => {});
    };
    loginWin.webContents?.on?.('did-finish-load', injectDoneButton);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        this.loginWindows.delete(platform);
        resolve(result);
      };
      const timer = setInterval(async () => {
        const saved = await this._saveSessionCookies(platform);
        if (saved.ok) {
          finish({ ok: true, loggedIn: true, status: saved.status });
          if (!loginWin.isDestroyed?.()) loginWin.close();
        }
      }, 1000);
      if (timer.unref) timer.unref();

      loginWin.on?.('closed', async () => {
        if (settled) return;
        const saved = await this._saveSessionCookies(platform);
        finish(saved);
      });
    });
  }
}

module.exports = { PlatformAuthService, PLATFORM_INFO, cookieHeader, hasAuthCookie };
