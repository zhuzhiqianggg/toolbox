/**
 * Cron 表达式引擎（纯函数，无框架 / 无依赖）。
 *
 * # 为什么自己写
 *
 * 原实现只有「5 段 → 一句中文」，用户反馈「太简单了，需要加强优化增强功能」。
 * 一个能用的 Cron 工具至少要能回答三个问题：
 *   1. **它到底什么意思**（字段级拆解，而不是一句话糊过去）；
 *   2. **它下次什么时候跑**（人脑算不出 `0 9 * * 1-5` 的下一次是几号）；
 *   3. **我写错了哪里**（错误要定位到具体第几段，而不是「格式不对」）。
 * 再加一个反向入口（「每天 9 点」→ `0 9 * * *`），才算闭环。
 *
 * # 支持的语法
 *
 * - **标准 5 段**：`分 时 日 月 周`；
 * - **Quartz 6 / 7 段**：`秒 分 时 日 月 周 [年]`（第 1 段是秒，别搞混）；
 * - 通配 `*`、`?`（Quartz，等价于「不指定」）、列表 `a,b,c`、范围 `a-b`、
 *   步长（`*` 斜杠 n，或 `a-b` 斜杠 n，或 `N` 斜杠 n）；
 *   其中 **`N/step` 按 Quartz 口径**理解为「从 N 起、每 step 一次、直到该字段上限」——
 *   所以 `0/30 * * * * ?` 真的是「每 30 秒」，而不是「只有第 0 秒」。
 *   （Vixie 老实现对 `N/step` 只取 N 一个值，两种口径在真实世界都存在；
 *   本工具选 Quartz 口径并在界面上把展开后的取值列出来，避免用户猜。）
 * - 别名月份 `JAN`-`DEC` / 星期 `SUN`-`SAT`；
 * - Quartz 扩展：`L`（当月最后一天）、`15W`（离 15 号最近的工作日）、
 *   `1#2`（当月第 2 个周一）、`5L`（当月最后一个周五）；
 * - 宏：`@yearly` `@annually` `@monthly` `@weekly` `@daily` `@midnight` `@hourly`。
 *
 * # 日 / 周同时限定时按 Vixie cron 语义取**或**（`0 0 1 * 1` = 每月 1 号**或**每周一，
 * 不是「1 号且是周一」）。这是最容易踩的坑，界面上单独提示。
 */

// ————————————————————————————————————————————————————————————————
// 类型
// ————————————————————————————————————————————————————————————————

export type CronFieldKey = 'second' | 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek' | 'year';

/** 字段规格（取值范围与别名） */
interface FieldSpec {
  key: CronFieldKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** 名称别名 → 数值（JAN/MON 等） */
  aliases?: Record<string, number>;
  /** 数值 → 中文名（渲染星期 / 月份用） */
  nameOf?: (value: number) => string;
  /** 是否支持 Quartz 的 L / W / # 扩展 */
  quartzy?: boolean;
  /** 取值范围的人类可读说明（界面上的「怎么写」提示） */
  hint: string;
}

/** 单字段解析结果 */
export interface CronFieldResult {
  key: CronFieldKey;
  label: string;
  raw: string;
  /** 中文解释 */
  text: string;
  /** 是否通配（`*` / `?`） */
  wildcard: boolean;
  /** 解析是否成功 */
  ok: boolean;
  /** 失败原因（仅 ok=false） */
  error?: string;
  /** 展开后的具体取值（特殊语法时为 null） */
  values: number[] | null;
}

/** 整体分析结果 */
export interface CronAnalysis {
  ok: boolean;
  /** 整体错误（含出错字段名） */
  error?: string;
  /** 表达式形态 */
  form: 'macro' | 'standard' | 'quartz';
  /** 字段拆解 */
  fields: CronFieldResult[];
  /** 一句话中文描述 */
  summary: string;
  /** 未来若干次执行时间（毫秒时间戳） */
  next: number[];
  /** 是否「日 / 周同时限定」（Vixie 取或，提示用） */
  dayOrWeek: boolean;
  /** 规范化后的表达式（宏展开 / 别名还原） */
  normalized: string;
}

// ————————————————————————————————————————————————————————————————
// 字段规格
// ————————————————————————————————————————————————————————————————

const WEEKDAY_CN: readonly string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MONTH_CN: readonly string[] = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
];

const DOW_ALIASES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};
const MONTH_ALIASES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** 星期取值 0-7（0 与 7 均为周日，标准 cron 允许 7） */
const SPEC_DOW: FieldSpec = {
  key: 'dayOfWeek',
  label: '星期',
  unit: '星期',
  min: 0,
  max: 7,
  aliases: DOW_ALIASES,
  nameOf: (value: number): string => WEEKDAY_CN[value % 7] ?? String(value),
  quartzy: true,
  hint: '0-7（0 和 7 都是周日）或 SUN-SAT；Quartz 可用 L / 5L / 1#2',
};

