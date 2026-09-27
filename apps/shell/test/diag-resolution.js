'use strict';
const fs = require('fs');
const ktvApi = require('@ktv/ktv-api');
const { MaidongProvider } = require('@ktv/ktv-api/src/providers/maidong');
const { execFileSync } = require('child_process');

function decodeErrors(file) {
  try {
    const out = execFileSync('ffmpeg', ['-v', 'warning', '-i', file, '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return (out.match(/error while decoding|mmco:|co located|reference picture missing/gi) || []).length;
  } catch (e) {
    const s = String(e.stderr || '');
    return (s.match(/error while decoding|mmco:|co located|reference picture missing/gi) || []).length;
  }
}

(async () => {
  const cfg = ktvApi.loadConfig();
  for (const res of ['480', '720', '1080']) {
    const p = new MaidongProvider({ ...(cfg.maidong || {}), resolution: res });
    let url;
    try {
      const token = await p.getToken(p.config.hosts[0]);
      url = await p._fetchUrl(p.config.hosts[0], '7789715', token, 0);
    } catch (e) { console.log(`res=${res} 取流失败: ${e.message}`); continue; }
    if (!url) { console.log(`res=${res} 无地址`); continue; }
    const seg = String(url).split('/').slice(-2).join('/').split('?')[0];
    const file = `.tmp-diag/r${res}.ts`;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    fs.writeFileSync(file, buf);
    const errs = decodeErrors(file);
    console.log(`res=${res}  URL段=${seg}  大小=${(buf.length / 1048576).toFixed(1)}MB  首字节=0x${buf[0].toString(16)}  解码错误=${errs}`);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });