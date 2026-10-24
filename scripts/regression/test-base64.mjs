/**
 * base64Utils.ts 回归（V26 新增）。
 *
 * # 为什么必须锁
 *
 * `src/modules/toolbox/lib/` 下这几个底层模块此前**一条断言都没有** —— 它们是
 * 「Base64 编解码 / URL 编解码 / JSON / JWT / 哈希」五个工具的公共实现，
 * 一旦改错，坏的是**用户肉眼很难发现**的东西：编码结果只是「看起来差不多」的乱码，
 * 用户的密码、密钥、报文会被它悄悄改掉。
 *
 * 本套的锚点来自**外部标准**，不是把实现重抄一遍：
 *
 *   - **RFC 4648 §10** 的官方测试向量（`""` / `f` / `fo` / `foo` / `foob` / `fooba` / `foobar`）；
 *   - **UTF-8 / UTF-16LE 的字节级期望值**（人工算出，可逐字节核对）；
 *   - **往返不变式**（任意输入 encode→decode 必须还原，含 URL 安全与 MIME 换行组合）。
 *
 * 不覆盖 `readFileAsBase64` / `readFileAsText`（依赖浏览器 FileReader，Node 里没有）。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import {
  BASE64_WRAP_WIDTH,
  base64ToBytes,
  bytesToBase64,
  bytesToText,
  decodeBase64,
  encodeBase64,
  fromUrlSafe,
  normalizeBase64Input,
  textToBytes,
  toUrlSafe,
  wrapLines,
} from '../../src/modules/toolbox/lib/base64Utils.ts';

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

/** 把字节数组打成可见形式（失败时打印用）。 */
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

const OPTS = { encoding: 'utf-8', urlSafe: false, wrap: false };

/* ================================================================== *
 * 1) RFC 4648 §10 官方测试向量（外部标准，唯一可信锚点）
 * ================================================================== */

const RFC4648 = [
  ['', ''],
  ['f', 'Zg=='],
  ['fo', 'Zm8='],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg=='],
  ['fooba', 'Zm9vYmE='],
  ['foobar', 'Zm9vYmFy'],
];

for (const [plain, b64] of RFC4648) {
  ok(`RFC4648 编码 "${plain}" → ${b64 || '(空)'}`, encodeBase64(plain, OPTS) === b64, encodeBase64(plain, OPTS));
}
for (const [plain, b64] of RFC4648) {
  ok(`RFC4648 解码 ${b64 || '(空)'} → "${plain}"`, decodeBase64(b64, OPTS) === plain, decodeBase64(b64, OPTS));
}

ok(
  '空串编码得空串（不是 "==" 之类残留）',
  bytesToBase64(new Uint8Array(0)) === '',
  bytesToBase64(new Uint8Array(0)),
);

/* ================================================================== *
 * 2) 字符编码：字节级期望值（手算，不抄实现）
 * ================================================================== */

// 「中」U+4E2D：UTF-8 = E4 B8 AD（3 字节）→ base64 = 5Lit
ok('UTF-8「中」3 字节', hex(textToBytes('中', 'utf-8')) === 'e4 b8 ad', hex(textToBytes('中', 'utf-8')));
ok('UTF-8「中」base64 = 5Lit', encodeBase64('中', OPTS) === '5Lit', encodeBase64('中', OPTS));
// 「你好」UTF-8 = E4 BD A0 E5 A5 BD → 5L2g5aW9
ok('UTF-8「你好」base64 = 5L2g5aW9', encodeBase64('你好', OPTS) === '5L2g5aW9', encodeBase64('你好', OPTS));

// UTF-16LE：「中」= 2D 4E（低字节在前）→ base64 = LU4=
const utf16Opts = { ...OPTS, encoding: 'utf-16' };
ok('UTF-16LE「中」2 字节（低字节在前）', hex(textToBytes('中', 'utf-16')) === '2d 4e', hex(textToBytes('中', 'utf-16')));
ok('UTF-16LE「中」base64 = LU4=', encodeBase64('中', utf16Opts) === 'LU4=', encodeBase64('中', utf16Opts));
ok('UTF-16LE「A」= 41 00（补零到 2 字节）', hex(textToBytes('A', 'utf-16')) === '41 00', hex(textToBytes('A', 'utf-16')));

// ASCII：高位被丢弃（UI 文案承诺的「丢弃高位」，必须真的按 & 0x7f 干）
ok('ASCII「é」(U+00E9) → 0x69', hex(textToBytes('é', 'ascii')) === '69', hex(textToBytes('é', 'ascii')));
ok('ASCII「中」(U+4E2D) → 0x2d（丢高位）', hex(textToBytes('中', 'ascii')) === '2d', hex(textToBytes('中', 'ascii')));

/* ================================================================== *
 * 3) 三种编码的往返不变式
 * ================================================================== */

const ROUND_TRIP = ['', 'hello', '中文混合 ASCII 123', '😀 emoji 代理对', '符号 !@#$%^&*()_+-=', '换行\n与\t制表'];

