# 阶段 2：复用 muse.db 曲库

**日期**：2026-09-21
**结论**：✅ 完成。曲库安装管线、读取层、HTTP 服务、界面接入全部跑通。
**重要发现**：曲库里的 `cloud_url` **签名已过期（HTTP 403）**，所以曲库只能提供
元数据，不能直接播放 —— 详见 §5。

## 1. 交付物

| 模块 | 路径 | 说明 |
|---|---|---|
| 清单解析 | `services/catalog/src/manifest.js` | manifest 读取 + 结构自检 |
| 安装管线 | `services/catalog/src/install.js` | 分片获取/校验/合并/解压/原子替换 |
| 安装 CLI | `services/catalog/src/cli.js` | `npm run install:catalog` |
| 曲库读取 | `services/catalog/src/db.js` | `node:sqlite` 只读查询 |
| HTTP 服务 | `services/catalog/src/server.js` | 零依赖，仅监听 127.0.0.1 |
| 服务客户端 | `apps/shell/src/catalog.js` | 子进程托管 + 查询封装 |
| 界面 | `apps/web/src/components/CatalogBrowser.vue` | 热歌榜/搜索/歌手/本地文件 |

## 2. 曲库分发格式（复用 maidong 方案）

`database_publish/database/` 里是一个清单加 10 个分片：

```
manifest.json      版本、original_size(解压后)、compressed_size、sha256(整库)、每片 size+md5
muse.db.gz.000 …   按顺序拼接成一个完整 gzip 流
```

安装流程：

```
逐片获取 → 校验 size+md5 → 顺序拼接 → gunzip → 校验 sha256 → 原子替换
```

工程要点：

- **全程流式**：1GB 的库不会整体读进内存
- **每片独立重试 3 次**；任一步失败都清理临时文件，绝不动到现有曲库
- **原子替换**：先把旧库改名为 `.backup`，新库改名到位，成功后再删备份；
  中途失败会把备份改回来
- **安装前查可用空间**：解压后大小 + 最大分片 + 256MB 余量
- **版本一致则跳过**（`--force` 可强制重装）

实测：440MB 分片 → 988MB 库，**8 秒**完成（本地源）。

## 3. 曲库结构

真实数据（版本 `20260717.211050`）：

| 表 | 行数 | 说明 |
|---|---|---|
| `songs` | 670,304 | 曲目元数据（44 列） |
| `singers` | 135,955 | 歌手 |
| `song_singer_relations` | 743,081 | 歌曲↔歌手多对多 |
| `song_langs` | 7 | 语种字典（国语/粤语/闽南语/英语/日语/韩语/其它） |

语种分布：国语 606,532 / 粤语 24,326 / 英语 14,351 / 闽南语 13,900 / 其它 5,249 …

### 两个必须知道的坑

**① `songs.singer_names` 在库里恒为空**
670,304 行里没有一行有值。歌手名必须 JOIN：

```sql
COALESCE(NULLIF(s.singer_names,''),
  (SELECT group_concat(sg.name,'、') FROM song_singer_relations ssr
     INNER JOIN singers sg ON sg.id = ssr.singer_id
    WHERE ssr.song_id = s.id), '') AS singer
```

**② `songs.accomp` 不是布尔值，是"原伴唱声道模式"**

| accomp | 含义 |
|---|---|
| `1` | 左声道 = 伴奏，右声道 = 原唱 |
| `2` | 左声道 = **原唱**，右声道 = **伴奏** |
| `<= 0` | 不做声道切换 |

分布：`accomp=2` 有 650,939 首，`accomp=1` 有 19,364 首。

**这个字段必须从曲库一路传到播放器。** 阶段 1 的实现写死了"左伴唱、右原唱"，
对 97% 的曲目都是反的 —— 会导致"点伴唱出原唱"。已修复：
`apps/player/src/player.js` 的 `channelMapForAccomp()` 按 accomp 计算映射，
并由 `KtvPlayer.load(filePath, { accomp })` 接收。

## 4. 性能

`searchSongs` 用 `LIMIT` 能走索引提前终止，`countSearch` 则要全表扫描：

