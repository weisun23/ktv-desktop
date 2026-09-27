/**
 * 片源类型判定单测
 * ================
 * 为什么值得单测：maidong 的 .ts 开头带 136 字节非 TS 数据，libVLC 的格式探测
 * 会 lost sync 并回退到 ps 解复用器，表现为花屏/纯黑；唯一解法是按片源类型
 * 切到带 --demux=ts 的实例。判定正则一旦写错（比如被转义成 /\\.ts/ ），
 * 整条播放链路会静默退化回花屏，没有任何报错——所以必须锁死。
 */
'use strict';

const assert = require('assert');
const { isTsSource } = require('../src/player');

const cases = [
  ['process.env.KTV_TEST_FILE || 'testmedia/sample.ts'', true],
  ['/home/ktv/cache/7005500.ts', true],
  ['http://download.origjoy.com/E/ts/35.2/crf/202607011700/480p/7789715.ts?sign=abc&t=6ab259ec', true],
  ['http://host/a/b/7789715.TS?x=1', true],
  ['F:\\media\\song.mp4', false],
  ['F:\\media\\song.mkv', false],
  ['http://host/live/stream.m3u8', false],
  ['F:\\media\\tsts.mp4', false],
  ['F:\\media\\a.tsx', false],
  ['', false],
  [null, false],
  [undefined, false],
];

let pass = 0;
for (const [input, expected] of cases) {
  const got = isTsSource(input);
  assert.strictEqual(got, expected, `isTsSource(${JSON.stringify(input)}) 应为 ${expected}，实得 ${got}`);
  pass++;
}
console.log(`isTsSource: ${pass}/${cases.length} 通过`);
