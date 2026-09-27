# Online Sources Auth, Hot Search and LAN QR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add QQ Music, Kugou and Migu online sources with cookie-based authentication, hot content in the online search page, and visible LAN QR entry points.

**Architecture:** Keep platform search and playback adapters inside `packages/ktv-api`. Add a main-process `PlatformAuthService` that stores encrypted cookies and opens official login windows. Expose the features through preload IPC and build focused Vue dialogs for account management and LAN QR display.

**Tech Stack:** Electron 33, Node 22 fetch, Electron safeStorage, Vue 3, Vite, existing IPC/preload patterns.

## Global Constraints

- Do not add Bilibili in this iteration.
- Online search uses one selected platform at a time.
- Cookies never cross into the renderer process.
- Use Electron `safeStorage`; do not fall back to plaintext storage.
- Existing Netease and Kuwo behavior must remain compatible.
- All new files use LF line endings.
- Every scripted replacement must assert the expected hit count.

---

### Task 1: Add the online platform registry and QQ/Kugou/Migu adapters

**Files:**
- Create: `packages/ktv-api/src/providers/platforms/qq.js`
- Create: `packages/ktv-api/src/providers/platforms/kugou.js`
- Create: `packages/ktv-api/src/providers/platforms/migu.js`
- Create: `packages/ktv-api/src/providers/platform-registry.js`
- Create: `packages/ktv-api/test/platform-registry-test.js`
- Modify: `packages/ktv-api/package.json`
- Modify: `packages/ktv-api/src/index.js`

**Interfaces:**
- Produces: `listPlatforms(): Array<{id,label,needsAuth,mv}>`
- Produces: `searchPlatform(id, keyword, opts): Promise<{ok,songs,hasMore,error?}>`
- Produces: `hotPlatform(id, opts): Promise<{ok,songs,hasMore,error?}>`
- Produces: `resolveAudio(id, platformId, opts): Promise<{ok,url,error?,reason?}>`
- Produces: `resolveMv(id, platformId, opts): Promise<{ok,url,error?,reason?}>`

- [ ] **Step 1: Write failing registry tests**

Create `platform-registry-test.js` with assertions that the registry contains exactly `netease, kuwo, qq, kugou, migu`, that QQ/Kugou/Migu report `needsAuth: true`, and that parser fixtures produce normalized song objects with `platform,id,title,artist,duration,hasMv,mvId,cover`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node packages/ktv-api/test/platform-registry-test.js`
Expected: FAIL because `platform-registry.js` does not exist.

- [ ] **Step 3: Implement adapters and registry**

Implement the three adapters with these exported functions:

```js
module.exports = {
  id: 'qq',
  label: 'QQ音乐',
  needsAuth: true,
  search,
  hot,
  resolveAudio,
  resolveMv,
  parseSong,
};
```

QQ uses `u.y.qq.com/cgi-bin/musicu.fcg` for search, hot list `topId=26`, `vkey.GetVkeyServer` for audio and `GetMvUrls` for MV. Kugou uses `mobilecdn.kugou.com` search/hot, `trackercdnbj.kugou.com/i/v2/` plus `wwwapi.kugou.com/yy/index.php` fallback for audio and `m.kugou.com/app/i/mv.php` for MV. Migu uses `search_all.do`, `querycontentbyId.do`, `listen-url/v2.4` and `resourceinfo.do`.

The registry keeps Netease and Kuwo wrappers around `online-search.js`, and normalizes all errors to `AUTH_REQUIRED`, `AUTH_EXPIRED`, `PLATFORM_UNAVAILABLE`, `NO_PLAYABLE_RESOURCE` or `NOT_SUPPORTED`.

- [ ] **Step 4: Run the tests and live search probe**

Run: `node packages/ktv-api/test/platform-registry-test.js`
Run: `node packages/ktv-api/test/online-search-test.js`
Expected: parser tests pass; existing Netease live tests pass or skip when offline.

- [ ] **Step 5: Commit**

```bash
git add packages/ktv-api/src/providers packages/ktv-api/src/index.js packages/ktv-api/package.json packages/ktv-api/test/platform-registry-test.js
git commit -m "feat: add qq kugou migu online platform adapters"
```

---

### Task 2: Add encrypted platform authentication and login windows

**Files:**
- Create: `apps/shell/src/platform-auth.js`
- Create: `apps/shell/test/platform-auth-test.js`
- Modify: `apps/shell/package.json`
- Modify: `apps/shell/src/preload.js`
- Modify: `apps/shell/src/main.js`

**Interfaces:**
- Produces: `new PlatformAuthService({ filePath, safeStorage, session, BrowserWindow, parentWindow })`
- Produces: `status()`, `getCookieHeader(platform)`, `importCookie(platform, cookie)`, `openLogin(platform)`, `logout(platform)`

- [ ] **Step 1: Write failing auth-store tests**

Create a fake safeStorage with deterministic reversible encryption and a temporary file. Assert that imported cookies are encrypted on disk, `getCookieHeader` returns the original string, `status` never contains the cookie, and `logout` removes the record.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node apps/shell/test/platform-auth-test.js`
Expected: FAIL because `platform-auth.js` does not exist.

