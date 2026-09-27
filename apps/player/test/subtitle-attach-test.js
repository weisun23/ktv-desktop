/**
 * 画面歌词字幕的挂载/重挂回归测试（会真的起 mpv 进程）
 * ===================================================
 * 钉住两个"静默失败"：
 *
 *   1. 歌词比播放器先就绪时字幕被丢掉。
 *      点歌那一刻渲染进程就去取歌词了，而 mpv 进程是 load() 时才拉起来的。
 *      setSubtitleFile 里老写法是 `if (!this.ipc) return;` —— 直接丢掉，
 *      于是**第一首歌永远没有画面歌词**，用户看到的是"有些歌没歌词"。
 *
 *   2. 换片源（原唱<->伴唱）会把外挂字幕一起丢掉。
 *      loadfile 会新建播放项，之前 sub-add 的字幕不在新项上，必须重新挂。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MpvPlayer, createHostWindow, destroyHostWindow } = require('../src');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEDIA = path.resolve(__dirname, '../../../testmedia/ktv_lr.ts');

let pass = 0, fail = 0;
function t(name, fnOrBool, detail) {
  try {
    const ok = typeof fnOrBool === 'function' ? fnOrBool() : fnOrBool;
    if (!ok) throw new Error(detail || '断言失败');
    console.log(`  [PASS] ${name}`); pass++;
  } catch (e) { console.log(`  [FAIL] ${name} - ${e.message}`); fail++; }
}

const MINIMAL_ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1280',
  'PlayResY: 720',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,'
    + ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,'
    + ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: KTV,Microsoft YaHei,46,&H00A4CC27,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,5,40,40,52,1',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:00.00,0:01:00.00,KTV,,0,0,0,,{\\an5\\pos(640,360)}测试歌词',
  '',
].join('\n');

/** 轮询直到 mpv 的 track-list 里出现/消失外挂字幕 */
async function waitSub(player, want, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const subs = player.getSubtitleTracks();
    if (want ? subs.length > 0 : subs.length === 0) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  console.log('\n画面歌词字幕挂载测试');
  if (!fs.existsSync(MEDIA)) {
    console.log('  跳过：缺少测试片源 ' + MEDIA);
    process.exit(0);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-sub-'));
  const ass = path.join(dir, 'song.karaoke.ass');
  fs.writeFileSync(ass, MINIMAL_ASS, 'utf8');

  const hwnd = createHostWindow({ title: 'sub-test', width: 640, height: 360, visible: false });
  const player = new MpvPlayer({});
  player.attachSurface(hwnd);

  // ① 复现真实时序：先 load（此刻 mpv 进程刚在拉起来、ipc 还是 null），
  //    紧接着歌词就绪并挂字幕。老代码 `if (!this.ipc) return;` 会把它直接丢掉。
  player.load(MEDIA, { accomp: 2 });
  await player.setSubtitleFile(ass);
  player.play();
  const attached = await waitSub(player, true);
  t('播放器还没起来时给的歌词，起播后能挂上', attached,
    'subs=' + JSON.stringify(player.getSubtitleTracks()));

  // ② 换片源后要重新挂（loadfile 会丢掉外挂字幕）
  player.load(MEDIA, { accomp: 1, keepSubtitles: true });
  await sleep(1200);
  const afterReload = await waitSub(player, true);
  t('换片源（原唱<->伴唱）后字幕自动重新挂上', afterReload,
    'subs=' + JSON.stringify(player.getSubtitleTracks()));

  // ③ 关掉歌词要真的摘掉
  await player.setSubtitleFile(null);
  const removed = await waitSub(player, false);
  t('setSubtitleFile(null) 能摘掉字幕', removed,
    'subs=' + JSON.stringify(player.getSubtitleTracks()));

  player.dispose();
  destroyHostWindow(hwnd);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n画面歌词字幕测试：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });