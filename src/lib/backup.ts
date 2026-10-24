import { isTauri } from '@/platform/detect';
import { ipc } from '@/lib/ipc';
import type { BackupReport, ImportOutcome } from '@/types/backup';

/**
 * 备份导入导出封装（M7，V13）。
 *
 * 目录选择走系统 dialog（`@tauri-apps/plugin-dialog`），由**用户亲自选定**目标 /
 * 来源目录——本模块绝不自动写入任何固定用户目录（安全红线）。
 * 数据组装在 Rust 侧（`commands/backup.rs`）：db 经 `VACUUM INTO` 快照 +
 * settings.json 复制；导入写 pending 标记、重启应用生效。
 *
 * 非桌面环境（浏览器 dev）：直接抛出可读错误，由 UI 兜底提示。
 */

/** 打开系统目录选择框；取消返回 null。 */
async function pickDirectory(title: string): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title });
  if (typeof picked === 'string' && picked.length > 0) {
    return picked;
  }
  return null;
}

/**
 * 导出备份：弹目录选择 → Rust 生成 `handy-backup-YYYYMMDD-HHmmss/` 产物。
 * @returns 产物目录；用户取消选择返回 null
 */
export async function exportBackup(): Promise<BackupReport | null> {
  if (!isTauri()) {
    throw new Error('备份功能需要 Handy 桌面环境');
  }
  const dir = await pickDirectory('选择备份保存位置');
  if (dir === null) {
    return null;
  }
  return ipc.backupExport(dir);
}

/**
 * 导入备份：弹目录选择 → Rust 校验齐全 + 写 pending 标记。
 * **不在线热替换**：返回 `pendingRestart: true`，由 UI 提示「重启应用生效」。
 * @returns 导入结果；用户取消选择返回 null
 */
export async function importBackup(): Promise<ImportOutcome | null> {
  if (!isTauri()) {
    throw new Error('备份功能需要 Handy 桌面环境');
  }
  const dir = await pickDirectory('选择备份目录');
  if (dir === null) {
    return null;
  }
  return ipc.backupImport(dir);
}
