# 阶段 1：Electron + Vue 骨架

**日期**：2026-09-21
**结论**：✅ 完成。点歌 → 播放 → 原伴唱切换主链路在真实 Electron 窗口中跑通。

## 1. 目标与范围

打通最小可运行的端到端链路，**不依赖任何第三方取流接口**：

```
本地曲库扫描 → 点歌 → libVLC 播放（嵌入原生子窗口）→ 原伴唱切换
```

刻意先做**本地曲库**：这样整条链路可以独立验证，也为后续接入
muse.db / 在线 provider 留出统一的 `Song` 结构。

## 2. 交付物

| 模块 | 路径 | 说明 |
|---|---|---|
| 播放器 FFI | `apps/player/src/vlc-ffi.js` | koffi 绑定 libVLC C API，唯一与 libVLC 耦合的层 |
| 视频承载窗口 | `apps/player/src/win32.js` | WS_CHILD 子窗口，供 libVLC 渲染 |
| 高层播放器 | `apps/player/src/player.js` | 原伴唱策略、状态轮询、事件 |
| Electron 主进程 | `apps/shell/src/main.js` | 窗口、IPC、视频区摆放、状态推送 |
| 曲库扫描 | `apps/shell/src/library.js` | 本地目录扫描 |
| 前端 | `apps/web/` | Vue 3 大屏界面：曲库列表 + 播放控制 + 原伴唱 |

## 3. 关键设计

### 3.1 原伴唱策略自动判定

KTV 片源有两种原伴唱载体，上层 UI 不应关心差异：

| 片源类型 | 判定条件 | 切换手段 |
|---|---|---|
| 音轨型（新式） | 音频轨 ≥ 2 条 | `libvlc_audio_set_track` |
| 声道型（老式） | 音频轨 = 1 条 | `libvlc_audio_set_channel`（左伴唱 / 右原唱） |

`KtvPlayer.resolveStrategy()` 在片源解析出音轨后自动判定，并建立
`原唱/伴唱 → 音轨 id` 映射。音轨命名不规范时用启发式
（`原唱`/`original`/`vocal` vs `伴唱`/`伴奏`/`accompaniment`），
仍不可靠时按"第一条伴唱、第二条原唱"兜底；UI 也提供**手动指定**入口。

### 3.2 视频渲染

libVLC 渲染到主窗口下的 WS_CHILD 子窗口，位置由渲染进程通过
`ResizeObserver` + `getBoundingClientRect()` 上报（CSS 像素），
主进程按显示器 `scaleFactor` 换算成物理像素后 `SetWindowPos`。

取舍见 `00-architecture.md` §6：**HTML 不能叠加在视频上**，控件放在视频区之外。

## 4. 验证结果

三组测试，共 **33 项全部通过**：

```powershell
npm test        # 播放器单测 + Electron 集成冒烟
```

### 4.1 播放器 FFI 冒烟（`apps/player/test/player-smoke.js`）— 10 项

| 检查 | 结果 |
|---|---|
| 创建宿主 HWND | ✅ |
| play() / 起播推进时间轴 | ✅ 261ms |
| 在外部 HWND 上建立视频输出 | ✅ 1280x720 |
| 枚举音轨 | ✅ `[{257,"Track 1 - [English]"},{258,"Track 2 - [Chinese]"}]` |
| 切换音轨并回读一致 | ✅ 257 ↔ 258 |
| 切换声道 L/R/Stereo 并回读一致 | ✅ |
| seek / 音量 | ✅ 15000ms / 60 |
| 切换片源类型并起播 | ✅ |

### 4.2 高层播放器逻辑（`apps/player/test/player-class-test.js`）— 12 项

| 检查 | 结果 |
|---|---|
| VideoSurface 子窗口可作 libVLC 输出目标 | ✅ 1280x720 |
| 双音轨片源 → 自动判定 track 策略 | ✅ `{accompaniment:257, original:258}` |
| 切伴唱 / 切原唱命中对应音轨 | ✅ |
| 单音轨片源 → 自动判定 channel 策略 | ✅ |
| 切伴唱 → 左声道，切原唱 → 右声道 | ✅ Left / Right |

### 4.3 Electron 集成（`apps/shell/src/smoke.js`）— 11 项

真实 Electron 窗口下：

| 检查 | 结果 |
|---|---|
| 视频承载子窗口已创建 | ✅ `hwnd=0x40a0c` |
| 视频区尺寸由界面上报 | ✅ `1002x505 @(14,66)` |
| 扫描本地曲库 | ✅ 2 首 |
| 窗口内起播 + 原生视频区建立输出 | ✅ 1280x720 |
| 识别为音轨型片源 + 切伴唱命中音轨 | ✅ |
| 识别为声道型片源 + 切伴唱/原唱 → 左/右声道 | ✅ |

## 5. 运行方式

```powershell
npm run setup        # 一次性：拉 libVLC + 生成测试片
npm run build:web    # 构建前端（首次或前端改动后）
npm start            # 启动应用
npm run smoke        # 无界面集成冒烟
npm test             # 全量回归
```

开发模式（Vite 热更新）：先 `npm --prefix apps/web run dev`，再 `npm run dev`。

界面快捷键：`空格` 播放/暂停 · `←/→` 快退/快进 5s · `O` 原唱 · `A` 伴唱。

## 6. 踩坑记录（koffi / libVLC）

1. **koffi 不支持结构体自引用**：`libvlc_track_description_t.p_next` 声明成
   `void *`（x64 布局一致），手动跟链。
2. **`char *` 成员会被 koffi 自动解码成 JS 字符串**，不要再 `decode` 一次。
3. **输出参数必须声明 `koffi.out()`**，否则传入的 JS 数组不会回写
   （`libvlc_video_get_size` 一开始返回 0x0 就是这个原因）。
4. **`koffi.out()` 返回对象不能字符串化**，做函数缓存时不能拿参数列表拼 key。
5. **`unsigned` 不是 koffi 类型名**，要用 `uint32`。
6. libVLC 3.0.21 已废弃 `--plugin-path`，改用 `VLC_PLUGIN_PATH` 环境变量。

## 7. 遗留事项

- [ ] 目视确认界面观感与视频区尺寸/DPI 表现（多显示器、125%/150% 缩放）。
- [ ] 播放结束自动切下一首、播放队列（阶段 3）。
- [ ] 变调（Android 端 SoundTrack）方案未定。
- [ ] 视频区无法叠加 HTML，若需画面内进度条要改双窗口方案。
- [ ] 接入真实 KTV 片源复跑，确认音轨/声道布局与预期一致。
