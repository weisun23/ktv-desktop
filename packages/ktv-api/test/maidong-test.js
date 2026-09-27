/**
 * 取流 provider 测试（本地 mock，不访问真实接口）
 * ==============================================
 * 验证：签名拼接、token 复用、demo 地址跳过、ls 回退、过期地址跳过、
 *       未配置时的报错、以及几个解析函数的边界。
 *
 * 用法: node test/maidong-test.js
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { MaidongProvider, isLikelyDemoUrl, looksLikeRequestedSong, parseExpiry, parseLooseJson } = require('../src/providers/maidong');

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

const APP_ID = 'test-app-id';
const APP_KEY = 'test-app-key';
const SDK_KEY = 'test-sdk-key';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  return !!ok;
}

/** 起一个 mock 服务，记录收到的请求，并按脚本返回。 */
function startMock(script) {
  const seen = { token: 0, song: [], badSign: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const params = url.search.slice(1);
    const givenSign = url.searchParams.get('sign');
    const base = params.replace(/&sign=[^&]*$/, '').replace(/sign=[^&]*&?/, '');

    if (url.pathname === '/i.php') {
      seen.token++;
      if (givenSign !== md5(base + APP_KEY)) { seen.badSign++; res.writeHead(403); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 200, token: 'tok-abc', msg: 'ok' }));
    }

    if (url.pathname === '/music/do.php') {
      const ls = Number(url.searchParams.get('ls'));
      seen.song.push(ls);
      if (givenSign !== md5(base + SDK_KEY)) { seen.badSign++; res.writeHead(403); return res.end('{}'); }
      const body = script(ls, url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // 模拟服务端在 JSON 前打印 PHP 警告
      return res.end('<br />\n<b>Deprecated</b>: something<br />\n' + body);
    }

    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

const futureHex = Math.floor((Date.now() + 3600_000) / 1000).toString(16);
const pastHex = Math.floor((Date.now() - 3600_000) / 1000).toString(16);

async function main() {
  // ── 解析函数 ──
  check('识别纯 IP 为 demo', isLikelyDemoUrl('http://1.2.3.4/a.ts') === true);
  check('识别 r2.dev 为 demo', isLikelyDemoUrl('https://pub-abc123.r2.dev/a.ts') === true);
  check('正常 CDN 不算 demo', isLikelyDemoUrl('http://download.origjoy.com/a.ts') === false);
  check('非法 URL 视为不可用', isLikelyDemoUrl('not a url') === true);

  // 广告片源识别（实测接口会返回 ad_files/my_ad_video.ts）
  check('识别广告地址', isLikelyDemoUrl('http://gz.ac16.vip/ad_files/my_ad_video.ts') === true);
  check('真片源不算广告',
    isLikelyDemoUrl('http://download.origjoy.com/E/ts/35.2/crf/480p/7789715.ts?sign=x') === false);

  // 关键判据：返回的地址必须真的对应所请求的曲目
  check('地址含 musicNo 判定为有效',
    looksLikeRequestedSong('http://cdn/E/ts/480p/7789715.ts?sign=x', '7789715') === true);
  check('广告地址不含 musicNo 判定为无效',
    looksLikeRequestedSong('http://gz.ac16.vip/ad_files/my_ad_video.ts', '7789715') === false);
  check('非法地址判定为无效', looksLikeRequestedSong('not a url', '7789715') === false);

  check('解析十六进制过期时间',
    Math.abs(parseExpiry(`http://x/a.ts?sign=1&t=${futureHex}`) - parseInt(futureHex, 16) * 1000) < 1);
  check('解析十进制过期时间',
    Math.abs(parseExpiry('http://x/a.ts?token=1&t=1784262398') - 1784262398000) < 1);
  check('无 t 参数返回 null', parseExpiry('http://x/a.ts') === null);

  check('容忍 JSON 前的 PHP 警告',
    parseLooseJson('<br /><b>Deprecated</b>: x<br />\n{"code":200,"data":"u"}')?.code === 200);

  // ── 未配置时报错清晰 ──
  const bare = new MaidongProvider({});
  check('未配置时 isConfigured=false', bare.isConfigured() === false);
  let msg = '';
  try { await bare.getPlayUrl('1'); } catch (e) { msg = e.message; }
  check('未配置时报错可读', /凭证未配置/.test(msg), msg.slice(0, 40));

  // ── 正常路径：ls=0 就是真源 ──
  {
    // mock 回显请求的 musicno，贴近真实行为
    const { server, seen, port } = await startMock((ls, params) =>
      JSON.stringify({
        code: 200,
        data: `http://cdn.example.net/E/ts/480p/${params.get('musicno')}.ts?sign=s&t=${futureHex}`,
        msg: 'SUCCESS',
      }));
    const p = new MaidongProvider({
      hosts: [`http://127.0.0.1:${port}`], appId: APP_ID, appKey: APP_KEY, sdkKey: SDK_KEY,
    });
    const r = await p.getPlayUrl('7789715');
    check('取得播放地址', r.url.includes('7789715'), r.url);
    check('签名全部正确', seen.badSign === 0);
    check('解析出过期时间', typeof r.expiresAt === 'number' && r.expiresAt > Date.now());
    check('ls 从 0 开始', seen.song[0] === 0, `尝试的 ls=${seen.song.join(',')}`);

    // token 复用
    const before = seen.token;
    await p.getPlayUrl('7789716');
    check('token 同 host 复用', seen.token === before, `token 请求次数=${seen.token}`);
    server.close();
  }

  // ── demo 地址应被跳过，继续试下一个 ls ──
  {
    const { server, seen, port } = await startMock((ls) => {
      if (ls === 0) return JSON.stringify({ code: 200, data: 'http://1.2.3.4/1.ts?t=' + futureHex });
      return JSON.stringify({ code: 200, data: `http://real.cdn.net/E/ts/480p/1.ts?sign=s&t=${futureHex}` });
    });
    const p = new MaidongProvider({
      hosts: [`http://127.0.0.1:${port}`], appId: APP_ID, appKey: APP_KEY, sdkKey: SDK_KEY,
    });
    const r = await p.getPlayUrl('1');
    check('跳过 demo 地址继续尝试', r.url.includes('real.cdn.net'), `ls 尝试序列=${seen.song.join(',')}`);
    server.close();
  }

  // ── 过期地址应被跳过 ──
  {
    const { server, port } = await startMock((ls) => JSON.stringify({
      code: 200, data: `http://cdn.net/E/ts/480p/1.ts?sign=s&t=${ls === 0 ? pastHex : futureHex}`,
    }));
    const p = new MaidongProvider({
      hosts: [`http://127.0.0.1:${port}`], appId: APP_ID, appKey: APP_KEY, sdkKey: SDK_KEY,
    });
    const r = await p.getPlayUrl('1');
    check('跳过已过期地址', r.ls === 1, `命中 ls=${r.ls}`);
    server.close();
  }

  // ── 广告地址应被跳过，继续试下一个 ls ──
  {
    const { server, seen, port } = await startMock((ls) => {
      if (ls === 0) {
        return JSON.stringify({ code: 200, data: 'http://gz.ac16.vip/ad_files/my_ad_video.ts' });
      }
      return JSON.stringify({ code: 200, data: `http://cdn.net/E/ts/480p/7789715.ts?sign=s&t=${futureHex}` });
    });
    const p = new MaidongProvider({
      hosts: [`http://127.0.0.1:${port}`], appId: APP_ID, appKey: APP_KEY, sdkKey: SDK_KEY,
    });
    const r = await p.getPlayUrl('7789715');
    check('跳过广告地址并取到真片源', r.url.includes('7789715'), `ls 序列=${seen.song.join(',')} url=${r.url}`);
    server.close();
  }

  // ── 全部返回 demo 时报错并重置设备 ──
  {
    const { server, port } = await startMock(() => JSON.stringify({ code: 200, data: 'http://1.2.3.4/7789715.ts' }));
    const p = new MaidongProvider({
      hosts: [`http://127.0.0.1:${port}`], appId: APP_ID, appKey: APP_KEY, sdkKey: SDK_KEY, maxAttempts: 3,
    });
    const macBefore = p.mac;
    let m = '';
    try { await p.getPlayUrl('1'); } catch (e) { m = e.message; }
    check('全是广告/占位地址时报错清晰', /广告|占位|demo/.test(m), m.slice(0, 46));
    check('失败后重置设备标识', p.mac !== macBefore);
    server.close();
  }

  // ── 多 host 回退 ──
  {
    const bad = http.createServer((_q, s) => { s.writeHead(500); s.end('{}'); });
    await new Promise((r) => bad.listen(0, '127.0.0.1', r));
    const { server, port } = await startMock(() =>
      JSON.stringify({ code: 200, data: `http://ok.cdn/E/ts/480p/1.ts?t=${futureHex}` }));
    const p = new MaidongProvider({
      hosts: [`http://127.0.0.1:${bad.address().port}`, `http://127.0.0.1:${port}`],
      appId: APP_ID, appKey: APP_KEY, sdkKey: SDK_KEY,
    });
    const r = await p.getPlayUrl('1');
    check('第一个 host 失败后回退到第二个', r.host.includes(String(port)), r.host);
    server.close(); bad.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`provider 测试失败 ${failed.length}/${results.length} 项`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
  console.log(`provider 测试全部通过（${results.length} 项）`);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
