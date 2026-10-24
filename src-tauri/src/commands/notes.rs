//! 便签（M3）数据命令：CRUD + 几何批量写 + 便签窗口开关（V08）。
//!
//! 数据契约：`db/schema.sql` 的 `notes` 表（**不可改表结构**）。
//!
//! 双路径说明（与前端 `src/core/data/notesService.ts` 的选择互为补充）：
//!   - 前端日常读写走 `tauri-plugin-sql` 直连 SQLite（单表简单实体，免 IPC 样板）；
//!   - 本模块提供 Rust 侧同义命令（单连接 rusqlite，事务语义更强），供后续统一写路径
//!     或无前端 SQL 能力的窗口迁移使用；二者读写**同一文件**（`db::db_path` 与
//!     sql 插件 preload 同源），语义一致。
//!
//! 窗口：`open_note_window` 委托 `window::create_note_window`（无边框、几何取自 DB、
//! pinned 置顶）。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::db;
use crate::window;

/// 便签实体（与 `notes` 表一一对应；serde camelCase 对齐前端 `Note`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub color: String,
    pub pinned: bool,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub opacity: f64,
    pub z: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `notes` 表行 → 实体。
fn row_to_note(row: &Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get("id")?,
        title: row.get("title")?,
        body: row.get("body")?,
        color: row.get("color")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        x: row.get("x")?,
        y: row.get("y")?,
        w: row.get("w")?,
        h: row.get("h")?,
        opacity: row.get("opacity")?,
        z: row.get("z")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 打开独立短连接（每次命令新建；WAL 模式下读写并发安全，与 sql 插件同文件）。
fn connect(app: &AppHandle) -> Result<Connection, String> {
    let path = db::db_path(app)?;
    db::open(&path)
}

/// 当前 Unix 毫秒时间戳。
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const NOTE_COLUMNS: &str =
    "id, title, body, color, pinned, x, y, w, h, opacity, z, created_at, updated_at";

/// 按 id 读取便签（不存在返回 `Ok(None)`；供 `window.rs` 开窗取几何复用）。
pub fn load_note(app: &AppHandle, note_id: &str) -> Result<Option<Note>, String> {
    let conn = connect(&app)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?1"
        ))
        .map_err(|err| format!("查询便签失败：{err}"))?;
    match stmt.query_row(params![note_id], row_to_note) {
        Ok(note) => Ok(Some(note)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(format!("查询便签失败：{err}")),
    }
}

/// 全量便签列表（置顶 → 层级 → 最近更新）。
#[tauri::command]
pub async fn notes_list(app: AppHandle) -> Result<Vec<Note>, String> {
    let conn = connect(&app)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {NOTE_COLUMNS} FROM notes ORDER BY pinned DESC, z DESC, updated_at DESC"
        ))
        .map_err(|err| format!("查询便签列表失败：{err}"))?;
    let notes = stmt
        .query_map([], row_to_note)
        .map_err(|err| format!("查询便签列表失败：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取便签列表失败：{err}"))?;
    Ok(notes)
}

/// 新建入参（全部可选；缺省值见 [`notes_create`]）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteCreateInput {
    pub id: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub color: Option<String>,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub w: Option<i64>,
    pub h: Option<i64>,
}

/// 新建便签，返回落库后的完整实体。
///
/// 缺省：标题/正文空、颜色 `yellow`、尺寸 280×240、位置按毫秒散列级联摆放
/// （避免多张新便签完全重叠）。
#[tauri::command]
pub async fn notes_create(app: AppHandle, input: Option<NoteCreateInput>) -> Result<Note, String> {
    let input = input.unwrap_or_default();
    let id = input
        .id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = now_ms();
    let def_x = 96 + (now % 5) * 32;
    let def_y = 96 + (now % 7) * 28;

    let note = Note {
        id: id.clone(),
        title: input.title.unwrap_or_default(),
        body: input.body.unwrap_or_default(),
        color: input.color.unwrap_or_else(|| "yellow".to_string()),
        pinned: false,
        x: input.x.unwrap_or(def_x),
        y: input.y.unwrap_or(def_y),
        w: input.w.unwrap_or(280),
        h: input.h.unwrap_or(240),
        opacity: 1.0,
        z: 0,
        created_at: now,
        updated_at: now,
    };

    let conn = connect(&app)?;
    conn.execute(
        "INSERT INTO notes (id, title, body, color, pinned, x, y, w, h, opacity, z, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            note.id,
            note.title,
            note.body,
            note.color,
            note.pinned as i64,
            note.x,
            note.y,
            note.w,
            note.h,
            note.opacity,
            note.z,
            note.created_at,
            note.updated_at,
        ],
    )
    .map_err(|err| format!("创建便签失败：{err}"))?;
    Ok(note)
}

