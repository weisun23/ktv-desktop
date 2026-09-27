<template>
  <teleport to="body">
    <div v-if="open" class="mask" @mousedown.self="$emit('close')">
      <div class="dlg" role="dialog" aria-modal="true" aria-label="平台账号">
        <header>
          <div>
            <div class="title">平台账号</div>
            <div class="sub">扫码登录或导入 Cookie，凭证只保存在本机</div>
          </div>
          <button class="x" aria-label="关闭" @click="$emit('close')"><Icon name="close" :size="16" /></button>
        </header>

        <div class="body">
          <aside class="platforms">
            <button
              v-for="p in platforms"
              :key="p.id"
              :class="{ active: selected === p.id }"
              @click="selected = p.id"
            >
              <span class="dot" :class="{ on: status[p.id]?.loggedIn }"></span>
              <span class="pname">{{ p.label }}</span>
              <span class="pstate">{{ status[p.id]?.loggedIn ? '已登录' : '未登录' }}</span>
            </button>
          </aside>

          <section class="detail">
            <div class="head">
              <h3>{{ current?.label || '平台' }}</h3>
              <span class="state" :class="{ on: status[selected]?.loggedIn }">
                {{ status[selected]?.loggedIn ? '已登录' : '未登录' }}
              </span>
            </div>
            <p class="hint">登录后可以搜索并播放该平台曲目；未登录仍可浏览热门榜和搜索结果。</p>

            <div class="actions">
              <button class="primary" :disabled="busy" @click="openLogin">扫码登录</button>
              <button :disabled="busy || !status[selected]?.loggedIn" @click="logout">退出登录</button>
            </div>

            <label class="cookie-label">Cookie 导入</label>
            <textarea v-model="cookieText" rows="4" placeholder="粘贴该平台浏览器 Cookie，例如 token=...; userid=..."></textarea>
            <button class="import" :disabled="busy || !cookieText.trim()" @click="importCookie">保存 Cookie</button>
            <p v-if="message" class="message" :class="{ error: messageError }">{{ message }}</p>
          </section>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  initialPlatform: { type: String, default: 'qq' },
})
const emit = defineEmits(['close', 'changed'])

const bridge = window.ktv || {}
const platforms = ref([])
const status = ref({})
const selected = ref('qq')
const cookieText = ref('')
const busy = ref(false)
const message = ref('')
const messageError = ref(false)
let timer = null

const current = computed(() => platforms.value.find((p) => p.id === selected.value) || { id: selected.value, label: selected.value })

async function refresh() {
  if (!bridge.online?.sources || !bridge.auth?.status) return
  try {
    platforms.value = (await bridge.online.sources()).filter((p) => p.needsAuth || p.auth)
    status.value = await bridge.auth.status()
    const ids = platforms.value.map((p) => p.id)
    if (!ids.includes(selected.value)) selected.value = ids.includes(props.initialPlatform) ? props.initialPlatform : (ids[0] || 'qq')
  } catch { /* 忽略 */ }
}

async function openLogin() {
  busy.value = true; message.value = ''
  try {
    const r = await bridge.auth.openLogin(selected.value)
    if (r?.ok) {
      messageError.value = false
      message.value = r.alreadyOpen ? '登录窗口已经打开' : '登录成功，凭证已保存'
      await refresh(); emit('changed')
    } else {
      messageError.value = true
      message.value = r?.error || '登录窗口未能完成登录'
    }
  } catch (e) {
    messageError.value = true; message.value = e.message
  } finally { busy.value = false }
}

async function importCookie() {
  busy.value = true; message.value = ''
  try {
    const r = await bridge.auth.importCookie(selected.value, cookieText.value)
    if (r?.ok) {
      cookieText.value = ''
      messageError.value = false
      message.value = 'Cookie 已加密保存'
      await refresh(); emit('changed')
    } else {
      messageError.value = true
      message.value = r?.error || 'Cookie 保存失败'
    }
  } catch (e) {
    messageError.value = true; message.value = e.message
  } finally { busy.value = false }
}

async function logout() {
  busy.value = true; message.value = ''
  try {
    await bridge.auth.logout(selected.value)
    messageError.value = false
    message.value = '已退出该平台'
    await refresh(); emit('changed')
  } catch (e) {
    messageError.value = true; message.value = e.message
  } finally { busy.value = false }
}

watch(() => props.open, (open) => {
  if (open) {
    selected.value = props.initialPlatform || 'qq'
    cookieText.value = ''
    message.value = ''
    refresh()
    clearInterval(timer)
    timer = setInterval(refresh, 1500)
  } else {
    clearInterval(timer)
    timer = null
  }
}, { immediate: true })

onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.mask { position: fixed; inset: 0; z-index: 320; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.58); }
.dlg { width: min(760px, calc(100vw - 40px)); max-height: min(620px, calc(100vh - 40px)); overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); box-shadow: 0 20px 60px rgba(0,0,0,.5); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--line); background: var(--panel-2); }
.title { font-size: 17px; font-weight: 700; }
.sub { margin-top: 3px; font-size: 12px; color: var(--dim); }
.x { padding: 6px 8px; }
.body { display: grid; grid-template-columns: 210px minmax(0, 1fr); min-height: 360px; }
.platforms { padding: 10px; border-right: 1px solid var(--line); background: color-mix(in srgb, var(--panel-2) 65%, transparent); }
.platforms button { width: 100%; display: grid; grid-template-columns: 10px 1fr auto; align-items: center; gap: 8px; padding: 10px 9px; margin-bottom: 4px; border: 1px solid transparent; border-radius: 9px; background: transparent; text-align: left; }
.platforms button:hover { background: var(--row-hover); }
.platforms button.active { border-color: var(--focus); background: var(--row-active); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dim-2); }
.dot.on { background: #35c46a; box-shadow: 0 0 8px rgba(53,196,106,.65); }
.pname { font-size: 14px; }
.pstate { font-size: 11px; color: var(--dim); }
.detail { padding: 18px; min-width: 0; }
.head { display: flex; align-items: center; justify-content: space-between; }
.head h3 { margin: 0; font-size: 18px; }
.state { font-size: 12px; color: var(--dim); }
.state.on { color: #35c46a; }
.hint { margin: 10px 0 16px; color: var(--dim); font-size: 12px; line-height: 1.7; }
.actions { display: flex; gap: 8px; margin-bottom: 18px; }
.primary { border-color: var(--focus); background: var(--focus-fill); color: var(--on-focus); }
.cookie-label { display: block; margin-bottom: 6px; color: var(--text-2); font-size: 12px; }
textarea { box-sizing: border-box; width: 100%; resize: vertical; border: 1px solid var(--line); border-radius: 9px; padding: 10px; background: var(--panel-2); color: var(--text); font: 12px/1.55 Consolas, monospace; outline: none; }
textarea:focus { border-color: var(--focus); }
.import { margin-top: 8px; }
.message { margin: 12px 0 0; font-size: 12px; color: #35c46a; }
.message.error { color: #ff7b72; }
@media (max-width: 680px) { .body { grid-template-columns: 1fr; } .platforms { display: flex; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); } .platforms button { min-width: 150px; } }
</style>
