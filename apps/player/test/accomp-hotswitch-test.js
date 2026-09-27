/**
 * 原伴唱热切换（会真的起 mpv 进程）
 * ================================
 * 钉住两件事：
 *
 *   1. **切原伴唱不能 seek、不能跳。**
 *      maidong 的 .ts 时间戳是坏的，seek 会偏几秒（实测 seek 60s 落到 66.4s）。
 *      老做法"换文件 + seek 回原位置"于是每次切原伴唱都把音频**快进**过去。
 *      现在改成"把伴奏挂成外挂音轨 + 切 aid"，位置纹丝不动。
 *
 *   2. **外挂音轨只能挂一次。**
 *      load() 之后和 mpv 的 file-loaded 事件都会触发挂载，没在途保护就会挂两条。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { MpvPlayer, createHostWindow, destroyHostWindow } = require('../src');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(ROOT, 'resources/catalog/video/cloud-song/7005500.ts');
const ACC = path.join(ROOT, 'resources/catalog/video/cloud-song/7005500.accomp.ts');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  if (ok) { console.log(`  [PASS] ${name}`); pass++; }
  else { console.log(`  [FAIL] ${name} - ${detail || ''}`); fail++; }
}

/** 采样 time-pos，返回 { series, maxJump } */
async function sample(player, n = 30) {
  const series = [];
  for (let i = 0; i < n; i++) { series.push(player.currentTime()); await sleep(50); }
  let maxJump = 0;
  for (let i = 1; i < series.length; i++) maxJump = Math.max(maxJump, series[i] - series[i - 1]);
  return { series, maxJump };
}

async function main() {
  console.log('\n原伴唱热切换测试');
  if (!fs.existsSync(SRC) || !fs.existsSync(ACC)) {
    console.log('  跳过：缺少测试片源');
    process.exit(0);
  }
  const hwnd = createHostWindow({ title: 'hotswitch', width: 640, height: 360, visible: false });
  const player = new MpvPlayer({ smoothPlayback: false });
  player.on('error', () => {});
  player.attachSurface(hwnd);
  player.load(SRC, { accomp: 2 });
  player.play();
  await player.waitForLoaded(15000);

  // 挂外挂伴奏（不选中）
  const attached = await player.attachAccompaniment(ACC);
  t('伴奏能挂成外挂音轨', attached && player.hasAccompanimentTrack(), 'attached=' + attached);

  await sleep(1500);
  const ext = (player._trackList || []).filter(x => x.type === 'audio' && x.external);
  t('外挂音轨只挂一条（没有重复 audio-add）', ext.length === 1,
    'external audio tracks=' + ext.length);

  // 播一会儿，拿到一个"唱到一半"的位置
  let d = Date.now() + 25000;
  while (Date.now() < d && player.currentTime() < 12000) await sleep(200);
  const before = player.currentTime();
  t('已经播到 12 秒以上（有位置可验证）', before >= 12000, 'pos=' + before);

  // 切伴唱
  player.setVocalMode('accompaniment');
  await sleep(300);
  const toAccomp = await sample(player);
  const jump1 = toAccomp.series[0] - before;
  t('切「伴唱」不跳（不是快进）', jump1 < 1500 && toAccomp.maxJump < 1500,
    `jump=${jump1}ms maxStep=${toAccomp.maxJump}ms`);
  t('切「伴唱」后确实换了音轨', player.getTrack() !== 1 || ext.length === 0,
    'aid=' + player.getTrack());

  // 切回原唱
  const beforeBack = player.currentTime();
  player.setVocalMode('original');
  await sleep(300);
  const toOrig = await sample(player);
  const jump2 = toOrig.series[0] - beforeBack;
  t('切回「原唱」不跳', jump2 < 1500 && toOrig.maxJump < 1500,
    `jump=${jump2}ms maxStep=${toOrig.maxJump}ms`);
  t('切回「原唱」后 aid 回到片源自带音轨', player.getTrack() === 1, 'aid=' + player.getTrack());

  player.dispose(); destroyHostWindow(hwnd);
  console.log(`\n原伴唱热切换测试：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });