/**
 * IPC 通道完整性测试
 * ==================
 * 之前一次脚本化改动把 `providers:status` 这个 handler 误删了，
 * 而界面调用失败会被 try/catch 静默吞掉，表现成"未配置取流服务"，
 * 排查了很久。这里把"preload 暴露的通道"和"主进程注册的通道"对一遍，
 * 缺一个就报错。
 *
 * 用法: node test/ipc-channels-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');

/** 主进程注册的通道 */
const registered = new Set(
  [...mainSrc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1])
);

/** preload 里 invoke 的通道 */
const invoked = new Set(
  [...preloadSrc.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1])
);

/** 主进程主动推给渲染进程的通道 */
const pushed = new Set(
  [...mainSrc.matchAll(/webContents\.send\('([^']+)'/g)].map((m) => m[1])
);
const listened = new Set(
  [...preloadSrc.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1])
);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
}

const missingHandlers = [...invoked].filter((c) => !registered.has(c));
check('preload 调用的通道都有主进程 handler', missingHandlers.length === 0,
  missingHandlers.length ? '缺少: ' + missingHandlers.join(', ') : `共 ${invoked.size} 个`);

const missingListeners = [...pushed].filter((c) => !listened.has(c));
check('主进程推送的通道都有 preload 监听', missingListeners.length === 0,
  missingListeners.length ? '缺少: ' + missingListeners.join(', ') : `共 ${pushed.size} 个`);

// 关键通道白名单（这些漏了会静默降级成"未配置/未就绪"）
const critical = [
  'providers:status', 'catalog:status', 'catalog:checkUpdate', 'catalog:update',
  'settings:get', 'settings:update', 'separator:status', 'separator:run',
  'cache:dir', 'cache:pickDir', 'app:paths',
  'online:sources', 'online:hot', 'auth:status', 'auth:openLogin', 'auth:importCookie', 'auth:logout',
];
const missingCritical = critical.filter((c) => !registered.has(c));
check('关键通道都在', missingCritical.length === 0,
  missingCritical.length ? '缺少: ' + missingCritical.join(', ') : critical.length + ' 个');

const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length) {
  console.log(`IPC 通道测试失败 ${failed.length}/${results.length} 项`);
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
  process.exit(1);
}
console.log(`IPC 通道测试全部通过（${results.length} 项）`);
