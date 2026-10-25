import { useEffect } from 'react';
import { isTauri } from '@/platform/detect';
import { useAppStore } from '@/stores/useAppStore';

/** Rust `window::MAIN_SHOWN_EVENT`：主窗口被唤出显示（隐藏路径不发）。载荷 = 关闭来源 */
const MAIN_SHOWN_EVENT = 'toolbox://main-shown';

/**
 * 全局呼出行为（V64，用户口径）：
 *
 * - **呼出键 / 托盘打开（`palette`）**：启动器语义 —— 无论上次停在哪（工具页 / 模块页 /
 *   设置页），一律切回命令面板并聚焦搜索框，用户直接输入即可过滤工具。
 *   解决「第一次呼出能到搜索框、之后切不回去」的不一致。
 * - **主动关闭后的重开（`resume`）**：用户点过关闭钮 / Alt+F4 = 「收起当前工作」，
 *   下次呼出**保持原页面**不打断上下文；原本就停在面板时聚焦搜索框。
 *   任何页面内按 `Esc` 都能随时回到命令面板。
 */
export function useHotkeyOpen(): void {
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<string>(MAIN_SHOWN_EVENT, (event) => {
          const mode = event.payload === 'resume' ? 'resume' : 'palette';
          const { view, setView } = useAppStore.getState();
          if (mode === 'resume') {
            // 上次主动关闭：原页面原样保留（工具输入由 usePersistedState 落盘）
            if (view.kind !== 'palette') {
              return;
            }
          } else {
            // 启动器语义：一律回命令面板
            if (view.kind !== 'palette') {
              setView({ kind: 'palette' });
            }
          }
          // 等命令面板挂载完成后聚焦搜索框并全选旧查询（无查询时 select 为 no-op）
          window.setTimeout(() => {
            const input = document.querySelector<HTMLInputElement>('[cmdk-input]');
            input?.focus();
            input?.select();
          }, 80);
        }),
      )
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        /* 浏览器环境无 Tauri IPC，忽略 */
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
