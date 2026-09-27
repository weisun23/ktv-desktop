# 21. 队列预下载 / 缓存管理 / 手机控制 / 键盘导航

> 这四项都是"用起来才发现的缺口"，不是新功能，是把已有的东西补完整。

## 1. 队列预下载

**问题**：点歌只是排队，下载要等**轮到它开始播**才启动。
所以"点歌 → 排队 → 轮到 → 边下边播"这条路，在网络稍差时就是实打实的卡顿。

**改法**：点歌后立刻把接下来要唱的几首丢进下载队列。

```js
// main.js
function prefetchQueue() {
  const depth = Number(state.getSettings().prefetchDepth) || 0;   // 默认 3
  if (depth <= 0) return;
  for (const q of state.getQueue().filter((x) => x.status === 'waiting').slice(0, depth)) {
    downloads.enqueue({ id: q.songId, filename: q.filename, name: q.name });
  }
}
```

调用时机：**点歌后 / 删歌后 / 清空后 / 启动时**（队列一变，"接下来要唱的"就变了）。

只预下载 `waiting` 里最前面的 N 首，不整个队列都下 —— 用户可能点完又删，
下太深是白烧带宽和磁盘。

设置项：**设置 → 缓存 → 队列预下载**，可选 关闭 / 下一首 / 接下来 3 首 / 接下来 5 首。

实测：连点 4 首，第 1 首立刻播（缓存完成），后 3 首全部进入 `queued` 状态开始后台下载。

## 2. 缓存管理

**问题**：缓存只有"全部清空"，看不见有哪些、多大、哪首占地方。

**改法**：`DownloadManager.listFiles()` / `removeFile()` + 设置页可展开的列表。

- 列文件名、大小、缓存时间，**最近缓存的排前面**
- 标出正在播放的那首，并**禁止删除**（Windows 上文件被占用，删了也是白报错）
- 删主文件时**连带删掉它的分离伴奏**（`*.accomp.*`），否则白占空间而且下次不会再生成
- 文件名统一走 `path.basename()`，`../evil.ts` 这种越界路径会被剥掉

### 顺手修掉的一个浪费

列表里冒出来 `xxx.accomp.src.wav`（**单个 50MB+**）—— 那是分离过程抽出的中间 wav。

排查后发现**不是泄漏**：当时正好有一轮自动分离在跑（`separationMode: plugin`）。
但仍然做了两件事：

1. `listFiles()` 过滤掉 `.accomp.src.wav` / `.accomp.sep.wav` —— 它们不是"缓存"，不该让用户看到和删
2. `init()` 时扫一遍清掉这些中间文件 —— **启动那一刻不可能有分离在跑**，
   所以此时存在的必然是上次被强杀/断电留下的垃圾

## 3. 手机端点歌页加控制

**问题**：手机上只能点歌，想暂停或切歌还得走到主机前 —— 那手机点歌的意义就少了一半。

**改法**：加 `POST /api/control`，手机页在"正在播放"卡片下面加一排控制。

| 动作 | 说明 |
|---|---|
| `toggle` / `play` / `pause` | 播放暂停 |
| `next` | 切歌 |
| `replay` | 从头重唱 |
| `volume` | 设音量（带值） |

**安全边界**：只放"点了不会出事"的动作。
刻意**不提供**删除文件、改设置、退出应用这类能力 —— 局域网内没有鉴权，
能做的越少越安全。未知动作返回 `{ok:false, error:'未知操作: xxx'}`。

音量滑块是 `change` 事件才发（不是 `input`），避免拖动时刷接口。

实测：切歌 `海阔天空 → 海阔天空(B)(HD)` 且队列从 5 变 4；暂停/播放按钮和状态点同步。

## 4. 遥控器 / 键盘导航

**问题**：KTV 现场常常是遥控器或小键盘，只能上下+确定，而列表只支持鼠标。

**改法**：曲库列表支持

- `↑` / `↓` 移动选中项，自动 `scrollIntoView({block:'nearest'})`
- `Enter` 执行选中项的**默认动作**：歌曲=点歌、歌手=进歌手页、本地文件=播放、在线结果=播放

两个细节：

- **输入框里不拦截**（`e.target instanceof HTMLInputElement` 直接 return），否则搜索时按上下键会跳选
- `App.vue` 的全局快捷键用的是 `←/→`（快进快退），和这里的 `↑/↓` 不冲突

实测：按 3 次 ↓ 选中第 4 项，再按 ↑ 回退一项，Enter 成功入队。

## 相关文件

- `apps/shell/src/main.js` — `prefetchQueue()` / `cache:listFiles` / `lan control`
- `apps/shell/src/downloads.js` — `listFiles` / `removeFile` / `_sweepIntermediates`
- `apps/shell/src/lanserver.js` — `/api/control`
- `apps/shell/src/lan/index.html` — 手机端控制条
- `apps/web/src/components/CatalogBrowser.vue` — `onKey` / `activate`
- `apps/shell/test/downloads-test.js` — 30 项（含缓存管理 10 项）
- `apps/shell/test/lan-test.js` — 26 项（含控制接口 5 项）


## 5. 顺手修掉的两个"和播放抢资源"的问题

做缓存列表时发现目录里躺着 50MB+ 的 `xxx.accomp.src.wav`，顺着查出来两个问题。

### 5.1 AI 分离不降优先级，会饿死播放

demucs 默认跑满所有核心。开着「AI 自动分离」唱歌时，
每首歌开始都会触发一轮分离，表现就是**画面开始卡**。

修法：插件进程降到 **BelowNormal**。

```js
const p = spawn(cmd, argv, { shell: false, windowsHide: true });
try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
```

Windows 上子进程会**继承父进程的优先级**，所以对 `cmd.exe` 设一次，
它拉起的 `python.exe` 也是 BelowNormal。实测确认：

| | 修复前 | 修复后 |
|---|---|---|
| python 进程 PriorityClass | `Normal` | `BelowNormal` |

### 5.2 连续切歌会同时跑多个 demucs

`autoSeparate()` 原来的守卫是"同一首不重复触发"：

```js
if (separatingFor === source) return;
```

但**换一首歌就会再起一个 demucs** —— 两个 demucs 各跑满所有核心。

修法：**串行化**。同一时刻只跑一个；期间来的请求记到 `separatePending`，
当前这轮结束后再看要不要跑 —— 而且**只在它还是当前在播的片源时才跑**：

```js
if (next && next.source === originalSource) autoSeparate(next.source, next.song);
```

用户连按切歌时，前面几首已经不唱了，没必要把它们的伴奏也算一遍（每首好几分钟）。
