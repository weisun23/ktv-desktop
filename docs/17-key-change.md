# 17. 变调（升降调）

> Android 端用 SoundTouch 做变调，Windows 侧一直没定方案。这篇是定案。

## 结论

**用 mpv 的 `rubberband` 滤镜，半音为步长，范围 ±6。**

```js
// apps/player/src/mpv-player.js
setPitch(semitones)          // -6 ~ +6，0 = 原调
_applyAudioFilters()         // pan（声道隔离）和 rubberband（变调）合成一条 lavfi 链
```

发出的 mpv 命令：

```
af set lavfi=[pan=stereo|c0=c0|c1=c0,rubberband=pitch=1.122462]
```

`pitch` 是**频率比**，不是半音：`ratio = 2^(semitones/12)`，+2 半音 = 1.122462。

## 为什么是 rubberband

| 方案 | 时长 | 音质 | 结论 |
|---|---|---|---|
| `rubberband=pitch=` | **不变** | 共振峰跟着走，人声自然 | ✅ 采用 |
| `asetrate=X,atempo=1/X` | 不变 | 重采样搬共振峰，大跨度像"花栗鼠" | ❌ |
| `--speed` / scaletempo | **变了** | 变速不变调 | ❌ 不是变调 |

mpv 的官方 Windows 构建是带 `-Drubberband=enabled` 编的（日志里能看到 Configuration 行），
所以不需要额外装东西。

## 验证：频谱实测，不是"看接口返回成功"

用 440Hz 纯音过一遍 mpv，把 PCM 输出落到文件，再用 Goertzel 扫 200~1500Hz 找主频：

| 设置 | 期望 | 实测 |
|---|---|---|
| 原调 | 440 Hz | **440 Hz** |
| +7 半音（ratio 1.4983） | 659 Hz | **660 Hz** |
| −5 半音（ratio 0.7492） | 330 Hz | **331 Hz** |

三次输出都是 **2 秒**，证明是"改音高"而不是"改速度"。

## 两个必须注意的点

### 1. `af set` 是整体替换，不是叠加

声道隔离（`pan`）和变调（`rubberband`）都想往 `af` 上挂，谁后挂谁把前一个顶掉。
所以**必须合成一条 graph**，并且在"切原伴唱"和"改变调"时一起重建。

### 2. ± 按钮要走相对增量

界面上的 `♯+` 如果自己算"当前值 + 1"，**连点两下只会加 1** ——
状态是 250ms 轮询推过去的，第二次点击读到的是同一个过期值。

所以走 `player:setPitchDelta`（和 `seekRelative` 一个思路），由主进程按权威状态算：

```
实测：连点两下 ♯+  ->  pitch = 2   （修复前是 1）
```

## 界面

控制条右侧：`♭ | 原调 | ♯`，点中间的数值还原原调。

快捷键：`[` 降半音、`]` 升半音、`\` 还原。

**响应式优先级**：

> ⚠️ 这里原来写的是「变调比音量常用得多，所以先砍快进快退和音量」。
> **实测这个判断是错的** —— 用户的第一反应就是「声音控制、快进快退都缺失了」。
> 现在改成：**音量、跳 5 秒任何宽度都保留**（只把形态压小），
> 变窄时依次砍 立体声 → 变调 → 全屏（这三个都有快捷键或替代入口）。

> ⚠️ 阈值要按 `ResizeObserver` 的 `contentRect`（**不含 padding**，比外框小 28px）来定，
> 否则 770px 的外框会被判成更窄的一档，变调控件直接不显示。

## libVLC 内核不支持

libVLC 3 没有变调滤波器（只有 scaletempo 变速）。所以：

```js
KtvPlayer.supportsPitch()  // false
MpvPlayer.supportsPitch()  // true
```

界面按 `status.pitchSupported` 决定显不显示变调控件；真去调用会返回
`{ ok:false, reason:'core-not-support' }`，界面提示"请把播放内核改成 mpv"。

## 相关文件

- `apps/player/src/mpv-player.js` — `setPitch` / `_applyAudioFilters` / `pitchRatio`
- `apps/player/test/mpv-player-test.js` — 频率比、范围夹取、滤镜链合成（6 项）
- `apps/web/src/components/PlayerControls.vue` — 控件与响应式分级
