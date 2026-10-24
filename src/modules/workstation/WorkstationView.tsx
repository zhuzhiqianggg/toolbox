import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Info } from 'lucide-react';
import { isTauri } from '@/platform/detect';
import { useTodosStore } from '@/stores/useTodosStore';
import { useNotesStore } from '@/stores/useNotesStore';
import { dayInfo, ganZhi, type DayInfo } from '@/lib/lunar';
import { holidayOf } from '@/lib/holidays';
import { CalendarPanel } from './CalendarPanel';
import { PlanPanel } from './PlanPanel';
import { NotesPanel } from './NotesPanel';
import { QuickActionsRail } from './QuickActionsRail';
import {
  addDays,
  pendingCountByDay,
  relativeDayLabel,
  startOfDay,
  startOfWeek,
  startOfMonth,
  startOfNextMonth,
  type PlanScope,
} from './planUtils';

/**
 * 工作台（路由 id 仍为 `notes`，便于零迁移）。
 *
 * # 布局（V21 按用户反馈再调）
 *
 * ```
 * ┌────────────────────────────────────────────┬──────┐
 * │ 问候 / 日期+农历 / 概览数字       时钟(到秒) │ 快捷 │
 * ├────────────────────────┬───────────────────┤ 入口 │
 * │  日历（农历/节气/休班） │  计划 · 任务列表   │ 图标 │
 * │  ← 两栏**真正等高**，撑满剩余高度           │ 栏   │
 * ├────────────────────────┴───────────────────┤      │
 * │  便签（固定高度 · 内部滚动）                 │      │
 * └────────────────────────────────────────────┴──────┘
 * ```
 *
 * 用户原话：「工作台上的日期和时间分到两边展示，而且时间没有显示秒，时间和系统时间
 * 不同步……日历里面最好可以添加农历、节假日等内容」「日历的显示最好和右边的计划任务
 * 对齐高度，或者有更加协调对称的布局方案」。
 *
 * 数据说明：待办与便签**完全复用**既有 `useTodosStore` / `useNotesStore`（同一份 SQLite），
 * 因此工作台与「待办清单」命令看到的是同一批数据，改动实时互通。
 */

/** 中文星期（getDay：0 = 周日） */
const WEEKDAYS: readonly string[] = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export interface WorkstationViewProps {
  /** 兼容 CommandProps（命令视图注入，未使用） */
  initialInput?: string;
  /** 兼容 ModuleProps（模块内页注入，未使用） */
  windowKind?: string;
}

/** 按时间段问候：5–12 早上好，12–18 下午好，其余晚上好 */
function greetingOf(hour: number): string {
  if (hour >= 5 && hour < 12) {
    return '早上好';
  }
  if (hour >= 12 && hour < 18) {
    return '下午好';
  }
  return '晚上好';
}

