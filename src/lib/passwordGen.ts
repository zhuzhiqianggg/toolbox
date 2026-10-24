/**
 * 密码生成核心（纯逻辑，不依赖 React / DOM / Tauri）。
 *
 * # 为什么单独抽出来
 *
 * V25 之前存在**两份**几乎相同的实现：工具箱「密码生成器」组件内联一份，
 * 密码库「生成」按钮用本文件另一份。两边行为并不一致 —— 工具箱能配符号占比、
 * 能排除易混淆字符，密码库却固定生成「符号可以连着来」的 20 位。
 * 现在只有这一份，两个入口都走它。
 *
 * # 生成顺序（V25 重写）
 *
 *   1. **先定符号数量**：`floor(长度 × 最大符号占比)`，勾了符号类则至少 1 个；
 *   2. **再定符号位置**：[`separatedPositions`] 用「同奇偶位置互不相邻」的性质
 *      一次选出**两两不相邻**的位置 —— 这是「符号不连续」的数学保证，
 *      不是生成完再修补（修补容易陷进死循环，也不好证）；
 *   3. **首尾收字母**（位置优化开启时）：0 号与末位先占字母，符号只在中段选点；
 *   4. **补必含类别**：每个勾选的字符类至少出现一次（站点校验常要求「必须含数字与符号」）；
 *   5. 余位用非符号池填满 —— 于是最终符号数**恰好等于**第 1 步算出的数量。
 *
 * 全程不抛异常：约束不可满足时把原因写进 `notes` 交给界面提示，绝不静默降级。
 */

/** 大写字母表 */
export const UPPER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 小写字母表 */
export const LOWER_CHARS = 'abcdefghijklmnopqrstuvwxyz';
/** 数字表 */
export const DIGIT_CHARS = '0123456789';
/** 默认符号表（密码库使用；工具箱另有自己的分组裁剪逻辑） */
export const DEFAULT_SYMBOL_CHARS = '!@#$%^&*()-_=+[]{};:,.?/~';

/**
 * 默认最大符号占比。
 *
 * V25 从「不限制（1.0）」改成 0.25：用户反馈 16 位密码里冒出 5~6 个符号
 * （`aB3!xY9@kL2#mN8$` 这种）既不必要也不易手输。25% 意味着 16 位最多 4 个符号。
 */
export const DEFAULT_MAX_SYMBOL_RATIO = 0.25;

/** 长度下界（便于同时包含各字符类） */
export const MIN_PASSWORD_LENGTH = 4;
/** 长度上界 */
export const MAX_PASSWORD_LENGTH = 128;

/** 随机整数源：返回 `[0, maxExclusive)` 的整数（测试可注入确定性实现） */
export type RandomInt = (maxExclusive: number) => number;

/**
 * 密码学安全的随机整数 `[0, maxExclusive)`。
 *
 * `crypto.getRandomValues` + 拒绝采样（消除模偏差）；无 Web Crypto 时降级
 * `Math.random`（仅功能兜底，真密钥场景应保证有 Web Crypto）。
 */
export function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) {
    return 0;
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      const value = buf[0] ?? 0;
      if (value < limit) {
        return value % maxExclusive;
      }
    }
  }
  return Math.floor(Math.random() * maxExclusive);
}

/** 是否为字母或数字（用于区分符号） */
export function isAlphanumeric(char: string): boolean {
  return /[A-Za-z0-9]/.test(char);
}

/** 按字符去重（保持首次出现顺序） */
export function dedupeChars(value: string): string {
  let out = '';
  for (const char of value) {
    if (!out.includes(char)) {
      out += char;
    }
  }
  return out;
}

/** Fisher-Yates 原地洗牌 */
export function shuffleInPlace<T>(items: T[], random: RandomInt = randomInt): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    const a = items[i];
    const b = items[j];
    if (a === undefined || b === undefined) {
      continue;
    }
    items[i] = b;
    items[j] = a;
  }
}

