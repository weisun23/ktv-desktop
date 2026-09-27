# 架构决策：Windows KTV 桌面版

**状态**：已定稿（阶段 0–4 完成）
**日期**：2026-09-21

## 1. 结论

不做"二选一移植"，做**混合架构**：

> **Electron 壳（Node）+ 复用 karaoke-companion 的 Vue 前端 + libVLC 原生播放器
> + 本地曲库先行 + 局域网 HTTP 服务（手机点歌）**

两个来源项目的强项几乎不重叠，这决定了改造方式：

| | karaoke-companion | maidong-ktv |
|---|---|---|
| 形态 | 前后端分离 Web 系统 | 单机 Android 原生 App |
| UI | Vue3 + Element Plus（网页/后台风格） | Kotlin 原生 View（TV 遥控器焦点导航，9k 行单体） |
| 曲库 | MySQL 自建 + 在线聚合搜索 | `muse.db`（约 450MB 分片发布）+ 热更新 JS 取流 |
| 播放 | `<video>` / `<audio>` 播本地文件 | IJK（FFmpeg）播 KTV MPEG-TS |
| 原伴唱切换 | **预分离成两个文件**（Spleeter 产物） | **单文件内切音轨 / 切左右声道** |
| 手机点歌 | 本身就是网页 | 内置 200 行 HTTP 服务，服务 `assets/mobile` |

**为什么 UI 用 Web 而不是移植 Android 原生 UI**：`MainActivity.kt` 有 9267 行，
把它移植到 WinUI/WPF 是纯重写且不可维护。它应被当作**功能规格说明书**使用，
而不是代码来源。

**为什么不能是纯 Web**：原伴唱切换必须落到原生播放器（见 `01-player-poc.md`）。

## 2. 壳为什么选 Electron 而不是 Tauri

原计划是 Tauri 2，**因工具链约束改为 Electron**：

- 本机（以及多数 KTV 装机环境）**没有 C++ 工具链**：VS 2019 目录是空壳，
  无 `link.exe`/`cl.exe`，无 Windows SDK。实测 `rustc` 编译最小程序即报
  `linker link.exe not found`。Tauri 必须编译 Rust，等于强制要求装
  2–4GB 的 VS Build Tools（且需要管理员权限）。
- Electron 只需 Node，**零编译依赖**。原生播放能力通过
  [koffi](https://koffi.dev/)（预编译 FFI，无需 node-gyp）直接调用 libVLC C API，
  与 Tauri 方案调用的是**同一套 API**。
- **Tauri 的体积优势在本项目基本被抵消**：无论哪个壳都要随包分发
  libVLC（约 100MB）和曲库数据（数百 MB），壳本身的 10MB vs 150MB 差别不显著。
- Node 同时也是曲库/在线音乐聚合服务的推荐实现语言（见 §5），技术栈更统一。

> 若要回到 Tauri：`apps/player/src/vlc-ffi.js` 是唯一与 libVLC 耦合的地方，
> 换壳只需用 Rust 重写这一层，上层业务与前端不动。

## 3. 模块级复用对照

| 能力 | 来源 | Windows 端做法 |
|---|---|---|
| 点歌/队列/收藏 UI | karaoke-companion `frontend` | 直接用，另加大屏布局 |
| 歌词逐字高亮 | `utils/lrc.js` + `LyricService` | 直接用 |
| 在线音乐聚合（网易/QQ/酷狗/酷我/B站/咪咕/5sing） | `platform/impl/*` | 见 §5，高价值需迁移 |
| 原伴唱切换 | maidong `KtvPlaybackEngine` **思路** | libVLC `audio_set_track` / `audio_set_channel`（自行实现） |
| KTV 取流 + 热更新 | maidong `ktv_api.js` **思路** | 自研 provider 接口（见 §4） |
| 曲库 schema + 分片更新 | maidong `MuseDatabase` / `database_publish` **思路** | Rust/Node 重写（本质是 SQLite + HTTP + 校验） |
| 用户态数据（队列/收藏/歌单/设置） | maidong `state.json` **思路** | SQLite / JSON，无需 MySQL |
| 局域网手机点歌 | maidong `LocalRemoteServer` **思路** | 自研 HTTP 服务，页面复用 `apps/web` |
| 遥控器焦点导航 | maidong `TvFocusStyler` **思路** | Web 侧 CSS `:focus-visible` + roving tabindex |

**不移植**：`MainActivity.kt` 的 UI 代码、Android 专有 API、以及 maidong 的任何
源代码文本（见 §4）。

## 4. 与 maidong-ktv 的关系：只参考方案，不复制代码

`maidong-ktv` 采用**禁止商用**协议，且明确点名"商业 KTV 运营、收费体验活动"。
为规避许可证约束，本项目对 maidong 采取**净室（clean-room）复刻**策略：

**可以做的（本项目的做法）**
- 参考其**架构思路、功能行为、协议流程**：例如"单文件内切音轨/切左右声道"
  这一实现方案、热更新取流的分层方式、曲库分片下发与校验流程。
- 按同样的**功能规格**自行编码。`apps/player/src/player.js` 的原伴唱策略、
  `apps/player/src/vlc-ffi.js` 的 FFI 绑定均为本项目独立实现。

**不能做的**
- 复制其源码文本（含 `ktv_api.js` 热更新脚本、`MainActivity.kt` 等）。
- 复用其界面素材、Logo（麦动）、品牌名。
- 依赖其内置的第三方服务凭证。

**"只参考方案"不能解决的问题（需要单独处理）**

| 问题 | 说明 |
|---|---|
| 第三方取流凭证 | maidong 的 `ktv_api.js` 内嵌了某商业 KTV 服务的 `APP_ID`/`APP_KEY`/`SDK_KEY`/RSA 公钥。这些属于**第三方**，不是 maidong 的版权问题，而是**授权问题**。本项目**不内置任何第三方凭证**，改为 provider 接口由使用者自行配置。 |
| 曲库数据 | `muse.db` 里的歌名、歌手、封面等数据源自商业曲库，属于**数据授权**问题，与软件许可无关。 |
| 商标与外观 | 不使用"麦动"名称与 Logo。 |

> 以上是工程层面的合规设计，不构成法律意见。若项目要商用，建议就取流授权
> 与曲库数据来源单独咨询法务。

**本项目自身的许可**：目前未定。若最终不包含 maidong 的任何代码与素材，
则不受其非商用条款约束，可自行选择许可证。

## 5. 目录布局

```
ktv-desktop/
├── apps/
│   ├── shell/        Electron 主进程：窗口、IPC、曲库托管、队列与用户状态  ✅
│   ├── web/          Vue3 前端：大屏点歌界面（+ 后续手机点歌模式）        ✅
│   └── player/       libVLC 封装：FFI 绑定 + 原伴唱策略 + Win32 承载窗口   ✅
├── services/
│   ├── catalog/      曲库：muse.db 安装/读取/HTTP 服务  ✅
│   └── separator/    可选：音频分离（demucs）
├── packages/
│   └── ktv-api/      KTV 取流 provider（自研，凭证由本地配置提供，不内置）  ✅
├── poc/player/       阶段 0 验证（libVLC 能力 + 音频级验证）
├── resources/{runtime,catalog}/
├── testmedia/        ffmpeg 生成的测试片
└── docs/
```

`karaoke-companion` 与 `maidong-ktv` 都保持独立，作为**只读参考**放在
`<workspace>\` 下，不 fork、不内嵌。

## 6. 视频渲染方案

libVLC 需要渲染到一个 HWND。若直接给它 Electron 主窗口的 HWND，视频会盖住整个
窗口（包括 HTML 界面）。因此 `apps/player/src/win32.js` 创建一个 **WS_CHILD 子窗口**，
挂在主窗口下、摆放在界面预留的视频区：

- 子窗口被父窗口裁剪，随父窗口移动/最小化，无需额外同步
- HTML 界面在子窗口之外照常显示与交互
- **代价**：HTML 元素无法叠加在视频之上，控件必须放在视频区之外

这是阶段 1 的取舍。若将来需要"进度条浮在画面上"，需改为双窗口方案
（视频子窗口 + 控件子窗口）或改用 `libvlc_video_set_callbacks` 自绘。

## 7. 后端方案

Spring Boot 2.7 + Java 8 + MySQL + Spleeter 是**服务器形态**，不适合单机 EXE 分发。
推荐目标形态：**Node (Fastify) + better-sqlite3**，与 Electron 同栈、无额外运行时。

真正要迁的只有 `platform/impl/*` 那 8 个平台解析类 + 歌词服务；其余
（用户/队列/歌曲 CRUD）在单机场景下不需要——maidong 的 `state.json` 已证明这点。

**Spleeter 必须换掉**：依赖 TF 1.x + Python 3.7，Windows 上装不动。建议改用
demucs（PyTorch），或做成"首次使用按需下载"的可选组件——因为 KTV 片源本身
通常就带原伴唱音轨，分离只是兜底能力。

## 8. 实施顺序

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 播放器可行性验证（音轨/声道/嵌入） | ✅ 完成 |
| 1 | Electron + Vue 骨架，点歌 → 播放 → 切原伴唱 | ✅ 完成 |
| 2 | 曲库：muse.db 复用 + 分片下载/校验/原子替换 | ✅ 完成 |
| 3 | 在线取流：实时获取播放地址 | ✅ 完成 |
| 4 | 用户态：队列/已唱/收藏/歌单/设置 | ✅ 完成 |
| 5 | 局域网手机点歌 | 待开始 |
| 6 | 打包单 exe（NSIS）+ 代码签名 | 待开始 |
| 7 | 可选：音频分离（demucs） | 待开始 |

## 9. 曲库结论（阶段 2 实测）

复用 maidong 的 `muse.db` 是可行的，但要认清它的边界：

- **元数据完整**：670,304 首曲目、135,955 位歌手、7 个语种，搜索与浏览都很快
  （热歌榜/歌名搜索 1–3ms）。
- **播放地址不可用**：`songs.cloud_url` 里的签名 URL 在曲库发布当天就过期，
  实测返回 **403**。这与 maidong 的设计一致——它每次播放都实时取 URL，
  库里的只是兜底。
- **因此曲库只解决"点什么歌"，不解决"怎么播"**。播放要么靠本地文件，
  要么靠实时取流——**阶段 3 已打通**：实测接口可返回新鲜地址（约 1 小时有效），
  片源是标准双音轨 KTV TS，原伴唱切换正常。详见 `04-phase3-online.md`。

另有一个易错点：`songs.accomp` 决定原伴唱声道映射（`1`=左伴奏/右原唱，
`2`=左原唱/右伴奏），必须从曲库传到播放器，否则会出现"点伴唱出原唱"。
详见 `03-phase2-catalog.md` §3。

## 10. 风险清单

| 风险 | 说明与对策 |
|---|---|
| 取流 URL 时效性 | 必须"每次播放实时获取、不缓存"（签名有有效期） |
| 第三方凭证与曲库授权 | 见 §4，本项目不内置凭证；曲库数据来源需自行确认 |
| exe 签名 | 未签名会被 SmartScreen 拦，分发前需代码签名 |
| libVLC 分发 | LGPL，随包附许可证与声明 |
| 视频区不可叠加 | 见 §6，控件布局需避开视频区 |
| 变调能力 | Android 端用 SoundTouch，libVLC 侧方案待定（`--audio-filter` 或 pitch 滤镜） |
| 真实片源差异 | 合成测试片已验证，仍需用实际曲库片源复跑确认音轨/声道布局 |
| 曲库授权 | `muse.db` 的歌名/歌手等数据源自商业曲库，来源需自行确认（见 §4） |
| 曲库体积 | 解压后 988MB，安装时需保证目标分区有足够空间 |
| Node 运行时 | 曲库服务依赖独立 Node 进程，打包时需随包带 node.exe |
| 取流地址时效 | 在线地址约 1 小时过期，播放失败需自动重取（见 04-phase3-online.md） |
| 接口返回广告片 | 部分节点返回 4K 广告片而非曲目；已用"URL 必须含 musicNo"过滤（见 06-fixes-lag-and-cache.md） |
| 第三方服务稳定性 | 取流依赖第三方接口，可能变更或下线；后续接 MIT 授权的在线聚合作为备份源 |
