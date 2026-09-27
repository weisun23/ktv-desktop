<template>
  <div class="catalog">
    <!-- 顶部：分类页签 + 曲库状态 -->
    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        :class="{ active: tab === t.id }"
        @click="switchTab(t.id)"
      >{{ t.label }}</button>
    </div>

    <!-- 状态行**只在出问题时**出现。
         一切正常时它只是一行噪音（曲库规模/取流方式），却要占掉 22px ——
         右侧列表本来就只能显示五六行，这 22px 很值钱。
         正常时的曲库规模挪到下面工具栏的右侧。 -->
    <div v-if="!catalogReady || !providers.length" class="status-line">
      <span class="stat warn">{{ catalogReady ? providerText : statText }}</span>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <template v-if="tab === 'search' || tab === 'singers'">
        <div class="search-wrap" @click="focusSearch">
          <Icon name="search" :size="15" />
          <input
            ref="searchInput"
            v-model="query"
            class="search"
            type="text"
            inputmode="search"
            enterkeyhint="search"
            autocomplete="off"
            spellcheck="false"
            :placeholder="tab === 'singers' ? '搜索歌手…' : '搜歌名 / 拼音首字母 / 歌手…'"
            @keydown.stop
            @keydown.enter="runSearch(1)"
          />
        </div>
        <button v-if="query" class="clear-q" title="清空搜索词" aria-label="清空搜索词"
          @click="clearQuery"><Icon name="close" :size="13" /></button>
        <button @click="runSearch(1)" :disabled="loading">搜索</button>
        <!-- 下拉筛选包成一组：整组换行，不会出现"一个下拉孤零零留在第二行" -->
        <span class="filters">
          <select v-if="tab === 'singers'" v-model="filterArea" @change="applySingerFilter" @keydown.stop title="按地区筛选">
            <option value="">全部地区</option>
            <option v-for="a in singerAreas" :key="a" :value="a">{{ a }}</option>
          </select>
          <select v-if="tab === 'singers'" v-model="filterType" @change="applySingerFilter" @keydown.stop title="按类型筛选">
            <option value="">全部类型</option>
            <option v-for="ty in singerTypes" :key="ty" :value="ty">{{ ty }}</option>
          </select>
          <select v-if="tab === 'search'" v-model="lang" @change="runSearch(1)" @keydown.stop>
            <option value="">全部语种</option>
            <option v-for="l in languages" :key="l" :value="l">{{ l }}</option>
          </select>
        </span>
        <div class="spacer"></div>
        <span class="count">已显示 {{ tab === 'singers' ? singers.length : songs.length }}</span>
        
      </template>
      <template v-else-if="tab === 'online'">
        <div class="search-wrap" @click="focusSearch">
          <Icon name="search" :size="15" />
          <input
            ref="searchInput"
            v-model="query"
            class="search"
            type="text"
            inputmode="search"
            enterkeyhint="search"
            autocomplete="off"
            spellcheck="false"
            :placeholder="onlineOnlyMv ? '搜 MV 名 / 歌手…' : '搜歌名 / 歌手…'"
            @keydown.stop
            @keydown.enter="loadOnline(1)"
          />
        </div>
        <button v-if="query" class="clear-q" title="清空搜索词" aria-label="清空搜索词"
          @click="clearQuery"><Icon name="close" :size="13" /></button>
        <button @click="loadOnline(1)" :disabled="loading">搜索</button>
        <div class="mini-seg">
          <button :class="{ active: !onlineOnlyMv }" @click="setOnlineMode(false)">搜歌</button>
          <button :class="{ active: onlineOnlyMv }" @click="setOnlineMode(true)">搜 MV</button>
        </div>
        <select v-model="onlinePlatform" class="platform-select" @change="onOnlinePlatformChange">
          <option v-for="p in onlinePlatforms" :key="p.id" :value="p.id">{{ platformOptionLabel(p) }}</option>
        </select>
        <button v-if="currentPlatformCanAuth" class="mini account-btn" :class="{ warn: currentPlatformRequiresLogin, auth: !currentPlatformLoggedIn }" @click="$emit('openAuth', onlinePlatform)">
          {{ currentAccountLabel }}
        </button>
        <div class="spacer"></div>
        <span class="count">已显示 {{ onlineSongs.length }}</span>
        
      </template>
      <template v-else-if="tab === 'singerSongs'">
        <button @click="switchTab('singers')">« 返回歌手列表</button>
        <span class="crumb">{{ currentSinger?.name }} 的歌</span>
        <div class="spacer"></div>
        <span class="count">已显示 {{ songs.length }}</span>
        
      </template>
      <template v-else-if="tab === 'local'">
        <span class="crumb">目录：{{ mediaRoot || '—' }}</span>
        <div class="spacer"></div>
        <button @click="loadLocal" :disabled="loading">重新扫描</button>
      </template>
      <!-- 热歌榜：页签上已经写着"热歌榜"了，这里再写一遍是重复的，只留计数 -->
      <template v-else>
        <span class="crumb">已显示 {{ songs.length }} 首</span>
        <div class="spacer"></div>
        <span v-if="catalogReady" class="count" title="曲库规模">{{ catalogInfo }}</span>
      </template>
    </div>

    <!-- 在线收藏：曲库里没有的歌，收藏后不用每次重搜 -->
    <div v-if="tab === 'online' && !query.trim() && onlineSaves.length" class="history-bar">
      <span class="hlabel">在线收藏</span>
      <button v-for="it in onlineSaves" :key="it.platform + ':' + it.id" class="hchip"
        :title="'播放「' + it.title + '」'" @click="playSaved(it)">{{ it.title }}</button>
    </div>

    <!-- 搜索历史：遥控器/小键盘输字很麻烦，常用的几个词点一下就行 -->
    <div v-if="tab === 'search' && !query.trim() && searchHistory.length" class="history-bar">
      <span class="hlabel">最近搜过</span>
      <button v-for="kw in searchHistory" :key="kw" class="hchip" :title="'搜索「' + kw + '」'"
        @click="useHistory(kw)">{{ kw }}</button>
      <button class="hclear" @click="clearHistory" title="清空搜索历史">清空</button>
    </div>

    <!-- 列表 -->
    <div v-if="tab === 'online' && !query.trim() && onlineSongs.length" class="online-hot-head">
      <Icon name="sparkles" :size="14" />
      <span>{{ currentOnlinePlatform?.label || '在线' }}热门榜</span>
    </div>
    <div class="list" :class="{ 'list-grid': tab === 'singers' }">
      <div v-if="loading" class="skeleton-list" aria-label="加载中">
        <div v-for="n in 7" :key="n" class="skeleton-row">
          <i class="sk-cover"></i>
          <span class="sk-lines"><i class="sk-name"></i><i class="sk-meta"></i></span>
        </div>
      </div>
      <div v-else-if="!catalogReady" class="empty notice first-run">
        <div class="fr-title">曲库还没装</div>
        <div class="fr-desc">
          曲库是曲目数据（约 440MB 下载、988MB 解压）。装好之后就能搜 67 万首歌并在线播放。
        </div>
        <button class="primary" :disabled="installing" @click="installCatalog">
          {{ installing ? progressText : '下载并安装曲库' }}
        </button>
        <div v-if="installing" class="fr-progress">{{ progressText }}</div>
      </div>
      <div v-else-if="notice" class="empty notice">{{ notice }}</div>

      <!-- 歌手首字母索引：13 万歌手靠搜索不现实，A-Z 一按就到 -->
      <div v-if="tab === 'singers' && letters.length" class="letters">
        <button
          v-for="L in letters"
          :key="L.letter"
          :class="{ on: activeLetter === L.letter }"
          :disabled="!L.count"
          :title="L.count ? L.letter + ' 开头 · ' + L.count + ' 位' : L.letter + ' 开头没有歌手'"
          @click="pickLetter(L.letter)"
        >{{ L.letter }}</button>
        <button v-if="activeLetter" class="clear" @click="pickLetter('')" title="取消首字母筛选">全部</button>
      </div>

      <!-- 歌曲 -->
      <template v-if="isSongList && songs.length">
        <div
          v-for="s in songs"
          :key="s.id"
          class="song"
          :data-id="s.id"
          :class="{ current: currentId === s.id, selected: selectedId === s.id, queued: isQueued(s.id) }"
          @click="selectedId = s.id"
          @dblclick="playNow(s)"
          @mouseenter="coverOnHover(s)"
          @contextmenu.prevent="showMenu($event, s)"
        >
          <!-- 曲库没封面数据，是按歌名去网易云查的（限速 + 永久缓存），查到就替换占位 -->
          <img v-if="covers[s.id]" class="cover" :src="covers[s.id]" alt="" loading="lazy"
            referrerpolicy="no-referrer" @error="hideBrokenCover" />
          <span v-else class="cover cover-none" :style="{ background: avatarTint(s.name) }">{{ (s.name || '?').slice(0, 1) }}</span>
          <span
            class="playable"
            :class="{ on: isPlayable(s), online: !isPlayable(s) && canStream }"
            :title="isPlayable(s) ? '本地已有文件，直接播放' : (canStream ? '本地无文件，将从在线取流' : '本地无文件且未配置取流服务')"
          ></span>
          <span class="info">
            <span class="name" :title="s.name">{{ s.name }}</span>
            <span class="meta">
              <span class="singer">{{ s.singer || '—' }}</span>
              <template v-if="s.lang"><i>·</i><span>{{ s.lang }}</span></template>
              <i>·</i><span :title="'曲库 accomp=' + s.accomp">{{ accompLabel(s.accomp) }}</span>
            </span>
          </span>
          <span class="col-actions">
            <span v-if="isQueued(s.id)" class="queued-badge" title="已在已点列表">已点</span>
            <span v-if="dlState(s)" class="dl" :class="dlState(s)" :title="dlTitle(s)">{{ dlLabel(s) }}</span>
            <button
              class="mini"
              :class="{ faved: isFavorite(s.id) }"
              :title="isFavorite(s.id) ? '取消收藏' : '收藏'"
              :aria-label="isFavorite(s.id) ? '取消收藏' : '收藏'"
              @click.stop="$emit('favorite', s.id)"
            ><Icon :name="isFavorite(s.id) ? 'heart-filled' : 'heart'" :size="15" :fill="isFavorite(s.id)" /></button>
            <button class="mini next-btn" title="插到下一首" aria-label="插到下一首"
              :disabled="isQueued(s.id)" @click.stop="orderNext(s)">下首</button>
          </span>
        </div>
      </template>

      <!-- 在线结果（网易云 / 酷我） -->
      <template v-else-if="tab === 'online' && onlineSongs.length">
        <div
          v-for="s in onlineSongs"
          :key="s.platform + '-' + s.id"
          :data-id="s.platform + '-' + s.id"
          class="song"
          @dblclick="playOnlineNow(s)"
          @contextmenu.prevent="showOnlineMenu($event, s)"
        >
          <!-- 封面：MV 搜索和搜歌都带（来自网易云的 al.picUrl / mvs[].cover） -->
          <img
            v-if="s.cover"
            class="cover"
            :src="s.cover"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
            :title="s.hasMv ? '有官方 MV，双击播放 MV' : '在线音频，双击播放'"
            @error="hideBrokenCover"
          />
          <span v-else class="cover cover-none" :style="{ background: avatarTint(s.title) }" :title="s.hasMv ? '有官方 MV' : '在线音频'">{{ (s.title || '?').slice(0, 1) }}</span>
          <span class="info">
            <span class="name" :title="s.title">{{ s.title }}</span>
            <span class="meta">
              <span class="singer">{{ s.artist || '—' }}</span>
              <template v-if="s.duration"><i>·</i><span>{{ fmtTime(s.duration) }}</span></template>
              <i>·</i><span>{{ platformLabel(s.platform) }}</span>
              <template v-if="needsLogin(s.platform)"><i>·</i><span class="auth-tag">需登录</span></template>
              <template v-if="s.hasMv"><i>·</i><span class="mv-tag">MV</span></template>
            </span>
          </span>
          <span class="col-actions">
            <button
              class="mini"
              :class="{ faved: isOnlineSaved(s) }"
              :title="isOnlineSaved(s) ? '取消在线收藏' : '收藏到本地（下次不用重搜）'"
              :aria-label="isOnlineSaved(s) ? '取消在线收藏' : '收藏到本地'"
              @click.stop="toggleOnlineSave(s)"
            ><Icon :name="isOnlineSaved(s) ? 'star-filled' : 'star'" :size="15" :fill="isOnlineSaved(s)" /></button>
            <button class="mini" @click.stop="orderOnline(s)">点歌</button>
            <button class="mini" @click.stop="playOnlineNow(s)">立即唱</button>
          </span>
        </div>
      </template>
      <!-- 歌手 -->
      <template v-else-if="tab === 'singers' && singers.length">
        <button v-for="g in singers" :key="g.id" class="song singer" :data-id="g.id" @click="openSinger(g)">
          <!-- 歌手头像：曲库里只存文件名，URL 由曲库服务按 CDN 前缀拼好 -->
          <img v-if="g.imageUrl" class="avatar" :src="g.imageUrl" alt="" loading="lazy"
            referrerpolicy="no-referrer" @error="hideBrokenCover" />
          <!-- 没头像时用**名字算出来的渐变色**兜底：比一圈灰底字母好看，还能一眼区分 -->
          <span v-else class="avatar avatar-none" :style="{ background: avatarTint(g.name) }">{{ (g.name || '?').slice(0, 1) }}</span>
          <span class="info">
            <span class="name">{{ g.name }}</span>
            <span class="meta">
              <span v-if="g.area" class="chip">{{ g.area }}</span>
              <span v-if="g.type" class="chip">{{ g.type }}</span>
            </span>
          </span>
          <span class="go" aria-hidden="true">›</span>
        </button>
      </template>

      <!-- 本地文件 -->
      <template v-else-if="tab === 'local' && localSongs.length">
        <button v-for="s in localSongs" :key="s.id" class="song" :data-id="s.id" @click="$emit('playLocal', s)">
          <span class="playable on"></span>
          <span class="info">
            <span class="name">{{ s.name }}</span>
            <span class="meta"><span>{{ s.ext.replace('.', '').toUpperCase() }}</span><i>·</i><span>{{ fmtSize(s.size) }}</span></span>
          </span>
        </button>
      </template>

      <div v-else-if="!loading && !notice" class="empty empty-card">
        <Icon name="search" :size="34" />
        <b>没有找到匹配的歌曲</b>
        <small>换个关键词，或切换数据源后再试</small>
      </div>

    </div>

    <ContextMenu ref="menu" />

    <!-- 底部条：图例 + 分页。
         ⚠️ 分页条必须在**滚动区外面**。
         之前它是 .list 里的 position:sticky，会**压住最后一行**（底还是半透明渐变），
         用户看到的就是"分页条位置不对、把歌挡住了"。
         图例也并到这一行，省下一整行高度留给列表。 -->
    <div class="bottombar">
      <div class="legend" title="单击选中 · 双击点歌 · 右键更多 · ↑↓ 选择 · Enter 确认 · PgUp/PgDn 翻页">
        <span><i class="playable on"></i>本地</span>
        <span><i class="playable online"></i>在线</span>
        <span><i class="playable"></i>不可播</span>
      </div>
      <div v-if="currentList.length && paginated" class="pager">
        <label class="psize" title="每页显示多少条">
          <span class="psize-label">每页</span>
          <select :value="pageSize" @change="setPageSize(Number($event.target.value))">
            <option v-for="n in PAGE_OPTIONS" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
        <div class="page-nav">
          <button class="pg" aria-label="上一页" :disabled="page <= 1 || loading" @click="prevPage" title="上一页（PgUp）"><Icon name="chevron-left" :size="15" /></button>
          <span class="pinfo">第 <input
              class="pjump"
              type="number"
              min="1"
              :value="page"
              :disabled="loading"
              title="输入页码后回车跳转"
              @keydown.enter="jumpTo($event)"
              @blur="jumpTo($event)"
            /> 页<template v-if="loading">…</template></span>
          <button class="pg" aria-label="下一页" :disabled="!hasMore || loading" @click="nextPage" title="下一页（PgDn）"><Icon name="chevron-right" :size="15" /></button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import ContextMenu from './ContextMenu.vue'
