'use strict';
const { createRequire } = require('module');
const koffi = createRequire(require.resolve('@ktv/player'))('koffi');
const playerMod = require('@ktv/player');
const vlc = require('@ktv/player/src/vlc-ffi');
const ktvApi = require('@ktv/ktv-api');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const r = await ktvApi.resolvePlayUrl({ musicNo: '7789715', filename: '7789715.ts' });
  const hwnd = playerMod.createHostWindow({ title: 'stats2', width: 800, height: 450 });
  const player = new playerMod.KtvPlayer();
  player.attachSurface(hwnd);
  player.load(r.url, { accomp: 2, isStream: true });
  player.play();
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (player.currentTime() > 300) break; await sleep(100); }
  await sleep(8000);

  // 直接调，看返回码
  const lib = koffi.load(require('path').join(vlc.resolveVlcDir(), 'libvlc.dll'));
  const Stats = koffi.struct('libvlc_media_stats_t', {
    i_read_bytes: 'int', f_input_bitrate: 'float', i_demux_read_bytes: 'int', f_demux_bitrate: 'float',
    i_demux_corrupted: 'int', i_demux_discontinuity: 'int', i_decoded_video: 'int', i_decoded_audio: 'int',
    i_displayed_pictures: 'int', i_lost_pictures: 'int', i_played_abuffers: 'int', i_lost_abuffers: 'int',
    i_sent_packets: 'int', i_sent_bytes: 'int', f_send_bitrate: 'float',
  });
  const getStats = lib.func('libvlc_media_player_get_stats', 'int',
    ['void *', koffi.out(koffi.pointer(Stats))]);
  const buf = Buffer.alloc(koffi.sizeof(Stats));
  const rc = getStats(player.mp, buf);
  console.log('sizeof(struct) =', koffi.sizeof(Stats));
  console.log('rc =', rc);
  if (rc === 0) {
    const st = koffi.decode(buf, Stats);
    console.log(JSON.stringify(st, null, 1));
  }
  player.dispose();
  playerMod.destroyHostWindow(hwnd);
})();
