/**
 * passwordGen.ts 回归（V25 新增）。
 *
 * # 用户反馈
 *
 * 「关于密码特殊字符太多了，另外特殊字符尽量不要连着出现多个特殊字符」
 *
 * 于是有两条**必须可证**的契约，光靠肉眼看几条样例不算：
 *
 *   1. **符号个数**受「最大符号占比」约束 —— 但勾了符号类时至少 1 个，
 *      且最终符号数应当**恰好等于**算出来的目标值（不是「不超过」就算了）；
 *   2. **任意两个符号都不相邻** —— 这条用「同奇偶位置互不相邻」的构造保证，
 *      所以可以用确定性随机源把边界情形全部打一遍，而不是靠概率赌。
 *
 * 另外守住几条历史约定：首尾为字母、每个勾选的字符类至少出现一次、
 * 长度与字符集都不越界、约束不可能满足时**写 notes 而不抛错**。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import {
  DEFAULT_MAX_SYMBOL_RATIO,
  DIGIT_CHARS,
  LOWER_CHARS,
  UPPER_CHARS,
  evaluatePasswordStrength,
  generatePassword,
  generateStrongPassword,
  hasAdjacentSymbols,
  separatedCapacity,
  separatedPositions,
} from '../../src/lib/passwordGen.ts';

const SYMBOLS = '!@#$%^&*()-_=+';
const ALNUM = UPPER_CHARS + LOWER_CHARS + DIGIT_CHARS;

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

/**
 * 确定性随机源（mulberry32）。
 *
 * 用它跑上千次，就能把「随机」变成可复现的实验：失败可以精确定位到某一次。
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把「连续均匀随机」包成 randomInt(maxExclusive) */
function intSource(seed) {
  const next = mulberry32(seed);
  return (maxExclusive) => Math.floor(next() * maxExclusive);
}

/** 一次标准生成（四类齐全 + 首尾字母 + 不连续） */
function gen(seed, length, maxSymbolRatio, extra = {}) {
  const pool = ALNUM + SYMBOLS;
  return generatePassword(
    {
      length,
      pool,
      requiredSets: [UPPER_CHARS, LOWER_CHARS, DIGIT_CHARS, SYMBOLS],
      nonSymbols: ALNUM,
      symbols: SYMBOLS,
      maxSymbolRatio,
      edgeLetter: true,
      separateSymbols: true,
      ...extra,
    },
    intSource(seed),
  );
}

const countSymbols = (value) => value.split('').filter((c) => !/[A-Za-z0-9]/.test(c)).length;

/* ================================================================== *
 * 1) separatedPositions：不相邻是「构造保证」，不是概率
 * ================================================================== */

ok('separatedCapacity(0) = 0', separatedCapacity(0) === 0);
ok('separatedCapacity(1) = 1', separatedCapacity(1) === 1);
ok('separatedCapacity(2) = 1', separatedCapacity(2) === 1);
ok('separatedCapacity(5) = 3', separatedCapacity(5) === 3);
ok('separatedCapacity(18) = 9', separatedCapacity(18) === 9);

{
  let allSeparated = true;
  let allInRange = true;
  let allUnique = true;
  for (let seed = 1; seed <= 300; seed += 1) {
    const picked = separatedPositions(1, 18, 9, intSource(seed));
    if (picked.length !== 9) {
      allSeparated = false;
    }
    if (new Set(picked).size !== picked.length) {
      allUnique = false;
    }
    if (picked.some((p) => p < 1 || p > 18)) {
      allInRange = false;
    }
    const sorted = picked.slice().sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] - sorted[i - 1] < 2) {
        allSeparated = false;
      }
    }
  }
  ok('满容量取点：300 次都拿到 count 个', allSeparated, '至少一次数量不足或出现相邻位置');
  ok('取点不重复', allUnique);
  ok('取点不越界', allInRange, '区间为 [1, 18]');
}

ok('count 超过容量时不会凭空补齐', separatedPositions(0, 4, 9, intSource(7)).length <= 2);
ok('count = 0 返回空数组', separatedPositions(1, 10, 0, intSource(7)).length === 0);
ok('slotCount = 0 返回空数组', separatedPositions(1, 0, 3, intSource(7)).length === 0);

/* ================================================================== *
 * 2) 生成的密码：符号不相邻 + 数量恰好等于目标
 * ================================================================== */

/**
 * 期望符号数：与实现同一条规则的**独立表述**（勾了符号类至少 1 个，
 * 再被「不连续」容量封顶）。长度 40 / 占比 50% 想要 20 个，
 * 但 40 位里首尾占掉两位后只剩 38 个候选位置，同奇偶最多 19 个 —— 所以收敛是对的。
 */
function expectedSymbols(length, ratio) {
  const want = Math.max(1, Math.floor(length * ratio));
  return Math.min(want, separatedCapacity(length - 2));
}

for (const [length, ratio] of [
  [8, 0.25],
  [12, 0.25],
  [16, 0.25],
  [16, 0.1],
  [20, 0.25],
  [32, 0.25],
  [40, 0.5],
  [16, 0],
]) {
  const want = expectedSymbols(length, ratio);
  let adjacent = 0;
  let wrongCount = 0;
  let wrongLength = 0;
  let outOfPool = 0;
  let edgeNotLetter = 0;
  let missingClass = 0;
  let samples = 0;
  const first = [];

  for (let seed = 1; seed <= 200; seed += 1) {
    const { password, symbolCount, notes } = gen(seed, length, ratio);
    if (password.length !== length) {
      wrongLength += 1;
    }
    if (hasAdjacentSymbols(password)) {
      adjacent += 1;
      if (first.length < 3) {
        first.push(password);
      }
    }
    if (symbolCount !== want) {
      wrongCount += 1;
      if (first.length < 3) {
        first.push(`${password} (符号 ${symbolCount} ≠ ${want})`);
      }
    }
    if (keepOnly(password, ALNUM + SYMBOLS) !== password) {
      outOfPool += 1;
    }
    if (!/^[A-Za-z]/.test(password) || !/[A-Za-z]$/.test(password)) {
      edgeNotLetter += 1;
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      missingClass += 1;
    }
    if (notes.length > 0) {
      outOfPool += 0; // notes 允许出现，单独断言
    }
    samples += 1;
  }

  const tag = `长度 ${length} / 占比 ${ratio}`;
  ok(`${tag}：长度恒等于 ${length}`, wrongLength === 0, `${wrongLength}/${samples} 次不符`);
  ok(`${tag}：符号两两不相邻`, adjacent === 0, `${adjacent}/${samples} 次出现相邻符号：${first.join(' | ')}`);
  ok(`${tag}：符号数恒等于 ${want}`, wrongCount === 0, `${wrongCount}/${samples} 次不符：${first.join(' | ')}`);
  ok(`${tag}：字符全部来自字符池`, outOfPool === 0);
  ok(`${tag}：首尾都是字母`, edgeNotLetter === 0);
  ok(`${tag}：大小写 / 数字 / 符号四类齐全`, missingClass === 0);
}

function keepOnly(value, allow) {
  return value
    .split('')
    .filter((c) => allow.includes(c))
    .join('');
}

/* ---- 占比超出「不连续」容量：必须收敛并说明，而不是悄悄放两个挨着的符号 ---- */
{
  const r = gen(5, 40, 0.5);
  ok('占比超出容量：符号数收敛到容量', r.symbolCount === separatedCapacity(38), String(r.symbolCount));
  ok('占比超出容量：给出收敛说明', /不连续/.test(r.notes.join(' ')), JSON.stringify(r.notes));
  ok('占比超出容量：结果仍不相邻', !hasAdjacentSymbols(r.password), r.password);
  ok('占比超出容量：长度与四类仍成立', r.password.length === 40 && /\d/.test(r.password));
}

/* ================================================================== *
 * 3) 约束冲突：写 notes，不抛错、不死循环
 * ================================================================== */

{
  // 长度 6 + 占比 100%：不连续容量只有 2（位置 1..4 -> 同奇偶 2 个）
  const r = gen(3, 6, 1);
  ok('短密码 + 高占比：能出结果', r.password.length === 6);
  ok('短密码 + 高占比：符号仍不相邻', !hasAdjacentSymbols(r.password), r.password);
  ok('短密码 + 高占比：给出收敛说明', r.notes.length > 0, JSON.stringify(r.notes));
  ok('短密码 + 高占比：说明里点明容量', /不连续/.test(r.notes.join(' ')), JSON.stringify(r.notes));
}

{
  // 只勾符号：不连续无法成立，必须明说
  const r = generatePassword(
    {
      length: 12,
      pool: SYMBOLS,
      requiredSets: [SYMBOLS],
      nonSymbols: '',
      symbols: SYMBOLS,
      maxSymbolRatio: 1,
      edgeLetter: true,
      separateSymbols: true,
    },
    intSource(9),
  );
  ok('只含符号：仍能生成', r.password.length === 12);
  ok('只含符号：明说「不连续」无法成立', /无法成立/.test(r.notes.join(' ')), JSON.stringify(r.notes));
}

{
  // 空池：返回空串 + 说明
  const r = generatePassword(
    {
      length: 16,
      pool: '',
      requiredSets: [''],
      nonSymbols: '',
      symbols: '',
      maxSymbolRatio: 1,
      edgeLetter: true,
      separateSymbols: true,
    },
    intSource(1),
  );
  ok('空字符池：返回空密码不抛错', r.password === '', r.password);
  ok('空字符池：给出说明', r.notes.length > 0);
}

{
  // 池里没有字母：位置优化必须自动跳过（否则首尾无法落字母）
  const r = generatePassword(
    {
      length: 16,
      pool: DIGIT_CHARS + SYMBOLS,
      requiredSets: [DIGIT_CHARS, SYMBOLS],
      nonSymbols: DIGIT_CHARS,
      symbols: SYMBOLS,
      maxSymbolRatio: 0.25,
      edgeLetter: true,
      separateSymbols: true,
    },
    intSource(11),
  );
  ok('池中无字母：长度正确且不抛错', r.password.length === 16);
  ok('池中无字母：符号仍不相邻', !hasAdjacentSymbols(r.password), r.password);
}

/* ================================================================== *
 * 4) 首尾字母关闭时仍守长度与类别
 * ================================================================== */

{
  let bad2 = 0;
  for (let seed = 1; seed <= 100; seed += 1) {
    const r = gen(seed, 20, 0.25, { edgeLetter: false });
    if (r.password.length !== 20 || !/\d/.test(r.password)) {
      bad2 += 1;
    }
    if (hasAdjacentSymbols(r.password)) {
      bad2 += 1;
    }
  }
  ok('关闭位置优化：长度 / 数字 / 不连续三条都还成立', bad2 === 0, `${bad2} 次不符`);
}

/* ================================================================== *
 * 5) 密码库入口 generateStrongPassword：20 位、四类齐全、不连续
 * ================================================================== */

{
  let problem = 0;
  let sample = '';
  let maxSymbols = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    const pwd = generateStrongPassword(20, intSource(seed));
    if (seed === 1) {
      sample = pwd;
    }
    const n = countSymbols(pwd);
    maxSymbols = Math.max(maxSymbols, n);
    if (pwd.length !== 20 || hasAdjacentSymbols(pwd)) {
      problem += 1;
    }
    if (!/[A-Z]/.test(pwd) || !/[a-z]/.test(pwd) || !/\d/.test(pwd) || n === 0) {
      problem += 1;
    }
    if (!/^[A-Za-z]/.test(pwd) || !/[A-Za-z]$/.test(pwd)) {
      problem += 1;
    }
  }
  const expected = Math.max(1, Math.floor(20 * DEFAULT_MAX_SYMBOL_RATIO));
  ok('密码库生成：200 次全部合规', problem === 0, `${problem} 次不符，样例 ${sample}`);
  ok(`密码库生成：符号数 ≤ ${expected}（默认占比 ${DEFAULT_MAX_SYMBOL_RATIO}）`, maxSymbols <= expected, `实测最多 ${maxSymbols} 个`);
  ok('密码库生成：符号数正好是目标值', maxSymbols === expected, `实测最多 ${maxSymbols} 个，期望 ${expected}`);
  ok('默认占比已从 100% 降下来', DEFAULT_MAX_SYMBOL_RATIO <= 0.3, String(DEFAULT_MAX_SYMBOL_RATIO));
}

/* ================================================================== *
 * 6) 强度评估
 * ================================================================== */

{
  const weak = evaluatePasswordStrength('abc123', 26);
  ok('短弱密码评低分', weak.score <= 1, `${weak.score} ${weak.label}`);
  ok('短弱密码给出「长度不足」建议', weak.feedback.some((f) => /长度/.test(f)), JSON.stringify(weak.feedback));

  const strong = evaluatePasswordStrength('aB3k!Rm9XqL2wZt7v', 62);
  ok('长且多类的密码评高分', strong.score >= 3, `${strong.score} ${strong.label}`);
  ok('高强度不再输出短板建议', strong.feedback.every((f) => !/缺少|低于/.test(f)), JSON.stringify(strong.feedback));

  const repeated = evaluatePasswordStrength('aB3!aaaRm9XqL2wZt', 62);
  ok('含重复片段会被扣分', repeated.feedback.some((f) => /连续或重复/.test(f)), JSON.stringify(repeated.feedback));

  ok('空密码不抛错', evaluatePasswordStrength('', 26).entropy === 0);
}

/* ================================================================== *
 * 7) 确定性：同一随机种子必须复现同一条密码（回归可比对）
 * ================================================================== */

{
  const a = gen(20260916, 16, 0.25).password;
  const b = gen(20260916, 16, 0.25).password;
  ok('同种子结果可复现', a === b, `${a} vs ${b}`);
  ok('不同种子结果不同', gen(1, 16, 0.25).password !== gen(2, 16, 0.25).password);
}

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
