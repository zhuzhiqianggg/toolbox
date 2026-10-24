/**
 * 桌面整理类型（M2 / V12；V48 裁剪到只剩扫描）。
 *
 * 与 Rust `commands/organizer.rs` 的 serde camelCase 结构一一对应。
 * 独立成文件以避免 `lib/ipc.ts` ↔ `core/data/organizerService.ts` 相互依赖成环
 * （与本项目其它类型文件同模式）。
 *
 * V48 删除了计划 / 移动 / 撤销相关的类型（`OrganizerPlan` / `OrganizerPlanItem` /
 * `OrganizerFailedMove` / `OrganizerApplyReport` / `OrganizerUndoReport` /
 * `OrganizerRules`），因为桌面整理不再移动用户文件 —— 详情见
 * `src-tauri/src/commands/organizer.rs` 头部说明。
 */

/** 扫描条目 */
export interface OrganizerScanItem {
  name: string;
  path: string;
  isDir: boolean;
  isLnk: boolean;
  ext: string;
  size: number;
  mtime: number;
  category: string;
}

/** 扫描结果（只读） */
export interface OrganizerScanResult {
  dir: string;
  items: OrganizerScanItem[];
}
