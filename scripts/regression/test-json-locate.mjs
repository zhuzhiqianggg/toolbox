/**
 * jsonLocate（JSON 语法错误行列定位）回归 —— V27。
 *
 * 锚点：**Node 自己的 `JSON.parse`（V8）**。
 *  - 合法性必须一致：V8 认为合法 ⇒ 本扫描器必须返回 null；V8 报错 ⇒ 本扫描器必须能定位。
 *    这是「不报错、只给错答案」类缺陷的唯一可靠防线（手写扫描器最容易悄悄与真实解析器分歧）。
 *  - 行列与原因：人工逐字符数出来的期望值（别凭直觉，V23 textlab 首轮 8 条 FAIL 全是自己数错）。
 *
 * 跑法：`node scripts/regression/run.mjs`（本文件自举 `--experimental-transform-types`，
 * 因为 jsonLocate.ts 的 SpotError 构造器用了参数属性，纯类型剥离不支持）。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---- 自举：需要 --experimental-transform-types（参数属性不是「可擦除语法」）----
const SELF = fileURLToPath(import.meta.url);
if (!process.execArgv.includes('--experimental-transform-types')) {
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, '--experimental-transform-types', SELF],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

const { locateJsonError } = await import('../../src/lib/jsonLocate.ts');

const NL = String.fromCharCode(10);
let pass = 0;
const fails = [];
function check(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    pass += 1;
  } else {
    fails.push(`FAIL | ${name} | got=${a} want=${b}`);
  }
}

/** 与 V8 对判：bothInvalid / bothValid / DIVERGE */
function agreement(src) {
  let v8Valid = true;
  try {
    JSON.parse(src);
  } catch {
    v8Valid = false;
  }
  const spot = locateJsonError(src);
  const locateValid = spot === null;
  if (v8Valid === locateValid) {
    pass += 1;
    return v8Valid ? 'bothValid' : 'bothInvalid';
  }
  fails.push(
    `FAIL | 与 V8 合法性分歧 | ${JSON.stringify(src).slice(0, 50)} | v8Valid=${v8Valid} locateSaysValid=${locateValid}`,
  );
  return v8Valid ? 'v8Only' : 'locateOnly';
}

// ---------- 1) 合法性差分：V8 拒绝的必须能定位 ----------
const malformed = [
  '{"a":1',
  '{"a" 1}',
  "{'a':1}",
  '{"a":1,}',
  '[1,2,]',
  '[1 2]',
  '{"a":01}',
  '{"a":.5}',
  '{"a":1.}',
  '{"a":1e}',
  '{"a":"\\x"}',
  '{"a":"\\u12"}',
  '{"a":"unterminated}',
  '{"a":tru}',
  '{"a":nul}',
  '{"a":undefined}',
  '{"a":NaN}',
  '{"a":Infinity}',
  '{"a":1} extra',
  '[}',
  '{]',
  '{"a":}',
  '[',
  '{',
  '{"a":+1}',
  '{"a":1,"b"}',
  '{"a"::1}',
  '{"a":1}}',
  '0x10',
  '01',
  '.5',
  '5.',
  '5.e3',
  '1e',
  'truex',
  'tru',
  'nulll',
  '',
  '   ',
  `{"a":"line1${NL}line2"}`,
  `{"a": 1,${NL}  "b":${NL}}`,
  '{"a": 1, "b": 2,}',
  '["a", "b",]',
  '{"a":[1,2,3}',
  '{"a":{"b":1}',
  '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9,"j":10,}',
  '\uFEFF{"a":1}',
  '{"a":1,,"b":2}',
  '[,1]',
  '{"":}',
  '[-1][0]',
  '{"a" 1, "b" 2}',
  '[1, 2 3, 4]',
  '{"a":1e+}',
  '{"a":"\\uZZZZ"}',
  '{"a":"\\}',
];
for (const src of malformed) {
  if (agreement(src) !== 'bothInvalid') {
    fails.push(`FAIL | 语料应当被 V8 拒绝 | ${JSON.stringify(src)}`);
  }
}

