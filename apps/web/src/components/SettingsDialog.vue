<template>
  <teleport to="body">
    <div v-if="open" class="mask" @mousedown.self="close" @dblclick.stop.prevent>
      <div class="dlg">
        <header>
          <span class="title">设置</span>
          <button class="x" aria-label="关闭设置" @click="close"><Icon name="close" :size="16" /></button>
        </header>

        <div class="settings-shell">
          <aside class="settings-nav">
            <label class="settings-search">
              <Icon name="search" :size="15" />
              <input v-model="settingQuery" type="search" placeholder="搜索设置…" @keydown.stop />
            </label>
            <button
              v-for="sec in visibleSettingSections"
              :key="sec.id"
              :class="{ active: activeSection === sec.id }"
              @click="activeSection = sec.id"
            >
              <Icon :name="sec.icon" :size="16" />
              <span>{{ sec.label }}</span>
            </button>
            <div v-if="!visibleSettingSections.length" class="nav-empty">没有匹配的设置</div>
          </aside>
          <div ref="bodyEl" class="body">
          <!-- 视频 -->
          <section v-show="activeSection === 'video'">
            <h3>视频</h3>
            <div class="row">
              <label>播放内核</label>
              <div class="seg">
                <button :class="{ on: s.playbackCore === 'mpv' }" @click="set('playbackCore', 'mpv')">mpv（推荐）</button>
                <button :class="{ on: s.playbackCore === 'libvlc' }" @click="set('playbackCore', 'libvlc')">libVLC</button>
              </div>
            </div>
            <p class="hint">
              <b>mpv</b> 用 ffmpeg 系解复用/解码（和安卓端同源），第三方片源自带损坏时也能满帧播放，<b>默认选它</b>；
              <b>libVLC</b> 是老内核，保留作回退。切换会重建播放器并回到原播放位置。
            </p>
            <div class="row">
              <label>解码方式</label>
              <div class="seg">
                <button :class="{ on: s.videoDecoder === 'auto' }" @click="set('videoDecoder', 'auto')">自动</button>
                <button :class="{ on: s.videoDecoder === 'hardware' }" @click="set('videoDecoder', 'hardware')">硬解</button>
                <button :class="{ on: s.videoDecoder === 'software' }" @click="set('videoDecoder', 'software')">软解</button>
              </div>
            </div>
            <p class="hint">
              硬解省 CPU，但部分老显卡/驱动会花屏或卡顿——<b>画面异常时改成软解</b>。
              切换会重建播放器并自动回到原来的播放位置。
            </p>

            <div class="row">
              <label>网络缓冲</label>
              <input type="range" min="500" max="10000" step="500" :value="s.networkCachingMs"
                @change="set('networkCachingMs', Number($event.target.value))" />
              <span class="val">{{ (s.networkCachingMs / 1000).toFixed(1) }} 秒</span>
            </div>
            <p class="hint">网络不稳导致卡顿时调大；调大后起播会稍慢。</p>

            <div class="row">
              <label>MV 清晰度</label>
              <div class="seg">
                <button :class="{ on: s.onlineMvQuality === 'auto' }" @click="set('onlineMvQuality', 'auto')">自动</button>
                <button :class="{ on: s.onlineMvQuality === '1080' }" @click="set('onlineMvQuality', '1080')">1080P</button>
                <button :class="{ on: s.onlineMvQuality === '720' }" @click="set('onlineMvQuality', '720')">720P</button>
                <button :class="{ on: s.onlineMvQuality === '480' }" @click="set('onlineMvQuality', '480')">480P</button>
              </div>
            </div>
            <p class="hint">优先选择指定清晰度；源站没有该档位时自动选最接近的一档。QQ MV 会从 HLS 清单中选择。</p>

            <div class="row">
              <label>流畅模式</label>
              <div class="seg">
                <button :class="{ on: s.smoothPlayback === false }" @click="set('smoothPlayback', false)">关（推荐）</button>
                <button :class="{ on: s.smoothPlayback !== false }" @click="set('smoothPlayback', true)">开</button>
              </div>
            </div>
            <p class="hint">
              显示器刷新率常常不是片源帧率的整数倍（例如 <b>75Hz 显示器 + 30fps 的 MV</b>），
              每帧停留的刷新次数会变成 3:2:3:2 的锯齿，肉眼就是<b>一卡一卡的顿挫</b>。
              打开后由播放器按显示节奏补帧。<b>默认关</b> —— 它要求显示器刷新率能被准确测出来，
              测不准（虚拟显示器/DWM 时钟不稳）时反而会持续顿挫和音画漂移。
            </p>
          </section>

          <!-- 播放 -->
          <section v-show="activeSection === 'playback'">
            <h3>播放</h3>
            <div class="row">
              <label>默认原伴唱</label>
              <div class="seg">
                <button :class="{ on: s.defaultVocalMode === 'original' }" @click="set('defaultVocalMode', 'original')">原唱</button>
                <button :class="{ on: s.defaultVocalMode === 'accompaniment' }" @click="set('defaultVocalMode', 'accompaniment')">伴唱</button>
              </div>
            </div>
          </section>

          <!-- 主题 -->
          <section v-show="activeSection === 'theme'">
            <h3>界面主题</h3>
            <div class="row">
              <label>配色</label>
              <div class="seg themes">
                <button
                  v-for="t in THEMES"
                  :key="t.id"
                  :class="{ on: s.theme === t.id }"
                  :title="t.desc"
                  @click="set('theme', t.id)"
                >
                  <i class="sw" :style="{ background: t.bg, borderColor: t.line }">
                    <b :style="{ background: t.accent }"></b>
                  </i>{{ t.label }}
                </button>
              </div>
            </div>
            <div class="row">
              <label>显示密度</label>
              <div class="seg">
                <button :class="{ on: s.uiDensity === 'auto' }" @click="set('uiDensity', 'auto')">自动</button>
                <button :class="{ on: s.uiDensity === 'comfortable' }" @click="set('uiDensity', 'comfortable')">舒适</button>
                <button :class="{ on: s.uiDensity === 'tv' }" @click="set('uiDensity', 'tv')">大屏 / 遥控器</button>
              </div>
            </div>
            <p class="hint">
              六种配色：<b>暗夜</b>、<b>午夜蓝</b>、<b>暖棕</b>、<b>浅色</b>、<b>舞台霓虹</b>、<b>翡翠</b>。
              显示密度“自动”会在大窗口启用更大的行高和按钮，适合电视/触屏。
            </p>
          </section>

          <!-- 播放诊断：用户说"卡/马赛克"时，先看这里就能分清是哪一种 -->
          <section v-show="activeSection === 'diagnostics'">
            <h3>播放诊断</h3>
            <div class="row">
              <label>正在播</label>
              <span class="val wide path-text" :title="diag.path">{{ diag.name }}</span>
            </div>
            <div class="row">
              <label>片源类型</label>
              <span class="val wide">{{ diag.source }}</span>
            </div>
            <div class="row">
              <label>画面</label>
              <span class="val wide">{{ diag.video }}</span>
            </div>
            <p class="hint">
              在线 MV 说"马赛克"时先看这两行：
              <b>画面只有 480p</b> → 这首歌本身最高就只有标清，放大后就是糊/块状，换哪套源都一样；
              <b>片源类型是「本地文件 / 麦动曲库」</b> → 播的其实是麦动那份带损坏包的片源
              （在「在线源」模式下从<b>已点 / 已唱 / 收藏</b>里点歌就会这样），不是在线源的问题。
              <b>丢帧</b>一直涨才是真的卡；解码器报错会让画面出现马赛克块。
            </p>
          </section>
          <!-- 数据源：两套环境二选一 -->
          <section v-show="activeSection === 'source'">
            <h3>数据源（二选一）</h3>
            <div class="row">
              <label>用哪套源</label>
              <div class="seg">
                <button :class="{ on: s.sourceMode !== 'online' }" @click="set('sourceMode', 'maidong')">麦动曲库</button>
                <button :class="{ on: s.sourceMode === 'online' }" @click="set('sourceMode', 'online')">在线源</button>
              </div>
            </div>
            <p class="hint">
              <b>麦动曲库</b>：67 万首、歌手/语种分类齐全，但它的 MV 片源本身带周期性损坏包，
              视频可能卡（同一首换在线源就顺）。<b>在线源</b>：直接搜网易云/酷我，视频流畅，冷门歌可能搜不到。<br />
              两个模式<b>互斥</b>：右侧页签会整块换掉，切到哪个就只有哪个的搜索入口，不会混着点。
            </p>
            <div class="row">
              <label>平台账号</label>
              <span class="val wide">网易云 / QQ音乐 / 酷狗 / 咪咕，扫码登录或导入 Cookie</span>
              <button @click="$emit('openAuth', 'netease')">管理账号</button>
            </div>
          </section>

          <!-- 数据位置 -->
          <section v-show="activeSection === 'data'">
            <h3>数据位置</h3>
            <div class="row">
              <label>应用版本</label>
              <span class="val wide">KTV Desktop {{ appPaths.version || '—' }} · Electron {{ appPaths.electronVersion || '—' }} · Chromium {{ appPaths.chromeVersion || '—' }}</span>
            </div>
            <div class="row">
              <label>数据目录</label>
              <span class="val wide path-text" :title="appPaths.dataRoot">{{ appPaths.dataRoot || '—' }}</span>
              <button @click="openDataDir">打开</button>
            </div>
            <div class="row">
              <label>曲库目录</label>
              <span class="val wide path-text" :title="appPaths.catalogDir">{{ appPaths.catalogDir || '—' }}</span>
              <button :disabled="migrating" @click="migrateCatalog">{{ migrating ? '迁移中…' : '迁移曲库' }}</button>
            </div>
            <p class="hint">
              曲库、用户状态、取流配置都放这里。<b>默认会选非系统盘中剩余空间最大的那个</b>
              （曲库 988MB + 缓存会很快占满 C 盘）。
              也可用环境变量 <code>KTV_DATA_DIR</code> 或启动参数 <code>--data-dir=</code> 指定。
            </p>
            <div class="row">
              <label>libVLC</label>
              <span class="val wide path-text" :title="appPaths.vlcDir">{{ appPaths.vlcDir || '—' }}</span>
            </div>
          </section>

          <!-- 缓存 -->
          <section v-show="activeSection === 'cache'">
            <h3>缓存</h3>
            <div class="row">
              <label>缓存目录</label>
              <input class="path" :value="cacheDir" readonly />
              <button @click="pickDir">选择…</button>
              <button @click="openDir">打开</button>
            </div>
            <p class="hint">点过的歌会自动缓存到这里，下次直接播本地文件。</p>

            <div class="row">
              <label>队列预下载</label>
              <div class="seg">
                <button :class="{ on: s.prefetchDepth === 0 }" @click="set('prefetchDepth', 0)">关闭</button>
                <button :class="{ on: s.prefetchDepth === 1 }" @click="set('prefetchDepth', 1)">下一首</button>
                <button :class="{ on: s.prefetchDepth === 3 }" @click="set('prefetchDepth', 3)">接下来 3 首</button>
                <button :class="{ on: s.prefetchDepth === 5 }" @click="set('prefetchDepth', 5)">接下来 5 首</button>
              </div>
            </div>
            <p class="hint">
              <b>点歌后立刻把接下来要唱的几首缓存到本地</b>，轮到它们时直接读本地文件，不会再"边下边播"。
              关掉的话就只缓存正在播的那首（更省带宽，但下一首起播可能受网络影响）。
            </p>

            <div class="row">
              <label>下载限速</label>
              <input type="range" min="0" max="8192" step="128" :value="Math.round(s.cacheMaxBytesPerSecond / 1024)"
                @change="set('cacheMaxBytesPerSecond', Number($event.target.value) * 1024)" />
              <span class="val">{{ s.cacheMaxBytesPerSecond ? Math.round(s.cacheMaxBytesPerSecond / 1024) + ' KB/s' : '不限速' }}</span>
            </div>
            <p class="hint">后台缓存抢带宽会让正在播的歌卡顿，默认限到 512 KB/s。</p>
            <div class="row">
              <label>缓存时机</label>
              <div class="seg">
                <button :class="{ on: !s.cacheOnlyWhenIdle }" @click="set('cacheOnlyWhenIdle', false)">播放时也缓存</button>
                <button :class="{ on: s.cacheOnlyWhenIdle }" @click="set('cacheOnlyWhenIdle', true)">仅空闲时</button>
              </div>
            </div>
            <p class="hint"><b>播放时卡顿的话选「仅空闲时」</b>——完全不和播放抢带宽。</p>

            <div class="row">
              <label>缓存文件</label>
              <button @click="toggleCacheList">{{ cacheOpen ? '收起' : '查看' }}（{{ cacheStats.count }} 首 · {{ fmtSize(cacheStats.bytes) }}）</button>
              <button @click="refreshCacheList" :disabled="!cacheOpen">刷新</button>
            </div>
            <div v-if="cacheOpen" class="cache-list">
              <div v-if="!cacheFiles.length" class="hint" style="margin-left:0">还没有缓存文件</div>
              <div v-for="f in cacheFiles" :key="f.filename" class="cache-row">
                <span class="cname" :title="f.filename">{{ f.filename }}</span>
                <span class="csize">{{ fmtSize(f.bytes) }}</span>
                <span class="ctime">{{ fmtDate(f.mtime) }}</span>
                <span v-if="f.playing" class="cplay">播放中</span>
                <button :disabled="f.playing" @click="removeCacheFile(f)">删除</button>
              </div>
            </div>

            <div class="row">
              <label>歌词显示</label>
              <div class="seg">
                <button :class="{ on: s.lyricsOnVideo }" @click="set('lyricsOnVideo', true)">画面内</button>
                <button :class="{ on: s.showLyrics }" @click="set('showLyrics', true)">底部条</button>
                <button :class="{ on: !s.lyricsOnVideo && !s.showLyrics }"
                  @click="setBothLyricsOff">都关</button>
              </div>
            </div>
            <div class="row">
              <label>画面歌词位置</label>
              <div class="seg">
                <button :class="{ on: s.lyricsPos === 'bottom' }" @click="set('lyricsPos', 'bottom')">画面底部（推荐）</button>
                <button :class="{ on: s.lyricsPos === 'center' }" @click="set('lyricsPos', 'center')">屏幕正中</button>
              </div>
            </div>
            <div class="row">
              <label>滚动特效</label>
              <div class="seg">
                <button :class="{ on: s.lyricsScroll !== false }" @click="set('lyricsScroll', true)">开（推荐）</button>
                <button :class="{ on: s.lyricsScroll === false }" @click="set('lyricsScroll', false)">关</button>
              </div>
            </div>

            <div class="row">
              <label>歌词偏移</label>
              <input type="range" min="-10000" max="10000" step="100" :value="s.lyricsOffsetMs"
                @change="set('lyricsOffsetMs', Number($event.target.value))" />
              <span class="val">{{ s.lyricsOffsetMs > 0 ? '+' : '' }}{{ (s.lyricsOffsetMs / 1000).toFixed(1) }} 秒</span>
            </div>
            <p class="hint">MV 歌词比画面早时调正数，歌词比画面晚时调负数。</p>

            <p class="hint">
              两个是<b>独立开关</b>，可以只开一个、都开、都关。
              <b>默认只开「画面内」</b>——MV 往往自带歌词，底下再叠一条会重复。
              画面内是让播放器自己把歌词渲染进视频（视频是原生窗口，网页元素叠不上去）。
            </p>

            <div class="row">
              <label>片源修复</label>
              <div class="seg">
                <button :class="{ on: s.repairMode === 'remux' }" @click="set('repairMode', 'remux')">只修卡顿</button>
                <button :class="{ on: s.repairMode === 'transcode' }" @click="set('repairMode', 'transcode')">连马赛克一起</button>
                <button :class="{ on: s.repairMode === 'off' }" @click="set('repairMode', 'off')">不修</button>
              </div>
            </div>
            <p class="hint">
              maidong 的片源带损坏包（实测一首里有 70 处），会造成<b>卡顿</b>和<b>马赛克</b>两个问题。
              <b>只修卡顿</b>：重建时间戳，约 3 秒，无损。<b>连马赛克一起</b>：重编码视频，约 9 秒，画质损失极小。
            </p>

            <div class="row">
              <label>起播方式</label>
              <div class="seg">
                <button :class="{ on: !s.cacheBeforePlay }" @click="set('cacheBeforePlay', false)">立刻播（起播快）</button>
                <button :class="{ on: s.cacheBeforePlay }" @click="set('cacheBeforePlay', true)">先缓存再播（首次就顺）</button>
              </div>
            </div>
            <p class="hint">
              <b>立刻播</b>：马上出声，但首次播放仍是未修复的在线流，会卡、可能有马赛克。
              <b>先缓存再播</b>：点歌后先下载并修复完再开始，起播要等几秒到十几秒，但第一次唱就是顺的。
            </p>

            <div class="row">
              <label>容量上限</label>
              <input type="range" min="1" max="100" step="1" :value="Math.round(s.cacheMaxBytes / 1024 / 1024 / 1024)"
                @change="set('cacheMaxBytes', Number($event.target.value) * 1024 * 1024 * 1024)" />
              <span class="val">{{ Math.round(s.cacheMaxBytes / 1024 / 1024 / 1024) }} GB</span>
            </div>

            <div class="row">
              <label>当前占用</label>
              <span class="val wide">{{ cacheInfo }}</span>
              <button class="danger" @click="clearCache">清空缓存</button>
            </div>
          </section>

          <!-- 手机点歌 -->
          <section v-show="activeSection === 'lan'">
            <h3>手机点歌</h3>
            <div class="row">
              <label>局域网服务</label>
              <div class="seg">
                <button :class="{ on: s.lanEnabled }" @click="set('lanEnabled', true)">开启</button>
                <button :class="{ on: !s.lanEnabled }" @click="set('lanEnabled', false)">关闭</button>
              </div>
              <span class="val">{{ lan.running ? '运行中' : (s.lanEnabled ? '未启动' : '已关闭') }}</span>
              <button @click="$emit('openLan')">大屏二维码</button>
            </div>
            <div class="row">
              <label>端口</label>
              <input class="num" type="number" min="1024" max="65535" :value="s.lanPort"
                @change="set('lanPort', Number($event.target.value))" />
              <span class="val">被占用时会自动往后试</span>
            </div>
            <template v-if="lan.running">
              <div class="row">
                <label>手机打开</label>
                <span class="val wide mono">{{ lan.url }}</span>
                <button @click="copyLanUrl">复制链接</button>
              </div>
              <div class="qr">
                <img :src="qrUrl" alt="点歌页二维码" @error="qrFailed = true" v-if="!qrFailed && qrUrl" />
                <div class="hint" v-else>二维码不可用，请手动输入上面的网址</div>
              </div>
              <p class="hint">
                手机连<b>同一个 Wi-Fi</b>，扫码或输入上面的网址即可点歌。
                <span v-if="lan.addresses && lan.addresses.length > 1">
                  （本机有多个网卡，其他可用地址：{{ lan.addresses.slice(1).join('、') }}）
                </span>
              </p>
            </template>
            <p class="hint warn-hint" v-if="s.lanEnabled">
              ⚠️ <b>首次开启时 Windows 会弹防火墙询问</b>，请选「允许」（至少勾上"专用网络"）。
              如果点了取消，手机就连不上——可到「Windows 防火墙 → 允许应用通过防火墙」里补上。
            </p>
            <p class="hint" v-else-if="lan.error">启动失败：{{ lan.error }}</p>
            <p class="hint" v-else>
              开启后手机连同一个 Wi-Fi 就能扫码点歌，走的是和主机界面<b>完全相同</b>的排队/缓存/播放链路。
              局域网内无鉴权，不需要时请关掉。
            </p>
          </section>

          <!-- 曲库 -->
          <section v-show="activeSection === 'catalog'">
            <h3>曲库</h3>
            <div class="row">
              <label>版本</label>
              <span class="val wide">本地 {{ update.localVersion || '未安装' }}　远端 {{ update.remoteVersion || '—' }}</span>
              <button @click="checkUpdate" :disabled="checking">{{ checking ? '检查中…' : '检查更新' }}</button>
            </div>
            <div class="row">
              <label>曲库来源</label>
              <input class="path" v-model="catalogSource" placeholder="http(s) 清单地址，或本地目录" @change="saveCatalogSource" />
              <button @click="pickCatalogDir">选目录</button>
            </div>
            <div class="row" v-if="/^https?:/i.test(catalogSource)">
              <label>访问令牌</label>
              <input class="path" v-model="catalogToken" placeholder="Gitee 等平台的大文件下载需要登录令牌（可选）" @change="saveCatalogSource" />
            </div>
            <p class="hint">
              <b>Gitee 对大文件 raw 下载要求登录</b>（会返回 403 <code>large file require login</code>），
              所以要么填访问令牌，要么直接指向本地的 <code>database_publish/database</code> 目录。
            </p>

            <p class="hint">
              曲库是从 KTV 服务端下载的曲目快照（当前 670k 首）。更新会下载约 440MB 分片，
              校验后原子替换，中途失败不会损坏现有曲库。<b>更新完成后需重启应用</b>。
            </p>
            <div class="row" v-if="update.hasUpdate">
              <label></label>
              <button class="primary" @click="runUpdate" :disabled="updating">
                {{ updating ? progressText : '下载并安装更新' }}
              </button>
            </div>
            <div class="row" v-if="progressText && updating">
              <label></label>
              <progress class="bar" :value="progressPercent" max="100"></progress>
              <span class="val">{{ progressPercent }}%</span>
            </div>
          </section>

          <!-- 音频分离 -->
          <section v-show="activeSection === 'separation'">
            <h3>音频分离</h3>
            <div class="row">
              <label>分离方式</label>
              <div class="seg">
                <button :class="{ on: s.separationMode === 'off' }" @click="set('separationMode', 'off')">关闭</button>
                <button :class="{ on: s.separationMode === 'instant' }" @click="set('separationMode', 'instant')">即时</button>
                <button :class="{ on: s.separationMode === 'plugin' }" @click="set('separationMode', 'plugin')">AI（插件）</button>
              </div>
            </div>
            <div class="row">
              <label>分离设备</label>
              <div class="seg">
                <button :class="{ on: s.separatorDevice === 'auto' }" @click="set('separatorDevice', 'auto')">自动</button>
                <button :class="{ on: s.separatorDevice === 'cpu' }" @click="set('separatorDevice', 'cpu')">CPU</button>
                <button :class="{ on: s.separatorDevice === 'cuda' }" @click="set('separatorDevice', 'cuda')">显卡</button>
              </div>
            </div>
            <div class="row">
              <label>分离模型</label>
              <div class="seg">
                <button :class="{ on: s.separatorModel !== 'htdemucs_ft' }" @click="set('separatorModel', 'htdemucs')">标准（快）</button>
                <button :class="{ on: s.separatorModel === 'htdemucs_ft' }" @click="set('separatorModel', 'htdemucs_ft')">精细（慢 4 倍）</button>
              </div>
            </div>

            <div class="sep-info">
              <div class="line">
                <span class="k">即时分离</span>
                <span class="v">中置声道消除，秒级完成，零依赖。<b>适合人声居中的录音</b>；对声场很宽的录音效果一般。</span>
              </div>
              <div class="line">
                <span class="k">AI 分离</span>
                <span class="v">
                  <b>Demucs</b> 神经网络分离，质量远好于中置消除，但慢（CPU 上约 0.5x 实时）、依赖重，
                  所以做成插件按需装。
                  当前状态：<b :class="sep.pluginPath ? 'ok' : 'warn'">{{ sep.pluginPath ? '已配置插件' : '未安装插件' }}</b>
                </span>
              </div>
              <div class="line" v-if="!sep.pluginPath">
                <span class="k">一键安装</span>
                <span class="v">点击下方按钮自动下载并安装 Demucs，完成后会自动写入插件路径，无需手动选择。首次安装约 200–300MB。</span>
              </div>
              <div class="line">
                <span class="k">ffmpeg</span>
                <span class="v" :class="sep.ffmpegAvailable ? 'ok' : 'warn'">
                  {{ sep.ffmpegAvailable ? '可用' : '不可用' }} — {{ sep.ffmpegDetail }}
                </span>
              </div>
            </div>

            <div class="row">
              <label>插件路径</label>
              <input class="path" :value="sep.pluginPath" readonly placeholder="点击右侧按钮自动下载安装" />
              <button class="primary" :disabled="installingSep" @click="installSepPlugin">{{ installingSep ? '正在下载安装…' : '一键下载并安装' }}</button>
              <button v-if="sep.pluginPath" @click="clearSepPlugin">清除</button>
            </div>

            <div class="row">
              <label></label>
              <button class="primary" :disabled="!sep.currentSong || busy" @click="runSeparation">
                {{ busy ? '分离中…' : '分离当前曲目' }}
              </button>
              <span class="val">{{ sep.currentSong ? sep.currentSong.name : '当前没有播放' }}</span>
            </div>
          </section>
        </div>
        </div>

        <footer>
          <span class="saved">{{ savedText }}</span>
          <button @click="close">关闭</button>
        </footer>
      </div>
    </div>
  </teleport>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  // 播放状态（App.vue 每 250ms 推一次）。只用来做下面那块「播放诊断」。
  status: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['close', 'changed', 'openAuth', 'openLan'])

