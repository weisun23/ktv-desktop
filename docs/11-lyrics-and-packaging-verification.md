# 歌词功能 + 打包形态完整验证

**日期**：2026-09-22

## 1. 打包形态的完整流程验证 ✅

之前只验证到"能启动"，这次把完整链路跑通了。

### 1.1 曲库下载：发现 Gitee 不让匿名下大文件

一键下载曲库直接失败：

```
安装失败: 分片 muse.db.gz.000 获取失败（重试 3 次）: HTTP 403
```

响应体说明了原因：

```
[session-9b46a7b7] large file require login for access.
```

**Gitee 对大文件 raw 下载要求登录**（manifest 这种小文件可以，45MB 的分片不行）。
这也解释了 maidong 的构建配置里为什么有 `GITEE_DATABASE_TOKEN`。

### 1.2 修法：曲库源可配置

新增两个设置：

| 设置 | 说明 |
|---|---|
| `catalogSource` | http(s) 清单地址，**或本地目录**（目录里要有 manifest.json + 分片） |
| `catalogToken` | 走 URL 时的访问令牌（可选） |

设置页的「曲库」分组可以直接填地址、选本地目录、填令牌。

安装管线也支持了自定义请求头（`installCatalog({ headers })`）。

### 1.3 顺带修了一个 CLI bug

```js
manifestSource: path.resolve(args.manifest),   // URL 被当成相对路径拼成本地路径
```

改成 URL 走原样、本地路径才 resolve。

### 1.4 验证结果

用本地分片目录安装到打包数据目录：

```
安装完成：版本 20260717.211050，988.0 MB，用时 6.8s
数据库: <KTV_DATA_DIR>\catalog\muse.db
```

打包后的应用启动后：

| 项 | 结果 |
|---|---|
| 曲库服务用打包的 node.exe 启动 | ✅ |
| 曲库加载 | ✅ 670,304 首 · 135,952 位歌手 |
| 取流服务识别 | ✅ 取流：maidong |
| 数据落在非系统盘 | ✅ `<KTV_DATA_DIR>` |
| 界面无错误框 | ✅ |

## 2. 排查中发现的两个真 bug

### 2.1 `providers:status` 这个 IPC handler 被误删了

界面上一直显示"未配置取流服务"，但配置文件和加载逻辑都正确。

排查过程：
1. 确认配置文件在正确位置（写启动诊断文件）→ 路径全对
2. 确认 `availableProviders` 返回 `['maidong']` → 逻辑对
3. 确认打包的前端产物包含正确代码 → 对
4. **列出所有 `ipcMain.handle`，发现 `providers:status` 根本不存在**

是我之前用脚本改 `main.js` 时，一次 `slice` 替换把这段删掉了。
而界面调用失败会被 `try/catch` 静默吞掉，表现成"未配置"——**静默失败最难查**。

### 2.2 环境变量设得太晚

`ktv-api` 的 `CONFIG_DIR` 是**模块加载时**就算出来的：

```js
const CONFIG_DIR = process.env.KTV_CONFIG_DIR || path.join(REPO_ROOT, 'resources', 'config');
```

而我把 `process.env.KTV_CONFIG_DIR = ...` 放在 `app.whenReady()` 里——**太晚了**，
模块早就加载完，退回开发态路径了。

改成在所有 require 之前设置。

### 2.3 加了防回归测试

`test/ipc-channels-test.js`：把「preload 暴露的通道」和「主进程注册的 handler」对一遍，
缺一个就报错。跑起来立刻又抓出 `player:ended` 是个**死通道**（主进程在推、没人监听），
已清掉。

## 3. 歌词功能

### 3.1 来源

网易云公开接口（与 karaoke-companion 的 LyricService 同源，MIT 授权）：

```
搜索: GET https://music.163.com/api/search/get/web?s=<歌名+歌手>&type=1&limit=5
歌词: GET https://music.163.com/api/song/lyric?id=<id>&lv=1&kv=1&tv=-1
```

实测可用，返回标准 LRC。

### 3.2 实现

| 层 | 文件 | 职责 |
|---|---|---|
| 服务 | `apps/shell/src/lyrics.js` | 搜索 + 取词 + 按曲目 id 缓存到 `<dataRoot>/lyrics/` |
| 界面 | `apps/web/src/components/LyricsBar.vue` | 解析 LRC、跟随播放时间高亮当前行、预览下一行 |

细节：

- **歌名要清洗**：曲库里的名字带 `(HD)`、`(DJ版)` 等修饰，直接搜命中率低，
  会先去掉这些再搜。
- **歌手要取第一个**：曲库的歌手字段可能是 `莫文蔚、李宗盛`，搜索只取第一个。
- **优先匹配歌手**：搜索结果里优先挑歌手名对得上的，否则取第一条。
- **按曲目 id 缓存**：同一首不再请求网络；并发请求会去重。

### 3.3 位置

放在**画面下方、控制条上方**——因为 libVLC 渲染在原生子窗口里，
HTML 无法叠在画面上，所以歌词也不能做成画面内的字幕。

## 4. 验证

`npm test` 共 **186 项**：

| 测试 | 项数 | 变化 |
|---|---|---|
| **IPC 通道完整性** | **3** | 新增（防 `providers:status` 那类静默失败） |
| **歌词** | **7** | 新增（含真实联网取词、缓存命中、错误路径） |
| 其余 | 176 | — |

## 5. 遗留

- **播放本身还没在打包形态下点过**——曲库、取流、界面都验证了，
  但"点一首歌真的播出来"需要人工点一下（自动化点不了原生窗口上的界面）。
- 歌词只有逐行高亮，没有做**逐字**高亮（karaoke-companion 有逐字，可以再移植）。
- 歌词搜索命中率依赖歌名清洗规则，冷门歌可能搜不到。
- 曲库源的**令牌**需要用户自己申请（Gitee 大文件下载要求登录）。
