/**
 * 换片源（原唱<->伴唱）后的位置续接（会真的起 mpv 进程）
 * ======================================================
 * 钉住一个"看起来像别的 bug"的坑：
 *
 *   load() 之后 mpv 推过来的 time-pos 还是**上一个**播放项的值。
 *   老代码用 `while (currentTime() < 200) await sleep(200)` 判断"新片源起没起来"，
 *   这个条件会**立刻通过**，紧接着的 seek 就落在正在被替换掉的旧播放项上 ——
 *   用户看到的现象是"点一下伴唱，歌从头开始播"。
 *
 *   正确做法是等 mpv 的 `file-loaded` 事件（player.waitForLoaded()）。
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { MpvPlayer, createHostWindow, destroyHostWindow } = require('../src');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEDIA = path.resolve(__dirname, '../../../testmedia/ktv_lr.ts');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  if (ok) { console.log(`  [PASS] ${name}`); pass++; }
  else { console.log(`  [FAIL] ${name} - ${detail || ''}`); fail++; }
}

async function main() {
  console.log('\n换片源位置续接测试');
  if (!require('fs').existsSync(MEDIA)) {
    console.log('  跳过：缺少测试片源 ' + MEDIA);
    process.exit(0);
  }
  const hwnd = createHostWindow({ title: 'switch-test', width: 640, height: 360, visible: false });
  const player = new MpvPlayer({});
  player.attachSurface(hwnd);

  player.load(MEDIA, { accomp: 2 });
  player.play();
  const ready1 = await player.waitForLoaded(15000);
  t('waitForLoaded 能等到新片源就绪', ready1, 'ready=' + ready1);

  // 先播一会儿，拿到一个"唱到一半"的位置
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && player.currentTime() < 3000) await sleep(200);
  const pos = player.currentTime();
  t('已经播到 3 秒以上（有位置可续）', pos >= 3000, 'pos=' + pos);

  // 模拟"点伴唱"：换文件 + 等就绪 + 接回原位置
  player.load(MEDIA, { accomp: 1, keepSubtitles: true });
  player.play();
  const ready2 = await player.waitForLoaded(15000);
  t('换片源后 waitForLoaded 依然可用', ready2, 'ready=' + ready2);

  player.seek(pos);
  await sleep(1200);
  const after = player.currentTime();
  t('换片源后位置被接上（不是从头开始）', after > pos - 2000 && after < pos + 4000,
    `pos=${pos} after=${after}`);

  // 超时要能返回 false，不能把调用方挂死
  const t0 = Date.now();
  const ghost = new MpvPlayer({});
  ghost.filePath = 'X:/definitely-not-here.ts';
  const timedOut = await ghost.waitForLoaded(600);
  t('waitForLoaded 超时返回 false（不挂死调用方）', timedOut === false,
    `timedOut=${timedOut} elapsed=${Date.now() - t0}ms`);
  ghost.dispose();

  player.dispose();
  destroyHostWindow(hwnd);
  console.log(`\n换片源位置续接测试：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });