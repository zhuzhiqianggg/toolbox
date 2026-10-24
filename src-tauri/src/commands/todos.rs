//! 待办（M3）数据命令：CRUD + 完成态切换（V09）。
//!
//! 数据契约：`todos` 表（v1 建表 + `db/migrations.rs` v5 追加 `detail`）：
//!   - `title` 一句话标题（列表显示 / 提醒播报用），`detail` 为 Markdown 说明；
//!   - `due_at` 到期时间 / `remind_at` 提醒时间 / `reminded` 是否已提醒（前端调度器写）；
//!   - `note_id` 外键关联 `notes(id)`（ON DELETE SET NULL），支撑便签↔待办互转。
//!
//! 表结构变更一律走**追加迁移**（只增不改），不得就地改动历史迁移 SQL。
//!
//! 双路径说明（与便签 `commands/notes.rs` 一致）：
//!   - 前端日常读写走 `tauri-plugin-sql` 直连 SQLite（见 `src/core/data/todosService.ts`）；
//!   - 本模块提供 Rust 侧同义命令（单连接 rusqlite）作为统一写路径预留，二者读写同一文件。
//!
//! 提醒调度：**不在 Rust 侧做**。调度逻辑（60s 扫描 + 过期 >1h 不补发）在前端
//! `ReminderScheduler.tsx`，经 `tauri-plugin-notification` 发系统通知——通知权限、
//! 去重与静默策略都在一处，避免两端重复调度。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::db;

/// 待办实体（与 `todos` 表一一对应；serde camelCase 对齐前端 `Todo`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub title: String,
    /// Markdown 说明（可为空串）
    pub detail: String,
    pub done: bool,
    pub priority: i64,
    pub due_at: Option<i64>,
    pub remind_at: Option<i64>,
    pub reminded: bool,
    pub note_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `todos` 表行 → 实体。
fn row_to_todo(row: &Row) -> rusqlite::Result<Todo> {
    Ok(Todo {
        id: row.get("id")?,
        title: row.get("title")?,
        detail: row.get("detail")?,
        done: row.get::<_, i64>("done")? != 0,
        priority: row.get("priority")?,
        due_at: row.get("due_at")?,
        remind_at: row.get("remind_at")?,
        reminded: row.get::<_, i64>("reminded")? != 0,
        note_id: row.get("note_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 打开独立短连接（与 `notes.rs` 同策略；WAL 下读写并发安全）。
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

const TODO_COLUMNS: &str =
    "id, title, detail, done, priority, due_at, remind_at, reminded, note_id, created_at, updated_at";

/// 列表排序：未完成优先 → 优先级高优先 → 有到期时间优先、近者优先 → 最近更新优先。
const TODO_ORDER: &str = "ORDER BY done ASC, priority DESC, \
     CASE WHEN due_at IS NULL THEN 1 ELSE 0 END ASC, due_at ASC, updated_at DESC";

/// 按 id 读取待办（不存在返回 `Ok(None)`）。
pub fn load_todo(app: &AppHandle, todo_id: &str) -> Result<Option<Todo>, String> {
    let conn = connect(&app)?;
    let mut stmt = conn
        .prepare(&format!("SELECT {TODO_COLUMNS} FROM todos WHERE id = ?1"))
        .map_err(|err| format!("查询待办失败：{err}"))?;
    match stmt.query_row(params![todo_id], row_to_todo) {
        Ok(todo) => Ok(Some(todo)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(format!("查询待办失败：{err}")),
    }
}

/// 全量待办列表。
#[tauri::command]
pub async fn todos_list(app: AppHandle) -> Result<Vec<Todo>, String> {
    let conn = connect(&app)?;
    let mut stmt = conn
        .prepare(&format!("SELECT {TODO_COLUMNS} FROM todos {TODO_ORDER}"))
        .map_err(|err| format!("查询待办列表失败：{err}"))?;
    let todos = stmt
        .query_map([], row_to_todo)
        .map_err(|err| format!("查询待办列表失败：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取待办列表失败：{err}"))?;
    Ok(todos)
}

/// 新建入参（全部可选；缺省值见 [`todos_create`]）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TodoCreateInput {
    pub id: Option<String>,
    pub title: Option<String>,
    pub detail: Option<String>,
    pub priority: Option<i64>,
    pub due_at: Option<i64>,
    pub remind_at: Option<i64>,
    pub note_id: Option<String>,
}

/// 新建待办，返回落库后的完整实体。
///
/// 缺省：标题空、`priority = 1`（普通）、无到期/提醒、未关联便签。
#[tauri::command]
pub async fn todos_create(app: AppHandle, input: Option<TodoCreateInput>) -> Result<Todo, String> {
    let input = input.unwrap_or_default();
    let id = input
        .id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = now_ms();

    let todo = Todo {
        id: id.clone(),
        title: input.title.unwrap_or_default(),
        detail: input.detail.unwrap_or_default(),
        done: false,
        priority: input.priority.unwrap_or(1),
        due_at: input.due_at,
        remind_at: input.remind_at,
        reminded: false,
        note_id: input.note_id,
        created_at: now,
        updated_at: now,
    };

    let conn = connect(&app)?;
    conn.execute(
        "INSERT INTO todos (id, title, detail, done, priority, due_at, remind_at, reminded, note_id, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            todo.id,
            todo.title,
            todo.detail,
            todo.done as i64,
            todo.priority,
            todo.due_at,
            todo.remind_at,
            todo.reminded as i64,
            todo.note_id,
            todo.created_at,
            todo.updated_at,
        ],
    )
    .map_err(|err| format!("创建待办失败：{err}"))?;
    Ok(todo)
}

/// 增量更新补丁（仅 `Some` 字段会被写入；全部缺省时为空操作）。
///
/// 注意：`due_at` / `remind_at` 为 `Option<i64>`，本命令不支持「清空为 NULL」
/// （如需清空请写 NULL 语句，前端 `todosService` 直连路径已支持）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TodoPatch {
    pub title: Option<String>,
    pub detail: Option<String>,
    pub done: Option<bool>,
    pub priority: Option<i64>,
    pub due_at: Option<i64>,
    pub remind_at: Option<i64>,
    pub reminded: Option<bool>,
    pub note_id: Option<String>,
}

/// 增量更新待办（自动刷新 `updated_at`），返回更新后的完整实体。
#[tauri::command]
pub async fn todos_update(app: AppHandle, todo_id: String, patch: TodoPatch) -> Result<Todo, String> {
    let mut sets: Vec<&'static str> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(v) = &patch.title {
        sets.push("title = ?");
        values.push(Box::new(v.clone()));
    }
    if let Some(v) = &patch.detail {
        sets.push("detail = ?");
        values.push(Box::new(v.clone()));
    }
    if let Some(v) = patch.done {
        sets.push("done = ?");
        values.push(Box::new(i64::from(v)));
    }
    if let Some(v) = patch.priority {
        sets.push("priority = ?");
        values.push(Box::new(v));
    }
    if let Some(v) = patch.due_at {
        sets.push("due_at = ?");
        values.push(Box::new(v));
    }
    if let Some(v) = patch.remind_at {
        sets.push("remind_at = ?");
        values.push(Box::new(v));
    }
    if let Some(v) = patch.reminded {
        sets.push("reminded = ?");
        values.push(Box::new(i64::from(v)));
    }
    if let Some(v) = &patch.note_id {
        sets.push("note_id = ?");
        values.push(Box::new(v.clone()));
    }

    let conn = connect(&app)?;
    if !sets.is_empty() {
        let sql = format!("UPDATE todos SET {}, updated_at = ? WHERE id = ?", sets.join(", "));
        let now = now_ms();
        let mut bind: Vec<&dyn rusqlite::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        bind.push(&now);
        bind.push(&todo_id);
        let affected = conn
            .execute(sql.as_str(), bind.as_slice())
            .map_err(|err| format!("更新待办失败：{err}"))?;
        if affected == 0 {
            return Err("待办不存在或已被删除".to_string());
        }
    }

    load_todo(&app, &todo_id)?.ok_or_else(|| "待办不存在或已被删除".to_string())
}

/// 删除待办（不级联动关联便签；`note_id` 仅是弱关联）。
#[tauri::command]
pub async fn todos_delete(app: AppHandle, todo_id: String) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute("DELETE FROM todos WHERE id = ?1", params![todo_id])
        .map_err(|err| format!("删除待办失败：{err}"))?;
    if affected == 0 {
        return Err("待办不存在或已被删除".to_string());
    }
    Ok(())
}

/// 切换完成态（`done`），完成时顺带置 `reminded = 1`（已完成的待办不再提醒）。
#[tauri::command]
pub async fn todos_toggle_done(app: AppHandle, todo_id: String, done: bool) -> Result<Todo, String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute(
            "UPDATE todos SET done = ?1, reminded = ?2, updated_at = ?3 WHERE id = ?4",
            params![i64::from(done), i64::from(done), now_ms(), todo_id],
        )
        .map_err(|err| format!("更新待办状态失败：{err}"))?;
    if affected == 0 {
        return Err("待办不存在或已被删除".to_string());
    }
    load_todo(&app, &todo_id)?.ok_or_else(|| "待办不存在或已被删除".to_string())
}
