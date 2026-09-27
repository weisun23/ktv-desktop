/**
 * preload —— 渲染进程与主进程之间唯一的通道。
 * 渲染进程没有 Node 权限，只能通过这里暴露的 API 访问播放器、曲库、队列与本地文件。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ktv', {
  library: {
    scan: () => ipcRenderer.invoke('library:scan'),
    defaultDir: () => ipcRenderer.invoke('library:defaultDir'),
    mediaRoot: () => ipcRenderer.invoke('library:mediaRoot'),
    localFileSet: () => ipcRenderer.invoke('library:localFileSet'),
  },
  catalog: {
    status: () => ipcRenderer.invoke('catalog:status'),
    languages: () => ipcRenderer.invoke('catalog:languages'),
    hot: (opts) => ipcRenderer.invoke('catalog:hot', opts),
    search: (opts) => ipcRenderer.invoke('catalog:search', opts),
    singers: (opts) => ipcRenderer.invoke('catalog:singers', opts),
    singerFacets: () => ipcRenderer.invoke('catalog:singerFacets'),
    singerSongs: (id, opts) => ipcRenderer.invoke('catalog:singerSongs', id, opts),
    singerLetters: (opts) => ipcRenderer.invoke('catalog:singerLetters', opts),
    songs: (ids) => ipcRenderer.invoke('catalog:songs', ids),
    song: (id) => ipcRenderer.invoke('catalog:song', id),
    migrate: () => ipcRenderer.invoke('catalog:migrate'),
  },
  queue: {
    order: (songId, opts) => ipcRenderer.invoke('queue:order', songId, opts),
    orderOnline: (item, opts) => ipcRenderer.invoke('queue:orderOnline', item, opts),
    list: () => ipcRenderer.invoke('queue:list'),
    remove: (entryId) => ipcRenderer.invoke('queue:remove', entryId),
    top: (entryId) => ipcRenderer.invoke('queue:top', entryId),
    move: (entryId, delta) => ipcRenderer.invoke('queue:move', entryId, delta),
    moveTo: (entryId, targetId) => ipcRenderer.invoke('queue:moveTo', entryId, targetId),
    clear: () => ipcRenderer.invoke('queue:clear'),
    next: () => ipcRenderer.invoke('player:next'),
    playNow: (songId) => ipcRenderer.invoke('queue:playNow', songId),
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    remove: (songId) => ipcRenderer.invoke('history:remove', songId),
    clear: () => ipcRenderer.invoke('history:clear'),
  },
  covers: {
    lookup: (items) => ipcRenderer.invoke('covers:lookup', items),
    stats: () => ipcRenderer.invoke('covers:stats'),
    onReady: (cb) => {
      const handler = (_e, p) => cb(p);
      ipcRenderer.on('covers:ready', handler);
      return () => ipcRenderer.removeListener('covers:ready', handler);
    },
  },
  onlineSaves: {
    list: () => ipcRenderer.invoke('onlineSaves:list'),
    add: (item) => ipcRenderer.invoke('onlineSaves:add', item),
    remove: (key) => ipcRenderer.invoke('onlineSaves:remove', key),
  },
  searchHistory: {
    list: () => ipcRenderer.invoke('searchHistory:list'),
    add: (kw) => ipcRenderer.invoke('searchHistory:add', kw),
    remove: (kw) => ipcRenderer.invoke('searchHistory:remove', kw),
    clear: () => ipcRenderer.invoke('searchHistory:clear'),
  },
  favorites: {
    toggle: (songId) => ipcRenderer.invoke('favorites:toggle', songId),
    list: () => ipcRenderer.invoke('favorites:list'),
    is: (songId) => ipcRenderer.invoke('favorites:is', songId),
    move: (songId, delta) => ipcRenderer.invoke('favorites:move', songId, delta),
    moveTo: (songId, targetId) => ipcRenderer.invoke('favorites:moveTo', songId, targetId),
  },
  playlists: {
    list: () => ipcRenderer.invoke('playlists:list'),
    create: (name) => ipcRenderer.invoke('playlists:create', name),
    remove: (name) => ipcRenderer.invoke('playlists:delete', name),
    add: (name, songId) => ipcRenderer.invoke('playlists:add', name, songId),
    addOnline: (name, item) => ipcRenderer.invoke('playlists:addOnline', name, item),
    removeSong: (name, songId) => ipcRenderer.invoke('playlists:remove', name, songId),
    songs: (name) => ipcRenderer.invoke('playlists:songs', name),
    move: (name, songId, delta) => ipcRenderer.invoke('playlists:move', name, songId, delta),
    moveTo: (name, songId, targetId) => ipcRenderer.invoke('playlists:moveTo', name, songId, targetId),
  },
  downloads: {
    list: () => ipcRenderer.invoke('downloads:list'),
    stats: () => ipcRenderer.invoke('downloads:stats'),
    clearFinished: () => ipcRenderer.invoke('downloads:clearFinished'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
  },
  catalogUpdate: {
    check: () => ipcRenderer.invoke('catalog:checkUpdate'),
    run: () => ipcRenderer.invoke('catalog:update'),
  },
  app: {
    paths: () => ipcRenderer.invoke('app:paths'),
  },
  lan: {
    info: () => ipcRenderer.invoke('lan:info'),
    restart: () => ipcRenderer.invoke('lan:restart'),
  },
  online: {
    sources: () => ipcRenderer.invoke('online:sources'),
    hot: (opts) => ipcRenderer.invoke('online:hot', opts),
    search: (opts) => ipcRenderer.invoke('online:search', opts),
    play: (item) => ipcRenderer.invoke('online:play', item),
  },
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    openLogin: (platform) => ipcRenderer.invoke('auth:openLogin', platform),
    importCookie: (platform, cookie) => ipcRenderer.invoke('auth:importCookie', platform, cookie),
    logout: (platform) => ipcRenderer.invoke('auth:logout', platform),
  },
  lyrics: {
    get: (songId) => ipcRenderer.invoke('lyrics:get', songId),
    setVideoText: (text) => ipcRenderer.invoke('lyrics:setVideoText', text),
  },
  cache: {
    dir: () => ipcRenderer.invoke('cache:dir'),
    pickDir: () => ipcRenderer.invoke('cache:pickDir'),
    openDir: () => ipcRenderer.invoke('cache:openDir'),
    clear: () => ipcRenderer.invoke('cache:clear'),
    listFiles: () => ipcRenderer.invoke('cache:listFiles'),
    removeFile: (filename) => ipcRenderer.invoke('cache:removeFile', filename),
    removeOnline: (songId) => ipcRenderer.invoke('cache:removeOnline', songId),
  },
  separator: {
    status: () => ipcRenderer.invoke('separator:status'),
    run: () => ipcRenderer.invoke('separator:run'),
    pickPlugin: () => ipcRenderer.invoke('separator:pickPlugin'),
    install: () => ipcRenderer.invoke('separator:install'),
  },
  providers: {
    status: () => ipcRenderer.invoke('providers:status'),
    reload: () => ipcRenderer.invoke('providers:reload'),
    ensureTemplate: () => ipcRenderer.invoke('providers:ensureTemplate'),
  },
  player: {
    loadLocal: (song) => ipcRenderer.invoke('player:loadLocal', song),
    play: () => ipcRenderer.invoke('player:play'),
    pause: () => ipcRenderer.invoke('player:pause'),
    toggle: () => ipcRenderer.invoke('player:toggle'),
    stop: () => ipcRenderer.invoke('player:stop'),
    seek: (ms) => ipcRenderer.invoke('player:seek', ms),
    seekRelative: (d) => ipcRenderer.invoke('player:seekRelative', d),
    setVolume: (v) => ipcRenderer.invoke('player:setVolume', v),
    setVocalMode: (m) => ipcRenderer.invoke('player:setVocalMode', m),
    setTrack: (id) => ipcRenderer.invoke('player:setTrack', id),
    setTrackMapping: (m) => ipcRenderer.invoke('player:setTrackMapping', m),
    setChannelMapping: (m) => ipcRenderer.invoke('player:setChannelMapping', m),
    setPitch: (semitones) => ipcRenderer.invoke('player:setPitch', semitones),
    setPitchDelta: (delta) => ipcRenderer.invoke('player:setPitchDelta', delta),
    status: () => ipcRenderer.invoke('player:status'),
  },
  window: {
    setFullscreen: (on) => ipcRenderer.invoke('window:setFullscreen', on),
  },
  video: {
    onDoubleClick: (cb) => {
      const handler = () => cb();
      ipcRenderer.on('video:dblclick', handler);
      return () => ipcRenderer.removeListener('video:dblclick', handler);
    },
    setBounds: (rect) => ipcRenderer.invoke('video:setBounds', rect),
    setVisible: (visible) => ipcRenderer.invoke('video:setVisible', visible),
  },
  onUiActivity: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('ui:activity', handler);
    return () => ipcRenderer.removeListener('ui:activity', handler);
  },
  onStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('player:status', handler);
    return () => ipcRenderer.removeListener('player:status', handler);
  },
  onDownloadProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('downloads:progress', handler);
    return () => ipcRenderer.removeListener('downloads:progress', handler);
  },
  onCatalogProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('catalog:progress', handler);
    return () => ipcRenderer.removeListener('catalog:progress', handler);
  },
  onNotice: (cb) => {
    const handler = (_e, notice) => cb(notice);
    ipcRenderer.on('app:notice', handler);
    return () => ipcRenderer.removeListener('app:notice', handler);
  },
});
