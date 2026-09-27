/**
 * 用户状态存储测试（临时目录，不碰真实数据）
 * 用法: node test/state-test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { UserState, QueueStatus } = require('../src/state');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  return !!ok;
}

const song = (id, name) => ({ id, name, singer: '歌手' + id, lang: '国语', filename: `${id}.ts`, accomp: 2 });

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-state-'));
  const file = path.join(dir, 'user-state.json');
  const st = new UserState(file).load();

  // ── 队列 ──
  st.addToQueue(song('a', 'A歌'));
  st.addToQueue(song('b', 'B歌'));
  st.addToQueue(song('c', 'C歌'));
  check('加入队列', st.getQueue().length === 3);

  // 去重：已在队列里的歌不能重复点
  const dup = st.addToQueue(song('a', 'A歌'));
  check('重复点歌被拒绝', dup.duplicate === true && dup.entry === null);
  check('队列里没有出现重复条目', st.getQueue().length === 3);
  check('isQueued 能识别已点', st.isQueued('a') === true && st.isQueued('zzz') === false);

  const first = st.takeNext();
  check('取第一首并标记正在播放', first?.songId === 'a' && first.status === QueueStatus.Playing);
  check('已点队列里只有一首是 playing',
    st.getQueue().filter((q) => q.status === QueueStatus.Playing).length === 1);

  const second = st.takeNext();
  check('再取下一首', second?.songId === 'b');
  check('唱完的歌被移出队列', !st.getQueue().some((q) => q.songId === 'a'),
    st.getQueue().map((q) => q.songId).join(','));
  check('移出后可以再点同一首', st.addToQueue(song('a', 'A歌')).duplicate === false);

  // 置顶
  const cEntry = st.getQueue().find((q) => q.songId === 'c');
  st.moveToNext(cEntry.entryId);
  const afterTop = st.getQueue();
  const playingIdx = afterTop.findIndex((q) => q.status === QueueStatus.Playing);
  check('置顶后排到正在播放之后', afterTop[playingIdx + 1]?.songId === 'c',
    afterTop.map((q) => `${q.songId}:${q.status}`).join(','));

  // 插队（下一首）
  st.addToQueue(song('d', 'D歌'), { next: true });
  const afterInsert = st.getQueue();
  const pIdx2 = afterInsert.findIndex((q) => q.status === QueueStatus.Playing);
  check('"下一首播放"插到正在播放之后', afterInsert[pIdx2 + 1]?.songId === 'd');

  // 移除
  const dEntry = st.getQueue().find((q) => q.songId === 'd');
  check('移除队列条目', st.removeFromQueue(dEntry.entryId) === true && !st.getQueue().some((q) => q.songId === 'd'));
  check('移除不存在的条目返回 false', st.removeFromQueue('nope') === false);

  // 清空（保留正在播放）
  st.clearQueue(true);
  check('清空队列保留正在播放', st.getQueue().length === 1 && st.getQueue()[0].status === QueueStatus.Playing);

  // ── 已唱 ──
  st.markPlayed(song('x', 'X歌'));
  st.markPlayed(song('y', 'Y歌'));
  check('已唱历史最新在前', st.getHistory()[0].songId === 'y' && st.getHistory().length === 2);
  for (let i = 0; i < 320; i++) st.markPlayed(song('h' + i, 'H' + i));
  check('已唱历史有上限', st.getHistory().length <= 300, `${st.getHistory().length} 条`);

  // ── 收藏 ──
  check('收藏返回 true', st.toggleFavorite('a') === true && st.isFavorite('a'));
  check('再点取消收藏', st.toggleFavorite('a') === false && !st.isFavorite('a'));
  st.toggleFavorite('b');
  check('收藏列表', st.getFavorites().includes('b'));

  // ── 歌单 ──
  check('默认歌单存在', st.getPlaylists().some((p) => p.name === '我的收藏'));
  st.createPlaylist('周末嗨歌');
  st.addToPlaylist('周末嗨歌', 'a');
  st.addToPlaylist('周末嗨歌', 'b');
  st.addToPlaylist('周末嗨歌', 'a');   // 重复不应重复添加
  check('歌单加歌去重', st.getPlaylistSongs('周末嗨歌').length === 2,
    st.getPlaylistSongs('周末嗨歌').join(','));
  check('歌单移除', st.removeFromPlaylist('周末嗨歌', 'a') === true
    && st.getPlaylistSongs('周末嗨歌').length === 1);
  let threw = false;
  try { st.createPlaylist('周末嗨歌'); } catch { threw = true; }
  check('重名歌单报错', threw);
  threw = false;
  try { st.deletePlaylist('我的收藏'); } catch { threw = true; }
  check('默认歌单不可删', threw);
  check('删除自建歌单', st.deletePlaylist('周末嗨歌') === true);

  // ── 设置 ──
  check('默认设置', st.getSettings().autoPlayNext === true && st.getSettings().volume === 100);
  st.updateSettings({ volume: 66, defaultVocalMode: 'accompaniment' });
  check('更新设置', st.getSettings().volume === 66 && st.getSettings().defaultVocalMode === 'accompaniment');

  // ── 持久化 ──
  st.flush();
  check('状态文件已落盘', fs.existsSync(file));
  const reloaded = new UserState(file).load();
  check('重新载入保持数据', reloaded.getSettings().volume === 66
    && reloaded.getFavorites().includes('b')
    && reloaded.getHistory().length > 0,
    `volume=${reloaded.getSettings().volume} favs=${reloaded.getFavorites().length} history=${reloaded.getHistory().length}`);

  // ── 容错：损坏文件不应崩 ──
  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8');
  const recovered = new UserState(file).load();
  check('损坏的状态文件降级为空状态', recovered.getQueue().length === 0 && recovered.getSettings().volume === 100);

  fs.rmSync(dir, { recursive: true, force: true });

  // ── 重启后残留的 playing 必须降级为 waiting ──
  // 上次退出时正在播的条目状态是 playing；不降级的话它会一直挂着「已点」标：
  // takeNext() 跳过 playing，用户重新点又被重复校验拦下，等于卡死一首。
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ktv-state-restart-"));
    const file2 = path.join(dir2, "user-state.json");
    const s1 = new UserState(file2).load();
    s1.addToQueue(song("r1", "重启测试"));
    const taken = s1.takeNext();
    check("退出前该条目是 playing", taken && taken.status === QueueStatus.Playing);
    s1.flush();

    const s2 = new UserState(file2).load();
    const q = s2.getQueue();
    check("重启后残留 playing 被降级", q.length === 1 && q[0].status === QueueStatus.Waiting,
      q.map((x) => x.status).join(","));
    check("重启后该条目能被 takeNext 取到", !!s2.takeNext());
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // ── 已唱去重：同一首只保留最近一次 ──
  {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "ktv-state-hist-"));
    const file3 = path.join(dir3, "user-state.json");
    const s3 = new UserState(file3).load();
    s3.markPlayed(song("h1", "反复唱"));
    s3.markPlayed(song("h2", "另一首"));
    s3.markPlayed(song("h1", "反复唱"));
    const h = s3.getHistory();
    check("重复唱同一首只留一条", h.length === 2 && h.filter((x) => x.songId === "h1").length === 1,
      h.map((x) => x.songId).join(","));
    check("保留的是最近一次（排在最前）", h[0].songId === "h1", h[0].songId);
    s3.flush();

    // 老存档里已经堆了重复：载入时要清掉
    const raw = JSON.parse(fs.readFileSync(file3, "utf8"));
    raw.history = [
      { songId: "x", name: "X", playedAt: 100 },
      { songId: "x", name: "X", playedAt: 300 },
      { songId: "y", name: "Y", playedAt: 200 },
    ];
    fs.writeFileSync(file3, JSON.stringify(raw), "utf8");
    const s4 = new UserState(file3).load();
    const h2 = s4.getHistory();
    check("载入时清掉历史重复", h2.length === 2 && h2[0].songId === "x", h2.map((x) => x.songId).join(","));
    fs.rmSync(dir3, { recursive: true, force: true });
  }

  // ── 队列排序（遥控器调顺序，比拖拽可靠）──
  {
    const st2 = new UserState(path.join(dir, 'order.json')).load();
    st2.clearQueue(false);
    for (const id of ['a', 'b', 'c']) st2.addToQueue(song(id, '歌' + id));
    const names = () => st2.getQueue().map((q) => q.songId).join(',');
    check('初始顺序', names() === 'a,b,c', names());

    const cId = st2.getQueue()[2].entryId;
    check('末条上移一位', st2.moveInQueue(cId, -1) === true && names() === 'a,c,b', names());
    check('中间条下移一位', st2.moveInQueue(st2.getQueue()[1].entryId, 1) === true && names() === 'a,b,c', names());
    check('已在最前不能再上移', st2.moveInQueue(st2.getQueue()[0].entryId, -1) === false && names() === 'a,b,c');
    check('已在最后不能再下移', st2.moveInQueue(st2.getQueue()[2].entryId, 1) === false);

    // 正在播的那条不能被挪走，也不能被别人越过
    st2.takeNext();                      // a 变成 playing
    const playing = st2.getQueue().find((q) => q.status === QueueStatus.Playing);
    check('正在播放的条目不能移动', st2.moveInQueue(playing.entryId, 1) === false);
    const last = st2.getQueue()[st2.getQueue().length - 1];
    check('waiting 之间可以跨越 playing 换位',
      st2.moveInQueue(last.entryId, -1) === true, names());
  }

  // ── 收藏 / 歌单排序 ──
  {
    const st3 = new UserState(path.join(dir, 'fav.json')).load();
    for (const id of ['x', 'y', 'z']) st3.toggleFavorite(id);
    const favs = () => st3.getFavorites().join(',');
    check('收藏最新的在最前', favs() === 'z,y,x', favs());
    check('收藏末位上移', st3.moveFavorite('x', -1) === true && favs() === 'z,x,y', favs());
    check('收藏已在最前不能再上移', st3.moveFavorite('z', -1) === false);
    check('收藏不存在的 id 返回 false', st3.moveFavorite('nope', 1) === false);

    st3.createPlaylist('测试单');
    for (const id of ['p1', 'p2', 'p3']) st3.addToPlaylist('测试单', id);
    const pls = () => st3.getPlaylistSongs('测试单').join(',');
    check('歌单末尾上移', st3.moveInPlaylist('测试单', 'p3', -1) === true && pls() === 'p1,p3,p2', pls());
    check('歌单不存在的名字返回 false', st3.moveInPlaylist('没有这个单', 'p1', 1) === false);
  }

  // ── 搜索历史 ──
  {
    const st4 = new UserState(path.join(dir, 'search.json')).load();
    check('初始为空', st4.getSearchHistory().length === 0);
    st4.addSearchHistory('海阔天空');
    st4.addSearchHistory('周杰伦');
    check('最新的排最前', st4.getSearchHistory().join(',') === '周杰伦,海阔天空', st4.getSearchHistory().join(','));
    st4.addSearchHistory('海阔天空');
    check('重复搜索不产生重复项，只挪到最前',
      st4.getSearchHistory().join(',') === '海阔天空,周杰伦', st4.getSearchHistory().join(','));
    check('空词不记录', st4.addSearchHistory('   ') === false && st4.getSearchHistory().length === 2);
    st4.removeSearchHistory('海阔天空');
    check('能删单条', st4.getSearchHistory().join(',') === '周杰伦');
    for (let i = 0; i < 30; i++) st4.addSearchHistory('词' + i);
    check('超过上限自动截断', st4.getSearchHistory().length === 20, String(st4.getSearchHistory().length));
    st4.clearSearchHistory();
    check('能清空', st4.getSearchHistory().length === 0);

    // 落盘再读回来
    st4.addSearchHistory('持久化测试');
    st4.flush();
    const st5 = new UserState(path.join(dir, 'search.json')).load();
    check('搜索历史能持久化', st5.getSearchHistory().join(',') === '持久化测试', st5.getSearchHistory().join(','));
  }

  // ── 拖拽用的 moveTo ──
  {
    const st6 = new UserState(path.join(dir, 'moveto.json')).load();
    st6.clearQueue(false);
    for (const id of ['a', 'b', 'c', 'd']) st6.addToQueue(song(id, '歌' + id));
    const names = () => st6.getQueue().map((q) => q.songId).join(',');
    const ids = st6.getQueue().map((q) => q.entryId);
    check('moveTo：把第一条拖到最后', st6.moveInQueueTo(ids[0], ids[3]) === true && names() === 'b,c,d,a', names());
    check('moveTo：拖到自己身上不动', st6.moveInQueueTo(ids[1], ids[1]) === false && names() === 'b,c,d,a');
    check('moveTo：不存在的条目返回 false', st6.moveInQueueTo('nope', ids[1]) === false);

    for (const id of ['x', 'y', 'z']) st6.toggleFavorite(id);
    check('收藏 moveTo', st6.moveFavoriteTo('x', 'z') === true && st6.getFavorites().join(',') === 'x,z,y',
      st6.getFavorites().join(','));

    st6.createPlaylist('拖动单');
    for (const id of ['p1', 'p2', 'p3']) st6.addToPlaylist('拖动单', id);
    check('歌单 moveTo', st6.moveInPlaylistTo('拖动单', 'p1', 'p3') === true
      && st6.getPlaylistSongs('拖动单').join(',') === 'p2,p3,p1', st6.getPlaylistSongs('拖动单').join(','));
  }

  // ── 在线收藏 ──
  {
    const st7 = new UserState(path.join(dir, 'online.json')).load();
    const item = (id, title, extra = {}) => ({ platform: 'netease', id, title, artist: '歌手', duration: 100, cover: 'https://x/y.jpg', ...extra });
    check('初始为空', st7.getOnlineSaves().length === 0);

    st7.addOnlineSave(item('1', '第一首'));
    st7.addOnlineSave(item('2', '第二首'));
    check('最新的排最前', st7.getOnlineSaves().map((x) => x.title).join(',') === '第二首,第一首',
      st7.getOnlineSaves().map((x) => x.title).join(','));

    st7.addOnlineSave(item('1', '第一首'));
    check('同一首不重复（按 platform:id）', st7.getOnlineSaves().length === 2);
    check('重复收藏会挪到最前', st7.getOnlineSaves()[0].title === '第一首');

    // 不同平台同 id 算两条
    st7.addOnlineSave({ platform: 'kuwo', id: '1', title: '酷我的第一首' });
    check('不同平台同 id 算两条', st7.getOnlineSaves().length === 3);

    check('缺 platform/id 的不收', st7.addOnlineSave({ title: '没有 id' }) === false && st7.getOnlineSaves().length === 3);
    check('mvId 会被保留', st7.addOnlineSave(item('9', '带MV', { mvId: '123' })) === true
      && st7.getOnlineSaves()[0].mvId === '123');

    check('能按 key 删除', st7.removeOnlineSave('netease:1') === true
      && !st7.getOnlineSaves().some((x) => x.platform === 'netease' && x.id === '1'));
    check('删不存在返回 false', st7.removeOnlineSave('nope:1') === false);

    for (let i = 0; i < 250; i++) st7.addOnlineSave(item('k' + i, '批量' + i));
    check('超过上限自动截断', st7.getOnlineSaves().length === 200, String(st7.getOnlineSaves().length));

    st7.flush();
    const st8 = new UserState(path.join(dir, 'online.json')).load();
    check('在线收藏能持久化', st8.getOnlineSaves().length === 200);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`状态存储测试失败 ${failed.length}/${results.length} 项`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
  console.log(`状态存储测试全部通过（${results.length} 项）`);
}

main();
