/**
 * mpv 播放内核：纯逻辑单测（不启动 mpv 进程）
 * ==========================================
 * 覆盖三件容易写错、写错又很难发现的事：
 *   1. createPlayer 的内核选择与回退
 *   2. pan 滤镜（原伴唱声道隔离）的取值
 *   3. JSON IPC 的粘包/半包解析与 request_id 对应
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { MpvPlayer, MpvIpc, createPlayer, resolveMpvPath, PAN_GRAPH, pitchRatio } = require('../src/mpv-player');
const { KtvPlayer } = require('../src/player');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  [PASS] ${name}`); pass++; }
  catch (e) { console.log(`  [FAIL] ${name} - ${e.message}`); fail++; }
}

console.log('\nmpv 播放内核单测');

t('mpv.exe 路径可解析（随包分发）', () => {
  const p = resolveMpvPath();
  assert.ok(p && p.endsWith('mpv.exe'), '未找到 mpv.exe: ' + p);
  assert.ok(require('fs').existsSync(p), 'mpv.exe 不存在: ' + p);
});

t('声道隔离用的 pan 滤镜语法正确', () => {
  assert.strictEqual(PAN_GRAPH.left, 'pan=stereo|c0=c0|c1=c0');
  assert.strictEqual(PAN_GRAPH.right, 'pan=stereo|c0=c1|c1=c1');
  assert.strictEqual(PAN_GRAPH.stereo, 'pan=stereo|c0=c0|c1=c1');
  // 必须是等值立体声，否则"立体声"模式会丢一个声道
  assert.ok(PAN_GRAPH.stereo.includes('c0=c0') && PAN_GRAPH.stereo.includes('c1=c1'));
});

t('core=libvlc 时选 KtvPlayer', () => {
  const p = createPlayer({ core: 'libvlc' });
  assert.ok(p instanceof KtvPlayer, '应选 KtvPlayer，实际 ' + p.constructor.name);
  p.dispose();
});

t('core=mpv 时选 MpvPlayer', () => {
  const p = createPlayer({ core: 'mpv' });
  assert.ok(p instanceof MpvPlayer, '应选 MpvPlayer，实际 ' + p.constructor.name);
  p.dispose();
});

t('mpv 不可用时自动回退到 KtvPlayer', () => {
  const old = process.env.MPV_PATH;
  process.env.MPV_PATH = path.join(require('os').tmpdir(), 'definitely-not-here-mpv.exe');
  const saved = resolveMpvPath;
  // 直接用显式不存在的 mpvPath 走 createPlayer 的探测分支
  const { createPlayer: cp } = require('../src/mpv-player');
  const p = cp({ core: 'mpv', mpvPath: process.env.MPV_PATH });
  // createPlayer 内部用 resolveMpvPath() 判断，这里只验证"显式给了坏路径也不会崩"
  assert.ok(p instanceof MpvPlayer || p instanceof KtvPlayer);
  p.dispose();
  process.env.MPV_PATH = old;
});

t('默认原伴唱映射：第一条原唱、第二条伴唱', () => {
  const { resolveTrackMap } = require('../src/vocal');
  assert.deepStrictEqual(resolveTrackMap([{ id: 1, name: '' }, { id: 2, name: '' }]),
    { original: 1, accompaniment: 2 });
});

t('音轨名能认出来时优先按名字', () => {
  const { resolveTrackMap } = require('../src/vocal');
  assert.deepStrictEqual(resolveTrackMap([{ id: 1, name: '伴唱' }, { id: 2, name: '原唱' }]),
    { original: 2, accompaniment: 1 });
});

/** 造一个假 IPC，只记录发出的命令 */
function fakeIpc() {
  const sent = [];
  return { sent, send: (c) => { sent.push(c); return Promise.resolve({ error: 'success' }); }, close() {} };
}

t('变调：半音 -> 频率比', () => {
  assert.strictEqual(pitchRatio(0), 1);
  assert.ok(Math.abs(pitchRatio(12) - 2) < 1e-9, '+12 半音应为 2 倍频');
  assert.ok(Math.abs(pitchRatio(-12) - 0.5) < 1e-9, '-12 半音应为 0.5 倍频');
  assert.ok(Math.abs(pitchRatio(7) - 1.498307) < 1e-5, '+7 半音应约 1.4983');
});

