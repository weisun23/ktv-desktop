# services/catalog

曲库服务：`muse.db` 的安装、读取与 HTTP 查询。

## 为什么是独立子进程

Electron 内置 Node 20，没有 `node:sqlite`；`better-sqlite3` 这类原生模块需要按
Electron ABI 重编译，而本机没有 C++ 工具链。所以曲库跑在独立 Node 进程里：
既能用上内置 SQLite，查询也不阻塞 Electron 主进程，将来手机点歌页还能直接复用。

| 文件 | 职责 |
|---|---|
| `src/manifest.js` | 清单读取与结构自检 |
| `src/install.js` | 分片获取/校验/合并/解压/原子替换 |
| `src/cli.js` | 安装命令行 |
| `src/db.js` | `node:sqlite` 只读查询 |
| `src/server.js` | HTTP 服务（仅监听 127.0.0.1） |

## 安装曲库

```powershell
npm --prefix services/catalog run install:db -- `
  --manifest <maidong-ktv-dir>\database_publish\database\manifest.json `
  --target resources\catalog
```

分片源支持 http(s) URL、`file://` 与本地路径；清单里的相对分片名会相对清单位置解析。

## 起服务

```powershell
npm --prefix services/catalog run serve
```

启动后会向 stdout 打印 `KTV_CATALOG_READY {"port":N,...}`，父进程据此判断就绪。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活检查 |
| GET | `/stats` | 曲目/歌手/带 cloud_url 的数量 |
| GET | `/languages` | 语种字典 |
| GET | `/songs/hot?lang=&limit=&offset=` | 热歌榜 |
| GET | `/songs/search?q=&lang=&limit=&offset=` | 搜索（歌名/拼音首字母/歌手名） |
| GET | `/songs/:id` | 单曲详情 |
| GET | `/singers?q=&area=&type=&limit=&offset=` | 歌手检索 |
| GET | `/singers/areas` | 地区/类型字典 |
| GET | `/singers/:id/songs` | 某歌手的曲目 |

## 两个必须知道的坑

1. `songs.singer_names` 在库里恒为空，歌手名必须 JOIN `song_singer_relations`。
2. `songs.accomp` 是原伴唱**声道模式**（1=左伴奏/右原唱，2=左原唱/右伴奏），
   不是布尔值；声道映射由播放器解释，见 `apps/player/src/player.js`。

另外：`cloud_url` 里的签名已过期（403），曲库只提供元数据，不提供可播放地址。
详见 `docs/03-phase2-catalog.md`。

## 测试

```powershell
npm test              # 读取层 + 性能
npm run test:server   # HTTP 服务
```

需要 Node 22/23（带 `--experimental-sqlite`）或 Node 24+。
