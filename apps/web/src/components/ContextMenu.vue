<template>
  <teleport to="body">
    <div v-if="visible" class="ctx-mask" @mousedown="close" @contextmenu.prevent="close">
      <div
        ref="menuEl"
        class="ctx-menu"
        :style="{ left: x + 'px', top: y + 'px' }"
        role="menu"
        tabindex="-1"
        @mousedown.stop
        @keydown="onKey"
      >
        <div v-if="title" class="ctx-title">{{ title }}</div>
        <button
          v-for="(item, i) in items"
          :key="item.action"
          class="ctx-item"
          :class="{ danger: item.danger, active: i === activeIndex }"
          :disabled="item.disabled"
          role="menuitem"
          @mouseenter="activeIndex = i"
          @click="pick(item)"
        >{{ item.label }}</button>
      </div>
    </div>
  </teleport>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'

const visible = ref(false)
const x = ref(0)
const y = ref(0)
const items = ref([])
const title = ref('')
const activeIndex = ref(0)
const menuEl = ref(null)
let onPick = null

/** 跳过禁用项，找下一个可选项。 */
function step(from, dir) {
  const n = items.value.length
  for (let k = 1; k <= n; k++) {
    const i = (from + dir * k + n * k) % n
    if (!items.value[i]?.disabled) return i
  }
  return from
}

function firstEnabled() {
  const i = items.value.findIndex((it) => !it.disabled)
  return i < 0 ? 0 : i
}

/** 在指定位置弹出菜单。超出窗口右/下边界时自动回收，避免被裁掉。 */
async function open(event, menuItems, opts = {}) {
  items.value = menuItems
  title.value = opts.title || ''
  onPick = opts.onPick || (() => {})
  activeIndex.value = firstEnabled()

  const w = 176
  const h = menuItems.length * 34 + (title.value ? 34 : 12)
  x.value = Math.min(event.clientX, window.innerWidth - w - 8)
  y.value = Math.min(event.clientY, window.innerHeight - h - 8)
  visible.value = true

  // 让菜单拿到焦点，方向键才能生效（遥控器/键盘场景）
  await nextTick()
  menuEl.value?.focus()
}

function close() { visible.value = false }

function pick(item) {
  if (!item || item.disabled) return
  close()
  onPick(item.action)
}

/**
 * 键盘导航：方向键移动、回车确认、Esc 关闭。
 * KTV 常配遥控器，不能只靠鼠标。
 */
function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); close() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex.value = step(activeIndex.value, 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex.value = step(activeIndex.value, -1) }
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    pick(items.value[activeIndex.value])
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

defineExpose({ open, close })
</script>

<style scoped>
.ctx-mask { position: fixed; inset: 0; z-index: 200; }
.ctx-menu {
  position: fixed; min-width: 168px; padding: 6px; outline: none;
  background: var(--row-hover); border: 1px solid var(--btn-border-hover); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.55);
}
.ctx-title {
  padding: 4px 10px 8px; font-size: 12px; color: var(--dim);
  border-bottom: 1px solid var(--line); margin-bottom: 5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ctx-item {
  display: block; width: 100%; text-align: left;
  padding: 7px 10px; font-size: 13px;
  background: transparent; border: none; border-radius: 6px;
}
.ctx-item.active:not(:disabled) { background: var(--btn-hover); outline: 1px solid var(--focus); }
.ctx-item.danger { color: var(--accent-text); }
.ctx-item:disabled { color: var(--dim-2); }
</style>
