//! 应用级命令：平台信息、主窗口控制、模块启停、快捷键。

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde_json::{Map, Value};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::db;
use crate::platform::{self, PlatformInfo, PlatformOps};
use crate::window;

/// 配置存储文件名（与前端 `src/lib/store.ts` 保持一致）。
const SETTINGS_STORE: &str = "settings.json";
/// 设置对象在存储中的键（`settings.json` → `settings`）。
const SETTINGS_KEY: &str = "settings";

/// 返回当前平台信息与能力位（前端 `platform.ts` 数据来源）。
#[tauri::command]
pub async fn platform_info() -> Result<PlatformInfo, String> {
    Ok(platform::current().info())
}

/// 前端诊断日志直写通道（绕过插件 ACL；走 log 门面 → Toolbox.log）。
#[tauri::command]
pub async fn debug_log(message: String) {
    log::info!("[diag-rust] {message}");
}

/// 退出应用。
#[tauri::command]
pub async fn app_quit(app: AppHandle) {
    app.exit(0);
}

/// 显示并聚焦主面板。
#[tauri::command]
pub async fn app_show_main(app: AppHandle) -> Result<(), String> {
    window::show_main_palette(&app)
}

/// 隐藏主面板（常驻托盘，不退出）。
#[tauri::command]
pub async fn app_hide_main(app: AppHandle) -> Result<(), String> {
    window::hide_main_palette(&app)
}

/// 切换主面板显隐。
#[tauri::command]
pub async fn app_toggle_main(app: AppHandle) -> Result<(), String> {
    window::toggle_main_palette(&app)
}

/// 设置主窗口置顶（设置项「窗口置顶」的唯一执行点）。
///
/// 默认**不置顶**：置顶窗口会盖住系统弹框与其它程序（用户反馈的痛点）。
#[tauri::command]
pub async fn app_set_pinned(app: AppHandle, pinned: bool) -> Result<(), String> {
    window::set_main_pinned(&app, pinned)
}

/// 读取 `settings.json` → `settings` 对象（缺失时返回空对象）。
fn load_settings(app: &AppHandle) -> Map<String, Value> {
    let Ok(store) = app.store(SETTINGS_STORE) else {
        return Map::new();
    };
    match store.get(SETTINGS_KEY) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// 读取模块启停状态（V13：**module_state 表为准**，settings.modules 为镜像打底）。
///
/// 合并口径：先读 store 镜像（兼容旧数据 / 表尚未落行的模块），再以表内行覆盖；
/// 前端 `useAppStore.hydrate` 将结果合并到本地默认（缺省 = 启用）。
#[tauri::command]
pub async fn module_list_state(app: AppHandle) -> Result<HashMap<String, bool>, String> {
    let mut out = HashMap::new();

    // 1) store 镜像打底（旧版本数据兼容）
    let settings = load_settings(&app);
    if let Some(Value::Object(modules)) = settings.get("modules") {
        for (id, value) in modules {
            if let Some(enabled) = value.as_bool() {
                out.insert(id.clone(), enabled);
            }
        }
    }

    // 2) module_state 表为准覆盖
    let conn = connect_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT module_id, enabled FROM module_state")
        .map_err(|err| format!("读取模块状态失败：{err}"))?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|err| format!("读取模块状态失败：{err}"))?;
    for row in rows {
        let (id, enabled) = row.map_err(|err| format!("读取模块状态失败：{err}"))?;
        out.insert(id, enabled != 0);
    }
    Ok(out)
}

/// 写入单个模块的启停状态（V13：**双写**——module_state 表为准 + settings.modules 镜像）。
/// 表写入失败即整体失败（唯一事实源不落库比镜像缺失严重）；镜像失败仅告警。
#[tauri::command]
pub async fn module_set_enabled(app: AppHandle, module_id: String, enabled: bool) -> Result<(), String> {
    // 1) 表（唯一事实源）
    let conn = connect_db(&app)?;
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO module_state (module_id, enabled, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(module_id) DO UPDATE SET enabled = ?2, updated_at = ?3",
        params![module_id, enabled as i64, now],
    )
    .map_err(|err| format!("写入模块状态失败：{err}"))?;

    // 2) settings.json 镜像（跨版本兼容 / 备份可读；失败不阻断——表为准）
    if let Err(err) = write_store_mirror(&app, &module_id, enabled) {
        eprintln!("[Toolbox] 模块状态镜像写入失败（表已生效）：{err}");
    }
    Ok(())
}

/// 打开应用库短连接（module_state 读写用）。
fn connect_db(app: &AppHandle) -> Result<Connection, String> {
    let path = db::db_path(app)?;
    db::open(&path)
}

/// 写入 settings.modules 镜像（读改写，保留其它字段）。
fn write_store_mirror(app: &AppHandle, module_id: &str, enabled: bool) -> Result<(), String> {
    let store = app
        .store(SETTINGS_STORE)
        .map_err(|err| format!("打开配置失败：{err}"))?;

    let mut settings = match store.get(SETTINGS_KEY) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let mut modules = match settings.remove("modules") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    modules.insert(module_id.to_string(), Value::Bool(enabled));
    settings.insert("modules".to_string(), Value::Object(modules));

    store.set(SETTINGS_KEY, Value::Object(settings));
    store
        .save()
        .map_err(|err| format!("保存配置失败：{err}"))?;
    Ok(())
}

/// 更新全局快捷键（设置中心「保存」时调用）。
/// 注册成功后由前端持久化到 settings.json；注册失败（键位冲突）返回错误且**不落盘**。
#[tauri::command]
pub async fn hotkey_update(app: AppHandle, hotkey: String) -> Result<(), String> {
    crate::shortcut::update_hotkey(&app, &hotkey)
}

// TODO(V09+)：module_state 表双写已在 module_list_state / module_set_enabled 内完成；
// TODO(V14)：license_* 授权校验命令、app_backup_* 的定时自动备份随 V14 接入。