- [ ] **Step 3: Implement the auth service**

Use `persist:ktv-auth-<platform>` partitions. Login URLs are `https://y.qq.com/`, `https://www.kugou.com/` and `https://music.migu.cn/`. Detect authentication cookies with per-platform name sets. Inject a floating “完成登录” button into the login window that calls `window.close()`; on close, read `session.cookies.get({})`, save the cookie header when an auth cookie exists, otherwise return `AUTH_REQUIRED`.

- [ ] **Step 4: Add IPC handlers and preload methods**

Add:

```js
auth: {
  status: () => ipcRenderer.invoke('auth:status'),
  openLogin: (platform) => ipcRenderer.invoke('auth:openLogin', platform),
  importCookie: (platform, cookie) => ipcRenderer.invoke('auth:importCookie', platform, cookie),
  logout: (platform) => ipcRenderer.invoke('auth:logout', platform),
}
```

Register matching `ipcMain.handle` entries in `main.js` and initialize the service after `state` is loaded.

- [ ] **Step 5: Run tests**

Run: `node apps/shell/test/platform-auth-test.js`
Run: `node apps/shell/test/ipc-channels-test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/shell/src/platform-auth.js apps/shell/test/platform-auth-test.js apps/shell/src/preload.js apps/shell/src/main.js apps/shell/package.json
git commit -m "feat: add encrypted online platform authentication"
```

---

### Task 3: Route online search, hot lists and playback through the registry

**Files:**
- Modify: `apps/shell/src/main.js`
- Modify: `apps/shell/src/preload.js`
- Modify: `packages/ktv-api/src/providers/online-search.js`
- Modify: `apps/shell/test/ipc-channels-test.js`

**Interfaces:**
- Consumes: `platform-registry.js` and `PlatformAuthService`.
- Produces IPC: `online:sources`, `online:hot`, extended `online:search`, extended `online:play`.

- [ ] **Step 1: Add failing IPC assertions**

Extend the critical channel list with `online:sources`, `online:hot`, `auth:status`, `auth:openLogin`, `auth:importCookie` and `auth:logout`.

- [ ] **Step 2: Implement main-process routing**

`online:search` accepts `{ platform, keyword, page, pageSize, onlyMv }` and delegates to the registry. `online:hot` delegates to `hotPlatform`. `resolveOnlineAndPlay` resolves audio or MV with `platformAuth.getCookieHeader(platform)`. When a resolver returns `AUTH_REQUIRED`, return that reason to the renderer instead of a generic error.

- [ ] **Step 3: Run tests**

Run: `node apps/shell/test/ipc-channels-test.js`
Run: `node packages/ktv-api/test/platform-registry-test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/shell/src/main.js apps/shell/src/preload.js packages/ktv-api/src/providers/online-search.js apps/shell/test/ipc-channels-test.js
git commit -m "feat: route online sources through platform registry"
```

---

### Task 4: Add platform selection, hot content and account dialog to the web UI

