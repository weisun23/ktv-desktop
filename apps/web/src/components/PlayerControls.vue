<template>
  <div ref="root" class="controls" :class="'w' + level">
    <div class="now" :title="songName">
      <div class="title">{{ songName || '未播放' }}</div>
      <div class="sub">
        <span v-if="songSinger" class="singer">{{ songSinger }}</span>
        <span class="state"><i class="dot" :class="{ on: playing }"></i>{{ statusText }}</span>
        <span v-if="hasMedia && level <= 2" class="tag">{{ strategyLabel }}</span>
      </div>
    </div>

    <div class="transport">
      <!-- 图标化的快退/快进：文字版「«5s」太宽，窄窗口会被挤掉，
           而"跳 5 秒"是唱歌时最常用的操作之一，不该只在最宽的档位才有。 -->
      <button class="icon" aria-label="快退 5 秒" @click="$emit('seekRelative', -5000)" :disabled="!hasMedia" title="快退 5 秒（←）"><Icon name="rewind" :size="17" :fill="true" /></button>
      <button class="primary big" @click="$emit('toggle')" :disabled="!hasMedia">
        {{ playing ? '暂停' : '播放' }}
      </button>
      <button class="icon" aria-label="快进 5 秒" @click="$emit('seekRelative', 5000)" :disabled="!hasMedia" title="快进 5 秒（→）"><Icon name="forward" :size="17" :fill="true" /></button>
      <button @click="$emit('next')" :disabled="!queueLength" :title="'下一首（已点 ' + queueLength + ' 首）'">
        切歌<span v-if="level <= 1 && queueLength" class="n">{{ queueLength }}</span>
      </button>
      <button v-if="level <= 1" @click="$emit('fullscreen')" :title="fullscreen ? '退出全屏 (F / Esc)' : '全屏 (F)'">
        {{ fullscreen ? '退出全屏' : '全屏' }}
      </button>
    </div>

    <div class="progress">
      <span class="t">{{ fmt(time) }}</span>
      <input
        class="seek"
        type="range"
        min="0"
        :max="length || 0"
        :value="time"
        :disabled="!length"
        :style="{ '--pct': (length ? Math.min(100, (time / length) * 100) : 0) + '%' }"
        @input="$emit('seek', Number($event.target.value))"
      />
      <span class="t">{{ fmt(length) }}</span>
    </div>

    <div class="vocal" :title="channelText">
      <button
        class="vocal-toggle"
        :class="{ active: true }"
        :disabled="!hasMedia"
        :title="vocalMode === 'accompaniment' ? '当前伴唱，点击切换原唱' : '当前原唱，点击切换伴唱'"
        @click="$emit('vocal', vocalMode === 'accompaniment' ? 'original' : 'accompaniment')"
      >{{ vocalMode === 'accompaniment' ? '伴唱' : '原唱' }}</button>
      <button v-if="level === 0" :class="{ active: vocalMode === 'stereo' }" @click="$emit('vocal', 'stereo')" :disabled="!hasMedia || strategy === 'track'">立体声</button>
      <!-- 这个「词」切的是**画面里**的歌词（居中滚动），不是底部的 HTML 歌词条。
           底部歌词条在设置页里开关。之前切错对象，用户按了半天画面上的字还在。 -->
      <button
        :class="{ active: lyricsOnVideo }"
        @click="$emit('lyrics')"
        :title="lyricsOnVideo ? '隐藏画面里的歌词（居中滚动）' : '显示画面里的歌词（居中滚动）'"
      >词</button>
    </div>

    <div v-if="pitchSupported && level <= 2" class="pitch" :title="pitchText">
      <button aria-label="降半音" @click="$emit('pitchStep', -1)" :disabled="!hasMedia || pitch <= -6" title="降半音（[）">♭</button>
      <button class="pitch-val" :class="{ on: pitch !== 0 }" :disabled="!hasMedia || pitch === 0"
        @click="$emit('pitch', 0)" :title="pitch === 0 ? '当前原调' : '点击还原原调（\\）'">{{ pitchLabel }}</button>
      <button aria-label="升半音" @click="$emit('pitchStep', 1)" :disabled="!hasMedia || pitch >= 6" title="升半音（]）">♯</button>
    </div>

    <!-- 音量：窄窗口下改成更短的滑块，而不是整块消失 ——
         对 KTV 来说音量是随时要调的。 -->
    <div class="volume">
      <Icon name="volume" :size="15" class="vol-icon" />
      <input class="vol" type="range" min="0" max="150" :value="volume"
        :style="{ '--pct': Math.min(100, (volume / 150) * 100) + '%' }"
        aria-label="音量" @input="$emit('volume', Number($event.target.value))" />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  songName: { type: String, default: '' },
  songSinger: { type: String, default: '' },
  hasMedia: { type: Boolean, default: false },
  playing: { type: Boolean, default: false },
  stateName: { type: String, default: '' },
  time: { type: Number, default: 0 },
  length: { type: Number, default: 0 },
  volume: { type: Number, default: 100 },
  vocalMode: { type: String, default: 'original' },
  strategy: { type: String, default: 'channel' },
  accomp: { type: Number, default: 0 },
  channelMap: { type: Object, default: null },
  queueLength: { type: Number, default: 0 },
  fullscreen: { type: Boolean, default: false },
  showLyrics: { type: Boolean, default: true },
  lyricsOnVideo: { type: Boolean, default: true },
  pitch: { type: Number, default: 0 },
  pitchSupported: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle', 'next', 'fullscreen', 'seek', 'seekRelative', 'volume', 'vocal', 'lyrics', 'pitch', 'pitchStep'])

