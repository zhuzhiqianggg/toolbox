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

/**
 * 是否已逾期：**按天**判定，到期日早于今天就算逾期。
 *
 * V77 之前是 `dueAt < Date.now()`，于是「今天 09:00」的事下午一过就变红——
 * 用户看到整列表一片红 + 全是「09:00」，反馈「逾期有什么作用，全都是 9」。
 * 工作台的排期粒度是「天」，当天的任务到当天结束前都还在计划内。
 */
export function isOverdue(todo: Todo): boolean {
  if (todo.done || todo.dueAt === null) {
    return false;
  }
  return startOfDay(todo.dueAt) < startOfDay(Date.now());
}

/** 逾期天数（不足一天按 1 天算；未逾期返回 0） */
export function overdueDays(todo: Todo): number {
  if (!isOverdue(todo) || todo.dueAt === null) {
    return 0;
  }
  return Math.max(1, Math.round((startOfDay(Date.now()) - startOfDay(todo.dueAt)) / DAY_MS));
}

/**
 * 排期徽标文案：`逾期 3 天` / `今天` / `明天` / `昨天` / `10月28日`；无日期返回 null。
 *
 * 刻意**不带时刻**：新建默认就是 09:00，每条都挂一枚「09:00」只是噪音，
 * 用户根本分不清它表示什么。真要精确时刻的场景请走待办页的时间编辑。
 */
export function scheduleLabel(todo: Todo): string | null {
  if (todo.dueAt === null) {
    return null;
  }
  const days = overdueDays(todo);
  if (days > 0) {
    return `逾期 ${days} 天`;
  }
  const today = startOfDay(Date.now());
  const diff = Math.round((startOfDay(todo.dueAt) - today) / DAY_MS);
  if (diff === 0) {
    return '今天';
  }
  if (diff === 1) {
    return '明天';
  }
  if (diff === -1) {
    return '昨天';
  }
  const d = new Date(todo.dueAt);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
