import type { Todo } from '@/core/data/todosService';
import {
  DAY_MS,
  addDays,
  buildMonthGrid,
  dayLabel,
  daysInMonth,
  defaultMomentOfDay,
  isSameDay,
  startOfDay,
  startOfMonth,
  startOfNextMonth,
  startOfWeek,
} from '@/lib/dateUtils';

/**
 * 工作台「日历 + 计划」纯函数工具集。
 *
 * 全部以**本地时间**计算（工作台是本地效率工具，不引入时区切换概念），
 * 日期加减一律走 `Date.setDate` 而非 `±86400000`，避免夏令时导致「零点漂移」。
 *
 * V35：与「计划」无关的**日期数学**已抽到 `@/lib/dateUtils`（纯逻辑归 `src/lib/`，
 * 见 MEMORY §2）—— 桌面日历挂件要用同一套口径，不该反向依赖 `modules/workstation`。
 * 这里把原名字**原样再导出**，既有调用方一行都不用改；本文件只保留计划语义部分。
 */

// 原样再导出：既有调用方（工作台各处）无需改动 import 路径
export {
  DAY_MS,
  startOfDay,
  addDays,
  startOfWeek,
  startOfMonth,
  startOfNextMonth,
  daysInMonth,
  buildMonthGrid,
  isSameDay,
  dayLabel,
  defaultMomentOfDay,
};

/** 计划范围 */
export type PlanScope = 'day' | 'week' | 'month' | 'undated' | 'all';

/** 范围中文名（界面 chip 与空态文案共用） */
export const SCOPE_LABELS: Record<PlanScope, string> = {
  day: '当日',
  week: '本周',
  month: '本月',
  undated: '无日期',
  all: '全部',
};

/** 范围 → [from, to) 毫秒区间；`undated` / `all` 返回 null（不做时间过滤） */
export function scopeRange(scope: PlanScope, anchorMs: number): { from: number; to: number } | null {
  switch (scope) {
    case 'day':
      return { from: startOfDay(anchorMs), to: addDays(anchorMs, 1) };
    case 'week': {
      const from = startOfWeek(anchorMs);
      return { from, to: addDays(from, 7) };
    }
    case 'month':
      return { from: startOfMonth(anchorMs), to: startOfNextMonth(anchorMs) };
    default:
      return null;
  }
}

/** 按范围 + 「隐藏已完成」筛选待办（保持 store 传入的顺序） */
export function filterTodos(
  todos: readonly Todo[],
  scope: PlanScope,
  anchorMs: number,
  hideDone: boolean,
): Todo[] {
  const range = scopeRange(scope, anchorMs);
  return todos.filter((todo) => {
    if (hideDone && todo.done) {
      return false;
    }
    if (scope === 'all') {
      return true;
    }
    if (scope === 'undated') {
      return todo.dueAt === null;
    }
    if (todo.dueAt === null) {
      return false;
    }
    return range !== null && todo.dueAt >= range.from && todo.dueAt < range.to;
  });
}

/** 每天的未完成待办数（日历圆点用）；键为当天零点毫秒 */
export function pendingCountByDay(todos: readonly Todo[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const todo of todos) {
    if (todo.done || todo.dueAt === null) {
      continue;
    }
    const key = startOfDay(todo.dueAt);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/** 相对今天的口语化标签（今天 / 明天 / 昨天 / 9月16日 周三） */
export function relativeDayLabel(ms: number): string {
  const today = startOfDay(Date.now());
  const diff = Math.round((startOfDay(ms) - today) / DAY_MS);
  if (diff === 0) {
    return '今天';
  }
  if (diff === 1) {
    return '明天';
  }
  if (diff === -1) {
    return '昨天';
  }
  return dayLabel(ms);
}

/** 时间标签：今天/明天只显示时刻，其余显示「月-日」 */
export function dueLabel(dueAt: number): string {
  const d = new Date(dueAt);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = startOfDay(Date.now());
  const day = startOfDay(dueAt);
  if (day === today) {
    return time;
  }
  if (day === addDays(today, 1)) {
    return `明天 ${time}`;
  }
  if (day === addDays(today, -1)) {
    return `昨天 ${time}`;
  }
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${time}`;
}

/** 是否已逾期（未完成且到期时间早于此刻） */
export function isOverdue(todo: Todo): boolean {
  return !todo.done && todo.dueAt !== null && todo.dueAt < Date.now();
}
