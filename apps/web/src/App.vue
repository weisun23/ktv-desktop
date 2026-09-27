<template>
  <div class="app" :class="{ fullscreen, 'controls-hidden': fullscreen && !controlsVisible }">
    <header class="topbar">
      <div class="brand">KTV 点歌系统</div>

      <!-- 数据源二选一。
           放在**顶栏**而不是右侧面板顶部：右栏本来就挤（数据源 44 + 分区页签 37 +
           曲库页签 40 + 工具栏 36 = 157px），挪上来后列表直接多出 44px。
           顶栏一直可见，反而比原来更"明显"。 -->
      <div class="src-switch" :class="'mode-' + sourceMode">
        <button
          :class="{ on: sourceMode === 'maidong' }"
          title="麦动曲库：67 万首、歌手/语种分类齐全，但 MV 片源带损坏包，视频可能卡"
          @click="setSourceMode('maidong')"
        ><Icon name="music" :size="14" />麦动曲库</button>
        <button
          :class="{ on: sourceMode === 'online' }"
          title="在线源：直接搜网易云/酷我，视频流畅，冷门歌可能搜不到"
          @click="setSourceMode('online')"
        ><Icon name="cloud" :size="14" />在线源</button>
      </div>

      <div class="spacer"></div>
      <div class="stat chip" v-if="status.cache">已缓存 {{ status.cache.count }} 首 · {{ fmtSize(status.cache.bytes) }}</div>
      <button class="phone-order" :class="{ on: lanInfo.running }" title="手机扫码点歌" aria-label="手机点歌" @click="openLan">
        <Icon name="smartphone" :size="16" />
        <span>手机点歌</span>
        <i class="lan-dot"></i>
      </button>
      <button class="gear" title="设置" aria-label="设置" @click="settingsOpen = true">
        <Icon name="gear" :size="17" />
      </button>
      <div class="clock">{{ clock }}</div>
    </header>

    <main class="main" :style="mainStyle">
      <section class="left">
        <div class="stage"><VideoStage :active="hasVideo && !modalOpen" :audio="hasMedia && !hasVideo" :song="status.song" :lan-info="lanInfo" @open-lan="openLan" /></div>
        <LyricsBar v-show="!fullscreen && showLyrics" :song-id="status.song?.id || ''" :time="status.time" :playing="status.playing" @line="onLyricLine" />
        <PlayerControls
          :song-name="displayName"
          :song-singer="displaySinger"
          :has-media="hasMedia"
          :playing="status.playing"
          :state-name="status.stateName"
          :time="status.time"
          :length="status.length"
          :volume="status.volume"
          :vocal-mode="status.vocalMode"
          :strategy="status.strategy"
          :accomp="status.accomp"
          :channel-map="status.channelMap"
          :queue-length="status.queueLength || 0"
          :fullscreen="fullscreen"
          :show-lyrics="showLyrics"
          :lyrics-on-video="lyricsOnVideo"
          :pitch="status.pitch || 0"
          :pitch-supported="!!status.pitchSupported"
          @toggle="call('toggle')"
          @lyrics="toggleLyrics"
          @fullscreen="toggleFullscreen"
          @next="skipSong"
          @seek="(ms) => call('seek', ms)"
          @seek-relative="(d) => call('seekRelative', d)"
          @volume="(v) => call('setVolume', v)"
          @vocal="(m) => call('setVocalMode', m)"
          @pitch="setPitch"
          @pitch-step="stepPitch"
        />
      </section>

      <div
        v-show="!fullscreen"
        class="splitter"
        :class="{ dragging: resizing }"
        title="拖动调整右栏宽度，双击恢复自动宽度"
        @pointerdown.prevent="startResize"
        @dblclick="resetRightWidth"
      ></div>

      <aside class="right" v-show="!fullscreen">
        <div v-if="status.song" class="now-strip" :title="displayName + (displaySinger ? ' - ' + displaySinger : '')">
          <span class="now-pulse" :class="{ on: status.playing }"></span>
          <div class="now-text">
            <div class="now-name">{{ displayName }}</div>
            <div class="now-sub">{{ displaySinger || '正在播放' }}</div>
          </div>
          <span class="now-time">{{ fmtTime(status.time) }} / {{ fmtTime(status.length) }}</span>
          <button class="now-mode" @click="toggleVocalMode">{{ status.vocalMode === 'accompaniment' ? '伴唱' : '原唱' }}</button>
          <i class="now-line" :style="{ width: nowProgressPct + '%' }"></i>
        </div>
        <SidePanel
          ref="side"
          :source-mode="sourceMode"
          :current-id="status.song?.id || ''"
          :favorite-ids="favoriteIds"
          :queued-ids="status.queuedIds || []"
          :downloading="downloading"
          :queue-count="status.queueLength || 0"
          :history-count="counts.history"
          :playlist-count="counts.playlists"
          @order="orderSong"
          @order-next="orderSongNext"
          @play-now="playNowById"
          @order-by-id="orderById"
          @order-next-by-id="orderNextById"
          @top="topEntry"
          @remove="removeEntry"
          @next="skipSong"
          @favorite="toggleFavorite"
          @add-to-playlist="addToPlaylist"
          @add-online-to-playlist="addToPlaylist"
          @play-local="playLocal"
          @changed="refreshCounts"
          @set-source-mode="setSourceMode"
          @open-auth="openAuth"
        />
      </aside>
    </main>

    <PlaylistPicker ref="playlistPicker" :open="pickerOpen" @close="pickerOpen = false" @picked="onPlaylistPicked" />

    <SettingsDialog :open="settingsOpen" :status="status" @close="settingsOpen = false" @changed="onSettingsChanged" @open-auth="openAuth" @open-lan="openLan" />
    <LanQrDialog :open="lanOpen" @close="lanOpen = false" @changed="refreshLan" />
    <PlatformAuthDialog :open="authOpen" :initial-platform="authPlatform" @close="authOpen = false" @changed="onAuthChanged" />

    <transition name="toast">
      <div v-if="toast" class="toast" :class="toast.kind">{{ toast.text }}</div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import VideoStage from './components/VideoStage.vue'
