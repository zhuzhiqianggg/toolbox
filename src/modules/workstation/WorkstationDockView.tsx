import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { useTodosStore } from '@/stores/useTodosStore';
import { buildMonthGrid, dayLabel, isSameDay, startOfDay } from '@/lib/dateUtils';
import { dayInfo, ganZhi, type DayInfo } from '@/lib/lunar';
import { holidayOf } from '@/lib/holidays';
import { patchSettings } from '@/lib/store';
import { isTauri } from '@/platform/detect';
import { ipc } from '@/lib/ipc';
import { filterTodos } from './planUtils';

/**
 * 工作台桌面停靠视图（V65 重构：桌面原生感）。
 *
 * 形态定位：**替代任务栏时钟的桌面挂件** —— 透明 Acrylic 材质（Rust 侧开窗配置）、
 * 贴主屏右缘、上下严丝合缝，视觉上「长在桌面上」而非浮块。
 *
 * 与 V64 的差异（用户反馈）：
 * - **去掉便签**：停靠窗只保留日历相关能力（时钟 / 月历 / 事项）；
 * - **精简月历**：不再复用主窗口的 CalendarPanel（其纪念日管理 / 图例说明太重），
 *   改为内嵌轻量月网格 —— 只保留公历 + 农历 + 休/班角标 + 今天/选中态；
 * - **修「添加事项后列表没变化」**：根因是新建事项不带 `dueAt`，被「当日」过滤
 *   排除；停靠窗创建时固定落 `dueAt = 选中日`，从数据层面根治；
 * - 数据与主窗口完全同源（`useTodosStore` → 同一份 SQLite），两边改动实时互通。
 */

/** 几何落库防抖（拖动 / 缩放停稳后写入，与便签同口径） */
const GEOMETRY_SAVE_DEBOUNCE_MS = 500;

/** 中文星期（getDay：0 = 周日）与月历列头（周一起始，与 buildMonthGrid 对齐） */
const WEEK_FULL: readonly string[] = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEK_HEAD: readonly string[] = ['一', '二', '三', '四', '五', '六', '日'];

