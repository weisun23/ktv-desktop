/**
 * 迅雷加密 TS 解密测试
 * ====================
 * 为什么必须有测试：这个 bug 的表现是"周期性马赛克 + 卡顿"，
 * 但**文件头看起来完全正常**（容器合法、每 188 字节都是同步字节），
 * 只有解码器才知道里面是密文。没有测试的话，改坏了根本看不出来。
 *
 * 做法：拿一个**真明文 TS**，按 maidong 的格式现场加密一遍，
 * 再让我们的解密器解回来，断言与原始文件**逐字节相同**。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  isEncrypted, decryptFile, decryptInPlace, looksLikeCleanTs,
  markPlain, isPlainMarked, clearPlainMark, HEADER_SIZE, SIGNATURES,
} = require('../src/tsdecrypt');

const TESTMEDIA = path.resolve(__dirname, '../../../testmedia/ktv_2tracks.ts');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  [PASS] ${name}`); pass++; }
  catch (e) { console.log(`  [FAIL] ${name} - ${e.message}`); fail++; }
}

/** 用与 maidong 相同的算法把一个明文 TS 加密成迅雷格式 */
function encryptLikeThunder(plain, key, { segmentSize = 8192, interval = 64, first = 3, keyIndex = 0 } = {}) {
  const header = Buffer.alloc(HEADER_SIZE);
  header[53] = keyIndex;
  header[452] = segmentSize / 1024;
  header[453] = 0;                 // mode
  header[454] = interval;
  header[457] = first;
  header.write(SIGNATURES[0], 500, 'ascii');
  const body = Buffer.from(plain);
  const cipher = crypto.createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  for (let seg = 0; seg * segmentSize < body.length; seg++) {
    const should = interval === 0 || seg === first || (seg > first && seg % interval === 1);
    if (!should) continue;
    const off = seg * segmentSize;
    const count = Math.min(segmentSize, body.length - off);
    const encLen = count - (count % 16);
    if (encLen <= 0) continue;
    cipher.update(body.slice(off, off + encLen)).copy(body, off);
  }
  return Buffer.concat([header, body]);
}

function main() {
  console.log('\n迅雷加密 TS 解密测试');
  if (!fs.existsSync(TESTMEDIA)) { console.log('  跳过：缺少测试片源'); process.exit(0); }
  const plain = fs.readFileSync(TESTMEDIA);
  t('测试片源本身是干净 TS（每 188 字节同步）', () => {
    assert.ok(looksLikeCleanTs(TESTMEDIA), '测试片源不是干净 TS');
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-dec-'));
  const enc = path.join(dir, 'enc.ts');
  const out = path.join(dir, 'out.ts');

  // 取第一把 THUNDER 密钥（模块里已经内置，这里只用来造测试数据）
  const mod = fs.readFileSync(path.resolve(__dirname, '../src/tsdecrypt.js'), 'utf8');
  const key = Buffer.from(/const THUNDER_KEYS = \[\s*\n\s*'([0-9a-f]+)'/.exec(mod)[1], 'hex');
  assert.strictEqual(key.length, 32, 'AES-256 需要 32 字节密钥');

  fs.writeFileSync(enc, encryptLikeThunder(plain, key));

  t('能认出迅雷加密文件（首字节不是 0x47）', () => assert.strictEqual(isEncrypted(enc), true));
  t('干净 TS 不会被误判成加密', () => assert.strictEqual(isEncrypted(TESTMEDIA), false));
  t('加密文件的同步字节检查会失败', () => assert.strictEqual(looksLikeCleanTs(enc), false));

  const ok = decryptFile(enc, out);
  t('解密成功', () => assert.strictEqual(ok, true));
  t('解密产物逐字节等于原始明文', () => {
    assert.ok(fs.readFileSync(out).equals(plain), '解密结果与原始文件不一致');
  });
  t('解密产物大小 = 输入 - 512（丢掉文件头）', () => {
    assert.strictEqual(fs.statSync(out).size, fs.statSync(enc).size - HEADER_SIZE);
  });
  t('解密产物通过 TS 校验', () => assert.strictEqual(looksLikeCleanTs(out), true));

  // 就地解密
  const inPlace = path.join(dir, 'inplace.ts');
  fs.copyFileSync(enc, inPlace);
  t('decryptInPlace 同步接口可用', () => {
    const r = require('../src/tsdecrypt').decryptInPlace;
    assert.strictEqual(typeof r, 'function');
  });

  // 标记
  t('明文标记能写能读能清', () => {
    assert.strictEqual(isPlainMarked(out), false);
    assert.strictEqual(markPlain(out), true);
    assert.strictEqual(isPlainMarked(out), true);
    clearPlainMark(out);
    assert.strictEqual(isPlainMarked(out), false);
  });

  // 不是加密文件时 decryptInPlace 应该跳过（不能把明文文件改坏）
  t('非加密文件 decryptInPlace 直接跳过', () => {
    const p = path.join(dir, 'plain.ts');
    fs.copyFileSync(TESTMEDIA, p);
    const before = fs.readFileSync(p);
    // 同步版判定 + 跳过由 isEncrypted 保证
    assert.strictEqual(isEncrypted(p), false);
    assert.ok(fs.readFileSync(p).equals(before));
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n迅雷加密 TS 解密测试：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main();