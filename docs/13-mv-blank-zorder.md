> ⚠️ **结论更正**：本文把 MV 黑屏归因于 z 序，但改完 z 序后画面**依旧花屏/纯黑**。HWND_TOP 这个改动本身是对的（视频子窗口确实要在最上层），但它不是根因。真正的原因见 **[14-mv-black-screen-demux-ts.md](14-mv-black-screen-demux-ts.md)**：maidong 的 .ts 开头带 136 字节非 TS 数据，导致 libVLC 的 TS 探测失败、回退到 PS 解复用器。

# MV 画面空白：根因与修复

**日期**：2026-09-22

## 1. 现象

用户反馈"MV 播放变成空白了"。而在我的测试里：

- 冒烟测试通过（vout 建立、视频尺寸 1280x720）
- 真实场景流畅度测试通过（1.00x，0 停顿）
- 子窗口位置尺寸实测正确

**说明"vout 建立"和"画面可见"是两件事**——之前的验证只覆盖了前者。

## 2. 根因：Chromium 渲染窗口盖在视频子窗口之上

枚举运行中应用的子窗口，z 序（上 → 下）是：

```
Chrome_RenderWidgetHostHWND   1266x763 @ 7,30    ← Chromium 渲染窗口，覆盖整个客户区
Static                         770x525 @ 19,90    ← 我创建的视频承载子窗口
VLC video main                 770x525 @ 19,90
VLC video output               770x433 @ 19,136
```

**Chromium 的渲染窗口在视频子窗口上面**，所以视频被 HTML 页面盖住，
用户看到的就是空白。

### 为什么会这样

`VideoSurface.setBounds()` 里用了 `SWP_NOZORDER`：

```js
SetWindowPos()(this.hwnd, null, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
```

`SWP_NOZORDER` 表示"不改 z 序"。创建子窗口时它确实在最上面，
但 **Chromium 会在重绘/焦点变化时把自己的渲染窗口提到前面**，
于是视频就被压到了下面。

### 修法

```js
// ⚠️ 不能带 SWP_NOZORDER
SetWindowPos()(this.hwnd, HWND_TOP, x, y, w, h, SWP_NOACTIVATE);
```

用 `HWND_TOP` 显式置顶，同时用 `SWP_NOACTIVATE` 避免抢焦点。
`show()` 里也补了一次置顶。

修复后 z 序：

```
Static                         770x525          ← 在最上面 ✅
Chrome_RenderWidgetHostHWND   1266x763
Intermediate D3D Window       1265x763
```

## 3. 教训：验证方式要覆盖"看得见"

之前所有的视频验证都只检查了 `hasVout` 和 `videoSize`——
**这两个都只能证明 libVLC 建了输出，不能证明画面真的显示出来了**。

而且 `PrintWindow` 截不到 D3D 画面，所以我一直没发现。

以后这类"原生窗口叠加"的问题，应该**直接枚举 Win32 子窗口看 z 序和位置**，
而不是靠 Electron 侧的属性推断。

新增 `test/diag-zorder.js` 做这件事。

## 4. MV 的缓存情况

用户问："MV 是不是应该跟歌曲一样缓存到本地？"

**答案是：已经缓存了，而且"歌曲"和"MV"在这个项目里是同一个东西。**

KTV 片源就是一个 MPEG-TS 文件（里面同时有视频和多条音轨），没有单独的"歌曲文件"。
所以：

| 问题 | 现状 |
|---|---|
| MV 会缓存到本地吗 | ✅ 会。播放时后台自动下载到数据目录 |
| 缓存位置 | `<数据目录>/catalog/video/cloud-song/<filename>` |
| 实测 | `7005500.ts` 43.3 MB（「阴天(HD)」的 MV）已在缓存里 |
| 下次播放 | 直接读本地文件，不再走网络 |

### 但有一个不足：是"边播边缓存"，不是"提前缓存"

- **现在**：点了歌才开始下载，边播边下（限速 512KB/s）
- **没有**：队列里排队的歌不会预下载

所以第一次唱某首歌时，仍然完全依赖网络流；缓存是**为下次**服务的。

如果要"点了就提前下载完"，需要加**队列预下载**——这是明确的改进方向。

## 5. 遗留

- 队列预下载（点了歌就在后台下完，而不是边播边下）
- 缓存没有手动"下载/删除"入口
- `PrintWindow` 截不到 D3D 画面，需要另做验证手段（枚举子窗口是一种）
