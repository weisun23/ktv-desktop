<template>
  <div class="queue-panel">
    <div class="toolbar">
      <span class="crumb">{{ crumb }}</span>
      <div class="spacer"></div>
      <template v-if="section === 'queue'">
        <button @click="$emit('next')" :disabled="!waitingCount" :title="waitingCount ? '播放下一首' : '没有下一首'">切歌</button>
        <button @click="clearQueue" :disabled="!queue.length">清空</button>
      </template>
      <template v-else-if="section === 'history'">
        <button @click="clearHistory" :disabled="!history.length">清空</button>
      </template>
      <template v-else-if="section === 'playlists' && !currentPlaylist">
        <button @click="newPlaylist">新建歌单</button>
      </template>
    </div>

    <div class="list">
      <!-- 已点 -->
      <template v-if="section === 'queue'">
        <div v-if="!queue.length" class="empty">还没有点歌<br /><small>从左边曲库双击一首吧</small></div>
        <div
          v-for="(q, i) in visibleRows"
          :key="q.entryId"
          class="row"
          :class="{ playing: q.status === 'playing' }"
          :draggable="q.status !== 'playing'"
          @dragstart="onDragStart(q.entryId, $event)"
          @dragover.prevent="onDragOver(q.entryId, $event)"
          @drop.prevent="onDrop(q.entryId, 'queue')"
          @dragend="onDragEnd"
          @contextmenu.prevent="showMenu($event, q, i)"
        >
          <span class="lead">
            <img v-if="coverUrl(q)" class="avatar" :src="coverUrl(q)" alt="" loading="lazy" referrerpolicy="no-referrer" @error="hideBrokenCover" />
            <span v-else class="avatar avatar-none" :style="{ background: avatarTint(q.name) }">{{ (q.name || '?').slice(0, 1) }}</span>
            <i v-if="q.status === 'playing'" class="play-badge"><Icon name="play" :size="9" :fill="true" /></i>
            <b v-else class="num">{{ i + 1 }}</b>
          </span>
          <span class="name" :title="q.name">{{ q.name }}</span>
          <span class="singer"><span class="singer-name">{{ q.singer || '—' }}</span><i class="source-badge" :title="sourceTitle(q)">{{ sourceLabel(q) }}</i></span>
          <span class="actions">
            <button
              class="mini"
              :class="{ faved: isFavorite(q.songId) }"
              :title="isFavorite(q.songId) ? '取消收藏' : '收藏'"
              @click="$emit('favorite', q.songId)"
            ><Icon :name="isFavorite(q.songId) ? 'heart-filled' : 'heart'" :size="14" :fill="isFavorite(q.songId)" /></button>
            <button v-if="q.status !== 'playing'" @click="$emit('top', q.entryId)" title="下一首播放">置顶</button>
            <template v-if="q.status !== 'playing'">
              <button class="ord" :disabled="!canMove(q, -1)" @click="moveEntry(q, -1)" title="上移一位"><Icon name="arrow-up" :size="13" /></button>
              <button class="ord" :disabled="!canMove(q, 1)" @click="moveEntry(q, 1)" title="下移一位"><Icon name="arrow-down" :size="13" /></button>
            </template>
            <button @click="$emit('remove', q.entryId)" title="从队列移除"><Icon name="trash" :size="13" /></button>
          </span>
          <div
            v-if="onlineTask(q)"
            class="online-task"
            :class="['phase-' + onlineTask(q).phase, { indeterminate: onlineTask(q).phase === 'downloading' && onlineTaskPct(q) === 0 }]"
            :title="onlineTask(q).error || onlineTaskLabel(q)"
          >
            <span class="ot-text">{{ onlineTaskLabel(q) }}</span>
            <span class="ot-bar"><i :style="{ width: onlineTaskPct(q) + '%' }"></i></span>
            <span v-if="onlineTask(q).phase === 'downloading'" class="ot-pct">{{ onlineTaskPct(q) }}%</span>
          </div>
        </div>
      </template>

      <!-- 已唱 -->
      <template v-else-if="section === 'history'">
        <div v-if="!history.length" class="empty">还没有唱过</div>
        <!-- 统计：数据本来就有，只是没展示过 -->
        <div v-else class="stats">
          <span class="st"><b>{{ history.length }}</b> 首</span>
          <span class="st"><b>{{ historyStats.singers }}</b> 位歌手</span>
          <span class="st">最近 7 天 <b>{{ historyStats.week }}</b> 首</span>
          <span v-if="historyStats.topSinger" class="st top">
            唱最多：<b>{{ historyStats.topSinger.name }}</b>（{{ historyStats.topSinger.count }} 首）
          </span>
        </div>
        <!-- 最近 30 天柱状图：纯 CSS，不引图表库 -->
        <div v-if="history.length" class="chart" title="最近 30 天每天唱了几首">
          <div v-for="d in last30Days" :key="d.key" class="bar-wrap"
            :title="d.label + '：' + d.count + ' 首'">
            <div class="bar" :class="{ on: d.count }" :style="{ height: d.height }"></div>
          </div>
        </div>
        <div
          v-for="h in visibleRows"
          :key="h.songId + h.playedAt"
          class="row"
          @contextmenu.prevent="showHistoryMenu($event, h)"
        >
          <span class="lead">
            <img v-if="coverUrl(h)" class="avatar" :src="coverUrl(h)" alt="" loading="lazy" referrerpolicy="no-referrer" @error="hideBrokenCover" />
            <span v-else class="avatar avatar-none" :style="{ background: avatarTint(h.name) }">{{ (h.name || '?').slice(0, 1) }}</span>
          </span>
          <span class="name">{{ h.name }}</span>
          <span class="singer"><span class="singer-name">{{ h.singer || '—' }}</span><i class="source-badge" :title="sourceTitle(h)">{{ sourceLabel(h) }}</i></span>
          <span class="actions">
            <button
              class="mini"
              :class="{ faved: isFavorite(h.songId) }"
              :title="isFavorite(h.songId) ? '取消收藏' : '收藏'"
              @click="$emit('favorite', h.songId)"
            ><Icon :name="isFavorite(h.songId) ? 'heart-filled' : 'heart'" :size="14" :fill="isFavorite(h.songId)" /></button>
            <button @click="orderRow(h)">点歌</button>
            <button class="ord danger" :disabled="h.songId === currentId" :title="h.songId === currentId ? '正在播放，不能删除' : '删除本地源文件'" @click="deleteHistoryItem(h)"><Icon name="trash" :size="13" /></button>
          </span>
        </div>
      </template>

      <!-- 收藏 -->
      <template v-else-if="section === 'favorites'">
        <div v-if="!favorites.length" class="empty">还没有收藏<br /><small>在曲库列表里点收藏按钮，或右键收藏</small></div>
        <div v-for="s in visibleRows" :key="s.id" class="row" draggable="true"
          @dragstart="onDragStart(s.id, $event)"
          @dragover.prevent="onDragOver(s.id, $event)"
          @drop.prevent="onDrop(s.id, 'favorites')"
          @dragend="onDragEnd"
          @contextmenu.prevent="showSongMenu($event, s)">
          <span class="lead">
            <img v-if="coverUrl(s)" class="avatar" :src="coverUrl(s)" alt="" loading="lazy" referrerpolicy="no-referrer" @error="hideBrokenCover" />
            <span v-else class="avatar avatar-none" :style="{ background: avatarTint(s.name) }">{{ (s.name || '?').slice(0, 1) }}</span>
          </span>
          <span class="name">{{ s.name }}</span>
          <span class="singer"><span class="singer-name">{{ s.singer || '—' }}</span><i class="source-badge" :title="sourceTitle(s)">{{ sourceLabel(s) }}</i></span>
          <span class="actions">
            <button @click="orderRow(s)">点歌</button>
            <button class="ord" :disabled="!canMoveIn(favorites, s.id, -1)" @click="moveFavorite(s.id, -1)" title="上移一位"><Icon name="arrow-up" :size="13" /></button>
            <button class="ord" :disabled="!canMoveIn(favorites, s.id, 1)" @click="moveFavorite(s.id, 1)" title="下移一位"><Icon name="arrow-down" :size="13" /></button>
            <button @click="unfavorite(s.id)">取消</button>
          </span>
        </div>
      </template>

      <!-- 歌单 -->
      <template v-else-if="section === 'playlists'">
        <div v-if="currentPlaylist">
          <div class="row playlist-head">
            <button class="back" @click="currentPlaylist = null">« 返回歌单</button>
            <span class="name">{{ currentPlaylist }}</span>
          </div>
          <div v-if="!playlistSongs.length" class="empty">这个歌单还是空的</div>
          <div v-for="s in visibleRows" :key="s.id" class="row" draggable="true"
            @dragstart="onDragStart(s.id, $event)"
            @dragover.prevent="onDragOver(s.id, $event)"
            @drop.prevent="onDrop(s.id, 'playlist')"
            @dragend="onDragEnd"
            @contextmenu.prevent="showSongMenu($event, s)">
            <span class="lead">
              <img v-if="coverUrl(s)" class="avatar" :src="coverUrl(s)" alt="" loading="lazy" referrerpolicy="no-referrer" @error="hideBrokenCover" />
              <span v-else class="avatar avatar-none" :style="{ background: avatarTint(s.name) }">{{ (s.name || '?').slice(0, 1) }}</span>
            </span>
            <span class="name">{{ s.name }}</span>
            <span class="singer">{{ s.singer || '—' }}</span>
            <span class="actions">
              <button @click="orderById(s.id)">点歌</button>
              <button class="ord" :disabled="!canMoveIn(playlistSongs, s.id, -1)" @click="moveInPlaylist(s.id, -1)" title="上移一位"><Icon name="arrow-up" :size="13" /></button>
              <button class="ord" :disabled="!canMoveIn(playlistSongs, s.id, 1)" @click="moveInPlaylist(s.id, 1)" title="下移一位"><Icon name="arrow-down" :size="13" /></button>
              <button @click="removeFromPlaylist(s.id)">移出</button>
            </span>
          </div>
        </div>
        <template v-else>
          <div v-if="!playlists.length" class="empty">还没有歌单</div>
          <div v-for="p in visibleRows" :key="p.name" class="row">
            <span class="idx"><Icon name="music" :size="14" /></span>
            <span class="name">{{ p.name }}</span>
            <span class="singer">{{ p.count }} 首</span>
            <span class="actions">
              <button @click="openPlaylist(p.name)">打开</button>
              <button v-if="p.name !== '我的收藏'" @click="deletePlaylist(p.name)">删除</button>
            </span>
          </div>
        </template>
      </template>
    </div>

    <!-- ⚠️ 分页条放在**滚动区外面**：放在 .list 里会压住最后一行。
         已唱/收藏/歌单都可能几百条，一次渲染既慢又难翻，所以显式分页。 -->
    <div v-if="currentRows.length > pageSize" class="pager">
        <label class="psize" title="每页显示多少条">
          每页
          <select :value="pageSize" @change="setPageSize(Number($event.target.value))">
            <option v-for="n in PAGE_OPTIONS" :key="n" :value="n">{{ n }}</option>
          </select>
          条
        </label>
        <button class="pg" aria-label="第一页" :disabled="page <= 1" @click="page = 1" title="第一页"><Icon name="chevrons-left" :size="14" /></button>
        <button class="pg" aria-label="上一页" :disabled="page <= 1" @click="page--" title="上一页"><Icon name="chevron-left" :size="14" /></button>
        <span class="pinfo">
          第 <input class="pjump" type="number" min="1" :max="totalPages" :value="page"
            title="输入页码后回车跳转" @keydown.enter="jumpTo($event)" @blur="jumpTo($event)" />
          / {{ totalPages }} 页
        </span>
        <button class="pg" aria-label="下一页" :disabled="page >= totalPages" @click="page++" title="下一页"><Icon name="chevron-right" :size="14" /></button>
        <button class="pg" aria-label="最后一页" :disabled="page >= totalPages" @click="page = totalPages" title="最后一页"><Icon name="chevrons-right" :size="14" /></button>
    </div>

    <ContextMenu ref="menu" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import ContextMenu from './ContextMenu.vue'
import Icon from './Icon.vue'

const props = defineProps({
  section: { type: String, default: 'queue' },   // queue | history | favorites | playlists
  favoriteIds: { type: Array, default: () => [] },
  queuedIds: { type: Array, default: () => [] },
  currentId: { type: String, default: '' },
})
const emit = defineEmits(['order', 'playNow', 'top', 'remove', 'next', 'favorite', 'changed', 'addToPlaylist'])

// 浏览器里预览界面时的降级（Electron 里走 window.ktv）
const bridge = window.ktv || {
  queue: { list: async () => ({ queue: [] }), clear: async () => {}, move: async () => false, moveTo: async () => false },
  history: { list: async () => [], clear: async () => {}, remove: async () => false },
  favorites: { move: async () => false, moveTo: async () => false },
  playlists: new Proxy({}, { get: () => async () => [] }),
  catalog: new Proxy({}, { get: () => async () => null }),
  cache: { removeFile: async () => false },
  covers: { lookup: async () => ({}) },
}
const menu = ref(null)
const queue = ref([])
const onlineProgress = ref({})
const history = ref([])
const covers = ref({})
const favorites = ref([])
const playlists = ref([])
const currentPlaylist = ref(null)
const playlistSongs = ref([])

/**
 * 分页：每次渲染 PAGE 条。
 * 已唱是只增不减的列表，收藏和歌单也可能上百条 —— 一次性渲染几百个 DOM
 * 既慢又难翻，所以统一分页。
 */
