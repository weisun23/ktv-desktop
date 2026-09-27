# 阶段 3：在线取流

**日期**：2026-09-21
**结论**：✅ 完成。曲库点歌 → 实时取地址 → libVLC 在线播放 → 原伴唱切换 → **断流自动恢复**，全链路跑通。

## 1. 上游调研结论

| 检查项 | 结果 |
|---|---|
| GitHub 镜像 `coolwuzizai/maidong-ktv` | ❌ **已停更**，最后推送 2026-07-16（比本地副本的曲库还早一天） |
| Gitee 上游 `yangyachao-X/maidong-ktv` | ✅ 仍在维护，但 `ktv_api.js` 与 `database_publish/manifest.json` **与本地副本逐字节一致** |
| 曲库版本 | `20260717.211050`（与本地相同，无更新版本） |
| 接口基础设施 | ✅ 存活（`gz.ac16.vip` 200、`mws.cherryonline.cn` 有响应） |

**所以"最新的库"并没有更新**——曲库停留在 2026-07-17，取流脚本也没变。
但**接口本身是活的**，这才是关键。

## 2. 实测：接口可用性

按 `ktv_api.js` 的协议做了一次最小探测（临时脚本，不入库）：

```
1. 取 token:   GET {host}/i.php
     appid, mac, sn, time, ver, vn  +  sign = md5(params + appKey)
   -> {"code":200,"token":"NjI1YjUy...","end_date":"2026-10-05 14:58:21","msg":"ok"}

2. 取播放地址: GET {host}/music/do.php
     appid, device, ish265, ls, musicno, resolution, sn, time, token
     +  sign = md5(params + sdkKey)
   -> {"code":200,"data":"http://download.origjoy.com/E/ts/35.2/crf/.../7789715.ts?sign=...&t=6ab150ae"}

3. HEAD 该地址 -> 200, content-length=36265524, content-type=video/MP2T
```

三个重要发现：

**① 地址有效期约 1 小时**
URL 里的 `t=6ab150ae` 解析为 `2026-09-21T15:43:42Z`，而请求时刻是 14:43 ——
**签发后仅 1 小时有效**。这印证了 maidong"每次播放实时取地址、绝不缓存"的设计。

**② 片源是标准双音轨 KTV TS**
对下载的 12MB 采样做 ffprobe：

```
0,h264,video
1,mp2,audio,2,stereo
2,mp2,audio,2,stereo     <- 两条独立音轨
```

两条音轨的音频指纹不同 → 确认是**独立的原唱/伴唱轨**。
也就是说在线片源是"音轨型"，正好走阶段 1 已经实现的 `audio_set_track` 路径。

**③ 服务端有脏输出**
`/music/do.php` 会在 JSON 前打印 PHP 废弃警告：

```
<br /><b>Deprecated</b>: Optional parameter $device declared before required parameter ...<br />
{"msg":"SUCCESS","data":"...","code":200}
```

所以解析必须容错（`parseLooseJson` 会在纯 JSON 解析失败时截取 `{...}` 再试）。

**④ 多节点 / 多 ls 回退是必需的**
`mm.kk456.top` 是代理，`(musicno + ls + device)` 的哈希决定路由到哪个上游节点，
**部分节点只返回 demo 地址**。所以实现里对 `host × ls` 组合逐个尝试并校验结果。

## 3. 实现

| 模块 | 路径 | 说明 |
|---|---|---|
| 协议客户端 | `packages/ktv-api/src/providers/maidong.js` | token / 取地址 / demo 检测 / 过期检测 |
| 配置 | `packages/ktv-api/src/config.js` | 凭证只从本地文件读，不写死在代码里 |
| 入口 | `packages/ktv-api/src/index.js` | `resolvePlayUrl(song)`，支持多 provider |
| 播放器 | `apps/player/src/vlc-ffi.js` | 新增 `libvlc_media_new_location` 支持播 URL |
| 点歌流程 | `apps/shell/src/main.js` | 本地文件 → 在线取流 → 可读错误 |

### 凭证为什么不内置

`maidong` 的 `APP_ID` / `APP_KEY` / `SDK_KEY` 属于**第三方 KTV 服务**。
这是**授权问题**，不是版权问题（见 `docs/00-architecture.md` §4）。
所以本项目：

- 代码里**不含任何凭证**
- 凭证只从 `resources/config/providers.json` 读取，**该文件被 .gitignore 排除**
- 首次启动会落一份空模板，字段齐全但没有值

> 本机为了验证功能，已把 maidong 公开仓库里内嵌的值写进该本地配置。
> 这份配置不会入库。**是否可用于分发请自行确认授权。**