/**
 * 响应式分级：控制条不能换行（换行会顶高左栏、挤占画面），
 * 而是在变窄时**按优先级隐藏次要控件**。
 *
 * 优先级（KTV 场景）：播放/切歌/进度 > 原伴唱 > 音量/跳 5 秒 > 变调 > 全屏 > 立体声。
 *
 * ⚠️ 音量、快进快退**不能整块砍掉** —— 曾经把它们放在最低优先级、窄一点就直接隐藏，
 * 用户的第一反应是"声音控制、快进快退都缺失了"。现在只**压缩形态**，不删功能：
 * 快进快退从「«5s」变成统一 SVG 图标，音量滑块从 92px 压到 56px。
 *
 *   0 宽（≥980）：全显示
 *   1 中（≥730）：藏 立体声（音轨型片源用不到）
 *   2 窄（≥570）：藏 全屏（F / Esc / 双击画面都在）—— 让位给**变调**
 *   3 最窄：再藏 变调（[ ] 快捷键仍在）
 *
 * ⚠️ 播放/暂停、切歌、进度、**音量、跳 5 秒**、原伴唱 这六样**任何宽度都保留**。
 * ⚠️ 变调要尽量留：KTV 里它比全屏常用得多，全屏有快捷键和双击画面两条路。
 */
const root = ref(null)
const width = ref(1200)
// ⚠️ width 来自 ResizeObserver 的 contentRect，**不含 padding**（比外框小 28px），
// 阈值必须按内容宽算，否则 770px 的外框会被判成更窄的一档。
const level = computed(() => (width.value >= 950 ? 0 : width.value >= 730 ? 1 : width.value >= 570 ? 2 : 3))

let ro = null
onMounted(() => {
  ro = new ResizeObserver((entries) => {
    for (const e of entries) width.value = e.contentRect.width
  })
  if (root.value) ro.observe(root.value)
})
onBeforeUnmount(() => ro?.disconnect())

const statusText = computed(() => {
  if (!props.hasMedia) return '空闲'
  const map = { Playing: '播放中', Paused: '已暂停', Stopped: '已停止', Ended: '播放结束', Error: '播放错误', Buffering: '缓冲中', Opening: '打开中' }
  return map[props.stateName] || props.stateName || '未知'
})

const strategyLabel = computed(() => (props.strategy === 'track' ? '音轨型' : '声道型'))

/** 变调显示：0 显示"原调"，其余带正负号 */
const pitchLabel = computed(() => (props.pitch === 0 ? '原调' : (props.pitch > 0 ? '+' : '') + props.pitch))
const pitchText = computed(() => props.pitch === 0
  ? '变调：当前原调（♭− 降半音 / ♯+ 升半音）'
  : `变调：${props.pitch > 0 ? '升' : '降'} ${Math.abs(props.pitch)} 个半音`)
// ± 走相对增量（见主进程 player:setPitchDelta 的说明），只有"还原"用绝对值

const channelText = computed(() => {
  const m = props.channelMap
  if (!m) return ''
  const side = (v) => (v === 'left' ? '左声道' : '右声道')
  return side(m.accompaniment) + '伴唱 / ' + side(m.original) + '原唱'
    + (props.accomp ? '（accomp=' + props.accomp + '）' : '')
})

function fmt(ms) {
  if (!ms || ms < 0) ms = 0
  const total = Math.floor(ms / 1000)
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}
</script>

<style scoped>
.controls {
  display: grid; align-items: center; gap: 11px;
  grid-template-columns: minmax(120px, 1fr) minmax(160px, 2fr) auto auto auto auto;
  grid-template-areas: "now progress transport vocal pitch volume";
  padding: 9px 12px;
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--panel) 96%, var(--panel-3)),
    var(--panel));
  border: 1px solid var(--line); border-radius: 10px;
  min-height: 0;
  box-shadow: 0 7px 22px rgba(0, 0, 0, .16);
}
.now { grid-area: now; }
.progress { grid-area: progress; }
.transport { grid-area: transport; }
.vocal { grid-area: vocal; }
.pitch { grid-area: pitch; }
.volume { grid-area: volume; }

