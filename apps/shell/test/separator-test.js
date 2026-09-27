/**
 * 音频分离测试
 * ============
 * 用受控信号验证中置消除确实有效：
 *   人声 440Hz 居中（左右相同）      -> 应该被消除
 *   伴奏 880Hz 只在左 / 1320Hz 只在右 -> 应该保留
 * 用 Goertzel 量各频点能量占比，不靠"听起来像"。
 *
 * 用法: node test/separator-test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { separateInstant, separate, accompanimentPath, hasAccompaniment, probeFfmpeg,
  needsSeparate, probeDuration } = require('../src/separator');
const { spawnSync } = require('child_process');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (detail ? ' - ' + detail : ''));
  return !!ok;
}

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** 读单声道 PCM。注意不能下混：反相信号下混会整体抵消。 */
function pcm(file, ch = 0) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ar', '48000', '-ac', '2', '-'],
    { maxBuffer: 1 << 28 });
  const a = [];
  for (let i = 0; i + 3 < raw.length; i += 4) a.push((ch === 0 ? raw.readInt16LE(i) : raw.readInt16LE(i + 2)) / 32768);
  return a;
}

function goertzel(x, rate, freq) {
  const n = x.length, k = Math.round(n * freq / rate), w = 2 * Math.PI * k / n, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (const v of x) { const s0 = v + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);
}

function spectrum(file) {
  const x = pcm(file, 0);
  const v = goertzel(x, 48000, 440), a1 = goertzel(x, 48000, 880), a2 = goertzel(x, 48000, 1320);
  const t = v + a1 + a2 || 1;
  return { vocal: v / t, accomp: (a1 + a2) / t };
}

function buildMix(dir) {
  const v = path.join(dir, 'v.wav'), ml = path.join(dir, 'ml.wav'), mr = path.join(dir, 'mr.wav');
  const l = path.join(dir, 'l.wav'), r = path.join(dir, 'r.wav'), mix = path.join(dir, 'song.wav');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5', '-ac', '1', v]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=5', '-ac', '1', ml]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=1320:sample_rate=48000:duration=5', '-ac', '1', mr]);
  ff(['-i', v, '-i', ml, '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0', '-ac', '1', l]);
  ff(['-i', v, '-i', mr, '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0', '-ac', '1', r]);
  ff(['-i', l, '-i', r, '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo', mix]);
  return mix;
}

