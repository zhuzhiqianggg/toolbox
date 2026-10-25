import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, X } from 'lucide-react';
import { useTodosStore } from '@/stores/useTodosStore';
import { dayInfo, type DayInfo } from '@/lib/lunar';
import { holidayOf } from '@/lib/holidays';
import { patchSettings } from '@/lib/store';
import { isTauri } from '@/platform/detect';
import { ipc } from '@/lib/ipc';
import { Toaster } from '@/components/ui/toast';
import { CalendarPanel } from './CalendarPanel';
import { PlanPanel } from './PlanPanel';
import { pendingCountByDay, startOfDay, type PlanScope } from './planUtils';

/**
 * 工作台桌面停靠视图（V67 双列布局）。
 *
 * 形态：**无边框独立窗、置顶盯住桌面右缘、上下严丝合缝**；Rust 侧配 Mica 透明
 * 材质（Win11 壁纸淡染、失焦不退化），前端只轻铺一层半透明底保证可读。
 *
 * 功能布局（V64 完整功能 + V68 双列：左计划 / 右日历）：
 * - 时钟头横贯顶部 → **左列完整 PlanPanel**（当日 / 本周 / 本月…，主操作区，醒目优先），
 *   **右列完整 CalendarPanel**（年月导航 / 农历节日 / 休班角标 / 纪念日管理 / 图例）——
 *   两列各自独立滚动；
 * - 窗宽 < 560px 自动回落单列（用户拖窄时保持可用）；
 * - **不放便签**（V65 用户明确要求「便签功能不要搞到工作台里面」）；
 * - 几何持久化到 `settings.workstationDockGeometry`（Rust 开窗直接取用）；
 * - 数据与主窗口完全同源（同一份 SQLite），两边改动实时互通。
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

  // —— 双列布局判定（V67）：宽 ≥560 左计划 / 右日历，窄窗回落单列 ——
  const [windowW, setWindowW] = useState<number>(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setWindowW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const twoCol = windowW >= 560;
  const lunarLabel = useMemo(() => {
    const d = new Date(now);
    const info = dayInfo(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return daySuffix(info, holidayOf(d.getFullYear(), d.getMonth() + 1, d.getDate()).name);
  }, [now]);

  // —— 待办（与主窗口同源数据层；便签按 V65 要求不进停靠窗）——
  const todos = useTodosStore((state) => state.todos);
  const hydrateTodos = useTodosStore((state) => state.hydrate);
  useEffect(() => {
    void hydrateTodos();
  }, [hydrateTodos]);

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
    // Mica 材质上轻铺一层半透明底（不遮死壁纸染色），去阴影去描边 = 「长在桌面上」
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background/40">
      {/* 标题栏：拖拽区 + 关闭 */}
      <header
        data-tauri-drag-region
        className="flex h-9 shrink-0 cursor-grab select-none items-center gap-2 border-b border-border/60 px-3 active:cursor-grabbing"
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

      {/* 内容区（V68 双列，V71 等高撑满）：左计划（主操作区）/ 右日历。
          面板经 h-full 撑满列高、各自内部滚动 —— 不再出现「内容少时面板缩短、
          底下留一大片裸 Mica」的失衡观感；窗宽不足 560 时回落单列（计划在上、日历在下） */}
      {twoCol ? (
        <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
          <div className="flex min-h-0 flex-1 flex-col">
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
          <div className="flex min-h-0 w-[320px] shrink-0 flex-col border-l border-border/60 pl-3">
            <CalendarPanel anchorMs={anchorMs} onSelect={handleSelectDay} pendingByDay={pendingByDay} />
          </div>
        </div>
      ) : (
        // 单列：面板按内容高度排布、外层滚动（包一层非拉伸容器抵消面板的 h-full）
        <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
          <div className="flex shrink-0 flex-col">
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
          <div className="flex shrink-0 flex-col">
            <CalendarPanel anchorMs={anchorMs} onSelect={handleSelectDay} pendingByDay={pendingByDay} />
          </div>
        </div>
      )}

      {/* 独立窗口的 toast 渲染器：PlanPanel 添加/勾选的成功与失败提示都走 sonner，
          V66 之前本窗没挂 Toaster，所有提示静默丢失 = 用户看到「回车没反应」 */}
      <Toaster />
    </div>
  );
}