const SPECS: readonly FieldSpec[] = [
  { key: 'second', label: '秒', unit: '秒', min: 0, max: 59, hint: '0-59（仅 Quartz 6/7 段）' },
  { key: 'minute', label: '分', unit: '分', min: 0, max: 59, hint: '0-59；*/5 = 每 5 分钟' },
  { key: 'hour', label: '时', unit: '时', min: 0, max: 23, hint: '0-23；*/2 = 每 2 小时' },
  {
    key: 'dayOfMonth',
    label: '日',
    unit: '日',
    min: 1,
    max: 31,
    quartzy: true,
    // 给「日」配上中文名（3 → 3日）：否则逐段编辑的灰字只会显示裸的「3」，
    // 一句话描述也会拼出「每月3」这种缺单位的句子
    nameOf: (value: number): string => `${value}日`,
    hint: '1-31；Quartz 可用 L（最后一天）/ 15W',
  },
  {
    key: 'month',
    label: '月',
    unit: '月',
    min: 1,
    max: 12,
    aliases: MONTH_ALIASES,
    nameOf: (v: number): string => MONTH_CN[v - 1] ?? String(v),
    hint: '1-12 或 JAN-DEC',
  },
  SPEC_DOW,
  { key: 'year', label: '年', unit: '年', min: 1970, max: 2199, hint: '1970-2199（仅 Quartz 7 段）' },
];

/** 界面用的段规格（只暴露界面需要的字段，`FieldSpec` 本身保持内部实现细节） */
export interface CronFieldSpec {
  key: CronFieldKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** 取值范围 / 写法的可读提示 */
  hint: string;
}

/**
 * 按段数取出各段的「界面规格」（标签 / 取值范围 / 提示）。
 *
 * 给界面用的：`CronDescriptor` 要按段数渲染一排**与表达式逐段对齐**的输入框，
 * 而不是把「分 时 日 月 周」当一行装饰性文字挂在下面。
 *
 * @param segmentCount 表达式段数（5 / 6 / 7）
 * @returns 各段规格；段数非法时返回 null（此时界面只让用户编原始表达式）
 */
export function fieldLayout(segmentCount: number): readonly CronFieldSpec[] | null {
  if (segmentCount === 5) {
    return SPECS.filter((spec) => spec.key !== 'second' && spec.key !== 'year');
  }
  if (segmentCount === 6) {
    return SPECS.filter((spec) => spec.key !== 'year');
  }
  if (segmentCount === 7) {
    return SPECS;
  }
  return null;
}

/** 宏 → 标准表达式 */
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

// ————————————————————————————————————————————————————————————————
// 字段解析
// ————————————————————————————————————————————————————————————————

/** 解析一个数字 / 别名，失败返回 null */
function resolveValue(spec: FieldSpec, token: string): number | null {
  const upper = token.toUpperCase();
  const alias = spec.aliases?.[upper];
  if (alias !== undefined) {
    return alias;
  }
  if (!/^\d+$/.test(token)) {
    return null;
  }
  return Number.parseInt(token, 10);
}

/** 字段内的「特殊语法」谓词（L / W / # 无法用值集合表达） */
interface Specials {
  /** 当月最后一天 */
  lastDayOfMonth: boolean;
  /** 离该日最近的工作日 */
  nearestWeekday: number | null;
  /** 当月最后一个指定星期几 */
  lastWeekday: number | null;
  /** 第 n 个星期几 */
  nthWeekday: { dow: number; nth: number } | null;
}

/** 编译后的字段（含匹配函数） */
interface CompiledField {
  result: CronFieldResult;
  /** 值集合；null = 通配（全匹配） */
  values: Set<number> | null;
  specials: Specials;
  /** 单一固定值（秒级扫描优化用；非单一返回 null） */
  single: number | null;
}

function emptySpecials(): Specials {
  return { lastDayOfMonth: false, nearestWeekday: null, lastWeekday: null, nthWeekday: null };
}