const bridge = window.ktv || {}
/** 默认值：设置还没加载出来时用它，避免界面上出现 NaN */
/** 主题清单：只用来渲染上面那排色块，真正的配色在 styles.css 里 */
const THEMES = [
  { id: 'dark', label: '暗夜', desc: '默认：深蓝底 + 青绿主色', bg: '#0b1016', line: '#24303d', accent: '#27cca4' },
  { id: 'midnight', label: '午夜蓝', desc: '更深更冷，主色青蓝', bg: '#070b14', line: '#1e2a44', accent: '#58b6ff' },
  { id: 'warm', label: '暖棕', desc: '包厢暖色调（琥珀）', bg: '#14100c', line: '#362b1f', accent: '#f0a63c' },
  { id: 'light', label: '浅色', desc: '白天 / 亮房间', bg: '#eef2f7', line: '#d5dee9', accent: '#0f9d7c' },
  { id: 'neon', label: '舞台霓虹', desc: '紫红舞台灯，暗场更有氛围', bg: '#090b16', line: '#252c4c', accent: '#d45cff' },
  { id: 'jade', label: '翡翠', desc: '深绿翡翠，适合长时间观看', bg: '#07110f', line: '#213d36', accent: '#38d39f' },
]

const SETTINGS_SECTIONS = [
  { id: 'video', label: '播放与画面', icon: 'monitor', keywords: '内核 mpv libvlc 解码 硬解 软解 缓冲 流畅' },
  { id: 'playback', label: '播放行为', icon: 'play', keywords: '原唱 伴唱 默认 播放' },
  { id: 'theme', label: '界面主题', icon: 'palette', keywords: '主题 配色 密度 大屏 遥控器 舒适 霓虹 翡翠' },
  { id: 'diagnostics', label: '播放诊断', icon: 'activity', keywords: '诊断 卡顿 马赛克 丢帧 分辨率' },
  { id: 'source', label: '数据源', icon: 'database', keywords: '麦动 在线 源 数据源' },
  { id: 'data', label: '数据位置', icon: 'folder', keywords: '目录 路径 数据 磁盘' },
  { id: 'cache', label: '缓存', icon: 'hard-drive', keywords: '缓存 清理 文件 空间' },
  { id: 'lan', label: '手机点歌', icon: 'smartphone', keywords: '手机 局域网 二维码 端口' },
  { id: 'catalog', label: '曲库更新', icon: 'music', keywords: '曲库 更新 下载 安装' },
  { id: 'separation', label: '音频分离', icon: 'sparkles', keywords: '分离 ai demucs 显卡 cpu 插件' },
]

const DEFAULTS = {
  theme: 'dark',
  playbackCore: 'mpv',
  lanEnabled: true,
  lanPort: 8088,
  videoDecoder: 'software',
  networkCachingMs: 1500,
  onlineMvQuality: 'auto',
  defaultVocalMode: 'original',
  cacheMaxBytesPerSecond: 1024 * 1024,
  cacheMaxBytes: 20 * 1024 * 1024 * 1024,
  cacheDir: '',
  prefetchDepth: 3,
  pageSize: 30,
  separationMode: 'off',
  separatorDevice: 'auto',
  separatorModel: 'htdemucs',
  repairMode: 'off',
  cacheBeforePlay: true,
  lyricsOnVideo: true,
  lyricsPos: 'bottom',   // 画面歌词位置：bottom（默认）| center
  lyricsScroll: true,    // 画面歌词滚动特效
  lyricsOffsetMs: 0,     // 歌词相对视频的偏移（毫秒）
  smoothPlayback: false, // 流畅模式（去抖动），默认关（display-fps 读数不稳时会更卡）
  sourceMode: 'maidong', // maidong | online
  showLyrics: false,   // 默认只画在视频里，底部条不叠一份
  uiDensity: 'auto',   // auto | comfortable | tv
  rightPanelWidth: null, // null = 按窗口自动；数字 = 用户拖拽固定
}
const s = ref({ ...DEFAULTS })
const activeSection = ref('video')
const settingQuery = ref('')
const bodyEl = ref(null)
const visibleSettingSections = computed(() => {
  const q = settingQuery.value.trim().toLowerCase()
  if (!q) return SETTINGS_SECTIONS
  return SETTINGS_SECTIONS.filter((sec) => (sec.label + ' ' + sec.keywords).toLowerCase().includes(q))
})
watch(visibleSettingSections, (list) => {
  if (settingQuery.value.trim() && list.length && !list.some((sec) => sec.id === activeSection.value)) {
    activeSection.value = list[0].id
  }
})
watch(activeSection, () => bodyEl.value?.scrollTo?.({ top: 0, behavior: 'smooth' }))