/** 从字符池取一个随机字符 */
function pick(pool: string, random: RandomInt): string {
  return pool.charAt(random(pool.length));
}

/** 把整数夹到 `[min, max]` 并取整（非法值退回 `min`） */
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 从数组里随机取 `count` 个（不改动入参） */
function sampleOf(items: readonly number[], count: number, random: RandomInt): number[] {
  const copy = items.slice();
  shuffleInPlace(copy, random);
  return copy.slice(0, Math.min(count, copy.length));
}

/** 连续区间 `[lo, lo + slotCount)` 内的全部位置 */
export function slotRange(lo: number, slotCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < slotCount; i += 1) {
    out.push(lo + i);
  }
  return out;
}

/**
 * 在连续区间 `[lo, lo + slotCount)` 内随机取 `count` 个**两两不相邻**的位置。
 *
 * 原理：相邻两个整数必然一奇一偶，所以**同奇偶的位置之间距离至少为 2**。
 * 先按奇偶分成两组，取容量够的那组随机抽样即可 —— 不需要生成后修补，
 * 也不会出现「修着修着死循环」。
 *
 * 因此单个区间的「不相邻」容量上限是 `ceil(slotCount / 2)`（见 [`separatedCapacity`]）。
 */
export function separatedPositions(
  lo: number,
  slotCount: number,
  count: number,
  random: RandomInt = randomInt,
): number[] {
  if (count <= 0 || slotCount <= 0) {
    return [];
  }
  const even: number[] = [];
  const odd: number[] = [];
  for (const position of slotRange(lo, slotCount)) {
    (position % 2 === 0 ? even : odd).push(position);
  }
  // 两组都够时随机择一，避免符号总落在同一批位置上
  const ordered = random(2) === 0 ? [even, odd] : [odd, even];
  const group = ordered.find((g) => g.length >= count) ?? (even.length >= odd.length ? even : odd);
  return sampleOf(group, count, random);
}

/** 「两两不相邻」在 `slotCount` 个位置里最多能放几个 */
export function separatedCapacity(slotCount: number): number {
  return slotCount <= 0 ? 0 : Math.ceil(slotCount / 2);
}

/** 生成约束 */
export interface GenerateSpec {
  /** 期望长度（会被夹到 4–128） */
  length: number;
  /** 全部可用字符（调用方已按分类 / 排除规则裁剪好） */
  pool: string;
  /** 必须至少出现一次的字符类（每个元素是一个字符池） */
  requiredSets: readonly string[];
  /** 非符号子集（字母 + 数字），用于「最大符号占比」约束 */
  nonSymbols: string;
  /** 符号子集 */
  symbols: string;
  /** 最大符号占比 0–1 */
  maxSymbolRatio: number;
  /** 位置优化：首尾收敛为字母 */
  edgeLetter: boolean;
  /** 符号不连续（尽量不让两个符号挨着） */
  separateSymbols: boolean;
}

/** 生成结果 */
export interface GenerateResult {
  password: string;
  /** 实际符号个数 */
  symbolCount: number;
  /** 因容量 / 字符池限制而未能完全满足的约束说明（空数组 = 完全达成） */
  notes: string[];
}

/**
 * 生成一条密码。约束不可满足时**不抛错**，把原因写进 `notes`。
 *
 * @param spec 生成约束
 * @param random 随机源（测试注入确定性实现）
 */
