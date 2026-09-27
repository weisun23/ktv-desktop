/**
 * 播放器模块冒烟测试（无需 Electron）
 * ==================================
 * 用 koffi 直接创建一个 Win32 宿主窗口，把 libVLC 嵌进去，
 * 验证 Node 绑定确实能驱动 libVLC 完成 KTV 需要的全部操作。
 *
 * 与 poc/player/ 的 Python 版本一一对应，验证的是同一套 C API。
 *
 * 用法: node test/player-smoke.js
 */
'use strict';

const path = require('path');
const koffi = require('koffi');
const vlc = require('../src/vlc-ffi');

const REPO = vlc.REPO_ROOT;
const TESTMEDIA = path.join(REPO, 'testmedia');

const WS_OVERLAPPEDWINDOW = 0x00cf0000;
const WS_POPUP = 0x80000000;

let user32;
function win() {
  if (!user32) user32 = koffi.load('user32.dll');
  return user32;
}

function createHostWindow(title, w, h, visible) {
  const CreateWindowExW = win().func(
    'void *CreateWindowExW(uint32 dwExStyle, const char16_t *lpClassName, const char16_t *lpWindowName,' +
    ' uint32 dwStyle, int x, int y, int nWidth, int nHeight,' +
    ' void *hWndParent, void *hMenu, void *hInstance, void *lpParam)'
  );
  const style = visible ? WS_OVERLAPPEDWINDOW : WS_POPUP;
  const hwnd = CreateWindowExW(0, 'Static', title, style, 80, 80, w, h, null, null, null, null);
  if (!hwnd) throw new Error('CreateWindowExW 失败');
  return hwnd;
}

function destroyWindow(hwnd) {
  win().func('int DestroyWindow(void *hWnd)')(hwnd);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(100);
  }
  return false;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, passed: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  return !!ok;
}

async function run() {
  console.log('libVLC =', vlc.getVersion());

  const media = path.join(TESTMEDIA, 'ktv_2tracks.ts');
  const mediaLr = path.join(TESTMEDIA, 'ktv_lr.ts');

  const inst = vlc.newInstance();
  const hwnd = createHostWindow('KTV player smoke', 1280, 720, false);
  check('创建宿主 HWND', !!hwnd, `hwnd=0x${hwnd.toString(16)}`);

  const mp = vlc.newMediaPlayer(inst);
  const m = vlc.newMediaPath(inst, media);
  vlc.setMedia(mp, m);
  vlc.setHwnd(mp, hwnd);

  const rc = vlc.play(mp);
  check('play() 调用成功', rc === 0, `rc=${rc}`);

  const started = await waitFor(() => vlc.getTime(mp) > 200, 25000);
  check('起播并推进时间轴', started, `state=${vlc.getStateName(mp)} time=${vlc.getTime(mp)}ms`);

  const gotVout = await waitFor(() => vlc.hasVout(mp), 10000);
  const size = vlc.getVideoSize(mp);
  check('在外部 HWND 上建立视频输出', gotVout, `${size.width}x${size.height}`);

  // ── 音轨枚举与切换（新式 KTV） ──
  await waitFor(() => vlc.getTrackCount(mp) > 1, 10000);
  const tracks = vlc.getTracks(mp);
  check('枚举音轨', tracks.length === 2, JSON.stringify(tracks));

  let trackOk = tracks.length === 2;
  for (const t of tracks) {
    vlc.setTrack(mp, t.id);
    await sleep(500);
    const cur = vlc.getTrack(mp);
    console.log(`    setTrack(${t.id}) -> getTrack()=${cur}`);
    trackOk = trackOk && cur === t.id;
  }
  check('切换音轨并回读一致', trackOk);

  // ── 声道切换（老式 KTV） ──
  let chanOk = true;
  for (const [name, code] of [['Left', vlc.AudioChannel.Left], ['Right', vlc.AudioChannel.Right], ['Stereo', vlc.AudioChannel.Stereo]]) {
    const setRc = vlc.setChannel(mp, code);
    await sleep(400);
    const cur = vlc.getChannel(mp);
    console.log(`    setChannel(${name}) rc=${setRc} -> getChannel()=${vlc.AudioChannelName[cur] ?? cur}`);
    chanOk = chanOk && setRc === 0 && cur === code;
  }
  check('切换声道 L/R/Stereo 并回读一致', chanOk);

  // ── seek ──
  vlc.setTime(mp, 15000);
  const seeked = await waitFor(() => Math.abs(vlc.getTime(mp) - 15000) < 4000, 12000);
  check('seek 到 15s', seeked, `position=${vlc.getTime(mp)}ms`);

  // ── 音量 ──
  vlc.setVolume(mp, 60);
  await sleep(200);
  const vol = vlc.getVolume(mp);
  check('设置音量', Math.abs(vol - 60) <= 5, `volume=${vol}`);

  // ── 换片源：单音轨左右声道型 ──
  vlc.stop(mp);
  const m2 = vlc.newMediaPath(inst, mediaLr);
  vlc.setMedia(mp, m2);
  vlc.play(mp);
  const started2 = await waitFor(() => vlc.getTime(mp) > 200, 25000);
  await waitFor(() => vlc.getTrackCount(mp) > 0, 10000);
  const tracks2 = vlc.getTracks(mp);
  check('切换到左右声道型片源并起播', started2 && tracks2.length === 1,
    `tracks=${JSON.stringify(tracks2)} state=${vlc.getStateName(mp)}`);

  // 清理
  vlc.stop(mp);
  await sleep(300);
  vlc.releaseMediaPlayer(mp);
  vlc.releaseMedia(m);
  vlc.releaseMedia(m2);
  vlc.releaseInstance(inst);
  destroyWindow(hwnd);

  const failed = results.filter((r) => !r.passed);
  console.log('');
  if (failed.length) {
    console.log(`冒烟测试失败 ${failed.length} 项:`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
  console.log(`冒烟测试全部通过（${results.length} 项）`);
}

run().catch((e) => { console.error('冒烟测试异常:', e); process.exit(1); });