import Icon from './Icon.vue'

const props = defineProps({
  currentId: { type: String, default: '' },
  favoriteIds: { type: Array, default: () => [] },
  queuedIds: { type: Array, default: () => [] },
  downloading: { type: Object, default: () => ({}) },
  // 数据源模式：maidong（麦动曲库）/ online（只用在线源）。两套环境二选一，
  // 页签完全不同 —— 见下面 tabs。
  sourceMode: { type: String, default: 'maidong' },
})

const selectedId = ref('')
const menu = ref(null)

function isQueued(id) { return props.queuedIds.includes(id) }

/** 点歌：已在已点列表里的会被拦下（避免列表出现重复条目）。 */
function order(song) {
  if (isQueued(song.id)) return
  emit('order', song)
}

/** 双击 = 立即播放并切歌（普通点歌仍走按钮 / 右键菜单）。 */
function playNow(song) {
  emit('playNow', song)
}

function orderNext(song) {
  if (isQueued(song.id)) return
  emit('orderNext', song)
}

/** 右键菜单：动作按当前状态动态启用/禁用。 */
function showMenu(event, song) {
  const queued = isQueued(song.id)
  const faved = isFavorite(song.id)
  menu.value?.open(event, [
    { action: 'playNow', label: '立即唱' },
    { action: 'order', label: '点歌', disabled: queued },
    { action: 'orderNext', label: '下一首播放', disabled: queued },
    { action: 'favorite', label: faved ? '取消收藏' : '收藏' },
    { action: 'playlist', label: '加入歌单' },
    { action: 'copyName', label: '复制歌名' },
  ], {
    title: `${song.name}${song.singer ? ' - ' + song.singer : ''}`,
    onPick: (action) => {
      if (action === 'playNow') emit('playNow', song)
      else if (action === 'order') order(song)
      else if (action === 'orderNext') orderNext(song)
      else if (action === 'favorite') emit('favorite', song.id)
      else if (action === 'playlist') emit('addToPlaylist', song)
      else if (action === 'copyName') navigator.clipboard?.writeText(`${song.name} - ${song.singer || ''}`)
    },
  })
}
const emit = defineEmits(['order', 'orderNext', 'playNow', 'favorite', 'playLocal', 'addToPlaylist', 'addOnlineToPlaylist', 'openAuth'])