async function main() {
  const probe = await probeFfmpeg();
  check('ffmpeg 可用', probe.ok, probe.detail);
  if (!probe.ok) { console.log('\n没有 ffmpeg，跳过分离测试'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-sep-'));
  const mix = buildMix(dir);

  const before = spectrum(mix);
  check('测试信号构造正确', before.vocal > 0.2 && before.accomp > 0.2,
    '人声=' + (before.vocal * 100).toFixed(1) + '% 伴奏=' + (before.accomp * 100).toFixed(1) + '%');

  const r = await separateInstant(mix);
  check('即时分离成功', r.ok === true, r.error || r.output);

  if (r.ok) {
    check('伴奏文件已生成', fs.existsSync(r.output), path.basename(r.output));
    check('无 .part 残留', !fs.existsSync(r.output + '.part'));

    const after = spectrum(r.output);
    check('人声被消除（<5%）', after.vocal < 0.05, '人声=' + (after.vocal * 100).toFixed(1) + '%');
    check('伴奏被保留（>90%）', after.accomp > 0.9, '伴奏=' + (after.accomp * 100).toFixed(1) + '%');
    check('hasAccompaniment 能识别', hasAccompaniment(mix) === true);
    check('伴奏路径符合约定', accompanimentPath(mix).endsWith('.accomp.wav'), path.basename(accompanimentPath(mix)));

    const again = await separateInstant(mix);
    check('已分离则跳过', again.ok && again.skipped === true);
  }

  const bad = await separateInstant(path.join(dir, 'missing.wav'));
  check('源文件不存在时报错可读', bad.ok === false && /不存在/.test(bad.error), bad.error);

  const off = await separate(mix, { mode: 'off' });
  check('mode=off 不执行', off.ok === false && /未启用/.test(off.error));

  const noPlugin = await separate(mix, { mode: 'plugin' });
  check('未装插件时提示可读', noPlugin.ok === false && /插件/.test(noPlugin.error), noPlugin.error);

  fs.rmSync(dir, { recursive: true, force: true });

  // ── MV 场景：源文件带画面时，分离产物必须保留画面 ──
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-sep-mv-'));
    const mv = path.join(dir2, 'mv.ts');
    // 用和 buildMix 相同的方式造立体声：人声 440Hz 居中（左右都有），伴奏 880/1320 分居左右。
    // 这样中置消除才会把 440Hz 消掉 —— 注意不能把 440Hz 只放左声道。
    const mvMix = buildMix(dir2);
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=5',
      '-i', mvMix,
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'mp2', '-b:a', '128k', '-shortest', '-f', 'mpegts', mv]);

    const r = await separateInstant(mv, { force: true });
    check('MV 分离成功', r.ok === true, r.error || '');
    check('报告保留了画面', r.hasVideo === true);
    if (r.ok) {
      const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type',
        '-of', 'csv=p=0', r.output], { encoding: 'utf8' });
      check('产物同时有视频和音频', /video/.test(streams) && /audio/.test(streams),
        streams.trim().split(/\s+/).join(','));
      const sp = spectrum(r.output);   // 返回 { vocal, accomp } 两个占比
      check('MV 分离后中置人声被消除', sp.vocal < 0.05,
        '人声占比 ' + (sp.vocal * 100).toFixed(2) + '%');
    }
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // ── AI 插件路径：用 mock 插件验证宿主<->插件的调用约定 ──
  //
  // 这里**故意不依赖 demucs**（那要 200MB 依赖 + 模型下载）：
  // mock 插件只做一件事——把 --input 复制成 --output。
  // 它验证的是宿主侧真正容易错的东西：参数怎么传、退出码怎么判、产物怎么收。
  {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-sep-plugin-'));
    const src = buildMix(dir3);

    // Windows 上必须能跑 .cmd —— Node 不允许直接 spawn .cmd，
    // 宿主改成经 cmd.exe 转一手。setup-demucs.ps1 生成的正是 separate.cmd。
    const isWin = process.platform === 'win32';
    const mock = path.join(dir3, isWin ? 'mock-plugin.cmd' : 'mock-plugin.sh');
    if (isWin) {
      fs.writeFileSync(mock, '@echo off\r\ncopy /y "%~2" "%~4" >nul\r\n', 'ascii');
    } else {
      fs.writeFileSync(mock, '#!/bin/sh\ncp "$2" "$4"\n', 'utf8');
      fs.chmodSync(mock, 0o755);
    }

    const ok = await separate(src, { mode: 'plugin', pluginPath: mock, force: true });
    check('AI 插件路径可跑通（.cmd 也能调）', ok.ok === true, ok.error || '');
    if (ok.ok && ok.output) {
      const a = fs.statSync(src).size;
      const b = fs.statSync(ok.output).size;
      check('插件产物被正确收下', b > 0, `src=${a}B out=${b}B`);
      check('插件产物保留原扩展名（纯音频源）', ok.output.endsWith('.wav'), ok.output);
    }

    // 插件返回非 0 时，宿主要把 stderr 带出来（否则用户完全不知道发生了什么）
    const bad = path.join(dir3, isWin ? 'bad-plugin.cmd' : 'bad-plugin.sh');
    if (isWin) {
      fs.writeFileSync(bad, '@echo off\r\necho plugin-boom 1>&2\r\nexit /b 3\r\n', 'ascii');
    } else {
      fs.writeFileSync(bad, '#!/bin/sh\necho "plugin-boom" 1>&2\nexit 3\n', 'utf8');
      fs.chmodSync(bad, 0o755);
    }
    const r2 = await separate(src, { mode: 'plugin', pluginPath: bad, force: true });
    check('插件失败时报出可读原因', r2.ok === false && /plugin-boom|exit/.test(r2.error || ''), r2.error || '');

    // 回归：曾经 separateWithPlugin 里 out 未定义就使用，AI 这条路一调就抛
    // "out is not defined"，而单元测试只覆盖了即时分离所以一直没发现。
    check('插件路径不再抛 out is not defined',
      !/out is not defined/.test((r2.error || '') + (ok.error || '')), r2.error || ok.error || '');

    fs.rmSync(dir3, { recursive: true, force: true });
  }

  // ── MV + AI 插件：产物**不能比原片短** ─────────────────────────
  //
  // 真实踩到的坑：demucs 产出的伴奏比原片短几秒（它会裁掉首尾 padding），
  // 而合并时写了 `-shortest` —— ffmpeg 以**较短的那条（音频）**为准结束封装，
  // 结果 MV 的结尾被整段切掉。
  // 现象不是"少几秒"，而是：唱到后半段切「伴唱」时 mpv 立刻 EOF，
  // 上层把 EOF 当成"唱完了"→ **直接切下一首**。本机 7 个 .accomp.ts 全中招。
  //
  // 这里用"会把音频裁短的 mock 插件"复现这个场景，断言产物时长 ≈ 原片时长。
  {
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-sep-short-'));
    const isWin = process.platform === 'win32';
    const mvMix = buildMix(dir4);          // 5 秒立体声
    const mv = path.join(dir4, 'mv.ts');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=5',
      '-i', mvMix,
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'mp2', '-b:a', '128k', '-shortest', '-f', 'mpegts', mv]);

    // 假插件：把输入**裁到 3 秒**再输出，模拟 AI 分离器的首尾裁剪
    const trim = path.join(dir4, isWin ? 'trim-plugin.cmd' : 'trim-plugin.sh');
    if (isWin) {
      fs.writeFileSync(trim, '@echo off\r\nffmpeg -y -v error -i "%~2" -t 3 "%~4"\r\n', 'ascii');
    } else {
      fs.writeFileSync(trim, '#!/bin/sh\nffmpeg -y -v error -i "$2" -t 3 "$4"\n', 'utf8');
      fs.chmodSync(trim, 0o755);
    }

    const srcMs = await probeDuration('ffmpeg', mv);
    const r = await separate(mv, { mode: 'plugin', pluginPath: trim, force: true });
    check('MV + 插件分离成功', r.ok === true, r.error || '');
    if (r.ok && r.output) {
      const outMs = await probeDuration('ffmpeg', r.output);
      check('产物不比原片短（结尾没被 -shortest 切掉）',
        srcMs != null && outMs != null && srcMs - outMs < 500,
        `src=${srcMs}ms out=${outMs}ms`);
      const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type',
        '-of', 'csv=p=0', r.output], { encoding: 'utf8' });
      check('产物仍然带画面', /video/.test(streams), streams.trim().split(/\s+/).join(','));
    }

    // 老版本留下的"残次品"要被识别出来，不能直接拿去播
    const stale = accompanimentPath(mv);
    fs.copyFileSync(mv, stale);
    const staleMs = await probeDuration('ffmpeg', stale);
    check('残次品检测：把原片当成伴奏（等长）时认为可用',
      staleMs != null && (await needsSeparate(mv)) === false);
    // 造一个明显短的伴奏文件
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'mp2', '-shortest', '-f', 'mpegts', stale]);
    check('残次品检测：伴奏明显短于原片时判为需要重做',
      (await needsSeparate(mv)) === true);

    fs.rmSync(dir4, { recursive: true, force: true });
  }
  const failed = results.filter((x) => !x.ok);
  console.log('');
  if (failed.length) {
    console.log('音频分离测试失败 ' + failed.length + '/' + results.length + ' 项');
    failed.forEach((f) => console.log('  - ' + f.name + ' ' + f.detail));
    process.exit(1);
  }
  console.log('音频分离测试全部通过（' + results.length + ' 项）');
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