/** 解析单个字段 */
function compileField(spec: FieldSpec, raw: string): CompiledField {
  const result: CronFieldResult = {
    key: spec.key,
    label: spec.label,
    raw,
    text: '',
    wildcard: false,
    ok: true,
    values: null,
  };
  const specials = emptySpecials();
  const fail = (message: string): CompiledField => {
    result.ok = false;
    result.error = message;
    result.text = '无法解析';
    return { result, values: null, specials, single: null };
  };

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fail('字段为空');
  }
  if (trimmed === '*' || trimmed === '?') {
    result.wildcard = true;
    result.text = '每' + spec.unit;
    result.values = null;
    return { result, values: null, specials, single: null };
  }

  const values = new Set<number>();
  const parts = trimmed.split(',');
  /** 用于生成中文描述的片段 */
  const texts: string[] = [];
  let single: number | null = null;

  for (const part of parts) {
    if (part.length === 0) {
      return fail('列表中有空项');
    }
    // 步长：`*/n` 或 `a-b/n`
    const slash = part.indexOf('/');
    const base = slash >= 0 ? part.slice(0, slash) : part;
    const stepText = slash >= 0 ? part.slice(slash + 1) : null;
    let step: number | null = null;
    if (stepText !== null) {
      if (!/^\d+$/.test(stepText) || Number.parseInt(stepText, 10) === 0) {
        return fail(`步长「${stepText}」必须是正整数`);
      }
      step = Number.parseInt(stepText, 10);
    }

    // —— Quartz 特殊语法 ——
    if (spec.quartzy && step === null) {
      const upper = base.toUpperCase();
      // 日：L = 当月最后一天
      if (spec.key === 'dayOfMonth' && upper === 'L') {
        specials.lastDayOfMonth = true;
        texts.push('最后一天');
        continue;
      }
      // 日：15W = 离 15 号最近的工作日
      if (spec.key === 'dayOfMonth' && upper.endsWith('W')) {
        const day = resolveValue(spec, upper.slice(0, -1));
        if (day === null) {
          return fail('「W」前必须是具体日期，如 15W');
        }
        specials.nearestWeekday = day;
        texts.push(`离 ${day} 日最近的工作日`);
        continue;
      }
      // 星期：5L = 当月最后一个周五；L 单独 = 周六（Quartz 语义）
      if (spec.key === 'dayOfWeek' && upper.endsWith('L')) {
        const head = upper.slice(0, -1);
        const day = head.length === 0 ? 6 : resolveValue(spec, head);
        if (day === null) {
          return fail('「L」前必须是具体星期，如 5L');
        }
        specials.lastWeekday = day;
        texts.push(`最后一个${WEEKDAY_CN[day % 7] ?? day}`);
        continue;
      }
      // 星期：1#2 = 当月第 2 个周一
      const hash = upper.indexOf('#');
      if (spec.key === 'dayOfWeek' && hash > 0) {
        const dow = resolveValue(spec, upper.slice(0, hash));
        const nthToken = upper.slice(hash + 1);
        const nth = /^\d+$/.test(nthToken) ? Number.parseInt(nthToken, 10) : null;
        if (dow === null || nth === null || nth < 1 || nth > 5) {
          return fail('「#」语法应为「星期#第几个」，第几个取值 1-5');
        }
        specials.nthWeekday = { dow, nth };
        texts.push(`第 ${nth} 个${WEEKDAY_CN[dow % 7] ?? dow}`);
        continue;
      }
    }

    // —— 范围 / 单值 ——
    let from: number;
    let to: number;
    /** base 是「光秃秃一个数」（既不是 `*` 也不是 `a-b`）—— 决定 `N/step` 怎么展开 */
    let bareSingle = false;
    if (base === '*') {
      from = spec.min;
      to = spec.max;
    } else {
      const dash = base.indexOf('-', 1);
      if (dash > 0) {
        const head = resolveValue(spec, base.slice(0, dash));
        const tail = resolveValue(spec, base.slice(dash + 1));
        if (head === null || tail === null) {
          return fail(`范围「${base}」含非法值`);
        }
        from = head;
        to = tail;
        if (from > to) {
          return fail(`范围「${base}」起点大于终点`);
        }
      } else {
        const value = resolveValue(spec, base);
        if (value === null) {
          return fail(`「${base}」不是合法${spec.label}值`);
        }
        from = value;
        to = value;
        bareSingle = true;
      }
    }
    if (from < spec.min || to > spec.max) {
      return fail(`「${base}」超出取值范围 ${spec.min}-${spec.max}`);
    }
    // `N/step`（如 Quartz 的 `0/10` 秒）语义是「从 N 起、每 step 一次、直到字段上限」，
    // 不是「只有 N 这一下」—— 这正是 `0/30 * * * * ?` 敢叫「每 30 秒」的原因。
    // 单值 + 步长时把范围右端撑到 max；`a-b/step` 保持原区间不动。
    if (bareSingle && step !== null) {
      to = spec.max;
    }

    const stride = step ?? 1;
    if (from === to && step === null) {
      values.add(from);
      single = from;
      texts.push(spec.nameOf ? spec.nameOf(from) : String(from));
      continue;
    }
    const partValues: number[] = [];
    for (let value = from; value <= to; value += stride) {
      values.add(value);
      partValues.push(value);
    }
    if (spec.nameOf) {
      // 有中文名的段（日 / 月 / 星期）一律用名字说话：
      //   区间   → 「周一 至 周五」「1月 至 3月」（旧的「1 至 5星期」语序是坏的）
      //   带步长 → 直接把取值列出来（dow 最多 7 个、月 12 个，dom 超 12 个再退回紧凑写法）
      if (step === null) {
        texts.push(`${spec.nameOf(from)} 至 ${spec.nameOf(to)}`);
        single = null;
      } else if (partValues.length <= 12) {
        texts.push(partValues.map((value) => spec.nameOf!(value)).join('、'));
        single = null;
      } else {
        texts.push(`${from}-${to} 每 ${step} ${spec.unit}`);
        single = null;
      }
    } else if (step === null) {
      texts.push(`${from} 至 ${to}${spec.unit}`);
      single = null;
    } else if (base === '*') {
      texts.push(`每 ${step} ${spec.unit}`);
      single = null;
    } else if (bareSingle) {
      texts.push(`从 ${from} 起每 ${step} ${spec.unit}`);
      single = null;
    } else {
      texts.push(`${from}-${to} 每 ${step} ${spec.unit}`);
      single = null;
    }
  }

  // 星期 7 归一为 0（周日），避免 `0,7` 这种写法产生两个「同一个星期」
  if (spec.key === 'dayOfWeek' && values.has(7)) {
    values.delete(7);
    values.add(0);
  }

  result.values = [...values].sort((a, b) => a - b);
  result.text = texts.join('、');
  // 多个 part 时 single 无意义
  if (parts.length > 1) {
    single = null;
  }
  return { result, values, specials, single };
}

