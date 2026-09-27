# 16. MV 卡顿的最终定位：片源周期性损坏 + libVLC 的两难

> 这份文档是 [15](15-mv-stutter-source-repair.md) 的续集，也是**推翻 15 号部分结论**的一篇。
> 15 号认为「修复 = 用 ffmpeg 重建时间戳」，但实测重建之后**声音会在 ~100 秒后彻底消失**。
> 本文用可复现的数据把这个矛盾彻底讲清楚。

## 一句话结论

maidong 分发的 `.ts` 片源里，**每隔约 524KB 就有 43~44 个 TS 包被整体破坏**（全文件 87 处）。
这批坏包同时波及视频和音频，导致 libVLC 陷入两难：

- **默认（`ts-cc-check` 开）**：libVLC 按连续性计数器检测到丢包 → 丢弃受影响的 PES → 音频完好，但视频只剩 ~15fps
- **关掉连续性检查（`--no-ts-cc-check`）**：视频恢复到 29.5fps，但**截断的音频 PES 被喂给 mpg123** → 解码器报错 → 音频在 ~100 秒彻底停摆

两条路都不可接受。**根因在 libVLC 的 TS 处理策略，不在我们的代码。**

## 1. 先把「卡」变成数字

`apps/player/test/stutter-probe.js` 读 `libvlc_media_stats_t`：

| 片源 | 显示帧率 | 丢帧 | 解复用不连续 |
|---|---|---|---|
| maidong 原始 `.ts` | **15.0 fps** | 少 | 多 |
| 同一个文件经 ffmpeg `-c copy` 重封装 | **29.5 fps** | 0 | 0 |
| 本地生成的干净 TS（240s） | 25.0 fps | 0 | 0 |

时间轴推进率始终 0.999x —— 不是解码慢、不是磁盘慢，是**解复用阶段在丢帧**。

## 2. 片源到底坏在哪

写了个 TS 解析器逐包扫描（`apps/shell/test/tmp-*.js` 系列，见「诊断脚本」），
从第一个 `0x47` 开始按 188 字节步进：

```
有效包 237754   垃圾段 87   垃圾总字节 712332
垃圾段长度分布：8272B×49   8084B×37   7896B×1
位置分布：0-10% 9 处，10-20% 9 处 …… 90-100% 9 处   ← 均匀分布
段间距：约 524332 字节，非常规律
```

坏段里的字节是**随机数据**（把首字节强行当 `0x47` 解析，PID 全是随机值），
说明不是「同步字节被翻了一位」这种可修复的损坏，**内容本身已经没了**。

同时确认：

- 文件开头有 **512 字节**非 TS 数据（15 号文档记的 136 字节不准）
- 去掉这 512 字节后，文件长度正好是 188 的整数倍
- 坏段占 3789 个包，**音频和视频的连续性计数器都会跳**（日志里 `pid=256/257/258` 都有 `discontinuity received`）

## 3. 用 libVLC 自己的日志定性

打开 libVLC 的 `--file-logging`（`--verbose=2`），对比同一文件在不同条件下的日志：

| 条件 | `lost synchro` | `discontinuity received` | `too late to be displayed` | `buffer too late` | 结果 |
|---|---|---|---|---|---|
| 原始 + 默认 | 17 | 41 | 12 | 0 | 视频 15fps，音频正常 |
| ffmpeg 重封装 + 默认 | 0 | 0 | 0 | 780 | 视频 29.5fps，**音频 100s 后死** |
| 坏包换空包 + 默认 | 0 | 200 | 63 | 0 | 视频 15fps，音频正常 |
| 坏包换空包 + `--no-ts-cc-check` | 0 | 0 | 0 | 780 | 视频 29.5fps，**音频 100s 后死** |

关键那行日志：

```
main warning: buffer too late (-493226 us): dropped
main debug: playback too late (58033): flushing buffers
wasapi debug: reset
```

音频输出进入 **「太晚 → flush → WASAPI reset」的循环**，一路丢掉所有缓冲区，声音彻底消失。

## 4. 排除了哪些可能

这些都是**实测排除**的，不是推测：

| 假设 | 实验 | 结论 |
|---|---|---|
| 视频解码拖累音频 | `--no-video` 只放音频 | **仍死在 100s** → 与视频无关 |
| 容器格式（TS vs MKV） | 重封装成 MKV | 仍死（还更早，70s） |
| 音频编码/采样率 | 重编码 mp2→mp2 48k、mp2→aac | 仍死 |
| scaletempo 时间伸缩 | `--no-audio-time-stretch` | 仍死 |
| 音频设备/驱动 | `--aout=directsound` | **丢块数字一模一样** → 与设备无关 |
| 音频偏移补偿 | `--audio-desync=-400` | 仍死 |
| 音频数据本身损坏 | 抽出 mp2 基本流比对 | 原始与重封装**字节完全相同**（同一 SHA256），且 ffmpeg 全量解码只报 8 处错误（都在文件头） |
| 机器/声卡系统性缺陷 | 本地生成干净 240s TS | **150 秒零丢块** → 不是机器问题 |

## 5. 为什么 ffmpeg 重封装救不了

`-c copy` 重封装确实把连续性计数器重新编号了（`discontinuity` 归零），
但**坏段里被截断的 PES 仍然以「半截」的形态留在文件里**：
一个 PES 的前半段是好的、后半段在坏段里。

- libVLC 开着 `ts-cc-check` 时，靠连续性跳变**识别并丢弃**这些半截 PES
- 一旦连续性被修好（或检查被关掉），半截 PES 就会**直接喂给 mpg123**
- mpg123 报 `missing bits in layer II step two`，音频管线崩掉

**所以「修好连续性」和「丢掉半截 PES」这两件事是互相矛盾的** —— 只要还用 libVLC，就绕不开。

## 6. 对照：换成 ffmpeg 系内核立刻正常

Android 端用的是 IJK（ffmpeg 系）。用 mpv（同样 ffmpeg 系）播**同一份原始文件**：

```
T=44.277578 VFPS=29.126214 DROP=0
...
Exiting... (End of file)
```

- **29.1 fps，丢帧 0**
- ffmpeg 的 TS 解复用器自己会处理坏包，不需要外部干预
- 音频走 ffmpeg 的 mp2 解码器，不会像 mpg123 那样被半截 PES 打死

这也解释了用户最开始的疑问：**「为什么官方安卓版很流畅」——因为它用的是 ffmpeg 系解复用/解码。**

## 7. 马赛克从哪来

坏段里的视频数据是**真的没了**（87 处 × 约 44 包）。ffmpeg 解码时只能靠
`reference picture missing` 做错误掩盖，掩盖出来的就是马赛克。

```
[h264] reference picture missing during reorder
[h264] Missing reference picture, default is 65964
[h264] error while decoding MB 28 1, bytestream 1675
```

**这不是我们播放器的问题，也不是软解/硬解能解决的** —— 数据不在文件里。
用 ffmpeg 系内核播，马赛克会**比 libVLC 少**（ffmpeg 的错误掩盖更好），但不会消失。

## 8. 落地方案

| 方案 | 视频 | 音频 | 代价 |
|---|---|---|---|
| 保持现状（`repairMode: off`，原始文件 + libVLC） | 15fps | 完好 | 画面卡 |
| ffmpeg 重封装 + libVLC | 29.5fps | **100s 后没了** | 不可用 |
| **换 mpv 内核** | 29.1fps，丢帧 0 | 完好 | 播放层要重写 |

结论：**MV 播放要真正流畅，必须把播放内核从 libVLC 换成 mpv（ffmpeg 系）**。
这是一次播放层重写，但接口是现成的（`load/play/pause/seek/setVolume/setTrack/setChannelMapping`），
上层业务（队列、缓存、歌词、分离）不用动。

在此之前：

- **音频分离（MV 伴奏）是当前推荐路径** —— 分离产物由 ffmpeg 写、只留一条音轨，绕开了双音轨的坑
- `repairMode` 保持 `off`，不要开 —— 15 号文档的「重建时间戳」会让声音消失

## 诊断脚本

| 脚本 | 作用 |
|---|---|
| `apps/player/test/stutter-probe.js` | 显示帧率 / 丢帧 / 解复用不连续 |
| `apps/shell/test/tmp-logprobe2.js` | 带 libVLC 文件日志的播放探针（可传 VLC 参数） |
| `apps/shell/test/tmp-probe-aout.js` | 5 秒粒度看音频是否开始丢块 |
| `.tmp-diag/scan-junk2.js` | 扫描 TS 里的坏段位置/长度 |
| `.tmp-diag/pts-diff.js` | 逐 PID 比对两个文件的 PTS 序列 |
| `.tmp-diag/nullpatch.js` | 把坏段原地换成空包（保持字节对齐） |
| `.tmp-diag/fetch-orig.js` | 重新拉一份原始片源做对照 |

---

# 附录：落地 —— mpv 内核接入与踩到的坑

## 实现

新增 `apps/player/src/mpv-player.js`，对外暴露与 `KtvPlayer` **完全一致**的接口
（`load/play/pause/seek/setVolume/setTrack/setChannelMapping/setVocalMode/setVideoText/getStatus`），
上层业务（队列、缓存、歌词、原伴唱、全屏、双击）一行没改。

```
apps/player/src/
├── mpv-player.js   mpv 内核（JSON IPC + 命名管道）
├── player.js       libVLC 内核（保留作回退）
├── vocal.js        两个内核共用的纯函数（原伴唱映射、TS 判定）
└── index.js        createPlayer()：按设置挑内核，mpv 缺失时自动回退 libVLC
```

设置项 `playbackCore`：`mpv`（默认）/ `libvlc`，可在设置页「视频 → 播放内核」切换。

### 关键参数映射

| 能力 | libVLC | mpv |
|---|---|---|
| 视频嵌入 | `libvlc_media_player_set_hwnd` | `--wid=<hwnd>` |
| 切音轨 | `libvlc_audio_set_track` | `set_property aid` |
| 切声道 | `libvlc_audio_set_channel` | `af set lavfi=[pan=stereo\|c0=c0\|c1=c0]` |
| 画面内文字 | marquee | `set_property osd-msg1` + 超长 `osd-duration` |
| 软解 | 媒体级 `:avcodec-hw=none` | `--hwdec=no` |

> `af` 属性不能直接 `set_property`（报 `unsupported format`），必须用 `af set` 命令；
> 滤镜串要带 `lavfi=[...]` 前缀，否则 `error running command`。
> 「立体声」不用 `af clr`（同样报 `invalid parameter`），改成设等值 pan
> `pan=stereo|c0=c0|c1=c1` 更稳。

## ⚠️ 踩到的坑：mpv 会因为管道写满而整个冻住

**症状**：应用里播到 **114~125 秒**（时间不固定）画面和声音一起冻死，
`mpv` 进程还在、但 CPU 几乎不涨，IPC 也收不到任何属性更新。

**根因**：mpv 默认把终端状态行写到 **stdout/stderr**。我们用 `spawn` 起了它，
管道缓冲（Windows 约 64KB）写满之后，**mpv 会阻塞在写管道上**，
整个播放线程跟着停住。

**证据**：

| 条件 | 结果 |
|---|---|
| 同参数，不读管道 | 125.6s 冻住 |
| 同参数 + `--terminal=no` | **160s 连续正常，stdout/stderr 都是 0 字节** |

**修法**：启动参数加 `--terminal=no`，并且 **stdout/stderr 都要排空**
（只排一个不够）。需要日志时用 `KTV_MPV_LOG=<path>` 打开 mpv 自己的日志文件
（mpv 自己写盘，不走管道）。

这个坑和 libVLC 那条完全无关，是「子进程 + 管道」的经典问题：
**凡是 `spawn` 出来的进程，两个输出管道都必须消费，或者干脆让它别输出。**

## 实测结果（应用内，完整一首歌）

```
阴天(HD) / 7005500.ts，时长 239s，原始（未修复）片源
t=21s   Playing  帧=555   丢帧=0
...
t=118s  Playing  帧=3471  丢帧=0     ← libVLC 在这附近就没声了
...
t=235s  Playing  帧=7029  丢帧=0
t=239s  Ended    帧=7156  丢帧=0     ← 完整播完
```

平均 ~29.5fps（源本身就是 29.97fps），**全程丢帧 0**。

## 仍未解决：马赛克

坏段里的视频数据是真的没了，ffmpeg 只能做错误掩盖。
mpv 的掩盖质量比 libVLC 好（同帧对比明显更少块），但**不会消失**。

想要彻底没有马赛克，只有两条路：

1. 让上游换干净的片源
2. 分离伴奏后**不再播原 MV**，只播分离产物（分离产物由 ffmpeg 重写，坏段已经被剔除）

第 2 条正是「MV 伴奏分离」这条路线的价值所在。

---

# 附录 2：`repairMode: 'off'` 从来没生效过（2026-09 发现）

> 这是排查"缓存列表里多出 50MB 的 .src.wav"时顺带撞见的，但它的影响比那个大得多。

## 现象

设置页上「片源修复」明明选的是**不修**，但每次启动日志都会打印：

```
[repair] 启动修复：修复 4 个，失败 0 个
```

## 根因

`apps/shell/src/repair.js`：

```js
const MODES = ['remux', 'transcode'];
function normMode(m) { return MODES.includes(m) ? m : 'remux'; }
```

`'off'` **不在 `MODES` 里**，于是被当成"非法值"兜底成了 `'remux'`。
设置页上写着"不修"，实际每次启动都在把损坏的 `.ts` 重封装一遍。

## 影响

- 用户选了"不修"，文件还是被改写（磁盘写入 + 首字节被改）
- 早期用 libVLC 内核时，"重封装会让音频在 ~100 秒后停摆"是实测结论 ——
  也就是说**用户以为在播原始文件，其实播的是被偷偷重封装过的版本**
- 排查 MV 卡顿时用到的对照文件是手工重新下载的原始片源，所以
  [docs/16](16-mv-stutter-root-cause.md) 的结论不受影响；但**应用内的实际行为**
  和文档描述是两回事

## 修法

```js
function normMode(m) {
  if (m === 'off') return 'off';
  return MODES.includes(m) ? m : 'off';   // 非法/缺省一律当 off
}
// needsRepair 里再加一道：if (m === 'off') return false;
```

**非法值一律当 `off`**，而不是兜底成 `remux`：
修复是"会改变片源"的操作，遇到不认识的值应该**宁可不动**。

## 为什么一直没被发现

单元测试里有这一条：

```js
check('损坏的 .ts 需要修复', () => assert.strictEqual(needsRepair(dirtyTs), true));
```

它**断言的是缺省模式 = remux**，也就是把这个 bug 当成正确行为固化下来了。
现在改成显式传模式，并补了三条回归：

- `normMode('off') === 'off'`
- 非法/缺省模式一律当 off
- `needsRepair(dirty, 'off') === false` 但 `needsRepair(dirty, 'remux') === true`

## 教训

**"兜底值"要选安全的那一侧。** 一个 `|| 'remux'` 让用户明确表达的"不要动"
被静默反转了两年都没人发现 —— 因为界面、文档、日志各自看起来都很正常。
