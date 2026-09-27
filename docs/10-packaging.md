# 打包成 Windows EXE

**日期**：2026-09-24
**状态**：✅ 完成。安装包与免安装版均已产出，默认安装目录和完整安装/卸载流程已验证。

## 1. 产物

| 文件 | 大小 | 说明 |
|---|---|---|
| `KTV点歌系统 Setup 0.5.3.exe` | 186.1 MB | NSIS 安装包（可选安装目录、建桌面/开始菜单快捷方式） |
| `KTV点歌系统 0.5.3.exe` | 185.9 MB | 免安装版，双击即运行 |
| `win-unpacked/` | 530 MB | 解包目录（调试用） |

```cmd
cd apps\shell
build.cmd          :: 出安装包 + 免安装版
build.cmd --dir    :: 只出解包目录（快，调试用）
```

## 2. 核心改造：路径解析

打包后目录结构和开发时完全不同，必须区分三类路径（`apps/shell/src/paths.js`）：

| | 开发时 | 打包后 |
|---|---|---|
| `runtimeRoot` 只读资源 | `<repo>/resources/runtime` | `<安装目录>/resources/runtime` |
| `dataRoot` 可写数据 | `<repo>/resources` | `%APPDATA%/KTV点歌系统` |
| `appRoot` 应用代码 | 仓库根目录 | `<安装目录>/resources/app` |

**为什么曲库不塞进安装包**：

- 988MB 会让安装包大到没人愿意下
- `Program Files` 通常不可写，而曲库更新需要写入

所以曲库放 `%APPDATA%`，**首次运行时下载**。

## 3. 随包分发的运行时

| 资源 | 大小 | 为什么需要 |
|---|---|---|
| libVLC 3.0.21 | 180MB | 播放与原伴唱切换 |
| **node.exe (v22.12)** | 79MB | 曲库服务要 `node:sqlite`；**Electron 自带的是 Node 20，没有这个模块** |
| 曲库服务代码 | <1MB | 曲库查询 |
| 前端产物 | ~0.5MB | 界面 |

## 4. 踩过的三个坑

### 4.1 本地包不能改成绝对路径 require

`@ktv/player` / `@ktv/ktv-api` 是 `file:` 依赖。我担心打包后符号链接失效，
改成绝对路径 require 并放进 `extraResources`。

**结果**：electron-builder 早就把它们（连同 `koffi`）打进了
`app.asar/node_modules/`；而 `extraResources` **默认不复制 node_modules**，
导致 `koffi` 找不到。

**正确做法**：直接用包名 require。开发走 file: 符号链接，打包走 asar 内
node_modules，两种形态都能解析。

### 4.2 跨仓库的相对 require 在 asar 里会跑出去

```js
require('../../../services/catalog/src/install')   // 开发态 OK，打包后 asar 外
```

打包后报 `Cannot find module`，应用启动即弹错误框。
改用 `require(path.join(paths.catalogServiceDir(), 'src', 'install'))`。

**教训**：任何跨仓库边界的 require 都必须走 `paths.js`，不能写死相对路径。

### 4.3 杀毒软件会锁住刚解压的 DLL

第一次打包成功，之后每次都在同一文件上失败：

```
EPERM: operation not permitted, open
  '...\release\win-unpacked.tmp\d3dcompiler_47.dll'
```

杀掉所有相关进程、删掉整个 `release` 目录都无效。
**关闭杀毒软件后立刻恢复正常** —— 确认是实时扫描锁文件。

### 4.4 require 顺序

`paths.js` 的 require 被插到了使用它的位置之后，导致
`Cannot access 'paths' before initialization`，应用起不来，
冒烟测试**挂了 7 分钟**才被发现。

**教训**：脚本化改代码必须校验替换是否命中（`assert count == 1`），
否则失败是静默的。

## 5. 首次运行体验

打包后首次运行没有曲库，曲库面板显示：

> **曲库还没装**
> 曲库是曲目数据（约 440MB 下载、988MB 解压）。装好之后就能搜 67 万首歌并在线播放。
> [下载并安装曲库]

点击后走已有的分片下载管线（校验 + 原子替换 + 进度条）。

## 6. 验证情况

| 项 | 状态 |
|---|---|
| 开发态全量回归（176 项） | ✅ 全过 |
| 安装包 / 免安装版产出 | ✅ 153.7 / 153.5 MB |
| 产物结构（libVLC / node.exe / 曲库服务 / player / web） | ✅ 全部就位 |
| 打包后应用启动 | ✅ 窗口正常，无错误框 |
| 打包后 UI 与首次运行引导 | ✅ 见截图 |
| 打包后**下载曲库** | ⬜ 未端到端验证（440MB，未实跑） |
| 打包后**播放** | ⬜ 未验证（需要先有曲库） |

## 7. 数据目录不落 C 盘

曲库 988MB + 缓存（每首 30-40MB）会很快吃掉 C 盘，而 KTV 机的系统盘通常很小。
所以数据目录**默认自动选非系统盘中剩余空间最大的那个**。

### 选盘逻辑（踩了个坑）

第一版用 `fs.statfsSync` 直接扫 D-Z，取可用空间最大的。结果选中了 `Z:`——
那是**网络盘**，`statfs` 返回了荒谬的值（8.5e9 GB），把真实磁盘全压下去了。

改成先用 Windows 的 `DriveType` 过滤（3 = 本地固定磁盘），排除网络盘/可移动盘/光驱，
再在固定盘里取剩余空间最大的：

```js
wmic logicaldisk get DeviceID,DriveType,FreeSpace /format:csv
// DriveType: 2=可移动 3=本地固定 4=网络 5=光驱
```

示例：程序会按剩余空间排序，选择可用空间最大的非系统固定磁盘。
没有合适的非系统盘时退回 `%APPDATA%`（会在 C 盘，但至少能跑）。

### 显式指定

```cmd
set KTV_DATA_DIR=E:\KTV数据
KTV Desktop.exe
:: 或
KTV Desktop.exe --data-dir=E:\KTV数据
```

设置页的「数据位置」分组会显示实际路径（数据目录 + libVLC 目录）。

### 安装目录

安装包默认装在 `%LOCALAPPDATA%\Programs\KTV Desktop`（C 盘），但**安装时可以改**
（`allowToChangeInstallationDirectory`）。建议装到数据盘，或者直接用免安装版
（放哪都行）。真正占空间的是曲库和缓存，它们已经自动落数据盘了。

## 8. 右栏页签换行

右栏只有 460px，页签行里塞了 4 个按钮 + 两段统计文字，装不下就把按钮文字挤成两行。
修法：把统计挪到**单独一行**，并给按钮加 `white-space: nowrap` + `flex: none`。

## 9. 遗留

- **首次运行下载曲库、以及之后播放，还没在打包形态下端到端验证过**——
  这是最该补的一步（先跑一次完整流程）。
- 没有应用图标（用的 Electron 默认图标）。
- **未做代码签名**，分发时会被 SmartScreen 拦，需要买证书。
- 打包后的 exe 是 GUI 子系统，**console 输出不回终端**，
  所以 `--smoke` 在打包形态下看不到输出，需要另做验证手段。
- 打包前必须关闭杀毒软件（或给 `release` 目录加排除）。
