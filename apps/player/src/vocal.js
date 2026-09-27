/**
 * 原伴唱相关的纯函数
 * ==================
 * 这些函数不依赖任何播放内核（libVLC / mpv 都要用），
 * 单独放一个模块是为了让 mpv 后端不必加载 libVLC 的 FFI。
 */
'use strict';

/** 原唱/伴唱的名称启发式（片源命名不规范，仅作默认值，UI 可覆盖） */
const ORIGINAL_HINTS = ['原唱', 'original', 'vocal', 'lead'];
const ACCOMPANIMENT_HINTS = ['伴唱', '伴奏', 'accompaniment', 'instrumental', 'karaoke', 'music'];

function classifyTrackName(name) {
  const n = String(name || '').toLowerCase();
  if (ORIGINAL_HINTS.some((h) => n.includes(h))) return 'original';
  if (ACCOMPANIMENT_HINTS.some((h) => n.includes(h))) return 'accompaniment';
  return null;
}

/**
 * 曲库 songs.accomp 字段 -> 原伴唱声道映射。
 *
 * 老式 KTV 片源把原唱/伴唱放在左右两个声道，但**哪边是原唱并不统一**，
 * 曲库里用 accomp 标记：
 *   accomp = 1 -> 左声道=伴奏, 右声道=原唱
 *   accomp = 2 -> 左声道=原唱, 右声道=伴奏
 *   accomp <= 0 或缺失 -> 按常见惯例（左伴奏、右原唱）
 *
 * 映射搞反会直接导致"点伴唱出原唱"，所以这个字段必须从曲库一路传到播放器。
 */
function channelMapForAccomp(accomp) {
  return Number(accomp) === 2
    ? { original: 'left', accompaniment: 'right' }
    : { original: 'right', accompaniment: 'left' };
}

/**
 * 片源是否为 MPEG-TS。
 *
 * maidong 的 .ts 开头带非 TS 数据，libVLC 的格式探测会 lost sync 并回退到
 * ps 解复用器（花屏/纯黑），必须用实例级 --demux=ts 才能正常解码。
 * 抽成独立函数是为了能单测——正则写错会让整条播放链路静默花屏。
 */
function isTsSource(source) {
  return /\.ts(\?|$)/i.test(String(source || ''));
}

/**
 * 两音轨时判定「哪条是原唱」。
 * 依据 maidong 自己的实现（KtvVideoView.kt:273）：
 *   val targetTrack = if (original) audioTracks[0] else audioTracks[1]
 * 即**第一条原唱、第二条伴唱**。
 */
function resolveTrackMap(tracks) {
  let accompaniment = null;
  let original = null;
  for (const t of tracks) {
    const kind = classifyTrackName(t.name);
    if (kind === 'accompaniment' && accompaniment == null) accompaniment = t.id;
    if (kind === 'original' && original == null) original = t.id;
  }
  if (original == null) original = tracks[0]?.id ?? null;
  if (accompaniment == null) {
    accompaniment = (tracks.find((t) => t.id !== original) || tracks[1])?.id ?? null;
  }
  return { accompaniment, original };
}

module.exports = { classifyTrackName, channelMapForAccomp, isTsSource, resolveTrackMap,
  ORIGINAL_HINTS, ACCOMPANIMENT_HINTS };
