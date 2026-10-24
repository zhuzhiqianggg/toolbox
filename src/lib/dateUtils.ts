/**
 * 日期纯函数工具集（**本地时间**口径）。
 *
 * # 为什么独立成一个 `src/lib/` 模块
 *
 * 这批函数最早长在 `modules/workstation/planUtils.ts` 里，桌面日历挂件要用同一套
 * 口径时，第一反应是「从 workstation 里 import 过来」—— 那会在模块之间拉一条
 * 横向依赖（`desktop-grid` → `workstation`），谁先谁后说不清，日后挪文件必炸。
 *
 * 而项目约定是「**纯逻辑全在 `src/lib/`**」（见 `.workbuddy/memory/MEMORY.md` §2）。
 * 所以这里把与「计划」无关的日期数学抽出来，`planUtils` 与桌面挂件各自 import；
 * `planUtils` 同时把原名字**原样再导出**，既有调用方一行都不用改。
 *
 * 口径约定（与全项目一致）：一律 `Date.setDate` 做加减，不用 `±86400000` —— 夏令时
 * 会让「加一天」变成「加 23 或 25 小时」，零点就漂了。
 */

/** 一天毫秒数（**仅用于差值估算**，不用于日期加减） */
export const DAY_MS = 86_400_000;

/** 本地当天零点 */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 按「日」加减（自动跨月跨年，规避夏令时） */
export function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 所在周的周一零点（周一开始，符合国内习惯） */
export function startOfWeek(ms: number): number {
  const day = startOfDay(ms);
  const offset = (new Date(day).getDay() + 6) % 7; // 周一 = 0
  return addDays(day, -offset);
}

/** 所在月的一号零点 */
export function startOfMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** 下月一号零点 */
export function startOfNextMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

/** 该月天数 */
export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * 月历网格，首格为包含该月 1 号的**那周的周一**。
 *
 * - `fit = false`（默认）：固定 6 行 × 7 列 = 42 天。工作台整页日历（`CalendarPanel`）
 *   用这一档 —— 它靠 `flex-1` 把整片网格铺满剩余高度，行数固定反而好看、翻月不跳动。
 * - `fit = true`：**自适应行数**（5 或 6 行），只覆盖「当月实际占用的周」。桌面挂件
 *   日历（`CalendarWidget`）用这一档 —— 它住在固定 400px 宽的常驻列里、`aspect-square`
 *   的日期格约 54px 见方，月底若硬塞 6 行（如 2026-09 第 6 行整行都是下月、纯属浪费约
 *   54px 高度）会挤掉下方「计划清单」的空间。自适应后 9 月只渲染 5 行，少一行白边。
 *
 * ⚠️ 调用方若依赖「恒为 42」请显式传 `false`；默认就是 `false`，不传行为不变。
 */
export function buildMonthGrid(year: number, monthIndex: number, fit = false): number[] {
  const gridStart = startOfWeek(new Date(year, monthIndex, 1).getTime());
  if (!fit) {
    return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  }
  // 自适应：从「含 1 号的那周周一」到「含月末那周的周日」，算实际要几行。
  const dim = daysInMonth(year, monthIndex);
  const lastDay = new Date(year, monthIndex, dim).getTime();
  const lastWeekStart = startOfWeek(lastDay);
  const weeks = Math.round((lastWeekStart - gridStart) / DAY_MS / 7) + 1;
  return Array.from({ length: weeks * 7 }, (_, index) => addDays(gridStart, index));
}

/** 同一天？ */
export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** 日期短标签（如 `9月16日 周三`） */
export function dayLabel(ms: number): string {
  const d = new Date(ms);
  const weekday = '日一二三四五六'[d.getDay()] ?? '';
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekday}`;
}

/** 把某天 09:00 作为新建事件的默认时刻（比 00:00 更贴近真实使用） */
export function defaultMomentOfDay(dayMs: number): number {
  const d = new Date(dayMs);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
