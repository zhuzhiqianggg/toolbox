/**
 * byteUnits.ts 回归（V26 新增）。
 *
 * # 为什么必须锁
 *
 * 这段逻辑原本埋在 `FileSize.tsx` 组件里，Node 回归够不着，于是藏了一个
 * **静默差 1024⁴ 倍**的错误：base-2 的 `TiB` 拿到 base-10 的单位表里查不到，
 * `unitFactor` 直接返回 1 —— 界面会一本正经地告诉你「1.5 TiB = 1.5 字节」。
 * 这类「不报错、只给错答案」的缺陷，只有把逻辑抽成纯模块 + 逐条对算式才拦得住。
 *
 * 锚点：
 *   - **IEC 80000-13** 的单位口径（1024 进制 = KiB/MiB/GiB/TiB/PiB；1000 进制 = KB/MB/GB/TB/PB）；
 *   - 逐项手算的倍数（1024⁰…1024⁵ 与 1000⁰…1000⁵）；
 *   - **UI 示例里写死的承诺**（1 MiB = 1048576 字节；10⁹ 字节 base-2 显示 953.67 MiB、
 *     base-10 显示 1 GB）—— V25 的教训是示例描述必须与实现一致。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import {
  BINARY_UNITS,
  DECIMAL_UNITS,
  baseOf,
  formatAllUnits,
  toBytesText,
  toMatchingBase,
  unitFactor,
  unitsFor,
} from '../../src/lib/byteUnits.ts';

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

function same(name, actual, expected) {
  ok(name, actual === expected, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
}

/* ================================================================== *
 * 1) 单位表：下标必须一一对应（换算与切换都建立在这个前提上）
 * ================================================================== */

same('base-2 单位表', BINARY_UNITS.join(','), 'B,KiB,MiB,GiB,TiB,PiB');
same('base-10 单位表', DECIMAL_UNITS.join(','), 'B,KB,MB,GB,TB,PB');
same('两表等长', BINARY_UNITS.length, DECIMAL_UNITS.length);
same('第 0 项都是 B', `${BINARY_UNITS[0]}/${DECIMAL_UNITS[0]}`, 'B/B');
same('unitsFor(true) 返回 base-2 表', unitsFor(true).join(','), BINARY_UNITS.join(','));
same('unitsFor(false) 返回 base-10 表', unitsFor(false).join(','), DECIMAL_UNITS.join(','));
same('baseOf(true) = 1024', baseOf(true), 1024);
same('baseOf(false) = 1000', baseOf(false), 1000);

/* ================================================================== *
 * 2) 倍数：逐项手算
 * ================================================================== */

const FACTORS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
for (let i = 0; i < FACTORS.length; i += 1) {
  same(`base-2 ${FACTORS[i]} = 1024^${i}`, unitFactor(FACTORS[i], true), 1024 ** i);
}
const DFACTORS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
for (let i = 0; i < DFACTORS.length; i += 1) {
  same(`base-10 ${DFACTORS[i]} = 1000^${i}`, unitFactor(DFACTORS[i], false), 1000 ** i);
}
same('KiB = 1024 B（示例承诺：1048576 字节 = 1 MiB）', unitFactor('MiB', true), 1048576);

// 已知地雷：进制不匹配时查不到 → 返回 1（这就是必须配 toMatchingBase 的原因）
same('进制不匹配时 unitFactor 返回 1（已知地雷，靠 toMatchingBase 兜）', unitFactor('TiB', false), 1);
same('未知单位同样返回 1', unitFactor('ZZ', true), 1);

/* ================================================================== *
 * 3) 单位进制切换（本次修掉的缺陷）
 * ================================================================== */

const PAIRS = [
  ['B', 'B'],
  ['KiB', 'KB'],
  ['MiB', 'MB'],
  ['GiB', 'GB'],
  ['TiB', 'TB'],
  ['PiB', 'PB'],
];
for (const [binary, decimal] of PAIRS) {
  same(`${binary} 切到 base-10 → ${decimal}`, toMatchingBase(binary, false), decimal);
  same(`${decimal} 切到 base-2 → ${binary}`, toMatchingBase(decimal, true), binary);
}
same('已是目标进制的单位不动（base-2 下的 MiB）', toMatchingBase('MiB', true), 'MiB');
same('已是目标进制的单位不动（base-10 下的 MB）', toMatchingBase('MB', false), 'MB');
same('完全无法识别的单位退到 B', toMatchingBase('XYZ', true), 'B');
same('空串退到 B', toMatchingBase('', true), 'B');

