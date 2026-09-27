/**
 * 音频分离
 * ========
 * 把一首歌的人声与伴奏分开，让"原唱/伴唱"切换对**任何**歌曲都可用——
 * 不限于自带双音轨的 KTV 片源。
 *
 * 提供两档：
 *
 *   1. instant（内置，零依赖）
 *      用 ffmpeg 做**中置声道消除**：人声通常居中，左右声道相减即可抵消，
 *      侧向分布的乐器保留。秒级完成。
 *      局限：对"人声不在正中间"的录音效果差，且输出是反相信号，
 *      一旦被下混成单声道会整体抵消（所以必须以立体声播放）。
 *
 *   2. plugin（可选，AI 分离）
 *      需要外部插件（demucs 等）。质量高但慢、依赖重，故做成插件按需安装。
 *      本模块只负责探测与调用，不内置模型。
 *
 * ⚠️ MV 场景（重要）
 * 源文件如果**带画面**，分离结果必须**保留画面**，否则切到伴唱时画面就没了。
 * 所以这里分两步：
 *   - 只有音轨：直接输出伴奏音频文件（原行为）
 *   - 带画面  ：视频流 `-c:v copy` 原样保留，只把音轨换成分离结果
 * AI 插件同理：先把音轨抽成 wav 交给插件，再把插件产出的伴奏**合回原视频**。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const { markPlain, isPlainMarked } = require('./tsdecrypt');

/** 伴奏文件的命名后缀 */
const ACCOMP_SUFFIX = '.accomp';

/**
 * 分离产物的扩展名。
 * - .ts 源：保持 .ts（mpegts 能同时装 h264 + mp2）
 * - 纯音频源：保持原扩展名（行为与以前一致）
 * - 其它带画面源：用 .mkv（matroska 能装任意视频/音频组合，兼容性最好）
 */
function outExtFor(sourceFile, hasVideo = false) {
  const ext = path.extname(sourceFile).toLowerCase();
  if (ext === '.ts') return '.ts';
  if (!hasVideo) return ext || '.mkv';
  return '.mkv';
}

/** ffmpeg 可执行文件：优先用环境变量，其次 PATH。 */
function resolveFfmpeg() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/** 探测 ffmpeg 是否可用（有些机器没装）。 */
function probeFfmpeg(ffmpegPath = resolveFfmpeg()) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, detail) => { if (!done) { done = true; resolve({ ok, detail }); } };
    try {
      const p = spawn(ffmpegPath, ['-version']);
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('error', (e) => finish(false, e.message));
      p.on('close', (code) => finish(code === 0, out.split('\n')[0] || `exit ${code}`));
      setTimeout(() => { try { p.kill(); } catch {} finish(false, '探测超时'); }, 8000);
    } catch (e) { finish(e.message); }
  });
}

/** 由源文件推导伴奏文件路径：`a/b/歌.mp3` -> `a/b/歌.accomp.mp3` */
function accompanimentPath(sourceFile, hasVideo = false) {
  const dir = path.dirname(sourceFile);
  const ext = path.extname(sourceFile);
  const base = path.basename(sourceFile, ext);
  return path.join(dir, `${base}${ACCOMP_SUFFIX}${outExtFor(sourceFile, hasVideo)}`);
}

/**
 * 找出已存在的伴奏文件。
 * 扩展名取决于源文件有没有画面，调用方不一定知道，所以两种都查。
 */
function findAccompaniment(sourceFile) {
  const dir = path.dirname(sourceFile);
  const ext = path.extname(sourceFile);
  const base = path.basename(sourceFile, ext);
  const candidates = [
    path.join(dir, `${base}${ACCOMP_SUFFIX}${ext}`),        // 纯音频 / ts
    path.join(dir, `${base}${ACCOMP_SUFFIX}.mkv`),          // 带画面的非 ts
  ];
  for (const c of candidates) {
    try {
      if (!fs.statSync(c).isFile()) continue;
      // ⚠️ 只有**打过"明文"标记**的伴奏才算数。
      // 早期版本是从**加密的**源文件分离出来的 —— 画面里带着加密段（马赛克），
      // 而且文件头看不出来。没有标记就当它不存在，下次播放会自动重做。
      if (!isPlainMarked(c)) continue;
      return c;
    } catch { /* 继续 */ }
  }
  return null;
}

/** 是否已经分离过。 */
function hasAccompaniment(sourceFile) {
  return findAccompaniment(sourceFile) !== null;
}