/**
 * 播放诊断：把"现在到底在播什么"摊开给用户看。
 *
 * 用户报"卡/马赛克"时最常见的三种情况，这里能一眼分开：
 *   1. 播的其实是麦动片源（从已点/收藏里点的歌）—— 那份片源本身有损坏包
 *   2. 在线 MV 只有 480p —— 放大后就是糊的，不是解码问题
 *   3. 真的丢帧/解码报错
 */
const diag = computed(() => {
  const st = props.status || {}
  const p = String(st.filePath || '')
  // 在线 MV 的"文件名"其实是 CDN 上的一串 hash.mp4?wsSecret=...，对用户没意义，
  // 优先显示歌名，原始路径放在 title 里
  const raw = p.split('?')[0].split(/[\\/]/).pop() || ''
  const name = (st.song && st.song.name) || raw || '未播放'
  const playSource = st.song && st.song.playSource
  const source = !p ? '—'
    : st.isStream ? '在线流（边下边播）'
    : playSource === 'online' ? '在线（已缓存到本地）'
    : '本地文件 / 麦动曲库'
  const v = st.videoSize || {}
  const lost = (st.stats && st.stats.i_lost_pictures) || 0
  const dec = s.value.videoDecoder === 'software' ? '软解'
    : s.value.videoDecoder === 'hardware' ? '硬解' : '自动'
  return {
    path: p || '—',
    name,
    source,
    video: v.width ? `${v.width}×${v.height} · ${dec} · 丢帧 ${lost}` : '—',
  }
})
const cacheDir = ref('')
const migrating = ref(false)
const cacheStats = ref({ count: 0, bytes: 0 })
const cacheOpen = ref(false)
const cacheFiles = ref([])