/** 中文日期：yyyy年M月d日 · 星期X */
function dateLabelOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · ${WEEKDAYS[d.getDay()]}`;
}

/** 时钟 HH:mm:ss（两位补零；每秒刷新，与系统时间同步） */
function clockOf(ms: number): { hhmm: string; ss: string } {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    ss: pad(d.getSeconds()),
  };
}

/**
 * 把「今天」的农历 / 节气 / 节假日拼成一句人话。
 *
 * 优先级：节日 > 节气 > 法定假日名。都没有时退化成农历日 + 星期属性。
 */
function todaySuffix(info: DayInfo, holidayName: string | null, isOff: boolean): string {
  const parts: string[] = [];
  if (info.lunarFestival !== null) {
    parts.push(info.lunarFestival);
  } else if (holidayName !== null) {
    parts.push(holidayName);
  } else if (info.term !== null) {
    parts.push(info.term);
  }
  if (info.lunar !== null) {
    parts.push(`农历${info.lunar.monthName}${info.lunar.dayName}`);
  }
  parts.push(isOff ? '休息日' : '工作日');
  return parts.join(' · ');
}

export default function WorkstationView(_props: WorkstationViewProps = {}): React.JSX.Element {
  // —— 头部时钟：每秒刷新（用户反馈「时间没有显示秒、和系统时间不同步」）——
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const greeting = useMemo(() => greetingOf(new Date(now).getHours()), [now]);
  const dateLabel = useMemo(() => dateLabelOf(now), [now]);
  const clock = useMemo(() => clockOf(now), [now]);

  // —— 今天的农历 / 节气 / 节假日 ——
  const todayInfo = useMemo(() => {
    const d = new Date(now);
    const info = dayInfo(d.getFullYear(), d.getMonth() + 1, d.getDate());
    const holiday = holidayOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return {
      ...info,
      suffix: todaySuffix(info, holiday.name, holiday.off),
      gz: ganZhi(d.getFullYear()),
    };
  }, [now]);

  // —— 待办（复用既有数据层）——
  const todos = useTodosStore((state) => state.todos);
  const todosError = useTodosStore((state) => state.error);
  const hydrateTodos = useTodosStore((state) => state.hydrate);
  useEffect(() => {
    void hydrateTodos();
  }, [hydrateTodos]);

  // —— 便签（复用既有数据层，仅做加载与统计）——
  const notes = useNotesStore((state) => state.notes);
  const hydrateNotes = useNotesStore((state) => state.hydrate);
  useEffect(() => {
    void hydrateNotes();
  }, [hydrateNotes]);

  // —— 日历 / 范围状态 ——
  const [anchorMs, setAnchorMs] = useState<number>(() => startOfDay(Date.now()));
  const [scope, setScope] = useState<PlanScope>('day');
  const [hideDone, setHideDone] = useState<boolean>(false);
  /** 递增信号：点日历后聚焦「新增事件」输入框 */
  const [focusToken, setFocusToken] = useState<number>(0);

  const pendingByDay = useMemo(() => pendingCountByDay(todos), [todos]);

  /** 头部概览：今日 / 本周 / 本月 未完成数 */
  const overview = useMemo(() => {
    const today = startOfDay(Date.now());
    const weekEnd = addDays(startOfWeek(Date.now()), 7);
    const monthEnd = startOfNextMonth(Date.now());
    let todayCount = 0;
    let weekCount = 0;
    let monthCount = 0;
    let overdue = 0;
    for (const todo of todos) {
      if (todo.done) {
        continue;
      }
      if (todo.dueAt !== null) {
        if (todo.dueAt >= today && todo.dueAt < addDays(today, 1)) {
          todayCount += 1;
        }
        if (todo.dueAt >= startOfWeek(Date.now()) && todo.dueAt < weekEnd) {
          weekCount += 1;
        }
        if (todo.dueAt >= startOfMonth(Date.now()) && todo.dueAt < monthEnd) {
          monthCount += 1;
        }
        if (todo.dueAt < today) {
          overdue += 1;
        }
      }
    }
    return { todayCount, weekCount, monthCount, overdue, noteCount: notes.length };
  }, [todos, notes.length]);

  const handleSelectDay = (dayMs: number): void => {
    setAnchorMs(startOfDay(dayMs));
    setScope('day');
    setFocusToken((token) => token + 1);
  };

  const statChip = (label: string, value: number, tone: 'normal' | 'warn' = 'normal'): React.JSX.Element => (
    <span
      className={
        tone === 'warn' && value > 0
          ? 'rounded-md bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive'
          : 'rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground'
      }
    >
      {label} <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </span>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-canvas">
      {/* —— 问候头部：左侧日期，右侧时钟（用户反馈「分到两边展示」）—— */}
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 px-6 pb-4 pt-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-foreground">{greeting}</h1>
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5" />
            {dateLabel}
            <span className="text-muted-foreground/40">|</span>
            <span className="text-muted-foreground/90" title={`${todayInfo.gz.ganZhi}年 · 属${todayInfo.gz.zodiac}`}>
              {todayInfo.suffix}
            </span>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {statChip('今日', overview.todayCount)}
            {statChip('本周', overview.weekCount)}
            {statChip('本月', overview.monthCount)}
            {overview.overdue > 0 ? statChip('逾期', overview.overdue, 'warn') : null}
            {statChip('便签', overview.noteCount)}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <p className="flex items-baseline gap-1 tabular-nums text-brand" title="当前时间（每秒刷新）">
            <span className="text-2xl font-semibold">{clock.hhmm}</span>
            <span className="text-sm font-medium text-brand/70">{clock.ss}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            当前查看：{relativeDayLabel(anchorMs)}
          </p>
        </div>
      </header>

      {todosError !== null ? (
        isTauri() ? (
          <div className="mx-6 mb-3 flex shrink-0 items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <Info className="h-3.5 w-3.5 shrink-0" />
            加载待办失败：{todosError}
          </div>
        ) : (
          <div className="mx-6 mb-3 flex shrink-0 items-center gap-2 rounded-md border border-brand/15 bg-brand-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0 text-brand" />
            浏览器预览模式：待办与便签数据存储在本机 SQLite 中，请在 Toolbox 桌面版中使用完整功能。
          </div>
        )
      ) : null}

      {/* —— 主区：内容列 + 右侧快捷入口图标栏 —— */}
      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        {/*
          * 内容列**自身可滚动**：窗口够高时上排 flex-1 撑满（日历与计划保持等高），
          * 窗口被压矮时上排退到 min-h 保底、由这一层出滚动条 ——
          * 而不是让面板各自的 min-h 撑破格子、互相盖住（V22 修复用户截图里的重叠）。
          */}
        <div className="scrollbar-thin flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
          {/*
            * 上排：日历（左） | 计划（右）—— `lg` 起两栏并排且等高、一起撑满剩余高度。
            *
            * ⚠️ V23：`flex-1` / `min-h-[440px]` 都**只在 `lg` 起生效**。
            * 窄窗口下这里是单栏，若还挂着 `flex-1`（`flex: 1 1 0%`），
            * 外层内容列虽写了 `overflow-y-auto`，但 flex 子项会**先被压缩**而不是溢出，
            * 于是「计划」面板被挤成 19px 高的空壳（V23 无头实测在 680px 复现）。
            * 单栏时一律按内容高度排布，滚动交给外层内容列。
            */}
          <div className="grid grid-cols-1 gap-4 lg:min-h-[440px] lg:flex-1 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
            <CalendarPanel anchorMs={anchorMs} onSelect={handleSelectDay} pendingByDay={pendingByDay} />
            <PlanPanel
              todos={todos}
              anchorMs={anchorMs}
              scope={scope}
              onScopeChange={setScope}
              hideDone={hideDone}
              onHideDoneChange={setHideDone}
              focusToken={focusToken}
            />
          </div>

          {/* 下排：便签（固定高度，面板内部滚动，全屏时不会把上排挤走）
              V23：窄窗口下这里更矮更窄，编辑器会被压得只剩两三行 —— 给窄屏多留 80px */}
          <div className="h-[380px] shrink-0 lg:h-[300px]">
            <NotesPanel />
          </div>
        </div>

        {/* 右侧：竖排快捷入口（随手可点，悬停出说明） */}
        <QuickActionsRail />
      </div>
    </div>
  );
}
