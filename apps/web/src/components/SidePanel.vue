<template>
  <div class="side-panel">
    <!-- 数据源切换已挪到**顶栏**（见 App.vue）：右栏顶部省下 44px 给列表。 -->

    <!-- 分段控件：和下面的曲库分类标签**刻意长得不一样**，
         否则两排几乎相同的按钮看不出层级 -->
    <div class="seg-tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        :class="{ active: section === t.id }"
        :title="t.label"
        @click="switchSection(t.id)"
      >
        <span class="label">{{ t.label }}</span>
        <span v-if="t.count" class="count">{{ t.count }}</span>
      </button>
    </div>

    <div class="body">
      <CatalogBrowser
        v-show="section === 'library'"
        ref="browser"
        :source-mode="sourceMode"
        :current-id="currentId"
        :favorite-ids="favoriteIds"
        :queued-ids="queuedIds"
        :downloading="downloading"
        @order="$emit('order', $event)"
        @order-next="$emit('orderNext', $event)"
        @play-now="$emit('playNow', $event)"
        @favorite="$emit('favorite', $event)"
        @add-to-playlist="$emit('addToPlaylist', $event)"
        @add-online-to-playlist="$emit('addOnlineToPlaylist', $event)"
        @play-local="$emit('playLocal', $event)"
        @open-auth="$emit('openAuth', $event)"
      />
      <QueuePanel
        v-if="section !== 'library'"
        ref="queuePanel"
        :section="section"
        :favorite-ids="favoriteIds"
        :queued-ids="queuedIds"
        :current-id="currentId"
        @play-now="$emit('playNow', $event)"
        @order="$emit('orderById', $event)"
        @order-next="$emit('orderNextById', $event)"
        @top="$emit('top', $event)"
        @remove="$emit('remove', $event)"
        @next="$emit('next')"
        @favorite="$emit('favorite', $event)"
        @add-to-playlist="$emit('addToPlaylist', $event)"
        @changed="$emit('changed')"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import CatalogBrowser from './CatalogBrowser.vue'
import QueuePanel from './QueuePanel.vue'

const props = defineProps({
  sourceMode: { type: String, default: 'maidong' },
  currentId: { type: String, default: '' },
  favoriteIds: { type: Array, default: () => [] },
  queuedIds: { type: Array, default: () => [] },
  downloading: { type: Object, default: () => ({}) },
  queueCount: { type: Number, default: 0 },
  historyCount: { type: Number, default: 0 },
  playlistCount: { type: Number, default: 0 },
})
defineEmits([
  'order', 'orderNext', 'orderById', 'orderNextById',
  'playNow', 'top', 'remove', 'next', 'favorite', 'addToPlaylist', 'playLocal', 'changed', 'openAuth',
  'setSourceMode',
])

const section = ref('library')
const browser = ref(null)
const queuePanel = ref(null)

const tabs = computed(() => [
  { id: 'library', label: '曲库' },
  { id: 'queue', label: '已点', count: props.queueCount },
  { id: 'history', label: '已唱', count: props.historyCount },
  { id: 'favorites', label: '收藏', count: props.favoriteIds.length },
  { id: 'playlists', label: '歌单', count: props.playlistCount },
])

function switchSection(id) {
  section.value = id
  if (id === 'library') browser.value?.refreshLocalFiles?.()
  else queuePanel.value?.refreshAll()
}

function refreshLocalFiles() { browser.value?.refreshLocalFiles?.() }
function refreshAuth() { browser.value?.refreshAuth?.() }
defineExpose({ refreshLocalFiles, switchSection, refreshAuth })
</script>

<style scoped>
.side-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }

/* 主分区导航：不再是厚重的外框分段控件。
   选中态用很浅的主题色底 + 短下划线，计数做成紧凑徽标；
   视觉重量低于下面的“曲库二级页签”，层级更清楚。 */
.seg-tabs {
  display: flex; gap: 2px; margin: 6px 10px 0; padding: 0;
  background: transparent; border: 0; border-bottom: 1px solid var(--line);
  border-radius: 0; flex: none;
}
.seg-tabs button {
  flex: 1 1 0; min-width: 0; position: relative;
  display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 9px 4px 8px; font-size: 13px;
  border: 0; border-radius: 7px 7px 0 0; background: transparent; color: var(--dim);
  white-space: nowrap; overflow: hidden;
}
.seg-tabs button:hover:not(.active) { background: var(--row-hover); color: var(--text); }
.seg-tabs button.active {
  background: linear-gradient(to bottom,
    color-mix(in srgb, var(--focus) 15%, transparent),
    transparent 78%);
  color: var(--text); font-weight: 600;
}
.seg-tabs button.active::after {
  content: ''; position: absolute; left: 50%; bottom: -1px;
  width: 22px; height: 2px; transform: translateX(-50%);
  border-radius: 999px; background: var(--focus);
  box-shadow: 0 0 9px color-mix(in srgb, var(--focus) 65%, transparent);
}
.seg-tabs .label { overflow: hidden; text-overflow: ellipsis; }
.count {
  flex: none; min-width: 18px; padding: 0 5px; border-radius: 999px;
  font-size: 10px; line-height: 15px; text-align: center;
  background: var(--panel-3); color: var(--dim); font-variant-numeric: tabular-nums;
}
.seg-tabs button.active .count { background: var(--focus); color: var(--on-focus-deep); }

.body { flex: 1; min-height: 0; position: relative; }
</style>
