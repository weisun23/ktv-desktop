# 15. MV「一卡一卡」的真正原因：片源本身损坏

> 这份文档接着 [14](14-mv-black-screen-demux-ts.md) 往下。
> 14 号解决了「**没有画面**」（libVLC 解复用器探测失败），但**画面出来之后还是一卡一卡**。
> 这是两个独立问题：14 号管「能不能出画」，本文管「出画之后顺不顺」。

## 现象

- 画面能出来，歌词、进度条、原伴唱切换都正常
- 但播放明显一顿一顿的，大约每一两秒卡一下

## 定位：先把「卡」量化

卡顿是主观感受，先找可测量的硬指标。`libvlc_media_stats_t` 里有两个关键计数：

- `i_lost_pictures` —— 丢帧数（卡顿的硬证据）
- `i_demux_discontinuity` —— 解复用器遇到的时间戳不连续次数

**但这两个数字一直是 null**。原因在 `vlc-ffi.js`：

```js
const rc = fnEx("libvlc_media_get_stats", ...)(media, out);
if (rc !== 0) return null;      // ← 判反了
```

`libvlc_media_get_stats` 返回的是 **bool（1=成功、0=失败）**，不是错误码。
`rc !== 0` 等于**把成功当失败**，统计永远拿不到，卡顿也就一直没法量化。
改成 `if (!rc) return null` 之后，诊断能力才真正打开。

## 测量结果

用 `apps/player/test/stutter-probe.js`（按时间采样统计，算显示帧率/丢帧率/不连续率），
在同一个播放器、同一份代码下对比：

| 片源 | 显示帧率 | 丢帧 | 解复用不连续 |
|---|---|---|---|
| maidong `7789715.ts`（原始） | **16.9 ~ 20.6 fps** | **5 ~ 15** | **4 ~ 13** |
| 本地生成的干净 MP4 | 25.0 fps | 0 | 0 |
| 本地生成的干净 TS（同 ts 解复用器） | 25.0 fps | 0 | 0 |
| **ffmpeg 重建时间戳后** | **29.7 fps** | **0** | **0** |

时间轴推进率一直是 0.999x，所以**不是解码跟不上、也不是 IO 不够**——
是解复用器每隔一两秒撞上一次时间戳不连续，只能丢帧重新同步。

顺带排除了取流线路：`ls=0` 和 `ls=2` 返回的是**同一个损坏文件**，
`ls=1` 返回的是广告片（`my_ad_video.ts`）。**接口没有干净线路可换。**

## 根因

maidong 的 `.ts` 片源带损坏包。ffmpeg 解它时会报：

```
PES packet size mismatch
Packet corrupt (stream = 0, dts = 144000)
```

而且文件开头还有 136 字节非 TS 数据（14 号文档已记录）。
两者叠加，解复用器只能反复 resync，表现为「一卡一卡」。

## 修复：缓存后自动重建时间戳

`apps/shell/src/repair.js`：

```js
ffmpeg -y -v error -fflags +genpts -i <损坏.ts> -map 0 -c copy -avoid_negative_ts make_zero <输出.ts>
```

- `-c copy` **不解码不重编码**，只重建 PTS/DTS，几乎不耗 CPU（几秒）
- `-map 0` 保留全部流（视频 + 原唱/伴唱两条音轨）
- 修复产物校验通过后才原子替换原文件；失败则保留原文件，绝不让播放更糟

### 怎么判断「要不要修」

**用文件自描述，不需要标记文件**：

- 干净的 TS 首字节一定是同步字节 `0x47`
- 损坏的那个实测首字节是 `0x0d` / `0x62`

```js
function isCleanTs(filePath) { /* 读第 1 字节，判断是否 0x47 */ }
function needsRepair(p) { /* .ts && size >= 188 && !isCleanTs(p) */ }
```

小于一个 TS 包（188 字节）的文件不修——那只是半成品，交给下载器重下。

### 接在哪里

1. **下载完成后**：`downloads.js` 在文件落盘后触发后台修复，不阻塞下载队列
2. **启动时**：`main.js` 调 `repairDir(MEDIA_ROOT)`，把历史上已缓存的损坏片源补修一遍
3. 启动前会 `cleanupRepairTemp()` 清掉上次异常退出留下的中间文件

## 验证

打包版启动日志：

```
[repair] 启动修复：修复 2 个，失败 0 个
```

修复前后（同一批缓存文件）：

| 文件 | 修复前首字节 | 修复后首字节 | 修复后帧率 | 丢帧 | 不连续 |
|---|---|---|---|---|---|
| `7005500.ts` | 0x62 | 0x47 | 29.7 fps | 0 | 0 |
| `7789715.ts` | 0x0d | 0x47 | 29.3 fps | 0 | 0 |

## 顺手修掉的两处无谓开销

排查时还发现两个「每 250ms 一次」的浪费：

1. **`downloads.stats()` 每 250ms 全量扫描缓存目录**（`readdir` + 每文件一次 `statSync`）。
   主进程状态推送每 250ms 调一次 `statusWithSong()`，里面就会调它。
   加了 2 秒 TTL 短缓存，下载完成/淘汰/清空时失效。
2. **`statusWithSong()` 重复调 `state.getQueue()`** 两次并各自 filter/map。改成取一次。

这两处不是卡顿主因（主因是片源），但属于高频路径上的真实浪费。

## 教训

1. **「能播」和「播得顺」是两件事**，要分别建立可测量的指标。
2. **诊断接口本身可能有 bug**：`libvlc_media_get_stats` 的返回值语义（bool vs 错误码）
   判反，导致「拿不到数据」被误当成「没有数据」，白白绕了远路。
3. **对照实验最能定性**：同一播放器 + 干净片源 = 0 丢帧，就锁定了问题在片源而不在代码。
4. **第三方片源要假设它是坏的**：能修就修（本地 remux），修不了要能测出来并告知用户。

## 相关文件

- `apps/shell/src/repair.js` — 修复实现
- `apps/shell/test/repair-test.js` — 判定逻辑回归测试
- `apps/player/test/stutter-probe.js` — 卡顿量化工具（显示帧率/丢帧/不连续）
- `apps/shell/test/diag-ls-quality.js` — 对比不同取流线路的片源质量