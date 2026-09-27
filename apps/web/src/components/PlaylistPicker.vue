<template>
  <teleport to="body">
    <div v-if="open" class="mask" @mousedown.self="close">
      <div class="dlg">
        <header>
          <span class="title">加入歌单</span>
          <button class="x" aria-label="关闭歌单选择" @click="close"><Icon name="close" :size="16" /></button>
        </header>

        <div class="song" v-if="song">
          {{ song.name || song.title }}<span v-if="song.singer || song.artist" class="singer"> — {{ song.singer || song.artist }}</span>
          <span v-if="song.platform" class="tag">在线</span>
        </div>

        <div class="body">
          <div v-if="!playlists.length" class="empty">还没有歌单，先新建一个</div>
          <button
            v-for="(p, i) in playlists"
            :key="p.name"
            class="item"
            :class="{ active: i === activeIndex, done: p.contains }"
            @click="pick(p)"
            @mouseenter="activeIndex = i"
          >
            <span class="name">{{ p.name }}</span>
            <span class="count">{{ p.contains ? '已在歌单' : p.count + ' 首' }}</span>
          </button>
        </div>

        <footer>
          <input
            v-model="newName"
            class="new-input"
            placeholder="新建歌单…"
            @keydown.enter.stop="createAndPick"
            @keydown.stop
          />
          <button :disabled="!newName.trim()" @click="createAndPick">新建并加入</button>
        </footer>
      </div>
    </div>
  </teleport>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close', 'picked'])

const bridge = window.ktv || {}
const playlists = ref([])
const song = ref(null)
const newName = ref('')
const activeIndex = ref(0)

/** 在线歌在歌单里用合成 id，和曲库 id 区分开 */
function onlinePlaylistId(s) { return 'online:' + s.platform + ':' + s.id }

async function load() {
  const list = await bridge.playlists.list()
  const songId = song.value?.platform ? onlinePlaylistId(song.value) : song.value?.id
  playlists.value = await Promise.all(list.map(async (p) => {
    let contains = false
    if (songId) {
      try {
        const ids = await bridge.playlists.songs(p.name)
        contains = ids.includes(songId)
      } catch { /* 忽略 */ }
    }
    return { ...p, contains }
  }))
  activeIndex.value = 0
}

function openFor(s) {
  song.value = s
  newName.value = ''
  return load()
}

async function pick(p) {
  if (!song.value) return
  if (!p.contains) {
    if (song.value.platform) {
      // 在线歌：元数据一并存下来，否则以后没法按 id 还原歌名
      await bridge.playlists.addOnline(p.name, JSON.parse(JSON.stringify(song.value)))
    } else {
      await bridge.playlists.add(p.name, song.value.id)
    }
  }
  emit('picked', p.name)
  close()
}

async function createAndPick() {
  const name = newName.value.trim()
  if (!name) return
  try {
    await bridge.playlists.create(name)
  } catch (e) {
    // 重名就直接用现有的
    if (!String(e.message).includes('已存在')) { window.alert(e.message); return }
  }
  await bridge.playlists.add(name, song.value.id)
  emit('picked', name)
  close()
}

function close() { emit('close') }

/** 键盘导航：上下选择、回车确认、Esc 关闭 */
function onKey(e) {
  if (!props.open) return
  if (e.key === 'Escape') { e.preventDefault(); close() }
  else if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = Math.min(playlists.value.length - 1, activeIndex.value + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = Math.max(0, activeIndex.value - 1)
  } else if (e.key === 'Enter' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault()
    const p = playlists.value[activeIndex.value]
    if (p) pick(p)
  }
}

watch(() => props.open, (v) => {
  if (v) { nextTick(load); window.addEventListener('keydown', onKey) }
  else window.removeEventListener('keydown', onKey)
})

defineExpose({ openFor })
</script>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 300; display: flex; align-items: center; justify-content: center; }
.tag { margin-left: 8px; font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--row-active); color: var(--focus); border: 1px solid var(--focus-hover); }
.dlg {
  width: 420px; max-width: 92vw; max-height: 80vh; display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0,0,0,.6);
}
header { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); }
header .title { flex: 1; font-size: 15px; font-weight: 600; }
header .x { padding: 3px 9px; }

.song { padding: 10px 16px; font-size: 13px; color: var(--dim); border-bottom: 1px solid var(--line); }
.song .singer { color: var(--dim-2); }

.body { flex: 1; overflow-y: auto; padding: 8px; min-height: 120px; }
.item {
  display: flex; align-items: center; width: 100%; text-align: left;
  padding: 10px 12px; margin-bottom: 4px; font-size: 14px;
  background: var(--panel-2); border: 1px solid transparent; border-radius: 8px;
}
.item.active { border-color: var(--focus); background: var(--row-active); }
.item.done .name { color: var(--dim); }
.item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .count { font-size: 12px; color: var(--dim); flex: none; }
.item.done .count { color: var(--focus); }

.empty { padding: 26px; text-align: center; color: var(--dim); font-size: 13px; }

footer { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
.new-input {
  flex: 1; min-width: 0; background: var(--panel-2); color: var(--text);
  border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; font: inherit; font-size: 13px;
}
.new-input:focus { outline: 2px solid var(--focus); outline-offset: 1px; }
footer button { padding: 8px 14px; font-size: 13px; white-space: nowrap; }
</style>
