//! 备份导入导出（M7，V13）。
//!
//! 备份产物：`<用户选定目录>/handy-backup-YYYYMMDD-HHmmss/`，内含
//! `handy.db`（经 `VACUUM INTO` 生成的一致性快照，规避 SQLite 在线复制风险）与
//! `settings.json`（应用配置镜像，含模块开关 / 收藏 / 最近）。
//!
//! 导入策略（**不在线热替换**）：
//!   1. 校验源目录文件齐全（handy.db + settings.json）；
//!   2. 写入 pending 标记（`import-pending.json`）并返回「重启应用生效」；
//!   3. 下次启动在 `db::init` **之前**由 `apply_pending_import` 执行替换
//!      （覆盖 handy.db 并清除旧 WAL/SHM 残留、覆盖 settings.json、删除标记）。
//!
//! 安全边界：导出 / 导入的目标目录均由用户经系统 dialog 选择后传入；本模块的一切
//! 自动化测试只在 TEMP 沙箱内进行，**绝不**触碰真实用户目录。

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;
use tauri::AppHandle;

use crate::db;

/// 配置存储文件名（与 `commands/app.rs` 一致）。
const SETTINGS_STORE_FILE: &str = "settings.json";
/// 数据库文件名（与 `db::DB_FILE` 一致，显式声明便于独立测试）。
const DB_FILE: &str = "handy.db";
/// 导入待执行标记（app_config_dir 下）。
pub(crate) const IMPORT_MARKER: &str = "import-pending.json";

/// 导出结果摘要
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    /// 产物目录绝对路径
    pub backup_dir: String,
    /// 产物文件名列表
    pub files: Vec<String>,
}

/// 导入结果（V13 一律 pending，重启生效）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub pending_restart: bool,
    pub files: Vec<String>,
}

/// 标记文件内容（JSON）
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportMarker {
    source_dir: String,
}

/// 产物目录名（本地时间 `YYYYMMDD-HHmmss`）。
fn stamp_dir_name() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 核心导出：db 经 `VACUUM INTO` 快照 + settings.json 复制 → `<target_root>/<产物目录>/`。
/// 返回产物目录与文件名列表（不含 settings.json 时表示源缺失，仅告警不失败）。
pub(crate) fn export_backup(
    db_path: &Path,
    settings_path: &Path,
    target_root: &Path,
) -> Result<BackupReport, String> {
    if !db_path.exists() {
        return Err(format!("数据库文件不存在：{}", db_path.display()));
    }
    let backup_dir = target_root.join(format!("handy-backup-{}", stamp_dir_name()));
    std::fs::create_dir_all(&backup_dir)
        .map_err(|err| format!("创建备份目录失败（{}）：{err}", backup_dir.display()))?;

    // 1) db 快照：VACUUM INTO 生成紧凑、无 WAL 依赖的一致性副本。
    //    路径按 SQL 字面量转义单引号（' → ''）。
    let dest_db = backup_dir.join(DB_FILE);
    let sql = format!(
        "VACUUM INTO '{}'",
        dest_db.display().to_string().replace('\'', "''")
    );
    let conn = Connection::open(db_path).map_err(|err| format!("打开数据库失败：{err}"))?;
    conn.execute_batch(&sql)
        .map_err(|err| format!("生成数据库快照失败（VACUUM INTO）：{err}"))?;

    // 2) settings.json 复制（镜像配置）
    let mut files = vec![DB_FILE.to_string()];
    if settings_path.exists() {
        let dest_settings = backup_dir.join(SETTINGS_STORE_FILE);
        std::fs::copy(settings_path, &dest_settings)
            .map_err(|err| format!("复制配置文件失败：{err}"))?;
        files.push(SETTINGS_STORE_FILE.to_string());
    }

    Ok(BackupReport {
        backup_dir: backup_dir.display().to_string(),
        files,
    })
}

