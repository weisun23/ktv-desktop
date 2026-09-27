'use strict';
/**
 * 同曲对照：MWS 授权前 vs 授权后
 * 比：CDN 主机、文件大小、坏包数、解码错误数、可播帧率
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ktvApi = require('@ktv/ktv-api');
const { MaidongProvider } = require('@ktv/ktv-api/src/providers/maidong');

const MUSICNO = process.argv[2] || '7789715';
const DIR = '.tmp-diag';

function ffmpegStats(file) {
  // 用 spawnSync：ffmpeg 的告警都走 stderr，成功退出时 execFileSync 的返回值是 null
  const r = spawnSync('ffmpeg', ['-v', 'warning', '-i', file, '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = String((r && r.stderr) || '');
  const decodeErrors = (out.match(/error while decoding|mmco:|co located|reference picture missing/gi) || []).length;
  const corrupt = (out.match(/Packet corrupt/gi) || []).length;
  return { decodeErrors, corrupt };
}

async function fetchOne(label, useMws) {
  const cfg = ktvApi.loadConfig();
  const conf = { ...(cfg.maidong || {}) };
  if (!useMws) { delete conf.mws; delete conf.rsaPubKey; }
  const p = new MaidongProvider(conf);
  const t0 = Date.now();
  if (useMws) await p.mwsLogin();
  const r = await p.getPlayUrl(MUSICNO);
  const took = Date.now() - t0;
  const file = path.join(DIR, `${useMws ? 'mws' : 'nomws'}.ts`);
  const buf = Buffer.from(await (await fetch(r.url)).arrayBuffer());
  fs.writeFileSync(file, buf);
  const stats = ffmpegStats(file);
  let host = '?';
  try { host = new URL(r.url).hostname; } catch { /* 忽略 */ }
  console.log(`\n[${label}]`);
  console.log(`  device    : ${p.mac}${useMws ? '  (sn=mac)' : ''}`);
  console.log(`  CDN 主机  : ${host}   ls=${r.ls}   取流 ${took}ms`);
  console.log(`  路径      : ${String(r.url).split('?')[0].split('/').slice(-6).join('/')}`);
  console.log(`  大小      : ${(buf.length / 1048576).toFixed(1)} MB   首字节=0x${buf[0].toString(16)}`);
  console.log(`  坏包      : ${stats.corrupt}   解码错误: ${stats.decodeErrors}`);
  return { host, size: buf.length, ...stats };
}

(async () => {
  const a = await fetchOne('未授权（随机设备）', false);
  const b = await fetchOne('MWS 授权后', true);
  console.log('\n=== 结论 ===');
  console.log(`主机 ${a.host} → ${b.host}   ${a.host === b.host ? '（同一个）' : '（不同）'}`);
  console.log(`大小 ${(a.size/1048576).toFixed(1)}MB → ${(b.size/1048576).toFixed(1)}MB`);
  console.log(`坏包 ${a.corrupt} → ${b.corrupt}`);
  console.log(`解码错误 ${a.decodeErrors} → ${b.decodeErrors}`);
  console.log(b.decodeErrors < a.decodeErrors ? '✅ 授权后更干净' : b.decodeErrors > a.decodeErrors ? '❌ 授权后更差' : '➖ 一样');
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });