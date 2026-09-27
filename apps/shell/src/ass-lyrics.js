/**
 * 逐字歌词 -> ASS 卡拉OK字幕
 * ===========================
 * 为什么走 ASS 而不是 mpv 的 OSD：
 *
 *   mpv 的 `osd-msg1` **不支持** ASS 覆盖码 —— 实测 `{\b1}粗体{\b0}普通` 会原样显示，
 *   而 `{\c&H00FF00&}绿` 直接变成 "(broken escape sequences)"。
 *   而 **ASS 字幕**天生就是干这个的：`\k<厘秒>` 就是卡拉OK标签，
 *   样式里 PrimaryColour = 已唱色、SecondaryColour = 未唱色，播放器自己逐字扫过去。
 *
 * 实测（720x480 的 MV，mpv --wid 内嵌）：歌词按字变绿，效果正确。
 *
 * 生成的 .ass 落到歌词缓存目录，按曲目 id 命名，同一首歌不重复生成。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** ASS 时间：H:MM:SS.cc（厘秒） */
function assTime(ms) {
  const t = Math.max(0, Math.round(Number(ms) || 0));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * ASS 颜色是 &HAABBGGRR（注意是 **BGR** 顺序，不是 RGB）。
 * 绿色 (0,255,0) -> &H0000FF00
 */
function assColor(rgb, alpha = 0) {
  const [r, g, b] = rgb;
  const hx = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
  return `&H${hx(alpha)}${hx(b)}${hx(g)}${hx(r)}`;
}

/**
 * 合并默认值。
 * ⚠️ 不能用 `{ ...base, ...over }`：调用方写 `{ slideMs: undefined }` 时会把默认值
 * 冲成 undefined，接着 Math.round(undefined) = NaN —— 生成出来的 ASS 每条
 * 时间轴都是 0:00:00.00，画面上看起来"歌词在显示"，其实永远只显示第一句。
 */
function withDefaults(base, over) {
  const o = { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] !== undefined) o[k] = over[k];
  }
  return o;
}

const DEFAULT_OPTS = {
  fontName: 'Microsoft YaHei',
  fontSize: 52,
  /** 已唱（卡拉OK扫过之后）的颜色 */
  sungColor: [39, 204, 164],     // 和界面主色 --focus 一致
  /** 未唱的颜色 */
  unsungColor: [255, 255, 255],
  outlineColor: [0, 0, 0],
  marginV: 52,
  playResX: 1280,
  playResY: 720,
};

/**
 * 把 parseYrc 的结果编译成 ASS 文本。
 * @param {Array<{time:number,duration:number,words:Array<{t:number,d:number,text:string}>}>} lines
 * @param {object} [opts]
 * @returns {string}
 */