for (const encoding of ['utf-8', 'utf-16', 'ascii']) {
  for (const text of ROUND_TRIP) {
    // ASCII 口径本身是有损的（高位被丢），只在纯 ASCII 输入上要求往返无损
    if (encoding === 'ascii' && [...text].some((ch) => ch.charCodeAt(0) > 0x7f)) {
      continue;
    }
    const round = decodeBase64(encodeBase64(text, { ...OPTS, encoding }), { ...OPTS, encoding });
    ok(`[${encoding}] 往返还原 ${JSON.stringify(text)}`, round === text, JSON.stringify(round));
  }
}

// UTF-16LE 的 emoji 必须是 4 字节（代理对逐 charCode 展开，不能劈成半个）
ok('UTF-16LE emoji 占 4 字节', textToBytes('😀', 'utf-16').length === 4, String(textToBytes('😀', 'utf-16').length));
ok('UTF-16LE emoji 往返无损', bytesToText(textToBytes('😀', 'utf-16'), 'utf-16') === '😀');

/* ================================================================== *
 * 4) URL 安全变体（JWT 段落就是它）
 * ================================================================== */

// 字节 FB FF → 标准 base64 "+/8="（恰好同时含 + 与 /）
const plusSlashBytes = new Uint8Array([0xfb, 0xff, 0xef, 0xbe]);
const raw = bytesToBase64(plusSlashBytes);
ok('原始 base64 含 + 或 /', /[+/]/.test(raw), raw);
ok('URL 安全变体不含 + / =', !/[+/=]/.test(toUrlSafe(raw)), toUrlSafe(raw));
ok('URL 安全往返还原原始串', fromUrlSafe(toUrlSafe(raw)) === raw, `${fromUrlSafe(toUrlSafe(raw))} vs ${raw}`);
ok('URL 安全往返后字节一致', hex(base64ToBytes(fromUrlSafe(toUrlSafe(raw)))) === hex(plusSlashBytes));

ok('toUrlSafe 去掉尾部填充 =', toUrlSafe('Zm9vYg==') === 'Zm9vYg', toUrlSafe('Zm9vYg=='));
ok('fromUrlSafe 补齐 2 个 =', fromUrlSafe('Zm9vYg') === 'Zm9vYg==', fromUrlSafe('Zm9vYg'));
ok('fromUrlSafe 补齐 1 个 =', fromUrlSafe('Zm8') === 'Zm8=', fromUrlSafe('Zm8'));
ok('fromUrlSafe 对已合法串不动', fromUrlSafe('Zm9v') === 'Zm9v', fromUrlSafe('Zm9v'));

// 长度模 4 余 1 是非法 base64 → 补成 4 的倍数后必须由 atob 抛错（不能悄悄解出垃圾）
let modOneThrew = false;
try {
  decodeBase64('AAAAA', { ...OPTS, urlSafe: true });
} catch {
  modOneThrew = true;
}
ok('长度模 4 余 1 的串解码抛错（不静默出垃圾）', modOneThrew);

// JWT 中段的真实形态：URL 安全 + 无填充
const jwtPayloadSegment = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0';
ok(
  'JWT 段落（无填充 URL 安全）可解出 JSON',
  decodeBase64(jwtPayloadSegment, { ...OPTS, urlSafe: true }) === '{"sub":"1234567890"}',
  decodeBase64(jwtPayloadSegment, { ...OPTS, urlSafe: true }),
);

/* ================================================================== *
 * 5) MIME 换行与输入归一化
 * ================================================================== */

ok('默认换行宽度为 76（RFC 2045）', BASE64_WRAP_WIDTH === 76, String(BASE64_WRAP_WIDTH));
ok('换行后每行 ≤ 76', wrapLines('A'.repeat(200)).split('\n').every((line) => line.length <= 76));
ok('恰好整除时不留空尾行', wrapLines('A'.repeat(152)).split('\n').length === 2, wrapLines('A'.repeat(152)).split('\n').length);
ok('换行不丢字符', wrapLines('A'.repeat(200)).replace(/\n/g, '') === 'A'.repeat(200));
ok('width <= 0 时不换行', wrapLines('A'.repeat(200), 0) === 'A'.repeat(200));
ok('自定义宽度按位切', wrapLines('abcdef', 2) === 'ab\ncd\nef', wrapLines('abcdef', 2));

ok('归一化去掉换行与空格', normalizeBase64Input(' Zm9v\n Yg== \t') === 'Zm9vYg==', normalizeBase64Input(' Zm9v\n Yg== \t'));

// 换行 + URL 安全的组合：编码带换行，解码要能还原（解码端必须先归一再补填充）
const longText = 'Handy 顺手 · 效率工具'.repeat(8);
const wrapped = encodeBase64(longText, { ...OPTS, urlSafe: true, wrap: true });
ok('换行 + URL 安全：输出确实多行', wrapped.includes('\n'), wrapped.slice(0, 40));
ok(
  '换行 + URL 安全：往返无损',
  decodeBase64(wrapped, { ...OPTS, urlSafe: true }) === longText,
  decodeBase64(wrapped, { ...OPTS, urlSafe: true }).slice(0, 30),
);

/* ================================================================== *
 * 6) 失败路径
 * ================================================================== */

let invalidThrew = false;
try {
  decodeBase64('这不是 base64!!', OPTS);
} catch {
  invalidThrew = true;
}
ok('非法字符输入抛错（由调用方转友好提示）', invalidThrew);

ok('空输入解码为空串（不抛错）', decodeBase64('   ', OPTS) === '', decodeBase64('   ', OPTS));

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
