# 14. MV 花屏/黑屏的真正根因：libVLC 解复用器探测失败

> 这份文档**修正**了 `13-mv-blank-zorder.md` 的结论。
> 13 号文把"视频区黑屏"归因于 Chromium 渲染窗口的 z 序，并加了 `HWND_TOP`。
> 那个改动本身没错（视频子窗口确实需要在最上层），**但它不是黑屏的原因**——
> 改完之后画面依旧是花屏/纯黑。真正的根因见下。

## 现象

- 点歌后控制条显示"播放中"、时间轴正常推进、`hasVout=true`、`videoSize=720x480`
- **但视频区只有一片彩色竖条纹，或纯黑**
- 换成软解（`--avcodec-hw=none`）画面依旧坏
- 换成 `--vout=wingdi`（纯 GDI，完全不碰 D3D）画面**一模一样地坏**
- 甚至脱离 Electron、用纯 node + libVLC 直接渲染到一个顶层窗口，也是黑屏

最后一条最关键：**换渲染后端、换宿主进程都改变不了画面**，
说明问题不在渲染层，而在更前面——**解码根本没拿到正确的码流**。

## 定位过程（数据驱动）

### 1. 让 libVLC 把话说出来

播放器默认带 `--quiet`，把 libVLC 自己的报错全吞了。加日志后立刻看到：

```
main debug: looking for demux module matching "any": 55 candidates
ts debug: TS module discarded (lost sync)          <-- 关键
ps warning: this does not look like an MPEG PS stream, continuing anyway
main debug: using demux module "ps"                <-- 关键：选错了解复用器
ps warning: garbage at input from 509, trying to resync...
ps warning: found sync code
（这两行重复几百次）
```

**libVLC 的 TS 解复用器探测失败，回退到了 PS（MPEG Program Stream）解复用器**，
于是把 TS 码流当 PS 解析，不停"重新同步"，自然出不了画面。

### 2. 确认片源文件本身是好的

同一个 `.ts` 文件，用 ffmpeg 抽帧：

```
ffmpeg -i 7789715.ts -frames:v 3 f%02d.png
```

抽出的帧是**完全正常、清晰**的 MV 画面（只有零星 `Packet corrupt` 警告）。
所以文件没坏、也能解码，**是 libVLC 的格式探测方式不兼容**。

### 3. 找出为什么探测失败

数同步字节：

```js
// 找 offset 0..187 里哪个位置满足 buf[o + k*188] === 0x47
best sync offset = 136   score = 254/300
bytes 0..31: 0d1058ee ff886c59 8666be2a c97c3599 ...
bytes 512..527: 474011100042f0250001cff01ff   <-- 0x47 开头，是合法 TS 包头
```

结论：**maidong 的 `.ts` 片源开头带 136 字节非 TS 数据**（两个不同曲目偏移量、
得分完全一致，是系统性的，不是单个文件损坏）。libVLC 的 TS 探测器只看开头几个包，
看到不是 `0x47` 就判定"不是 TS"，直接放弃。

ffmpeg 的探测器扫描范围更宽、容错更强，所以它能认出这是 MPEG-TS。

## 修复

强制指定解复用器。但有两个坑：

### 坑 1：媒体级选项无效

```js
// 试过，无效：libVLC 日志里 demux 仍然是 "any"
libvlc_media_add_option(media, ':demux=ts');
```

实测**媒体级 `:demux=ts` 对 libVLC 不生效**，只有**实例级** `--demux=ts` 才有用。

### 坑 2：实例级选项是全局的

`--demux=ts` 在 `libvlc_new()` 时传入，会作用于该实例的**所有**片源——
用它播 mp4/mkv 会被 TS 解复用器毁掉。

### 最终方案：按片源类型切换实例

`apps/player/src/player.js`：

```js
_recreateInstance(tsMode) {
  // 释放旧的 media / media_player / instance，用带或不带 --demux=ts 的参数重建
  const args = (this._vlcArgs || []).slice();
  if (tsMode) args.push('--demux=ts');
  this.instance = vlc.newInstance(args);
  this.mp = vlc.newMediaPlayer(this.instance);
  if (this.surfaceHwnd) vlc.setHwnd(this.mp, this.surfaceHwnd);
  this._tsMode = tsMode;
}

load(source, opts = {}) {
  this.stop();
  const isTs = isTsSource(source);              // 见下
  if (isTs !== this._tsMode) this._recreateInstance(isTs);
  ...
}
```

- `.ts`（本地文件或在线 URL）→ 带 `--demux=ts` 的实例
- 其它格式 → 普通实例，不受影响
- 切换只在片源类型变化时发生，不增加常规开销

## 验证

修复后同一个文件：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| libVLC 选的 demux | `ps` | `ts` |
| 识别到的音轨数 | 1 | **2**（原唱 + 伴唱，符合预期） |
| 视频区画面 | 彩色竖条纹 / 纯黑 | **正常 MV，含内嵌 KTV 字幕** |

音轨数从 1 变 2 是个很好的旁证：PS 解复用器连音轨都没认全，
难怪"点伴唱"之类的切换在那些曲目上会失灵。

## 教训

1. **`--quiet` 会吞掉定位问题所需的关键信息**。诊断播放问题时先开 `--verbose=2 --file-logging`。
2. **换渲染后端可以快速排除渲染层**。wingdi 和 D3D11 出一样的画面，就该往上游（解复用/解码）找。
3. **"能播"不等于"解码正确"**：`hasVout=true` + 时间轴推进只说明管线在跑，
   不代表画面正确——必须**抓真实屏幕截图**看像素。
4. **第三方片源可能不遵守标准**。maidong 的 `.ts` 有 136 字节前导垃圾，
   对 ffmpeg 无所谓，对 libVLC 是致命的。接入第三方源时要留"探测失败"的兜底。
5. **判定逻辑要抽成纯函数并单测**。这次的 `isTsSource()` 正则一度被误写成
   `/\\.ts(\\?|$)/`（双反斜杠），导致判定恒为 false、修复静默失效、画面照旧花屏，
   而控制台没有任何报错。见 `apps/player/test/ts-source-test.js`。

## 相关文件

- `apps/player/src/player.js` — `isTsSource()` / `_recreateInstance()` / `load()`
- `apps/player/test/ts-source-test.js` — 判定逻辑回归测试
- `apps/shell/test/diag-vout.js` — 可指定 vout / 解码器 / demux 并抓真实屏幕的探针
- `apps/shell/test/diag-hostwin.js` — 脱离 Electron 的纯 libVLC 宿主窗口探针