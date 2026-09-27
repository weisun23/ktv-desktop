# 阶段 4：用户态（队列 / 已唱 / 收藏 / 歌单 / 设置）

**日期**：2026-09-21
**结论**：✅ 完成。点歌改为真正的 KTV 语义——**入队后按序自动播放**。

## 1. 核心设计：点歌 = 入队，不是插播

阶段 3 之前，点一首歌就是立刻播。这在 KTV 场景是错的——客人是一口气点好几首，
然后按顺序唱。所以这一阶段最重要的改动是**改变点歌语义**：

```
点歌            -> 加入已点队列末尾
下首            -> 插到"正在播放"之后（不打断当前这首）
一首唱完         -> 记入已唱 -> 自动接下一首
切歌            -> 当前记入已唱 -> 接下一首
队列播完         -> 停止
```

界面上：左侧曲库点一下就是"点歌"，每行右侧有 `♡`（收藏）和 `下首`（插播）；
右侧是队列面板，`切歌`/`清空` 按钮和已点/已唱/收藏/歌单四个页签。

## 2. 交付物

| 模块 | 路径 | 说明 |
|---|---|---|
| 状态存储 | `apps/shell/src/state.js` | 队列/已唱/收藏/歌单/设置，JSON 落盘 |
| 播放流程 | `apps/shell/src/main.js` | `resolveAndPlay` / `playNextInQueue` / `onSongFinished` |
| 队列面板 | `apps/web/src/components/QueuePanel.vue` | 四个页签 + 队列操作 |
| 曲库列表 | `apps/web/src/components/CatalogBrowser.vue` | 点歌 / 收藏 / 下首 |

## 3. 状态存储：为什么用 JSON 而不是 SQLite

| | JSON | SQLite |
|---|---|---|
| 数据量 | 几十到几千条 | 曲库那种 67 万条才需要 |
| 读写频率 | 低（点歌、切歌时） | 高频查询 |
| 用户可读可备份 | ✅ 直接看/改/拷 | ❌ |
| 依赖 | 无 | 需要 node:sqlite 子进程 |

所以曲库用 SQLite，用户状态用 JSON。落盘做了两件事：

- **防抖 400ms**：连续操作（比如连点几首歌）只写一次
- **原子替换**：先写 `.tmp` 再 rename，避免写一半断电损坏

读取时对损坏文件降级为空状态，不会因为一个坏文件就起不来。

## 4. 队列数据结构

```js
{
  entryId,        // 队列条目唯一 id（同一首歌可以点两次）
  songId,         // 曲库 id
  name, singer, lang, filename, accomp,   // 显示 + 定位用的快照
  addedAt,
  status          // waiting | playing | played
}
```

**只存快照，不存完整曲目**：播放时按 `songId` 回曲库取最新详情。
这样曲库更新后，队列里的歌不会变成脏数据；曲目下架也能优雅降级。

同一首歌点两次会排两首——KTV 里连点两次就是要唱两次。

## 5. 自动接歌与容错

```js
async function onSongFinished(reason) {
  if (currentSong) state.markPlayed(currentSong);   // 记入已唱
  const r = await playNextInQueue();
  if (!r.ok && r.reason === 'QUEUE_EMPTY') { currentSong = null; player.stop(); }
}
```

**播不了就跳过**：如果队列里某首歌本地没有文件、在线又取不到地址，
不会卡住整个队列——提示用户后自动继续找下一首：

```js
if (!r.ok) {
  notify(r.message || `《${song.name}》无法播放，已跳过`);
  advancing = false;
  return playNextInQueue();   // 递归找下一首
}
```

`advancing` 标志防止"自动接歌"与"手动切歌"同时触发导致跳两首。

## 6. 验证

`npm test` 共 **135 项**，本阶段新增：

| 测试 | 项数 | 覆盖 |
|---|---|---|
| 状态存储 | 26 | 队列增删/置顶/插队/清空、已唱上限、收藏、歌单 CRUD、设置、持久化、损坏文件降级 |
| Electron 集成 | +7 | 点歌入队、下首插队、取出播放、记入已唱、收藏、歌单、测试数据清理 |

`apps/shell/test/state-test.js` 用临时目录，不碰真实用户数据；
冒烟测试跑完会清理自己造的队列/收藏/歌单，不会污染 `resources/state/user-state.json`。

## 7. 已知限制

- **队列不持久化播放位置**：重启应用后队列还在，但不会自动接着播。
- **没有拖动排序**：只有"置顶"，不能任意调整顺序。
- **歌单不支持改名**，也不支持把整个歌单一次性加入队列。
- **多用户/多包间**：目前是单机单用户状态，没有账号概念。
- **设置项还很少**：目前只存了音量、默认原伴唱模式、自动接歌开关（后者尚未接到 UI）。