/**
 * 页签按**数据源模式**给，两个模式互不相交：
 *   maidong -> 热歌榜 / 搜索 / 歌手 / 本地文件
 *   online  -> 在线搜索 / 本地文件
 * 这样"麦动的源"和"在线的源"在界面上就是两套环境，不会混着点。
 */
const tabs = computed(() => (props.sourceMode === 'online'
  ? [{ id: 'online', label: '在线搜索' }, { id: 'local', label: '本地文件' }]
  : [{ id: 'hot', label: '热歌榜' }, { id: 'search', label: '搜索' },
     { id: 'singers', label: '歌手' }, { id: 'local', label: '本地文件' }]))

const tab = ref('hot')
const query = ref('')
const searchInput = ref(null)
const lang = ref('')
const languages = ref([])
const songs = ref([])
const singers = ref([])
const localSongs = ref([])
const localFiles = ref(new Set())
const loading = ref(false)
const notice = ref('')
const hasMore = ref(false)
const page = ref(1)          // 当前页码（显式分页）
/** 每页条数可选：条数越少翻页越轻，越多越省得翻 */
const PAGE_OPTIONS = [20, 30, 50, 100]
const pageSize = ref(30)

/** 哪些标签是分页的：本地文件一次扫完，没有下一页 */
const paginated = computed(() => ['hot', 'search', 'singers', 'singerSongs', 'online'].includes(tab.value))
const currentSinger = ref(null)
const letters = ref([])        // 歌手首字母分布
const singerAreas = ref([])    // 地区候选（大陆/港台/中国/外国）
const singerTypes = ref([])    // 类型候选（男/女/组合/歌星）
const filterArea = ref('')
const filterType = ref('')
const activeLetter = ref('')   // 当前选中的首字母（'' = 不筛选）
const searchHistory = ref([])
const onlineSaves = ref([])   // 在线收藏（曲库里没有的歌）
const covers = ref({})        // songId -> 封面 URL（曲库自己的数据里没有封面）
let offCoverReady = null
// 在线搜歌：结果来自网易云（曲库里没有的歌）
const onlineSongs = ref([])
const onlineOnlyMv = ref(false)
const onlinePlatforms = ref([])
const onlinePlatform = ref('netease')
const authStatus = ref({})
const catalogReady = ref(false)
const catalogInfo = ref('')
const providers = ref([])
const installing = ref(false)
const progressText = ref("")

/** 在非 Electron 环境（浏览器里调界面）降级，避免整页报错 */
const bridge = window.ktv || {
  library: { scan: async () => [], localFileSet: async () => [], mediaRoot: async () => '' },
  catalog: new Proxy({}, { get: () => async () => ({ songs: [], hasMore: false, ready: false }) }),
  online: {
    sources: async () => [],
    hot: async () => ({ ok: false, error: '当前环境不支持在线热门榜' }),
    search: async () => ({ ok: false, error: '当前环境不支持在线搜索' }),
    play: async () => ({ ok: false, error: '当前环境不支持在线播放' }),
  },
  auth: {
    status: async () => ({}),
    openLogin: async () => ({ ok: false, error: '当前环境不支持账号登录' }),
    importCookie: async () => ({ ok: false, error: '当前环境不支持 Cookie 导入' }),
    logout: async () => ({ ok: false, error: '当前环境不支持退出登录' }),
  },
  onlineSaves: { list: async () => [], add: async () => [], remove: async () => [] },
}


const isSongList = computed(() => ['hot', 'search', 'singerSongs'].includes(tab.value))
const tabLabel = computed(() => {
  if (tab.value === 'hot') return '热歌榜'
  if (tab.value === 'search') return query.value ? `搜索「${query.value}」` : '搜索结果'
  if (tab.value === 'online') return onlineOnlyMv.value ? '在线搜 MV' : '在线搜歌'
  if (tab.value === 'singerSongs') return `${currentSinger.value?.name || ''} 的歌`
  return ''
})
const statText = computed(() => catalogReady.value
  ? catalogInfo.value
  : `曲库未就绪${catalogInfo.value ? '：' + catalogInfo.value : ''}`)

/** 有取流服务时，本地没文件的曲目也能在线播。 */
const canStream = computed(() => providers.value.length > 0)
const providerText = computed(() => canStream.value
  ? `取流：${providers.value.join('、')}`
  : '未配置取流服务')

const currentOnlinePlatform = computed(() => onlinePlatforms.value.find((p) => p.id === onlinePlatform.value) || null)
const currentPlatformLoggedIn = computed(() => !!authStatus.value[onlinePlatform.value]?.loggedIn)
const currentPlatformCanAuth = computed(() => !!(currentOnlinePlatform.value?.needsAuth || currentOnlinePlatform.value?.auth))
const currentPlatformRequiresLogin = computed(() => !!currentOnlinePlatform.value?.needsAuth && !currentPlatformLoggedIn.value)
const currentAccountLabel = computed(() => {
  const p = currentOnlinePlatform.value
  if (!p || (!p.needsAuth && !p.auth)) return '账号'
  if (currentPlatformLoggedIn.value) return `${p.label}账号`
  return `登录${p.label}`
})

function platformOptionLabel(p) {
  if (!p) return ''
  const loggedIn = !!authStatus.value[p.id]?.loggedIn
  if (p.needsAuth && !loggedIn) return `${p.label}（需登录）`
  if (p.auth && loggedIn) return `${p.label}（已登录）`
  if (p.auth) return `${p.label}（可登录）`
  return p.label
}

function platformLabel(id) {
  const p = onlinePlatforms.value.find((x) => x.id === id)
  if (p) return p.label
  return id === 'netease' ? '网易云' : id === 'kuwo' ? '酷我' : id === 'qq' ? 'QQ音乐' : id === 'kugou' ? '酷狗' : id === 'migu' ? '咪咕' : id
}