const PAGE_OPTIONS = [20, 30, 50, 100]
const pageSize = ref(30)
const page = ref(1)

/** 当前分区的完整列表（未分页） */
const currentRows = computed(() => {
  if (props.section === 'queue') return queue.value
  if (props.section === 'history') return history.value
  if (props.section === 'favorites') return favorites.value
  if (props.section === 'playlists') return currentPlaylist.value ? playlistSongs.value : playlists.value
  return []
})
/**
 * 已唱统计。
 * history 是去重后的（同一首只留最近一次），所以这里的口径是"去重后的记录"。
 */
const historyStats = computed(() => {
  const h = history.value
  const singers = new Set(h.map((x) => x.singer).filter(Boolean))
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
  const week = h.filter((x) => Number(x.playedAt) >= weekAgo).length
  const bySinger = new Map()
  for (const x of h) {
    const s = x.singer
    if (!s) continue
    bySinger.set(s, (bySinger.get(s) || 0) + 1)
  }
  let topSinger = null
  for (const [name, count] of bySinger) {
    if (!topSinger || count > topSinger.count) topSinger = { name, count }
  }
  return { singers: singers.size, week, topSinger }
})

/** 最近 30 天每天唱了几首（按 playedAt 归日） */
const last30Days = computed(() => {
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  const counts = new Map()
  for (const x of history.value) {
    const t = Number(x.playedAt)
    if (!t) continue
    const k = dayKey(new Date(t))
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  const days = []
  const today = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const k = dayKey(d)
    days.push({ key: k, label: `${d.getMonth() + 1}/${d.getDate()}`, count: counts.get(k) || 0 })
  }
  const max = Math.max(1, ...days.map((d) => d.count))
  // 最低给 3px，让"0 首"的日子也看得见一条基线
  for (const d of days) d.height = d.count ? Math.max(4, Math.round((d.count / max) * 34)) + 'px' : '2px'
  return days
})

