/**
 * jwtUtils.ts 回归（V26 新增）。
 *
 * # 为什么必须锁
 *
 * 这是全项目**后果最重**的一个纯逻辑模块：验签只要偏一颗比特，
 * 要么把伪造令牌放行（说「签名有效」），要么把真令牌误判成假的。
 * 它此前一条断言都没有，靠肉眼看了几条示例就算「测过」。
 *
 * 本套的锚点刻意**不来自本项目**：
 *
 *   1. **公开的 jwt.io 示例令牌**（HS256 + `your-256-bit-secret`），它的
 *      header / payload 两段 base64url 是可查的公开值；
 *   2. **Node 自带 `node:crypto` 独立算 HMAC**（OpenSSL 实现），
 *      与产品侧走的 WebCrypto 是**两套实现** —— 两边对上才算数；
 *   3. 过期四态 / 相对时间用**注入的 now**，边界值逐个钉死（不依赖真实时钟）。
 *
 * 另守住「示例 token 与示例密钥必须自洽」：UI 承诺「填入演示密钥即可看到验证通过」，
 * 那么 `buildSampleToken(false)` 就必须真的验得过。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import { createHmac } from 'node:crypto';
import {
  HMAC_ALGORITHMS,
  SAMPLE_SECRET,
  base64UrlToBytes,
  base64UrlToString,
  buildSampleToken,
  buildStandardClaims,
  buildTimeClaims,
  bytesToBase64Url,
  decodeJwtToken,
  describeRelative,
  formatUnixSeconds,
  getExpiryInfo,
  hasWebCrypto,
  isHmacAlgorithm,
  stringToBase64Url,
  verifyJwtSignature,
} from '../../src/modules/toolbox/lib/jwtUtils.ts';

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

/** 用 Node 自带 crypto 独立造令牌（与产品侧 WebCrypto 是两套实现）。 */
function makeToken(alg, secret, header, payload) {
  const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const nodeAlg = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }[alg];
  const signature = createHmac(nodeAlg, secret).update(signingInput).digest().toString('base64url');
  return `${signingInput}.${signature}`;
}

/* ================================================================== *
 * 1) base64url 互转（RFC 7515 的 URL 安全无填充变体）
 * ================================================================== */

ok('base64url 不含 + / =', !/[+/=]/.test(stringToBase64Url('任何 中文 ± 符号')));

// 公开向量：jwt.io 默认示例令牌的两段，字符逐个可查
const PUBLIC_HEADER_SEGMENT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
const PUBLIC_PAYLOAD_SEGMENT =
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ';

ok(
  '头部段与公开示例一致',
  stringToBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) === PUBLIC_HEADER_SEGMENT,
  stringToBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
);
ok(
  '载荷段与公开示例一致',
  stringToBase64Url(JSON.stringify({ sub: '1234567890', name: 'John Doe', iat: 1516239022 })) ===
    PUBLIC_PAYLOAD_SEGMENT,
  stringToBase64Url(JSON.stringify({ sub: '1234567890', name: 'John Doe', iat: 1516239022 })),
);
ok(
  '公开头部段解回原文',
  base64UrlToString(PUBLIC_HEADER_SEGMENT) === '{"alg":"HS256","typ":"JWT"}',
  base64UrlToString(PUBLIC_HEADER_SEGMENT),
);

ok('空字节 → 空串', bytesToBase64Url(new Uint8Array(0)) === '', bytesToBase64Url(new Uint8Array(0)));
ok(
  '字节 → base64url → 字节 往返',
  Array.from(base64UrlToBytes(bytesToBase64Url(new Uint8Array([0xfb, 0xff, 0xef, 0xbe])))).join(',') ===
    '251,255,239,190',
  Array.from(base64UrlToBytes(bytesToBase64Url(new Uint8Array([0xfb, 0xff, 0xef, 0xbe])))).join(','),
);
ok('中文往返无损', base64UrlToString(stringToBase64Url('Handy 顺手')) === 'Handy 顺手');
ok(
  'URL 安全字符 - _ 可解码并原样回写',
  bytesToBase64Url(base64UrlToBytes('-_8')) === '-_8',
  bytesToBase64Url(base64UrlToBytes('-_8')),
);
ok('带 URL 安全字符的串解出真实字节', Array.from(base64UrlToBytes('-_8')).join(',') === '251,255', Array.from(base64UrlToBytes('-_8')).join(','));

let modOneThrew = false;
try {
  base64UrlToBytes('AAAAA');
} catch {
  modOneThrew = true;
}
ok('长度模 4 余 1 非法 → 抛错', modOneThrew);

/* ================================================================== *
 * 2) decodeJwtToken：三段解析与容错
 * ================================================================== */

const PUBLIC_TOKEN = `${PUBLIC_HEADER_SEGMENT}.${PUBLIC_PAYLOAD_SEGMENT}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`;

const publicDecoded = decodeJwtToken(PUBLIC_TOKEN);
ok('公开示例令牌解析成功', publicDecoded.ok === true, JSON.stringify(publicDecoded.error));
ok('算法识别为 HS256', publicDecoded.decoded?.algorithm === 'HS256', String(publicDecoded.decoded?.algorithm));
ok('载荷 sub 正确', publicDecoded.decoded?.payload.sub === '1234567890', String(publicDecoded.decoded?.payload.sub));
ok('载荷 iat 正确', publicDecoded.decoded?.payload.iat === 1516239022, String(publicDecoded.decoded?.payload.iat));
ok(
  'signingInput = 前两段拼接',
  publicDecoded.decoded?.signingInput === `${PUBLIC_HEADER_SEGMENT}.${PUBLIC_PAYLOAD_SEGMENT}`,
);
ok('三段原样保留（供复制）', publicDecoded.decoded?.signatureSegment === 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
ok(
  'JSON 展示为缩进 2 空格',
  publicDecoded.decoded?.payloadText.startsWith('{\n  "sub"') === true,
  publicDecoded.decoded?.payloadText,
);

ok('自动去掉 Bearer 前缀', decodeJwtToken(`Bearer ${PUBLIC_TOKEN}`).ok === true);
ok('自动去掉小写 bearer 前缀', decodeJwtToken(`bearer ${PUBLIC_TOKEN}`).ok === true);
ok('首尾空白被裁掉', decodeJwtToken(`\n  ${PUBLIC_TOKEN}  \n`).ok === true);

const twoSegments = decodeJwtToken('aaa.bbb');
ok('两段 → 报错', twoSegments.ok === false);
ok('报错文案说明段数', twoSegments.error.includes('2 段'), twoSegments.error);

ok('空输入 → 报错', decodeJwtToken('   ').ok === false);
ok('头部为空 → 报错', decodeJwtToken('.eyJhIjoxfQ.sig').ok === false);

const badBase64 = decodeJwtToken('!!!.eyJhIjoxfQ.sig');
ok('头部非法 base64url → 报错', badBase64.ok === false);
ok('非法 base64 的提示针对头部', badBase64.error.includes('头部'), badBase64.error);

const notJsonPayload = `${PUBLIC_HEADER_SEGMENT}.${stringToBase64Url('这不是 JSON')}.sig`;
ok('载荷非 JSON → 报错', decodeJwtToken(notJsonPayload).ok === false);
ok('非 JSON 提示指向载荷', decodeJwtToken(notJsonPayload).error.includes('载荷'), decodeJwtToken(notJsonPayload).error);

const arrayPayload = `${PUBLIC_HEADER_SEGMENT}.${stringToBase64Url('[1,2,3]')}.sig`;
ok('载荷是数组 → 报错（必须是对象）', decodeJwtToken(arrayPayload).ok === false);

const noAlg = `${stringToBase64Url(JSON.stringify({ typ: 'JWT' }))}.${PUBLIC_PAYLOAD_SEGMENT}.sig`;
const noAlgDecoded = decodeJwtToken(noAlg);
ok('缺 alg 时能解析但 algorithm 为空串', noAlgDecoded.ok === true && noAlgDecoded.decoded.algorithm === '', String(noAlgDecoded.decoded?.algorithm));

/* ================================================================== *
 * 3) HMAC 验签：与 node:crypto 交叉验证（本套最关键的一段）
 * ================================================================== */

const SECRET = 'your-256-bit-secret';
const payloadForSign = { sub: '1234567890', name: 'John Doe', iat: 1516239022 };
const nodeSignedHs256 = makeToken('HS256', SECRET, { alg: 'HS256', typ: 'JWT' }, payloadForSign);

// 自造令牌的签名段必须与公开示例的签名段一致 —— 两个独立的第三方实现互相印证
ok(
  'node:crypto 算出的 HS256 签名 = 公开示例签名',
  nodeSignedHs256.endsWith('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'),
  nodeSignedHs256.split('.')[2],
);

const nodeDecoded = decodeJwtToken(nodeSignedHs256);
const validState = await verifyJwtSignature(nodeDecoded.decoded, SECRET);
ok('正确密钥 → 验证通过', validState.status === 'valid', `${validState.status}: ${validState.message}`);
ok('通过时的文案含算法名', validState.message.includes('HS256'), validState.message);

const wrongSecretState = await verifyJwtSignature(nodeDecoded.decoded, 'wrong-secret');
ok('错误密钥 → 验证失败', wrongSecretState.status === 'invalid', `${wrongSecretState.status}: ${wrongSecretState.message}`);

// 篡改载荷：签名不再匹配
const tamperedToken = `${stringToBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${stringToBase64Url(
  JSON.stringify({ sub: 'attacker', iat: 1516239022 }),
)}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`;
const tamperedDecoded = decodeJwtToken(tamperedToken);
const tamperedState = await verifyJwtSignature(tamperedDecoded.decoded, SECRET);
ok('篡改载荷 → 验证失败', tamperedState.status === 'invalid', `${tamperedState.status}: ${tamperedState.message}`);

// 签名段被改一位。**注意别改最后一个字符**：32 字节的 HS256 签名编成 43 个 base64 字符，
// 最后一个字符只贡献高 4 位，低 2 位是填充位 —— 改它字节序列完全不变，
// 验签通过是**正确**行为（这是 base64 规范，不是漏洞）。所以要改就改首位。
const prevBytes = base64UrlToBytes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
const padBitBytes = base64UrlToBytes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5d');
ok(
  '只改填充位：解出的字节完全相同（base64 规范，不是漏洞）',
  Array.from(prevBytes).join(',') === Array.from(padBitBytes).join(','),
);

const flippedSignature = 'TflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
ok('改有效位：解出的字节确实不同', Array.from(base64UrlToBytes(flippedSignature)).join(',') !== Array.from(prevBytes).join(','));

const flippedDecoded = decodeJwtToken(
  `${PUBLIC_HEADER_SEGMENT}.${PUBLIC_PAYLOAD_SEGMENT}.${flippedSignature}`,
);
const flippedState = await verifyJwtSignature(flippedDecoded.decoded, SECRET);
ok('签名改一位 → 验证失败', flippedState.status === 'invalid', `${flippedState.status}: ${flippedState.message}`);

// HS384 / HS512：用 node:crypto 造，产品侧必须验得过
for (const alg of ['HS384', 'HS512']) {
  const token = makeToken(alg, SECRET, { alg, typ: 'JWT' }, payloadForSign);
  const decoded = decodeJwtToken(token);
  const state = await verifyJwtSignature(decoded.decoded, SECRET);
  ok(`${alg} 交叉验签通过`, state.status === 'valid', `${state.status}: ${state.message}`);
}

/* --- 降级与边界 --- */

ok('HMAC_ALGORITHMS 只有三项', HMAC_ALGORITHMS.length === 3 && HMAC_ALGORITHMS.join(',') === 'HS256,HS384,HS512');
ok('isHmacAlgorithm 认 HS256', isHmacAlgorithm('HS256') === true);
ok('isHmacAlgorithm 不认 RS256', isHmacAlgorithm('RS256') === false);
ok('isHmacAlgorithm 不认原型链上的键名', isHmacAlgorithm('constructor') === false);
ok('isHmacAlgorithm 不认 toString', isHmacAlgorithm('toString') === false);

const rsDecoded = decodeJwtToken(makeToken('HS256', SECRET, { alg: 'RS256', typ: 'JWT' }, payloadForSign));
const rsState = await verifyJwtSignature(rsDecoded.decoded, SECRET);
ok('非 HMAC 算法 → unsupported（不误报通过）', rsState.status === 'unsupported', rsState.status);

const emptySecretState = await verifyJwtSignature(nodeDecoded.decoded, '');
ok('空密钥 → error 且提示填写密钥', emptySecretState.status === 'error' && emptySecretState.message.includes('密钥'), emptySecretState.message);

const noAlgState = await verifyJwtSignature(noAlgDecoded.decoded, SECRET);
ok('缺 alg 且无覆盖 → unsupported', noAlgState.status === 'unsupported', noAlgState.status);

const overrideState = await verifyJwtSignature(noAlgDecoded.decoded, SECRET, 'HS256');
ok('手动覆盖算法后返回 invalid/valid 而不是 unsupported', overrideState.status !== 'unsupported', overrideState.status);

const unsignedDecoded = decodeJwtToken(`${PUBLIC_HEADER_SEGMENT}.${PUBLIC_PAYLOAD_SEGMENT}.`);
const unsignedState = await verifyJwtSignature(unsignedDecoded.decoded, SECRET);
ok('无签名段（alg=none）→ invalid', unsignedState.status === 'invalid', unsignedState.status);
ok('无签名段提示 alg=none', unsignedState.message.includes('none'), unsignedState.message);

ok('Node 环境具备 Web Crypto', hasWebCrypto() === true);

/* ================================================================== *
 * 4) 过期四态（注入 now，边界逐个钉死）
 * ================================================================== */

const NOW = 1_700_000_000_000; // 固定时刻（毫秒）
const nowSec = NOW / 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

ok('无 exp → none 档', getExpiryInfo({}, NOW).state === 'none');
ok('exp 非数字 → none 档', getExpiryInfo({ exp: 'soon' }, NOW).state === 'none');
ok('已过期 → expired 档', getExpiryInfo({ exp: nowSec - 1 }, NOW).state === 'expired');
ok('恰好等于当前时刻 → expired（边界取闭）', getExpiryInfo({ exp: nowSec }, NOW).state === 'expired');
ok('剩余 23 小时 → expiring 档', getExpiryInfo({ exp: nowSec + 23 * 3600 }, NOW).state === 'expiring');
ok('剩余 25 小时 → active 档', getExpiryInfo({ exp: nowSec + 25 * 3600 }, NOW).state === 'active');
ok('剩余 7 天 → active 档', getExpiryInfo({ exp: nowSec + 7 * 86400 }, NOW).state === 'active');
ok('expiresAt 按毫秒给出', getExpiryInfo({ exp: nowSec + 100 }, NOW).expiresAt === NOW + 100 * 1000);
ok('四态各有独立文案', new Set(['none', 'expired', 'expiring', 'active'].map((s) => {
  const payload = s === 'none' ? {} : { exp: nowSec + (s === 'expired' ? -1 : s === 'expiring' ? 60 : 100000) };
  return getExpiryInfo(payload, NOW).label;
})).size === 4);

/* ================================================================== *
 * 5) 相对时间描述
 * ================================================================== */

ok('0 秒的边界', describeRelative(NOW, NOW) === '0 秒后', describeRelative(NOW, NOW));
ok('59 秒前', describeRelative(NOW - 59_000, NOW) === '59 秒前', describeRelative(NOW - 59_000, NOW));
ok('60 秒 → 1 分钟前', describeRelative(NOW - 60_000, NOW) === '1 分钟前', describeRelative(NOW - 60_000, NOW));
ok('90 秒 → 1 分钟前（向下取整）', describeRelative(NOW - 90_000, NOW) === '1 分钟前', describeRelative(NOW - 90_000, NOW));
ok('2 小时前', describeRelative(NOW - 2 * HOUR, NOW) === '2 小时前', describeRelative(NOW - 2 * HOUR, NOW));
ok('3 天后', describeRelative(NOW + 3 * DAY, NOW) === '3 天后', describeRelative(NOW + 3 * DAY, NOW));
ok('29 天前仍是「天」档', describeRelative(NOW - 29 * DAY, NOW) === '29 天前', describeRelative(NOW - 29 * DAY, NOW));
ok('30 天 → 1 个月前', describeRelative(NOW - 30 * DAY, NOW) === '1 个月前', describeRelative(NOW - 30 * DAY, NOW));
ok('11 个月 → 个月档', describeRelative(NOW - 330 * DAY, NOW) === '11 个月前', describeRelative(NOW - 330 * DAY, NOW));
ok('12 个月 → 1 年前', describeRelative(NOW - 360 * DAY, NOW) === '1 年前', describeRelative(NOW - 360 * DAY, NOW));
ok('未来也有「后」字', describeRelative(NOW + 400 * DAY, NOW).endsWith('后'), describeRelative(NOW + 400 * DAY, NOW));

/* ================================================================== *
 * 6) 时间声明与标准声明抽取
 * ================================================================== */

const timeClaims = buildTimeClaims(
  { iat: nowSec - 100, nbf: nowSec - 100, exp: nowSec + 100, sub: 'x', iss: 'y' },
  NOW,
);
ok('时间声明按 iat → nbf → exp 顺序', timeClaims.map((c) => c.key).join(',') === 'iat,nbf,exp', timeClaims.map((c) => c.key).join(','));
ok('时间声明带本地格式化绝对时间', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeClaims[0].absolute), timeClaims[0].absolute);
ok('时间声明带相对描述', timeClaims[2].relative === '1 分钟后', timeClaims[2].relative);
ok('非数字时间声明被跳过', buildTimeClaims({ iat: 'yesterday', exp: nowSec + 1 }, NOW).length === 1);
ok('无时间声明时返回空数组', buildTimeClaims({}, NOW).length === 0);