// ————————————————————————————————————————————————————————————————
// 日期匹配
// ————————————————————————————————————————————————————————————————

/** 当月天数 */
function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

/** 判断某字段是否命中给定值（dom 用 date 提供上下文以支持 L / W / #） */
function fieldMatches(field: CompiledField, value: number, date: Date): boolean {
  if (field.values === null) {
    const { specials } = field;
    if (
      !specials.lastDayOfMonth &&
      specials.nearestWeekday === null &&
      specials.lastWeekday === null &&
      specials.nthWeekday === null
    ) {
      return true; // 通配
    }
    if (specials.lastDayOfMonth && value === daysInMonth(date.getFullYear(), date.getMonth() + 1)) {
      return true;
    }
    if (specials.nearestWeekday !== null) {
      const total = daysInMonth(date.getFullYear(), date.getMonth() + 1);
      const target = Math.min(specials.nearestWeekday, total);
      const weekday = new Date(date.getFullYear(), date.getMonth(), target).getDay();
      // 周六 → 提前到周五；周日 → 顺延到周一（Quartz 语义）
      let actual = target;
      if (weekday === 6) {
        actual = target === 1 ? target + 2 : target - 1;
      } else if (weekday === 0) {
        actual = target >= total ? target - 2 : target + 1;
      }
      if (value === actual) {
        return true;
      }
    }
    if (specials.lastWeekday !== null) {
      const total = daysInMonth(date.getFullYear(), date.getMonth() + 1);
      for (let day = total; day > total - 7; day -= 1) {
        const weekday = new Date(date.getFullYear(), date.getMonth(), day).getDay();
        if (weekday === specials.lastWeekday % 7) {
          if (value === day) {
            return true;
          }
          break;
        }
      }
    }
    if (specials.nthWeekday !== null) {
      const { dow, nth } = specials.nthWeekday;
      const total = daysInMonth(date.getFullYear(), date.getMonth() + 1);
      let count = 0;
      for (let day = 1; day <= total; day += 1) {
        if (new Date(date.getFullYear(), date.getMonth(), day).getDay() === dow % 7) {
          count += 1;
          if (count === nth && value === day) {
            return true;
          }
        }
      }
    }
    return false;
  }
  return field.values.has(value);
}

/** 编译后的表达式（供 nextRuns 与 UI 复用） */
export interface CompiledCron {
  fields: Partial<Record<CronFieldKey, CompiledField>>;
  hasSeconds: boolean;
  hasYear: boolean;
}

/** 某个具体时刻是否命中 */
export function dateMatches(cron: CompiledCron, date: Date): boolean {
  const { fields } = cron;
  const month = fields.month;
  if (month && !fieldMatches(month, date.getMonth() + 1, date)) {
    return false;
  }
  const year = fields.year;
  if (year && !fieldMatches(year, date.getFullYear(), date)) {
    return false;
  }

  const dom = fields.dayOfMonth;
  const dow = fields.dayOfWeek;
  const domRestricted = dom !== undefined && !dom.result.wildcard;
  const dowRestricted = dow !== undefined && !dow.result.wildcard;
  if (domRestricted && dowRestricted) {
    // Vixie cron：日与周同时限定时**取或**
    const domOk = fieldMatches(dom, date.getDate(), date);
    const dowOk = fieldMatches(dow, date.getDay(), date);
    if (!domOk && !dowOk) {
      return false;
    }
  } else if (domRestricted && dom) {
    if (!fieldMatches(dom, date.getDate(), date)) {
      return false;
    }
  } else if (dowRestricted && dow) {
    if (!fieldMatches(dow, date.getDay(), date)) {
      return false;
    }
  }

  const hour = fields.hour;
  if (hour && !fieldMatches(hour, date.getHours(), date)) {
    return false;
  }
  const minute = fields.minute;
  if (minute && !fieldMatches(minute, date.getMinutes(), date)) {
    return false;
  }
  const second = fields.second;
  if (second && !fieldMatches(second, date.getSeconds(), date)) {
    return false;
  }
  return true;
}

/** 推算未来执行时间 */
export function nextRuns(cron: CompiledCron, from: number, count: number): number[] {
  const out: number[] = [];
  const seconds = cron.fields.second;
  // 秒段是「单一固定值」或不存在 → 按分钟扫描（快且够用）；
  // 秒段是范围 / 步长 → 必须按秒扫描（否则 `*/30 * * * * *` 会算错）
  const minuteScan = seconds === undefined || seconds.single !== null;
  const secondOffset = seconds?.single ?? 0;

  if (minuteScan) {
    const start = new Date(from);
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);
    const limit = 1_051_200; // ≈ 2 年
    for (let i = 0; i < limit && out.length < count; i += 1) {
      const probe = new Date(start.getTime() + i * 60_000);
      if (dateMatches(cron, probe)) {
        out.push(probe.getTime() + secondOffset * 1000);
      }
    }
    return out;
  }

  const start = new Date(from);
  start.setMilliseconds(0);
  const limit = 200_000; // ≈ 55 小时（秒级表达式命中很快，够用）
  for (let i = 1; i <= limit && out.length < count; i += 1) {
    const probe = new Date(start.getTime() + i * 1000);
    if (dateMatches(cron, probe)) {
      out.push(probe.getTime());
    }
  }
  return out;
}

