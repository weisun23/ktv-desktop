/**
 * Electron 集成冒烟测试（--smoke）
 * =================================
 * 验证真实 Electron 窗口下的关键链路：
 *   Electron 主窗口 HWND -> Win32 子窗口(VideoSurface) -> libVLC 视频输出
 *   -> 本地曲库点歌 -> 原伴唱切换
 *
 * 不依赖人工点击，跑完直接以退出码汇报结果，便于回归。
 */
'use strict';

const path = require('path');
const { scanLibrary, resolveLocalMedia } = require('./library');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEDIA_ROOT_FOR_SMOKE = path.resolve(__dirname, '..', '..', '..', 'resources', 'catalog', 'video', 'cloud-song');

async function waitUntil(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (pred()) return true; } catch { /* 播放器可能尚未就绪 */ }
    await sleep(100);
  }
  return false;
}

async function runSmoke({ win, player, surface, libraryDir, catalog, state }) {
  const results = [];
  // 冒烟测试使用真实状态文件。测试片源播放前先把队列隔离掉，
  // 否则主进程可能自动续播队列里的歌并重新挂外挂伴奏，和测试片源抢播放器。
  const queueSnapshot = state ? state.getQueue().map((e) => ({ ...e })) : [];
  if (state) state.clearQueue(false);
  await Promise.resolve(player.stop?.());
  await sleep(250);
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
    return !!ok;
  };

  console.log('Electron 集成冒烟测试');
  console.log('  libVLC =', require('@ktv/player').getVersion());

  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', resolve);
  });
  await sleep(800); // 等渲染进程上报视频区尺寸

  check('视频承载子窗口已创建', !!surface && !!surface.handle(),
    `hwnd=0x${surface && surface.handle() ? surface.handle().toString(16) : '?'}`);
  check('视频区尺寸已由界面上报', !!surface && surface.bounds.width > 100,
    surface ? `${surface.bounds.width}x${surface.bounds.height} @(${surface.bounds.x},${surface.bounds.y})` : '');

  // ── 曲库服务 ──
  const cat = typeof catalog === 'function' ? catalog() : catalog;
  const catReady = await waitUntil(() => cat && cat.ready, 40000);
  check('曲库服务就绪', catReady, catReady ? '' : (cat?.lastError || '服务未就绪'));
  if (catReady) {
    const stats = await cat.stats();
    check('曲库统计', stats.songs > 600000, `${stats.songs} 首 / ${stats.singers} 位歌手`);

    const hot = await cat.hot({ limit: 5 });
    check('热歌榜查询', hot.songs?.length === 5, `首条 ${hot.songs?.[0]?.name} - ${hot.songs?.[0]?.singer}`);

    const search = await cat.search({ keyword: '周杰伦', limit: 5 });
    check('按歌手搜索', search.songs?.length > 0, `例: ${search.songs?.[0]?.name} - ${search.songs?.[0]?.singer}`);

    const song = await cat.songById(hot.songs[0].id);
    check('单曲详情带 accomp（决定原伴唱声道）',
      song && typeof song.accomp === 'number' && !!song.filename,
      `accomp=${song?.accomp} filename=${song?.filename}`);

    const noFile = resolveLocalMedia(MEDIA_ROOT_FOR_SMOKE, song.filename);
    check('无本地文件时能正确判定', noFile === null || typeof noFile === 'string',
      noFile ? '本地存在该文件' : '本地无文件（预期，在线取流属阶段 3）');
  }

  const songs = scanLibrary(libraryDir);
  check('扫描本地曲库', songs.length > 0, `${songs.length} 首`);

  const twoTrack = songs.find((s) => s.name.includes('2tracks'));
  const lrTrack = songs.find((s) => s.name.includes('_lr'));
  if (!twoTrack || !lrTrack) {
    check('测试片源齐备', false, '需要 testmedia 下的 ktv_2tracks.ts 与 ktv_lr.ts');
  }

  // ── 双音轨片源 ──
  if (twoTrack) {
    player.load(twoTrack.filePath);
    player.play();
    const started = await waitUntil(() => player.getStatus().time > 200, 25000);
    check('窗口内起播', started, `state=${player.getStatus().stateName}`);

    const gotVout = await waitUntil(() => player.getStatus().hasVout, 10000);
    const st = player.getStatus();
    check('原生视频区建立输出', gotVout, `${st.videoSize.width}x${st.videoSize.height}`);

    await waitUntil(() => player.getTracks().length >= 2, 10000);
    player.resolveStrategy();
    const map = player.getTrackMap();
    check('识别为音轨型片源', player.getStrategy() === 'track' && !!map, JSON.stringify(map));

    // ⚠️ 先等 mpv 把初始 aid 回推完，再切伴唱。
    // 只等 track-list 可能出现 track-list 已到、aid 还停留在默认值的短暂窗口；
    // 这时立刻 set_property 会被随后的初始 aid 回推覆盖，表现为偶发 current=3/expect=2。
    const initialTrackReady = await waitUntil(() => !!map && player.getTrack() === map.original, 4000);
    player.setVocalMode('accompaniment');
    // ⚠️ 这里要**轮询等**，不能固定 sleep：mpv 刚起来时 aid 的变更 + 属性回推
    // 偶尔会超过 500ms，固定等待会偶发假失败（实测就是这样翻车的）。
    const switched = initialTrackReady
      && await waitUntil(() => !!map && player.getTrack() === map.accompaniment, 6000);
    check('切伴唱命中音轨', switched,
      `current=${player.getTrack()} expect=${map && map.accompaniment} initial=${initialTrackReady} tracks=${JSON.stringify(player.getTracks())}`);
  }

  // ── 左右声道片源 ──
  if (lrTrack) {
    player.load(lrTrack.filePath);
    player.play();
    const started = await waitUntil(() => player.getStatus().time > 200, 25000);
    check('换片源起播', started, `state=${player.getStatus().stateName}`);

    // ⚠️ 这个文件是**单音轨**，要等音轨表真的换成 1 条再判。
    // 只写 `>= 1` 的话，换片源后那几百毫秒里读到的还是上一个用例（双音轨）的列表，
    // 会把 2 当成"没识别成声道型"，偶发假失败。
    const tracksSettled = await waitUntil(() => player.getTracks().length === 1, 10000);
    player.resolveStrategy();
    check('识别为声道型片源', tracksSettled && player.getStrategy() === 'channel',
      `tracks=${player.getTracks().length}`);

    player.setVocalMode('accompaniment');
    // 声道切换要重建 aout，属性回推不是瞬时的 —— 轮询等，别写死 sleep
    const chLeft = await waitUntil(() => player.getChannel() === 3, 5000);
    check('切伴唱 -> 左声道', chLeft, `channel=${player.getChannel()}`);

    player.setVocalMode('original');
    const chRight = await waitUntil(() => player.getChannel() === 4, 5000);
    check('切原唱 -> 右声道', chRight, `channel=${player.getChannel()}`);
  }

  player.stop();

  // ── 用户态：队列 / 已唱 / 收藏 ──
  if (state) {
    // 快照设置，跑完还原，避免测试把用户偏好改掉
    const settingsSnapshot = state.getSettings();
    // 队列已在 runSmoke 开头快照并清空，避免播放器测试期间被自动续播干扰。
    // ⚠️ 这个测试跑在**真实**状态文件上。除了队列，它还会清空已唱、动收藏和歌单 ——
    // 之前只快照了队列，结果每次跑 npm test 都会把用户的已唱记录清掉。
    // 现在把这四样全部快照，跑完还原。
    const historySnapshot = state.getHistory().map((h) => ({ ...h }));
    const favoritesSnapshot = state.getFavorites();
    const playlistsSnapshot = state.getPlaylists()
      .map((p) => ({ name: p.name, songs: state.getPlaylistSongs(p.name) }));
    state.clearQueue(false);
    const before = state.getQueue().length;
    state.addToQueue({ id: 'smoke-1', name: '冒烟测试歌', singer: '测试歌手', filename: 'smoke.ts', accomp: 2 });
    check('点歌入队', state.getQueue().length === before + 1);

    state.addToQueue({ id: 'smoke-2', name: '冒烟测试歌2', singer: '测试歌手', filename: 'smoke2.ts', accomp: 1 }, { next: true });
    const q = state.getQueue();
    check('"下一首"插到队首', q[0]?.songId === 'smoke-2', q.map((x) => x.songId).join(','));

    const taken = state.takeNext();
    check('取出下一首并标记播放中', !!taken && taken.status === 'playing' && taken.songId === 'smoke-2',
      `taken=${taken?.songId} status=${taken?.status}`);

    state.markPlayed({ id: 'smoke-2', name: '冒烟测试歌2' });
    check('记入已唱', state.getHistory()[0]?.songId === 'smoke-2');

    check('收藏切换', state.toggleFavorite('smoke-1') === true && state.isFavorite('smoke-1'));

    state.createPlaylist('冒烟歌单');
    state.addToPlaylist('冒烟歌单', 'smoke-1');
    check('歌单增删', state.getPlaylistSongs('冒烟歌单').length === 1);

    // 清理，别污染真实用户数据
    state.clearQueue(false);
    state.clearHistory();
    state.toggleFavorite('smoke-1');
    state.deletePlaylist('冒烟歌单');
    state.updateSettings(settingsSnapshot);
    state.flush();
    check('清理测试数据', state.getQueue().length === 0 && state.getHistory().length === 0);

    // 还原进来之前的状态
    for (const e of queueSnapshot) {
      state.addToQueue({ id: e.songId, name: e.name, singer: e.singer, lang: e.lang,
        filename: e.filename, accomp: e.accomp }, {});
    }
    // ⚠️ history 里的字段是 songId（不是 id），markPlayed 要的是 { id, ... }
    // 直接把快照丢进去会因为 song.id 为 undefined 而静默不还原。
    for (const h of historySnapshot) state.markPlayed({ id: h.songId, name: h.name, singer: h.singer });
    for (const id of favoritesSnapshot) if (!state.isFavorite(id)) state.toggleFavorite(id);
    for (const p of playlistsSnapshot) {
      try { state.createPlaylist(p.name); } catch { /* 已存在 */ }
      for (const id of p.songs) state.addToPlaylist(p.name, id);
    }
    state.flush();
    check('还原进入前的队列', state.getQueue().length === queueSnapshot.length,
      `还原 ${state.getQueue().length}/${queueSnapshot.length}`);
    check('还原进入前的已唱', state.getHistory().length === historySnapshot.length,
      `还原 ${state.getHistory().length}/${historySnapshot.length}`);
    check('还原进入前的收藏', state.getFavorites().length === favoritesSnapshot.length,
      `还原 ${state.getFavorites().length}/${favoritesSnapshot.length}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`Electron 冒烟测试失败 ${failed.length}/${results.length} 项`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    return 1;
  }
  console.log(`Electron 冒烟测试全部通过（${results.length} 项）`);
  return 0;
}

module.exports = { runSmoke };