function buildAss(lines, opts = {}) {
  const o = withDefaults(DEFAULT_OPTS, opts);
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${o.playResX}`,
    `PlayResY: ${o.playResY}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,'
      + ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,'
      + ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment=2 底部居中；BorderStyle=1 描边+阴影，保证在亮画面上也看得清
    `Style: KTV,${o.fontName},${o.fontSize},${assColor(o.sungColor)},${assColor(o.unsungColor)},`
      + `${assColor(o.outlineColor)},&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,${o.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!L || !Array.isArray(L.words) || !L.words.length) continue;
    const next = lines[i + 1];
    const end = next && next.time > L.time ? next.time : L.time + (L.duration || 5000);
    let text = '';
    for (const w of L.words) {
      const cs = Math.max(1, Math.round((Number(w.d) || 0) / 10));
      // ASS 里 { } \ 都是控制字符，歌词正文要清掉，否则会破坏标签
      const clean = String(w.text == null ? '' : w.text).replace(/[{}\\]/g, '');
      if (!clean) continue;
      text += `{\\kf${cs}}${clean}`;
    }
    if (!text.trim()) continue;
    events.push(`Dialogue: 0,${assTime(L.time)},${assTime(end)},KTV,,0,0,0,,${text}`);
  }

  return head.concat(events).join('\n') + '\n';
}

/**
 * 生成（或复用）某首歌的 ASS 字幕文件，返回路径；没有歌词返回 null。
 * opts.style: 'rolling'（默认，居中滚动）| 'flat'（贴底单行，老样式）
 */
function writeAssFile(dir, key, lines, opts = {}) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const safe = String(key).replace(/[^\w-]/g, '_');
  const file = path.join(dir, safe + '.karaoke.ass');
  const text = opts.style === 'flat' ? buildAss(lines, opts) : buildRollingAss(lines, opts);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch { return null; }
  return file;
}


/**
 * 滚动歌词（默认样式）
 * ====================
 * 和上面的 `buildAss`（贴底、单行、不滚动）不同，这里是**画面居中 + 滚动过渡**：
 *
 *   1. 当前行从下方滑到中间（\move），换行时淡出；
 *   2. 下一行以暗色**预览**停在下方，轮到它时无缝滑上来接替；
 *   3. 逐字数据（yrc）仍然编译成 \kf 卡拉OK填充标签，跟着唱缓慢覆盖。
 *
 * ⚠️ 为什么滑入事件要从 `start - slide` 开始：
 *   ASS 的 \kf 是**相对事件起点**计时的。事件提前 slide 毫秒开始，
 *   卡拉OK就会整体提前 slide 毫秒 —— 用一段**前导空格**把这段时间吃掉
 *   （\k<slide> + 空格），既不影响观感，也不让时间轴偏移。
 *   这里错了会"歌词对不上嘴"，但画面看起来完全正常，极难发现。
 *
 * ⚠️ 一行要发 2 条事件（当前行 + 下一行预览），两条的位置/时间必须严丝合缝，
 *   否则会出现"重影"。
 */
const ROLLING_DEFAULTS = {
  ...DEFAULT_OPTS,
  fontSize: 46,
  lineGap: 1.5,
  slideMs: 260,
  nextColor: [150, 172, 196],
  position: 'center',   // center | bottom
};

/** 歌词正文：清掉 ASS 控制字符（{ } \），否则会破坏标签 */
function assEscape(text) {
  return String(text == null ? '' : text).replace(/[{}\\]/g, '');
}

/** 整行纯文本（没有逐字数据时用） */
function plainTextOf(line) {
  if (!line) return '';
  if (Array.isArray(line.words) && line.words.length) return assEscape(line.words.map((w) => w.text).join(''));
  return assEscape(line.text);
}

/** 一行歌词的正文：有逐字数据就编译成 \k 卡拉OK，否则纯文本 */
function bodyOf(line, leadMs) {
  if (!Array.isArray(line.words) || !line.words.length) return plainTextOf(line);
  let text = '';
  if (leadMs > 0) text += `{\\kf${Math.max(1, Math.round(leadMs / 10))}} `;
  for (const w of line.words) {
    const clean = assEscape(w.text);
    if (!clean) continue;
    text += `{\\kf${Math.max(1, Math.round((Number(w.d) || 0) / 10))}}${clean}`;
  }
  return text;
}

/**
 * 编译"居中滚动"歌词。
 * @param {Array<{time:number,duration?:number,words?:Array,text?:string}>} lines
 * @param {object} [opts]
 */
function buildRollingAss(lines, opts = {}) {
  const o = withDefaults(ROLLING_DEFAULTS, opts);
  const list = (Array.isArray(lines) ? lines : []).filter(Boolean);
  const slide = Math.max(0, Math.round(o.slideMs));
  const dy = Math.round(o.fontSize * o.lineGap);
  // KTV 双行：当前行靠左、下一行靠右，同一水平线上。
  const leftX = Math.round(o.playResX * 0.27);
  const rightX = Math.round(o.playResX * 0.73);
  const cy = o.position === 'bottom'
    ? Math.round(o.playResY - o.marginV - 18)
    : Math.round(o.playResY / 2);

  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${o.playResX}`,
    `PlayResY: ${o.playResY}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,'
      + ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,'
      + ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: KTV,${o.fontName},${o.fontSize},${assColor(o.sungColor)},${assColor(o.unsungColor)},`
      + `${assColor(o.outlineColor)},&H80000000,-1,0,0,0,100,100,0,0,1,3,1,5,40,40,${o.marginV},1`,
    `Style: KTVDim,${o.fontName},${Math.round(o.fontSize * 0.82)},${assColor(o.nextColor)},${assColor(o.nextColor)},`
      + `${assColor(o.outlineColor)},&H80000000,0,0,0,0,100,100,0,0,1,2,1,5,40,40,${o.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const ev = [];
  for (let i = 0; i < list.length; i++) {
    const L = list[i];
    const next = list[i + 1];
    const start = Math.max(0, Number(L.time) || 0);
    const end = next && Number(next.time) > start
      ? Number(next.time)
      : start + (Number(L.duration) || 5000);
    const inAt = Math.max(0, start - slide);
    // 当前行从下方滑到左侧；slide=0 时静态定位。
    const enter = slide > 0
      ? `{\\an5\\move(${leftX},${cy + dy},${leftX},${cy},0,${slide})\\fad(0,${slide})}`
      : `{\\an5\\pos(${leftX},${cy})}`;
    ev.push({
      at: inAt,
      text: `Dialogue: 0,${assTime(inAt)},${assTime(end)},KTV,,0,0,0,,` + enter + bodyOf(L, slide),
    });
    // 下一行预览固定靠右，和当前行形成 KTV 常见的左右双行。
    if (next) {
      const nt = plainTextOf(next);
      if (nt.trim()) {
        ev.push({
          at: start,
          text: `Dialogue: 0,${assTime(start)},${assTime(end)},KTVDim,,0,0,0,,`
            + `{\\an5\\pos(${rightX},${cy})}${nt}`,
        });
      }
    }
  }
  ev.sort((a, b) => a.at - b.at);
  return head.concat(ev.map((e) => e.text)).join('\n') + '\n';
}

module.exports = { buildAss, buildRollingAss, writeAssFile, assTime, assColor, assEscape, withDefaults, DEFAULT_OPTS, ROLLING_DEFAULTS };
