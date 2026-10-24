/**
 * hashUtils.ts + md5.ts 回归（V26 新增）。
 *
 * # 为什么必须锁
 *
 * 哈希工具是整个工具箱里**最容易被信任**的一个 —— 用户拿它核对下载文件的完整性、
 * 比对接口签名。它此前没有任何自动断言，而它的错误形态极其隐蔽：
 * 只有 MD5 是自己实现的（Web Crypto 不提供），一个填充分支写错，
 * 只在「长度恰好 55 / 56 / 64 字节」这类边界上出问题，日常测几个短串根本看不出来。
 *
 * 锚点全部来自项目之外：
 *
 *   1. **RFC 1321 附录 A.5** 的 7 条官方 MD5 向量；
 *   2. **NIST 公开 SHA 向量**（空串 / "abc"）；
 *   3. **Node 自带 `node:crypto`（OpenSSL）逐长度对拍** ——
 *      `0 / 1 / 55 / 56 / 57 / 63 / 64 / 65 / 127 / 128 / 1000` 全打一遍，
 *      专门覆盖 MD5 填充的「≡56 mod 64」分界（这一带最容易写错）。
 *
 * 另守住一条结构不变式：`HASH_HEX_LENGTH` 里声明的长度必须等于真实算出的摘要长度
 * （将来加算法忘了改表，这条会立刻红）。
 *
 * 不覆盖 `readFileInChunks`（依赖浏览器 File / FileReader）。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import { createHash } from 'node:crypto';
import { md5, md5Bytes } from '../../src/lib/md5.ts';
import {
  HASH_ALGOS,
  HASH_HEX_LENGTH,
  algoByHexLength,
  digestAll,
  digestsToText,
  hasSubtleCrypto,
  isHexDigest,
  toHex,
} from '../../src/modules/toolbox/lib/hashUtils.ts';

let pass = 0;
let fail = 0;
const bad = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    bad.push(`${name}${extra ? ` → ${extra}` : ''}`);
  }
}

/** Node 侧独立实现（OpenSSL） */
const nodeHash = (algo, bytes) => createHash(algo).update(bytes).digest('hex');
const NODE_ALGO = { MD5: 'md5', 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };

const utf8 = (text) => new TextEncoder().encode(text);

/* ================================================================== *
 * 1) RFC 1321 附录 A.5 的官方 MD5 向量
 * ================================================================== */

const RFC1321 = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
  [
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
    '57edf4a22be3c955ac49da2e2107b67a',
  ],
];

for (const [plain, expected] of RFC1321) {
  const actual = md5(plain);
  ok(`RFC1321 md5(${plain.length > 20 ? `${plain.slice(0, 12)}…` : JSON.stringify(plain)})`, actual === expected, `${actual} ≠ ${expected}`);
}

/* ================================================================== *
 * 2) 填充边界逐长度与 node:crypto 对拍
 *    —— MD5 的坑全在「≡56 mod 64」这一段
 * ================================================================== */

const BOUNDARY_LENGTHS = [0, 1, 2, 3, 54, 55, 56, 57, 63, 64, 65, 66, 119, 120, 127, 128, 129, 1000];

for (const length of BOUNDARY_LENGTHS) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    // 用非平凡内容，避免「全零串在不同实现下巧合相等」
    bytes[i] = (i * 31 + length * 7) & 0xff;
  }
  const ours = md5Bytes(bytes);
  const theirs = nodeHash('md5', bytes);
  ok(`MD5 与 OpenSSL 对拍：${length} 字节`, ours === theirs, `ours=${ours} theirs=${theirs}`);
}

/* ================================================================== *
 * 3) 文本入口与字节入口口径一致（中文 / emoji / 换行）
 * ================================================================== */

const UNICODE_CASES = ['中文内容', 'Handy 顺手 · 效率工具', '😀🎉エモジ', 'line1\nline2\r\nline3', '  空格  首尾  ', 'a'.repeat(200)];

for (const text of UNICODE_CASES) {
  ok(`MD5 文本入口 = OpenSSL：${JSON.stringify(text.slice(0, 12))}`, md5(text) === nodeHash('md5', utf8(text)), md5(text));
  ok(
    `md5() 与 md5Bytes(UTF-8) 口径一致：${JSON.stringify(text.slice(0, 12))}`,
    md5(text) === md5Bytes(utf8(text)),
  );
}

/* ================================================================== *
 * 4) SHA 系列：NIST 公开向量 + 与 OpenSSL 对拍
 * ================================================================== */

