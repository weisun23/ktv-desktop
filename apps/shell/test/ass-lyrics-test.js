/**
 * 逐字歌词：yrc 解析 + ASS 卡拉OK字幕生成
 * =====================================
 * 这两块都是"错了会静默出问题"的类型：
 *   - yrc 解析错 -> 时间轴整体错位，但歌词还是显示得出来
 *   - ASS 拼错   -> 播放器直接不显示字幕，没有任何报错
 * 所以用真实抓下来的 yrc 片段做断言。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseYrc } = require('../src/lyrics');
const { buildAss, writeAssFile, assTime, assColor } = require('../src/ass-lyrics');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  [PASS] ${name}`); pass++; }
  catch (e) { console.log(`  [FAIL] ${name} - ${e.message}`); fail++; }
}

console.log('\n逐字歌词测试');

// 真实抓下来的片段（含元数据 JSON 行 + 正文行）
const REAL = [
  '{"t":0,"c":[{"tx":"作词: "},{"tx":"李宗盛"}]}',
  '{"t":1000,"c":[{"tx":"作曲: "},{"tx":"李宗盛"}]}',
  '[20100,2030](20100,440,0)阴(20540,690,0)天 (21230,260,0)在(21490,200,0)不(21690,240,0)开(21930,240,0)灯',
  '[221970,6800](221970,300,0)傻(222270,250,0)傻(222520,260,0)两(222780,170,0)个(222950,3470,0)人 (226420,590,0)笑',
].join('\n');

t('解析出逐字行，跳过 JSON 元数据行', () => {
  const out = parseYrc(REAL);
  assert.strictEqual(out.length, 2, '应该只有 2 行歌词');
  assert.strictEqual(out[0].time, 20100);
  assert.strictEqual(out[1].time, 221970);
});

t('每个字带自己的起止时间', () => {
  const [line] = parseYrc(REAL);
  assert.strictEqual(line.words.length, 6, '阴/天/在/不/开/灯');
  assert.deepStrictEqual(line.words[0], { t: 20100, d: 440, text: '阴' });
  assert.strictEqual(line.words[1].text, '天 ', '尾部空格要保留（它也是时间轴的一部分）');
  assert.strictEqual(line.duration, 2030);
});

t('一个字可以唱很久（长音）', () => {
  const line = parseYrc(REAL)[1];
  const ren = line.words.find((w) => w.text === '人 ');
  assert.strictEqual(ren.d, 3470, '长音时长应原样保留');
});

t('空输入 / 只有元数据都返回空数组', () => {
  assert.deepStrictEqual(parseYrc(''), []);
  assert.deepStrictEqual(parseYrc(null), []);
  assert.deepStrictEqual(parseYrc('{"t":0,"c":[]}'), []);
  assert.deepStrictEqual(parseYrc('随便一段不是 yrc 的文字'), []);
});

t('ASS 时间格式 H:MM:SS.cc', () => {
  assert.strictEqual(assTime(0), '0:00:00.00');
  assert.strictEqual(assTime(83450), '0:01:23.45');
  assert.strictEqual(assTime(3661230), '1:01:01.23');
  assert.strictEqual(assTime(-5), '0:00:00.00');
});

t('ASS 颜色是 BGR 顺序（写成 RGB 会红蓝颠倒）', () => {
  assert.strictEqual(assColor([0, 255, 0]), '&H0000FF00', '纯绿');
  assert.strictEqual(assColor([255, 0, 0]), '&H000000FF', '纯红');
  assert.strictEqual(assColor([255, 255, 255]), '&H00FFFFFF', '纯白');
  assert.strictEqual(assColor([0, 0, 0], 128), '&H80000000', '带 alpha');
});

t('生成的 ASS 有正确的段头', () => {
  const ass = buildAss(parseYrc(REAL));
  assert.ok(ass.includes('[Script Info]'));
  assert.ok(ass.includes('[V4+ Styles]'));
  assert.ok(ass.includes('[Events]'));
  assert.ok(ass.includes('Style: KTV,'), '应有 KTV 样式');
  assert.ok(/^Dialogue: 0,0:00:20\.10,/m.test(ass), '第一条事件应从 20.10s 开始');
});

t('每个字编译成 \\k 卡拉OK标签（厘秒）', () => {
  const ass = buildAss(parseYrc(REAL));
  // 阴 440ms -> \k44；天 690ms -> \k69
  assert.ok(ass.includes('{\\kf44}阴'), '阴应编译成 \\k44');
  assert.ok(ass.includes('{\\kf69}天 '), '天应编译成 \\k69 且保留空格');
  assert.ok(ass.includes('{\\kf347}人 '), '3470ms 长音应编译成 \\k347');
});

t('歌词里的 { } \\ 会被清掉，避免破坏 ASS 标签', () => {
  const evil = [{ time: 0, duration: 1000, words: [
    { t: 0, d: 500, text: '{\\k99}坏' },
    { t: 500, d: 500, text: '好}' },
  ] }];
  const ass = buildAss(evil);
  const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
  assert.ok(!dialogue.includes('\\k99'), '不该让歌词自带控制码混进来: ' + dialogue);
  assert.ok(dialogue.includes('坏') && dialogue.includes('好'), '文字本身要保留');
});

t('样式里的已唱/未唱色可配置', () => {
  const ass = buildAss(parseYrc(REAL), { sungColor: [255, 0, 0], unsungColor: [0, 0, 255], fontSize: 72 });
  assert.ok(ass.includes('&H000000FF'), '已唱色应为红');
  assert.ok(ass.includes('&H00FF0000'), '未唱色应为蓝');
  assert.ok(ass.includes(',72,'), '字号应生效');
});

t('writeAssFile 落盘，且同一首歌复用同一路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-ass-'));
  const f1 = writeAssFile(dir, 'song-1', parseYrc(REAL));
  assert.ok(f1 && fs.existsSync(f1), '应生成文件');
  const text = fs.readFileSync(f1, 'utf8');
  assert.ok(text.includes('{\\kf44}阴'));
  const f2 = writeAssFile(dir, 'song-1', parseYrc(REAL));
  assert.strictEqual(f1, f2, '同一首歌应复用同一路径');
  // 文件名里的非法字符要清掉（曲目 id 可能带奇怪字符）
  const f3 = writeAssFile(dir, 'a/b:c*d', parseYrc(REAL));
  assert.ok(f3 && fs.existsSync(f3));
  assert.ok(!path.basename(f3).includes('/'), '文件名不应含路径分隔符');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('没有逐字数据时 writeAssFile 返回 null（调用方回退逐行）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-ass-'));
  assert.strictEqual(writeAssFile(dir, 'x', []), null);
  assert.strictEqual(writeAssFile(dir, 'x', null), null);
  fs.rmSync(dir, { recursive: true, force: true });
});


// ── 滚动歌词（画面居中 + 滚动 + 下一行预览）─────────────────────
//
// 这一块的错误是"静默"的：ASS 拼错播放器直接不显示字幕，什么都不报。
// 而且卡拉OK的时间轴一旦被滚动事件带偏，画面上看起来完全正常，
// 只有对着嘴唱才会发现"字比声音早"——所以时间轴必须用断言钉住。
console.log('\n滚动歌词测试');

function firstY(ass) {
  const line = ass.split('\n').find((l) => l.startsWith('Dialogue:') && l.includes(',KTV,'));
  const mv = line.match(/\\move\(\d+,(\d+),\d+,(\d+),/);
  if (mv) return Number(mv[2]);
  const ps = line.match(/\\pos\(\d+,(\d+)\)/);
  return ps ? Number(ps[1]) : null;
}


const { buildRollingAss, withDefaults, ROLLING_DEFAULTS } = require('../src/ass-lyrics');
const { parseLrc } = require('../src/lyrics');

t('显式传 undefined 不能把默认值冲掉（否则时间轴全变 0:00:00.00）', () => {
  // 调用方写 { slideMs: undefined } 是很容易犯的错（三元表达式里返回 undefined）。
  // 用 { ...base, ...over } 合并会把默认值冲掉 -> slide = NaN -> 每条事件都从 0 开始。
  const lines = parseLrc('[00:20.10]阴天');
  const a = buildRollingAss(lines, { position: 'center', slideMs: undefined });
  const d = a.split('\n').find((l) => l.startsWith('Dialogue:'));
  assert.ok(!d.includes('0:00:00.00'), '时间轴被冲成 0 了: ' + d);
  assert.ok(d.includes('0:00:19.84'), '应保留 260ms 的滑入提前量: ' + d);
  assert.strictEqual(withDefaults(ROLLING_DEFAULTS, { slideMs: undefined }).slideMs, 260);
});
t('居中：当前行停在画面中央（y = 半高）', () => {
  const ass = buildRollingAss(parseLrc('[00:01.00]只有一行'));
  assert.strictEqual(firstY(ass), ROLLING_DEFAULTS.playResY / 2, ass);
  assert.ok(ass.includes('\\an5'), '要居中对齐');
});

t('贴底模式：y 落到画面下方（不会盖在正中间）', () => {
  const ass = buildRollingAss(parseLrc('[00:01.00]只有一行'), { position: 'bottom' });
  const y = firstY(ass);
  assert.ok(y > ROLLING_DEFAULTS.playResY / 2 && y < ROLLING_DEFAULTS.playResY, '贴底时 y 应在下半屏: ' + y);
});

t('滚动：当前行用 \move 从下方滑上来', () => {
  const ass = buildRollingAss(parseLrc('[00:01.00]第一行\n[00:04.00]第二行'));
  const leftX = Math.round(ROLLING_DEFAULTS.playResX * 0.27), cy = ROLLING_DEFAULTS.playResY / 2;
  const dy = Math.round(ROLLING_DEFAULTS.fontSize * ROLLING_DEFAULTS.lineGap);
  assert.ok(ass.includes(`\\move(${leftX},${cy + dy},${leftX},${cy},0,260)`), ass);
});

t('下一行预览：暗色样式固定在右侧', () => {
  const lines = parseLrc('[00:01.00]第一行\n[00:04.00]第二行');
  const ass = buildRollingAss(lines);
  const dim = ass.split('\n').filter((l) => l.includes(',KTVDim,'));
  assert.strictEqual(dim.length, 1, '应只有一条预览事件');
  const m = dim[0].match(/Dialogue: 0,([\d:.]+),([\d:.]+),KTVDim/);
  assert.ok(m, dim[0]);
  const t0 = (s) => { const [h, mm, rest] = s.split(':'); return (+h * 3600 + +mm * 60 + +rest) * 1000; };
  const rightX = Math.round(ROLLING_DEFAULTS.playResX * 0.73);
  assert.ok(dim[0].includes(`\\pos(${rightX},${ROLLING_DEFAULTS.playResY / 2})`), dim[0]);
  assert.ok(Math.abs(t0(m[2]) - 4000) < 15, '预览结束时间: ' + m[2]);
});

t('逐字时间轴不被滑入提前：用前导空格吃掉 slide 时长', () => {
  const ass = buildRollingAss(parseYrc(REAL));
  // 事件起点比歌词起点早 260ms，所以第一条 \kf 必须是 26（厘秒）的空格
  assert.ok(ass.includes('{\\kf26} {\\kf44}阴'), ass.split('\n').find((l) => l.includes('阴')));
});

t('关掉滚动（slideMs=0）时不发 \move、也不补前导空格', () => {
  const ass = buildRollingAss(parseYrc(REAL), { slideMs: 0 });
  assert.ok(!ass.includes('\\move('), '不应出现 \\move');
  assert.ok(ass.includes('{\\kf44}阴'), '第一个字应直接开始，不带前导空格');
  assert.ok(ass.includes('\\an5\\pos('), '改用静态定位');
});

t('没有逐字数据（纯 LRC）也能生成滚动歌词', () => {
  const ass = buildRollingAss(parseLrc('[00:02.00]第一句\n[00:05.00]第二句'));
  assert.ok(/^Dialogue: 0,0:00:01\.74,/m.test(ass), '应按 slide 提前到 1.74s 开始');
  assert.ok(ass.includes('第一句') && ass.includes('第二句'));
});

t('LRC 解析：毫秒时间 + 自动补 duration', () => {
  const rows = parseLrc('[00:01.50]甲\n[00:05.00]乙');
  assert.strictEqual(rows[0].time, 1500);
  assert.strictEqual(rows[0].duration, 3500, 'duration 应补成到下一行的间隔');
  assert.strictEqual(rows[1].duration, 5000, '最后一行给个兜底时长');
});

t('LRC 解析：一行多个时间标签 / 忽略元信息行', () => {
  const rows = parseLrc('[ar:某某]\n[00:10.00][00:20.00]副歌');
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map((r) => r.time), [10000, 20000]);
  assert.strictEqual(rows[0].text, '副歌');
});
console.log(`\n逐字歌词测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
