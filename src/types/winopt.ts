/**
 * Windows 优化工具类型（与 `src-tauri/src/commands/winopt.rs` 的 `WinOptItem` 对应）。
 */

/** 优化项状态：`applied` = 已按推荐优化；`default` = Windows 默认；`unknown` = 无法读取 */
export type WinOptStatus = 'applied' | 'default' | 'unknown';

export interface WinOptItem {
  id: string;
  name: string;
  description: string;
  /** 分组名（OneDrive / 隐私与广告 / 系统性能 / 游戏与后台） */
  group: string;
  /** 写入需要管理员授权（点击会弹 UAC） */
  elevated: boolean;
  /** 单向动作（如卸载 OneDrive）：渲染为按钮而非开关 */
  actionOnly: boolean;
  status: WinOptStatus;
  /** 应用/还原后的生效提示 */
  notice: string;
}

/** 切换目标状态：`applied` = 优化值；`default` = Windows 默认值 */
export type WinOptTarget = 'applied' | 'default';