const totalPages = computed(() => Math.max(1, Math.ceil(currentRows.value.length / pageSize.value)))
const visibleRows = computed(() =>
  currentRows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))

/** 改每页条数：回到第 1 页（页码会失去意义） */
async function setPageSize(n) {
  const v = PAGE_OPTIONS.includes(Number(n)) ? Number(n) : 30
  if (v === pageSize.value) return
  pageSize.value = v
  page.value = 1
  try { await bridge.settings.update({ pageSize: v }) } catch { /* 存不上也不影响本次 */ }
}

/** 输入框跳页 */
function jumpTo(e) {
  const raw = Number(e.target.value)
  if (!Number.isFinite(raw) || raw < 1) { e.target.value = page.value; return }
  const target = Math.min(totalPages.value, Math.round(raw))
  e.target.value = target
  if (target !== page.value) page.value = target
}

const waitingCount = computed(() => queue.value.filter((q) => q.status === 'waiting').length)
const crumb = computed(() => {
  if (props.section === 'queue') return `等待 ${queue.value.filter((q) => q.status === 'waiting').length} 首`
  if (props.section === 'history') return `最近 ${history.value.length} 首`
  if (props.section === 'favorites') return `${props.favoriteIds.length} 首`
  return currentPlaylist.value || `${playlists.value.length} 个歌单`
})

function isFavorite(id) { return props.favoriteIds.includes(id) }
function isQueued(id) { return props.queuedIds.includes(id) }

/**
 * 按 id 列表取曲目。
 * 走批量接口：原来逐首 songById，200 首要 200 次往返，实测要等好几秒。
 */
/**
 * 按 id 列表取曲目。
 *
 * 歌单里可能混着两种 id：
 *   - 曲库 id（uuid）        -> 批量查曲库
 *   - "online:<平台>:<id>"   -> 从「在线收藏」里还原（加歌单时已存过元数据）
 * 返回值保持传入顺序。
 */
async function loadSongs(ids) {
  const list = (ids || []).slice(0, 500)
  if (!list.length) return []
  const onlineIds = list.filter((x) => String(x).startsWith('online:'))
  const localIds = list.filter((x) => !String(x).startsWith('online:'))

  const byId = new Map()
  if (localIds.length) {
    try {
      const songs = bridge.catalog.songs
        ? await bridge.catalog.songs(localIds)
        : await (async () => {
            const out = []   // 老 preload 没有批量接口时退回逐个取
            for (const id of localIds) {
              try { const s = await bridge.catalog.song(id); if (s) out.push(s) } catch { /* 已下架 */ }
            }
            return out
          })()
      for (const s of songs) byId.set(String(s.id), s)
    } catch { /* 忽略 */ }
  }
  if (onlineIds.length) {
    try {
      const saves = (await bridge.onlineSaves?.list?.()) || []
      const map = new Map(saves.map((x) => [x.platform + ':' + x.id, x]))
      for (const id of onlineIds) {
        const it = map.get(String(id).slice('online:'.length))
        if (!it) continue
        // 转成和曲库歌一样的形状，列表模板不用分叉
        byId.set(String(id), {
          id: String(id), platformId: it.id, name: it.title, singer: it.artist,
          lang: '', accomp: 0, online: true, platform: it.platform,
          mvId: it.mvId, cover: it.cover, duration: it.duration,
        })
      }
    } catch { /* 忽略 */ }
  }
  return list.map((id) => byId.get(String(id))).filter(Boolean)
}

