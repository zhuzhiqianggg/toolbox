import { useEffect } from 'react';
import { isTauri } from '@/platform/detect';
import { useAppStore } from '@/stores/useAppStore';

/** Rust `window::MAIN_SHOWN_EVENT`：主窗口被唤出显示（隐藏路径不发）。载荷 = 关闭来源 */
const MAIN_SHOWN_EVENT = 'toolbox://main-shown';

/**
 * 全局呼出行为（V65 用户口径：一律回到原页面保持上下文）。
 *
 * 无论上次是怎么被藏起来的（呼出键 / 主动关闭），呼出都**保持当前页面**：
 * 密码库解锁态、工具输入、滚动位置全部保留 —— 用户「切后台再切回来」就是无缝续用。
 * 只有用户在工具内按 `Esc` 主动回到命令面板，下次呼出才停在面板。
 * 停在命令面板时呼出 → 聚焦搜索框，直接输入即可过滤工具。
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
        listen<string>(MAIN_SHOWN_EVENT, () => {
          // 原页面原样保留（工具输入由 usePersistedState / 各 store 落盘）
          const { view } = useAppStore.getState();
          if (view.kind !== 'palette') {
            return;
          }
          // 停在命令面板时：等挂载完成后聚焦搜索框并全选旧查询（无查询时 select 为 no-op）
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
