/**
 * 软件安装（V84）。
 *
 * 目录与安装状态**全部来自 Rust 端**（`commands::apps`），前端不硬编码任何 winget id：
 * 白名单变更只需改 `src-tauri/src/commands/apps.rs` 的 `catalog()`。
 */
export interface AppPackage {
  /** 稳定短 id（安装 / 卸载都用它） */
  id: string;
  /** winget 包 id，展示用，方便用户手动搜 */
  wingetId: string;
  name: string;
  /** 开发 / 效率 / 系统 / 媒体 */
  group: string;
  description: string;
  /** 已安装版本；null = 未安装 */
  installed: string | null;
}
