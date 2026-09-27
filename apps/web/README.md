# apps/web

Vue 3 前端（Vite）。阶段 1 为大屏点歌界面。

| 组件 | 职责 |
|---|---|
| `App.vue` | 布局、状态订阅、快捷键 |
| `components/VideoStage.vue` | 视频区占位，上报 bounds 给主进程 |
| `components/PlayerControls.vue` | 播放控制、原伴唱切换、音轨手动指定、音量 |
| `components/LibraryList.vue` | 曲库列表与搜索 |

## 快捷键

`空格` 播放/暂停 · `←/→` 快退/快进 5s · `O` 原唱 · `A` 伴唱

## 注意

`VideoStage` 区域会被原生子窗口覆盖，**HTML 不能叠加在视频之上**，
控件需放在视频区之外（见 `docs/00-architecture.md` §6）。

浏览器里单独跑（无 Electron）时会降级为空实现，方便调界面：
```powershell
npm run dev
```