/// 核心导入计划：校验源目录齐全 → 写 pending 标记（替换动作延迟到下次启动）。
pub(crate) fn import_plan(source_dir: &Path, config_dir: &Path) -> Result<ImportOutcome, String> {
    let src_db = source_dir.join(DB_FILE);
    let src_settings = source_dir.join(SETTINGS_STORE_FILE);
    if !src_db.exists() {
        return Err(format!("备份缺少数据库文件：{}", src_db.display()));
    }
    if !src_settings.exists() {
        return Err(format!("备份缺少配置文件：{}", src_settings.display()));
    }
    let marker = ImportMarker {
        source_dir: source_dir.display().to_string(),
    };
    let json = serde_json::to_string(&marker).map_err(|err| format!("序列化标记失败：{err}"))?;
    std::fs::write(config_dir.join(IMPORT_MARKER), json)
        .map_err(|err| format!("写入导入标记失败：{err}"))?;
    Ok(ImportOutcome {
        pending_restart: true,
        files: vec![DB_FILE.to_string(), SETTINGS_STORE_FILE.to_string()],
    })
}

/// 启动时执行待导入备份（由 `lib.rs` setup 在 `db::init` **之前**调用）。
/// 返回是否执行了导入；源文件缺失 / 标记损坏时清除标记并返回错误（不阻塞启动）。
pub(crate) fn apply_pending_import(config_dir: &Path) -> Result<bool, String> {
    let marker_path = config_dir.join(IMPORT_MARKER);
    if !marker_path.exists() {
        return Ok(false);
    }
    let result = (|| -> Result<(), String> {
        let json = std::fs::read_to_string(&marker_path)
            .map_err(|err| format!("读取导入标记失败：{err}"))?;
        let marker: ImportMarker =
            serde_json::from_str(&json).map_err(|err| format!("导入标记损坏：{err}"))?;
        let source_dir = Path::new(&marker.source_dir);
        let src_db = source_dir.join(DB_FILE);
        let src_settings = source_dir.join(SETTINGS_STORE_FILE);
        if !src_db.exists() {
            return Err(format!("备份源缺失：{}", src_db.display()));
        }
        // 覆盖 db（先清掉旧 WAL/SHM 残留，避免旧连接日志与新库失配）
        std::fs::copy(&src_db, config_dir.join(DB_FILE))
            .map_err(|err| format!("恢复数据库失败：{err}"))?;
        for suffix in ["-wal", "-shm"] {
            let leftover = config_dir.join(format!("{DB_FILE}{suffix}"));
            if leftover.exists() {
                let _ = std::fs::remove_file(&leftover);
            }
        }
        if src_settings.exists() {
            std::fs::copy(&src_settings, config_dir.join(SETTINGS_STORE_FILE))
                .map_err(|err| format!("恢复配置失败：{err}"))?;
        }
        Ok(())
    })();
    // 无论成败都清标记：导入失败不应让每次启动都重试同一损坏备份
    let _ = std::fs::remove_file(&marker_path);
    result?;
    Ok(true)
}

/// `lib.rs` setup 用的包装（定位 app_config_dir）。
pub fn apply_pending_import_for_app(app: &AppHandle) -> Result<bool, String> {
    let db_path = db::db_path(app)?;
    let config_dir = db_path
        .parent()
        .ok_or_else(|| "无法定位应用配置目录".to_string())?;
    apply_pending_import(config_dir)
}

// —— Tauri 命令 ——

/// 导出备份（target_dir 由前端 dialog 让用户选择后传入）。
#[tauri::command]
pub async fn backup_export(app: AppHandle, target_dir: String) -> Result<BackupReport, String> {
    let db_path = db::db_path(&app)?;
    let config_dir = db_path
        .parent()
        .ok_or_else(|| "无法定位应用配置目录".to_string())?;
    export_backup(&db_path, &config_dir.join(SETTINGS_STORE_FILE), Path::new(&target_dir))
}

/// 导入备份：校验齐全后写 pending 标记，**重启应用生效**（前端提示用户）。
#[tauri::command]
pub async fn backup_import(app: AppHandle, source_dir: String) -> Result<ImportOutcome, String> {
    let db_path = db::db_path(&app)?;
    let config_dir = db_path
        .parent()
        .ok_or_else(|| "无法定位应用配置目录".to_string())?;
    import_plan(Path::new(&source_dir), config_dir)
}