/** 跑一次 ffmpeg，收集 stderr，返回 {ok, error}。 */
function runFfmpeg(ffmpeg, args, onStderr) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { const s = d.toString(); err += s; if (err.length > 20000) err = err.slice(-20000); onStderr?.(s); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => {
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, error: err.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `ffmpeg exit ${code}` });
    });
  });
}

/**
 * 读媒体时长（毫秒）。
 * 用 `ffmpeg -i` 的 stderr 解析，不额外依赖 ffprobe（有些环境只有 ffmpeg）。
 * 读不到返回 null —— 调用方必须把 null 当成"未知"，不能当成 0。
 */
function probeDuration(ffmpeg, file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 200000) err = err.slice(-200000); });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/);
      if (!m) return resolve(null);
      resolve(Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000));
    });
  });
}

/**
 * 允许的时长差。小于这个值认为"就是原片长度"。
 * AI 分离器（demucs）会把首尾的 padding 裁掉，产出比原片短 4~7 秒是常态，
 * 那是它自己的行为；我们要防的是**它把结果也截短**。
 */
const DURATION_TOLERANCE_MS = 1500;

/**
 * 已经存在的伴奏文件能不能直接用？
 *
 * ⚠️ 只看"文件在不在"是不够的。实测本机 7 个 .accomp.ts **每一个**都比原片短
 * 4.7~7.5 秒 —— 都是老版本用 `-shortest` 合并时被**音频**的时长截断，MV 的结尾被切掉了。
 * 这种残次品留在盘上会有两个后果：
 *   1. 切到「伴唱」后如果已经唱过这个位置，mpv 立刻 EOF，被上层当成"唱完了"**直接切歌**；
 *   2. 就算没切歌，伴唱版本也会比原唱版本早结束几秒。
 * 所以这里顺带核验时长，不合格就当它不存在（下次分离会自动重做）。
 *
 * 返回可用的伴奏路径；没有 / 不合格 / 量不出来但存在 -> 见下。
 */
async function existingAccompanimentUsable(ffmpeg, sourceFile) {
  const existed = findAccompaniment(sourceFile);
  if (!existed) return null;
  const [srcMs, accMs] = await Promise.all([
    probeDuration(ffmpeg, sourceFile),
    probeDuration(ffmpeg, existed),
  ]);
  // 量不出来（比如文件正在被占用）时保守处理：先当它能用，别把用户已经做好的伴奏废掉
  if (srcMs == null || accMs == null) return existed;
  if (srcMs - accMs > DURATION_TOLERANCE_MS) return null;
  return existed;
}

/**
 * 需不需要（重新）分离。给上层做"要不要提示用户/要不要排队"用，
 * 免得每次点歌都弹一句"正在后台分离"、其实什么都没做。
 */
async function needsSeparate(sourceFile, opts = {}) {
  if (!fs.existsSync(sourceFile)) return true;
  const ffmpeg = opts.ffmpegPath || resolveFfmpeg();
  return (await existingAccompanimentUsable(ffmpeg, sourceFile)) === null;
}
/**
 * 探测源文件里有没有视频流。
 * MV 场景要靠它决定"保留画面"还是"只出音频"。
 */
async function probeHasVideo(ffmpeg, sourceFile) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-i', sourceFile], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(/Stream #\d+:\d+.*: Video:/.test(err)));
  });
}

/**
 * 即时分离：中置声道消除。
 *
 * ffmpeg 滤镜 `pan=stereo|c0=c0-c1|c1=c1-c0` 就是经典的卡拉OK消除：
 * 左=原左-原右，右=原右-原左。居中的信号（人声）在相减时抵消，
 * 左右不同的信号（乐器）保留下来。
 *
 * **带画面时保留画面**（`-c:v copy`），切到伴唱画面不会消失。
 *
 * @param {string} sourceFile 源媒体文件
 * @param {{ffmpegPath?:string, onProgress?:(p:number)=>void, force?:boolean, audioStream?:number}} [opts]
 * @returns {Promise<{ok:boolean, output?:string, skipped?:boolean, error?:string, hasVideo?:boolean}>}
 */