// ————————————————————————————————————————————————————————————————
// 主入口
// ————————————————————————————————————————————————————————————————

/** 解析并分析一个 cron 表达式 */
export function analyzeCron(input: string, from: number = Date.now()): CronAnalysis {
  const raw = input.trim();
  const empty: CronAnalysis = {
    ok: false,
    form: 'standard',
    fields: [],
    summary: '',
    next: [],
    dayOrWeek: false,
    normalized: '',
  };
  if (raw.length === 0) {
    return { ...empty, error: '请输入表达式' };
  }

  // —— 宏 ——
  const lower = raw.toLowerCase();
  if (lower.startsWith('@')) {
    if (lower === '@reboot') {
      return {
        ...empty,
        ok: true,
        form: 'macro',
        summary: '系统启动时执行一次（@reboot，非时间语义，无法推算下次时间）',
        normalized: '@reboot',
      };
    }
    const expanded = MACROS[lower];
    if (!expanded) {
      // 形态仍标成 macro：`@everyday` 是**写错的宏**，不是「段数不合法的一般表达式」。
      // 平台判定（platformOf）据此给「未知宏不会生效」的警告，而不是误判成标准 5 段。
      return {
        ...empty,
        form: 'macro',
        error: `未知宏「${raw}」（可用：@yearly @monthly @weekly @daily @hourly @reboot）`,
      };
    }
    const analysis = analyzeCron(expanded, from);
    return { ...analysis, form: 'macro', normalized: `${lower} → ${expanded}` };
  }

  const parts = raw.split(/\s+/);
  const layout: readonly CronFieldSpec[] | null = fieldLayout(parts.length);
  if (layout === null) {
    return {
      ...empty,
      error: `段数不对：需要 5 段（分 时 日 月 周）、6 段（秒 分 时 日 月 周）或 7 段（末尾再加年），当前 ${parts.length} 段`,
    };
  }
  const specs: readonly CronFieldSpec[] = layout;

  const compiled: Partial<Record<CronFieldKey, CompiledField>> = {};
  const results: CronFieldResult[] = [];
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i]!;
    const field = compileField(spec, parts[i] ?? '');
    compiled[spec.key] = field;
    results.push(field.result);
    if (!field.result.ok) {
      return {
        ...empty,
        fields: results,
        error: `第 ${i + 1} 段（${spec.label}）出错：${field.result.error ?? '格式不正确'}`,
      };
    }
  }

  const cron: CompiledCron = {
    fields: compiled,
    hasSeconds: specs.some((spec) => spec.key === 'second'),
    hasYear: specs.some((spec) => spec.key === 'year'),
  };

  const dayOrWeek =
    (compiled.dayOfMonth !== undefined && !compiled.dayOfMonth.result.wildcard) &&
    (compiled.dayOfWeek !== undefined && !compiled.dayOfWeek.result.wildcard);

  return {
    ok: true,
    form: cron.hasSeconds || cron.hasYear ? 'quartz' : 'standard',
    fields: results,
    summary: describe(compiled, cron),
    next: nextRuns(cron, from, 8),
    dayOrWeek,
    normalized: parts.join(' '),
  };
}

/** 生成一句话中文描述 */
function describe(compiled: Partial<Record<CronFieldKey, CompiledField>>, cron: CompiledCron): string {
  const monthField = compiled.month;
  const domField = compiled.dayOfMonth;
  const dowField = compiled.dayOfWeek;
  const hourField = compiled.hour;
  const minuteField = compiled.minute;
  const secondField = compiled.second;

  // —— 日期部分 ——
  const monthRestricted = monthField !== undefined && !monthField.result.wildcard;
  const domRestricted = domField !== undefined && !domField.result.wildcard;
  const dowRestricted = dowField !== undefined && !dowField.result.wildcard;

  // 月份是**前提条件**（「5月的…」），不参与日 / 周的二选一——
  // 否则会拼出「5月 或 每月3日 或 …」这种把前提当选项的病句
  const monthText = monthRestricted && monthField ? monthField.result.text : null;
  const dayPieces: string[] = [];
  if (domRestricted && domField) {
    // nameOf 让 text 自带单位（「3日」），拼出来是「每月3日」而不是旧的「每月3」
    dayPieces.push(`每月${domField.result.text}`);
  }
  if (dowRestricted && dowField) {
    const text = dowField.result.text;
    // 特殊语法（第 n 个周一 / 最后一个周五）挂「每月」；普通写法（周三 / 周一 至 周五 /
    // 周日、周二…）挂「每」—— 旧的 `每月${text}` 会拼出「每月1 至 5星期」这种坏句子
    dayPieces.push(/^第|^最/.test(text) ? `每月${text}` : `每${text}`);
  }
  const monthPrefix = monthText !== null ? `${monthText}的` : '';
  let datePart: string;
  if (dayPieces.length === 0) {
    datePart = monthText !== null ? `${monthPrefix}每天` : '每天';
  } else if (domRestricted && dowRestricted) {
    // Vixie 语义：或 —— 用「或」字点破，比光秃秃并列再补一句「满足其一」更直白
    datePart = `${monthPrefix}${dayPieces.join(' 或 ')}（满足其一）`.replace(/ 至 /g, '至');
  } else {
    datePart = `${monthPrefix}${dayPieces[0] ?? ''}`.replace(/ 至 /g, '至');
  }

  // —— 时间部分 ——
  const hourText = hourField?.result.text ?? '每小时';
  const minuteText = minuteField?.result.text ?? '每分钟';
  // 分钟的「每 n 分」接在别的词后面会拼出「第 每 5 分」这种坏句；
  // 「每 n 分」+「钟」=「每 n 分钟」自成一句，其余（列表 / 区间 / 单值）才用「第 …」
  const minutePhrase = (text: string): string => {
    if (/^每/.test(text)) {
      return `${text}钟`;
    }
    return /分$/.test(text) ? `第 ${text}` : `第 ${text} 分`;
  };
  let timePart: string;
  if (hourField && !hourField.result.wildcard && minuteField && !minuteField.result.wildcard) {
    const hours = hourField.result.values ?? [];
    const minutes = minuteField.result.values ?? [];
    if (hours.length <= 6 && minutes.length <= 6) {
      const list: string[] = [];
      for (const h of hours) {
        for (const m of minutes) {
          list.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
        }
      }
      timePart = list.join('、');
    } else {
      timePart = `${hourText}，${minutePhrase(minuteText)}`;
    }
  } else if (hourField && !hourField.result.wildcard) {
    timePart = `${hourText} 内每分钟`;
  } else if (minuteField && !minuteField.result.wildcard) {
    timePart = minutePhrase(minuteField.result.text).replace(/^第 /, '每小时的第 ');
  } else {
    timePart = '每分钟';
  }

  const secondText =
    secondField !== undefined && !secondField.result.wildcard ? `（${secondField.result.text}）` : '';

  const yearPart = cron.hasYear && compiled.year !== undefined && !compiled.year.result.wildcard
    ? `${compiled.year.result.text} `
    : '';

  return `${yearPart}${datePart} ${timePart} 执行${secondText}`.replace(/\s+/g, ' ').trim();
}