// —— TEMP 沙箱测试（红线：绝不触碰真实用户目录）——

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::path::PathBuf;

    /// TEMP 沙箱（唯一目录；产物留 TEMP 供 QA 复查）
    fn sandbox(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("handy-backup-test-{}-{tag}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一个带 notes 表 + 一行数据的文件库
    fn make_db(path: &Path, marker: &str) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL);",
        )
        .unwrap();
        conn.execute("DELETE FROM notes", []).unwrap();
        conn.execute(
            "INSERT INTO notes (id, title) VALUES ('n1', ?1)",
            params![marker],
        )
        .unwrap();
    }

    fn read_marker_title(path: &Path) -> String {
        let conn = Connection::open(path).unwrap();
        conn.query_row("SELECT title FROM notes WHERE id = 'n1'", [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    #[test]
    fn export_import_roundtrip_in_sandbox() {
        let root = sandbox("roundtrip");
        let config_dir = root.join("config");
        let target_root = root.join("backups");
        std::fs::create_dir_all(&config_dir).unwrap();

        let db_path = config_dir.join(DB_FILE);
        let settings_path = config_dir.join(SETTINGS_STORE_FILE);
        make_db(&db_path, "before-backup");
        std::fs::write(&settings_path, r#"{"settings":{"theme":"light"}}"#).unwrap();

        // —— 导出 ——
        let report = export_backup(&db_path, &settings_path, &target_root).unwrap();
        assert_eq!(report.files.len(), 2);
        assert!(report.backup_dir.contains("handy-backup-"));
        let backup_dir = Path::new(&report.backup_dir);
        assert!(backup_dir.join(DB_FILE).exists());
        assert!(backup_dir.join(SETTINGS_STORE_FILE).exists());
        // 快照内容一致
        assert_eq!(read_marker_title(&backup_dir.join(DB_FILE)), "before-backup");

        // —— 原库继续变化 ——
        make_db(&db_path, "after-backup");
        assert_eq!(read_marker_title(&db_path), "after-backup");

        // —— 导入计划（pending 标记） ——
        let outcome = import_plan(backup_dir, &config_dir).unwrap();
        assert!(outcome.pending_restart);
        assert!(config_dir.join(IMPORT_MARKER).exists());

        // —— 启动时应用 pending 导入 ——
        let applied = apply_pending_import(&config_dir).unwrap();
        assert!(applied);
        assert!(!config_dir.join(IMPORT_MARKER).exists()); // 标记清除
        // 数据库回滚到备份时点
        assert_eq!(read_marker_title(&db_path), "before-backup");
        // settings.json 已恢复
        let restored = std::fs::read_to_string(config_dir.join(SETTINGS_STORE_FILE)).unwrap();
        assert!(restored.contains("light"));

        // —— 无标记时为 no-op ——
        assert!(!apply_pending_import(&config_dir).unwrap());
    }

    #[test]
    fn import_validates_missing_files() {
        let root = sandbox("validate");
        let config_dir = root.join("config");
        let backup_dir = root.join("backup");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&backup_dir).unwrap();

        // 缺 db → 报错
        std::fs::write(backup_dir.join(SETTINGS_STORE_FILE), "{}").unwrap();
        assert!(import_plan(&backup_dir, &config_dir).is_err());
        assert!(!config_dir.join(IMPORT_MARKER).exists());

        // 缺 settings → 报错
        std::fs::write(backup_dir.join(DB_FILE), b"sqlite").unwrap();
        std::fs::remove_file(backup_dir.join(SETTINGS_STORE_FILE)).unwrap();
        assert!(import_plan(&backup_dir, &config_dir).is_err());

        // 齐全 → 成功；标记损坏时启动应用会清标记并报错（不阻塞启动）
        std::fs::write(backup_dir.join(SETTINGS_STORE_FILE), "{}").unwrap();
        assert!(import_plan(&backup_dir, &config_dir).is_ok());
        std::fs::write(config_dir.join(IMPORT_MARKER), "not-json").unwrap();
        assert!(apply_pending_import(&config_dir).is_err());
        assert!(!config_dir.join(IMPORT_MARKER).exists()); // 损坏标记被清除
    }

    #[test]
    fn export_fails_when_db_missing() {
        let root = sandbox("missing");
        let target_root = root.join("backups");
        let err = export_backup(&root.join("nope.db"), &root.join("s.json"), &target_root);
        assert!(err.is_err());
    }
}
