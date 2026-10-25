/**
 * 农历 / 节气 / 干支 / 传统节日（零依赖）。
 *
 * # 为什么要自己写
 *
 * 工作台的月历要像「中华万年历」那样，一眼看到「今天农历几号、什么节气、
 * 是不是节假日」。这类需求是纯查表 + 简单递推，引入 `lunar-javascript`
 * （约 200KB）不划算 —— release 体积是本项目的硬指标。
 *
 * # 数据与精度
 *
 * - **农历**：内置 1900–2100 年的压缩年表（每年一个 20 位整数，编码 12/13 个月的
 *   大小月与闰月位置），与通行的《寿星天文历》口径一致；1900-01-31 为农历
 *   1900 年正月初一，此后按「累计天数 → 逐年逐月扣减」定位。
 * - **节气**：用 24 节气的**分钟偏移表** × 回归年长度（365.2422 天）递推，
 *   1900–2100 内绝大多数年份吻合，个别年份可能差 1 天（节气交接时刻本就贴在
 *   日界附近时，不同天文历表也会分歧）。对「日历上标注哪一天」完全够用。
 * - 范围外（<1900 / >2100）一律返回 `null`，调用方显示公历即可，不做静默兜底。
 *
 * # 与节假日的关系
 *
 * 本模块只管**天文与传统节日**；法定节假日（放假 / 调休上班）是行政安排，
 * 单独放在 `@/lib/holidays`。
 */

/** 农历年表（1900–2100，共 201 项）。 */
const LUNAR_INFO: readonly number[] = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520, // 2100
];

/** 农历 1900 年正月初一 = 公历 1900-01-31（UTC 零点，只用来数天数） */
const LUNAR_BASE_UTC = Date.UTC(1900, 0, 31);
const DAY_MS = 86_400_000;
export const LUNAR_MIN_YEAR = 1900;
export const LUNAR_MAX_YEAR = 2100;

/** 十天干 */
const GAN: readonly string[] = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
/** 十二地支 */
const ZHI: readonly string[] = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
/** 十二生肖（与地支一一对应） */
const ZODIAC: readonly string[] = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

/** 农历月名（1..12） */
const LUNAR_MONTH_NAMES: readonly string[] = [
  '正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊',
];

/** 农历日名（1..30） */
const LUNAR_DAY_NAMES: readonly string[] = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
];

/** 24 节气名（自「小寒」起，与 `TERM_OFFSET_MINUTES` 一一对应） */
export const SOLAR_TERMS: readonly string[] = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
  '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
  '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
];

/** 各节气相对「回归年基准点」的分钟偏移（经典寿星历表） */
const TERM_OFFSET_MINUTES: readonly number[] = [
  0, 21208, 42467, 63836, 85337, 107014, 128867, 150921,
  173149, 195551, 218072, 240693, 263343, 285989, 308563, 331033,
  353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758,
];

/** 农历传统节日：`月-日` → 名称（逢闰月不重复触发） */
const LUNAR_FESTIVALS: Readonly<Record<string, string>> = {
  '1-1': '春节',
  '1-15': '元宵节',
  '2-2': '龙抬头',
  '5-5': '端午节',
  '7-7': '七夕',
  '7-15': '中元节',
  '8-15': '中秋节',
  '9-9': '重阳节',
  '12-8': '腊八节',
  '12-23': '小年',
};

/** 公历节日：`月-日` → 名称 */
const SOLAR_FESTIVALS: Readonly<Record<string, string>> = {
  '1-1': '元旦',
  '2-14': '情人节',
  '3-8': '妇女节',
  '3-12': '植树节',
  '4-1': '愚人节',
  '5-1': '劳动节',
  '5-4': '青年节',
  '6-1': '儿童节',
  '7-1': '建党节',
  '8-1': '建军节',
  '9-10': '教师节',
  '10-1': '国庆节',
  '12-25': '圣诞节',
};

/** 某农历年闰哪个月（0 = 无闰月） */
function leapMonth(year: number): number {
  return LUNAR_INFO[year - LUNAR_MIN_YEAR]! & 0xf;
}

/** 某农历年闰月的天数（无闰月返回 0） */
function leapMonthDays(year: number): number {
  if (leapMonth(year) === 0) {
    return 0;
  }
  return (LUNAR_INFO[year - LUNAR_MIN_YEAR]! & 0x10000) !== 0 ? 30 : 29;
}

/** 某农历年某月（`month` 1..12，不含闰月）的天数：29 或 30 */
function monthDays(year: number, month: number): number {
  return (LUNAR_INFO[year - LUNAR_MIN_YEAR]! & (0x10000 >> month)) !== 0 ? 30 : 29;
}

/** 农历月槽位 */
interface LunarMonthSlot {
  /** 月序 1..12 */
  month: number;
  /** 是否闰月 */
  leap: boolean;
  /** 该月天数 */
  days: number;
}