/// 增量更新补丁（仅 `Some` 字段会被写入；全部缺省时为空操作）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotePatch {
    pub title: Option<String>,
    pub body: Option<String>,
    pub color: Option<String>,
    pub pinned: Option<bool>,
}

/// 增量更新便签（自动刷新 `updated_at`），返回更新后的完整实体。
#[tauri::command]
pub async fn notes_update(app: AppHandle, note_id: String, patch: NotePatch) -> Result<Note, String> {
    let mut sets: Vec<&'static str> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(v) = &patch.title {
        sets.push("title = ?");
        values.push(Box::new(v.clone()));
    }
    if let Some(v) = &patch.body {
        sets.push("body = ?");
        values.push(Box::new(v.clone()));
    }
    if let Some(v) = &patch.color {
        sets.push("color = ?");
        values.push(Box::new(v.clone()));
    }
    if let Some(v) = patch.pinned {
        sets.push("pinned = ?");
        values.push(Box::new(i64::from(v)));
    }

    let conn = connect(&app)?;
    if !sets.is_empty() {
        let sql = format!("UPDATE notes SET {}, updated_at = ? WHERE id = ?", sets.join(", "));
        let now = now_ms();
        let mut bind: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        bind.push(&now);
        bind.push(&note_id);
        let affected = conn
            .execute(sql.as_str(), bind.as_slice())
            .map_err(|err| format!("更新便签失败：{err}"))?;
        if affected == 0 {
            return Err("便签不存在或已被删除".to_string());
        }
    }

    load_note(&app, &note_id)?.ok_or_else(|| "便签不存在或已被删除".to_string())
}

/// 删除便签；若其窗口开着则一并关闭（窗口关闭为 best-effort，不影响删除结果）。
#[tauri::command]
pub async fn notes_delete(app: AppHandle, note_id: String) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute("DELETE FROM notes WHERE id = ?1", params![note_id])
        .map_err(|err| format!("删除便签失败：{err}"))?;
    if affected == 0 {
        return Err("便签不存在或已被删除".to_string());
    }
    let _ = window::close_note_window(&app, &note_id);
    Ok(())
}

/// 批量写几何（x,y,w,h,z,opacity）——供拖动/缩放**结束**时调用，避免拖动中高频写库。
///
/// 注意：几何写**不**刷新 `updated_at`（移动窗口不算内容更新，避免列表排序抖动）。
#[tauri::command]
pub async fn notes_set_geometry(
    app: AppHandle,
    note_id: String,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
    z: i64,
    opacity: f64,
) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute(
            "UPDATE notes SET x = ?1, y = ?2, w = ?3, h = ?4, z = ?5, opacity = ?6 WHERE id = ?7",
            params![x, y, w, h, z, opacity, note_id],
        )
        .map_err(|err| format!("写入便签位置失败：{err}"))?;
    if affected == 0 {
        return Err("便签不存在或已被删除".to_string());
    }
    Ok(())
}

/// 打开（或聚焦已存在的）便签窗口，返回窗口 label（`note-<id>`）。
#[tauri::command]
pub async fn open_note_window(app: AppHandle, note_id: String) -> Result<String, String> {
    window::create_note_window(&app, &note_id)?;
    Ok(window::note_label(&note_id))
}