import PlayerControls from './components/PlayerControls.vue'
import LyricsBar from './components/LyricsBar.vue'
import SidePanel from './components/SidePanel.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import Icon from './components/Icon.vue'
import PlaylistPicker from './components/PlaylistPicker.vue'
import PlatformAuthDialog from './components/PlatformAuthDialog.vue'
import LanQrDialog from './components/LanQrDialog.vue'

const noop = async () => {}
const emptyList = async () => []
const bridge = window.ktv || {
  library: { scan: emptyList, localFileSet: emptyList },
  catalog: new Proxy({}, { get: () => async () => ({ songs: [], hasMore: false }) }),
  queue: new Proxy({}, { get: () => async () => ({ queue: [] }) }),
  history: { list: emptyList, clear: noop },
  favorites: { list: emptyList, toggle: async () => ({ favorite: false }) },
  playlists: new Proxy({}, { get: () => async () => [] }),
  settings: { get: async () => ({}), update: noop },
  catalogUpdate: { check: async () => ({ ok: false, error: '未连接主进程' }), run: async () => ({ ok: false }) },
  player: new Proxy({}, { get: () => noop }),
  video: { setBounds: noop, setVisible: noop },
  window: { setFullscreen: noop },
  onStatus: () => () => {},
  onNotice: () => () => {},
  onDownloadProgress: () => () => {},
}