// ---------- 2) 合法 JSON 必须返回 null（含随机生成的结构） ----------
const validSamples = [
  '{}',
  '[]',
  '""',
  '0',
  '-0',
  '123',
  '1e5',
  '1E+5',
  '1.5e-3',
  'true',
  'false',
  'null',
  '{"a":1}',
  '{"a":[1,2,{"b":3}]}',
  '{"a":"\\uD83D\\uDE00"}',
  '[1,[2,[3]]]',
  `{"a":1} ${NL} ${NL}`,
  '  {"a": 1}  ',
  JSON.stringify({ a: 1, b: 'x', c: [1, 2, { d: null, e: true }], f: '中文😀' }),
  JSON.stringify({ nested: { deep: { deeper: [1, { x: 1.5e10 }] } } }),
  // 空白与转义的边界
  '[\t\r\n ]',
  '{"a" : "b" }',
];
// 确定性伪随机（避免每次跑出不同语料导致「过一次就绿」）
let seed = 20260916;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function rndValue(depth) {
  const r = rnd();
  if (depth <= 0 || r < 0.25) return Math.floor(rnd() * 1000) - 500;
  if (r < 0.4) return rnd() < 0.5;
  if (r < 0.5) return null;
  if (r < 0.7) return `文本${Math.floor(rnd() * 100)}😀`;
  if (r < 0.85) {
    return Array.from({ length: Math.floor(rnd() * 4) }, () => rndValue(depth - 1));
  }
  const obj = {};
  for (let k = Math.floor(rnd() * 4) + 1; k > 0; k -= 1) {
    obj[`k${Math.floor(rnd() * 100)}`] = rndValue(depth - 1);
  }
  return obj;
}
for (let i = 0; i < 20; i += 1) {
  validSamples.push(JSON.stringify(rndValue(4)));
}
for (const src of validSamples) {
  let v8Valid = true;
  try {
    JSON.parse(src);
  } catch {
    v8Valid = false;
  }
  if (!v8Valid) {
    fails.push(`FAIL | 语料应当被 V8 接受 | ${JSON.stringify(src).slice(0, 40)}`);
    continue;
  }
  const spot = locateJsonError(src);
  if (spot !== null) {
    fails.push(
      `FAIL | 合法 JSON 被误报 | ${JSON.stringify(src).slice(0, 40)} | spot=${JSON.stringify(spot)}`,
    );
  } else {
    pass += 1;
  }
}

// ---------- 3) 行列与原因（人工逐字符数） ----------
// 结构：[输入, line, column, reason 片段, 行片段]
const positionCases = [
  ['{"a":1', 1, 7, '对象未闭合', '{"a":1'],
  ['{"a" 1}', 1, 6, '键后面缺少冒号', '{"a" 1}'],
  ["{'a':1}", 1, 2, '对象的键必须是双引号字符串', "{'a':1}"],
  ['{"a":1,}', 1, 7, '尾随逗号', '{"a":1,}'],
  ['[1,2,]', 1, 5, '尾随逗号', '[1,2,]'],
  ['["a", "b",]', 1, 10, '尾随逗号', '["a", "b",]'],
  ['[1 2]', 1, 4, '数组元素之间应为 , 或以 ] 结束', '[1 2]'],
  ['{"a":01}', 1, 7, '对象成员之间应为 , 或以 } 结束', '{"a":01}'],
  ['{"a":.5}', 1, 6, '数字格式无效', '{"a":.5}'],
  ['{"a":1.}', 1, 8, '小数点后缺少数字', '{"a":1.}'],
  ['{"a":1e}', 1, 8, '指数部分缺少数字', '{"a":1e}'],
  ['{"a":"\\x"}', 1, 8, '无效的转义字符 \\x', '{"a":"\\x"}'],
  ['{"a":"\\u12"}', 1, 11, '\\u 转义需要 4 位十六进制数字', '{"a":"\\u12"}'],
  ['{"a":"unterminated}', 1, 20, '字符串未闭合', '{"a":"unterminated}'],
  ['{"a":tru}', 1, 9, '无效字面量：此处应为 true', '{"a":tru}'],
  ['{"a":1} extra', 1, 9, 'JSON 结束后存在多余内容', '{"a":1} extra'],
  ['[}', 1, 2, '此处缺少 JSON 值', '[}'],
  ['{"a":}', 1, 6, '此处缺少 JSON 值', '{"a":}'],
  ['{"a":+1}', 1, 6, '数字格式无效', '{"a":+1}'],
  ['{"a"::1}', 1, 6, '此处缺少 JSON 值', '{"a"::1}'],
  ['{"a":1}}', 1, 8, 'JSON 结束后存在多余内容', '{"a":1}}'],
  ['0x10', 1, 2, 'JSON 结束后存在多余内容', '0x10'],
  ['01', 1, 2, 'JSON 结束后存在多余内容', '01'],
  ['.5', 1, 1, '数字格式无效', '.5'],
  ['truex', 1, 5, 'JSON 结束后存在多余内容', 'truex'],
  ['[,1]', 1, 2, '此处缺少 JSON 值', '[,1]'],
  // 「,,」是缺键不是缺值 —— 逗号后面应出现下一个键（双引号字符串）
  ['{"a":1,,"b":2}', 1, 8, '对象的键必须是双引号字符串', '{"a":1,,"b":2}'],
  // 多行：行列必须跨行累计，行片段只取出错那一行
  [`{${NL}  "a": 1,${NL}  "b":${NL}}`, 4, 1, '此处缺少 JSON 值', '}'],
  [`{${NL} "a":1,${NL}}`, 2, 7, '尾随逗号', ' "a":1,'],
  [`{${NL}  "a": tru${NL}}`, 2, 11, '无效字面量', '  "a": tru'],
  [`[${NL}  1,${NL}  2${NL}  3${NL}]`, 4, 3, '数组元素之间应为 , 或以 ] 结束', '  3'],
];
for (const [src, line, column, reasonPart, snippet] of positionCases) {
  let v8Valid = true;
  try {
    JSON.parse(src);
  } catch {
    v8Valid = false;
  }
  if (v8Valid) {
    fails.push(`FAIL | 定位语料应当非法 | ${JSON.stringify(src).slice(0, 40)}`);
    continue;
  }
  const spot = locateJsonError(src);
  if (spot === null) {
    fails.push(`FAIL | 非法 JSON 却返回 null | ${JSON.stringify(src).slice(0, 40)}`);
    continue;
  }
  check(`${JSON.stringify(src).slice(0, 30)} 行号`, spot.line, line);
  check(`${JSON.stringify(src).slice(0, 30)} 列号`, spot.column, column);
  if (!spot.reason.includes(reasonPart)) {
    fails.push(`FAIL | 原因不含「${reasonPart}」 | got=${spot.reason}`);
  }
  check(`${JSON.stringify(src).slice(0, 30)} 行片段`, spot.snippet, snippet);
}

// ---------- 4) 长行截断：片段 ≤ 120 字符且以出错列为中心 ----------
{
  const long = `{"k":"${'x'.repeat(200)}",}`;
  const spot = locateJsonError(long);
  if (spot === null) {
    fails.push('FAIL | 长行尾随逗号却返回 null');
  } else {
    check('长行片段长度 ≤ 122', spot.snippet.length <= 122, true);
    if (!spot.snippet.includes('…')) {
      fails.push(`FAIL | 长行片段应有省略号 | got=${spot.snippet.slice(0, 40)}`);
    }
  }
}

// ---------- 汇总 ----------
console.log(`PASS ${pass} / FAIL ${fails.length}`);
for (const line of fails) {
  console.log(line);
}
if (fails.length > 0) {
  process.exit(1);
}
