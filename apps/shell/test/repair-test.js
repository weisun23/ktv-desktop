'use strict';
/**
 * 片源修复判定测试
 *
 * 为什么值得测：maidong 的 .ts 首字节不是 TS 同步字节 0x47（实测是 0x0d），
 * 这种文件会让解复用器每秒撞上一两次时间戳不连续、疯狂丢帧。
 * "是否需要修复"完全依赖这个首字节判定，判错就会漏修或误修。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isCleanTs, needsRepair, normMode } = require('../src/repair');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-repair-'));
let pass = 0;
function check(name, fn) { fn(); pass++; console.log(`  [PASS] ${name}`); }

const cleanTs = path.join(dir, 'clean.ts');
fs.writeFileSync(cleanTs, Buffer.concat([Buffer.from([0x47]), Buffer.alloc(1000, 0x11)]));
const dirtyTs = path.join(dir, 'dirty.ts');
fs.writeFileSync(dirtyTs, Buffer.concat([Buffer.from([0x0d]), Buffer.alloc(1000, 0x22)]));
const mp4 = path.join(dir, 'video.mp4');
fs.writeFileSync(mp4, Buffer.alloc(1000, 0x33));
const emptyTs = path.join(dir, 'empty.ts');
fs.writeFileSync(emptyTs, Buffer.alloc(0));
const tinyTs = path.join(dir, 'tiny.ts');
fs.writeFileSync(tinyTs, Buffer.from([0x0d, 0x01, 0x02]));

check('首字节 0x47 判为干净 TS', () => assert.strictEqual(isCleanTs(cleanTs), true));
check('首字节 0x0d 判为不干净', () => assert.strictEqual(isCleanTs(dirtyTs), false));
check('损坏的 .ts 需要修复（remux 模式下）', () => assert.strictEqual(needsRepair(dirtyTs, 'remux'), true));
check('干净的 .ts 不需要修复', () => assert.strictEqual(needsRepair(cleanTs, 'remux'), false));
check('非 .ts 一律不修（避免误伤 mp4/mkv）', () => assert.strictEqual(needsRepair(mp4, 'remux'), false));
check('空文件不修（半成品交给下载器重下，别喂 ffmpeg）', () => assert.strictEqual(needsRepair(emptyTs, 'remux'), false));
check('小于一个 TS 包的文件不修', () => assert.strictEqual(needsRepair(tinyTs, 'remux'), false));
check('不存在的文件不修', () => assert.strictEqual(needsRepair(path.join(dir, 'nope.ts'), 'remux'), false));
// ── transcode 模式：光看容器分不出『转码过的』和『干净但含坏宏块的』，靠标记 ──
check('干净 TS 在 remux 模式下不用修', () => assert.strictEqual(needsRepair(cleanTs, 'remux'), false));
check('干净 TS 在 transcode 模式下仍要转（可能含坏宏块）', () => assert.strictEqual(needsRepair(cleanTs, 'transcode'), true));
const { MARK_DIR } = require('../src/repair');
const markDir = path.join(dir, MARK_DIR);
fs.mkdirSync(markDir, { recursive: true });
fs.writeFileSync(path.join(markDir, 'clean.ts.transcode'), 'done');
check('转过标记后不再重复转码', () => assert.strictEqual(needsRepair(cleanTs, 'transcode'), false));
check('transcode 标记不影响 remux 判定', () => assert.strictEqual(needsRepair(cleanTs, 'remux'), false));

// ── 崩溃恢复：替换到一半被杀时，.orig 是唯一副本，必须还原而不是删 ──
{
  const { cleanupRepairTemp } = require('../src/repair');
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-repair-crash-'));
  // 场景 A：主文件没了、只剩 .orig（替换中途被杀）
  fs.writeFileSync(path.join(d2, 'a.ts.orig'), Buffer.concat([Buffer.from([0x47]), Buffer.alloc(400)]));
  cleanupRepairTemp(d2);
  check('崩溃后 .orig 被还原成主文件', () => assert.ok(fs.existsSync(path.join(d2, 'a.ts'))));
  check('还原后不再留 .orig', () => assert.ok(!fs.existsSync(path.join(d2, 'a.ts.orig'))));
  // 场景 B：主文件在、.orig 也在（替换已完成，备份多余）
  fs.writeFileSync(path.join(d2, 'b.ts'), Buffer.concat([Buffer.from([0x47]), Buffer.alloc(400)]));
  fs.writeFileSync(path.join(d2, 'b.ts.orig'), Buffer.alloc(400));
  cleanupRepairTemp(d2);
  check('主文件在时清掉多余备份', () => assert.ok(fs.existsSync(path.join(d2, 'b.ts')) && !fs.existsSync(path.join(d2, 'b.ts.orig'))));
  // 场景 C：未完成的修复产物直接删
  fs.writeFileSync(path.join(d2, 'c.ts.repair.ts'), Buffer.alloc(400));
  cleanupRepairTemp(d2);
  check('未完成的 .repair.ts 被清掉', () => assert.ok(!fs.existsSync(path.join(d2, 'c.ts.repair.ts'))));
  fs.rmSync(d2, { recursive: true, force: true });
}

// ── 回归：'off' 曾经被兜底成 'remux' ──
// normMode 原来的写法是 MODES.includes(m) ? m : 'remux'，
// 而 'off' 不在 MODES 里 —— 于是设置页上写着"不修"，实际每次启动都在重封装。
check("normMode 保留 'off'（不再兜底成 remux）", () => {
  assert.strictEqual(normMode('off'), 'off');
  assert.strictEqual(normMode('remux'), 'remux');
  assert.strictEqual(normMode('transcode'), 'transcode');
});
check('非法/缺省模式一律当 off（宁可不动片源）', () => {
  assert.strictEqual(normMode(undefined), 'off');
  assert.strictEqual(normMode('xyz'), 'off');
  assert.strictEqual(normMode(''), 'off');
});
check("mode='off' 时损坏的 .ts 也不修", () => {
  assert.strictEqual(needsRepair(dirtyTs, 'off'), false);
  assert.strictEqual(needsRepair(dirtyTs, undefined), false);
  assert.strictEqual(needsRepair(dirtyTs, 'xyz'), false);
});
check("mode='remux' 时损坏的 .ts 仍然要修", () => {
  assert.strictEqual(needsRepair(dirtyTs, 'remux'), true);
});

check('空路径不修', () => assert.strictEqual(needsRepair('', 'remux'), false));
check('null 不抛错', () => assert.strictEqual(needsRepair(null, 'remux'), false));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n片源修复判定测试全部通过（${pass} 项）`);