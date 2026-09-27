<template>
  <teleport to="body">
    <div v-if="open" class="mask" @mousedown.self="$emit('close')">
      <div class="dlg" role="dialog" aria-modal="true" aria-label="手机点歌">
        <header>
          <div>
            <div class="title">手机点歌</div>
            <div class="sub">手机连接同一个 Wi-Fi，扫码即可点歌</div>
          </div>
          <button class="x" aria-label="关闭" @click="$emit('close')"><Icon name="close" :size="16" /></button>
        </header>
        <div class="body">
          <div class="qr-box">
            <img v-if="info.running && qrUrl" :src="qrUrl" alt="手机点歌二维码" @error="qrFailed = true" />
            <div v-else class="offline">
              <Icon name="smartphone" :size="40" />
              <span>{{ info.running ? '二维码生成失败' : '手机点歌服务未开启' }}</span>
            </div>
          </div>
          <div class="info">
            <div class="state" :class="{ on: info.running }">
              {{ info.running ? '运行中' : (info.disabled ? '已关闭' : '未启动') }}
            </div>
            <div v-if="info.running" class="url-row">
              <span class="url" :title="info.url">{{ info.url }}</span>
              <button @click="copyUrl">复制链接</button>
            </div>
            <div class="port-row">
              <label>端口</label>
              <input v-model.number="port" type="number" min="1024" max="65535" />
              <button :disabled="busy" @click="savePort">保存并重启</button>
            </div>
            <div class="actions">
              <button v-if="info.running" class="danger" :disabled="busy" @click="setEnabled(false)">关闭手机点歌</button>
              <button v-else class="primary" :disabled="busy" @click="setEnabled(true)">开启手机点歌</button>
            </div>
            <p class="hint">首次开启时 Windows 防火墙会询问，请选择「允许」，至少勾选“专用网络”。</p>
            <p v-if="info.addresses?.length > 1" class="hint">其他网卡地址：{{ info.addresses.slice(1).join('、') }}</p>
            <p v-if="message" class="hint" :class="{ error: messageError }">{{ message }}</p>
          </div>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close', 'changed'])
const bridge = window.ktv || {}
const info = ref({ running: false, disabled: false, port: 8088, url: '', addresses: [], error: '' })
const port = ref(8088)
const busy = ref(false)
const message = ref('')
const messageError = ref(false)
const qrFailed = ref(false)
let timer = null

const qrUrl = computed(() => (info.value.running ? `http://127.0.0.1:${info.value.port}/api/qr.svg` : ''))

async function refresh() {
  if (!bridge.lan?.info) return
  try {
    info.value = await bridge.lan.info()
    port.value = Number(info.value.port) || 8088
    qrFailed.value = false
  } catch { /* 忽略 */ }
}

async function setEnabled(on) {
  busy.value = true; message.value = ''
  try {
    if (bridge.settings?.update) await bridge.settings.update({ lanEnabled: on })
    if (bridge.lan?.restart) await bridge.lan.restart()
    await refresh()
    messageError.value = false
    message.value = on ? '手机点歌已开启' : '手机点歌已关闭'
    emit('changed')
  } catch (e) {
    messageError.value = true; message.value = e.message
  } finally { busy.value = false }
}

async function savePort() {
  busy.value = true; message.value = ''
  try {
    if (bridge.settings?.update) await bridge.settings.update({ lanPort: Number(port.value) })
    if (bridge.lan?.restart) await bridge.lan.restart()
    await refresh()
    messageError.value = false
    message.value = '端口已保存'
    emit('changed')
  } catch (e) {
    messageError.value = true; message.value = e.message
  } finally { busy.value = false }
}

async function copyUrl() {
  try { await navigator.clipboard.writeText(info.value.url || ''); message.value = '链接已复制'; messageError.value = false } catch { /* 忽略 */ }
}

watch(() => props.open, (open) => {
  if (open) {
    refresh()
    clearInterval(timer)
    timer = setInterval(refresh, 3000)
  } else {
    clearInterval(timer); timer = null
  }
}, { immediate: true })

onBeforeUnmount(() => clearInterval(timer))
</script>

<style scoped>
.mask { position: fixed; inset: 0; z-index: 310; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.58); }
.dlg { width: min(700px, calc(100vw - 40px)); overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); box-shadow: 0 20px 60px rgba(0,0,0,.5); }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; border-bottom: 1px solid var(--line); background: var(--panel-2); }
.title { font-size: 17px; font-weight: 700; }
.sub { margin-top: 3px; font-size: 12px; color: var(--dim); }
.x { padding: 6px 8px; }
.body { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 18px; padding: 18px; }
.qr-box { display: flex; align-items: center; justify-content: center; min-height: 230px; border: 1px dashed var(--line); border-radius: 12px; background: #fff; overflow: hidden; }
.qr-box img { width: 220px; height: 220px; object-fit: contain; }
.offline { display: flex; flex-direction: column; align-items: center; gap: 10px; color: #777; font-size: 13px; }
.info { min-width: 0; }
.state { display: inline-flex; padding: 4px 9px; border-radius: 999px; background: var(--panel-2); color: var(--dim); font-size: 12px; }
.state.on { color: #35c46a; background: rgba(53,196,106,.12); }
.url-row { display: flex; gap: 8px; align-items: center; margin: 14px 0; }
.url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--focus); font: 12px Consolas, monospace; }
.port-row { display: grid; grid-template-columns: 42px 90px auto; gap: 8px; align-items: center; margin: 12px 0; }
.port-row label { color: var(--dim); font-size: 12px; }
.port-row input { width: 90px; }
.actions { margin-top: 16px; }
.primary { border-color: var(--focus); background: var(--focus-fill); color: var(--on-focus); }
.danger { border-color: #a64242; color: #ff8d8d; }
.hint { margin: 10px 0 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.hint.error { color: #ff7b72; }
@media (max-width: 640px) { .body { grid-template-columns: 1fr; } .qr-box { min-height: 200px; } }
</style>
