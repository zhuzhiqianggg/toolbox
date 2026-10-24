import { useAppStore } from '@/stores/useAppStore';
import type { CommandProps } from '@/core/types';

/**
 * 主面板内导航（统一的视图切换入口）。
 *
 * 「最近使用」在命令视图挂载时集中记录（见 `CommandView`），因此本模块只负责切换视图。
 */

/** 打开命令（可携带初始输入与来源，如来自剪贴板建议）。 */
export function openCommand(
  commandId: string,
  opts?: { input?: string; source?: CommandProps['source'] },
): void {
  useAppStore.getState().setView({
    kind: 'command',
    commandId,
    ...(opts?.input !== undefined ? { input: opts.input } : {}),
    ...(opts?.source !== undefined ? { source: opts.source } : {}),
  });
}

/** 打开模块面板内页。 */
export function openModule(moduleId: string): void {
  useAppStore.getState().setView({ kind: 'module', moduleId });
}

/** 打开设置中心。 */
export function openSettings(): void {
  useAppStore.getState().setView({ kind: 'settings' });
}

/**
 * 通用导航（V45）：把「导航目标字符串」解析成对应视图。
 *
 * 支持三种 target，与 Rust `desktop_open_view` 的载荷、主窗口 `toolbox:navigate`
 * 的解析规则**完全一致**（三处语义必须同步，否则桌面点一下会开到别的地方）：
 *   - `module:<id>` → 模块面板内页（如 `module:notes` = 工作台）；
 *   - `settings`    → 设置中心；
 *   - 其余          → 命令 id（如 `vault` = 密码存储器，现在是工具箱工具）。
 *
 * 引入原因：V45 起 `vault` 从模块降级为工具箱命令，凡是「按 id 打开」的地方
 * （工作台快捷栏、桌面搜索、右侧面板）都得能同时表达模块与命令，不能再各自
 * 硬编码 `openModule()`。
 */
export function openTarget(target: string): void {
  const value = target.trim();
  if (value.startsWith('module:')) {
    openModule(value.slice('module:'.length));
  } else if (value === 'settings') {
    openSettings();
  } else if (value !== '') {
    openCommand(value);
  }
}

/** 返回命令面板（默认视图）。 */
export function backToPalette(): void {
  useAppStore.getState().showPalette();
}
