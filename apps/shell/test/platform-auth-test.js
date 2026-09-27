'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlatformAuthService } = require('../src/platform-auth');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-auth-test-'));
const file = path.join(tmp, 'platform-auth.json');
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
  decryptString: (b) => b.toString('utf8').slice(4),
};
const cookieStore = [];
const fakeSession = {
  fromPartition: () => ({
    cookies: {
      get: async () => cookieStore.map((x) => ({ ...x })),
      set: async (c) => { const i = cookieStore.findIndex((x) => x.name === c.name); if (i >= 0) cookieStore[i] = { ...c }; else cookieStore.push({ ...c }); },
      remove: async (_url, name) => { const i = cookieStore.findIndex((x) => x.name === name); if (i >= 0) cookieStore.splice(i, 1); },
    },
    clearStorageData: async () => { cookieStore.length = 0; },
  }),
};
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  [PASS] ' + name); pass++; }
  catch (e) { console.log('  [FAIL] ' + name + ' - ' + e.message); fail++; }
}
(async () => {
  console.log('');
  console.log('平台凭证存储');
  const auth = new PlatformAuthService({ filePath: file, safeStorage: fakeSafeStorage, session: fakeSession });
  await t('初始状态未登录', async () => {
    const s = await auth.status();
    assert.strictEqual(s.qq.loggedIn, false);
    assert.strictEqual(s.kugou.loggedIn, false);
  });
  await t('导入 Cookie 后状态为已登录', async () => {
    const r = await auth.importCookie('qq', 'uin=123; qqmusic_key=abc');
    assert.strictEqual(r.ok, true);
    assert.strictEqual((await auth.status()).qq.loggedIn, true);
  });
  await t('磁盘上没有明文 Cookie', () => {
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('qqmusic_key=abc'));
    assert.ok(raw.includes('cookieEnc'));
  });
  await t('可以取回原始 Cookie', async () => {
    const text = await auth.getCookieHeader('qq');
    assert.ok(text.includes('qqmusic_key=abc'));
  });
  await t('状态接口不泄露 Cookie', async () => {
    const raw = JSON.stringify(await auth.status());
    assert.ok(!raw.includes('qqmusic_key=abc'));
  });
  await t('退出登录清除凭证', async () => {
    await auth.logout('qq');
    assert.strictEqual((await auth.status()).qq.loggedIn, false);
    assert.strictEqual(await auth.getCookieHeader('qq'), '');
  });
  await t('safeStorage 不可用时仍可使用持久化 session', async () => {
    const sessionOnly = new PlatformAuthService({
      filePath: path.join(tmp, 'session-only.json'),
      safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
      session: fakeSession,
    });
    const r = await sessionOnly.importCookie('kugou', 'token=abc; userid=42');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sessionOnly, true);
    assert.ok((await sessionOnly.getCookieHeader('kugou')).includes('token=abc'));
  });
  await t('safeStorage 与 session 都不可用时拒绝保存', async () => {
    const denied = new PlatformAuthService({
      filePath: path.join(tmp, 'denied.json'),
      safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
      session: { fromPartition: () => ({ cookies: { get: async () => [] } }) },
    });
    const r = await denied.importCookie('migu', 'userid=abc');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'SAFE_STORAGE_UNAVAILABLE');
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('');
  console.log('平台凭证测试：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