async function separateInstant(sourceFile, opts = {}) {
  const ffmpeg = opts.ffmpegPath || resolveFfmpeg();

  if (!opts.force) {
    const existed = await existingAccompanimentUsable(ffmpeg, sourceFile);
    if (existed) return { ok: true, output: existed, skipped: true };
  }
  if (!fs.existsSync(sourceFile)) return { ok: false, error: `源文件不存在: ${sourceFile}` };

  const probe = await probeFfmpeg(ffmpeg);
  if (!probe.ok) return { ok: false, error: `ffmpeg 不可用: ${probe.detail}` };

  const hasVideo = await probeHasVideo(ffmpeg, sourceFile);
  const out = accompanimentPath(sourceFile, hasVideo);
  // 临时文件必须保留真实扩展名，否则 ffmpeg 推断不出输出格式
  const tmp = `${out}.part${path.extname(out)}`;
  await fsp.rm(tmp, { force: true });

  const audioIdx = Number.isInteger(opts.audioStream) ? opts.audioStream : 0;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourceFile];
  if (hasVideo) {
    // 保留画面：视频流直接复制，不解码
    args.push('-map', '0:v:0', '-map', `0:a:${audioIdx}`, '-c:v', 'copy');
  } else {
    args.push('-vn', '-map', `0:a:${audioIdx}`);
  }
  // 输出保持立体声：反相结构不能被下混
  args.push('-af', 'pan=stereo|c0=c0-c1|c1=c1-c0', '-ac', '2');
  if (path.extname(out) === '.mkv') args.push('-c:a', 'libmp3lame', '-b:a', '224k');
  args.push(tmp);

  const r = await runFfmpeg(ffmpeg, args);
  if (!r.ok) {
    await fsp.rm(tmp, { force: true });
    return { ok: false, error: r.error };
  }
  try {
    await fsp.rename(tmp, out);   // 原子替换，避免留下半个文件
    markPlain(out);
    opts.onProgress?.(100);
    return { ok: true, output: out, hasVideo };
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    return { ok: false, error: e.message };
  }
}

/**
 * 插件式 AI 分离（可选）。
 *
 * 插件是一个可执行文件/脚本，约定：
 *   <plugin> --input <wav> --output <wav>
 * 成功退出码 0，并把分离出的伴奏写到 --output。
 *
 * 流程（MV 也能用）：
 *   1. 从源文件抽出音轨为 wav
 *   2. 交给插件分离
 *   3. 把伴奏音轨**合回原视频**（视频流 -c:v copy），带画面时画面不丢
 *
 * 本模块不内置任何模型；没装插件时返回可读的提示。
 *
 * @param {string} sourceFile
 * @param {{pluginPath?:string, ffmpegPath?:string, onProgress?:(p:number)=>void, force?:boolean, audioStream?:number}} [opts]
 */
