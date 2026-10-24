import { useEffect } from 'react';
import { isTauri } from '@/platform/detect';
import { useAppStore } from '@/stores/useAppStore';

/** Rust `window::MAIN_SHOWN_EVENT`：主窗口被全局快捷键唤出显示（隐藏路径不发） */
const MAIN_SHOWN_EVENT = 'toolbox://main-shown';

/**
 * 全局呼出行为（V61，用户口径）：
 *
 * - 主窗口唤出时，若正停留在**工具页 / 模块页**（上次没关）→ 保持原界面，
 *   Rust 侧已完成 show + set_focus，前端不做任何视图切换；
 * - 若停留在**命令面板 / 设置页** → 切回命令面板，把焦点落到搜索框并全选旧词，
 *   用户直接输入即可过滤工具（输入即替换）。
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
        listen(MAIN_SHOWN_EVENT, () => {
          const { view, setView } = useAppStore.getState();
          // 上次的工具/模块还开着 → 原样保留（工具输入由 usePersistedState 落盘）
          if (view.kind === 'command' || view.kind === 'module') {
            return;
          }
          setView({ kind: 'palette' });
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
