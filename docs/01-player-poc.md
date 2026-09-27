# 阶段 0：播放器可行性验证报告

**日期**：2026-09-21
**结论**：✅ 通过。Windows + libVLC 可以完整支撑 KTV 原伴唱切换，Tauri 架构可行。

## 1. 为什么要先做这一步

Android 端 `maidong-ktv` 的原伴唱切换靠的是 IJK（FFmpeg）的两个底层能力
（见 `KtvPlaybackEngine`）：

| Android (IJK) | 用途 | 片源类型 |
|---|---|---|
| `selectAudioTrack(original)` | 在**独立音轨**之间切换 | 新式 KTV TS：原唱/伴唱各一条音轨 |
| `seletcAudioChannel(LEFT/RIGHT)` | 选择**左右声道** | 老式 KTV TS：左声道伴唱、右声道原唱 |

WebView 的 `<video>` 元素两者都做不到。所以"能不能在 Windows 上做 KTV"这个问题，
等价于"有没有一个原生播放器能同时做到这两件事，并且能嵌进应用窗口"。
这一步不通，后面的 UI 工作全是白做。

## 2. 环境

| 项 | 版本/说明 |
|---|---|
| libVLC | 3.0.21 Vetinari (Windows x64 便携版) |
| 获取方式 | `poc/player/fetch-vlc.ps1`（清华/南大/中科大镜像） |
| 测试片 | ffmpeg 生成，见 `poc/player/make-testmedia.ps1` |
| 验证脚本 | Python 3.13 + python-vlc（ctypes 绑定，与 Rust 走的是同一套 C API） |

> 说明：PoC 用 Python 写是为了快。python-vlc 只是 libVLC C API 的薄 ctypes 包装，
> 所以这里验证到的行为可以 1:1 迁移到 Tauri/Rust 侧。

## 3. 测试片设计

用 ffmpeg 合成，两个频点代表两种"声音来源"，这样频谱分析就能判断切换是否真的生效：

- **440Hz = 伴唱**
- **880Hz = 原唱**

| 文件 | 结构 | 模拟 |
|---|---|---|
| `ktv_lr.ts` | H.264 + 1 条立体声音轨（L=440, R=880） | 老式 KTV 左右声道 |
| `ktv_2tracks.ts` | H.264 + 2 条立体声音轨（Track0=440, Track1=880） | 新式 KTV 双音轨 |

均为 MPEG-TS 封装、MP2 音频，贴近真实 KTV 片源。

## 4. 验证一：API 行为（`vlc_poc.py --selftest`）

用 `--vout=dummy --aout=adummy` 无窗口跑，验证 API 层。

| 检查项 | `ktv_2tracks.ts` | `ktv_lr.ts` |
|---|---|---|
| 起播并推进时间轴 | ✅ 421ms | ✅ 420ms |
| 枚举音轨 | ✅ 2 条（`Track 1 - [English]` / `Track 2 - [Chinese]`） | ✅ 1 条 |
| 切换音轨并回读一致 | ✅ 257 ↔ 258 | ✅ 257 |
| 切换声道 L/R/Stereo 并回读一致 | ✅ | ✅ |
| seek 到 15s | ✅ 15000ms | ✅ 15000ms |

## 5. 验证二：音频级端到端（`vlc_ktv_verify.py`）

**这一步才是关键。** 上一步只证明 API 返回 0，不证明声音真的变了。
这里用 libVLC 的 **amem（内存音频输出）回调**在进程内拿到**经过切换之后**的 PCM，
再用 **Goertzel 算法**测量两个频点的能量占比。

两种场景都只播放一次，**在播放中途实时切换**——这正是"唱歌时切原伴唱"的真实用法。

| 场景 | 切换 | 440Hz 占比 | 880Hz 占比 | 判定 |
|---|---|---|---|---|
| A 声道型 | stereo | 0.517 | 0.483 | ✅ 双声道混合 |
| A 声道型 | left | **1.0000** | 0.0000 | ✅ 伴唱完全隔离 |
| A 声道型 | right | 0.0000 | **1.0000** | ✅ 原唱完全隔离 |
| B 音轨型 | Track0 | **1.0000** | 0.0000 | ✅ 伴唱完全隔离 |
| B 音轨型 | Track1 | 0.0000 | **1.0000** | ✅ 原唱完全隔离 |

隔离度 1.0000 意味着目标频点之外的能量低于测量精度，切换是干净的。

## 6. 验证三：窗口嵌入（`vlc_embed_verify.py`）

Tauri 方案的嵌入机制是：Web 层留出视频区 → 取到该区域的 HWND → 交给 libVLC 渲染
→ HTML/CSS 控件叠在上层。本项验证用 ctypes 直接创建 Win32 宿主窗口
（复用系统内置 `Static` 类，无需注册窗口过程），把 HWND 交给 libVLC。

| 检查项 | 结果 |
|---|---|
| 创建宿主 HWND | ✅ `hwnd=0x560928` |
| 建立视频输出 `has_vout()` | ✅ State.Playing |
| 视频尺寸 | ✅ 1280x720 |
| 嵌入后播放并推进时间轴 | ✅ |
| 嵌入状态下仍可切声道 | ✅ channel=3 (left) |

> 隐藏窗口下 D3D vout 仍能建立，说明 `set_hwnd` 路径可用。
> 实际画面呈现需目视确认：`python poc/player/vlc_poc.py --interactive`

## 7. 踩过的坑（供 Rust 侧参考）

1. **`--audiofile-format` 不是 WAV 文件名**。afile 模块要的是采样格式串
   （`u8` / `s16l` / `f32l` / `spdif`），且实测在 3.0.21 上仍被拒；
   最终改用 amem 回调路线，反而更干净。
2. **play 回调里的 `samples` 是采样数据首地址**，不是"平面指针数组"
   （后者是视频格式回调的约定）。按平面指针解引用会读到 `0xFFFF...` 直接崩。
3. **`vlc.AudioPlayCb` 在运行时只是文档桩**（`c_void_p` 子类），不是 CFUNCTYPE。
   必须自己定义：`CFUNCTYPE(None, c_void_p, c_void_p, c_uint, c_int64)`。
   回调对象还要持引用，否则被 GC 回收会导致崩溃。
4. **ctypes 回调里抛异常会被吞掉并持续重试**，造成刷屏。
   回调内必须自己 try/except。
5. `get.videolan.org` 直连返回的是 HTML 跳转页，不是 zip；要用镜像直链。

## 8. 复现方式

```powershell
python -m pip install -r poc/player/requirements.txt
pwsh -File poc/player/fetch-vlc.ps1
pwsh -File poc/player/make-testmedia.ps1
pwsh -File poc/player/verify.ps1        # 三项全跑，失败即非零退出
```

产物：
- `poc/player/selftest-report.json`
- `poc/player/ktv-verify-report.json`
- `poc/player/embed-verify-report.json`

## 9. 遗留事项

- [ ] 用**真实 KTV 片源**（来自实际曲库的 `.ts`）复跑 `--media` 模式，
      确认线上片源的音轨/声道布局与预期一致。
- [ ] 目视确认 `--interactive` 的实际画面与切换体验。
- [ ] 评估变调（Android 端用 SoundTouch）在 libVLC 上的替代方案。
- [ ] 确认 libVLC 的 LGPL 分发义务（随包附许可证与声明）。