const NIST_VECTORS = [
  ['SHA-1', '', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
  ['SHA-1', 'abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
  ['SHA-256', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['SHA-256', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'SHA-512',
    'abc',
    'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
  ],
];

const emptyOutcome = await digestAll(new Uint8Array(0));
for (const [algo, plain, expected] of NIST_VECTORS) {
  const actual = emptyOutcome.digests[algo];
  const want = plain === '' ? expected : null;
  if (want !== null) {
    ok(`NIST 向量 ${algo}("")`, actual === want, `${actual} ≠ ${want}`);
  }
}
const abcOutcome = await digestAll(utf8('abc'));
for (const [algo, plain, expected] of NIST_VECTORS) {
  if (plain !== 'abc') {
    continue;
  }
  ok(`NIST 向量 ${algo}("abc")`, abcOutcome.digests[algo] === expected, `${abcOutcome.digests[algo]} ≠ ${expected}`);
}

// 五种算法 × 边界长度，全部与 OpenSSL 对拍
for (const length of [0, 55, 56, 64, 65, 200]) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 13 + 7) & 0xff;
  }
  const outcome = await digestAll(bytes);
  for (const algo of HASH_ALGOS) {
    const ours = outcome.digests[algo];
    const theirs = nodeHash(NODE_ALGO[algo], bytes);
    ok(`${algo} 与 OpenSSL 对拍：${length} 字节`, ours === theirs, `ours=${ours} theirs=${theirs}`);
  }
}

/* ================================================================== *
 * 5) digestAll 的增量回调与错误字段
 * ================================================================== */

const seen = [];
const cbOutcome = await digestAll(utf8('handy'), (algo, digest) => {
  seen.push([algo, digest]);
});
ok('回调五个算法各一次', seen.length === 5, String(seen.length));
ok('回调顺序为弱 → 强', seen.map((item) => item[0]).join(',') === HASH_ALGOS.join(','), seen.map((i) => i[0]).join(','));
ok('回调值与最终结果一致', seen.every(([algo, digest]) => cbOutcome.digests[algo] === digest));
ok('成功时 error 为 null', cbOutcome.error === null, String(cbOutcome.error));
ok('Node 环境具备 Web Crypto', hasSubtleCrypto() === true);

/* ================================================================== *
 * 6) 十六进制工具与算法匹配
 * ================================================================== */

ok('toHex 低位补零', toHex(new Uint8Array([0, 1, 15, 16, 255]).buffer) === '00010f10ff', toHex(new Uint8Array([0, 1, 15, 16, 255]).buffer));

ok('isHexDigest 接受小写', isHexDigest('abcdef0123456789') === true);
ok('isHexDigest 接受大写', isHexDigest('ABCDEF0123456789') === true);
ok('isHexDigest 拒绝非十六进制字符', isHexDigest('zzzz') === false);
ok('isHexDigest 拒绝奇数长度', isHexDigest('abc') === false);
ok('isHexDigest 拒绝空串', isHexDigest('') === false);
ok('isHexDigest 拒绝带空格', isHexDigest('abcd ef') === false);

ok('32 位 → MD5', algoByHexLength('a'.repeat(32)) === 'MD5');
ok('40 位 → SHA-1', algoByHexLength('a'.repeat(40)) === 'SHA-1');
ok('64 位 → SHA-256', algoByHexLength('a'.repeat(64)) === 'SHA-256');
ok('96 位 → SHA-384', algoByHexLength('a'.repeat(96)) === 'SHA-384');
ok('128 位 → SHA-512', algoByHexLength('a'.repeat(128)) === 'SHA-512');
ok('31 位 → null', algoByHexLength('a'.repeat(31)) === null);
ok('33 位 → null', algoByHexLength('a'.repeat(33)) === null);
ok('空串 → null', algoByHexLength('') === null);

// 结构不变式：表里声明的长度必须是真实摘要长度（加算法忘了改表 → 立刻红）
ok('HASH_ALGOS 有五种算法', HASH_ALGOS.length === 5, String(HASH_ALGOS.length));
for (const algo of HASH_ALGOS) {
  const real = (await digestAll(utf8('length-check'))).digests[algo];
  ok(
    `${algo} 声明长度 = 真实摘要长度`,
    HASH_HEX_LENGTH[algo] === real.length,
    `声明 ${HASH_HEX_LENGTH[algo]} / 真实 ${real.length}`,
  );
}
ok(
  '五种算法两两长度不同（长度匹配算法才成立）',
  new Set(HASH_ALGOS.map((algo) => HASH_HEX_LENGTH[algo])).size === HASH_ALGOS.length,
);

/* ================================================================== *
 * 7) 导出文本
 * ================================================================== */

const text = digestsToText({ MD5: 'a'.repeat(32), 'SHA-256': 'b'.repeat(64) }, '文本');
ok('导出含标题行', text.includes('# Handy 哈希计算结果'), text.split('\n')[0]);
ok('导出含来源行', text.includes('# 来源：文本'));
ok('导出只列有值的算法', text.includes('MD5') && text.includes('SHA-256') && !text.includes('SHA-512'));
ok('导出时算法名对齐（padEnd 8）', /^SHA-256\s{1}b{64}$/m.test(text), text.split('\n').at(-1));

/* ================================================================== *
 * 结果
 * ================================================================== */

console.log(`PASS ${pass} / FAIL ${fail}`);
if (bad.length > 0) {
  console.log('--- 失败明细 ---');
  for (const item of bad) {
    console.log('  ✗ ' + item);
  }
}
process.exit(fail === 0 ? 0 : 1);
