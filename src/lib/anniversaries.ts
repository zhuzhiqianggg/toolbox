import type { Anniversary } from '@/core/types';

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
 * 每年重复的按「月-日」匹配；**2/29 在平年落到 3/1 也算命中** ——
 * 否则闰日出生的用户四年才被提醒一次。
 */
export function anniversariesOf(list: readonly Anniversary[], dayMs: number): Anniversary[] {
  const d = new Date(dayMs);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const full = toDateKey(d.getFullYear(), month, day);
  return list.filter((item) => {
    if (item.yearly) {
      const parts = item.date.split('-');
      const im = Number(parts[1]);
      const id = Number(parts[2]);
      if (im === month && id === day) {
        return true;
      }
      return im === 2 && id === 29 && month === 3 && day === 1;
    }
    return item.date === full;
  });
}

/** 纪念日已经过了几年（用于「第 N 年」提示） */
export function yearsSince(item: Anniversary, year: number): number {
  const startYear = Number(item.date.split('-')[0]);
  if (!Number.isFinite(startYear)) {
    return 0;
  }
  return year - startYear;
}
