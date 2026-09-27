/** 用 -vv 抓 libVLC 日志，确认解码器与视频输出模块 */
'use strict';
const path = require('path');
const { createRequire } = require('module');
const vlc = require('@ktv/player/src/vlc-ffi');
// koffi 装在 apps/player 下，从该包解析
const koffi = createRequire(require.resolve('@ktv/player'))('koffi');

const VLC_DIR = vlc.resolveVlcDir();
process.env.VLC_PLUGIN_PATH = path.join(VLC_DIR, 'plugins');
process.env.PATH = VLC_DIR + path.delimiter + process.env.PATH;

const lib = koffi.load(path.join(VLC_DIR, 'libvlc.dll'));
const newInst = lib.func('void *libvlc_new(int argc, const char **argv)');
const newMp = lib.func('void *libvlc_media_player_new(void *)');
const newPath = lib.func('void *libvlc_media_new_location(void *, const char *)');
const setMedia = lib.func('void libvlc_media_player_set_media(void *, void *)');
const play = lib.func('int libvlc_media_player_play(void *)');
const stop = lib.func('void libvlc_media_player_stop(void *)');

(async () => {
  const r = await require('@ktv/ktv-api').resolvePlayUrl({ musicNo: '7789715', filename: '7789715.ts' });
  const args = ['-vv', '--no-video-title-show', '--vout=direct3d11'];
  const inst = newInst(args.length, args);
  const mp = newMp(inst);
  setMedia(mp, newPath(inst, r.url));
  play(mp);
  setTimeout(() => { stop(mp); process.exit(0); }, 6000);
})();
