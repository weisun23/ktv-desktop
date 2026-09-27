/**
 * KtvPlayer 高层逻辑测试
 * =====================
 * 验证三件事：
 *   1. VideoSurface 子窗口能作为 libVLC 的输出目标（Electron 集成方式）
 *   2. 双音轨片源自动判定为 track 策略，原伴唱切换落到音轨
 *   3. 单音轨片源自动判定为 channel 策略，原伴唱切换落到左右声道
 *
 * 用法: node test/player-class-test.js
 */
'use strict';

const path = require('path');
const koffi = require('koffi');
const { KtvPlayer, VideoSurface, AudioChannel, AudioChannelName, REPO_ROOT, channelMapForAccomp } = require('../src');

const TESTMEDIA = path.join(REPO_ROOT, 'testmedia');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const user32 = koffi.load('user32.dll');
const CreateWindowExW = user32.func('void *CreateWindowExW(uint32, const char16_t *, const char16_t *, uint32,'
  + ' int, int, int, int, void *, void *, void *, void *)');
const DestroyWindow = user32.func('int DestroyWindow(void *)');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, passed: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  return !!ok;
}

async function waitFor(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = pred();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

async function main() {
  // 模拟 Electron 主窗口
  const parent = CreateWindowExW(0, 'Static', 'KTV parent', 0x00cf0000, 80, 80, 1400, 860, null, null, null, null);
  check('创建父窗口', !!parent, `hwnd=0x${parent.toString(16)}`);

  const surface = new VideoSurface(parent, { scaleFactor: 1 });
  surface.setBounds({ x: 20, y: 20, width: 960, height: 540 });
  check('创建视频承载子窗口', !!surface.handle(), `hwnd=0x${surface.handle().toString(16)}`);

  const player = new KtvPlayer();

  // ── 场景 1：双音轨片源 ──
  console.log('\n  ── 双音轨片源 (ktv_2tracks.ts) ──');
  player.attachSurface(surface.handle());
  player.load(path.join(TESTMEDIA, 'ktv_2tracks.ts'));
  player.play();

  const started = await waitFor(() => player.getStatus().time > 200, 25000);
  check('起播', !!started, `state=${player.getStatus().stateName}`);

  await waitFor(() => player.getTracks().length >= 2, 10000);
  const strategy = player.resolveStrategy();
  check('自动判定为 track 策略', strategy === 'track', `tracks=${player.getTracks().length}`);

  const map = player.getTrackMap();
  check('建立原伴唱->音轨映射', !!map && map.accompaniment !== map.original, JSON.stringify(map));

  player.setVocalMode('accompaniment');
  await sleep(500);
  check('切伴唱 -> 命中伴唱音轨', player.getTrack() === map.accompaniment,
    `current=${player.getTrack()} expect=${map.accompaniment}`);

  player.setVocalMode('original');
  await sleep(500);
  check('切原唱 -> 命中原唱音轨', player.getTrack() === map.original,
    `current=${player.getTrack()} expect=${map.original}`);

  // ── 场景 2：单音轨左右声道片源 ──
  console.log('\n  ── 左右声道片源 (ktv_lr.ts) ──');
  player.load(path.join(TESTMEDIA, 'ktv_lr.ts'));
  player.play();

  const started2 = await waitFor(() => player.getStatus().time > 200, 25000);
  check('起播', !!started2, `state=${player.getStatus().stateName}`);

  await waitFor(() => player.getTracks().length >= 1, 10000);
  const strategy2 = player.resolveStrategy();
  check('自动判定为 channel 策略', strategy2 === 'channel', `tracks=${player.getTracks().length}`);

  player.setVocalMode('accompaniment');
  await sleep(500);
  check('切伴唱 -> 左声道', player.getChannel() === AudioChannel.Left,
    `channel=${AudioChannelName[player.getChannel()]}`);

  player.setVocalMode('original');
  await sleep(500);
  check('切原唱 -> 右声道', player.getChannel() === AudioChannel.Right,
    `channel=${AudioChannelName[player.getChannel()]}`);

  // ── 场景 3：accomp 决定声道映射（真实曲库的正确性关键） ──
  console.log('\n  ── accomp 声道映射 ──');
  check('accomp=1 -> 左伴奏/右原唱',
    channelMapForAccomp(1).original === 'right' && channelMapForAccomp(1).accompaniment === 'left',
    JSON.stringify(channelMapForAccomp(1)));
  check('accomp=2 -> 左原唱/右伴奏',
    channelMapForAccomp(2).original === 'left' && channelMapForAccomp(2).accompaniment === 'right',
    JSON.stringify(channelMapForAccomp(2)));
  check('accomp 缺失 -> 默认左伴奏/右原唱',
    channelMapForAccomp(0).original === 'right' && channelMapForAccomp(undefined).accompaniment === 'left');

  // 用真实播放验证：accomp=2 时"切原唱"必须落到左声道
  player.load(path.join(TESTMEDIA, 'ktv_lr.ts'), { accomp: 2 });
  player.play();
  await waitFor(() => player.getStatus().time > 200, 25000);
  await waitFor(() => player.getTracks().length >= 1, 10000);
  player.resolveStrategy();
  player.setVocalMode('original');
  await sleep(500);
  check('accomp=2 切原唱 -> 左声道', player.getChannel() === AudioChannel.Left,
    `channel=${AudioChannelName[player.getChannel()]}`);
  player.setVocalMode('accompaniment');
  await sleep(500);
  check('accomp=2 切伴唱 -> 右声道', player.getChannel() === AudioChannel.Right,
    `channel=${AudioChannelName[player.getChannel()]}`);

  // ── 场景 4：视频仍在正常输出 ──
  console.log('\n  ── 视频输出 ──');
  const st = player.getStatus();
  check('子窗口上仍建立视频输出', st.hasVout, `${st.videoSize.width}x${st.videoSize.height}`);

  // 清理
  player.dispose();
  surface.destroy();
  DestroyWindow(parent);

  const failed = results.filter((r) => !r.passed);
  console.log('');
  if (failed.length) {
    console.log(`测试失败 ${failed.length} 项:`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
  console.log(`KtvPlayer 测试全部通过（${results.length} 项）`);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
