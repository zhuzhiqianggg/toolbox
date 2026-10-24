//! SQLite 主数据层（ARCHITECTURE ADR-7）。
//!
//! 职责：
//!   - 解析数据库路径（`app_config_dir()/toolbox.db`，**必须**与 `tauri.conf.json` 中
//!     `plugins.sql.preload = ["sqlite:toolbox.db"]` 的解析基准一致，二者才能访问同一文件）；
//!   - 打开连接并设置 WAL / 外键约束（崩溃一致性、局部更新）；
//!   - 执行版本化迁移（见 [`migrations`]）。
//!
//! 边界：业务命令**不**在本模块拼 SQL；各模块的实体读写在 `commands/*` 中经连接封装进行。

pub mod migrations;

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

/// 数据库文件名。须与 `tauri.conf.json` → `plugins.sql.preload` 的 `sqlite:toolbox.db` 一致。
pub const DB_FILE: &str = "toolbox.db";

/// 解析数据库绝对路径（`app_config_dir()/toolbox.db`）。
///
/// 说明：`tauri-plugin-sql` 的 sqlite 连接以 `app_config_dir()` 为基准解析 `sqlite:<相对名>`，
/// 因此此处使用同一基准，避免出现「插件写 A 库、Rust 写 B 库」的分裂。
pub fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|err| format!("获取应用配置目录失败：{err}"))?;
    Ok(dir.join(DB_FILE))
}

/// 打开数据库连接（WAL 模式 + 外键约束）。
pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|err| format!("打开数据库失败：{err}"))?;
    // WAL：读写并发、崩溃一致性（ADR-7）。journal_mode 会返回一行结果，用 query_row 读取。
    let _mode: String = conn
        .query_row("PRAGMA journal_mode=WAL;", [], |row| row.get(0))
        .map_err(|err| format!("设置 WAL 模式失败：{err}"))?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")
        .map_err(|err| format!("启用外键约束失败：{err}"))?;
    Ok(conn)
}

/// 初始化数据库：创建目录、打开连接、执行迁移。返回数据库绝对路径。
pub fn init(app: &AppHandle) -> Result<PathBuf, String> {
    let path = db_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建数据目录失败：{err}"))?;
    }

    let conn = open(&path)?;
    migrations::run(&conn)?;

    Ok(path)
}
