import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, X } from 'lucide-react';
import { useTodosStore } from '@/stores/useTodosStore';
import { useNotesStore } from '@/stores/useNotesStore';
import { dayInfo, type DayInfo } from '@/lib/lunar';
import { holidayOf } from '@/lib/holidays';
import { patchSettings } from '@/lib/store';
import { isTauri } from '@/platform/detect';
import { ipc } from '@/lib/ipc';
import { CalendarPanel } from './CalendarPanel';
import { PlanPanel } from './PlanPanel';
import { NotesPanel } from './NotesPanel';
import { pendingCountByDay, relativeDayLabel, startOfDay, type PlanScope } from './planUtils';

/**
 * 工作台桌面停靠视图（V64）。
 *
 * 形态与便签一致：**无边框独立窗、置顶盯住桌面右缘**，用户关不掉应用只能收起
 * （设置中心 / 标题栏 ✕ 都是「隐藏」，几何与内容全保留）。
 *
 * 与主窗口工作台（`WorkstationView`）的差异：
 * - **竖排窄栏**（默认 360px 宽）：时钟头部 → 日历 → 计划（默认看「今天」）→ 便签，
 *   整列滚动，无右侧快捷栏；
 * - **几何持久化到 `settings.workstationDockGeometry`**（而非 localStorage）：
 *   Rust 开窗时要直接取用，settings.json 是两端共享的单一事实源；
 * - 数据与主窗口完全同源（`useTodosStore` / `useNotesStore` → 同一份 SQLite），
 *   两边改动实时互通。
 */

/** 几何落库防抖（拖动 / 缩放停稳后写入，与便签同口径） */
const GEOMETRY_SAVE_DEBOUNCE_MS = 500;

/** 中文星期（getDay：0 = 周日） */
const WEEKDAYS: readonly string[] = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 时钟 HH:mm:ss（两位补零） */
function clockOf(ms: number): { hhmm: string; ss: string } {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return { hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`, ss: pad(d.getSeconds()) };
}

/** 农历 / 节气 / 假日摘要（与主工作台同一优先级：节日 > 假日 > 节气） */
function daySuffix(info: DayInfo, holidayName: string | null): string {
  if (info.lunarFestival !== null) {
    return info.lunarFestival;
  }
  if (holidayName !== null) {
    return holidayName;
  }
  if (info.term !== null) {
    return info.term;
  }
  if (info.lunar !== null) {
    return `农历${info.lunar.monthName}${info.lunar.dayName}`;
  }
  return '';
}

export function WorkstationDockView(): React.JSX.Element {
  // —— 时钟（每秒刷新，与系统时间同步）——
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const clock = useMemo(() => clockOf(now), [now]);
  const dateLabel = useMemo(() => {
    const d = new Date(now);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
  }, [now]);
  const lunarLabel = useMemo(() => {
    const d = new Date(now);
    const info = dayInfo(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return daySuffix(info, holidayOf(d.getFullYear(), d.getMonth() + 1, d.getDate()).name);
  }, [now]);

  // —— 待办 / 便签（与主窗口同源数据层）——
  const todos = useTodosStore((state) => state.todos);
  const hydrateTodos = useTodosStore((state) => state.hydrate);
  const hydrateNotes = useNotesStore((state) => state.hydrate);
  useEffect(() => {
    void hydrateTodos();
    void hydrateNotes();
  }, [hydrateTodos, hydrateNotes]);

  // —— 日历 / 计划状态（默认看「今天」）——
  const [anchorMs, setAnchorMs] = useState<number>(() => startOfDay(Date.now()));
  const [scope, setScope] = useState<PlanScope>('day');
  const [hideDone, setHideDone] = useState<boolean>(false);
  const [focusToken, setFocusToken] = useState<number>(0);
  const pendingByDay = useMemo(() => pendingCountByDay(todos), [todos]);

  const handleSelectDay = (dayMs: number): void => {
    setAnchorMs(startOfDay(dayMs));
    setScope('day');
    setFocusToken((token) => token + 1);
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

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-canvas shadow-2xl ring-1 ring-border">
      {/* 标题栏：拖拽区 + 关闭 */}
      <header
        data-tauri-drag-region
        className="flex h-9 shrink-0 cursor-grab select-none items-center gap-2 border-b border-border px-3 active:cursor-grabbing"
      >
        <CalendarDays data-tauri-drag-region className="h-3.5 w-3.5 shrink-0 text-brand" />
        <span data-tauri-drag-region className="flex-1 truncate text-xs font-medium text-foreground">
          工作台
        </span>
        <button
          type="button"
          onClick={handleClose}
          title="收起（设置中心可重新打开）"
          aria-label="收起工作台停靠窗"
          className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* 时钟头：时间 + 日期农历 */}
      <div className="flex shrink-0 items-baseline justify-between gap-2 px-3 pb-2 pt-3">
        <p className="flex items-baseline gap-1 tabular-nums text-brand">
          <span className="text-2xl font-semibold">{clock.hhmm}</span>
          <span className="text-xs font-medium text-brand/70">{clock.ss}</span>
        </p>
        <div className="min-w-0 text-right">
          <p className="truncate text-xs font-medium text-foreground">{dateLabel}</p>
          {lunarLabel !== '' ? (
            <p className="truncate text-[11px] text-muted-foreground">{lunarLabel}</p>
          ) : null}
        </div>
      </div>

      {/* 内容列：日历 → 计划 → 便签，整列滚动 */}
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
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
        <div className="flex min-h-[220px] flex-col">
          <p className="mb-1 text-[11px] text-muted-foreground">
            便签 · 当前查看 {relativeDayLabel(anchorMs)}
          </p>
          <NotesPanel />
        </div>
      </div>
    </div>
  );
}
