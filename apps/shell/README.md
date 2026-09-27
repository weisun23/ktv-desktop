# apps/shell

Electron 主进程。

| 文件 | 职责 |
|---|---|
| `src/main.js` | 窗口创建、IPC 注册、视频区摆放、状态推送 |
| `src/preload.js` | contextBridge，渲染进程访问主进程的唯一通道 |
| `src/library.js` | 本地曲库扫描（后续扩展为 provider 接口） |
| `src/smoke.js` | `--smoke` 集成冒烟，无需人工点击 |

## 视频区如何摆放

1. 渲染进程用 `ResizeObserver` + `getBoundingClientRect()` 上报视频区（CSS 像素）
2. 主进程按显示器 `scaleFactor` 换算成物理像素
3. `VideoSurface.setBounds()` 调 `SetWindowPos` 摆放 WS_CHILD 子窗口

## 命令

```powershell
npm start     # 启动（加载 apps/web/dist）
npm run dev   # 开发模式（连 Vite dev server:5173）
npm run smoke # 集成冒烟
```