function avatarTint(name) {
  let h = 0
  for (const ch of String(name || '?')) h = (h * 31 + ch.codePointAt(0)) % 360
  return `linear-gradient(140deg, hsl(${h} 40% 34%), hsl(${(h + 42) % 360} 36% 22%))`
}
function coverId(x) { return String(x?.songId || x?.id || '') }
function coverUrl(x) { return x?.cover || covers.value[coverId(x)] || '' }
function hideBrokenCover(e) { e.target.style.display = 'none' }
async function loadCovers(rows) {
  const items = (rows || []).map((x) => ({ id: coverId(x), name: x.name, singer: x.singer }))
    .filter((x) => x.id && x.name && !covers.value[x.id] && !String(x.id).startsWith('online:'))
  if (!items.length || !bridge.covers?.lookup) return
  try {
    const known = await bridge.covers.lookup(items)
    if (known && Object.keys(known).length) covers.value = { ...covers.value, ...known }
  } catch { /* 忽略 */ }
}

function sourceLabel(row) {
  const p = row?.platform
  if (p === 'qq') return 'QQ'
  if (p === 'netease') return '网易'
  if (p === 'kugou') return '酷狗'
  if (p === 'migu') return '咪咕'
  if (p === 'kuwo') return '酷我'
  if (row?.online || row?.playSource === 'online') return '在线'
  return '麦动'
}

function sourceTitle(row) {
  const p = row?.platform
  if (p === 'qq') return '来源：QQ音乐'
  if (p === 'netease') return '来源：网易云音乐'
  if (p === 'kugou') return '来源：酷狗音乐'
  if (p === 'migu') return '来源：咪咕音乐'
  if (p === 'kuwo') return '来源：酷我音乐'
  if (row?.online || row?.playSource === 'online') return '来源：在线源'
  return '来源：麦动曲库'
}

function onlineTask(q) {
  return q?.online ? onlineProgress.value[q.songId] : null
}

function onlineTaskPct(q) {
  const n = Number(onlineTask(q)?.percent) || 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

function onlineTaskLabel(q) {
  const t = onlineTask(q)
  if (!t) return ''
  if (t.phase === 'queued') return '排队缓存…'
  if (t.phase === 'resolving') return '解析中…'
  if (t.phase === 'downloading') return '下载中'
  if (t.phase === 'streaming') return '在线播放中'
  if (t.phase === 'hls') return '在线播放中 · HLS'
  if (t.phase === 'done') return q.status === 'playing' ? '已缓存 · 播放中' : '已缓存，待播放'
  if (t.phase === 'failed') return '缓存失败'
  return '准备中…'
}

async function refreshQueue() {
  const r = await bridge.queue.list()
  queue.value = r.queue || []
  onlineProgress.value = r.onlineProgress || {}
}
async function refreshHistory() { history.value = await bridge.history.list() }
async function refreshFavorites() { favorites.value = await loadSongs(props.favoriteIds) }
async function refreshPlaylists() { playlists.value = await bridge.playlists.list() }

async function loadPageSizePref() {
  try {
    const s = await bridge.settings?.get?.()
    if (PAGE_OPTIONS.includes(Number(s?.pageSize))) pageSize.value = Number(s.pageSize)
  } catch { /* 忽略 */ }
}

async function refreshAll() {
  await Promise.all([refreshQueue(), refreshHistory(), refreshPlaylists()])
  await refreshFavorites()
}

// 换分区、进/出歌单都要回到第一页，否则会带着上一页的页码
watch(() => [props.section, currentPlaylist.value], () => { page.value = 1 })
// 数据变短时（比如删到不足一页）把页码拉回有效范围，否则会停在空白页
watch([currentRows, totalPages], () => { if (page.value > totalPages.value) page.value = totalPages.value })

/**
 * 上移/下移。
 *
 * 为什么用按钮而不是拖拽：KTV 现场多半是遥控器/小键盘，
 * 拖拽在遥控器上根本没法操作；按钮还能给键盘留出焦点。
 *
 * 边界判断放在前端是为了让按钮**置灰**（用户一眼知道到头了），
 * 真正的移动由主进程按权威数据做。
 */
function canMoveIn(list, id, delta) {
  const idx = list.findIndex((x) => String(x.id ?? x.songId) === String(id))
  if (idx < 0) return false
  return idx + delta >= 0 && idx + delta < list.length
}

/** 队列里只能挪"等待中"的条目，而且中间可能夹着正在播的那条 */
function canMove(entry, delta) {
  const waiting = queue.value.filter((q) => q.status === 'waiting')
  const idx = waiting.findIndex((q) => q.entryId === entry.entryId)
  if (idx < 0) return false
  return idx + delta >= 0 && idx + delta < waiting.length
}

/**
 * 拖拽排序。
 *
 * 和 ↑↓ 按钮**并存**：按钮给遥控器/键盘，拖拽给鼠标。
 * 用 HTML5 原生拖拽事件，不引第三方库。
 */
const dragId = ref('')
const dragOverId = ref('')

function onDragStart(id, e) {
  dragId.value = String(id)
  try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId.value) } catch { /* 忽略 */ }
}
function onDragOver(id) { dragOverId.value = String(id) }
function onDragEnd() { dragId.value = ''; dragOverId.value = '' }

