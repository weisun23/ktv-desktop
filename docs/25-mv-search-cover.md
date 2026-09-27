# 25. MV 搜索带封面

> 「mv搜索能不能带封面的那种」

## 结论：能，而且顺便换成了**真正的 MV 搜索**

### 数据从哪来

曲库里**没有封面**：`songs` 表没有封面字段，`albums.image_url` 是空的（0 行）。
封面只能来自在线源。

网易云有两个接口，差别很大：

| 接口 | 搜歌封面 | MV 搜索 |
|---|---|---|
| `/api/search/get/web`（老，原来用的） | ❌ 只给 `album.picId`，要自己算加密路径段 | ❌ `type=1004` 直接返回 400 |
| **`/api/cloudsearch/pc`（现在用的）** | ✅ 直接给 `al.picUrl` 完整地址 | ✅ `type=1004` 返回真 MV 列表 |

```
搜歌   GET /api/cloudsearch/pc?s=<kw>&type=1&limit=N&offset=M
         -> result.songs[].al.picUrl      ← 完整封面 URL，不用解密
搜 MV  GET /api/cloudsearch/pc?s=<kw>&type=1004&limit=N&offset=M
         -> result.mvs[] = { id, cover, name, artistName, duration, ... }
```

### 顺带修掉的：MV 搜索以前是"搜歌再筛"

原来的做法是搜歌、再 `filter(mvid > 0)`。问题有两个：

1. **拿到的是歌曲条目，没有 MV 封面**（只有专辑封面）
2. **漏 MV** —— 很多 MV 没有对应的单曲条目，搜不出来

改成 `type=1004` 之后，`mvs[].id` **就是 mvId**，可以直接拿去调 `mv/detail` 取播放地址：

```
mvs[0].id = 376199  ->  GET /api/mv/detail?id=376199  ->  code 200，拿到 mp4 直链
```

实测搜「海阔天空」：

| | 旧（搜歌筛 mvid） | 新（type=1004） |
|---|---|---|
| 结果性质 | 歌曲 | **真 MV** |
| 封面 | 专辑封面 | **MV 自己的封面** |
| 时长 | 歌曲时长 | **MV 时长**（5:17 / 5:14 / 5:40） |

### 封面 URL 升到 https

接口给的是 `http://p1.music.126.net/...`，统一改成 `https://` ——
渲染进程从 `file://` 加载，混用 http 容易被拦。

### 界面

在线列表每行左侧加 42×42 圆角缩略图（`object-fit: cover`），
加载失败时 `@error` 把图藏掉，不留一个破图图标。

> 搜歌显示方形专辑封面，搜 MV 显示 16:9 的 MV 帧 —— 都按方形裁切，
> 列表看起来整齐。

## 相关文件

- `packages/ktv-api/src/providers/online-search.js` — `searchNetease` / `searchNeteaseMv` / `httpsUrl`
- `apps/shell/src/main.js` — `online:search` 按 `onlyMv` 分流
- `apps/web/src/components/CatalogBrowser.vue` — 封面缩略图
- `packages/ktv-api/test/online-search-test.js` — 8 项（含封面、MV 专用搜索、直链可用性）
