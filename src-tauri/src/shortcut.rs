//! 全局快捷键。
//!
//! 默认：Windows / macOS `Alt+Q`（单手可按，不与系统窗口菜单 `Alt+Space`、
//! `Cmd+Space`/Spotlight 冲突）。注册失败不 panic，返回可读中文错误由命令层透传给前端。
//!
//! V61：默认键由 `Alt+Space` 改为 `Alt+Q`（用户拍板）；旧默认视为「未自定义」
//! 自动迁移，用户显式录制过的其他键不受影响。
//! V13：支持用户自定义快捷键（设置中心录制 → `hotkey_update` 命令重注册）。
//! 注册失败（键位被系统 / 其他应用占用）返回错误且**不落盘**（前端负责回滚显示）；
//! 应用侧始终保证有一个可用呼出键（新键失败自动回滚旧键 / 默认键）。

use std::sync::Mutex;

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};
use tauri_plugin_store::StoreExt;


/// 配置存储文件名 / 键（与 `commands/app.rs` 一致）。
const SETTINGS_STORE: &str = "settings.json";
const SETTINGS_KEY: &str = "settings";

/// 旧默认快捷键（V61 迁移：落盘值为它时按「未自定义」处理，迁移到新默认）。
const LEGACY_DEFAULT: &str = "Alt+Space";

/// 平台默认全局快捷键。
pub fn default_shortcut() -> Shortcut {
    // 两个平台的默认键在 modifiers 上都是 Alt（macOS 中 Alt = Option）
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        Shortcut::new(Some(Modifiers::ALT), Code::KeyQ)
    }
}

/// 当前已注册的全局快捷键（update_hotkey 注销 / 回滚用）。
static CURRENT: Mutex<Option<Shortcut>> = Mutex::new(None);

/// 快捷键触发回调（首次注册与重注册共用）。
///
/// 显示/聚焦由 `window::toggle_main_palette` 完成；「呼出后前端切视图/聚焦搜索框」
/// 由 `window::show_main_palette` emit 的 `toolbox://main-shown` 事件驱动 —— 仅在
/// 真正显示时才发，隐藏路径不发，避免「按快捷键想隐藏却切了视图」的错乱。
fn on_hotkey_pressed(app: &AppHandle, _shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() == ShortcutState::Pressed {
        // 全局快捷键呼出主窗口（Toolbox：普通窗口应用，无桌面面板概念）
        let _ = crate::window::toggle_main_palette(app);
    }
}

/// 注册一个快捷键并记录为当前键。
fn register(app: &AppHandle, shortcut: Shortcut) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, shortcut, event| {
            on_hotkey_pressed(app, shortcut, event);
        })
        .map_err(|e| format!("注册全局快捷键失败（可能与系统/其他应用冲突）：{e}"))?;
    *CURRENT
        .lock()
        .expect("快捷键状态锁不应中毒") = Some(shortcut);
    Ok(())
}

/// 注销当前注册的快捷键（未注册时为 no-op）。
fn unregister_current(app: &AppHandle) {
    let current = CURRENT
        .lock()
        .expect("快捷键状态锁不应中毒")
        .take();
    if let Some(shortcut) = current {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

/// 解析用户快捷键字符串（如 `Alt+Space`、`Ctrl+Shift+P`）。
fn parse_hotkey(hotkey: &str) -> Result<Shortcut, String> {
    hotkey
        .trim()
        .parse::<Shortcut>()
        .map_err(|_| format!("无法识别的快捷键组合：{hotkey}"))
}

/// 启动注册：优先 `settings.json` 已保存的 hotkey；解析 / 注册失败回退平台默认。
pub fn register_from_settings(app: &AppHandle) -> Result<(), String> {
    let saved = app
        .store(SETTINGS_STORE)
        .ok()
        .and_then(|store| store.get(SETTINGS_KEY))
        .and_then(|value| value.get("hotkey").and_then(|h| h.as_str()).map(String::from))
        // V61：旧默认 `Alt+Space` 视为「未自定义」，迁移到新默认 `Alt+Q`
        .filter(|hotkey| hotkey != LEGACY_DEFAULT);

    if let Some(hotkey) = saved {
        match parse_hotkey(&hotkey).and_then(|sc| register(app, sc)) {
            Ok(()) => return Ok(()),
            Err(err) => {
                eprintln!("[Toolbox] 已保存快捷键「{hotkey}」注册失败（{err}），回退默认键");
            }
        }
    }
    register(app, default_shortcut())
}

/// 更新全局快捷键（设置中心「保存」时调用）。
///
/// 流程：解析新键 → 注销当前键 → 注册新键；注册失败则回滚注册旧键（或默认键），
/// 保证应用始终有可用呼出键。**持久化由前端在成功后写入 settings.json**（失败不落盘）。
pub fn update_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let new_shortcut = parse_hotkey(hotkey)?;
    let old = CURRENT
        .lock()
        .expect("快捷键状态锁不应中毒")
        .clone();
    unregister_current(app);
    match register(app, new_shortcut) {
        Ok(()) => Ok(()),
        Err(err) => {
            // 回滚：恢复旧键（或默认键），不留下无呼出键的空窗
            let fallback = old.unwrap_or_else(default_shortcut);
            let _ = register(app, fallback);
            Err(err)
        }
    }
}