async function refreshCacheList() {
  if (!bridge.cache?.listFiles) return
  try {
    cacheFiles.value = await bridge.cache.listFiles()
    cacheStats.value = await bridge.cache.stats()
  } catch { /* 忽略 */ }
}
async function toggleCacheList() {
  cacheOpen.value = !cacheOpen.value
  if (cacheOpen.value) await refreshCacheList()
}
async function removeCacheFile(f) {
  if (!bridge.cache?.removeFile) return
  const r = await bridge.cache.removeFile(f.filename)
  if (!r.ok) { alert(r.error || '删除失败'); return }
  await refreshCacheList()
}
function fmtSize(bytes) {
  const mb = (bytes || 0) / 1024 / 1024
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(0) + ' MB'
}
function fmtDate(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const sep = ref({ ffmpegAvailable: false, ffmpegDetail: '', pluginPath: '', currentSong: null })
const appPaths = ref({})
const lan = ref({ running: false, port: 8088, url: '', addresses: [], error: '' })
const qrFailed = ref(false)
// 二维码由局域网服务自己生成（/api/qr.svg），走本机回环拿，不依赖外网
const qrUrl = computed(() => (lan.value.running ? `http://127.0.0.1:${lan.value.port}/api/qr.svg` : ''))

async function refreshLan() {
  if (!bridge.lan?.info) return
  try { lan.value = await bridge.lan.info() } catch { /* 忽略 */ }
}
async function copyLanUrl() {
  try { await navigator.clipboard.writeText(lan.value.url || '') } catch { /* 忽略 */ }
}
const catalogSource = ref('')
const catalogToken = ref('')
const busy = ref(false)
const installingSep = ref(false)
const update = ref({ localVersion: null, remoteVersion: "", hasUpdate: false })
const checking = ref(false)
const updating = ref(false)
const progressText = ref("")
const progressPercent = ref(0)
const savedText = ref('')

const cacheInfo = computed(() => {
  const mb = cacheStats.value.bytes / 1024 / 1024
  return `${cacheStats.value.count} 个文件 / ${mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(0) + ' MB'}`
})

async function refresh() {
  if (!bridge.settings) return
  s.value = { ...DEFAULTS, ...(await bridge.settings.get()) }
  cacheDir.value = await bridge.cache.dir()
  if (bridge.app?.paths) appPaths.value = await bridge.app.paths()
  await refreshLan()
  catalogSource.value = s.value.catalogSource || ""
  catalogToken.value = s.value.catalogToken || ""
  sep.value = await bridge.separator.status()
  try {
    const st = await bridge.player.status()
    cacheStats.value = st.cache || { count: 0, bytes: 0 }
  } catch { /* 忽略 */ }
}

/** 改一项设置就立刻落盘（播放器重建等副作用由主进程处理）。 */
async function set(key, value) {
  s.value = { ...s.value, [key]: value }
  await bridge.settings.update({ [key]: value })
  s.value = await bridge.settings.get()
  if (key === 'lanEnabled' || key === 'lanPort') { qrFailed.value = false; await refreshLan() }
  savedText.value = '已保存'
  setTimeout(() => { savedText.value = '' }, 1500)
  emit('changed')
}

async function pickDir() {
  const dir = await bridge.cache.pickDir()
  if (!dir) return
  await set('cacheDir', dir)
  cacheDir.value = dir
}

async function openDir() { await bridge.cache.openDir() }

/** 「都关」要一次改两个开关 */
async function setBothLyricsOff() {
  await set('lyricsOnVideo', false)
  await set('showLyrics', false)
}

async function installSepPlugin() {
  if (!bridge.separator?.install) { window.alert('当前版本不支持一键安装'); return }
  installingSep.value = true
  savedText.value = '正在下载并安装 Demucs，请勿关闭应用…'
  try {
    const r = await bridge.separator.install()
    if (!r?.ok) { window.alert('安装失败：' + (r?.error || '未知错误')); return }
    sep.value = await bridge.separator.status()
    savedText.value = 'Demucs 安装完成'
    setTimeout(() => { savedText.value = '' }, 3000)
  } finally {
    installingSep.value = false
  }
}

async function pickSepPlugin() {
  if (!bridge.separator?.pickPlugin) return
  const f = await bridge.separator.pickPlugin()
  if (f) sep.value = await bridge.separator.status()
}
async function clearSepPlugin() {
  await bridge.settings.update({ separatorPluginPath: '' })
  sep.value = await bridge.separator.status()
}

/** 在资源管理器里打开数据目录 */
async function openDataDir() { await bridge.cache.openDir() }

async function migrateCatalog() {
  if (!bridge.catalog?.migrate) return
  migrating.value = true
  try {
    const r = await bridge.catalog.migrate()
    if (r?.canceled) return
    if (!r?.ok) { window.alert('曲库迁移失败：' + (r?.error || '未知错误')); return }
    appPaths.value = { ...appPaths.value, catalogDir: r.newDir }
    window.alert('曲库迁移完成。建议重启应用，让所有路径状态完全刷新。')
  } catch (e) { window.alert('曲库迁移失败：' + e.message) } finally { migrating.value = false }
}

async function clearCache() {
  if (!window.confirm('确定清空所有已缓存的歌曲文件？')) return
  const r = await bridge.cache.clear()
  if (r && r.ok) {
    savedText.value = `已清理 ${r.removed} 个文件`
    setTimeout(() => { savedText.value = '' }, 2500)
  }
  await refresh()
}

async function runSeparation() {
  busy.value = true
  try {
    const r = await bridge.separator.run()
    if (!r.ok) window.alert(r.error)
  } finally {
    busy.value = false
    await refresh()
  }
}

async function saveCatalogSource() {
  await set('catalogSource', catalogSource.value.trim())
  await set('catalogToken', catalogToken.value.trim())
}

async function pickCatalogDir() {
  const dir = await bridge.cache.pickDir()
  if (!dir) return
  catalogSource.value = dir
  await saveCatalogSource()
}

async function checkUpdate() {
  checking.value = true
  try {
    const r = await bridge.catalogUpdate.check()
    if (!r.ok) { window.alert(r.error); return }
    update.value = r
    if (!r.hasUpdate) window.alert("曲库已是最新版本 " + r.remoteVersion)
  } finally { checking.value = false }
}

async function runUpdate() {
  if (!window.confirm("下载并安装曲库更新？约 440MB，期间会占用带宽。")) return
  updating.value = true
  progressPercent.value = 0
  progressText.value = "准备中…"
  try {
    const r = await bridge.catalogUpdate.run()
    if (!r.ok) window.alert(r.error)
    else window.alert("更新完成，请重启应用生效")
  } finally { updating.value = false; progressText.value = "" }
}

function onCatalogProgress(p) {
  progressPercent.value = p.percent || 0
  progressText.value = (p.detail || p.phase || "") + " " + (p.percent || 0) + "%"
}

function close() { emit('close') }

let offCatalog = null
watch(() => props.open, (v) => {
  if (v) {
    refresh()
    offCatalog = bridge.catalogUpdate ? bridge.onCatalogProgress(onCatalogProgress) : null
  } else {
    offCatalog?.()
    offCatalog = null
  }
})
</script>

<style scoped>
.mask { position: fixed; inset: 0; background: rgba(0,0,0,.66); backdrop-filter: blur(3px); z-index: 300; display: flex; align-items: center; justify-content: center; }
.dlg {
  width: min(920px, 94vw); height: min(760px, 88vh); max-height: 88vh; display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0,0,0,.6);
}
header { display: flex; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--line); }
header .title { font-size: 16px; font-weight: 600; flex: 1; }
header .x { padding: 4px 10px; }
.settings-shell { flex: 1; min-height: 0; display: grid; grid-template-columns: 190px minmax(0, 1fr); }
.settings-nav {
  min-height: 0; overflow-y: auto; padding: 12px 8px;
  border-right: 1px solid var(--line); background: var(--panel-2);
}
.settings-search {
  display: flex; align-items: center; gap: 7px; margin: 0 4px 10px; padding: 7px 9px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--dim);
}
.settings-search:focus-within { border-color: var(--focus); box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 20%, transparent); }
.settings-search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--text); font: inherit; font-size: 12px; }
.settings-nav > button {
  width: 100%; display: flex; align-items: center; gap: 8px; margin-bottom: 2px;
  padding: 8px 9px; border: 0; border-radius: 8px; background: transparent;
  color: var(--dim); text-align: left; font-size: 13px;
}
.settings-nav > button:hover { background: var(--row-hover); color: var(--text); }
.settings-nav > button.active { background: var(--focus-fill); color: var(--on-focus); font-weight: 600; }
.settings-nav .nav-empty { padding: 18px 10px; color: var(--dim-2); font-size: 12px; text-align: center; }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 18px 14px; }
section { padding: 14px 0; border-bottom: 1px solid var(--line); }
section:last-child { border-bottom: none; }
h3 { margin: 0 0 10px; font-size: 13px; color: var(--gold); font-weight: 600; }

