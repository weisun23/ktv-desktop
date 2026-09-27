# 18. 局域网手机点歌

> 阶段 5 的功能。手机连同一个 Wi-Fi 就能扫码点歌，不用走到主机前面。

## 用法

1. 主机上打开 **设置 → 手机点歌**，确认是「开启」状态
2. 手机连**同一个 Wi-Fi**，扫设置页里的二维码（或手输 `http://<主机IP>:8088`）
3. 搜歌 → 点「点歌」→ 主机的已点列表里就出现了

主机上没在播时会**立刻开唱**；正在唱就排到队尾。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 点歌页（单文件 HTML，无外链、无构建） |
| GET | `/api/info` | 服务名与端口 |
| GET | `/api/status` | 正在播放 + 已点队列（手机页每 3 秒轮询） |
| GET | `/api/hot?limit=&offset=` | 热歌榜 |
| GET | `/api/search?kw=&limit=&offset=` | 搜歌 |
| POST | `/api/order` | `{ songId, next? }` 点歌 |
| POST | `/api/remove` | `{ entryId }` 从队列移除 |
| GET | `/api/qr.svg` | 点歌页地址的二维码（服务端用 `qrcode-generator` 现算） |

## 三个关键设计决定

### 1. 点歌走**同一条**代码路径

主机界面走 IPC，手机走 HTTP，但两者最终都调同一个函数：

```js
// apps/shell/src/main.js
async function orderSongById(songId, opts = {}) { ... }

ipcMain.handle('queue:order', (_e, songId, opts) => orderSongById(songId, opts));
// lanserver 的 order handler 也指向它
```

这样"重复点歌拦截""立刻开唱还是排队""缓存入队"的行为不会出现两套。

> 抽函数时踩过一次：`orderSongById` 和 `needCatalog` 原本定义在 `registerIpc()` **内部**，
> 局域网服务在外面调用会报 `is not defined`。两个都提到了模块级。

### 2. 只监听局域网，不做鉴权

绑 `0.0.0.0`（局域网可达），同一 Wi-Fi 就是信任边界。这是 KTV 的常规形态：
客人不需要登录就能点歌。**不想要就关掉开关**，关掉后不监听任何端口。

### 3. 端口被占用自动往后试

默认 8088，最多试 10 个。实际端口以设置页显示的为准。
（家里/店里跑着别的 Web 服务很常见，直接失败会很烦。）

## ⚠️ 首次开启会被 Windows 防火墙拦

服务一开始监听，Windows 就会弹「是否允许 Electron 通过防火墙」。
**必须选「允许」**（至少勾"专用网络"），否则只有主机自己（127.0.0.1）能访问，手机连不上。

点错了可以到「Windows 防火墙 → 允许应用通过防火墙」里补。
设置页里也写了这条提示。

## 安全边界

- 页面只暴露"搜索 / 点歌 / 看队列"，**没有**任何删除文件、改设置、执行命令的入口
- 请求体上限 64KB
- 响应统一带 `X-Content-Type-Options: nosniff`、`Cache-Control: no-store`
- 不落地任何凭证，不读用户文件

## 相关文件

- `apps/shell/src/lanserver.js` — HTTP 服务与路由
- `apps/shell/src/lan/index.html` — 手机点歌页（内联 CSS/JS，零依赖）
- `apps/shell/test/lan-test.js` — 20 项：路由、参数夹取、坏 JSON、端口回退、二维码、错误兜底
- `apps/shell/src/main.js` — `startLanServer` / `stopLanServer` / `restartLanServer`
