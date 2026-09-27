/**
 * 在线点歌不能阻塞 IPC 的回归测试
 * ================================
 * 线上问题：点“立即唱”后右侧列表一直转圈。
 * 根因是 orderOnlineItem -> playNextInQueue -> resolveOnlineAndPlay
 * 在 IPC 返回前同步等待 QQ MV 网页抓流和整段缓存下载。
 *
 * 这个测试不依赖网络，只锁定调用链的时序约束：
 *   - 在线点歌先入队并启动后台预缓存；
 *   - orderOnlineItem 不得 await 播放/切歌；
 *   - resolveOnlineAndPlay 不得 await 整段缓存下载。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main.js'), 'utf8');

function functionBody(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '找不到函数 ' + name);
  const signatureEnd = source.indexOf(') {', start);
  assert.ok(signatureEnd >= 0, '找不到函数体 ' + name);
  const brace = signatureEnd + 2;
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  throw new Error('函数体没有闭合: ' + name);
}

const order = functionBody('orderOnlineItem');
assert.ok(order.includes('prefetchOnlineQueue()'), '在线点歌必须触发后台预缓存');
assert.ok(!/await\s+onSongFinished\s*\(/.test(order), 'orderOnlineItem 不能在 IPC 返回前 await 切歌');
assert.ok(!/await\s+playNextInQueue\s*\(/.test(order), 'orderOnlineItem 不能在 IPC 返回前 await 起播');

const play = functionBody('resolveOnlineAndPlay');
assert.ok(!/await\s+downloadOnlineMedia\s*\(/.test(play), '播放链路不能等待整段缓存下载');
assert.ok(play.includes('cacheOnlineMedia('), '播放链路应把缓存交给后台任务');
assert.ok(play.includes('afterSourceReady('), '缓存命中本地文件后应执行片源就绪收尾');

const prefetch = functionBody('prefetchOnlineQueue');
assert.ok(prefetch.includes('prefetchOnlineItem('), '队列预缓存应逐首启动后台任务');
assert.ok(prefetch.includes("status === 'waiting'"), '队列预缓存只处理等待中的歌曲');

const jobs = functionBody('runOnlineJob');
assert.ok(jobs.includes('map.get(key)'), '同一首歌的后台任务必须去重');
assert.ok(jobs.includes('map.delete(key)'), '后台任务完成后必须释放去重项');

assert.ok(order.includes('scheduleOnlinePlayback('), '立即唱必须走后台切歌调度');
assert.ok(order.includes("r.existing?.status === 'waiting'"), '已点里的在线歌再次立即唱必须移到下一首');
assert.ok(source.includes('onlineProgress: onlineTaskSnapshot()'), 'queue:list 必须返回在线解析/下载进度');

const webRoot = path.resolve(__dirname, '..', '..', 'web', 'src', 'components');
const browser = fs.readFileSync(path.join(webRoot, 'CatalogBrowser.vue'), 'utf8');
assert.ok(browser.includes('@dblclick="playNow(s)"'), '曲库歌曲双击必须立即唱');
assert.ok(browser.includes('@dblclick="playOnlineNow(s)"'), '在线歌曲双击必须立即唱');

const queuePanel = fs.readFileSync(path.join(webRoot, 'QueuePanel.vue'), 'utf8');
assert.ok(queuePanel.includes('onlineTaskLabel(q)'), '已点列表必须显示在线任务状态');
assert.ok(queuePanel.includes('onlineProgress.value = r.onlineProgress'), '已点列表必须接收在线任务进度');
assert.ok(queuePanel.includes('source-badge'), '已点/已唱等列表必须显示歌曲来源');
assert.ok(!source.includes('for (let i = 0; i < 60 && !captured'), 'QQ 网页抓流不能保留 15 秒无界等待');
assert.ok(source.includes('webRequest.onBeforeRequest'), 'QQ 抓流应使用有界 webRequest 监听');
assert.ok(source.includes('isHlsUrl(resolved.url)'), 'HLS 清单不能当完整缓存落盘');

const ass = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ass-lyrics.js'), 'utf8');
assert.ok(ass.includes('\\kf'), '逐字歌词必须使用 \\kf 缓慢填充');
const settings = fs.readFileSync(path.join(webRoot, 'SettingsDialog.vue'), 'utf8');
assert.ok(settings.includes('height: min(760px, 88vh)'), '设置窗口高度必须固定，切缓存页不能变大');
assert.ok(settings.includes('一键下载并安装'), 'Demucs 插件必须支持应用内一键安装');
assert.ok(settings.includes('onlineMvQuality'), '设置页必须提供 MV 清晰度选择');
assert.ok(queuePanel.includes('orderRow(h)'), '已唱点歌必须支持在线歌曲重新入队');

const win32 = fs.readFileSync(path.resolve(__dirname, '..', '..', 'player', 'src', 'win32.js'), 'utf8');
assert.ok(win32.includes('IsWindowVisible'), '视频双击检测必须能判断原生窗口是否可见');
assert.ok(source.includes("ipcMain.handle('separator:install'"), '主进程必须提供插件一键安装 IPC');
assert.ok(ass.includes('rightX'), '歌词必须使用左右双行布局');

console.log('  [PASS] 在线点歌异步链路约束');
console.log('  [PASS] 双击立即唱与在线进度可视化约束');
console.log('\n在线点歌异步回归测试全部通过（8 组约束）');
