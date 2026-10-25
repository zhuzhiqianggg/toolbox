import React, { useEffect, useMemo, useState } from 'react';
import { useTodosStore } from '@/stores/useTodosStore';
import { patchSettings } from '@/lib/store';
import { isTauri } from '@/platform/detect';
import { ipc } from '@/lib/ipc';
import { Toaster } from '@/components/ui/toast';
import { CalendarPanel } from './CalendarPanel';
import { PlanPanel } from './PlanPanel';
import { QuickActionsRail } from './QuickActionsRail';
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

/**
 * dock 内「应用内跳转」的跨窗实现（V72）：
 * 停靠窗与主窗各有独立 JS 上下文，本窗 setView 主窗看不到 —— 先唤起主窗
 * （托盘形态常驻，show 即还原），再广播导航事件，由主窗 main.tsx 监听后
 * 按 openTarget 规则切视图。系统面板类动作不经此路：直接在停靠窗本地执行。
 */
function dockNavigate(target: string): void {
  void ipc.appShowMain().catch(() => undefined);
  void import('@tauri-apps/api/event')
    .then(({ emit }) => emit('toolbox:navigate', target))
    .catch(() => undefined);
}

/** 时钟 HH:mm:ss（两位补零） */
function clockOf(ms: number): { hhmm: string; ss: string } {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return { hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`, ss: pad(d.getSeconds()) };
}

export function WorkstationDockView(): React.JSX.Element {
  // —— 时钟（每秒刷新，与系统时间同步）——
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const clock = useMemo(() => clockOf(now), [now]);

  // —— 双列布局判定（V78）：宽 ≥660 左计划 / 右日历，窄窗回落单列 ——
  // V77 及以前阈值是 560，而右列固定 332 —— 620~700 宽时左列只剩 200 出头，
  // 待办标题被挤成一列字、日历格子也缩水，用户直说「布局很烂」。阈值抬到 660，
  // 并且右列从 332 收到 320，默认窗宽同时由 680 放宽到 760（Rust DOCK_DEFAULT_W）。
  const [windowW, setWindowW] = useState<number>(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setWindowW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const twoCol = windowW >= 660;

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

  return (
    // Mica 材质上轻铺一层半透明底（不遮死壁纸染色），去阴影去描边 = 「长在桌面上」
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background/25">
      {/*
        V76：去掉「工作台」标题栏与关闭按钮（用户明确：本来就只有一个工作台，
        这个标题不提供任何信息，却实打实吃掉 36px 高度）。拖动改为时钟区兜底：
        整块带 data-tauri-drag-region，时钟文字块也带一份，按住即可拖窗。

        V77：时钟与日期「看着乱」→ 收敛成左右两组：
        左 = HH:mm 大号 + 秒（同基线、无底色徽标，不再像一枚贴纸）；
        右 = 完整日期 + 农历，右对齐单行/两行，字号压到 12/10。
      */}
      <div
        data-tauri-drag-region
        className="relative flex shrink-0 select-none items-center justify-between gap-3 px-3 pb-2 pt-3"
      >
        <div data-tauri-drag-region className="flex items-baseline">
          {/* V81：秒不再缩小一号 —— 与 HH:mm 同字号、以浅色区分（用户口径：
              「设成一样大小，然后用不同的颜色来表示」，读起来才是一个完整的时刻） */}
          <span
            data-tauri-drag-region
            className="tabular-nums text-[27px] font-semibold leading-none tracking-tight text-foreground"
          >
            {clock.hhmm}
          </span>
          <span
            data-tauri-drag-region
            className="tabular-nums text-[27px] font-semibold leading-none tracking-tight text-muted-foreground/45"
          >
            :{clock.ss}
          </span>
        </div>
        {/*
          * V82：顶栏右侧的「日期 + 农历」整块删掉 —— 用户口径：Windows 任务栏
          * 本来就有时间日期，这里再放一遍纯属重复；而且选中日详情里已经给出
          * 更完整的阳历 / 农历 / 干支。顶栏只留时钟当视觉锚点，腾出的高度给面板。
          */}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-brand/25 to-transparent" />
      </div>

      {/* 内容区（V81 等宽双列）：左计划 / 右日历各占一半 —— V78 之前右列固定 320px，
          左右差着 200 多像素，用户直评「整体怪怪的、日历框和待办框等宽更好看」。
          两个 flex-1（basis 0）严格均分，日历格随宽度自然变大 */}
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
              glass
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex min-h-0 flex-1 flex-col">
              {/* 停靠窗只读：生日与纪念日统一回主界面工作台配置（V81） */}
              <CalendarPanel
                anchorMs={anchorMs}
                onSelect={handleSelectDay}
                pendingByDay={pendingByDay}
                anniversariesEditable={false}
                glass
              />
            </div>
            <QuickActionsRail variant="dock" onNavigate={dockNavigate} />
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
              glass
            />
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            <CalendarPanel
              anchorMs={anchorMs}
              onSelect={handleSelectDay}
              pendingByDay={pendingByDay}
              anniversariesEditable={false}
            />
            <QuickActionsRail variant="dock" onNavigate={dockNavigate} />
          </div>
        </div>
      )}

      {/* 独立窗口的 toast 渲染器：PlanPanel 添加/勾选的成功与失败提示都走 sonner，
          V66 之前本窗没挂 Toaster，所有提示静默丢失 = 用户看到「回车没反应」 */}
      <Toaster />
    </div>
  );
}
