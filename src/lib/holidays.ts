/**
 * 中国法定节假日与调休上班（数据表）。
 *
 * # 为什么单列一个文件
 *
 * 「放假日 / 调休上班日」是**行政安排**，跟农历、节气这类天文计算完全不是一回事：
 * 每年由国务院办公厅发通知，日期只能查表。所以本文件是**纯数据**，
 * 更新时只需要在 `HOLIDAY_DATA` 里补一年的条目，逻辑一行都不用动，
 * 也方便用户自己校对（界面里会标注「数据截至 2026 年」）。
 *
 * # 数据来源与口径
 *
 * 全部取自国务院办公厅《关于 YYYY 年部分节假日安排的通知》正式公布的安排：
 *
 * | 年份 | 放假合计 | 备注 |
 * | --- | --- | --- |
 * | 2024 | 30 天 | 春节 8 天 |
 * | 2025 | 28 天 | 春节 8 天、国庆中秋合并 8 天 |
 * | 2026 | 33 天 | 春节 9 天（2/15–2/23）、国庆 7 天，全年法定假全部与周末自然衔接 |
 *
 * 表里只列**放假区间**与**调休补班日**；周末是否休息由星期几推导，
 * 因此不需要把普通周末也铺进表里。
 */

/** 一段连续放假 */
interface OffRange {
  /** 起始日（含）`YYYY-MM-DD` */
  start: string;
  /** 结束日（含）`YYYY-MM-DD` */
  end: string;
  /** 节日名（用于日历标注与「下一个假期」） */
  name: string;
}

/** 一个调休补班日（本该休息的周末要上班） */
interface WorkDay {
  /** `YYYY-MM-DD` */
  date: string;
  /** 补哪次假 */
  name: string;
}

/** 某年的节假日安排 */
interface YearPlan {
  off: readonly OffRange[];
  work: readonly WorkDay[];
}

/** 内置节假日数据（想支持更多年份照格式追加即可） */
const HOLIDAY_DATA: Readonly<Record<number, YearPlan>> = {
  2024: {
    off: [
      { start: '2024-01-01', end: '2024-01-01', name: '元旦' },
      { start: '2024-02-10', end: '2024-02-17', name: '春节' },
      { start: '2024-04-04', end: '2024-04-06', name: '清明节' },
      { start: '2024-05-01', end: '2024-05-05', name: '劳动节' },
      { start: '2024-06-08', end: '2024-06-10', name: '端午节' },
      { start: '2024-09-15', end: '2024-09-17', name: '中秋节' },
      { start: '2024-10-01', end: '2024-10-07', name: '国庆节' },
    ],
    work: [
      { date: '2024-02-04', name: '春节调休' },
      { date: '2024-02-18', name: '春节调休' },
      { date: '2024-04-07', name: '清明调休' },
      { date: '2024-04-28', name: '劳动节调休' },
      { date: '2024-05-11', name: '劳动节调休' },
      { date: '2024-09-14', name: '中秋调休' },
      { date: '2024-09-29', name: '国庆调休' },
      { date: '2024-10-12', name: '国庆调休' },
    ],
  },
  2025: {
    off: [
      { start: '2025-01-01', end: '2025-01-01', name: '元旦' },
      { start: '2025-01-28', end: '2025-02-04', name: '春节' },
      { start: '2025-04-04', end: '2025-04-06', name: '清明节' },
      { start: '2025-05-01', end: '2025-05-05', name: '劳动节' },
      { start: '2025-05-31', end: '2025-06-02', name: '端午节' },
      { start: '2025-10-01', end: '2025-10-08', name: '国庆节·中秋节' },
    ],
    work: [
      { date: '2025-01-26', name: '春节调休' },
      { date: '2025-02-08', name: '春节调休' },
      { date: '2025-04-27', name: '劳动节调休' },
      { date: '2025-09-28', name: '国庆调休' },
      { date: '2025-10-11', name: '国庆调休' },
    ],
  },
  2026: {
    off: [
      { start: '2026-01-01', end: '2026-01-03', name: '元旦' },
      { start: '2026-02-15', end: '2026-02-23', name: '春节' },
      { start: '2026-04-04', end: '2026-04-06', name: '清明节' },
      { start: '2026-05-01', end: '2026-05-05', name: '劳动节' },
      { start: '2026-06-19', end: '2026-06-21', name: '端午节' },
      { start: '2026-09-25', end: '2026-09-27', name: '中秋节' },
      { start: '2026-10-01', end: '2026-10-07', name: '国庆节' },
    ],
    work: [
      { date: '2026-01-04', name: '元旦调休' },
      { date: '2026-02-14', name: '春节调休' },
      { date: '2026-02-28', name: '春节调休' },
      { date: '2026-05-09', name: '劳动节调休' },
      { date: '2026-09-20', name: '国庆调休' },
      { date: '2026-10-10', name: '国庆调休' },
    ],
  },
};

/** 数据覆盖的年份（供界面标注「数据截至」） */
export const HOLIDAY_YEARS: readonly number[] = Object.keys(HOLIDAY_DATA)
  .map((key) => Number(key))
  .sort((a, b) => a - b);

/** 数据最新年份 */
export const HOLIDAY_LATEST_YEAR: number = HOLIDAY_YEARS[HOLIDAY_YEARS.length - 1] ?? 0;

/** 两位补零 */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 日期 → `YYYY-MM-DD`（本地时区，格子键用） */
export function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** 一天的休假属性 */
export type DayKind =
  /** 法定节假日（放假） */
  | 'holiday'
  /** 调休补班日（周末但要上班） */
  | 'makeup'
  /** 普通周末 */
  | 'weekend'
  /** 普通工作日 */
  | 'workday';

/** 某天的休假判定结果 */
export interface HolidayInfo {
  kind: DayKind;
  /** 节日名（kind = 'holiday' 时为节日，'makeup' 时为调休说明；其余为 null） */
  name: string | null;
  /** 是否休息（holiday / weekend 为 true） */
  off: boolean;
  /** 该年是否有节假日数据（没有 = 界面提示「未收录」而不是假装是工作日） */
  known: boolean;
}

/** 放假表 / 补班表的一次性索引（构建成本 O(年数 × 区间长度)，只在首次访问时付） */
let offIndex: Map<string, string> | null = null;
let workIndex: Map<string, string> | null = null;

/** 生成索引：区间展开到每一天 */
function ensureIndex(): { off: Map<string, string>; work: Map<string, string> } {
  if (offIndex !== null && workIndex !== null) {
    return { off: offIndex, work: workIndex };
  }
  const off = new Map<string, string>();
  const work = new Map<string, string>();
  for (const plan of Object.values(HOLIDAY_DATA)) {
    for (const range of plan.off) {
      const [sy, sm, sd] = range.start.split('-').map(Number) as [number, number, number];
      const [ey, em, ed] = range.end.split('-').map(Number) as [number, number, number];
      let cursor = Date.UTC(sy, sm - 1, sd);
      const end = Date.UTC(ey, em - 1, ed);
      // 防御：万一数据写反了（end < start），不让它变成死循环
      let guard = 0;
      while (cursor <= end && guard < 400) {
        const d = new Date(cursor);
        off.set(dateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), range.name);
        cursor += 86_400_000;
        guard += 1;
      }
    }
    for (const item of plan.work) {
      work.set(item.date, item.name);
    }
  }
  offIndex = off;
  workIndex = work;
  return { off, work };
}

/**
 * 判断某天是「放假 / 调休上班 / 周末 / 工作日」。
 *
 * @param year 公历年
 * @param month 公历月 1..12
 * @param day 公历日
 */
export function holidayOf(year: number, month: number, day: number): HolidayInfo {
  const key = dateKey(year, month, day);
  const { off, work } = ensureIndex();
  const known = HOLIDAY_DATA[year] !== undefined;

  const offName = off.get(key);
  if (offName !== undefined) {
    return { kind: 'holiday', name: offName, off: true, known };
  }
  const workName = work.get(key);
  if (workName !== undefined) {
    return { kind: 'makeup', name: workName, off: false, known };
  }

  const weekday = new Date(year, month - 1, day).getDay();
  if (weekday === 0 || weekday === 6) {
    return { kind: 'weekend', name: null, off: true, known };
  }
  return { kind: 'workday', name: null, off: false, known };
}

/** 一个即将到来的假期 */
export interface UpcomingHoliday {
  /** 假期首日（本地零点毫秒） */
  startMs: number;
  /** 假期末日（本地零点毫秒） */
  endMs: number;
  name: string;
  /** 共几天 */
  days: number;
  /** 距今天还有几天（0 = 今天开始） */
  inDays: number;
}

/**
 * 从今天起往后找接下来的几个假期（含「正在放假」中的这个）。
 *
 * @param fromMs 基准时间（本地毫秒）
 * @param limit 最多返回几个
 */
export function upcomingHolidays(fromMs: number, limit = 3): UpcomingHoliday[] {
  const today = new Date(fromMs);
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  const ranges: Array<{ start: number; end: number; name: string }> = [];
  for (const plan of Object.values(HOLIDAY_DATA)) {
    for (const range of plan.off) {
      const [sy, sm, sd] = range.start.split('-').map(Number) as [number, number, number];
      const [ey, em, ed] = range.end.split('-').map(Number) as [number, number, number];
      ranges.push({
        start: new Date(sy, sm - 1, sd).getTime(),
        end: new Date(ey, em - 1, ed).getTime(),
        name: range.name,
      });
    }
  }
  ranges.sort((a, b) => a.start - b.start);

  const result: UpcomingHoliday[] = [];
  for (const range of ranges) {
    if (range.end < todayMs) {
      continue;
    }
    result.push({
      startMs: range.start,
      endMs: range.end,
      name: range.name,
      days: Math.round((range.end - range.start) / 86_400_000) + 1,
      inDays: Math.max(0, Math.round((range.start - todayMs) / 86_400_000)),
    });
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}
