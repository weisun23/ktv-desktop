/**
 * 片源修复：重建时间戳 / 重编码
 * =============================
 * maidong 的 .ts 片源普遍带损坏包——ffmpeg 解它时会报一堆
 * `PES packet size mismatch` / `Packet corrupt`，文件开头还有 136 字节非 TS 数据。
 * 实测这一个文件（《Angel》7789715.ts）里就有 **70 个损坏包，均匀分布在全片**，
 * 平均每 3.5 秒一个。
 *
 * 它会造成两个**不同**的问题，必须分开处理：
 *
 *   1. 卡顿：损坏的时间戳让解复用器反复"不连续→丢帧重同步"
 *      实测 显示 16.9~20.6fps / 丢帧 5~15 / 不连续 4~13
 *   2. 马赛克：H.264 码流里的坏宏块（82 处解码错误）
 *
 * 对应两种修复：
 *
 *   remux      `-c copy` 重建 PTS/DTS，不解码不重编码，约 3 秒，无损
 *              → 修卡顿（不连续 0、丢帧 0、29.7fps），但坏宏块原样保留
 *   transcode  `-c:v libx264` 重编码视频，约 9 秒，画质损失极小
 *              → 同时修卡顿和马赛克（解码错误 82 → 0）
 *                原理：解码器对坏宏块做"错误掩盖"（用参考帧补），重编码把这个
 *                掩盖结果固化下来，产出的码流就是干净的
 *
 * 两种模式都保留全部流（视频 + 原唱/伴唱两条音轨），产物校验通过才原子替换，
 * 失败一律保留原文件。
 *
 * "是否需要修"分两套判断：
 *   remux     文件自描述——干净的 TS 首字节一定是同步字节 0x47，损坏的是 0x0d/0x62
 *   transcode 光看容器分不出"转码过的"和"干净但含坏宏块的"，所以用标记文件
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { resolveFfmpeg, probeFfmpeg } = require('./separator');

const REPAIR_SUFFIX = '.repair.ts';
const BAK_SUFFIX = '.orig';
const MARK_DIR = 'repair-marks';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const MODES = ['remux', 'transcode'];
/**
 * 归一化修复模式。
 *
 * ⚠️ 这里**必须保留 'off'**。原来的写法是
 *     return MODES.includes(m) ? m : 'remux';
 * 结果 'off' 不在 MODES 里，被当成非法值兜底成了 'remux' ——
 * **"不修"这个选项从来没生效过**，每次启动都在偷偷重封装，
 * 而设置页上明明写着"不修"。
 *
 * 现在：非法/缺省一律当 'off'。修复是"会改变片源"的操作，宁可不动。
 */
function normMode(m) {
  if (m === 'off') return 'off';
  return MODES.includes(m) ? m : 'off';
}

/** 文件是不是"已经干净的 TS"（首字节是同步字节 0x47）。 */
function isCleanTs(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const b = Buffer.alloc(1);
      const n = fs.readSync(fd, b, 0, 1, 0);
      return n === 1 && b[0] === 0x47;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

// ── 修复标记 ──────────────────────────────────────────────────────
// 放在子目录里，这样不会被 downloads.stats() 当成缓存文件统计进去。
function markPath(filePath, mode) {
  return path.join(path.dirname(filePath), MARK_DIR, path.basename(filePath) + '.' + mode);
}
function isMarked(filePath, mode) {
  try { return fs.statSync(markPath(filePath, mode)).isFile(); } catch { return false; }
}
/**
 * 清掉某个文件的所有修复标记。
 * 缓存文件被删掉重下时**必须**调用：否则残留的标记会让新下回来的
 * 原始损坏文件被当成『已修复』而跳过修复，重新下载后照样卡、照样有马赛克。
 */
function clearMarks(filePath) {
  for (const m of MODES) {
    try { fs.rmSync(markPath(filePath, m), { force: true }); } catch { /* 忽略 */ }
  }
}

function markDone(filePath, mode) {
  try {
    const mp = markPath(filePath, mode);
    fs.mkdirSync(path.dirname(mp), { recursive: true });
    fs.writeFileSync(mp, new Date().toISOString(), 'utf8');
  } catch { /* 标记写不了不影响文件本身 */ }
}

/**
 * 是否需要修复。
 * @param {string} filePath
 * @param {'remux'|'transcode'} [mode]
 */
function needsRepair(filePath, mode) {
  const m = normMode(mode);
  if (m === 'off') return false;
  if (!/\.ts$/i.test(String(filePath || ''))) return false;
  let st;
  try { st = fs.statSync(filePath); } catch { return false; }
  if (!st.isFile()) return false;
  // 小于一个 TS 包（188 字节）的只可能是半成品，交给下载器重下，别喂给 ffmpeg
  if (st.size < 188) return false;
  if (isMarked(filePath, m)) return false;
  if (m === 'transcode') return true;   // 转码模式：没转过的都要转（含已 remux 的）
  return !isCleanTs(filePath);          // remux 模式：首字节自描述
}

function runFfmpeg(ffmpeg, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } }, timeoutMs);
    p.stderr.on('data', (d) => { if (err.length < 8000) err += d.toString(); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      const tail = err.trim().split('\n').slice(-2).join(' ').slice(0, 240);
      resolve({ ok: false, error: `ffmpeg exit ${code}${tail ? ': ' + tail : ''}` });
    });
  });
}

/**
 * 修复一个 .ts 片源。
 *
 * 不需要修复时返回 `{ ok: true, skipped: true }`；
 * 失败时保留原文件并返回 `{ ok: false }`，绝不让播放变得更糟。
 *
 * @param {string} filePath
 * @param {{mode?:'remux'|'transcode', ffmpegPath?:string, timeoutMs?:number}} [opts]
 */
async function repairTsFile(filePath, opts = {}) {
  const mode = normMode(opts.mode);
  if (!needsRepair(filePath, mode)) return { ok: true, skipped: true };

  const ffmpeg = opts.ffmpegPath || resolveFfmpeg();
  const probe = await probeFfmpeg(ffmpeg);
  if (!probe.ok) return { ok: false, error: `ffmpeg 不可用: ${probe.detail}` };

  const tmp = filePath + REPAIR_SUFFIX;
  const bak = filePath + BAK_SUFFIX;
  try { await fsp.rm(tmp, { force: true }); } catch { /* 忽略 */ }

  const args = ['-y', '-v', 'error', '-fflags', '+genpts', '-i', filePath, '-map', '0'];
  if (mode === 'transcode') {
    // ⚠️ 音频必须**重编码**，不能 -c:a copy。
    // 实测：源文件音频本身没问题（连续播 130s 零丢块），但 `-c:a copy` 会把
    // 它那些损坏的时间戳原样搬过去，播放约 100 秒后音频输出开始疯狂丢块
    // （i_lost_abuffers 一路涨到 1258）直到完全没声音。
    // 重编码音频会让时间戳按采样数重新生成，从根本上消除这个漂移。
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'mp2', '-b:a', '224k', '-ac', '2');
  } else {
    // remux 只是重建容器时间戳，不动码流。注意它修不了音频漂移，
    // 所以默认用的是 transcode（见 state.js 的 repairMode 说明）。
    args.push('-c', 'copy');
  }
  args.push('-avoid_negative_ts', 'make_zero', tmp);

  const r = await runFfmpeg(ffmpeg, args, opts.timeoutMs);
  if (!r.ok) { try { await fsp.rm(tmp, { force: true }); } catch { /* 忽略 */ } return r; }

  // 产物校验：必须是合法 TS，否则宁可保留原文件
  if (!isCleanTs(tmp)) {
    try { await fsp.rm(tmp, { force: true }); } catch { /* 忽略 */ }
    return { ok: false, error: '修复产物不是有效 TS' };
  }

  // 原子替换：原文件先挪开 → 修复产物顶上 → 删备份
  try {
    await fsp.rm(bak, { force: true });
    await fsp.rename(filePath, bak);
    await fsp.rename(tmp, filePath);
    await fsp.rm(bak, { force: true });
    markDone(filePath, mode);
    return { ok: true, repaired: true, mode };
  } catch (e) {
    try { if (!fs.existsSync(filePath) && fs.existsSync(bak)) await fsp.rename(bak, filePath); } catch { /* 忽略 */ }
    return { ok: false, error: `替换失败: ${e.message}` };
  }
}

/** 批量修复目录下的 .ts（顺序执行，避免多路 ffmpeg 抢 CPU）。 */
async function repairDir(dir, opts = {}) {
  const mode = normMode(opts.mode);
  let names;
  try { names = fs.readdirSync(dir); } catch { return { repaired: 0, failed: 0, skipped: 0 }; }
  let repaired = 0, failed = 0, skipped = 0;
  for (const n of names) {
    if (!/\.ts$/i.test(n)) continue;
    const full = path.join(dir, n);
    if (!needsRepair(full, mode)) { skipped++; continue; }
    const r = await repairTsFile(full, { ...opts, mode });
    if (r.ok && r.repaired) repaired++;
    else if (!r.ok) failed++;
    else skipped++;
  }
  return { repaired, failed, skipped };
}

/**
 * 清理上次异常退出留下的修复中间文件。
 *
 * ⚠️ `.orig` 不能直接删！修复是『原文件改名成 .orig → 修复产物顶上』两步，
 * 如果在两步之间进程被杀，原文件就只剩 .orig 这一份。此时必须**还原**，
 * 删掉等于把用户的缓存直接丢了（这个坑踩过一次，丢过两个缓存文件）。
 */
function cleanupRepairTemp(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const full = path.join(dir, n);
    if (n.endsWith(REPAIR_SUFFIX)) {
      // 未完成的修复产物，没有价值，删掉重来
      try { fs.rmSync(full, { force: true }); } catch { /* 忽略 */ }
    } else if (n.endsWith(BAK_SUFFIX)) {
      const orig = path.join(dir, n.slice(0, -BAK_SUFFIX.length));
      try {
        if (!fs.existsSync(orig)) fs.renameSync(full, orig);   // 还原，不是删！
        else fs.rmSync(full, { force: true });                  // 替换已完成，备份是多余的
      } catch { /* 忽略 */ }
    }
  }
}

module.exports = {
  repairTsFile, repairDir, needsRepair, isCleanTs, cleanupRepairTemp, clearMarks,
  REPAIR_SUFFIX, MARK_DIR, MODES, normMode,
};