/**
 * libVLC 底层 FFI 绑定（koffi）
 * ============================
 * 只暴露本项目需要的那部分 C API。刻意保持"薄"：这一层是唯一与 libVLC 耦合的地方，
 * 将来若要换成 Rust/Tauri，只需替换本文件，上层逻辑不动。
 *
 * 与 Android 端 IJK 的能力对应关系：
 *   libvlc_audio_set_track   <-> IjkMediaPlayer.selectAudioTrack
 *   libvlc_audio_set_channel <-> IjkMediaPlayer.seletcAudioChannel
 */
'use strict';

const fs = require('fs');
const path = require('path');
const koffi = require('koffi');

/** 仓库根目录（apps/player/src -> ../../..） */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** 允许用 KTV_VLC_DIR 覆盖 libVLC 位置（打包后指向 resources 内的相对路径）。 */
function resolveVlcDir() {
  const candidates = [
    process.env.KTV_VLC_DIR,
    path.join(REPO_ROOT, 'resources', 'runtime', 'vlc', 'vlc-3.0.21'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'libvlc.dll'))) return dir;
  }
  throw new Error(
    '找不到 libvlc.dll。请先执行 poc/player/fetch-vlc.ps1，或用 KTV_VLC_DIR 指定目录。\n' +
    '已尝试: ' + candidates.join(', ')
  );
}

// ── libvlc 枚举值（对应 vlc/libvlc.h） ─────────────────────────────
const State = Object.freeze({
  NothingSpecial: 0, Opening: 1, Buffering: 2, Playing: 3,
  Paused: 4, Stopped: 5, Ended: 6, Error: 7,
});
const StateName = Object.freeze(Object.fromEntries(Object.entries(State).map(([k, v]) => [v, k])));

const AudioChannel = Object.freeze({
  Error: -1, Stereo: 1, RStereo: 2, Left: 3, Right: 4, Dolbys: 5,
});
const AudioChannelName = Object.freeze(Object.fromEntries(Object.entries(AudioChannel).map(([k, v]) => [v, k])));

// ── 结构体：libvlc_track_description_t（单向链表） ──────────────────
// C 定义：
//   typedef struct libvlc_track_description_t {
//       int    i_id;
//       char  *psz_name;
//       struct libvlc_track_description_t *p_next;
//   } libvlc_track_description_t;
// koffi 不支持结构体自引用，p_next 用 void* 表示（x64 下布局一致，24 字节）。
const TrackDescription = koffi.struct('libvlc_track_description_t', {
  i_id: 'int',
  psz_name: 'char *',
  p_next: 'void *',
});

// 注意：结构体成员声明为 'char *' 时，koffi 会自动把它解码成 JS 字符串，
// 因此 psz_name 拿到的已经是 string，不需要再 decode。

let _lib = null;
let _dir = null;
const _fn = new Map();

function lib() {
  if (_lib) return _lib;
  _dir = resolveVlcDir();
  // libvlc 需要同目录的 libvlccore.dll，插件目录通过环境变量告知
  process.env.VLC_PLUGIN_PATH = path.join(_dir, 'plugins');
  process.env.PATH = _dir + path.delimiter + process.env.PATH;
  _lib = koffi.load(path.join(_dir, 'libvlc.dll'));
  return _lib;
}

/** 声明并缓存一个 C 函数（签名字符串形式）。 */
function fn(signature) {
  if (_fn.has(signature)) return _fn.get(signature);
  const f = lib().func(signature);
  _fn.set(signature, f);
  return f;
}

/** 声明并缓存一个 C 函数（显式形式，可表达 koffi.out 输出参数）。 */
function fnEx(name, ret, args) {
  // 用函数名作缓存键：koffi.out() 返回的是对象，无法安全地参与字符串拼接
  const key = 'ex:' + name;
  if (_fn.has(key)) return _fn.get(key);
  const f = lib().func(name, ret, args);
  _fn.set(key, f);
  return f;
}

// ── 实例 ──────────────────────────────────────────────────────────
function getVersion() {
  return fn('const char *libvlc_get_version()')();
}

function newInstance(extraArgs = []) {
  const args = [
    '--quiet', '--no-video-title-show', '--no-osd', '--no-snapshot-preview', '--stats',
    '--file-caching=1000', '--network-caching=1500',
    ...extraArgs,
  ];
  const inst = fn('void *libvlc_new(int argc, const char **argv)')(args.length, args);
  if (!inst) throw new Error('libvlc_new 返回 null，启动参数可能非法');
  return inst;
}

