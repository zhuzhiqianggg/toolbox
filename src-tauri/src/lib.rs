//! Toolbox —— Rust 原生层入口。
//!
//! 职责：装配 Tauri Builder（插件 / 命令 / 托盘 / 快捷键 / 单实例 / DB 初始化）。
//! 平台差异全部下沉到 `platform/` 适配层，业务代码不写运行时平台分支。
//!
//! 前身（toolbox）曾内置「桌面整理 / 格子挂件 / 顶部贴条」等接管桌面的能力，
//! Toolbox 已彻底移除：不再隐藏系统图标、不再往桌面挂窗口，回归普通窗口应用。

pub mod commands;
pub mod db;
pub mod logging;
pub mod platform;
pub mod shortcut;
pub mod tray;
pub mod window;

use tauri::{Emitter, Manager};

/// 处理命令行参数（冷启动与单实例回调共用）。
///
/// Toolbox 只保留 `--open-settings`（托盘/桌面快捷方式直达设置页）；
/// 返回 `true` 表示已被认领，调用方不必再弹主窗口。
pub fn handle_cli_args(app: &tauri::AppHandle, argv: &[String]) -> bool {
    let has = |flag: &str| argv.iter().any(|arg| arg == flag);

    if has("--open-settings") {
        println!("[Toolbox] 打开设置页");
        let _ = window::show_main_palette(app);
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.emit("autotool", "module:settings");
        }
        return true;
    }
    false
}

/// 装配应用。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 已有实例时：认领 CLI 参数（如设置直达）；都没认领则呼出主窗口
            if !handle_cli_args(app, &argv) {
                let _ = window::show_main_palette(app);
            }
        }))
        .invoke_handler(tauri::generate_handler![
            // —— 应用 / 窗口 / 平台 ——
            commands::app::platform_info,
            commands::app::app_quit,
            commands::app::app_show_main,
            commands::app::app_hide_main,
            commands::app::app_toggle_main,
            commands::app::app_set_pinned,
            commands::app::workstation_dock_show,
            commands::app::workstation_dock_hide,
            commands::app::module_list_state,
            commands::app::module_set_enabled,
            commands::app::hotkey_update,
            commands::app::debug_log,
            // —— 日志（前端错误上报 + 自助查看）——
            logging::log_frontend,
            logging::log_open_dir,
            logging::log_read_tail,
            logging::log_clear,
            logging::log_info,
            // —— 便签 ——
            commands::notes::notes_list,
            commands::notes::notes_create,
            commands::notes::notes_update,
            commands::notes::notes_delete,
            commands::notes::notes_set_geometry,
            commands::notes::open_note_window,
            // —— 待办 ——
            commands::todos::todos_list,
            commands::todos::todos_create,
            commands::todos::todos_update,
            commands::todos::todos_delete,
            commands::todos::todos_toggle_done,
            // —— 密码存储器 ——
            commands::vault::vault_setup,
            commands::vault::vault_status,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::vault::vault_list,
            commands::vault::vault_create,
            commands::vault::vault_update,
            commands::vault::vault_delete,
            // —— 工具：HTTP 接口测试 / 端口占用 ——
            commands::http::http_request,
            commands::misc::port_occupants,
            // —— 系统快捷动作（白名单制）——
            commands::sys::sys_action_list,
            commands::sys::sys_action_run,
            // —— Windows 优化（白名单制）——
            commands::winopt::winopt_list,
            commands::winopt::winopt_apply,
            commands::winopt::winopt_action,
            // —— 软件安装（白名单 + winget）——
            commands::apps::apps_list,
            commands::apps::apps_install,
            commands::apps::apps_uninstall,
            commands::apps::apps_install_custom,
            // —— 备份 / 恢复 ——
            commands::backup::backup_export,
            commands::backup::backup_import,
        ])
        .setup(|app| {
            // 日志会话分隔线（用户回传日志可分清是哪一次运行）
            logging::start_session(&app.package_info().version.to_string());
            // 待导入备份：必须在 db::init 之前应用
            match commands::backup::apply_pending_import_for_app(app.handle()) {
                Ok(true) => println!("[Toolbox] 已应用待导入备份"),
                Ok(false) => {}
                Err(err) => eprintln!("[Toolbox] 应用待导入备份失败（已清除标记）：{err}"),
            }
            // 托盘
            if let Err(err) = tray::setup(app.handle()) {
                eprintln!("[Toolbox] 托盘初始化失败：{err}");
            }
            // 全局快捷键（优先 settings.json 已保存键，失败回退平台默认）
            if let Err(err) = shortcut::register_from_settings(app.handle()) {
                eprintln!("[Toolbox] 快捷键注册失败：{err}");
            }
            // 主窗口关闭 → 隐藏到托盘（常驻，不退出应用）
            window::attach_close_to_tray(app.handle());
            // 工作台桌面停靠（V64）：默认开启（settings.workstationDock = false 关闭），
            // 贴主屏右缘、占满工作区高度；用户拖动 / 缩放后的几何由前端落盘、重启恢复。
            let dock_enabled = commands::app::load_settings(app.handle())
                .get("workstationDock")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            if dock_enabled {
                if let Err(err) = window::create_or_show_workstation_dock(app.handle()) {
                    eprintln!("[Toolbox] 工作台停靠窗创建失败：{err}");
                }
            }
            // SQLite 主数据层（WAL + 版本迁移）
            match db::init(app.handle()) {
                Ok(path) => println!("[Toolbox] 数据库就绪：{}", path.display()),
                Err(err) => eprintln!("[Toolbox] 数据库初始化失败：{err}"),
            }
            // 桌面图标自愈：前身版本曾隐藏系统桌面图标，若残留旧状态则无条件恢复
            #[cfg(target_os = "windows")]
            platform::desktop_icons::restore_desktop_icons();
            // 冷启动 CLI（--open-settings）
            let argv: Vec<String> = std::env::args().collect();
            handle_cli_args(app.handle(), &argv);
            // 启动弹主窗口（普通窗口应用的标准行为）
            let _ = window::show_main_palette(app.handle());
            // 无头测试通道：TOOLBOX_AUTOTOOL=<commandId> 或 module:<moduleId>，
            // 延迟 4s 后发给主窗口，用于自动化诊断/回归，无此变量时零开销。
            if let Ok(target) = std::env::var("TOOLBOX_AUTOTOOL") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if let Some(win) = handle.get_webview_window("main") {
                        let _ = win.emit("autotool", target);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Toolbox 失败")
        .run(|_app, _event| {});
}
