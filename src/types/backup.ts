/**
 * 备份产物类型（M7 / V13）。
 *
 * 与 Rust `commands/backup.rs` 的 serde camelCase 结构对应。
 * 独立成文件以避免 `lib/ipc.ts` ↔ `lib/backup.ts` 相互依赖成环。
 */

/** 导出结果摘要 */
export interface BackupReport {
  /** 产物目录绝对路径（`<用户选定目录>/handy-backup-YYYYMMDD-HHmmss`） */
  backupDir: string;
  /** 产物文件名列表 */
  files: string[];
}

/** 导入结果（V13 一律 pending，重启应用生效） */
export interface ImportOutcome {
  pendingRestart: boolean;
  files: string[];
}