function releaseInstance(inst) {
  if (inst) fn('void libvlc_release(void *p_instance)')(inst);
}

// ── 媒体 ──────────────────────────────────────────────────────────
function newMediaPath(inst, filePath) {
  const m = fn('void *libvlc_media_new_path(void *p_instance, const char *path)')(inst, filePath);
  if (!m) throw new Error('libvlc_media_new_path 失败: ' + filePath);
  return m;
}

/** 用 URL（http/https）建媒体对象。在线取流走这条路径。 */
/**
 * 给单个媒体加选项（`:key=value`）。
 * 用它而不是全局 --demux，避免影响其它格式的片源。
 */
function addMediaOption(media, option) {
  fn('void libvlc_media_add_option(void *p_md, const char *psz_option)')(media, option);
}
function newMediaLocation(inst, url) {
  const m = fn('void *libvlc_media_new_location(void *p_instance, const char *path)')(inst, url);
  if (!m) throw new Error('libvlc_media_new_location 失败: ' + url);
  return m;
}

function releaseMedia(media) {
  if (media) fn('void libvlc_media_release(void *p_md)')(media);
}

// ── 播放器 ────────────────────────────────────────────────────────
function newMediaPlayer(inst) {
  const mp = fn('void *libvlc_media_player_new(void *p_libvlc_instance_t)')(inst);
  if (!mp) throw new Error('libvlc_media_player_new 失败');
  return mp;
}

function releaseMediaPlayer(mp) {
  if (mp) fn('void libvlc_media_player_release(void *p_mi)')(mp);
}

function setMedia(mp, media) {
  return fn('void libvlc_media_player_set_media(void *p_mi, void *p_md)')(mp, media);
}

/** 把视频渲染到指定 HWND（Windows）。传 null 可解除绑定。 */
function setHwnd(mp, hwnd) {
  return fn('void libvlc_media_player_set_hwnd(void *p_mi, void *drawable)')(mp, hwnd);
}

function play(mp) { return fn('int libvlc_media_player_play(void *p_mi)')(mp); }
function stop(mp) { return fn('void libvlc_media_player_stop(void *p_mi)')(mp); }
function pause(mp) { return fn('void libvlc_media_player_pause(void *p_mi)')(mp); }
function isPlaying(mp) { return fn('int libvlc_media_player_is_playing(void *p_mi)')(mp) !== 0; }
function getState(mp) { return fn('int libvlc_media_player_get_state(void *p_mi)')(mp); }
function getStateName(mp) { return StateName[getState(mp)] ?? 'Unknown'; }

function getTime(mp) { return Number(fn('int64_t libvlc_media_player_get_time(void *p_mi)')(mp)); }
function setTime(mp, ms) { return fn('void libvlc_media_player_set_time(void *p_mi, int64_t i_time)')(mp, BigInt(Math.max(0, Math.round(ms)))); }
function getLength(mp) { return Number(fn('int64_t libvlc_media_player_get_length(void *p_mi)')(mp)); }
function hasVout(mp) { return fn('int libvlc_media_player_has_vout(void *p_mi)')(mp) > 0; }
function getVideoSize(mp) {
  const w = [0], h = [0];
  fnEx('libvlc_video_get_size', 'int',
    ['void *', 'uint32', koffi.out(koffi.pointer('uint32')), koffi.out(koffi.pointer('uint32'))]
  )(mp, 0, w, h);
  return { width: w[0], height: h[0] };
}

// ── 音频：音轨（新式 KTV：原唱/伴唱各一条轨） ──────────────────────
function getTrackCount(mp) {
  return fn('int libvlc_audio_get_track_count(void *p_mi)')(mp);
}

/** 返回 [{ id, name }]，已过滤掉 id<0 的 "Disable" 项。 */
function getTracks(mp) {
  const head = fn('void *libvlc_audio_get_track_description(void *p_mi)')(mp);
  if (!head) return [];
  const out = [];
  try {
    let node = head;
    const guard = 64; // 防御性上限，避免链表异常时死循环
    for (let i = 0; i < guard && node; i++) {
      const desc = koffi.decode(node, TrackDescription);
      if (desc.i_id >= 0) {
        out.push({ id: desc.i_id, name: desc.psz_name || '' });
      }
      node = desc.p_next;
    }
  } finally {
    fn('void libvlc_track_description_list_release(void *p_track_description)')(head);
  }
  return out;
}