async function separateWithPlugin(sourceFile, opts = {}) {
  const plugin = opts.pluginPath || process.env.KTV_SEPARATOR_PLUGIN;
  if (!plugin) {
    return { ok: false, error: '未安装 AI 分离插件。可在设置里配置插件路径，或先用「即时分离」。' };
  }
  if (!fs.existsSync(plugin)) return { ok: false, error: `插件不存在: ${plugin}` };
  if (!fs.existsSync(sourceFile)) return { ok: false, error: `源文件不存在: ${sourceFile}` };

  const ffmpeg = opts.ffmpegPath || resolveFfmpeg();
  const probe = await probeFfmpeg(ffmpeg);
  if (!probe.ok) return { ok: false, error: `ffmpeg 不可用: ${probe.detail}` };

  if (!opts.force) {
    const existed = await existingAccompanimentUsable(ffmpeg, sourceFile);
    if (existed) return { ok: true, output: existed, skipped: true };
  }

  // ⚠️ 这里必须先算出 out 再用它派生路径。
  // 之前写成"先 path.dirname(...) + path.basename(out) 再定义 out"，
  // 结果 AI 插件这条路径**一调用就抛 out is not defined**，从来没跑通过。
  const hasVideo = await probeHasVideo(ffmpeg, sourceFile);
  const out = accompanimentPath(sourceFile, hasVideo);
  const dir = path.dirname(out);
  const stem = path.basename(out, path.extname(out));
  const srcWav = path.join(dir, `${stem}.src.wav`);
  const sepWav = path.join(dir, `${stem}.sep.wav`);
  const tmp = `${out}.part${path.extname(out)}`;
  const cleanup = async () => { for (const f of [srcWav, sepWav, tmp]) { try { await fsp.rm(f, { force: true }); } catch { /* 忽略 */ } } };

  try {
    await cleanup();
    const audioIdx = Number.isInteger(opts.audioStream) ? opts.audioStream : 0;

    // 1) 抽音轨（保持立体声，AI 分离需要原始混音）
    opts.onProgress?.(5);
    let r = await runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourceFile,
      '-vn', '-map', `0:a:${audioIdx}`, '-ac', '2', '-ar', '44100', srcWav]);
    if (!r.ok) throw new Error(`抽取音轨失败: ${r.error}`);

    // 2) 交给插件
    opts.onProgress?.(20);
    r = await new Promise((resolve) => {
      // ⚠️ Windows 上 Node 不允许直接 spawn .cmd/.bat（会抛 EINVAL），
      // 必须经 cmd.exe 转一手。setup-demucs.ps1 生成的正是 separate.cmd。
      const isBatch = /\.(cmd|bat)$/i.test(plugin);
      const cmd = isBatch ? (process.env.ComSpec || 'cmd.exe') : plugin;
      // 设备交给插件自己挑（auto = 有 CUDA 就用）。用户也能在设置里强制 cpu/cuda。
      const devArgs = ['--device', opts.device || 'auto'];
      // 模型可换：htdemucs 快、htdemucs_ft 质量更好（4 个模型集成，慢约 4 倍）。
      // 装了 GPU 之后慢 4 倍也还能接受，所以做成可选项。
      if (opts.model) devArgs.push('--model', String(opts.model));
      const argv = isBatch
        ? ['/d', '/c', plugin, '--input', srcWav, '--output', sepWav, ...devArgs]
        : ['--input', srcWav, '--output', sepWav, ...devArgs];
      const p = spawn(cmd, argv, { shell: false, windowsHide: true });
      // ⚠️ AI 分离是分钟级、吃满 CPU 的活。不降优先级的话它会和正在播的视频抢核，
      // 表现为「一开自动分离，画面就开始卡」——实测 demucs 会跑满所有核心。
      // 降到 BelowNormal 之后，系统优先保证播放线程，分离只是慢一点。
      try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 权限不足就跳过 */ }
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: err.trim().slice(0, 300) || `插件 exit ${code}` }));
    });
    if (!r.ok) throw new Error(`分离插件失败: ${r.error}`);
    if (!fs.existsSync(sepWav)) throw new Error('分离插件没有产出文件');

    // 3) 合回原文件（带画面就保留画面）
    opts.onProgress?.(85);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourceFile, '-i', sepWav];
    if (hasVideo) {
      // ⚠️ 这里**不能**只写 `-shortest`。
      // AI 分离器（demucs）产出的伴奏比原片短几秒是常态，`-shortest` 会以
      // **较短的那条（音频）**为准结束封装 —— 结果 MV 的结尾被整段切掉。
      // 实测本机 7 个 .accomp.ts 全部比原片短 4.7~7.5 秒，用户切到伴唱后
      // 直接 EOF 被当成"唱完了"切歌。
      // 正确做法：先用 apad 把伴奏补成无限长（尾部补静音），再 -shortest
      // —— 这时最短的是**画面**，于是以画面为准截断，长度与原片一致。
      args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', 'apad', '-shortest');
    } else {
      args.push('-map', '1:a:0', '-vn');
    }
    if (path.extname(out) === '.mkv') args.push('-c:a', 'libmp3lame', '-b:a', '224k');
    args.push(tmp);
    r = await runFfmpeg(ffmpeg, args);
    if (!r.ok) throw new Error(`合并回原文件失败: ${r.error}`);

    await fsp.rename(tmp, out);
    markPlain(out);
    opts.onProgress?.(100);
    await cleanup();
    return { ok: true, output: out, hasVideo };
  } catch (e) {
    await cleanup();
    return { ok: false, error: e.message };
  }
}

/**
 * 统一入口：按模式分离。
 * @param {string} sourceFile
 * @param {{mode?:'off'|'instant'|'plugin', pluginPath?:string, ffmpegPath?:string, onProgress?:(p:number)=>void, force?:boolean, audioStream?:number}} [opts]
 */
async function separate(sourceFile, opts = {}) {
  const mode = opts.mode || 'off';
  if (mode === 'off') return { ok: false, error: '分离功能未启用', skipped: true };
  if (mode === 'plugin') return separateWithPlugin(sourceFile, opts);
  return separateInstant(sourceFile, opts);
}

module.exports = {
  separate,
  needsSeparate,
  probeDuration,
  existingAccompanimentUsable, separateInstant, separateWithPlugin,
  accompanimentPath, findAccompaniment, hasAccompaniment,
  probeFfmpeg, probeHasVideo, resolveFfmpeg,
  ACCOMP_SUFFIX, outExtFor,
};