<template>
  <div ref="el" class="video-stage">
    <!-- 这块区域会被原生子窗口覆盖；无片源时隐藏原生窗口，露出这个占位提示 -->
    <div v-if="!active" class="video-placeholder" :class="{ audio: audio }">
      <template v-if="audio">
        <img v-if="song?.cover" class="audio-cover" :src="song.cover" alt="" @error="$event.target.style.display='none'" />
        <Icon v-else name="music" :size="54" class="ph-icon" :stroke-width="1.3" />
        <div class="ph-title">{{ song?.name || song?.title || '正在播放音频' }}</div>
        <div class="ph-sub">{{ song?.singer || song?.artist || '当前曲目没有 MV' }}</div>
        <div class="audio-badge">音频播放 · 该曲目没有 MV</div>
      </template>
      <template v-else>
        <Icon name="music" :size="54" class="ph-icon" :stroke-width="1.3" />
        <div class="ph-title">从右侧曲库点一首歌</div>
        <div class="ph-sub">单击选中 · 双击点歌 · 右键更多；画面里的歌词可随时用「词」开关</div>
        <button class="qr-entry" @click="$emit('openLan')">
          <img v-if="lanInfo.running" :src="qrUrl" alt="手机点歌二维码" />
          <Icon v-else name="smartphone" :size="28" />
          <span>{{ lanInfo.running ? '手机扫码点歌' : '开启手机点歌' }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  active: { type: Boolean, default: false },
  audio: { type: Boolean, default: false },
  song: { type: Object, default: null },
  lanInfo: { type: Object, default: () => ({ running: false, port: 8088 }) },
})
defineEmits(['openLan'])
const qrUrl = computed(() => (props.lanInfo?.running ? `http://127.0.0.1:${props.lanInfo.port}/api/qr.svg` : ''))
const el = ref(null)
let observer = null
let raf = 0

/** 把视频区的 CSS 像素矩形上报给主进程，由它摆放原生子窗口。 */
function reportBounds() {
  const node = el.value
  if (!node || !window.ktv) return
  const r = node.getBoundingClientRect()
  window.ktv.video.setBounds({
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  })
}

function scheduleReport() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(reportBounds)
}

onMounted(() => {
  observer = new ResizeObserver(scheduleReport)
  observer.observe(el.value)
  window.addEventListener('resize', scheduleReport)
  scheduleReport()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  observer?.disconnect()
  window.removeEventListener('resize', scheduleReport)
})

// 有片源才显示原生视频窗口，否则露出 HTML 占位
watch(() => props.active, (on) => {
  if (!window.ktv) return
  window.ktv.video.setVisible(on)
  if (on) scheduleReport()
}, { immediate: true })
</script>

<style scoped>
.video-stage {
  position: relative;
  width: 100%;
  height: 100%;
  background: #000;
  border-radius: 11px;
  overflow: hidden;
  border: 1px solid var(--line);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .015);
}
.video-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--dim);
  background:
    radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--panel-3) 88%, transparent) 0%, var(--bg) 72%),
    linear-gradient(color-mix(in srgb, var(--line) 30%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--line) 30%, transparent) 1px, transparent 1px);
  background-size: auto, 48px 48px, 48px 48px;
}
.ph-icon { font-size: 56px; color: var(--line-2); }
.ph-title { font-size: 19px; color: var(--text-2); letter-spacing: .3px; }
.ph-sub { font-size: 13px; color: var(--dim-2); }
.audio-cover { width: 168px; height: 168px; object-fit: cover; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
.audio-badge { margin-top: 4px; padding: 5px 10px; border-radius: 999px; background: var(--panel-2); color: var(--dim); font-size: 12px; }
.qr-entry { display: flex; flex-direction: column; align-items: center; gap: 7px; margin-top: 10px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 12px; background: color-mix(in srgb, var(--panel-2) 85%, transparent); color: var(--text-2); }
.qr-entry:hover { border-color: var(--focus); color: var(--text); }
.qr-entry img { width: 96px; height: 96px; object-fit: contain; background: #fff; border-radius: 6px; }
</style>