function getTrack(mp) { return fn('int libvlc_audio_get_track(void *p_mi)')(mp); }
function setTrack(mp, id) { return fn('int libvlc_audio_set_track(void *p_mi, int i_track)')(mp, id); }

// ── 音频：声道（老式 KTV：左伴唱 / 右原唱） ────────────────────────
function getChannel(mp) { return fn('int libvlc_audio_get_channel(void *p_mi)')(mp); }
function setChannel(mp, ch) { return fn('int libvlc_audio_set_channel(void *p_mi, int channel)')(mp, ch); }

// ── 播放统计（诊断卡顿用） ──
// C 定义：typedef struct libvlc_media_stats_t { ... } —— 字段顺序不能错
const MediaStats = koffi.struct("libvlc_media_stats_t", {
  i_read_bytes: 'int',
  f_input_bitrate: 'float',
  i_demux_read_bytes: 'int',
  f_demux_bitrate: 'float',
  i_demux_corrupted: 'int',
  i_demux_discontinuity: 'int',
  i_decoded_video: 'int',
  i_decoded_audio: 'int',
  i_displayed_pictures: 'int',
  i_lost_pictures: 'int',
  i_played_abuffers: 'int',
  i_lost_abuffers: 'int',
  i_sent_packets: 'int',
  i_sent_bytes: 'int',
  f_send_bitrate: 'float',
});

/**
 * 读取播放统计。
 * 最有用的两个：i_lost_pictures（丢帧，卡顿的硬证据）、i_demux_corrupted（数据损坏）。
 * 注意：需要在实例启动参数里带 --stats，否则返回全 0。
 */
function getStats(media) {
  try {
    // koffi 的 out 参数用"单元素数组"接收，它会把解码后的结构体写进 out[0]
    const out = [null];
    const rc = fnEx("libvlc_media_get_stats", "int",
      ["void *", koffi.out(koffi.pointer(MediaStats))])(media, out);
    // ⚠️ 这个接口返回 bool（1=成功、0=失败），不是错误码。
    // 之前写成 `if (rc !== 0) return null` 等于把成功当失败，stats 永远是 null。
    if (!rc) return null;
    return out[0];
  } catch {
    return null;
  }
}

// ── 音量 ──────────────────────────────────────────────────────────
/**
 * 视频内嵌文字（marquee）。
 *
 * 为什么需要：视频是原生子窗口、永远盖在 HTML 之上，所以 HTML 歌词**不可能**
 * 叠到画面上。libVLC 自带的 marquee 会把文字直接画进视频输出，是唯一可行的路子。
 *
 * 选项编号来自 libvlc_video_marquee_option_t（顺序不能改）。
 */
const Marquee = { Enable: 0, Text: 1, Color: 2, Opacity: 3, Position: 4, Refresh: 5, Size: 6, Timeout: 7, X: 8, Y: 9 };

function setMarqueeInt(mp, option, value) {
  return fn('void libvlc_video_set_marquee_int(void *p_mi, uint32 option, int i_val)')(mp, option, value);
}
function setMarqueeString(mp, option, text) {
  return fn('void libvlc_video_set_marquee_string(void *p_mi, uint32 option, const char *psz_text)')(mp, option, text);
}

function getVolume(mp) { return fn('int libvlc_audio_get_volume(void *p_mi)')(mp); }
function setVolume(mp, v) { return fn('int libvlc_audio_set_volume(void *p_mi, int i_volume)')(mp, Math.max(0, Math.min(200, Math.round(v)))); }

module.exports = {
  REPO_ROOT, resolveVlcDir,
  State, StateName, AudioChannel, AudioChannelName,
  getVersion, newInstance, releaseInstance,
  newMediaPath, newMediaLocation, releaseMedia,
  newMediaPlayer, releaseMediaPlayer, setMedia, setHwnd, addMediaOption,
  play, stop, pause, isPlaying, getState, getStateName,
  getTime, setTime, getLength, hasVout, getVideoSize,
  getTrackCount, getTracks, getTrack, setTrack,
  getChannel, setChannel,
  getVolume, setVolume, getStats, setMarqueeInt, setMarqueeString, Marquee,
};