// ————————————————————————————————————————————————————————————————
// 常用预设（一键填充）
// ————————————————————————————————————————————————————————————————

/** 预设项 */
export interface CronPreset {
  label: string;
  expr: string;
  note: string;
  group: string;
}

/**
 * 运维 / 开发真正的日常写法。
 *
 * V21 补齐：用户反馈「缺少 `*` 斜杠 5 这样的吗？最小到分钟吗、如果每 5 分钟呢？注意齐全点」——
 * 于是「高频」组按 2/3/5/6/10/15/20/30 分钟铺全（这几个才是真实业务里点得最多的），
 * 「进阶」组补上秒级（Quartz 6 段）与多日 / 季度写法。
 */
export const CRON_PRESETS: readonly CronPreset[] = [
  { group: '高频', label: '每分钟', expr: '* * * * *', note: '调试期临时用，生产慎用' },
  { group: '高频', label: '每 2 分钟', expr: '*/2 * * * *', note: '' },
  { group: '高频', label: '每 3 分钟', expr: '*/3 * * * *', note: '' },
  { group: '高频', label: '每 5 分钟', expr: '*/5 * * * *', note: '最常用的轮询间隔' },
  { group: '高频', label: '每 6 分钟', expr: '*/6 * * * *', note: '' },
  { group: '高频', label: '每 10 分钟', expr: '*/10 * * * *', note: '' },
  { group: '高频', label: '每 15 分钟', expr: '*/15 * * * *', note: '' },
  { group: '高频', label: '每 20 分钟', expr: '*/20 * * * *', note: '' },
  { group: '高频', label: '每 30 分钟', expr: '*/30 * * * *', note: '' },
  { group: '高频', label: '每小时整点', expr: '0 * * * *', note: '等同于 @hourly' },
  { group: '每天', label: '每天 00:00', expr: '0 0 * * *', note: '等同于 @daily' },
  { group: '每天', label: '每天 02:00', expr: '0 2 * * *', note: '低峰期备份 / 清理' },
  { group: '每天', label: '每天 08:30', expr: '30 8 * * *', note: '上班前跑一次' },
  { group: '每天', label: '工作日 09:00', expr: '0 9 * * 1-5', note: '报表 / 提醒' },
  { group: '每天', label: '每天 12:00 与 18:00', expr: '0 12,18 * * *', note: '一天两次' },
  { group: '每天', label: '每 2 小时', expr: '0 */2 * * *', note: '' },
  { group: '每天', label: '每 6 小时', expr: '0 */6 * * *', note: '' },
  { group: '每天', label: '每 12 小时', expr: '0 */12 * * *', note: '' },
  { group: '每周', label: '每周一 01:00', expr: '0 1 * * 1', note: '' },
  { group: '每周', label: '每周日 23:00', expr: '0 23 * * 0', note: '' },
  { group: '每周', label: '周一至周五每小时', expr: '0 * * * 1-5', note: '' },
  { group: '每周', label: '周末 09:00', expr: '0 9 * * 0,6', note: '' },
  { group: '每月', label: '每月 1 日 00:00', expr: '0 0 1 * *', note: '等同于 @monthly' },
  { group: '每月', label: '每月 1 日与 15 日', expr: '0 0 1,15 * *', note: '' },
  { group: '每月', label: '每月最后一天 23:59', expr: '59 23 L * *', note: 'Quartz 语法，标准 cron 不支持 L' },
  { group: '每月', label: '每季度首日', expr: '0 0 1 1,4,7,10 *', note: '' },
  { group: '每月', label: '每年 1 月 1 日', expr: '0 0 1 1 *', note: '等同于 @yearly' },
  { group: '进阶', label: '每 15 分钟（9-18 点）', expr: '*/15 9-18 * * *', note: '限定业务时段' },
  { group: '进阶', label: '每 5 分钟（仅工作日）', expr: '*/5 * * * 1-5', note: '日 / 周同时限定取「或」，这里只限周所以是「且」语义' },
  { group: '进阶', label: '第 2 个周一 10:00', expr: '0 10 ? * 1#2', note: 'Quartz 语法，用于双周会议' },
  { group: '进阶', label: 'Quartz 每 30 秒', expr: '0/30 * * * * ?', note: '6 段：第 1 段是秒，最小粒度 1 秒' },
  { group: '进阶', label: 'Quartz 每 10 秒', expr: '0/10 * * * * ?', note: '6 段：高位日志 / 探活用' },
  { group: '进阶', label: 'Quartz 每 5 秒', expr: '0/5 * * * * ?', note: '6 段；再密就别用 cron 了' },
];