/** 时钟 HH:mm:ss（两位补零） */
function clockOf(ms: number): { hhmm: string; ss: string } {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return { hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`, ss: pad(d.getSeconds()) };
}

/** 单日摘要：农历 / 节气 / 假日 / 休班标记（月历格与头部共用一套取数口径） */
interface DayMeta {
  info: DayInfo;
  /** 'rest' = 放假 / 'work' = 调休上班 / 'workday' = 普通日 */
  holidayKind: string;
  /** 假日名（国庆 / 春节…），无则 null */
  holidayName: string | null;
}

/** 农历行文本（优先级：传统节日 > 法定假日 > 节气 > 农历日），与主窗口一致 */
function metaLabel(meta: DayMeta): string {
  if (meta.info.lunarFestival !== null) {
    return meta.info.lunarFestival;
  }
  if (meta.holidayName !== null) {
    return meta.holidayName;
  }
  if (meta.info.term !== null) {
    return meta.info.term;
  }
  if (meta.info.lunar !== null) {
    return meta.info.lunar.dayName;
  }
  return '';
}

export function WorkstationDockView(): React.JSX.Element {
  // —— 时钟（每秒刷新）——
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const clock = useMemo(() => clockOf(now), [now]);

  // —— 选中日（默认今天）——
  const [anchorMs, setAnchorMs] = useState<number>(() => startOfDay(Date.now()));
  const anchor = useMemo(() => new Date(anchorMs), [anchorMs]);
  const isToday = isSameDay(anchorMs, now);

  // —— 待办（与主窗口同源数据层）——
  const todos = useTodosStore((state) => state.todos);
  const createTodo = useTodosStore((state) => state.createTodo);
  const toggleDone = useTodosStore((state) => state.toggleDone);
  const hydrate = useTodosStore((state) => state.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // —— 月历数据：6×7 网格 + 每日农历 / 假日摘要 ——
  const gridDays = useMemo(() => buildMonthGrid(anchor.getFullYear(), anchor.getMonth()), [anchor]);
  const gridMeta = useMemo(() => {
    const map = new Map<number, DayMeta>();
    for (const dayMs of gridDays) {
      const d = new Date(dayMs);
      const holiday = holidayOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
      map.set(dayMs, {
        info: dayInfo(d.getFullYear(), d.getMonth() + 1, d.getDate()),
        holidayKind: holiday.kind,
        holidayName: holiday.name,
      });
    }
    return map;
  }, [gridDays]);
  const monthTitle = `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`;

  // —— 选中日的事项（与主窗口同一过滤口径：当日 + 不隐藏已完成）——
  const dayTodos = useMemo(
    () => filterTodos(todos, 'day', anchorMs, false),
    [todos, anchorMs],
  );
  const pendingCount = dayTodos.filter((todo) => !todo.done).length;

  // —— 添加事项（Enter 创建；dueAt 固定落到选中日 —— 修复「添加后列表没变化」）——
  const [draftTitle, setDraftTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const handleCreate = async (): Promise<void> => {
    const title = draftTitle.trim();
    if (title === '' || creating) {
      return;
    }
    setCreating(true);
    try {
      await createTodo({ title, priority: 1, dueAt: defaultMomentOfDay(anchorMs) });
      setDraftTitle('');
    } finally {
      setCreating(false);
      inputRef.current?.focus();
    }
  };

  // —— 几何持久化：moved / resized 停稳后写 settings.workstationDockGeometry ——
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let unlisteners: Array<() => void> = [];

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const scaleFactor = await win.scaleFactor();
        let geo: { x: number; y: number; w: number; h: number } | null = null;

        const scheduleSave = (): void => {
          if (timer !== undefined) {
            window.clearTimeout(timer);
          }
          timer = window.setTimeout(() => {
            if (!cancelled && geo !== null) {
              // 静默落盘：几何写失败只影响「下次启动恢复位置」，不提示
              void patchSettings({ workstationDockGeometry: { ...geo } }).catch(() => undefined);
            }
          }, GEOMETRY_SAVE_DEBOUNCE_MS);
        };

        const onMoved = await win.onMoved(({ payload }) => {
          const pos = payload.toLogical(scaleFactor);
          geo = { ...(geo ?? { x: 0, y: 0, w: 0, h: 0 }), x: pos.x, y: pos.y };
          scheduleSave();
        });
        const onResized = await win.onResized(({ payload }) => {
          const size = payload.toLogical(scaleFactor);
          geo = { ...(geo ?? { x: 0, y: 0, w: 0, h: 0 }), w: size.width, h: size.height };
          scheduleSave();
        });
        if (cancelled) {
          onMoved();
          onResized();
          return;
        }
        unlisteners = [onMoved, onResized];
      } catch (error: unknown) {
        console.error('[Toolbox] 停靠窗几何监听失败（不影响展示）：', error);
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);

  const handleClose = (): void => {
    // 收起（非退出）：窗口由 Rust 侧保留，恢复零开销
    void ipc.workstationDockHide().catch(() => undefined);
  };

  const stepMonth = (delta: number): void => {
    const next = new Date(anchor);
    next.setDate(1);
    next.setMonth(next.getMonth() + delta);
    setAnchorMs(next.getTime());
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background/50 text-foreground">
      {/* —— 时钟区（也是拖拽区）：替代任务栏时钟的主视觉 —— */}
      <div
        data-tauri-drag-region
        className="group relative flex shrink-0 cursor-grab select-none flex-col items-center px-4 pb-3 pt-5 active:cursor-grabbing"
      >
        <button
          type="button"
          onClick={handleClose}
          title="收起（设置中心可重新打开）"
          aria-label="收起工作台停靠窗"
          className="absolute right-2 top-2 rounded p-1 text-muted-foreground/70 opacity-0 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <p className="flex items-baseline gap-2 tabular-nums leading-none">
          <span className="text-[56px] font-extralight tracking-tight">{clock.hhmm}</span>
          <span className="text-lg font-light text-brand/80">{clock.ss}</span>
        </p>
        <p className="mt-2 text-[13px] font-medium">
          {isToday ? '今天 · ' : ''}
          {dayLabel(anchorMs).replace(/^\S+?\s/, '')}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {WEEK_FULL[anchor.getDay()]} · {anchorMetaText(anchorMs)}
        </p>
      </div>

      <div className="mx-4 shrink-0 border-t border-border/50" />

      {/* —— 精简月历 —— */}
      <section className="shrink-0 px-4 pt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-xs font-semibold tracking-wide">{monthTitle}</p>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => stepMonth(-1)}
              title="上一月"
              aria-label="上一月"
              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => setAnchorMs(startOfDay(now))}
              title="回到今天"
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              今天
            </button>
            <button
              type="button"
              onClick={() => stepMonth(1)}
              title="下一月"
              aria-label="下一月"
              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              ›
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-y-0.5 text-center">
          {WEEK_HEAD.map((label, index) => (
            <span
              key={label}
              className={`pb-1 text-[10px] ${index >= 5 ? 'text-brand/70' : 'text-muted-foreground/70'}`}
            >
              {label}
            </span>
          ))}
          {gridDays.map((dayMs) => {
            const meta = gridMeta.get(dayMs);
            const inMonth = new Date(dayMs).getMonth() === anchor.getMonth();
            const selected = isSameDay(dayMs, anchorMs);
            const today = isSameDay(dayMs, now);
            const rest = meta?.holidayKind === 'rest';
            const workdaySwap = meta?.holidayKind === 'work';
            const label = meta === undefined ? '' : metaLabel(meta);
            return (
              <button
                key={dayMs}
                type="button"
                onClick={() => setAnchorMs(dayMs)}
                aria-label={dayLabel(dayMs)}
                aria-current={today ? 'date' : undefined}
                className={`flex flex-col items-center rounded-md py-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected ? 'bg-brand/15 ring-1 ring-brand' : 'hover:bg-accent/60'
                } ${inMonth ? '' : 'opacity-30'}`}
              >
                <span
                  className={`relative text-[13px] leading-tight ${
                    today ? 'font-bold text-brand' : ''
                  }`}
                >
                  {new Date(dayMs).getDate()}
                  {rest ? (
                    <span className="absolute -right-2.5 -top-1 text-[8px] font-semibold text-red-500">
                      休
                    </span>
                  ) : workdaySwap ? (
                    <span className="absolute -right-2.5 -top-1 text-[8px] font-semibold text-sky-500">
                      班
                    </span>
                  ) : null}
                </span>
                <span
                  className={`max-w-full truncate text-[9px] leading-tight ${
                    rest ? 'text-red-500/80' : workdaySwap ? 'text-sky-500/80' : 'text-muted-foreground/70'
                  }`}
                >
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="mx-4 mt-3 shrink-0 border-t border-border/50" />

      {/* —— 选中日事项：添加 + 勾选，数据与主窗口实时互通 —— */}
      <section className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3">
        <p className="mb-2 flex items-center justify-between text-xs font-semibold tracking-wide">
          <span>
            {anchor.getMonth() + 1} 月 {anchor.getDate()} 日事项
            {pendingCount > 0 ? (
              <span className="ml-1.5 font-normal text-muted-foreground">待办 {pendingCount}</span>
            ) : null}
          </span>
          <span className="text-[10px] font-normal text-muted-foreground">回车添加</span>
        </p>
        <div className="mb-2 flex items-center gap-1.5">
          <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleCreate();
              }
            }}
            placeholder="添加事项…"
            aria-label={`为 ${dayLabel(anchorMs)} 添加事项`}
            className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-1 text-xs outline-none placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <div className="scrollbar-thin -mr-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
          {dayTodos.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-muted-foreground/70">
              这一天还没有安排
            </p>
          ) : (
            dayTodos.map((todo) => (
              <div
                key={todo.id}
                className="group flex items-center gap-2 rounded-md px-1 py-1 transition hover:bg-accent/50"
              >
                <button
                  type="button"
                  onClick={() => {
                    void toggleDone(todo.id).catch(() => undefined);
                  }}
                  title={todo.done ? '标记未完成' : '标记完成'}
                  aria-pressed={todo.done}
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    todo.done ? 'border-brand bg-brand text-white' : 'border-muted-foreground/50'
                  }`}
                >
                  {todo.done ? <Check className="h-2 w-2" /> : null}
                </button>
                <span
                  className={`min-w-0 flex-1 truncate text-xs ${todo.done ? 'text-muted-foreground line-through' : ''}`}
                >
                  {todo.title}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

/** 头部农历摘要（今天那行的小字：传统节日 / 法定假日 / 节气 > 干支生肖 > 农历日） */
function anchorMetaText(ms: number): string {
  const d = new Date(ms);
  const info = dayInfo(d.getFullYear(), d.getMonth() + 1, d.getDate());
  const holiday = holidayOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
  if (info.lunarFestival !== null) {
    return info.lunarFestival;
  }
  if (holiday.name !== null) {
    return holiday.name;
  }
  if (info.term !== null) {
    return info.term;
  }
  const gz = ganZhi(d.getFullYear());
  return `${gz.ganZhi}年 · 属${gz.zodiac}`;
}

/** 选中日的默认时刻（上午 9 点，避开零点临界；与主窗口新建事项口径一致） */
function defaultMomentOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