async function onDrop(targetId, kind) {
  const from = dragId.value
  dragId.value = ''; dragOverId.value = ''
  if (!from || from === String(targetId)) return
  try {
    if (kind === 'queue') { await bridge.queue.moveTo(from, String(targetId)); await refreshQueue() }
    else if (kind === 'favorites') { await bridge.favorites.moveTo(from, String(targetId)); await refreshFavorites(); emit('changed') }
    else if (kind === 'playlist') { playlistSongs.value = await bridge.playlists.moveTo(currentPlaylist.value, from, String(targetId)) }
  } catch { /* 忽略 */ }
}

async function moveEntry(entry, delta) {
  await bridge.queue.move(entry.entryId, delta)
  await refreshQueue()
}
async function moveFavorite(songId, delta) {
  await bridge.favorites.move(songId, delta)
  await refreshFavorites()
  emit('changed')
}
async function moveInPlaylist(songId, delta) {
  playlistSongs.value = await bridge.playlists.move(currentPlaylist.value, songId, delta)
}

function onlinePayload(row) {
  const id = String(row?.platformId || row?.id || '')
  const parts = String(row?.id || '').split(':')
  const platformId = row?.platformId || (parts[0] === 'online' ? parts.slice(2).join(':') : id)
  return {
    id: platformId, platform: row?.platform,
    title: row?.name || row?.title, artist: row?.singer || row?.artist,
    mvId: row?.mvId, cover: row?.cover, duration: row?.duration,
  }
}

async function orderRow(row) {
  const id = row?.songId || row?.id
  if (row?.platform && row?.platformId && !isQueued(id)) {
    const r = await bridge.queue.orderOnline(onlinePayload(row), {})
    if (r?.duplicate) return
    emit('changed')
    return
  }
  emit('order', id)
}

async function orderNextRow(row) {
  const id = row?.songId || row?.id
  if (row?.platform && row?.platformId && !isQueued(id)) {
    const r = await bridge.queue.orderOnline(onlinePayload(row), { next: true })
    if (r?.duplicate) return
    emit('changed')
    return
  }
  emit('orderNext', id)
}

function orderById(songId) {
  if (isQueued(songId)) return
  emit('order', songId)
}
function playNowById(songId) { emit('playNow', songId) }

/** 右键菜单：已点的歌禁用点歌项。 */
function menuItems(songId) {
  const queued = isQueued(songId)
  return [
    { action: 'playNow', label: '立即唱' },
    { action: 'order', label: '点歌', disabled: queued },
    { action: 'orderNext', label: '下一首播放', disabled: queued },
    { action: 'favorite', label: isFavorite(songId) ? '取消收藏' : '收藏' },
    { action: 'playlist', label: '加入歌单' },
  ]
}

function showMenu(event, entry, index) {
  const isPlaying = entry.status === 'playing'
  const items = menuItems(entry.songId)
  if (!isPlaying) items.push({ action: 'top', label: '置顶到下一首' })
  items.push({ action: 'remove', label: '从已点移除', danger: true })
  menu.value?.open(event, items, {
    title: `${entry.name}${entry.singer ? ' - ' + entry.singer : ''}`,
    onPick: (a) => {
      if (a === 'playNow') playNowById(entry.songId)
      else if (a === 'order') orderById(entry.songId)
      else if (a === 'orderNext') emit('orderNext', entry.songId)
      else if (a === 'favorite') emit('favorite', entry.songId)
      else if (a === 'top') emit('top', entry.entryId)
      else if (a === 'remove') emit('remove', entry.entryId)
      else if (a === 'playlist') emit('addToPlaylist', { id: entry.songId, name: entry.name, singer: entry.singer })
    },
  })
}

function showHistoryMenu(event, h) {
  menu.value?.open(event, menuItems(h.songId), {
    title: `${h.name}${h.singer ? ' - ' + h.singer : ''}`,
    onPick: (a) => {
      if (a === 'playNow') playNowById(h.songId)
      else if (a === 'order') orderRow(h)
      else if (a === 'orderNext') orderNextRow(h)
      else if (a === 'favorite') emit('favorite', h.songId)
      else if (a === 'playlist') emit('addToPlaylist', { id: h.songId, name: h.name, singer: h.singer })
    },
  })
}