export function generatePassword(spec: GenerateSpec, random: RandomInt = randomInt): GenerateResult {
  const notes: string[] = [];
  const size = clampInt(spec.length, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH);
  const pool = dedupeChars(spec.pool);
  if (pool === '') {
    return { password: '', symbolCount: 0, notes: ['字符集为空，无法生成'] };
  }

  /** 与最终池交集后的子集（调用方传进来的池可能含有被排除的字符） */
  const intersect = (source: string): string =>
    dedupeChars(source)
      .split('')
      .filter((char) => pool.includes(char))
      .join('');

  const symbolPool = intersect(spec.symbols);
  const nonSymbolPool = intersect(spec.nonSymbols);
  const letterPool = pool.split('').filter((char) => /[A-Za-z]/.test(char)).join('');

  // ① 目标符号数量
  const ratio = Number.isFinite(spec.maxSymbolRatio)
    ? Math.min(1, Math.max(0, spec.maxSymbolRatio))
    : 1;
  const symbolRequired = spec.requiredSets.some((set) =>
    set.split('').some((char) => !isAlphanumeric(char)),
  );
  let wantSymbols = symbolPool === '' ? 0 : Math.floor(size * ratio);
  if (symbolPool !== '' && symbolRequired) {
    wantSymbols = Math.max(1, wantSymbols);
  }

  // ② 符号可选位置：位置优化开启且池中有字母时，避开首尾
  const edge = spec.edgeLetter && letterPool !== '';
  const lo = edge ? 1 : 0;
  const hi = edge ? size - 2 : size - 1;
  const slotCount = hi >= lo ? hi - lo + 1 : 0;

  // ③ 容量收敛（不连续 -> 同奇偶容量；只含符号 -> 约束无法成立）
  const allSymbols = nonSymbolPool === '';
  const separated = spec.separateSymbols && !allSymbols;
  const capacity = separated ? separatedCapacity(slotCount) : slotCount;
  if (wantSymbols > capacity) {
    const before = wantSymbols;
    wantSymbols = Math.max(0, capacity);
    if (separated) {
      notes.push(`「符号不连续」在 ${size} 位里最多放 ${capacity} 个符号，已从 ${before} 个降到 ${wantSymbols} 个`);
    } else {
      notes.push(`可用位置不够，符号已降到 ${wantSymbols} 个`);
    }
  }
  if (spec.separateSymbols && allSymbols && size > 1) {
    notes.push('字符集只含符号，「符号不连续」无法成立');
  }

  // ④ 落位
  const chars: Array<string | null> = new Array<string | null>(size).fill(null);
  if (edge) {
    chars[0] = pick(letterPool, random);
    chars[size - 1] = pick(letterPool, random);
  }
  const positions = separated
    ? separatedPositions(lo, slotCount, wantSymbols, random)
    : sampleOf(slotRange(lo, slotCount), wantSymbols, random);
  for (const position of positions) {
    chars[position] = pick(symbolPool, random);
  }

  // ⑤ 必含类别（符号类通常已在第 ④ 步满足，这里兜底并覆盖字母 / 数字类）
  const empty: number[] = [];
  for (let i = 0; i < size; i += 1) {
    if (chars[i] === null) {
      empty.push(i);
    }
  }
  shuffleInPlace(empty, random);
  for (const set of spec.requiredSets) {
    const setPool = intersect(set);
    if (setPool === '') {
      continue;
    }
    const already = chars.some((char) => char !== null && setPool.includes(char));
    if (already) {
      continue;
    }
    const slot = empty.pop();
    if (slot === undefined) {
      notes.push('长度不足，无法保证每一类字符都出现');
      break;
    }
    chars[slot] = pick(setPool, random);
  }

  // ⑥ 余位填充：优先非符号池，于是符号数恰好停在第 ① 步的目标上
  const filler = nonSymbolPool !== '' ? nonSymbolPool : symbolPool !== '' ? symbolPool : pool;
  while (empty.length > 0) {
    const slot = empty.pop();
    if (slot === undefined) {
      break;
    }
    chars[slot] = pick(filler, random);
  }

  const password = chars.map((char) => char ?? '').join('');
  const symbolCount = password.split('').filter((char) => !isAlphanumeric(char)).length;
  return { password, symbolCount, notes };
}

// ————————————————————————————————————————————————————————————————
// 强度评估
// ————————————————————————————————————————————————————————————————

/** 强度档位文案（下标 = score） */
export const STRENGTH_LABELS: readonly string[] = ['很弱', '弱', '中等', '强', '极强'];