// ————————————————————————————————————————————————————————————————
// 反向生成（描述 → 表达式）
// ————————————————————————————————————————————————————————————————

/** 生成器模式 */
export type CronBuildMode =
  | 'seconds'
  | 'minutes'
  | 'hours'
  | 'daily'
  | 'weekly'
  | 'weeklyRange'
  | 'monthly'
  | 'dayList'
  | 'weekdays'
  | 'lastDay';

/** 生成器参数 */
export interface CronBuildInput {
  mode: CronBuildMode;
  /** 间隔（秒 / 分钟 / 小时模式） */
  every: number;
  hour: number;
  minute: number;
  /** 星期（0-6，weekly / weeklyRange 模式） */
  weekday: number;
  /** 星期区间的结束日（weeklyRange 模式） */
  weekdayTo: number;
  /** 日期（1-31，monthly / dayList 模式） */
  day: number;
  /** 多个日期（dayList 模式） */
  days: number[];
}

/** 由「人话参数」生成表达式 */
export function buildCron(input: CronBuildInput): string {
  const { mode, every, hour, minute, weekday, weekdayTo, day, days } = input;
  const m = Math.max(0, Math.min(59, Math.trunc(minute)));
  const h = Math.max(0, Math.min(23, Math.trunc(hour)));
  const clampDow = (value: number): number => Math.max(0, Math.min(6, Math.trunc(value)));
  switch (mode) {
    case 'seconds': {
      // Quartz 6 段：第 1 段是秒，所以最小粒度能到 1 秒（标准 5 段只能到分钟）
      const n = Math.max(1, Math.min(59, Math.trunc(every)));
      return n === 1 ? '* * * * * ?' : `0/${n} * * * * ?`;
    }
    case 'minutes': {
      const n = Math.max(1, Math.min(59, Math.trunc(every)));
      return n === 1 ? '* * * * *' : `*/${n} * * * *`;
    }
    case 'hours': {
      const n = Math.max(1, Math.min(23, Math.trunc(every)));
      return `0 */${n} * * *`;
    }
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly':
      return `${m} ${h} * * ${clampDow(weekday)}`;
    case 'weeklyRange':
      return `${m} ${h} * * ${clampDow(weekday)}-${clampDow(weekdayTo)}`;
    case 'monthly':
      return `${m} ${h} ${Math.max(1, Math.min(31, Math.trunc(day)))} * *`;
    case 'lastDay':
      // Quartz：L = 当月最后一天；日与周互斥，周位要写 ?
      return `${m} ${h} L * ?`;
    case 'dayList': {
      // 多日期（`1,15`）：去重排序，空数组兜底成「day」那一格
      const list = [...new Set((days.length > 0 ? days : [day]).map((item) => Math.max(1, Math.min(31, Math.trunc(item)))))].sort(
        (a, b) => a - b,
      );
      return `${m} ${h} ${list.join(',')} * *`;
    }
    case 'weekdays':
    default:
      return `${m} ${h} * * 1-5`;
  }
}

/** 时间戳 → `MM-DD HH:mm`（下周执行时间展示） */
export function formatRunTime(ms: number, withSeconds = false): string {
  const d = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const base = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

/** 时间戳 → 相对今天 / 明天 / 星期几（让「下次执行」一眼可读） */
export function humanRunTime(ms: number): string {
  const target = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) {
    return '今天';
  }
  if (diffDays === 1) {
    return '明天';
  }
  if (diffDays === 2) {
    return '后天';
  }
  if (diffDays > 0 && diffDays < 7) {
    return WEEKDAY_CN[target.getDay()] ?? `${diffDays} 天后`;
  }
  return `${diffDays} 天后`;
}

// ————————————————————————————————————————————————————————————————
// 宏展开 & 平台判定（V23）
// ————————————————————————————————————————————————————————————————

/**
 * 把宏展开成标准 5 段表达式（不是宏则返回 null）。
 *
 * 界面用：`@daily` 这种写法没法逐段编辑（它只有 1 段），展开后就能落到
 * 那排逐段输入框里接着改 —— 比让用户自己背「@daily = 0 0 * * *」友好。
 */