function needsLogin(platform) {
  const p = onlinePlatforms.value.find((x) => x.id === platform)
  return !!p?.needsAuth && !authStatus.value[platform]?.loggedIn
}

function canLogin(platform) {
  const p = onlinePlatforms.value.find((x) => x.id === platform)
  return !!(p?.needsAuth || p?.auth) && !authStatus.value[platform]?.loggedIn
}

/** 这首歌的缓存状态：undefined | downloading | done | failed */
function dlState(song) {
  const t = props.downloading[song.filename]
  return t ? t.state : undefined
}

function dlLabel(song) {
  const t = props.downloading[song.filename]
  if (!t) return ''
  if (t.state === 'downloading') {
    return t.total ? `${Math.floor((t.received / t.total) * 100)}%` : '缓存中'
  }
  if (t.state === 'done') return '已缓存'
  if (t.state === 'failed') return '失败'
  return '排队'
}

function dlTitle(song) {
  const t = props.downloading[song.filename]
  if (!t) return ''
  if (t.state === 'downloading') {
    const mb = (n) => (n / 1024 / 1024).toFixed(1)
    return `缓存中 ${mb(t.received)} / ${t.total ? mb(t.total) + ' MB' : '未知大小'}`
  }
  return { done: '已缓存到本地', failed: `缓存失败：${t.error}`, queued: '排队等待缓存' }[t.state] || ''
}

function isFavorite(id) {
  return props.favoriteIds.includes(id)
}

function accompLabel(a) {
  if (a === 1) return '声道 1'
  if (a === 2) return '声道 2'
  return '—'
}

function isPlayable(song) {
  return !!song && localFiles.value.has(String(song.filename || '').toLowerCase())
}

