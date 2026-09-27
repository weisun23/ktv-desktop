'use strict';
/**
 * 歌词服务测试
 *
 * 重点锁死一个踩过的坑：网易云同曲多版本里，个别版本的歌词被平台替换成 `**`
 * （实测《阴天》id=108640 是 "爱情究竟是精神**"，id=277775 才是完整的
 * "爱情究竟是精神鸦片"）。早期实现只取第一条候选，导致用户永远看到星号。
 */
const { LyricsService, cleanTitle, primarySinger, looksCensored, synthesizeWordsFromLrc } = require('../src/lyrics');
const os = require('os'), path = require('path'), fs = require('fs');

const results = [];
function check(n, ok, d = '') { results.push({ n, ok: !!ok, d }); console.log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + n + (d ? ' - ' + d : '')); }

(async () => {
  check('清理歌名修饰', cleanTitle('阴天(HD)') === '阴天' && cleanTitle('恋人(HD)') === '恋人',
    cleanTitle('阴天(HD)') + ' / ' + cleanTitle('无人之岛(DJ版)(HD)'));
  check('取第一个歌手', primarySinger('莫文蔚、李宗盛') === '莫文蔚', primarySinger('莫文蔚、李宗盛'));

  // ── 屏蔽判定（纯函数，不联网）──
  check('识别星号替换', looksCensored('[00:26.600]爱情究竟是精神**') === true);
  check('完整歌词不误判', looksCensored('[00:26.679]爱情究竟是精神鸦片') === false);
  check('单个星号不误判', looksCensored('[00:01.00]oh * yeah') === false);

  const synth = synthesizeWordsFromLrc('[00:01.00]晴天\n[00:03.00]故事的小黄花');
  check('LRC 没有逐字时自动合成逐字时间轴',
    synth.length === 2 && synth[0].words.length === 2 && synth[0].words[0].t === 1000 && synth[0].words[1].t === 2000,
    JSON.stringify(synth[0]));
  check('合成歌词最后一行有兜底时长', synth[1].duration === 5000, String(synth[1].duration));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-lyr-'));

  // ── 坏缓存要被清掉（否则用户升级后仍命中旧缓存，看起来像没修）──
  const badId = 'legacy-bad';
  fs.writeFileSync(path.join(dir, badId + '.lrc'), '[00:26.600]爱情究竟是精神**\n', 'utf8');
  const goodId = 'legacy-good';
  fs.writeFileSync(path.join(dir, goodId + '.lrc'), '[00:26.679]爱情究竟是精神鸦片\n', 'utf8');
  new LyricsService({ cacheDir: dir }).init();
  check('清掉被屏蔽的旧缓存', !fs.existsSync(path.join(dir, badId + '.lrc')));
  check('保留正常旧缓存', fs.existsSync(path.join(dir, goodId + '.lrc')));

  const svc = new LyricsService({ cacheDir: dir }).init();

  // ── 联网：必须挑到没有被星号替换的版本 ──
  const r1 = await svc.get({ id: 'test1', name: '阴天(HD)', singer: '莫文蔚' });
  check('联网取到歌词', r1.ok === true, r1.ok ? r1.lrc.length + ' 字符' : r1.error);
  if (r1.ok) {
    check('取到的是未被屏蔽的版本', r1.censored !== true && !looksCensored(r1.lrc));
    check('歌词里是完整的「精神鸦片」', r1.lrc.includes('精神鸦片'));
    check('LRC 含时间标签', /\[\d{2}:\d{2}/.test(r1.lrc));
  }
  check('写入缓存', fs.existsSync(path.join(dir, 'test1.lrc')));

  const r2 = await svc.get({ id: 'test1', name: '阴天(HD)', singer: '莫文蔚' });
  check('二次命中缓存', r2.ok && r2.cached === true);

  const r3 = await svc.get({ id: 'x', name: '这首歌肯定不存在zzzqqq123', singer: '无人' });
  check('搜不到时给出可读错误（不能拿别人的歌词）', r3.ok === false, r3.error);

  // 网易云的搜索是模糊的：乱搜它也会返回一堆无关结果。
  // 必须自己核对标题，否则用户会看到别人的歌词 —— 而且时间轴还是对的，极难发现。
  const { titleMatches } = require('../src/lyrics');
  check('标题匹配：曲库的 (HD)/(Live) 后缀不影响',
    titleMatches('阴天(HD)', '阴天') && titleMatches('阴天', '阴天 (Live)') && titleMatches('恋人(HD)', '恋人'));
  check('标题匹配：乱搜不会命中无关歌',
    !titleMatches('这首歌肯定不存在zzzqqq123', '存在') && !titleMatches('稻香', '稻香快乐'));
  check('标题匹配：同名不同版本仍然命中', titleMatches('告白气球', '告白气球 (Live)'));

  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x.ok);
  console.log('');
  if (failed.length) { console.log('歌词测试失败 ' + failed.length + '/' + results.length); process.exit(1); }
  console.log('歌词测试全部通过（' + results.length + ' 项）');
})();