/** 强度评估结果 */
export interface PasswordStrength {
  /** 0–4：很弱 / 弱 / 中等 / 强 / 极强 */
  score: number;
  label: string;
  /** 改进建议（无短板时给出正向说明） */
  feedback: string[];
  /** 熵（bit） */
  entropy: number;
}

/** 是否含连续（abc / 321）或重复（aaa / 111）片段 */
export function hasSequentialOrRepeated(value: string): boolean {
  let repeat = 1;
  let ascend = 1;
  let descend = 1;
  for (let i = 1; i < value.length; i += 1) {
    const prev = value.charCodeAt(i - 1);
    const curr = value.charCodeAt(i);
    repeat = curr === prev ? repeat + 1 : 1;
    ascend = curr === prev + 1 ? ascend + 1 : 1;
    descend = curr === prev - 1 ? descend + 1 : 1;
    if (repeat >= 3 || ascend >= 3 || descend >= 3) {
      return true;
    }
  }
  return false;
}

/** 相邻两字符是否都是符号（用于界面展示「是否已达成不连续」） */
export function hasAdjacentSymbols(value: string): boolean {
  for (let i = 1; i < value.length; i += 1) {
    const prev = value[i - 1] ?? '';
    const curr = value[i] ?? '';
    if (prev !== '' && curr !== '' && !isAlphanumeric(prev) && !isAlphanumeric(curr)) {
      return true;
    }
  }
  return false;
}

/** 综合强度评分：熵值定档，字符种类与连续/重复缺陷扣分。 */
export function evaluatePasswordStrength(password: string, poolSize: number): PasswordStrength {
  const entropy = password.length * Math.log2(Math.max(2, poolSize));
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const classCount = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;
  const sequential = hasSequentialOrRepeated(password);

  const feedback: string[] = [];
  if (password.length > 0 && password.length < 12) {
    feedback.push('长度低于 12，建议至少 12 位');
  }
  if (!hasUpper) {
    feedback.push('缺少大写字母');
  }
  if (!hasLower) {
    feedback.push('缺少小写字母');
  }
  if (!hasDigit) {
    feedback.push('缺少数字');
  }
  if (!hasSymbol) {
    feedback.push('缺少符号');
  }
  if (sequential) {
    feedback.push('包含连续或重复字符（如 abc / 111）');
  }

  let score = 0;
  if (entropy >= 100) {
    score = 4;
  } else if (entropy >= 75) {
    score = 3;
  } else if (entropy >= 55) {
    score = 2;
  } else if (entropy >= 35) {
    score = 1;
  }
  if (classCount <= 2) {
    score = Math.max(0, score - 1);
  }
  if (sequential) {
    score = Math.max(0, score - 1);
  }

  if (feedback.length === 0) {
    feedback.push(`熵约 ${Math.round(entropy)} bit，字符组合充分`);
  }

  return {
    score,
    label: STRENGTH_LABELS[score] ?? '很弱',
    feedback,
    entropy,
  };
}

/**
 * 生成一条强密码（密码库「生成」按钮用）。
 *
 * 四类字符齐全、首尾字母、符号不超过 25% 且互不相邻。
 */
export function generateStrongPassword(length = 20, random: RandomInt = randomInt): string {
  const pool = UPPER_CHARS + LOWER_CHARS + DIGIT_CHARS + DEFAULT_SYMBOL_CHARS;
  return generatePassword(
    {
      length,
      pool,
      requiredSets: [UPPER_CHARS, LOWER_CHARS, DIGIT_CHARS, DEFAULT_SYMBOL_CHARS],
      nonSymbols: UPPER_CHARS + LOWER_CHARS + DIGIT_CHARS,
      symbols: DEFAULT_SYMBOL_CHARS,
      maxSymbolRatio: DEFAULT_MAX_SYMBOL_RATIO,
      edgeLetter: true,
      separateSymbols: true,
    },
    random,
  ).password;
}