const stdClaims = buildStandardClaims({
  iss: 'https://issuer',
  sub: 'user-1',
  aud: ['a', 'b'],
  jti: 'id-1',
  name: 'ignored',
});
ok('标准声明抽取 4 条', stdClaims.length === 4, String(stdClaims.length));
ok('aud 数组用顿号连接', stdClaims[2].value === 'a、b', stdClaims[2].value);
ok('未列出的声明（name）不出现', !stdClaims.some((row) => row.key === 'name'));
ok('空值被跳过', buildStandardClaims({ iss: '', sub: null, aud: [], jti: 'x' }).length === 1);
ok('数字声明转字符串', buildStandardClaims({ sub: 123 }).at(0)?.value === '123', JSON.stringify(buildStandardClaims({ sub: 123 })));

ok('formatUnixSeconds 输出本地时间格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(formatUnixSeconds(nowSec)), formatUnixSeconds(nowSec));

/* ================================================================== *
 * 7) 示例 token 自洽（UI 承诺「填演示密钥就能看到验证通过」）
 * ================================================================== */

const activeToken = await buildSampleToken(false);
const activeDecoded = decodeJwtToken(activeToken);
ok('未过期示例可解析', activeDecoded.ok === true, String(activeDecoded.error));
ok('未过期示例算法为 HS256', activeDecoded.decoded?.algorithm === 'HS256', String(activeDecoded.decoded?.algorithm));
ok('未过期示例有三段', activeToken.split('.').length === 3);
ok('未过期示例带真实签名（非占位）', activeDecoded.decoded?.signatureSegment?.startsWith('handy-demo-signature-') === false);

const activeVerify = await verifyJwtSignature(activeDecoded.decoded, SAMPLE_SECRET);
ok('示例密钥能验过示例 token', activeVerify.status === 'valid', `${activeVerify.status}: ${activeVerify.message}`);

const activeExpiry = getExpiryInfo(activeDecoded.decoded.payload);
ok('未过期示例的过期态为 active', activeExpiry.state === 'active', activeExpiry.state);
ok('未过期示例 exp 在 7 天后左右', Math.abs(activeDecoded.decoded.payload.exp * 1000 - (Date.now() + 7 * 86400_000)) < 120_000);

const expiredToken = await buildSampleToken(true);
const expiredDecoded = decodeJwtToken(expiredToken);
ok('已过期示例可解析', expiredDecoded.ok === true);
ok('已过期示例过期态为 expired', getExpiryInfo(expiredDecoded.decoded.payload).state === 'expired');
ok('已过期示例仍带真实签名（能验签通过）', (await verifyJwtSignature(expiredDecoded.decoded, SAMPLE_SECRET)).status === 'valid');
ok('已过期示例的 iat 早于 exp', expiredDecoded.decoded.payload.iat < expiredDecoded.decoded.payload.exp);
ok('示例 jti 区分两种状态', activeDecoded.decoded.payload.jti !== expiredDecoded.decoded.payload.jti);

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