function showSongMenu(event, s) {
  menu.value?.open(event, menuItems(s.id), {
    title: `${s.name}${s.singer ? ' - ' + s.singer : ''}`,
    onPick: (a) => {
      if (a === 'playNow') playNowById(s.id)
      else if (a === 'order') orderRow(s)
      else if (a === 'orderNext') orderNextRow(s)
      else if (a === 'favorite') emit('favorite', s.id)
      else if (a === 'playlist') emit('addToPlaylist', s)
    },
  })
}

async function unfavorite(songId) { emit('favorite', songId) }

async function newPlaylist() {
  const name = window.prompt('歌单名称')
  if (!name) return
  try { playlists.value = await bridge.playlists.create(name) } catch (e) { alert(e.message) }
}

async function deletePlaylist(name) {
  if (!window.confirm(`删除歌单「${name}」？`)) return
  playlists.value = await bridge.playlists.remove(name)
}

async function openPlaylist(name) {
  currentPlaylist.value = name
  playlistSongs.value = await loadSongs(await bridge.playlists.songs(name))
}

async function removeFromPlaylist(songId) {
  await bridge.playlists.removeSong(currentPlaylist.value, songId)
  await openPlaylist(currentPlaylist.value)
}

async function clearQueue() {
  await bridge.queue.clear()
  await refreshQueue()
  emit('changed')
}

async function clearHistory() {
  await bridge.history.clear()
  await refreshHistory()
}

async function deleteHistoryItem(h) {
  if (h.songId === props.currentId) return
  if (!window.confirm(`删除《${h.name}》并删除本地源文件？`)) return
  try {
    // 曲库查询失败不能阻止删除已唱记录：在线歌曲本来就不在曲库里。
    let song = null
    try { song = await bridge.catalog?.song?.(h.songId) } catch { /* 在线/本地记录允许查不到 */ }
    if (song?.filename) {
      try { await bridge.cache?.removeFile?.(song.filename) } catch { /* 文件可能已删除 */ }
    }
    if (String(h.songId).startsWith('online:')) {
      try { await bridge.cache?.removeOnline?.(h.songId) } catch { /* 在线缓存可能不存在 */ }
    }
    await bridge.history?.remove?.(h.songId)
    await refreshHistory()
    emit('changed')
  } catch (e) { window.alert(e.message) }
}

watch(visibleRows, (rows) => { loadCovers(rows) }, { immediate: true })

let timer = null
onMounted(() => {
  loadPageSizePref()
  refreshAll()
  timer = setInterval(refreshQueue, 1500)
})
onBeforeUnmount(() => clearInterval(timer))

// 收藏列表随外部数据变化刷新
watch(() => props.favoriteIds, () => { refreshFavorites() }, { deep: true })

defineExpose({ refreshAll, refreshQueue })
</script>

<style scoped>
.queue-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
.toolbar .spacer { flex: 1; }
.toolbar button { padding: 5px 10px; font-size: 12px; }
.crumb { font-size: 12px; color: var(--dim); }

.list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 10px; }

