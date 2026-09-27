<template>
  <div class="lyrics" :class="{ empty: !lines.length }">
    <template v-if="lines.length">
      <div class="cur" :class="{ dim: !playing, gap: !wordSpans && !currentText }">
        <template v-if="!wordSpans && !currentText">
          <i class="gap-dot"></i><i class="gap-dot"></i><i class="gap-dot"></i>
        </template>
        <template v-else-if="wordSpans">
          <span v-for="(w, i) in wordSpans" :key="i" :class="'w-' + w.state">{{ w.text }}</span>
        </template>
        <template v-else>{{ currentText }}</template>
      </div>
      <div class="next" v-if="nextText">{{ nextText }}</div>
    </template>
    <template v-else>
      <div class="placeholder">{{ status }}</div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const emit = defineEmits(['line'])

const props = defineProps({
  songId: { type: String, default: '' },
  time: { type: Number, default: 0 },       // 毫秒
  playing: { type: Boolean, default: false },
})

const bridge = window.ktv || {}
const lines = ref([])      // [{ time: 秒, text }]
const wordLines = ref([])  // 逐字时间轴：[{ time:毫秒, duration, words:[{t,d,text}] }]
const status = ref('')
const loadingFor = ref('')

/** 解析 LRC。支持一行多个时间标签，也忽略元信息行（[ar:] 之类）。 */
function parseLrc(text) {
  const out = []
  const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const raw of String(text || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(re)]
    if (!tags.length) continue
    const content = raw.replace(re, '').trim()
    if (!content) continue
    for (const t of tags) {
      const min = Number(t[1])
      const sec = Number(t[2])
      const frac = t[3] ? Number(('0.' + t[3])) : 0
      out.push({ time: min * 60 + sec + frac, text: content })
    }
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

async function load(songId) {
  lines.value = []
  if (!songId) { status.value = '点歌后显示歌词'; return }
  loadingFor.value = songId
  status.value = '正在获取歌词…'
  try {
    const r = await bridge.lyrics.get(songId)
    if (loadingFor.value !== songId) return      // 期间切歌了，丢弃结果
    if (r.ok) {
      lines.value = parseLrc(r.lrc)
      wordLines.value = Array.isArray(r.words) ? r.words : []
      status.value = lines.value.length ? '' : '歌词格式无法解析'
    } else {
      wordLines.value = []
      status.value = r.error || '没有歌词'
    }
  } catch (e) {
    status.value = '歌词获取失败：' + e.message
  }
}

/** 当前行：最后一条 time <= 当前播放时间 */
const currentIndex = computed(() => {
  const t = props.time / 1000
  let idx = -1
  for (let i = 0; i < lines.value.length; i++) {
    if (lines.value[i].time <= t) idx = i
    else break
  }
  return idx
})
const currentText = computed(() => (currentIndex.value >= 0 ? lines.value[currentIndex.value].text : ''))

/**
 * 当前这一行的**逐字**时间轴。拿不到（老缓存/平台没提供）就返回 null，
 * 界面回退成整行高亮。
 */
const currentWords = computed(() => {
  if (!wordLines.value.length) return null
  const t = props.time
  let best = null
  for (const L of wordLines.value) {
    if (L.time <= t) best = L
    else break
  }
  if (!best) return null
  // 这一行过去太久就不显示了，避免和"当前行"错位
  const end = best.time + (best.duration || 5000)
  return t > end + 1500 ? null : best
})

/** 每个字的状态：done 已唱 / now 正在唱 / todo 未唱 */
const wordSpans = computed(() => {
  const L = currentWords.value
  if (!L) return null
  const t = props.time
  return L.words.map((w) => {
    const end = w.t + (w.d || 0)
    return { text: w.text, state: t >= end ? 'done' : (t >= w.t ? 'now' : 'todo') }
  })
})
const nextText = computed(() => {
  const n = currentIndex.value + 1
  return n < lines.value.length ? lines.value[n].text : ''
})

watch(() => props.songId, (id) => load(id), { immediate: true })
// 把当前歌词行抛给上层 —— 上层会把它送进 libVLC marquee 画到视频画面上
watch(currentText, (t) => emit('line', t || ''), { immediate: true })
</script>

<style scoped>
.lyrics {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; padding: 10px 20px; min-height: 86px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  text-align: center; overflow: hidden;
}
.lyrics.empty { color: var(--dim); }

.cur {
  font-size: 22px; font-weight: 600; line-height: 1.3;
  color: var(--focus); text-shadow: 0 0 18px rgba(39, 204, 164, .25);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
}
.cur.dim { color: var(--dim-2); text-shadow: none; }

/* 纯音乐段落（这一行没有歌词）：用三个呼吸点代替一个孤零零的「…」 */
.cur.gap { display: flex; align-items: center; justify-content: center; gap: 7px; }
.gap-dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--dim);
  animation: gapPulse 1.4s ease-in-out infinite;
}
.gap-dot:nth-child(2) { animation-delay: .2s; }
.gap-dot:nth-child(3) { animation-delay: .4s; }
@keyframes gapPulse {
  0%, 100% { opacity: .25; transform: scale(.8); }
  50% { opacity: .9; transform: scale(1); }
}

/* 逐字模式：已唱绿、正在唱亮白、未唱灰 */
.cur .w-done { color: var(--focus); }
.cur .w-now { color: #ffffff; text-shadow: 0 0 16px rgba(39, 204, 164, .75); }
.cur .w-todo { color: var(--dim-2); }
.next {
  font-size: 14px; color: var(--dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
}
.placeholder { font-size: 13px; }
</style>
