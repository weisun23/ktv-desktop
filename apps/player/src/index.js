'use strict';
/**
 * @ktv/player —— 播放层
 *
 * 两个内核，同一套接口：
 *   MpvPlayer   基于 mpv（ffmpeg 系，默认；maidong 的坏片源只有它扛得住，见 docs/16）
 *   KtvPlayer   基于 libVLC（老内核，保留作回退）
 * 上层统一用 createPlayer() 拿实例，不要直接 new 某个内核。
 */
module.exports = {
  ...require('./vlc-ffi'),
  ...require('./win32'),
  ...require('./player'),
  ...require('./vocal'),
  MpvPlayer: require('./mpv-player').MpvPlayer,
  MpvIpc: require('./mpv-player').MpvIpc,
  createPlayer: require('./mpv-player').createPlayer,
  resolveMpvPath: require('./mpv-player').resolveMpvPath,
};
