/**
 * 抽查多首歌的取流结果，统计"广告/错误地址"出现频率
 */
'use strict';
const ktvApi = require('@ktv/ktv-api');
const { looksLikeRequestedSong, isLikelyDemoUrl } = require('@ktv/ktv-api/src/providers/maidong');
const path = require('path');

(async () => {
  const cfg = ktvApi.loadConfig();
  if (!ktvApi.availableProviders(cfg).length) { console.log('未配置 provider'); process.exit(1); }

  // 用热歌榜前 8 首做抽查
  const cat = require(path.resolve(__dirname, '..', '..', '..', 'services', 'catalog', 'src', 'db.js'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.resolve(__dirname, '..', '..', '..', 'resources', 'catalog', 'muse.db'), { readOnly: true });
  const rows = db.prepare('SELECT name, filename FROM songs WHERE deleted_at IS NULL ORDER BY rec_score DESC, local_hot_score DESC, hot_score DESC LIMIT 8').all();

  let ok = 0, bad = 0;
  for (const r of rows) {
    const musicNo = String(r.filename).replace(/\.[^.]+$/, '');
    try {
      const res = await ktvApi.resolvePlayUrl({ musicNo, filename: r.filename, name: r.name });
      const good = looksLikeRequestedSong(res.url, musicNo);
      if (good) ok++; else bad++;
      console.log(`${good ? 'OK  ' : 'BAD '} ${r.name.padEnd(20)} musicNo=${musicNo.padEnd(9)} ls=${res.ls}  ${res.url.slice(0, 78)}`);
    } catch (e) {
      bad++;
      console.log(`FAIL ${r.name.padEnd(20)} musicNo=${musicNo.padEnd(9)} ${e.message.slice(0, 70)}`);
    }
  }
  console.log(`\n结果: 正常 ${ok} / 异常 ${bad}`);
  process.exit(0);
})();
