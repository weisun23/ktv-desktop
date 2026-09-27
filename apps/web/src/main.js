import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

/**
 * 主题要在**挂载之前**就贴上。
 * 主题存在设置文件里、走 IPC 异步读回来，等 onMounted 再贴会先闪一下默认配色。
 * 所以额外在 localStorage 里留一份，这里同步读出来先用上；
 * App.vue 拿到设置后再以设置文件为准覆盖一次（并回写 localStorage）。
 */
const THEMES = ['dark', 'midnight', 'warm', 'light', 'neon', 'jade']
const DENSITIES = ['auto', 'comfortable', 'tv']
try {
  const t = localStorage.getItem('ktv-theme')
  if (THEMES.includes(t)) document.documentElement.dataset.theme = t
} catch { /* 读不到就用默认 */ }
try {
  const d = localStorage.getItem('ktv-density')
  if (DENSITIES.includes(d)) document.documentElement.dataset.density = d
} catch { /* 读不到就用默认 */ }

createApp(App).mount('#app')