/* 宽档：歌名可占弹性空间，进度条拿到主要宽度。 */
.controls.w1 {
  grid-template-columns: minmax(160px, 2fr) auto auto auto auto;
  grid-template-areas: "progress transport vocal pitch volume";
}
/* 窄档：进度条独占第一行，其余操作在第二行。 */
.controls.w2 {
  grid-template-columns: auto auto auto auto;
  grid-template-areas:
    "progress progress progress progress"
    "transport vocal pitch volume";
  row-gap: 8px; column-gap: 7px;
}
.controls.w3 {
  grid-template-columns: auto auto auto;
  grid-template-areas:
    "progress progress progress"
    "transport vocal volume";
  row-gap: 8px; column-gap: 7px;
}
.progress { width: 100%; }

.now { flex: 1 1 150px; min-width: 0; }
/* 窄档位下这块会被压到只剩一两个字，还不如不显示 ——
   歌名在窗口标题里（主进程会写）和右侧列表里都有。 */
.w1 .now, .w2 .now, .w3 .now { display: none; }
.now .title { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.now .sub { display: flex; align-items: center; gap: 8px; margin-top: 3px; font-size: 12px; color: var(--dim); }
.now .singer { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 110px; }
.now .state { display: flex; align-items: center; gap: 4px; flex: none; }
.now .tag { flex: none; color: var(--gold); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line-2); }
.dot.on { background: var(--focus); box-shadow: 0 0 6px var(--focus); }

.transport { display: flex; gap: 6px; flex: 0 0 auto; }
.transport button { padding: 9px 12px; font-size: 13px; white-space: nowrap; }
.transport .big { padding: 9px 20px; font-size: 15px; }
.transport .n { font-size: 11px; opacity: .75; margin-left: 3px; }

.progress { flex: 3 1 140px; min-width: 110px; display: flex; align-items: center; gap: 8px; }
.progress .t { font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; flex: none; }
.seek { flex: 1; min-width: 0; accent-color: var(--focus); cursor: pointer; }

/* 图标按钮：比文字窄，用来把"跳 5 秒"塞进更窄的档位 */
.transport button.icon { display: inline-flex; align-items: center; justify-content: center; padding: 7px 8px; font-size: 13px; line-height: 1; }

/* 窄档位把按钮挤紧一点：9 个按钮各省几像素，正好够放变调 */
.w2 .transport button, .w3 .transport button,
.w2 .vocal button, .w3 .vocal button,
.w2 .pitch button, .w3 .pitch button { padding: 6px 7px; }

/* 音量滑块：宽档 92px，窄档压到 56px 也还能拖 */
.volume .vol { width: 92px; }
.w1 .volume .vol, .w2 .volume .vol, .w3 .volume .vol { width: 56px; }
.w1 .volume .vol-icon, .w2 .volume .vol-icon, .w3 .volume .vol-icon { font-size: 12px; }

.vocal { display: flex; gap: 4px; flex: 0 0 auto; padding-left: 10px; border-left: 1px solid var(--line); }
.vocal button { padding: 7px 10px; font-size: 12px; }
.vocal button:disabled { background: var(--btn); border-color: var(--line); color: var(--dim); }

.pitch { display: flex; align-items: center; gap: 3px; flex: 0 0 auto; padding-left: 9px; border-left: 1px solid var(--line); }
.pitch button { padding: 7px 7px; font-size: 12px; white-space: nowrap; }
.pitch .pitch-val {
  min-width: 36px; text-align: center; font-size: 12px; color: var(--dim);
  font-variant-numeric: tabular-nums; cursor: pointer;
}
.pitch .pitch-val.on { color: var(--gold); font-weight: 600; }
.pitch .pitch-val:disabled { background: var(--btn); border-color: var(--line); color: var(--dim); opacity: .8; cursor: default; }

.volume { display: flex; align-items: center; gap: 6px; flex: 0 1 100px; min-width: 70px; padding-left: 10px; border-left: 1px solid var(--line); }
.vol-icon { font-size: 13px; }
.vol { flex: 1; min-width: 0; accent-color: var(--focus); cursor: pointer; }

/* 窄档位减少分隔线数量，避免控制条显得像被切碎 */
.w2 .vocal, .w2 .pitch, .w2 .volume,
.w3 .vocal, .w3 .pitch, .w3 .volume { padding-left: 0; border-left: 0; }

/* 最窄时：隐藏进度条上的时间数字，把空间留给滑块 */
.controls.w3 .progress .t { display: none; }
.controls.w3 .now { flex: 0 1 auto; max-width: 120px; }
</style>
