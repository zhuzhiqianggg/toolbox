import { ipc } from '@/lib/ipc';
import type { OrganizerScanResult } from '@/types/organizer';

/**
 * 桌面整理数据服务。
 *
 * V48 起**只剩扫描**：桌面整理不移动任何文件，所以计划生成 / 移动执行 / 撤销
 * 这三个能力连同它们的 IPC 一起删除了（Rust 侧 `organizer_preview_plan` /
 * `organizer_apply` / `organizer_undo` / `organizer_list_plans` 也已移除，
 * 见 `src-tauri/src/commands/organizer.rs` 头部说明）。
 *
 * 界面上还需要 `scanDesktop` 的两件事：显示真实「作用目录」，以及「扫描到 N 个条目」
 * 那个徽章 —— 让用户能自己核对「它读的是哪个目录、里面有什么」。
 *
 * 安全边界：`dir` 参数缺省 = 用户真实桌面；自动化测试只允许传 TEMP 沙箱目录。
 * 本服务**没有任何写文件系统的方法**。
 */

/** 扫描目录条目（只读；dir 缺省 = 用户真实桌面） */
export function scanDesktop(dir?: string): Promise<OrganizerScanResult> {
  return ipc.organizerScanDesktop(dir);
}