const status = ref({
  playing: false, stateName: '', time: 0, length: 0, volume: 100,
  vocalMode: 'original', strategy: 'channel', accomp: 0, channelMap: null,
  pitch: 0, pitchSupported: false,
  song: null, queueLength: 0, queuedIds: [], cache: null,
})
const clock = ref('')
const toast = ref(null)
const favoriteIds = ref([])
const downloading = ref({})
const counts = ref({ history: 0, playlists: 0 })
const side = ref(null)
const settingsOpen = ref(false)
const authOpen = ref(false)
const authPlatform = ref('qq')
const lanOpen = ref(false)
const lanInfo = ref({ running: false, disabled: false, port: 8088, url: '', addresses: [], error: '' })
const fullscreen = ref(false)
const controlsVisible = ref(true)
// 歌词条开关：MV 大多自带内嵌歌词，用户可能不需要再叠一条
const showLyrics = ref(true)
// 歌词是否画进视频画面里（ASS 字幕：居中 + 滚动 + 逐字上色）。视频是原生子窗口，HTML 叠不上去。
const lyricsOnVideo = ref(true)
// 数据源模式：maidong（麦动曲库）/ online（只用在线源）。两套环境二选一。
const sourceMode = ref('maidong')
// 界面主题：只改 <html data-theme>，颜色全在 styles.css 的变量里
const THEMES = ['dark', 'midnight', 'warm', 'light', 'neon', 'jade']
const DENSITIES = ['auto', 'comfortable', 'tv']
const theme = ref('dark')
const MIN_RIGHT = 340
const MAX_RIGHT = 620
const rightWidth = ref(null)
const windowWidth = ref(typeof window === 'undefined' ? 1440 : window.innerWidth)
const resizing = ref(false)
const currentLine = ref('')      // 当前歌词行（设置变更时用它重挂画面歌词）
let lastVideoLine = null
const pickerOpen = ref(false)
// 原生视频窗口永远盖在 HTML 之上，弹窗打开时必须把它藏掉，否则弹窗会被挖掉一块
const modalOpen = computed(() => settingsOpen.value || pickerOpen.value || authOpen.value || lanOpen.value)
const playlistPicker = ref(null)

// ⚠️ 不能只看 filePath：队列放完之后 player.stop() 并**不会清掉** filePath，
// 于是 hasMedia 一直为真 —— 原生视频窗口继续盖着（一片黑），
// VideoStage 里那句"请点歌"的占位提示永远出不来。
// 用 currentSong 判断才是对的：队列空了主进程会把它置空。
const hasMedia = computed(() => !!status.value.song && !!status.value.filePath)
const hasVideo = computed(() => hasMedia.value && status.value.song?.mediaKind !== 'audio')
const displayName = computed(() => status.value.song?.name || '')
const displaySinger = computed(() => status.value.song?.singer || '')
const nowProgressPct = computed(() => {
  const len = Number(status.value.length) || 0
  if (!len) return 0
  return Math.max(0, Math.min(100, (Number(status.value.time) || 0) / len * 100))
})
const autoRightWidth = computed(() => Math.min(480, Math.max(400, Math.round(windowWidth.value * 0.32))))
const effectiveRightWidth = computed(() => {
  const maxAllowed = Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, windowWidth.value - 520))
  const want = typeof rightWidth.value === 'number' ? rightWidth.value : autoRightWidth.value
  return Math.round(Math.min(maxAllowed, Math.max(MIN_RIGHT, want)))
})
const mainStyle = computed(() => ({ '--right-width': effectiveRightWidth.value + 'px' }))

let toastTimer = null
function showToast(text, kind = 'warn', ms = 4200) {
  toast.value = { text, kind }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, ms)
}

