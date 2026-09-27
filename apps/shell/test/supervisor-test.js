/**
 * 播放监管器测试（假播放器，不联网）
 * =================================
 * 验证：断流后重取地址并续播、重试上限、本地播放不介入、恢复中不重入。
 *
 * 用法: node test/supervisor-test.js
 */
'use strict';

const { PlaybackSupervisor, MAX_RETRIES } = require('../src/supervisor');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' - ' + detail : ''}`);
  return !!ok;
}

/** 假播放器：记录调用，可控 getStatus 返回值。 */
function makeFakePlayer() {
  return {
    calls: [],
    status: { time: 0, playing: true, stateName: 'Playing' },
    load(url, opts) { this.calls.push({ op: 'load', url, opts }); },
    play() { this.calls.push({ op: 'play' }); },
    seek(ms) { this.calls.push({ op: 'seek', ms }); },
    getStatus() { return this.status; },
  };
}

const onlineSong = { id: 's1', name: '测试歌', accomp: 2, playSource: 'online' };
const localSong = { id: 's2', name: '本地歌', accomp: 0, playSource: 'local' };

async function main() {
  // ── 1. 正常恢复并续播 ──
  {
    const player = makeFakePlayer();
    const notices = [];
    let resolveCalls = 0;
    const sup = new PlaybackSupervisor({
      player,
      resolveUrl: async () => { resolveCalls++; return { url: 'http://cdn/new.ts', provider: 'test', expiresAt: Date.now() + 3600_000 }; },
      notify: (n) => notices.push(n),
    });
    sup.setSong(onlineSong);
    sup.onStatus({ time: 42000 });          // 播到 42s
    player.status = { time: 300, playing: true, stateName: 'Playing' };  // 重载后从 0 开始

    await sup.onFailure('stalled');

    check('断流后重新取地址', resolveCalls === 1, `resolveUrl 调用 ${resolveCalls} 次`);
    check('重新载入新地址', player.calls.some((c) => c.op === 'load' && c.url === 'http://cdn/new.ts'));
    check('重新播放', player.calls.some((c) => c.op === 'play'));
    check('从断点续播', player.calls.some((c) => c.op === 'seek' && c.ms === 42000),
      JSON.stringify(player.calls.filter((c) => c.op === 'seek')));
    check('续播时带上 accomp', player.calls.find((c) => c.op === 'load')?.opts?.accomp === 2);
    check('提示用户已续播', notices.some((n) => n.kind === 'ok' && /续播/.test(n.text)), notices.map((n) => n.text).join(' | '));
  }

  // ── 2. 本地播放不介入 ──
  {
    const player = makeFakePlayer();
    let resolveCalls = 0;
    const sup = new PlaybackSupervisor({
      player, resolveUrl: async () => { resolveCalls++; return { url: 'x' }; }, notify: () => {},
    });
    sup.setSong(localSong);
    await sup.onFailure('libvlc-error');
    check('本地播放不触发重取', resolveCalls === 0 && player.calls.length === 0);
  }

  // ── 3. 重试上限 ──
  {
    const player = makeFakePlayer();
    const notices = [];
    let resolveCalls = 0;
    const sup = new PlaybackSupervisor({
      player,
      resolveUrl: async () => { resolveCalls++; throw new Error('接口挂了'); },
      notify: (n) => notices.push(n),
    });
    sup.setSong(onlineSong);
    for (let i = 0; i < 5; i++) await sup.onFailure('stalled');

    check('重试次数受上限约束', resolveCalls === MAX_RETRIES, `resolveUrl 调用 ${resolveCalls} 次（上限 ${MAX_RETRIES}）`);
    check('超限后告知用户', notices.some((n) => /重试 \d+ 次仍失败/.test(n.text)), notices.at(-1)?.text);
  }

  // ── 4. 恢复过程中不重入 ──
  {
    const player = makeFakePlayer();
    let resolveCalls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const sup = new PlaybackSupervisor({
      player,
      resolveUrl: async () => { resolveCalls++; await gate; return { url: 'http://cdn/x.ts' }; },
      notify: () => {},
    });
    sup.setSong(onlineSong);
    const first = sup.onFailure('stalled');
    await sup.onFailure('stalled');    // 恢复还没结束就再来一次
    release();
    await first;
    check('恢复中不重复取流', resolveCalls === 1, `resolveUrl 调用 ${resolveCalls} 次`);
  }

  // ── 5. 换歌重置重试计数 ──
  {
    const player = makeFakePlayer();
    let resolveCalls = 0;
    const sup = new PlaybackSupervisor({
      player, resolveUrl: async () => { resolveCalls++; throw new Error('x'); }, notify: () => {},
    });
    sup.setSong(onlineSong);
    await sup.onFailure('stalled');
    await sup.onFailure('stalled');
    const afterFirstSong = resolveCalls;
    sup.setSong({ ...onlineSong, id: 's9' });
    await sup.onFailure('stalled');
    check('换歌后重试计数重置', resolveCalls === afterFirstSong + 1,
      `第一首用了 ${afterFirstSong} 次，换歌后又用了 ${resolveCalls - afterFirstSong} 次`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length) {
    console.log(`监管器测试失败 ${failed.length}/${results.length} 项`);
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exit(1);
  }
  console.log(`监管器测试全部通过（${results.length} 项）`);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
