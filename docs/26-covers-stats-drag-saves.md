# 26. 曲库封面、已唱统计、拖拽排序、在线收藏

> 四项：曲库列表带封面、已唱统计、拖拽排序、在线结果收藏到本地。

## 1. 曲库列表的封面

**曲库里没有封面数据** —— `songs` 表没这个字段，`albums.image_url` 是空的（0 行）。
所以封面只能**按歌名 + 歌手去网易云查**。

这件事不能蛮干：翻一页热歌榜就是 30 首，每次都查会被风控。所以 `covers.js` 定了四条规矩：

| 规矩 | 为什么 |
|---|---|
| **按 songId 永久缓存**（只存 URL，不落地图片） | 同一首查过一次就不再请求；图片本身交给 Electron 的 HTTP 缓存 |
| **严格限速**（1 并发、每 400ms 一个） | 一页 30 首 ≈ 12 秒陆续冒出来，不会被风控 |
| **查不到也记一笔**（存空字符串） | 否则每次翻回同一页都会把查不到的歌重试一遍 |
| **只在第 1 页/当前页查** | 不预取整个列表 |

界面上封面是"一个一个冒出来"的：主进程解析完一张就 `covers:ready` 推给界面，
不阻塞列表渲染。加载失败 `@error` 把图藏掉，不留破图图标。

> 缓存上限 10000 条，按访问时间 LRU 淘汰。一条只有几十字节，一万条也就几百 KB。
> 设置里有 `showCovers` 开关，不想让它发请求可以关掉。

## 2. 已唱统计

数据本来就有（`history`），只是没展示。已唱面板顶部加一行：

```
4 首 · 4 位歌手 · 最近 7 天 4 首 · 唱最多：任然（1 首）
```

> 口径说明：`history` 是**去重后**的（同一首只留最近一次），所以"唱最多"是按去重记录算的。
> 想按真实次数算得另存计数，先用现有数据能给到的口径。

## 3. 拖拽排序

↑↓ 按钮**保留**（遥控器/键盘用），另加鼠标拖拽。用 HTML5 原生拖拽事件，不引第三方库。

拖拽一次可能跨很多格，所以加了 `moveTo` 系列接口（按钮仍走 ±1）：

```js
moveInQueueTo(entryId, targetEntryId)
moveFavoriteTo(songId, targetSongId)
moveInPlaylistTo(name, songId, targetSongId)
```

队列里**只有 `waiting` 的行可拖**（正在播的那条不能动），用 `:draggable="q.status !== 'playing'"` 控制。

## 4. 在线收藏

曲库里没有的歌，每次都得重新搜。收藏之后在「在线」标签下（**不输关键词时**）直接能点到。

- 唯一键是 `platform:id` —— **同 id 不同平台算两条**（网易云和酷我是两首歌）
- 重复收藏会**挪到最前**，不产生重复项
- 保留 `mvId`，所以收藏的 MV 下次点还是播 MV
- 上限 200 条

列表每行加了 ☆ 按钮，收藏后变 ★（金色）。

## 相关文件

- `apps/shell/src/covers.js` — `CoverService` / `fetchNeteaseCover`
- `apps/shell/src/state.js` — `moveInQueueTo` / `moveFavoriteTo` / `moveInPlaylistTo` / 在线收藏
- `apps/web/src/components/CatalogBrowser.vue` — 封面、在线收藏
- `apps/web/src/components/QueuePanel.vue` — 已唱统计、拖拽
- `apps/shell/test/covers-test.js` — 8 项（缓存、去重、限速、失败兜底）
- `apps/shell/test/state-test.js` — 73 项（含 moveTo 5 项、在线收藏 10 项）