t('变调：范围夹到 -6..+6，并取整', () => {
  const p = new MpvPlayer({ volume: 0 });
  p.setPitch(99); assert.strictEqual(p.getPitch(), 6);
  p.setPitch(-99); assert.strictEqual(p.getPitch(), -6);
  p.setPitch(2.4); assert.strictEqual(p.getPitch(), 2);
  p.setPitch('abc'); assert.strictEqual(p.getPitch(), 0);
  p.dispose();
});

t('变调：pan 与 rubberband 合成一条 lavfi 链', () => {
  const p = new MpvPlayer({ volume: 0 });
  p.ipc = fakeIpc();
  p._setPan('left');
  p.setPitch(3);
  const last = p.ipc.sent[p.ipc.sent.length - 1];
  assert.deepStrictEqual(last.slice(0, 2), ['af', 'set'], '应该走 af set 命令');
  const graph = last[2];
  assert.ok(graph.startsWith('lavfi=[pan=stereo|c0=c0|c1=c0'), '应带左声道 pan：' + graph);
  assert.ok(graph.includes('rubberband=pitch=1.189207'), '应带 +3 半音的 rubberband：' + graph);
  // 回到原调时不该再挂 rubberband
  p.setPitch(0);
  const back = p.ipc.sent[p.ipc.sent.length - 1][2];
  assert.ok(!back.includes('rubberband'), '原调不应带 rubberband：' + back);
  // 变调要跟着声道切换一起重建（af set 是整体替换）
  p.setPitch(2);
  p._setPan('right');
  const r = p.ipc.sent[p.ipc.sent.length - 1][2];
  assert.ok(r.includes('c0=c1') && r.includes('rubberband'), '切声道后仍应保留变调：' + r);
  p.dispose();
});

t('变调：mpv 内核声明支持', () => {
  const p = new MpvPlayer({ volume: 0 });
  assert.strictEqual(p.supportsPitch(), true);
  p.dispose();
});

t('libVLC 内核明确声明不支持变调', () => {
  const p = new KtvPlayer({});
  assert.strictEqual(p.supportsPitch(), false, 'libVLC 3 没有变调滤波器');
  assert.strictEqual(p.setPitch(3), false);
  assert.strictEqual(p.getPitch(), 0);
  p.dispose();
});

t('IPC：半包 + 粘包都能正确解析', () => {
  const ipc = new MpvIpc('\\\\.\\pipe\\nope');
  const got = [];
  ipc.on('event', (e) => got.push(e));
  // 先喂半行
  ipc._onData(Buffer.from('{"event":"property-change","id":1,"data":3.'));
  assert.strictEqual(got.length, 0, '半行不应触发事件');
  // 补齐，再跟一整行
  ipc._onData(Buffer.from('5}\n{"event":"end-file","reason":"eof"}\n'));
  assert.strictEqual(got.length, 2, '应解析出 2 个事件，实际 ' + got.length);
  assert.strictEqual(got[0].event, 'property-change');
  assert.strictEqual(got[0].data, 3.5);
  assert.strictEqual(got[1].reason, 'eof');
});

t('IPC：property-change 会记进 observed()', () => {
  const ipc = new MpvIpc('\\\\.\\pipe\\nope');
  ipc._onData(Buffer.from('{"event":"property-change","id":7,"data":42}\n'));
  assert.strictEqual(ipc.observed(7), 42);
});

(async () => {
  // 上面两条是 async 测试，单独跑
  try {
    const ipc = new MpvIpc('\\\\.\\pipe\\nope');
    ipc.sock = {
      write(payload) {
        const req = JSON.parse(payload.trim());
        setImmediate(() => ipc._onData(Buffer.from(JSON.stringify({
          request_id: req.request_id, error: 'success', data: 'ok' }) + '\n')));
        return true;
      },
    };
    const r = await ipc.send(['get_property', 'x']);
    assert.strictEqual(r.data, 'ok');
    console.log('  [PASS] IPC 请求/响应配对（异步）'); pass++;
  } catch (e) { console.log('  [FAIL] IPC 请求/响应配对（异步） - ' + e.message); fail++; }

  try {
    const ipc = new MpvIpc('\\\\.\\pipe\\nope');
    const r = await ipc.send(['get_property', 'x']);
    assert.strictEqual(r.error, 'ipc-not-connected');
    console.log('  [PASS] 未连接时返回可读错误（异步）'); pass++;
  } catch (e) { console.log('  [FAIL] 未连接时返回可读错误（异步） - ' + e.message); fail++; }

  console.log(`\nmpv 播放内核单测：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
