import type { Anniversary } from '@/core/types';
import { lunarToSolar, solarToLunar } from '@/lib/lunar';

/**
 * 纪念日（生日 / 周年）纯函数。
 *
 * V35 从 `modules/workstation/CalendarPanel.tsx` 抽到 `src/lib/` —— 桌面日历挂件
 * 要在日期格上画同一套「🎂」标记，如果各写一份，迟早出现「工作台说是这天、
 * 桌面挂件说是那天」的分歧（口径漂移是这类重复实现最典型的代价）。
 */

/** 纪念日类型 → 展示信息（表单下拉与图例共用） */
export const ANNIVERSARY_KINDS: ReadonlyArray<{ id: Anniversary['kind']; name: string }> = [
  { id: 'birthday', name: '生日' },
  { id: 'anniversary', name: '纪念日' },
  { id: 'other', name: '其他' },
];

/** 日期口径（V76）：公历 / 农历 */
export const CALENDAR_KINDS: ReadonlyArray<{ id: 'solar' | 'lunar'; name: string }> = [
  { id: 'solar', name: '公历' },
  { id: 'lunar', name: '农历' },
];

/** 该项是否按农历记录（存量数据没有该字段 → 公历） */
export function isLunar(item: Anniversary): boolean {
  return item.calendar === 'lunar';
}

/** 拆 `YYYY-MM-DD` */
function partsOf(date: string): { year: number; month: number; day: number } {
  const [y, m, d] = date.split('-');
  return { year: Number(y), month: Number(m), day: Number(d) };
}

/** 两位补零 */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地日期 → `YYYY-MM-DD` */
export function toDateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** 新纪念日 id（时间戳 + 随机后缀，足够避免碰撞） */
export function newAnniversaryId(): string {
  return `an-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 某天命中的纪念日（`dayMs` 为本地零点毫秒）。
 *
 * - **公历**每年重复：按「月-日」匹配；2/29 在平年落到 3/1 也算命中 ——
 *   否则闰日出生的用户四年才被提醒一次。
 * - **农历**每年重复（V76）：把当天的公历先转成农历，再比对农历月-日
 *   （闰月只在 `leap=true` 时命中），所以 1988 年农历十月十三每年落在
 *   不同的公历日，也能准确打点。
 */
export function anniversariesOf(list: readonly Anniversary[], dayMs: number): Anniversary[] {
  const d = new Date(dayMs);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const full = toDateKey(d.getFullYear(), month, day);
  const lunarOfDay = list.some(isLunar)
    ? solarToLunar(d.getFullYear(), month, day)
    : null;

  return list.filter((item) => {
    const parts = partsOf(item.date);
    if (isLunar(item)) {
      if (!item.yearly) {
        // 农历 + 单次：换算成公历后精确比对
        const solar = lunarToSolar(parts.year, parts.month, parts.day, item.leap === true);
        return solar !== null && toDateKey(solar.year, solar.month, solar.day) === full;
      }
      return (
        lunarOfDay !== null &&
        lunarOfDay.month === parts.month &&
        lunarOfDay.day === parts.day &&
        lunarOfDay.leap === (item.leap === true)
      );
    }
    if (item.yearly) {
      if (parts.month === month && parts.day === day) {
        return true;
      }
      return parts.month === 2 && parts.day === 29 && month === 3 && day === 1;
    }
    return item.date === full;
  });
}

/** 纪念日已经过了几年（用于「第 N 年」提示） */
export function yearsSince(item: Anniversary, year: number): number {
  const startYear = partsOf(item.date).year;
  if (!Number.isFinite(startYear)) {
    return 0;
  }
  return year - startYear;
}

/**
 * 该纪念日在指定年份对应的公历日期（列表里给农历项标注「今年公历几号」用）。
 *
 * - 公历每年重复 → 换年份、保留月日；
 * - 农历每年重复 → `lunarToSolar(year, 月, 日)`，闰月按记录时的闰月口径；
 * - 单次 → 返回记录日期本身（农历项先换算）。
 */
export function solarDateInYear(
  item: Anniversary,
  year: number,
): { year: number; month: number; day: number } | null {
  const parts = partsOf(item.date);
  if (isLunar(item)) {
    return lunarToSolar(item.yearly ? year : parts.year, parts.month, parts.day, item.leap === true);
  }
  if (!item.yearly) {
    return parts;
  }
  return { year, month: parts.month, day: parts.day };
}

/** 日期展示：农历项带「农历」前缀，公历项保持 `YYYY-MM-DD` */
export function anniversaryDateLabel(item: Anniversary): string {
  return `${isLunar(item) ? '农历 ' : ''}${item.date}`;
}

/** 农历项的中文表述（如「十月十三」）；非农历或超范围返回 `null` */
export function anniversaryLunarLabel(item: Anniversary): string | null {
  if (!isLunar(item)) {
    return null;
  }
  const parts = partsOf(item.date);
  const solar = lunarToSolar(parts.year, parts.month, parts.day, item.leap === true);
  if (solar === null) {
    return null;
  }
  const back = solarToLunar(solar.year, solar.month, solar.day);
  return back === null ? null : `${back.monthName}${back.dayName}`;
}