/** 秒 → m:ss */
function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function fmtSize(bytes) {
  const mb = (bytes || 0) / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${((bytes || 0) / 1024).toFixed(0)} KB`
}

/** 首次运行：一键下载安装曲库。 */
async function installCatalog() {
  if (!bridge.catalogUpdate) { notice.value = "当前环境不支持下载曲库"; return }
  installing.value = true
  progressText.value = "准备中…"
  try {
    const r = await bridge.catalogUpdate.run()
    if (r.ok) {
      progressText.value = "安装完成，正在重启应用…"
      setTimeout(() => window.location.reload(), 1200)
    } else {
      notice.value = "下载失败：" + r.error
    }
  } finally { installing.value = false }
}

function onCatalogProgress(p) {
  progressText.value = (p.detail || p.phase || "") + " " + (p.percent || 0) + "%"
}

async function refreshLocalFiles() {
  try { localFiles.value = new Set(await bridge.library.localFileSet()) } catch { /* 忽略 */ }
}

/**
 * 显式分页：每页 pageSize 条（用户可选），翻页时**整页替换**而不是往后面追加。
 *
 * 为什么不用"加载更多/无限滚动"：KTV 现场常是遥控器，
 * 追加式只能一页页往下加，想回到前面得一路往回滚；而且 DOM 会越滚越大。
 * 这里的列表都是有界的（搜索几十条、歌手几十条、已唱几百条），页码是有意义的。
 */
function scrollListTop() {
  const el = document.querySelector('.catalog .list')
  if (el) el.scrollTop = 0
}

async function loadHot(pageNo = 1) {
  page.value = pageNo
  loading.value = true; notice.value = ''
  try {
    const r = await bridge.catalog.hot({ limit: pageSize.value, offset: (pageNo - 1) * pageSize.value })
    songs.value = r.songs
    hasMore.value = r.hasMore
    scrollListTop()
    loadCovers()
  } catch (e) { notice.value = e.message } finally { loading.value = false }
}

async function runSearch(pageNo = 1) {
  if (tab.value === 'singers') return loadSingers(pageNo)
  // 只在第 1 页记历史，翻页不该产生新纪录
  if (pageNo === 1 && query.value.trim()) {
    bridge.searchHistory?.add(query.value.trim()).then(refreshHistory).catch(() => {})
  }
  page.value = pageNo
  loading.value = true; notice.value = ''
  try {
    const r = await bridge.catalog.search({
      keyword: query.value, lang: lang.value, limit: pageSize.value, offset: (pageNo - 1) * pageSize.value,
    })
    songs.value = r.songs
    hasMore.value = r.hasMore
    scrollListTop()
    loadCovers()
    if (!r.songs.length) notice.value = pageNo > 1 ? '没有更多了' : `没有找到「${query.value}」`
  } catch (e) { notice.value = e.message } finally { loading.value = false }
}

// 歌手列表分页。后端返回的是纯数组（没有 hasMore），
// 所以用「返回条数是否等于每页数」判断还有没有下一页。
async function loadSingers(pageNo = 1) {
  page.value = pageNo
  loading.value = true; notice.value = ''
  try {
    const list = await bridge.catalog.singers({
      keyword: query.value, letter: activeLetter.value,
      area: filterArea.value, type: filterType.value,
      limit: pageSize.value, offset: (pageNo - 1) * pageSize.value,
    })
    singers.value = list
    hasMore.value = list.length >= pageSize.value
    scrollListTop()
    if (!list.length) notice.value = pageNo > 1 ? '没有更多了' : `没有找到歌手「${query.value}」`
  } catch (e) { notice.value = e.message } finally { loading.value = false }
}

async function openSinger(g, pageNo = 1) {
  if (pageNo === 1) { currentSinger.value = g; tab.value = 'singerSongs' }
  page.value = pageNo
  loading.value = true; notice.value = ''
  try {
    const list = await bridge.catalog.singerSongs(g.id, { limit: pageSize.value, offset: (pageNo - 1) * pageSize.value })
    songs.value = list
    hasMore.value = list.length >= pageSize.value
    scrollListTop()
    loadCovers()
    if (!list.length) notice.value = pageNo > 1 ? '没有更多了' : '这位歌手名下没有曲目'
  } catch (e) { notice.value = e.message } finally { loading.value = false }
}

/** 在线内容：输入为空时加载热门榜，有词时搜索。 */
async function refreshOnlineSources() {
  try {
    if (bridge.online?.sources) onlinePlatforms.value = await bridge.online.sources()
    if (bridge.auth?.status) authStatus.value = await bridge.auth.status()
  } catch { /* 忽略 */ }
}

function onOnlinePlatformChange() {
  onlineSongs.value = []
  page.value = 1
  hasMore.value = false
  loadOnline(1)
}

async function loadOnline(pageNo = 1) {
  page.value = pageNo
  loading.value = true; notice.value = ''
  try {
    const isHot = !query.value.trim()
    const r = isHot
      ? await bridge.online.hot({ platform: onlinePlatform.value, page: pageNo, pageSize: pageSize.value, onlyMv: onlineOnlyMv.value })
      : await bridge.online.search({ platform: onlinePlatform.value, keyword: query.value, page: pageNo, pageSize: pageSize.value, onlyMv: onlineOnlyMv.value })
    if (!r.ok) { notice.value = r.error || '在线搜索失败'; return }
    onlineSongs.value = r.songs
    hasMore.value = r.hasMore
    scrollListTop()
    if (!r.songs.length) {
      notice.value = pageNo > 1 ? '没有更多了'
        : (isHot ? '这个平台暂时没有热门内容' : (onlineOnlyMv.value ? `没找到带 MV 的「${query.value}」` : `在线也没找到「${query.value}」`))
    }
  } catch (e) { notice.value = e.message } finally { loading.value = false }
}

function onlineKeyOf(it) { return String(it?.platform || '') + ':' + String(it?.id || '') }
function isOnlineSaved(it) { return onlineSaves.value.some((x) => onlineKeyOf(x) === onlineKeyOf(it)) }

async function refreshOnlineSaves() {
  try { onlineSaves.value = (await bridge.onlineSaves?.list?.()) || [] } catch { /* 忽略 */ }
}

async function toggleOnlineSave(it) {
  if (!bridge.onlineSaves) return
  try {
    // 响应式对象过不了 IPC 的结构化克隆，先转普通对象
    const plain = JSON.parse(JSON.stringify(it))
    onlineSaves.value = isOnlineSaved(it)
      ? await bridge.onlineSaves.remove(onlineKeyOf(it))
      : await bridge.onlineSaves.add(plain)
  } catch { /* 忽略 */ }
}

/** 播放一条在线收藏 */
function playSaved(it) {
  playOnline({
    platform: it.platform, id: it.id, mvId: it.mvId,
    title: it.title, artist: it.artist, duration: it.duration,
    cover: it.cover, hasMv: !!it.mvId,
  })
}

/** 切换「搜歌 / 搜 MV」，已输入关键词时立刻重搜。 */
function setOnlineMode(onlyMv) {
  onlineOnlyMv.value = onlyMv
  onlineSongs.value = []
  page.value = 1
  hasMore.value = false
  loadOnline(1)
}

/** 在线结果右键菜单：目前只做播放和复制歌名。 */
function showOnlineMenu(event, song) {
  menu.value?.open(event, [
    { action: 'playNow', label: '立即唱' },
    { action: 'order', label: '加入已点' },
    ...(canLogin(song.platform) ? [{ action: 'auth', label: '登录该平台账号' }] : []),
    { action: 'play', label: song.hasMv ? '直接播放 MV' : '直接播放' },
    { action: 'playlist', label: '加入歌单' },
    { action: 'copyName', label: '复制歌名' },
  ], {
    title: `${song.title}${song.artist ? ' - ' + song.artist : ''}`,
    onPick: (action) => {
      if (action === 'playNow') playOnlineNow(song)
      else if (action === 'order') orderOnline(song)
      else if (action === 'auth') emit('openAuth', song.platform)
      else if (action === 'play') playOnline(song)
      // 在线歌没有曲库 id，交给上层走 addOnline 流程（会先存元数据再入歌单）
      else if (action === 'playlist') emit('addOnlineToPlaylist', JSON.parse(JSON.stringify(song)))
      else if (action === 'copyName') navigator.clipboard?.writeText(`${song.title} - ${song.artist || ''}`)
    },
  })
}

function onlineFailure(r) {
  if (r?.reason === 'AUTH_REQUIRED' || r?.reason === 'AUTH_EXPIRED') {
    emit('openAuth', r.platform || onlinePlatform.value)
    return '请先登录该平台账号'
  }
  return r?.message || r?.error || ''
}

/** 在线点歌：加入已点队列，空闲时才立即开始。 */
async function orderOnline(item) {
  loading.value = true; notice.value = ''
  try {
    const r = await bridge.queue.orderOnline(JSON.parse(JSON.stringify(item)), {})
    if (r.duplicate) notice.value = r.message || '已经在已点列表里了'
    else if (!r.ok) notice.value = onlineFailure(r) || '点歌失败'
    else if (r.preparing) notice.value = '已加入已点，正在准备播放…'
    else notice.value = r.startedImmediately ? '已加入已点并开始播放' : '已加入已点'
  } catch (e) { notice.value = e.message } finally { loading.value = false }
}

/** 在线立即唱：加入已点并马上切过去。 */
async function playOnlineNow(item) {
  loading.value = true; notice.value = ''
  try {
    const r = await bridge.queue.orderOnline(JSON.parse(JSON.stringify(item)), { playNow: true })
    if (!r.ok) notice.value = onlineFailure(r) || '立即唱失败'
    else if (r.preparing) notice.value = '已加入已点，正在准备播放…'
    else notice.value = r.kind === 'mv' ? '正在播放 MV' : '正在播放'
  } catch (e) { notice.value = e.message } finally { loading.value = false }
}

/** 在线点播：有 MV 就播 MV（网易云 mp4 直链），否则播酷我音频。 */
async function playOnline(item) {
  loading.value = true; notice.value = ''
  try {
    // 响应式对象是 Proxy，Electron IPC 的结构化克隆无法处理，必须先转成普通对象
    const r = await bridge.online.play(JSON.parse(JSON.stringify(item)))
    if (!r.ok) notice.value = onlineFailure(r) || '在线播放失败'
    else notice.value = r.kind === 'mv' ? `正在播放 MV（${r.quality}p）` : '正在播放在线音频'
  } catch (e) { notice.value = e.message } finally { loading.value = false }
}
async function loadLocal() {
  loading.value = true; notice.value = ''
  hasMore.value = false      // 本地文件是一次扫完的，没有"下一页"
  try {
    localSongs.value = await bridge.library.scan()
    // 本地文件也试着配封面（按文件名猜歌名，多半查不到，查不到就保持占位）
    mediaRoot.value = await bridge.library.mediaRoot()
    await refreshLocalFiles()
    if (!localSongs.value.length) notice.value = '本地没有媒体文件'
  } catch (e) { notice.value = e.message } finally { loading.value = false }
}

/** 改每页条数：回到第 1 页重新加载（页码会失去意义） */
async function setPageSize(n) {
  const v = PAGE_OPTIONS.includes(Number(n)) ? Number(n) : 30
  if (v === pageSize.value) return
  pageSize.value = v
  try { await bridge.settings.update({ pageSize: v }) } catch { /* 存不上也不影响本次 */ }
  gotoPage(1)
}

/** 输入框跳页：非法值就当没输入 */
function jumpTo(e) {
  const raw = Number(e.target.value)
  if (!Number.isFinite(raw) || raw < 1) { e.target.value = page.value; return }
  const target = Math.round(raw)
  if (target === page.value) { e.target.value = page.value; return }
  gotoPage(target)
}

async function refreshHistory() {
  try { searchHistory.value = (await bridge.searchHistory?.list?.()) || [] } catch { /* 忽略 */ }
}

/** 点历史词：填回输入框并直接搜 */
function useHistory(kw) {
  query.value = kw
  runSearch(1)
}

async function clearHistory() {
  try { await bridge.searchHistory?.clear?.() } catch { /* 忽略 */ }
  searchHistory.value = []
}

/** 重新拉首字母分布（筛选变了计数也要跟着变，否则点进去是空的） */
async function refreshLetters() {
  try {
    letters.value = await bridge.catalog.singerLetters({
      area: filterArea.value, type: filterType.value,
    })
  } catch { /* 忽略 */ }
}

/** 地区/类型变了：清掉首字母，回第 1 页重查 */
function applySingerFilter() {
  activeLetter.value = ''
  refreshLetters()
  loadSingers(1)
}

/** 点首字母：清掉搜索词（两者一起用没意义），回到第 1 页 */
function pickLetter(L) {
  activeLetter.value = activeLetter.value === L ? '' : L
  query.value = ''
  loadSingers(1)
}

/** 翻到第 n 页（按当前标签分发）。 */
function gotoPage(n) {
  const target = Math.max(1, Math.round(Number(n) || 1))
  if (loading.value) return
  if (tab.value === 'online') return loadOnline(target)
  if (tab.value === 'singers') return loadSingers(target)
  if (tab.value === 'singerSongs') return openSinger(currentSinger.value, target)
  if (tab.value === 'search') return runSearch(target)
  return loadHot(target)
}

/** 上一页 / 下一页（遥控器和键盘都用这两个） */
function prevPage() { if (page.value > 1) gotoPage(page.value - 1) }
function nextPage() { if (hasMore.value) gotoPage(page.value + 1) }

// 切模式时当前页签可能不存在了（比如从曲库的"歌手"切到在线模式），要挪到默认页
watch(() => props.sourceMode, (m) => {
  if (!tabs.value.some((t) => t.id === tab.value)) {
    // ⚠️ 必须走 switchTab（它会去 loadHot/loadSingers…）。
    // 直接 `tab.value = 'hot'` 只换了页签、**不加载数据** ——
    // 用户切完数据源会看到一片「没有结果」。
    switchTab(m === 'online' ? 'online' : 'hot')
  }
  // 在线模式默认搜 MV —— 用户切到在线源就是冲着"不卡的 MV"来的
  onlineOnlyMv.value = m === 'online'
})

/**
 * 清空搜索词。
 * 遥控器/小键盘输字麻烦，清空同样不该靠一路退格 —— 清完直接回到该页签的默认内容。
 */
function focusSearch() {
  nextTick(() => searchInput.value?.focus())
}

function clearQuery() {
  query.value = ''
  switchTab(tab.value)
}

/**
 * 没头像的歌手用一个由**名字算出来**的渐变色兜底。
 * 同一个名字永远是同一个颜色（纯函数，不用存），比统一的灰底字母好看，
 * 一屏里也能靠颜色快速区分不同歌手。
 */
function avatarTint(name) {
  let h = 0
  for (const ch of String(name || '?')) h = (h * 31 + ch.codePointAt(0)) % 360
  return `linear-gradient(140deg, hsl(${h} 40% 34%), hsl(${(h + 42) % 360} 36% 22%))`
}

function switchTab(id) {
  tab.value = id
  notice.value = ''
  // ⚠️ page / hasMore 都是跨标签共享的状态，切标签必须一起重置：
  // 不重置的话从热歌榜（有下一页）切到"本地文件"（只有 13 首）会显示"下一页"。
  page.value = 1
  hasMore.value = false
  if (id === 'online') { onlineSongs.value = []; refreshOnlineSaves(); loadOnline(1) }
  if (id === 'hot') loadHot(1)
  else if (id === 'local') loadLocal()
  else if (id === 'singers') loadSingers(1)
  else if (id === 'search') { songs.value = []; refreshHistory() }
}

const mediaRoot = ref('')

onMounted(async () => {
  try {
    const st = await bridge.catalog.status()
    catalogReady.value = !!st.ready
    catalogInfo.value = st.ready
      ? `${st.songs.toLocaleString()} 首 · ${st.singers.toLocaleString()} 位歌手`
      : (st.error || '')
  } catch (e) { catalogInfo.value = e.message }

  if (catalogReady.value) {
    try { languages.value = await bridge.catalog.languages() } catch { /* 忽略 */ }
    await refreshLetters()
    try {
      const f = await bridge.catalog.singerFacets()
      singerAreas.value = f.areas || []
      singerTypes.value = f.types || []
    } catch { /* 忽略 */ }
  }
  // 每页条数 / 封面开关是用户偏好，启动时读一次（hover 时不重复读）
  try {
    const s = await bridge.settings.get()
    if (PAGE_OPTIONS.includes(Number(s.pageSize))) pageSize.value = Number(s.pageSize)
    if (s.showCovers === false) coversEnabled.value = false
  } catch { /* 忽略 */ }
  try {
    const ps = await bridge.providers.status()
    providers.value = ps.available || []
  } catch { /* 忽略 */ }

  if (bridge.onCatalogProgress) bridge.onCatalogProgress(onCatalogProgress)

  // 主进程解析完一张封面就推过来，直接塞进 map
  offCoverReady = bridge.covers?.onReady?.(({ songId, url }) => {
    if (url) covers.value = { ...covers.value, [songId]: url }
  })

  await refreshLocalFiles()
  await refreshHistory()
  await refreshOnlineSaves()
  await refreshOnlineSources()
  await loadHot(1)     // ⚠️ 参数是页码不是 reset 布尔值，传 true 会渲染成「第 true 页」
})

/**
 * 遥控器 / 键盘导航。
 *
 * KTV 现场常常是遥控器或小键盘，只能上下+确定。这里让曲库列表支持：
 *   ↑ / ↓  移动选中项（自动滚动到可视区）
 *   Enter  对选中项执行"默认动作"（歌曲=点歌，歌手=进歌手页，本地文件=播放）
 *
 * 输入框里不拦截（搜索时上下键要能正常用）。
 */
const currentList = computed(() => {
  if (tab.value === 'singers') return singers.value
  if (tab.value === 'local') return localSongs.value
  if (tab.value === 'online') return onlineSongs.value.map((s) => ({ ...s, id: s.platform + '-' + s.id }))
  return songs.value
})

/** 选中项的"默认动作" */
function activate(item) {
  if (!item) return
  if (tab.value === 'singers') return openSinger(item, 1)
  if (tab.value === 'local') return emit('playLocal', item)
  if (tab.value === 'online') {
    const raw = onlineSongs.value.find((s) => s.platform + '-' + s.id === item.id)
    if (raw) orderOnline(raw)
    return
  }
  order(item)
}

/**
 * 查当前这一页的封面。
 *
 * 曲库没有封面数据，只能按歌名+歌手去网易云查 —— 所以：
 *   - 只查**当前这一页**（30/50/100 条），不预取整个列表
 *   - 主进程侧严格限速 + 按 songId 永久缓存，查过一次就不再请求
 *   - 结果一张一张推回来（covers:ready），封面是"冒出来"的，不阻塞列表
 */
/** 首屏立即查多少张；其余的等鼠标移上去再查（省请求） */
const EAGER_COVERS = 12
const coversEnabled = ref(true)

/** 把一个列表项转成封面服务要的形状 */
function coverItem(x) {
  return { id: x.id, name: x.title || x.name, singer: x.artist || x.singer }
}

/**
 * 查封面。
 *
 * 策略：**首屏前 EAGER_COVERS 行立即查，其余等 hover**。
 * 全页预取的话，翻一页热歌榜就是 30 次请求；只查首屏 + hover
 * 能把大部分"用户根本没看"的请求省掉，而可见区域又不会空着。
 *
 * @param {Array} [only] 指定条目（hover 用）；不传就取当前列表前 N 行
 */
async function loadCovers(only) {
  if (!bridge.covers?.lookup || !coversEnabled.value) return
  const src = only || currentList.value.slice(0, EAGER_COVERS)
  const items = src.map(coverItem).filter((x) => x.id && x.name && !covers.value[x.id])
  if (!items.length) return
  try {
    const known = await bridge.covers.lookup(items)
    if (known && Object.keys(known).length) covers.value = { ...covers.value, ...known }
  } catch { /* 忽略 */ }
}

/** 鼠标移上去才查这一条 */
function coverOnHover(x) {
  if (!coversEnabled.value || covers.value[x.id]) return
  loadCovers([x])
}

/** 封面加载失败（接口挂了/网络不通）就把图藏掉，别显示一个破图图标 */
function hideBrokenCover(e) {
  e.target.style.display = 'none'
}

function scrollToSelected() {
  const el = document.querySelector('.catalog .list .song.selected')
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
}

function onKey(e) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  const list = currentList.value
  if (!list.length) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const idx = list.findIndex((x) => x.id === selectedId.value)
    const delta = e.key === 'ArrowDown' ? 1 : -1
    const next = idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + delta))
    selectedId.value = list[next].id
    nextTick(scrollToSelected)
  } else if (e.key === 'PageDown') {
    // 遥控器/键盘翻页
    e.preventDefault()
    nextPage()
  } else if (e.key === 'PageUp') {
    e.preventDefault()
    prevPage()
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault()
    const idx = e.key === 'Home' ? 0 : list.length - 1
    selectedId.value = list[idx].id
    nextTick(scrollToSelected)
  } else if (e.key === 'Enter') {
    const item = list.find((x) => x.id === selectedId.value)
    if (!item) return
    e.preventDefault()
    activate(item)
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  offCoverReady?.()
})

defineExpose({ refreshLocalFiles, isPlayable, refreshAuth: refreshOnlineSources })
</script>

<style scoped>
.catalog { display: flex; flex-direction: column; height: 100%; min-height: 0; container-type: inline-size; }

/* 下划线标签：扁平样式，和上面的分段控件区分开 */
.tabs {
  display: flex; gap: 2px; padding: 8px 10px 0; align-items: center;
  flex-wrap: nowrap; border-bottom: 1px solid var(--line); overflow-x: auto;
}
.tabs button {
  flex: none; white-space: nowrap;
  padding: 7px 10px 6px; font-size: 13px;
  border: 0; border-radius: 0; background: transparent; color: var(--dim);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tabs button:hover:not(.active) { color: var(--text); background: transparent; }
.tabs button.active {
  background: transparent; border-color: transparent;
  border-bottom-color: var(--focus); color: var(--focus); font-weight: 600;
}

.stat { font-size: 12px; color: var(--dim); }
.stat.warn { color: var(--gold); }
.status-line {
  display: flex; align-items: center; gap: 6px; padding: 6px 14px 0;
  font-size: 12px; overflow: hidden; white-space: nowrap;
}
.status-line .stat { overflow: hidden; text-overflow: ellipsis; }
.dot-sep { color: var(--line-2); flex: none; }

/* 允许换行：歌手页有「搜索框 + 搜索 + 地区 + 类型」四件，
   400px 的右栏一行放不下，原来最后一个下拉会被裁掉半截。 */
.toolbar {
  display: flex; flex-wrap: wrap; gap: 7px 8px; align-items: center;
  padding: 8px 12px 9px; background: color-mix(in srgb, var(--panel) 82%, transparent);
}
.toolbar .clear-q {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 7px 8px; font-size: 12px; line-height: 1; color: var(--dim);
}
.toolbar .clear-q:hover { color: var(--text); }
.toolbar button { flex: none; white-space: nowrap; }
.search-wrap {
  flex: 1 1 140px; min-width: 110px;
  display: flex; align-items: center; gap: 7px;
  background: var(--panel-2); color: var(--dim);
  border: 1px solid var(--line); border-radius: 9px; padding: 0 10px;
  transition: border-color .12s, box-shadow .12s, background .12s;
}
.search-wrap:hover { border-color: var(--btn-border-hover); }
.search-wrap:focus-within {
  border-color: var(--focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 22%, transparent);
}
.toolbar .search {
  flex: 1; min-width: 0; width: 100%;
  background: transparent; color: var(--text);
  border: 0; padding: 8px 0; font: inherit; outline: none;
}
.count { font-size: 12px; color: var(--dim); margin-right: 8px; flex: none; }
.platform-select { max-width: 120px; flex: none; }
.account-btn.auth { border-color: color-mix(in srgb, var(--focus) 58%, var(--line)); color: var(--focus); }
.account-btn.warn { border-color: #d89b35; color: #f0b84b; }
.online-hot-head { display: flex; align-items: center; gap: 6px; padding: 8px 12px 4px; color: var(--focus); font-size: 12px; font-weight: 600; }
.auth-tag { color: #f0b84b; }
.mini-seg {
  display: inline-flex; border: 1px solid var(--line); border-radius: 9px;
  overflow: hidden; flex: none; padding: 2px; background: var(--panel-2);
}
.mini-seg button { border: 0; border-radius: 7px; padding: 5px 9px; font-size: 12px; background: transparent; color: var(--dim); }
.mini-seg button.active { background: var(--focus-fill); color: var(--on-focus); }
.mv-tag { color: var(--focus); font-weight: 600; }
.toolbar .filters { display: flex; gap: 7px; flex: none; }
.toolbar select {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
  border-radius: 9px; padding: 8px 6px; font-size: 13px; max-width: 86px; flex: none;
}
.crumb { font-size: 12px; color: var(--dim); }

/* 窄栏优先隐藏次要控件，保证搜索框和主操作不被挤扁 */
@container (max-width: 560px) {
  .toolbar .count { display: none; }
}
@container (max-width: 430px) {
  .toolbar .crumb { display: none; }
}
/* 窄栏下把「下首」收起来 —— 歌名比它更该有空间；右键菜单里还有一项 */
@container (max-width: 430px) {
  .col-actions .next-btn { display: none; }
}
/* 提示文字比图例本身还长，窄栏下先让它走 */
@container (max-width: 520px) {
  .legend .hint { display: none; }
}

.list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px 12px; }

/* 「下首」默认隐藏，鼠标悬停/键盘聚焦该行时才出现 ——
   它每行都占 46px，而列表里最值钱的就是歌名那点宽度。
   键盘用户：Tab 能聚焦到它（:focus-within 会把整行点亮）。 */
.song .next-btn { opacity: 0; transition: opacity .12s; }
.song:hover .next-btn,
.song:focus-within .next-btn { opacity: 1; }
.song .next-btn:disabled { opacity: .35; }

/* 两行式行布局：窄栏（400px）里比多列 grid 更稳，
   多列 grid 的固定列会挤掉 1fr 的歌名列，导致歌名看不见。 */
.song {
  position: relative; display: flex; align-items: center; gap: 9px; text-align: left;
  margin: 0; background: transparent; border: 0;
  border-top: 1px solid color-mix(in srgb, var(--line) 72%, transparent);
  border-radius: 0; padding: 8px 10px; cursor: pointer;
  transition: background .12s, box-shadow .12s;
}
.song:first-child { border-top-color: transparent; }
.song:hover, .song:focus-visible { background: var(--row-hover); }
.song.selected {
  background: var(--row-hover);
  box-shadow: inset 3px 0 var(--online);
}
.song.current {
  background: var(--row-active);
  box-shadow: inset 3px 0 var(--focus);
}
.song.current.selected { box-shadow: inset 3px 0 var(--focus); }

.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.info .name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.info .meta {
  display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dim);
  overflow: hidden; white-space: nowrap;
}
.info .meta .singer { overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
.info .meta i { font-style: normal; color: var(--line-2); }
.song.queued .info .name { color: var(--dim); }

.queued-badge {
  font-size: 11px; padding: 3px 7px; border-radius: 6px; white-space: nowrap;
  background: var(--row-active); color: var(--focus); border: 1px solid var(--focus-hover);
}

.col-actions { display: flex; gap: 4px; justify-content: flex-end; flex: none; }
.song .col-actions .mini {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 4px 7px; font-size: 12px; color: var(--dim);
  background: transparent; border-color: transparent;
}
.song .col-actions .mini:hover:not(:disabled) { color: var(--text); background: var(--btn); border-color: var(--line); }
.song .col-actions .mini.faved { color: var(--gold); border-color: transparent; background: transparent; }
.song .col-actions .next-btn { padding-inline: 8px; }

.dl {
  font-size: 11px; padding: 3px 7px; border-radius: 6px; white-space: nowrap;
  background: var(--btn); color: var(--dim); border: 1px solid var(--line);
}
.dl.downloading { color: var(--gold); border-color: var(--gold-line); }
.dl.done { color: var(--focus); border-color: var(--focus-hover); }
.dl.failed { color: var(--accent); border-color: var(--accent-bg); }

/* 本地可播标记 */
.playable {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: var(--line-2); flex: none;
}
.playable.on { background: var(--focus); box-shadow: 0 0 6px var(--focus); }
.playable.online { background: var(--online); box-shadow: 0 0 6px var(--online); }

/* 歌手头像：圆形，和歌曲封面区分开 */
.song .avatar {
  width: 38px; height: 38px; border-radius: 50%; flex: none;
  object-fit: cover; background: var(--panel-2);
}
.song .avatar-none {
  display: flex; align-items: center; justify-content: center;
  font-size: 17px; font-weight: 600; color: #fff;
  border: 1px solid rgba(255, 255, 255, .12);
  text-shadow: 0 1px 2px rgba(0, 0, 0, .45);
}

/* ── 歌手行 ──────────────────────────────────────────────
   头像 38 → 46，名字加粗，地区/类型做成小胶囊，右侧一个「›」提示可点进去。
   原来的"热度 2147483647"直接删掉 —— 那是库里的哨兵值（INT32_MAX），
   对用户没有任何意义，还特别扎眼。 */
.song.singer { padding: 8px 10px; gap: 10px; }
.song.singer .avatar { width: 44px; height: 44px; }
.song.singer .info { gap: 5px; }
.song.singer .name { font-size: 15px; font-weight: 600; letter-spacing: .2px; }
.song.singer .meta { gap: 5px; }
.chip {
  font-size: 11px; line-height: 16px; padding: 0 8px; border-radius: 999px;
  background: var(--panel-3); border: 1px solid var(--line); color: var(--dim);
}
.song.singer .go {
  flex: none; padding: 0 2px; font-size: 20px; line-height: 1;
  color: var(--dim-2); transition: color .12s, transform .12s;
}
.song.singer:hover .go { color: var(--focus); transform: translateX(2px); }

/* 歌手页：按右栏实际宽度自动排成多列。
   右栏 400px 时稳定两列；窗口/分栏变宽后自动变三列、四列。
   歌曲、在线结果、本地文件仍走单列列表。 */
.list.list-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(138px, 1fr));
  gap: 7px;
  align-content: start;
  padding: 8px;
}
.list.list-grid .song.singer {
  min-width: 0; min-height: 58px;
  padding: 8px; gap: 7px;
  background: var(--panel-2);
  border: 1px solid color-mix(in srgb, var(--line) 78%, transparent);
  border-radius: 9px;
}
.list.list-grid .song.singer:hover {
  background: var(--row-hover);
  border-color: var(--line-2);
  transform: translateY(-1px);
}
.list.list-grid .song.singer .avatar { width: 36px; height: 36px; }
.list.list-grid .song.singer .info { gap: 3px; }
.list.list-grid .song.singer .name { font-size: 13px; letter-spacing: 0; }
.list.list-grid .song.singer .meta { gap: 4px; }
.list.list-grid .song.singer .chip { font-size: 10px; line-height: 15px; padding: 0 5px; }
.list.list-grid .song.singer .go { display: none; }

/* 右栏最窄时强制两列，并优先保留地区，隐藏第二枚类型胶囊。 */
/* A-Z 索引也是 .list 的直接子元素；网格模式下必须横跨全部列，
   否则它会占一个歌手卡位，把第一位歌手挤到右边并拉出很高的空白。 */
.list.list-grid .letters {
  grid-column: 1 / -1;
  padding: 7px 8px;
  border: 1px solid color-mix(in srgb, var(--line) 72%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--panel-2) 82%, transparent);
}

@container (max-width: 430px) {
  .list.list-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .list.list-grid .song.singer .meta .chip:nth-child(2) { display: none; }
}


/* 在线结果的封面缩略图 */
.song .cover {
  width: 42px; height: 42px; border-radius: 6px; flex: none;
  object-fit: cover; background: var(--panel-2);
}
/* 曲库行更挤，封面小一号 */
.song .cover + .playable { margin-left: -4px; }
/* 没有封面时用**名字算出来的渐变色 + 首字**兜底（和歌手头像同一套逻辑）。
   原来是一块灰底斜纹方块，一屏十几行灰块很闷。 */
.song .cover-none {
  display: flex; align-items: center; justify-content: center;
  font-size: 17px; font-weight: 600; color: #fff;
  border: 1px solid rgba(255, 255, 255, .12);
  text-shadow: 0 1px 2px rgba(0, 0, 0, .45);
}

.legend {
  display: flex; gap: 14px; padding: 6px 14px 8px;
  font-size: 12px; color: var(--dim); border-top: 1px solid var(--line);
  /* 不换行：换行会把列表压矮，而且"不可播"会被拆成两行很难看 */
  flex-wrap: nowrap; overflow: hidden;
}
.legend span { display: flex; align-items: center; gap: 6px; white-space: nowrap; flex: none; }

/* 搜索历史：一排可点的词 */
.history-bar {
  display: flex; align-items: center; gap: 6px; padding: 6px 12px 0;
  overflow-x: auto; flex: none;
}
.history-bar .hlabel { flex: none; font-size: 12px; color: var(--dim); }
.history-bar .hchip {
  flex: none; padding: 3px 10px; font-size: 12px; border-radius: 999px;
  background: var(--panel-2); border: 1px solid var(--line); color: var(--text-2);
}
.history-bar .hchip:hover { border-color: var(--focus); color: var(--text); }
.history-bar .hclear { flex: none; padding: 3px 8px; font-size: 12px; color: var(--dim-2); background: transparent; border-color: transparent; }
.song .mini.faved { color: var(--gold); border-color: var(--gold-line); }

/* 歌手首字母索引：横条，窄栏下可横向滚动 */
/* A-Z 索引。
   ⚠️ 原来是 overflow-x:auto + min-width:22px：26 个字母要 648px，
   而右侧栏只有 ~380px —— 结果是一条 14px 高的细带 + 一根横向滚动条，
   字母只露出 A~O。改成**换行排布**，两行放得下，一眼看全。 */
.letters {
  display: flex; flex-wrap: wrap; gap: 3px; padding: 7px 10px;
  border-bottom: 1px solid var(--line); flex: none;
}
.letters button {
  flex: none; min-width: 20px; height: 22px; padding: 0 3px; font-size: 11px;
  border: 1px solid transparent; background: transparent; border-radius: 6px; color: var(--dim);
}
.letters button:hover:not(:disabled) { background: var(--panel-2); }
.letters button.on { background: var(--focus); border-color: var(--focus); color: var(--on-focus-deep); font-weight: 600; }
.letters button:disabled { opacity: .28; cursor: default; }
.letters button.clear { padding: 0 8px; color: var(--gold); border-color: var(--gold-line); }

/* 底部条：图例在左、分页在右，**在滚动区之外**（不再压住列表）。 */
.bottombar {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; min-height: 44px;
  border-top: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel-2) 94%, transparent);
}
.legend {
  display: flex; align-items: center; gap: 10px; flex: 1 1 auto;
  min-width: 0; overflow: hidden; white-space: nowrap;
  font-size: 11px; color: var(--dim);
}
.legend span { flex: none; }
.pager { flex: none; display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--dim); }
.page-nav {
  display: flex; align-items: center; gap: 3px; padding: 2px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 9px;
}
.pager button, .pager .pg {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 5px 6px; font-size: 12px; line-height: 1;
  background: transparent; border-color: transparent;
}
.pager button:hover:not(:disabled) { background: var(--btn); border-color: transparent; }
.pager .pinfo { display: flex; align-items: center; gap: 2px; padding: 0 2px; white-space: nowrap; }
.pager .psize { display: flex; align-items: center; gap: 4px; }
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
@container (max-width: 430px) {
  .pager .psize-label { display: none; }
  .legend { gap: 7px; }
}
/* ⚠️ 三个状态不能只靠颜色区分（色弱用户看不出绿/蓝）。
   形状也给一个维度：本地=实心圆、在线=空心圆环、不可播=灰色小方。 */
.playable { border-radius: 50%; }
.playable.on { background: var(--focus); }
.playable.online { background: transparent; border: 2px solid var(--online); }
.playable:not(.on):not(.online) { background: var(--dim-2); border-radius: 2px; }
.legend .playable { margin-right: 0; }

.empty { padding: 30px; text-align: center; color: var(--dim); font-size: 13px; }
.skeleton-list { grid-column: 1 / -1; padding: 8px 10px; }
.skeleton-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 62%, transparent);
}
.skeleton-row:last-child { border-bottom: 0; }
.sk-cover {
  width: 42px; height: 42px; border-radius: 6px; flex: none;
  background: linear-gradient(100deg, var(--panel-2) 25%, var(--panel-3) 42%, var(--panel-2) 60%);
  background-size: 220% 100%; animation: sk-shimmer 1.2s linear infinite;
}
.sk-lines { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.sk-name, .sk-meta {
  display: block; height: 12px; border-radius: 999px;
  background: linear-gradient(100deg, var(--panel-2) 25%, var(--panel-3) 42%, var(--panel-2) 60%);
  background-size: 220% 100%; animation: sk-shimmer 1.2s linear infinite;
}
.sk-name { width: min(72%, 240px); }
.sk-meta { width: min(46%, 160px); height: 9px; opacity: .8; }
@keyframes sk-shimmer { from { background-position: 180% 0; } to { background-position: -40% 0; } }
.empty-card {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  margin: 18px 10px; padding: 28px 18px; border-radius: 10px;
  background: color-mix(in srgb, var(--panel-2) 72%, transparent);
  border: 1px dashed var(--line-2); color: var(--dim);
}
.empty-card b { color: var(--text-2); font-size: 14px; font-weight: 600; }
.empty-card small { color: var(--dim-2); font-size: 12px; }
.empty.notice { color: var(--gold); line-height: 1.7; }
.first-run { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 34px 24px; }
.first-run .fr-title { font-size: 16px; color: var(--text); }
.first-run .fr-desc { font-size: 12px; color: var(--dim); line-height: 1.8; max-width: 360px; }
.first-run button.primary { background: var(--focus-fill); border-color: var(--focus-border); padding: 10px 20px; font-size: 14px; }
.first-run .fr-progress { font-size: 12px; color: var(--focus); }
</style>