### 点歌解析优先级

```
1. 本地已有文件  resources/catalog/video/cloud-song/<filename>   （快，无网络依赖）
2. 在线取流      实时取地址，约 1 小时有效
3. 都不可用      返回可读原因（"未配置取流服务" / "只返回 demo 地址" 等）
```

界面上用圆点区分：🟢 本地可播 · 🔵 在线取流 · ⚪ 不可播。

## 4. 断流自动恢复

地址约 1 小时过期，播放中途断流是最容易踩的坑。实现分两层：

**播放器侧：识别异常**（`apps/player/src/player.js`）

| 信号 | 触发条件 |
|---|---|
| `error` | libVLC 进入 `Error` 状态 |
| `error` (ended-without-progress) | 网络流进入 `Ended` 但**时间轴从未推进过** |
| `stalled` | `Playing` 状态但时间轴连续 6 秒不推进 |

> **实测发现**：取流地址返回 403 时，libVLC **不报 `Error`，而是直接进入 `Ended`**。
> 正常播完和"根本没播起来就结束"都表现为 `Ended`，只能靠"时间轴是否推进过"来区分。
> 这个坑是靠真实的过期地址端到端测试才暴露出来的——单元测试里假播放器不会这么表现。

**壳侧：恢复**（`apps/shell/src/supervisor.js`）

```
检测到异常
  -> 记录当前播放位置
  -> 重新实时取地址
  -> 重新载入并 play
  -> 等媒体就绪后 seek 回断点
  -> 提示用户"已重新取流并从 Ns 续播"
```

约束：最多重试 2 次；只对在线播放生效（本地文件重取地址没有意义）；
恢复过程中不重入；换歌时重置计数。

## 5. 验证

```powershell
npm test          # 全量回归（91 项，不含联网）
npm run test:live # 真实联网端到端（需配置 provider）
```

`npm run test:live` 实测输出：

```
  [PASS] 实时获取播放地址 - 418ms  http://download.origjoy.com/.../7789715.ts?sign=...
  [PASS] 地址带有效期 - 2026-09-21T15:43:42.000Z
  [PASS] 在线流起播 - state=Playing time=301ms
  [PASS] 建立视频输出 - 720x480
  [PASS] 在线片源含多条音轨 - [{"id":257,"name":"Track 1"},{"id":258,"name":"Track 2"}]
  [PASS] 判定为音轨型（原伴唱走切音轨） - strategy=track
  [PASS] 切伴唱命中音轨 - current=257 expect=257
  [PASS] 切原唱命中音轨 - current=258 expect=258
  [PASS] 切换后仍在播放 - time=2024ms
```

provider 单元测试（20 项，本地 mock，不联网）覆盖：签名拼接正确、token 复用、
demo 地址跳过、过期地址跳过、多 host 回退、失败后重置设备标识。

监管器单元测试（11 项，假播放器）覆盖：断流后重取并续播、重试上限、本地播放不介入、
恢复中不重入、换歌重置计数。

`npm run test:live` 还包含**断流恢复的真实端到端验证**：故意用曲库里那条已过期的
地址（403）起播，验证监管器能救回来。实测输出：

```
    [notice] 《过期地址恢复测试》播放中断（ended-without-progress），已重新取流
  [PASS] 监管器检测到失败并重新取流
  [PASS] 恢复后正常播放 - state=Playing
  [PASS] 恢复后建立视频输出 - 352x240
  [PASS] 恢复后的片源仍含原伴唱音轨 - [{"id":257},{"id":258}]
  [PASS] 恢复后原伴唱切换仍可用 - current=257
```

## 6. 已知限制

- **地址 1 小时过期**：已实现断流自动重取与续播（见 §4），但极端情况下（连续两次都失败）仍会中断。
- **依赖第三方服务**：接口随时可能变更或下线。这就是 maidong 要做 JS 热更新的原因；
  本项目目前把协议固化在代码里，后续可考虑把 provider 也做成可热更新。
- **部分曲目无源**：实测个别 musicno 只返回 demo 地址，属服务端行为，非本地 bug。
- **未做码率/清晰度选择**：目前固定 `resolution=720`、`ish265=0`。
- **凭证授权未确认**：见 §3。

## 7. 后续建议

1. ~~播放失败自动重取地址~~ ✅ 已完成（见 §4）。
2. **provider 热更新**：把协议参数做成可远程更新的配置，降低接口变更的维护成本。
3. **接 karaoke-companion 的在线音乐聚合**（网易/QQ/酷狗/B站等 8 个平台，MIT 授权），
   作为 maidong provider 的补充与备份源，减少对单一第三方服务的依赖。
