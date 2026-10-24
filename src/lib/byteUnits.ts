/**
 * 字节 / 人类可读 换算核心（V26 从 FileSize 组件里抽出）。
 *
 * 抽出来的原因有两条：
 *
 *   1. **组件里测不了**。这段逻辑此前埋在 `.tsx` 里，Node 回归够不着，
 *      于是「base 开关与单位不同步」这种**静默差 1024 倍**的错误一直没被发现；
 *   2. 单位表原本同时以「数字进制（1024/1000）」和「单位数组」两种形式存在，
 *      开关一翻两边就可能对不上。现在只留一个 `base2: boolean` 入口，两表按下标对齐。
 *
 * 单位口径按 IEC 80000-13：1024 进制用 KiB/MiB/GiB/TiB/PiB，1000 进制用 KB/MB/GB/TB/PB。
 * （注意 `src/lib/utils.ts` 的 `formatBytes` 是另一套「单值 + 1 位小数」的口径，
 *   标签仍写作 KB/MB —— 见 PROJECT_STATUS 遗留清单。）
 */

/** base-2（1024 进制）单位表。 */
export const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** base-10（1000 进制）单位表。 */
export const DECIMAL_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** 该进制下使用的单位表（两表等长、下标一一对应）。 */
export function unitsFor(base2: boolean): readonly string[] {
  return base2 ? BINARY_UNITS : DECIMAL_UNITS;
}

/** 该进制下的进制基数。 */
export function baseOf(base2: boolean): number {
  return base2 ? 1024 : 1000;
}

/**
 * 单位 → 相对字节的倍数。
 *
 * 查不到单位（例如把 base-2 的 `TiB` 拿到 base-10 表里查）时返回 `1`，
 * 所以调用方必须先用 `toMatchingBase` 把单位校准到当前进制 —— 否则会静默算出
 * 「1.5 TiB = 1.5 字节」这种差 1024⁴ 倍的答案。
 */
export function unitFactor(unit: string, base2: boolean): number {
  const index = unitsFor(base2).indexOf(unit);
  return index < 0 ? 1 : baseOf(base2) ** index;
}

/**
 * 把单位换算到指定进制下的等价单位（`KiB ↔ KB`、`MiB ↔ MB` …）。
 *
 * 已经是目标进制的单位原样返回；完全无法识别的单位退到 `B`（两表第 0 项都是 `B`）。
 */
export function toMatchingBase(unit: string, base2: boolean): string {
  const target = unitsFor(base2);
  if (target.includes(unit)) {
    return unit;
  }
  const source = unitsFor(!base2);
  const index = source.indexOf(unit);
  return index < 0 ? 'B' : (target[index] ?? 'B');
}

/** 单个数值的展示文本：整数不带小数点，其余保留两位。 */
function displayAllUnitsValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * 字节数 → 该进制下**所有单位**的对照文本（每行一条）。
 * 负数与非有限值返回空串（UI 直接显示空态）。
 */
export function formatAllUnits(bytes: number, base2: boolean): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  const units = unitsFor(base2);
  const base = baseOf(base2);
  return units
    .map((unit, index) => `${displayAllUnitsValue(bytes / base ** index)} ${unit}`)
    .join('\n');
}

/**
 * 「易读数值 + 单位」→ 字节数文本（反查方向）。
 * 数值非法或负数返回空串。
 *
 * 内部先做一次 `toMatchingBase`：调用方就算把 base-10 的 `GB` 传进 base-2 模式
 * （比如持久化状态里存着旧单位、或者将来有第三个入口），也只会拿到 `GiB` 的正确结果，
 * 而不是 `unitFactor` 兜底的 1 倍。
 */
export function toBytesText(value: number, unit: string, base2: boolean): string {
  if (!Number.isFinite(value) || value < 0) {
    return '';
  }
  const bytes = value * unitFactor(toMatchingBase(unit, base2), base2);
  const display = Number.isInteger(bytes)
    ? String(bytes)
    : bytes.toPrecision(12).replace(/\.?0+$/, '');
  return `${display} 字节（${base2 ? 'base-2' : 'base-10'}）`;
}