| 查询 | 耗时 |
|---|---|
| 热歌榜 LIMIT 20 | 1–2 ms |
| 歌名搜索 LIMIT 20 | 2–3 ms |
| 歌手名搜索 LIMIT 20 | ~35 ms |
| `countSearch('爱')`（66k 结果） | **~3.9 s** |

**结论：分页不要用精确总数。** 改为多取一条判断 `hasMore`，
界面显示"加载更多"而不是"共 N 条"。

## 5. ⚠️ 关键发现：曲库里的播放地址已失效

`songs.cloud_url` 有 124,635 条，形如：

```
http://download.origjoy.com/E/ts/0.0/240p/4102967.ts?sign=149a9b...&t=6a59aefe
```

`t` 参数解析出来是 **2026-07-17 04:26:38**，正好是曲库发布时刻 ——
即签名在发布当天就过期了。实测两个域名：

```
GET http://download.origjoy.com/...  -> 403
GET http://txog.ktvsky.com/...       -> 403
```

**所以曲库只提供元数据，不提供可播放地址。** 这也解释了 maidong 的设计：
它每次播放都通过热更新的 JS 去接口**实时取 URL**，数据库里的 `cloud_url`
只是兜底，而且代码里还专门判断过"是不是 demo 地址"。

对阶段 2 的影响：

- ✅ 曲库浏览、搜索、歌手、语种、热歌榜 —— 全部可用
- ❌ 从 `cloud_url` 直接播放 —— 不可用
- 因此**点歌能否播，取决于本地有没有对应的媒体文件**
  （布局沿用 maidong：`<mediaRoot>/<songs.filename>`）

界面上用左侧小圆点标注"本地可播"，避免用户点了才发现没文件。
在线取流属于**阶段 3**。

## 6. 技术选型：为什么用 node:sqlite

| 方案 | 结论 |
|---|---|
| `better-sqlite3` | ❌ 预编译包与 Node 22.12 的 ABI 不匹配，装上但一运行就崩（无 C++ 工具链，无法自行编译） |
| `sql.js`（WASM） | ❌ 要把 1GB 库整个读进内存，不可行 |
| Electron 内置 Node + 原生模块 | ❌ Electron 是 Node 20，无 `node:sqlite`，原生模块需按 Electron ABI 重编译 |
| **`node:sqlite` + 独立 Node 子进程** | ✅ 零依赖、无需编译；Node 22/23 加 `--experimental-sqlite`，24+ 已稳定 |

服务以子进程方式运行，还带来两个额外好处：曲库查询不阻塞 Electron 主进程；
将来手机点歌页可以直接复用这个 HTTP 服务（阶段 4）。

> 打包注意：生产环境需随包带一个 `node.exe`（约 80MB）。客户端已支持
> `KTV_NODE_BIN` 指定路径，并在 Node 24+ 自动去掉 `--experimental-sqlite` 重试。

## 7. 使用方式

```powershell
# 安装曲库（从 maidong 的本地分片目录）
npm run install:catalog -- `
  --manifest <maidong-ktv-dir>\database_publish\database\manifest.json `
  --target resources\catalog

# 单独起曲库服务（调试用）
npm run serve:catalog

# 构建前端并启动
npm run build:web
npm start
```

曲库曲目的媒体文件放在 `resources/catalog/video/cloud-song/<filename>`，
放进去界面上的圆点就会亮起，点歌即可播放。

## 8. 验证结果

`npm test` 共 **71 项**：

| 测试 | 项数 | 结果 |
|---|---|---|
| 播放器 FFI | 10 | ✅ |
| 播放器逻辑（含 accomp 声道映射） | 17 | ✅ |
| 曲库读取 + 性能 | 15 | ✅ |
| 曲库 HTTP 服务 | 12 | ✅ |
| Electron 集成（含曲库服务） | 17 | ✅ |

## 9. 遗留事项

- [ ] 在线取流（阶段 3）—— 目前只有本地文件能播
- [ ] 曲库增量更新（当前是全量替换）
- [ ] 断点续传（maidong 的 README 提到，但其实现是整片重下）
- [ ] 歌词：`songs.lyrics` 字段大多为空，需要单独的歌词来源
- [ ] 打包时随包带 `node.exe`