/**
 * 列出某农历年的全部月份（按时间先后）。
 *
 * 用「先物化月表再线性扣减」而不是经典实现里那套 `--i / ++i` 游标戏法：
 * 后者在闰月年份极易把「闰月」和「同名正常月」搞混 —— 本项目第一版就踩了，
 * 闰六月把正常六月顶掉了，导致腊月整体前移一个月（`2023-03-22` 被算成「闰三月」）。
 * 物化月表没有这类边界，闰月插在同名月之后，顺序天然正确。
 *
 * @param year 农历年
 * @returns 月槽位数组（平年 12 项，闰年 13 项）
 */
function monthsOfYear(year: number): LunarMonthSlot[] {
  const leap = leapMonth(year);
  const slots: LunarMonthSlot[] = [];
  for (let m = 1; m <= 12; m += 1) {
    // 闰月排在同名月之后：闰 N 月插在 N 月与 N+1 月之间，月序仍记作 N
    if (leap > 0 && m === leap + 1) {
      slots.push({ month: leap, leap: true, days: leapMonthDays(year) });
    }
    slots.push({ month: m, leap: false, days: monthDays(year, m) });
  }
  return slots;
}

/** 某农历年的总天数 */
function yearDays(year: number): number {
  let sum = 348; // 12 个月各 29 天
  for (let bit = 0x8000; bit > 0x8; bit >>= 1) {
    sum += (LUNAR_INFO[year - LUNAR_MIN_YEAR]! & bit) !== 0 ? 1 : 0;
  }
  return sum + leapMonthDays(year);
}

/**
 * 农历日期。
 *
 * `leap = true` 表示闰月（如「闰二月」）；`monthName` / `dayName` 已是可直接展示的中文。
 */
export interface LunarDate {
  /** 农历年（数字，如 2026） */
  year: number;
  /** 农历月 1..12 */
  month: number;
  /** 农历日 1..30 */
  day: number;
  /** 是否闰月 */
  leap: boolean;
  /** 中文月名（含「闰」前缀，如「闰二月」） */
  monthName: string;
  /** 中文日名（如「廿三」） */
  dayName: string;
  /** 该农历月的总天数 */
  monthDays: number;
}

/** 数字 → 中文月名 */
function monthLabel(month: number, leap: boolean): string {
  return `${leap ? '闰' : ''}${LUNAR_MONTH_NAMES[month - 1] ?? `${month}`}月`;
}

/**
 * 公历 → 农历。
 *
 * @param year 公历年（1900–2100）
 * @param month 公历月 1..12
 * @param day 公历日
 * @returns 农历日期；超出支持范围返回 `null`
 */
export function solarToLunar(year: number, month: number, day: number): LunarDate | null {
  if (year < LUNAR_MIN_YEAR || year > LUNAR_MAX_YEAR) {
    return null;
  }
  const target = Date.UTC(year, month - 1, day);
  let offset = Math.round((target - LUNAR_BASE_UTC) / DAY_MS);
  if (offset < 0) {
    return null;
  }

  // 逐年扣减，定位到农历年
  let lunarYear = LUNAR_MIN_YEAR;
  let remaining = offset;
  while (lunarYear <= LUNAR_MAX_YEAR) {
    const days = yearDays(lunarYear);
    if (remaining < days) {
      break;
    }
    remaining -= days;
    lunarYear += 1;
  }
  if (lunarYear > LUNAR_MAX_YEAR) {
    return null;
  }

  // 年内逐月扣减，定位到农历月（平年 12 项、闰年 13 项）
  const slots = monthsOfYear(lunarYear);
  let slot: LunarMonthSlot | null = null;
  for (const candidate of slots) {
    if (remaining < candidate.days) {
      slot = candidate;
      break;
    }
    remaining -= candidate.days;
  }
  if (slot === null) {
    // 理论上不可达：年循环已保证 remaining < yearDays(year)
    return null;
  }

  return {
    year: lunarYear,
    month: slot.month,
    day: remaining + 1,
    leap: slot.leap,
    monthName: monthLabel(slot.month, slot.leap),
    dayName: LUNAR_DAY_NAMES[remaining] ?? `${remaining + 1}`,
    monthDays: slot.days,
  };
}

/** 农历月天数（含闰月）；参数非法返回 `null` */
export function lunarMonthDays(year: number, month: number, leap: boolean): number | null {
  if (year < LUNAR_MIN_YEAR || year > LUNAR_MAX_YEAR || month < 1 || month > 12) {
    return null;
  }
  if (leap) {
    return leapMonth(year) === month ? leapMonthDays(year) : null;
  }
  return monthDays(year, month);
}

/** 某农历年是否有闰月，是则返回闰哪个月（1..12），无则 `0` */
export function leapMonthOf(year: number): number {
  if (year < LUNAR_MIN_YEAR || year > LUNAR_MAX_YEAR) {
    return 0;
  }
  return leapMonth(year);
}