export function expandMacro(input: string): string | null {
  return MACROS[input.trim().toLowerCase()] ?? null;
}

/** 表达式归属的调度平台 */
export type CronPlatform = 'unix' | 'quartz';

/** 平台判定结果（界面据此显示「适用哪儿 / 贴错地方会怎样」） */
export interface CronPlatformInfo {
  platform: CronPlatform;
  /** 形态标签（徽标文案） */
  title: string;
  /** 一句话：这套写法是喂给谁的 */
  summary: string;
  /** 会真的报错 / 不生效的兼容性坑（空数组 = 没坑） */
  warnings: string[];
  /** 是否需要在界面上用警示色（有坑即 true） */
  risky: boolean;
}

/**
 * 从字段原始文本里挑出**只有 Quartz 认**的 token。
 *
 * 不能简单地 `/[LW#]/i.test(raw)` —— 月份别名 `JUL` 含 `L`、星期别名 `WED` 含 `W`，
 * 那样会把最普通的 `0 9 * * WED` 误报成 Quartz 扩展。所以按「逗号切分后的整段」
 * 逐个精确匹配：`L` / `5L` / `15W` / `1#2`。
 */
function quartzOnlyTokens(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(',')) {
    const token: string = piece.trim().toUpperCase();
    if (token.length === 0) {
      continue;
    }
    if (/^\d*W$/.test(token) || /^\d*#\d+$/.test(token) || token === 'L' || /^\d+L$/.test(token)) {
      out.push(piece.trim());
    }
  }
  return out;
}

/**
 * 判定表达式的适用平台，并给出「贴错地方会不会报错」的结论。
 *
 * 这是 V23 针对用户疑问「Quartz 语法究竟是什么、在什么场景下会被实际使用、
 * 如果不属于常用语法是否应当移除以免造成误解」给出的**代码级依据**：
 * 结论是**保留但必须标清适用平台** —— Quartz 不是冷门语法（Java 系与 XXL-JOB 天天用），
 * 但它和 Linux crontab / K8s CronJob 的 5 段写法**不互通**，混用会直接不生效，
 * 所以工具必须主动把这件事说清楚，而不是把它当作 5 段的「增强版」并排展示。
 */
export function platformOf(analysis: CronAnalysis): CronPlatformInfo {
  if (analysis.form === 'macro') {
    return {
      platform: 'unix',
      title: '宏写法',
      summary:
        'Linux cron 的简写：@daily @hourly @weekly @monthly @yearly @reboot。只有 cronie / Vixie cron（绝大多数发行版的 `crontab -e`）支持，systemd timer 与 Quartz 都不认。',
      warnings: analysis.ok ? [] : ['未知宏不会生效，可用的是上面那 6 个。'],
      risky: !analysis.ok,
    };
  }

  const quartzTokens: string[] = analysis.fields.flatMap((field) => quartzOnlyTokens(field.raw));

  if (analysis.form === 'quartz') {
    return {
      platform: 'quartz',
      title: 'Quartz 6 / 7 段',
      summary:
        'Java 系的写法：Quartz Scheduler、Spring `@Scheduled(cron=…)`、XXL-JOB、ElasticJob 用这一套。它比标准 5 段多了「秒」这一格，以及 `?`（不指定）/ `L`（最后一天）/ `15W`（最近工作日）/ `1#2`（第 2 个周一）。',
      warnings: [
        '这段表达式不能贴进 `crontab -e`、`/etc/cron.d` 或 Kubernetes CronJob 的 `schedule:` —— 它们只接受 5 段，多一段会直接报错、任务不生效（不是「写法不规范」那么轻）。',
        '`?` 是 Quartz 专有的「不指定」；标准 cron 里没有这个字符，需要「不指定」时写 `*`。',
      ],
      risky: true,
    };
  }

  if (quartzTokens.length > 0) {
    return {
      platform: 'unix',
      title: '标准 5 段（含 Quartz 专用符号）',
      summary:
        '段数是标准 5 段，但字段里出现了只有 Quartz 认识的写法，Linux crontab 会拒绝执行。',
      warnings: [
        `字段里的 ${quartzTokens.map((token) => `\`${token}\``).join('、')} 是 Quartz 扩展（\`L\` 最后一天 / \`15W\` 最近工作日 / \`1#2\` 第 2 个周一），Linux cron 不支持 —— 要么改成具体数字，要么把这条任务交给 Java 侧的调度器。`,
      ],
      risky: true,
    };
  }

  const questionMarks: string[] = analysis.fields
    .filter((field) => field.raw.trim() === '?')
    .map((field) => field.label);

  return {
    platform: 'unix',
    title: '标准 5 段',
    summary:
      'Linux `crontab -e`、`/etc/cron.d`、cronie、BusyBox crond，以及 Kubernetes CronJob 的 `schedule` 都是这一套。最小粒度 1 分钟，没有「秒」这一格。',
    warnings:
      questionMarks.length > 0
        ? [
            `第 ${questionMarks.join('、')} 段写的是 \`?\` —— 标准 cron 没有这个字符（Quartz 用它表示「不指定」）。K8s 的解析器能容忍，但 Linux crontab 不认，请改成 \`*\`。`,
          ]
        : [],
    risky: questionMarks.length > 0,
  };
}