.row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.row label { width: 90px; flex: none; font-size: 13px; color: var(--dim); }

/* 主题选择器：每个按钮左边一个小色块（底色 + 主色圆点），一眼看出是什么配色 */
.seg.themes button { display: flex; align-items: center; gap: 6px; }
.seg .sw {
  width: 16px; height: 16px; border-radius: 5px; border: 1px solid;
  display: inline-flex; align-items: center; justify-content: center; flex: none;
}
.seg .sw b { width: 7px; height: 7px; border-radius: 50%; }
.row input[type=range] { flex: 1; min-width: 0; accent-color: var(--focus); }
.row .val { font-size: 12px; color: var(--dim); min-width: 76px; text-align: right; }
.row .val.wide { flex: 1; text-align: left; }
.row .path {
  flex: 1; min-width: 0; background: var(--panel-2); color: var(--text);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; font-size: 12px;
}
.row button { padding: 6px 12px; font-size: 12px; }
.row button.danger { color: var(--accent-text); }
.row button.primary { background: var(--focus-fill); border-color: var(--focus-border); }

.seg { display: flex; gap: 4px; }
.seg button { padding: 6px 14px; font-size: 13px; }
.seg button.on { background: var(--focus-fill); border-color: var(--focus); color: var(--on-focus); font-weight: 600; }

.hint { margin: 0 0 12px 100px; font-size: 12px; color: var(--dim-2); line-height: 1.6; }
.hint b { color: var(--text-2); }

.sep-info { margin: 0 0 12px 100px; display: flex; flex-direction: column; gap: 6px; }
.sep-info .line { display: flex; gap: 8px; font-size: 12px; }
.sep-info .k { flex: none; width: 62px; color: var(--dim); }
.sep-info .v { color: var(--dim-2); line-height: 1.6; }
.sep-info .v.ok { color: var(--focus); }
.sep-info .v.warn { color: var(--gold); }

.bar { flex: 1; height: 8px; accent-color: var(--focus); }
.path-text { font-size: 12px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hint code { background: var(--row-hover); padding: 1px 5px; border-radius: 4px; color: var(--text-2); }
footer { display: flex; align-items: center; padding: 12px 18px; border-top: 1px solid var(--line); }
footer .saved { flex: 1; font-size: 12px; color: var(--focus); }
footer button { padding: 7px 18px; }

/* 手机点歌：二维码与地址 */
.qr { display: flex; justify-content: center; padding: 8px 0 4px; }
.qr img { width: 168px; height: 168px; background: #fff; border-radius: 10px; padding: 8px; }
.val.mono { font-family: Consolas, ui-monospace, monospace; font-size: 13px; }
.hint.warn-hint { color: var(--gold); }

/* 缓存文件列表 */
.cache-list { margin: 0 0 12px 100px; max-height: 220px; overflow-y: auto;
  border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
.cache-row { display: flex; align-items: center; gap: 10px; padding: 6px 10px; font-size: 12px;
  border-bottom: 1px solid var(--line); }
.cache-row:last-child { border-bottom: 0; }
.cache-row .cname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cache-row .csize { flex: none; width: 74px; text-align: right; color: var(--dim); }
.cache-row .ctime { flex: none; width: 74px; color: var(--dim-2); }
.cache-row .cplay { flex: none; color: var(--focus); }
.cache-row button { padding: 3px 10px; font-size: 12px; }
input.num { width: 90px; }
</style>