/**
 * 农历 → 公历。
 *
 * 与 [`solarToLunar`] 共用同一张年表，两者互为逆运算：先用年表把
 * 「农历年之前的总天数 + 当年月之前的天数 + 日偏移」累加出来，再加到
 * 1900-01-31（农历 1900 年正月初一）上即可。
 *
 * @param year 农历年（1900–2100）
 * @param month 农历月 1..12
 * @param day 农历日 1..30
 * @param leap 是否闰月（如「闰二月」传 `true`）
 * @returns 对应的公历年月日；超出范围或该月不存在（如非闰年传 `leap`）返回 `null`
 */
export function lunarToSolar(
  year: number,
  month: number,
  day: number,
  leap = false,
): { year: number; month: number; day: number } | null {
  const days = lunarMonthDays(year, month, leap);
  if (days === null || day < 1 || day > days) {
    return null;
  }

  let offset = 0;
  for (let y = LUNAR_MIN_YEAR; y < year; y += 1) {
    offset += yearDays(y);
  }
  let found = false;
  for (const slot of monthsOfYear(year)) {
    if (slot.month === month && slot.leap === leap) {
      found = true;
      break;
    }
    offset += slot.days;
  }
  if (!found) {
    return null;
  }
  offset += day - 1;

  const date = new Date(LUNAR_BASE_UTC + offset * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * 某公历年第 `termIndex` 个节气落在几号。
 *
 * @param year 公历年
 * @param termIndex 0..23（0 = 小寒，见 [`SOLAR_TERMS`]）
 * @returns 该节气的公历月与日（月 = `floor(index/2)+1`）
 */
export function solarTermDay(year: number, termIndex: number): { month: number; day: number } | null {
  if (termIndex < 0 || termIndex >= TERM_OFFSET_MINUTES.length) {
    return null;
  }
  const stamp =
    31_556_925_974.7 * (year - LUNAR_MIN_YEAR) +
    TERM_OFFSET_MINUTES[termIndex]! * 60_000 +
    Date.UTC(1900, 0, 6, 2, 5);
  const date = new Date(stamp);
  return { month: Math.floor(termIndex / 2) + 1, day: date.getUTCDate() };
}

/** 某天的节气名（不是节气日返回 null） */
export function solarTermOf(year: number, month: number, day: number): string | null {
  const first = (month - 1) * 2;
  for (const index of [first, first + 1]) {
    const hit = solarTermDay(year, index);
    if (hit && hit.month === month && hit.day === day) {
      return SOLAR_TERMS[index] ?? null;
    }
  }
  return null;
}

/** 干支纪年（如「丙午」）与生肖（如「马」） */
export function ganZhi(year: number): { ganZhi: string; zodiac: string } {
  // 1900 年为庚子年（干支序号 36）
  const index = (year - LUNAR_MIN_YEAR + 36) % 60;
  return {
    ganZhi: `${GAN[index % 10] ?? ''}${ZHI[index % 12] ?? ''}`,
    zodiac: ZODIAC[index % 12] ?? '',
  };
}

/** 一天的完整日历信息 */
export interface DayInfo {
  /** 农历日期（超范围 = null） */
  lunar: LunarDate | null;
  /** 节气名（当天不是节气则为 null） */
  term: string | null;
  /** 农历传统节日名 */
  lunarFestival: string | null;
  /** 公历节日名 */
  solarFestival: string | null;
  /**
   * 日历格子右上角要显示的小字（优先级：节日 > 节气 > 农历初一显示月名 > 农历日名）。
   * 没有任何可显示的（超范围）时为 null。
   */
  badge: string | null;
}

/**
 * 汇总某天的农历信息（日历格子 + tooltip 共用）。
 *
 * @param year 公历年
 * @param month 公历月 1..12
 * @param day 公历日
 */
export function dayInfo(year: number, month: number, day: number): DayInfo {
  const lunar = solarToLunar(year, month, day);
  const term = solarTermOf(year, month, day);
  const solarFestival = SOLAR_FESTIVALS[`${month}-${day}`] ?? null;

  let lunarFestival: string | null = null;
  if (lunar !== null && !lunar.leap) {
    lunarFestival = LUNAR_FESTIVALS[`${lunar.month}-${lunar.day}`] ?? null;
    // 除夕：腊月最后一天（有闰腊月时自然跟着最后一个月走）
    if (lunar.month === 12 && lunar.day === lunar.monthDays) {
      lunarFestival = '除夕';
    }
  }

  let badge: string | null = null;
  if (lunarFestival !== null) {
    badge = lunarFestival;
  } else if (term !== null) {
    badge = term;
  } else if (solarFestival !== null) {
    badge = solarFestival;
  } else if (lunar !== null) {
    badge = lunar.day === 1 ? lunar.monthName : lunar.dayName;
  }

  return { lunar, term, lunarFestival, solarFestival, badge };
}

/** 农历节日专属的强调色（日历里把传统节日与其他小字区分开） */
export function isMajorFestival(info: DayInfo): boolean {
  return info.lunarFestival !== null;
}

/** 供外部展示：农历「X月Y」完整写法 */
export function lunarLabel(lunar: LunarDate): string {
  return `${lunar.leap ? '闰' : ''}${LUNAR_MONTH_NAMES[lunar.month - 1] ?? ''}月${lunar.dayName}`;
}
