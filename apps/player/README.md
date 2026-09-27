# apps/player

libVLC 播放器封装。**唯一与 libVLC 耦合的层**，换壳只需重写这一层。

| 文件 | 职责 |
|---|---|
| `src/vlc-ffi.js` | koffi 绑定 libVLC C API（实例/媒体/播放器/音轨/声道/音量） |
| `src/win32.js` | `VideoSurface`：WS_CHILD 子窗口，供 libVLC 渲染 |
| `src/player.js` | `KtvPlayer`：原伴唱策略自动判定、状态轮询、事件 |

## 原伴唱策略

| 片源类型 | 判定 | 切换手段 |
|---|---|---|
| 音轨型（新式） | 音频轨 ≥ 2 | `libvlc_audio_set_track` |
| 声道型（老式） | 音频轨 = 1 | `libvlc_audio_set_channel`（左伴唱/右原唱） |

对应 Android 端 `KtvPlaybackEngine` 的 `selectAudioTrack` / `seletcAudioChannel`，
但为**独立实现**（净室复刻，见 `docs/00-architecture.md` §4）。

## 测试

```powershell
node test/player-smoke.js        # FFI 冒烟（10 项）
node test/player-class-test.js   # 高层逻辑（12 项）
```
