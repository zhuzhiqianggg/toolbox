import * as React from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { isTauri } from '@/platform/detect';
import { hideToTray, subscribeStatus, toggleMaximize } from '@/lib/windowShell';
import { cn } from '@/lib/utils';

/**
 * 自定义标题栏（无边框窗口必备：`decorations: false` 时没有原生标题栏）。
 *
 * - 整条 bar 为拖拽区（`data-tauri-drag-region`），可拖动窗口；
 * - 右侧提供 最小化 / 最大化·还原 / 关闭。本应用为**托盘优先**形态（`skipTaskbar: true`），
 *   主窗口**不进原生最小化态**——「最小化」与「关闭」同语义，均 = 隐藏到托盘（复用 `app_hide_main`）；
 *   原生 `windowShell.minimize()` 仅留给便签等独立窗口；
 * - **仅在 Tauri 宿主内渲染**，浏览器预览不显示（避免干扰冒烟测试与截图）。
 */
export function TitleBar(): React.JSX.Element | null {
  const [maximized, setMaximized] = React.useState<boolean>(false);

  // 最大化状态：事件 + 轮询双通道刷新（无边框窗口的最大化事件不可靠）
  React.useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void subscribeStatus((status) => {
      if (!disposed) {
        setMaximized(status.maximized);
      }
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      cleanup = fn;
    });
    return () => {
      disposed = true;
      if (cleanup !== null) {
        cleanup();
      }
    };
  }, []);

  if (!isTauri()) {
    return null;
  }

  const buttonClass =
    'flex h-8 w-9 items-center justify-center text-muted-foreground transition-colors ' +
    'hover:bg-accent hover:text-accent-foreground';

  return (
    <header
      data-tauri-drag-region
      className="flex h-8 shrink-0 select-none items-center gap-2 border-b border-border bg-background px-2"
    >
      <span
        data-tauri-drag-region
        className="h-2 w-2 shrink-0 rounded-full bg-brand"
        aria-hidden="true"
      />
      <span
        data-tauri-drag-region
        className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground"
      >
        Toolbox
      </span>
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          title="最小化（收起到托盘）"
          aria-label="最小化（收起到托盘）"
          onClick={() => {
            // V16 修复：托盘优先形态（skipTaskbar:true）下，原生最小化会让窗口"丢失"
            // 且无任务栏入口可恢复。故「最小化」= 隐藏到托盘（与关闭按钮同语义）。
            void hideToTray();
          }}
          className={cn(buttonClass)}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => {
            void toggleMaximize().then(setMaximized);
          }}
          className={cn(buttonClass)}
        >
          {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          title="关闭（隐藏到托盘）"
          aria-label="关闭（隐藏到托盘）"
          onClick={() => {
            void hideToTray();
          }}
          className={cn(buttonClass, 'hover:bg-destructive/10 hover:text-destructive')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}

export default TitleBar;