.row {
  display: grid; grid-template-columns: 40px 1fr 86px 138px;
  gap: 6px; align-items: center; padding: 7px 9px; margin-bottom: 3px;
  background: color-mix(in srgb, var(--panel-2) 76%, transparent);
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 8px;
  transition: background .12s, border-color .12s, box-shadow .12s;
}
.row:hover { background: var(--row-hover); border-color: var(--line-2); }
.row.playing {
  border-color: color-mix(in srgb, var(--focus) 78%, var(--line));
  background: var(--row-active); box-shadow: inset 3px 0 var(--focus);
}
.row[draggable="true"] { cursor: grab; }
.row[draggable="true"]:active { cursor: grabbing; }
.online-task {
  grid-column: 2 / -1; display: flex; align-items: center; gap: 8px;
  margin-top: -2px; font-size: 11px; color: var(--dim); min-width: 0;
}
.ot-text { min-width: 78px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ot-bar { flex: 1; height: 4px; border-radius: 999px; background: var(--panel-3); overflow: hidden; }
.ot-bar i { display: block; height: 100%; width: 0; background: var(--focus); transition: width .25s ease; }
.online-task.phase-resolving .ot-bar i,
.online-task.phase-queued .ot-bar i,
.online-task.indeterminate .ot-bar i { width: 38% !important; animation: online-slide 1.1s ease-in-out infinite alternate; }
.online-task.phase-downloading .ot-bar i { background: var(--gold); }
.online-task.phase-streaming .ot-bar i { width: 100% !important; background: var(--gold); opacity: .55; }
.online-task.phase-hls .ot-bar i { width: 100% !important; background: var(--gold); opacity: .38; }
.online-task.phase-done { color: var(--focus); }
.online-task.phase-failed { color: var(--accent-text); }
.online-task.phase-failed .ot-bar i { width: 100% !important; background: var(--accent); }
.ot-pct { width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
@keyframes online-slide { from { transform: translateX(-40%); } to { transform: translateX(180%); } }
.row.playlist-head { grid-template-columns: 90px 1fr; background: transparent; border: none; }

.idx { display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--dim); text-align: center; }
.lead { position: relative; width: 34px; height: 34px; flex: none; }
.avatar { width: 34px; height: 34px; border-radius: 7px; object-fit: cover; display: block; background: var(--panel-3); }
.avatar-none { display: flex; align-items: center; justify-content: center; color: #fff; font-size: 13px; font-weight: 600; text-shadow: 0 1px 2px rgba(0,0,0,.45); }
.play-badge, .num {
  position: absolute; right: -4px; bottom: -4px; min-width: 15px; height: 15px; padding: 0 3px;
  display: flex; align-items: center; justify-content: center; border-radius: 999px;
  font-size: 9px; line-height: 1; font-weight: 700; color: var(--on-focus-deep);
  background: var(--focus); border: 2px solid var(--panel-2);
}
.num { background: var(--panel-3); color: var(--text-2); border-color: var(--panel-2); font-weight: 500; }
.actions .danger { color: var(--accent-text); }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.singer { display: flex; align-items: center; gap: 5px; min-width: 0; font-size: 12px; color: var(--dim); }
.singer-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-badge { flex: none; padding: 1px 4px; border-radius: 4px; border: 1px solid var(--line); background: var(--panel-3); color: var(--dim-2); font-size: 9px; font-style: normal; line-height: 1.4; }
.actions { display: flex; gap: 4px; justify-content: flex-end; }
.actions button { display: inline-flex; align-items: center; justify-content: center; padding: 4px 7px; font-size: 12px; }
.actions .mini { background: transparent; border-color: transparent; color: var(--dim); }
.actions .mini:hover:not(:disabled) { color: var(--text); background: var(--btn); border-color: var(--line); }
.mini.faved { color: var(--accent); border-color: var(--accent-bg); }
/* 上移/下移：窄按钮，别把歌名挤掉 */
.actions .ord { padding: 4px 6px; font-size: 12px; line-height: 1; }
.back { padding: 4px 9px; font-size: 12px; }

.empty { padding: 26px; text-align: center; color: var(--dim); font-size: 13px; line-height: 1.8; }

/* 已唱统计条 */
.stats {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px;
  padding: 8px 12px; margin-bottom: 6px; font-size: 12px; color: var(--dim);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
}
.stats .st b { color: var(--text); font-variant-numeric: tabular-nums; }
.stats .top b { color: var(--focus); }

/* 最近 30 天柱状图 */
.chart {
  display: flex; align-items: flex-end; gap: 2px; height: 46px;
  padding: 6px 10px 8px; margin-bottom: 6px;
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
}
.bar-wrap { flex: 1 1 0; min-width: 0; display: flex; align-items: flex-end; justify-content: center; height: 100%; }
.bar { width: 100%; max-width: 10px; border-radius: 2px 2px 0 0; background: var(--scroll); transition: height .15s; }
.bar.on { background: var(--focus); }

/* 列表下方的分页条（在滚动区之外，不压内容） */
.pager {
  flex: none; display: flex; align-items: center; gap: 7px; justify-content: center;
  padding: 7px 8px; font-size: 12px; color: var(--dim);
  border-top: 1px solid var(--line); background: var(--panel-2);
}
.pager button, .pager .pg {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 5px 7px; font-size: 12px; line-height: 1; background: transparent; border-color: transparent;
}
.pager button:hover:not(:disabled) { background: var(--btn); }
.pager .psize { display: flex; align-items: center; gap: 4px; }
.pager .pinfo { display: flex; align-items: center; gap: 2px; white-space: nowrap; }
.pager select {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
  border-radius: 7px; padding: 3px 5px; font: inherit; font-size: 12px;
}
.pager .pjump {
  width: 30px; text-align: center; font: inherit; font-size: 12px;
  background: transparent; color: var(--text); border: 0;
  border-radius: 5px; padding: 3px 1px; font-variant-numeric: tabular-nums;
}
.pager .pjump:hover { background: var(--btn); }
.pager .pjump:focus { outline: 2px solid var(--focus); outline-offset: 0; background: var(--panel-2); }
.pager .pjump::-webkit-outer-spin-button,
.pager .pjump::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
</style>