**Files:**
- Create: `apps/web/src/components/PlatformAuthDialog.vue`
- Modify: `apps/web/src/components/CatalogBrowser.vue`
- Modify: `apps/web/src/components/SidePanel.vue`
- Modify: `apps/web/src/App.vue`
- Modify: `apps/web/src/components/SettingsDialog.vue`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `bridge.online.sources()`, `bridge.online.hot()`, `bridge.auth.*`.
- Produces: platform selector, hot empty state, account management dialog, login-required row states.

- [ ] **Step 1: Add platform state and hot-loading tests**

Use the existing Vite build as the compile check. Verify in CDP that the online toolbar contains a platform selector, that empty query calls the hot endpoint, and that switching platform clears stale results.

- [ ] **Step 2: Implement platform selection and hot content**

Keep one `onlinePlatform` ref. When `tab === 'online'` and `query` is empty, call `bridge.online.hot({ platform, page, pageSize })`. When a keyword exists, call `bridge.online.search({ platform, keyword, ... })`. Render a “热门榜” heading when the query is empty and a source/login badge on every row.

- [ ] **Step 3: Implement PlatformAuthDialog**

The dialog lists QQ音乐, 酷狗 and 咪咕, shows login status, and provides “扫码登录”, “导入 Cookie” and “退出登录”. It polls `bridge.auth.status()` while open and never displays the cookie value.

- [ ] **Step 4: Handle login-required actions**

If order or play-now returns `AUTH_REQUIRED`, open the account dialog for that platform and show “登录后才能播放”. Keep the item visible.

- [ ] **Step 5: Run build and CDP verification**

Run: `npm run build:web`
Verify: platform selector, empty-query hot list, account dialog open/close, and no console errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat: add online platform selection hot content and account dialog"
```

---

### Task 5: Add visible LAN QR entry points

**Files:**
- Create: `apps/web/src/components/LanQrDialog.vue`
- Modify: `apps/web/src/App.vue`
- Modify: `apps/web/src/components/VideoStage.vue`
- Modify: `apps/web/src/components/SettingsDialog.vue`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `bridge.lan.info()`, `bridge.lan.restart()`, `bridge.settings.update()`.
- Produces: topbar “手机点歌” button, LAN QR dialog, idle-stage QR card.

- [ ] **Step 1: Add failing UI checks**

In CDP, assert that a topbar button with accessible name `手机点歌` exists, that clicking it opens a dialog containing a QR image or a readable disabled state, and that the idle stage contains a QR card when no song is playing.

- [ ] **Step 2: Implement LanQrDialog**

Show running state, QR image from `http://127.0.0.1:<port>/api/qr.svg`, URL, copy button, enable/disable buttons, port input, multi-address hint and firewall hint.

- [ ] **Step 3: Add topbar and idle-stage entries**

Add the topbar button next to the settings gear. Add a small QR card to the VideoStage placeholder only when no media is active; clicking it opens the same dialog. Keep the settings section for advanced configuration.

- [ ] **Step 4: Run build and CDP verification**

Run: `npm run build:web`
Verify: topbar button opens dialog, QR image loads, idle card opens the dialog, playback hides the idle card.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat: make lan qr entry visible"
```

---

### Task 6: Documentation, version bump, regression tests and packaging

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `apps/shell/package.json`
- Modify: `apps/shell/package-lock.json`
- Modify: `docs/10-packaging.md`
- Create: `docs/35-online-sources-auth-hot-and-lan-qr.md`

- [ ] **Step 1: Bump the version**

Set root, shell and lockfile versions to `0.5.0`.

- [ ] **Step 2: Document the feature**

Document the three new sources, login/cookie behavior, hot empty state, and the three LAN QR entry points. State that Bilibili is intentionally not included.

- [ ] **Step 3: Run full verification**

Run: `npm run build:web`
Run: `npm test`
Run: `npm --prefix apps/shell run dist` with the configured Electron mirrors.
Expected: all tests pass and NSIS/portable artifacts are produced.

- [ ] **Step 4: Verify the installer**

Install silently, confirm `%LOCALAPPDATA%\\Programs\\KTV Desktop\\KTV Desktop.exe`, then uninstall silently.

- [ ] **Step 5: Commit and tag**

```bash
git add -A
git commit -m "release: v0.5.0 online sources auth hot content and lan qr"
git tag v0.5.0
```
