/**
 * 工作台「快捷入口」类型（与 Rust `commands/sys.rs` 的 serde camelCase 一一对应）。
 *
 * 安全约定：前端**只能传 `actionId`**，可执行目标与参数全部在 Rust 侧白名单表里，
 * 前端无法构造任意命令（详见 `src-tauri/src/commands/sys.rs` 模块注释）。
 */

/** 一个系统快捷动作 */
export interface SysAction {
  /** 动作 id（唯一可传给后端的参数） */
  id: string;
  /** 按钮标题 */
  name: string;
  /** 一句话说明 */
  description: string;
  /** 分组名（界面按组渲染） */
  group: string;
  /** 是否需要管理员权限（界面加「管理员」角标） */
  elevated: boolean;
}