function fmtSize(bytes) {
  const gb = (bytes || 0) / 1024 / 1024 / 1024
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${((bytes || 0) / 1024 / 1024).toFixed(0)} MB`
}

function fmtTime(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}

async function refreshFavorites() {
  try { favoriteIds.value = await bridge.favorites.list() } catch { /* 忽略 */ }
}

async function refreshCounts() {
  try {
    const [h, p] = await Promise.all([bridge.history.list(), bridge.playlists.list()])
    counts.value = { history: h.length, playlists: p.length }
  } catch { /* 忽略 */ }
}

async function orderSong(song) {
  try {
    const r = await bridge.queue.order(song.id, {})
    if (r.duplicate) { showToast(r.message || `《${song.name}》已经在已点列表里了`); return }
    showToast(r.startedImmediately ? `开始播放：${song.name}` : `已点：${song.name}`, 'ok', 2000)
    side.value?.switchSection('queue')
    refreshCounts()
  } catch (e) { showToast('点歌失败：' + e.message) }
}

async function orderSongNext(song) {
  try {
    const r = await bridge.queue.order(song.id, { next: true })
    if (r.duplicate) { showToast(r.message || '已经在已点列表里了'); return }
    showToast(`已插到下一首：${song.name}`, 'ok', 2000)
    refreshCounts()
  } catch (e) { showToast('操作失败：' + e.message) }
}

async function orderById(songId) {
  try {
    const r = await bridge.queue.order(songId, {})
    if (r.duplicate) { showToast(r.message || '已经在已点列表里了'); return }
    showToast('已加入已点', 'ok', 1800)
    side.value?.switchSection('queue')
    refreshCounts()
  } catch (e) { showToast('点歌失败：' + e.message) }
}

async function orderNextById(songId) {
  try {
    const r = await bridge.queue.order(songId, { next: true })
    if (r.duplicate) { showToast(r.message || '已经在已点列表里了'); return }
    showToast('已插到下一首', 'ok', 1800)
    refreshCounts()
  } catch (e) { showToast('操作失败：' + e.message) }
}

async function toggleFavorite(songId) {
  try {
    const r = await bridge.favorites.toggle(songId)
    showToast(r.favorite ? '已收藏' : '已取消收藏', 'ok', 1600)
    await refreshFavorites()
    refreshCounts()
  } catch (e) { showToast('收藏失败：' + e.message) }
}

/** 加入歌单：打开正经的选择弹窗（支持键盘导航，替代原来的 window.prompt）。 */
async function addToPlaylist(song) {
  if (!song || !song.id) return
  pickerOpen.value = true
  await nextTick()
  await playlistPicker.value?.openFor(song)
}

async function onPlaylistPicked(name) {
  showToast(`已加入「${name}」`, 'ok', 2000)
  await refreshCounts()
}

/**
 * 变调（半音）。只有 mpv 内核支持——libVLC 3 没有变调滤波器，
 * 这时给出明确提示而不是静默失败。
 */
async function setPitch(semitones) {
  const v = Math.max(-6, Math.min(6, Math.round(Number(semitones) || 0)))
  if (!bridge.player?.setPitch) return
  try {
    const r = await bridge.player.setPitch(v)
    if (r && r.ok === false) {
      showToast('当前播放内核不支持变调，请到设置里把「播放内核」改成 mpv', 'warn', 4200)
      return
    }
    if (v !== 0) showToast(`变调：${v > 0 ? '升' : '降'} ${Math.abs(v)} 个半音`, 'ok', 1400)
  } catch (e) { showToast('变调失败：' + e.message) }
}

/** 相对升降半音（连点不会丢步）。 */
async function stepPitch(delta) {
  if (!bridge.player?.setPitchDelta) return
  try {
    const r = await bridge.player.setPitchDelta(delta)
    if (r && r.ok === false) {
      showToast('当前播放内核不支持变调，请到设置里把「播放内核」改成 mpv', 'warn', 4200)
      return
    }
    if (r?.pitch) showToast(`变调：${r.pitch > 0 ? '升' : '降'} ${Math.abs(r.pitch)} 个半音`, 'ok', 1200)
  } catch (e) { showToast('变调失败：' + e.message) }
}

async function topEntry(entryId) { await bridge.queue.top(entryId) }
async function removeEntry(entryId) { await bridge.queue.remove(entryId); refreshCounts() }
async function refreshLan() {
  try { if (bridge.lan?.info) lanInfo.value = await bridge.lan.info() } catch { /* 忽略 */ }
}

function openLan() {
  lanOpen.value = true
  refreshLan()
}

function openAuth(platform) {
  authPlatform.value = platform || 'qq'
  authOpen.value = true
}

function onAuthChanged() {
  side.value?.refreshAuth?.()
}

async function playNowById(songOrId) {
  const songId = typeof songOrId === 'string' ? songOrId : songOrId?.id
  if (!songId) return
  try {
    const r = await bridge.queue.playNow(songId)
    if (r?.duplicate) showToast(r.message || '这首歌已经在播放了')
    else if (r?.ok) showToast('立即播放', 'ok', 1600)
    refreshCounts()
  } catch (e) { showToast('立即唱失败：' + e.message) }
}

async function skipSong() {
  const r = await bridge.queue.next()
  if (r && r.reason === 'QUEUE_EMPTY') showToast('没有下一首了', 'warn', 2200)
  refreshCounts()
}

async function playLocal(song) {
  try {
    // 同上：Proxy 过不了 IPC 的结构化克隆
    await bridge.player.loadLocal(JSON.parse(JSON.stringify(song)))
    showToast(`开始播放：${song.name}`, 'ok', 1800)
  } catch (e) { showToast('播放失败：' + e.message) }
}

/**
 * 切「歌词显示」。
 *
 * ⚠️ 控制条上这个「词」按钮切的是**画面里的歌词**（lyricsOnVideo），
 * 不是底下那条 HTML 歌词条 —— 之前切错对象，用户关了半天画面上的字还在。
 * 底部歌词条改到设置页里开关。
 */
/**
 * 应用主题。
 * 同时写一份到 localStorage —— 下次启动时 main.js 能在**挂载之前**先贴上，
 * 不会先闪一下默认配色再切过去。
 */
function applyTheme(t) {
  const v = THEMES.includes(t) ? t : 'dark'
  theme.value = v
  document.documentElement.dataset.theme = v
  try { localStorage.setItem('ktv-theme', v) } catch { /* 存不上不影响本次 */ }
}

function applyDensity(d) {
  const v = DENSITIES.includes(d) ? d : 'auto'
  document.documentElement.dataset.density = v
  try { localStorage.setItem('ktv-density', v) } catch { /* 存不上不影响本次 */ }
}

function onWindowResize() { windowWidth.value = window.innerWidth }

function onResizeMove(e) {
  const maxAllowed = Math.max(MIN_RIGHT, Math.min(MAX_RIGHT, windowWidth.value - 520))
  rightWidth.value = Math.round(Math.min(maxAllowed, Math.max(MIN_RIGHT, window.innerWidth - e.clientX - 12)))
}

function stopResize() {
  if (!resizing.value) return
  resizing.value = false
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
  Promise.resolve(bridge.settings?.update?.({ rightPanelWidth: rightWidth.value })).catch(() => {})
}

function startResize(e) {
  resizing.value = true
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', stopResize)
  try { e.currentTarget?.setPointerCapture?.(e.pointerId) } catch { /* 合成事件/特殊设备没有 pointer capture 也能拖 */ }
}

function resetRightWidth() {
  rightWidth.value = null
  Promise.resolve(bridge.settings?.update?.({ rightPanelWidth: null })).catch(() => {})
}

async function toggleVocalMode() {
  const next = status.value.vocalMode === 'accompaniment' ? 'original' : 'accompaniment'
  await call('setVocalMode', next)
}

async function toggleLyrics() {
  lyricsOnVideo.value = !lyricsOnVideo.value
  lastVideoLine = null
  try { await bridge.settings.update({ lyricsOnVideo: lyricsOnVideo.value }) } catch { /* 存不上也不影响本次 */ }
}

/** 切数据源模式（麦动曲库 / 在线源）。 */
async function setSourceMode(mode) {
  const m = mode === 'online' ? 'online' : 'maidong'
  if (m === sourceMode.value) return
  sourceMode.value = m
  try { await bridge.settings.update({ sourceMode: m }) } catch { /* 存不上也不影响本次 */ }
  showToast(m === 'online'
    ? '已切到「在线源」：视频更流畅，冷门歌可能搜不到'
    : '已切到「麦动曲库」：歌最全，但 MV 片源可能卡', 'ok', 3200)
}

/**
 * 当前歌词行 → 交给主进程用 libVLC marquee 画在视频画面上。
 * 同一行不重复下发（这个回调会随播放进度频繁触发）。
 */
async function onLyricLine(text) {
  currentLine.value = text || ''
  const want = lyricsOnVideo.value ? currentLine.value : ''
  if (want === lastVideoLine) return
  lastVideoLine = want
  try { await bridge.lyrics.setVideoText(want) } catch { /* 忽略 */ }
}

/**
 * 设置页改动后的回流。
 *
 * ⚠️ 这里必须把歌词开关同步回本地 ref。
 * 之前 @changed 只刷新了收藏/计数，改「歌词显示」要**重启应用**才生效 ——
 * 用户在设置里点半天没反应，只会以为是坏了。
 */
async function onSettingsChanged() {
  refreshFavorites()
  refreshCounts()
  try {
    const s = await bridge.settings.get()
    // 主题改动要立刻生效（在设置页点一下就得变）
    if (typeof s.theme === 'string' && s.theme !== theme.value) applyTheme(s.theme)
    if (typeof s.uiDensity === 'string') applyDensity(s.uiDensity)
    if (s.rightPanelWidth === null || typeof s.rightPanelWidth === 'number') rightWidth.value = s.rightPanelWidth
    let changed = false
    if (typeof s.showLyrics === 'boolean' && s.showLyrics !== showLyrics.value) {
      showLyrics.value = s.showLyrics; changed = true
    }
    if (typeof s.lyricsOnVideo === 'boolean' && s.lyricsOnVideo !== lyricsOnVideo.value) {
      lyricsOnVideo.value = s.lyricsOnVideo; changed = true
    }
    // 立刻按新开关重挂/摘掉画面里的歌词
    if (changed) { lastVideoLine = null; await onLyricLine(currentLine.value) }
  } catch { /* 忽略 */ }
}

async function toggleFullscreen() {
  fullscreen.value = !fullscreen.value
  controlsVisible.value = true
  bumpActivity()
  await bridge.window.setFullscreen(fullscreen.value)
  // 布局变化后要重新上报视频区，否则原生窗口还停在旧位置
  setTimeout(() => window.dispatchEvent(new Event("resize")), 120)
}

async function call(method, ...args) {
  const fn = bridge.player[method]
  if (typeof fn === 'function') await fn(...args)
}

function bumpActivity() {
  controlsVisible.value = true
  clearTimeout(activityTimer)
  if (fullscreen.value) activityTimer = setTimeout(() => { controlsVisible.value = false }, 3200)
}

function isEditableTarget(e) {
  const tag = (el) => String(el?.tagName || '').toUpperCase()
  const t = e?.target
  if (e?.isComposing || t?.isContentEditable) return true
  if (tag(t) === 'INPUT' || tag(t) === 'TEXTAREA' || tag(t) === 'SELECT') return true
  const active = document.activeElement
  return tag(active) === 'INPUT' || tag(active) === 'TEXTAREA' || tag(active) === 'SELECT' || active?.isContentEditable
}

function onKey(e) {
  bumpActivity()
  if (isEditableTarget(e)) return
  const k = e.key.toLowerCase()
  if (e.code === 'Space') { e.preventDefault(); call('toggle') }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); call('seekRelative', -5000) }
  else if (e.key === 'ArrowRight') { e.preventDefault(); call('seekRelative', 5000) }
  else if (k === 'o') call('setVocalMode', 'original')
  else if (k === 'a') call('setVocalMode', 'accompaniment')
  else if (k === 'n') skipSong()
  else if (k === 'f') toggleFullscreen()
  else if (e.key === '[') stepPitch(-1)
  else if (e.key === ']') stepPitch(1)
  else if (e.key === '\\') setPitch(0)
  else if (e.key === 'Escape' && fullscreen.value) toggleFullscreen()
}

let offStatus = null, offNotice = null, offDownload = null, offVideoDbl = null, offUiActivity = null, clockTimer = null, countTimer = null, activityTimer = null, lanTimer = null

onMounted(async () => {
  offStatus = bridge.onStatus((s) => { status.value = s })
  // 视频区双击由主进程检测后通知（原生视频窗口会吞掉 HTML 的鼠标事件）
  offVideoDbl = bridge.video?.onDoubleClick?.(() => toggleFullscreen())
  offUiActivity = bridge.onUiActivity?.(() => bumpActivity())
  window.addEventListener('mousemove', bumpActivity)
  window.addEventListener('pointerdown', bumpActivity)
  offNotice = bridge.onNotice((n) => showToast(n.text, n.kind === 'ok' ? 'ok' : 'warn', 5200))
  offDownload = bridge.onDownloadProgress((p) => {
    downloading.value = { ...downloading.value, [p.filename]: p }
    if (p.state === 'done') side.value?.refreshLocalFiles()
    else if (p.state === 'failed') showToast(`《${p.name}》缓存失败：${p.error}`, 'warn', 4200)
  })
  clockTimer = setInterval(() => {
    clock.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  }, 1000)
  countTimer = setInterval(refreshCounts, 3000)
  lanTimer = setInterval(refreshLan, 5000)
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onWindowResize)

  await refreshFavorites()
  await refreshCounts()
  await refreshLan()

  try {
    const s = await bridge.settings.get()
    if (typeof s.volume === 'number') await bridge.player.setVolume(s.volume)
    if (s.defaultVocalMode) await bridge.player.setVocalMode(s.defaultVocalMode)
    if (typeof s.showLyrics === 'boolean') showLyrics.value = s.showLyrics
    if (typeof s.lyricsOnVideo === 'boolean') lyricsOnVideo.value = s.lyricsOnVideo
    if (typeof s.sourceMode === 'string') sourceMode.value = s.sourceMode === 'online' ? 'online' : 'maidong'
    if (typeof s.theme === 'string') applyTheme(s.theme)
    if (typeof s.uiDensity === 'string') applyDensity(s.uiDensity)
    else applyDensity(localStorage.getItem('ktv-density') || 'auto')
    if (s.rightPanelWidth === null || typeof s.rightPanelWidth === 'number') rightWidth.value = s.rightPanelWidth
  } catch { /* 忽略 */ }
})

onBeforeUnmount(() => {
  offStatus?.(); offNotice?.(); offDownload?.(); offVideoDbl?.(); offUiActivity?.()
  window.removeEventListener('mousemove', bumpActivity)
  window.removeEventListener('pointerdown', bumpActivity)
  clearInterval(clockTimer); clearInterval(countTimer); clearInterval(lanTimer); clearTimeout(toastTimer); clearTimeout(activityTimer)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
})
</script>

<style scoped>
.app { display: grid; grid-template-rows: 48px 1fr; height: 100%; }
/* 全屏：藏顶栏，让画面铺满整个窗口 */
.app.fullscreen { grid-template-rows: 1fr; }
.app.fullscreen .topbar { display: none; }
.app.fullscreen .main { grid-template-columns: minmax(0, 1fr); padding: 0; gap: 0; }
.app.fullscreen .splitter, .app.fullscreen .right { display: none !important; }
.app.controls-hidden :deep(.controls) { display: none !important; }
.app.fullscreen .left { gap: 0; }

.topbar {
  position: relative;
  display: flex; align-items: center; gap: 14px;
  padding: 0 16px; background: var(--panel-2); border-bottom: 1px solid var(--line);
}
.brand { font-size: 16px; font-weight: 600; letter-spacing: .5px; }
.spacer { flex: 1; }
.stat { font-size: 12px; color: var(--dim); }
.stat.chip { padding: 4px 9px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); color: var(--text-2); }
.clock { font-size: 13px; color: var(--dim); font-variant-numeric: tabular-nums; }
/* 数据源二选一（顶栏）：一行小分段控件，选中的整块高亮 */
.src-switch {
  display: flex; gap: 2px; padding: 2px; flex: none;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
}
.src-switch button {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 10px; font-size: 12px; border: 0; border-radius: 6px;
  background: transparent; color: var(--dim); white-space: nowrap;
}
.src-switch button:hover:not(.on) { color: var(--text); background: var(--row-hover); }
.src-switch.mode-maidong button.on { background: var(--focus-fill); color: var(--on-focus); font-weight: 600; }
.src-switch.mode-online button.on { background: var(--online-fill); color: var(--online-text); font-weight: 600; }

.gear { padding: 6px 9px; font-size: 15px; line-height: 1; display: flex; align-items: center; }
.phone-order { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 6px 9px; font-size: 12px; color: var(--dim); }
.phone-order:hover, .phone-order.on { color: var(--focus); }
.lan-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dim-2); }
.phone-order.on .lan-dot { background: #35c46a; box-shadow: 0 0 7px rgba(53,196,106,.7); }
.gear:hover { color: var(--focus); }

.main {
  /* 三列：左画面 / 拖拽条 / 右栏。右栏宽度由 App.vue 计算并允许拖动。 */
  display: grid;
  grid-template-columns: minmax(0, 1fr) 10px var(--right-width, 400px);
  gap: 0; padding: 12px; min-height: 0;
}
.splitter { position: relative; grid-column: 2; cursor: col-resize; }
.splitter::before {
  content: ''; position: absolute; top: 8px; bottom: 8px; left: 4px; width: 2px;
  border-radius: 999px; background: var(--line); transition: background .15s, box-shadow .15s;
}
.splitter:hover::before, .splitter.dragging::before {
  background: var(--focus); box-shadow: 0 0 9px color-mix(in srgb, var(--focus) 70%, transparent);
}
/* grid-template-columns 必须显式写 minmax(0,1fr)：
   否则隐式列会被内容撑宽（实测多出 24px），原生视频窗口就会压到右栏上 */
.left {
  grid-column: 1;
  display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: 1fr auto auto;
  gap: 10px; min-height: 0; min-width: 0;
}
.stage { min-height: 0; min-width: 0; overflow: hidden; }

.right {
  grid-column: 3;
  display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; min-height: 0; overflow: hidden;
}
.right > :deep(.side-panel) { flex: 1; min-height: 0; }

/* 右栏顶部正在播放条：切到已点/收藏时也能知道当前曲目。 */
.now-strip {
  position: relative; flex: none; display: flex; align-items: center; gap: 8px;
  min-height: 42px; padding: 7px 10px 8px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
  overflow: hidden;
}
.now-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--line-2); flex: none; }
.now-pulse.on { background: var(--focus); box-shadow: 0 0 8px var(--focus); }
.now-text { flex: 1; min-width: 0; }
.now-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.now-sub { margin-top: 1px; font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.now-time { flex: none; font-size: 11px; color: var(--dim); font-variant-numeric: tabular-nums; }
.now-mode { flex: none; padding: 3px 7px; font-size: 11px; border-radius: 999px; background: var(--focus-fill); border-color: var(--focus-border); color: var(--on-focus); }
.now-line { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--focus); opacity: .85; transition: width .2s; }


.toast {
  position: fixed; left: 50%; bottom: 90px; transform: translateX(-50%);
  max-width: 720px; padding: 12px 20px; border-radius: 10px; font-size: 14px;
  background: var(--gold-bg); color: var(--gold-text); border: 1px solid var(--gold-line);
  box-shadow: 0 8px 28px rgba(0,0,0,.5); z-index: 50;
}
.toast.ok { background: var(--focus-fill); color: var(--on-focus); border-color: var(--focus-hover); }
.toast-enter-active, .toast-leave-active { transition: opacity .18s, transform .18s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 8px); }
</style>