// 性质断言：切换后单位一定属于当前进制表；且非 B 单位的倍数绝不为 1
for (const base2 of [true, false]) {
  for (const unit of unitsFor(!base2)) {
    const matched = toMatchingBase(unit, base2);
    ok(`切换后 ${unit}→${matched} 属于当前进制表`, unitsFor(base2).includes(matched), matched);
    const index = unitsFor(base2).indexOf(matched);
    same(`切换后 ${matched} 的倍数正确`, unitFactor(matched, base2), baseOf(base2) ** index);
  }
}

// 修掉的那条：base-10 模式下选中 base-2 的 TiB，绝不能再算出「1.5 字节」
same('base-10 + 原 TiB 的换算结果（修复前是 1.5 字节）', toBytesText(1.5, toMatchingBase('TiB', false), false), '1500000000000 字节（base-10）');

/* ================================================================== *
 * 4) 字节 → 全部单位（示例承诺逐条核对）
 * ================================================================== */

same(
  '1048576 字节在 base-2 下正好 1 MiB',
  formatAllUnits(1048576, true).split('\n')[2],
  '1 MiB',
);
same('1048576 字节列出 6 个进制档', formatAllUnits(1048576, true).split('\n').length, 6);
same('整数不带小数点', formatAllUnits(1048576, true).split('\n')[0], '1048576 B');
same('非整数保留两位', formatAllUnits(1048576, true).split('\n')[3], '0.00 GiB');

// 「base-2 vs base-10」示例：同一个数字在两套进制下的显示
same('10⁹ 字节 base-2 显示 953.67 MiB', formatAllUnits(1_000_000_000, true).split('\n')[2], '953.67 MiB');
same('10⁹ 字节 base-10 显示 1 GB', formatAllUnits(1_000_000_000, false).split('\n')[3], '1 GB');
same('10⁹ 字节 base-10 显示 1 GB 而不是 0.93 GiB', formatAllUnits(1_000_000_000, false).includes('GiB'), false);

same('0 字节', formatAllUnits(0, true).split('\n')[0], '0 B');
same('负数返回空串（UI 显示空态）', formatAllUnits(-1, true), '');
same('NaN 返回空串', formatAllUnits(Number.NaN, true), '');
same('Infinity 返回空串', formatAllUnits(Number.POSITIVE_INFINITY, true), '');

/* ================================================================== *
 * 5) 易读 → 字节（反查）
 * ================================================================== */

same('反查 1.5 TiB（示例承诺）', toBytesText(1.5, 'TiB', true), '1649267441664 字节（base-2）');
same('反查 20 MB（示例承诺）', toBytesText(20, 'MB', false), '20000000 字节（base-10）');
same('反查 1 GB 按 1024 进制 = 1073741824 字节', toBytesText(1, 'GB', true), '1073741824 字节（base-2）');
// 边界自愈：单位口径与进制不匹配时，函数内部自己归一化，不接受「1 倍」的兜底答案
same('单位口径不匹配时内部自动归一化（GB@base-2 → GiB）', toBytesText(1, 'GB', true), '1073741824 字节（base-2）');
same('反向同理（GiB@base-10 → GB）', toBytesText(1, 'GiB', false), '1000000000 字节（base-10）');
same('小数结果保留有效位且不留尾零', toBytesText(1.1, 'MiB', true), '1153433.6 字节（base-2）');
same('0 值', toBytesText(0, 'MB', true), '0 字节（base-2）');
same('负数返回空串', toBytesText(-5, 'MB', true), '');
same('NaN 返回空串', toBytesText(Number.NaN, 'MB', true), '');
same('结果里标明所用进制', toBytesText(1, 'B', true).endsWith('（base-2）'), true);
same('base-10 结果里标明 base-10', toBytesText(1, 'B', false).endsWith('（base-10）'), true);

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
