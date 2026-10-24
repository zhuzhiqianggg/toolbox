//! 系统托盘。
//!
//! Toolbox：托盘只做「打开 / 设置 / 退出」三件事；左键单击切换主窗口显隐。
//! （前身的「显示/隐藏整理层」等桌面接管菜单项已随该机制一并移除。）

use tauri::{
    menu::{MenuBuilder, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

use crate::window;

/// 创建托盘（应用启动时调用一次）。
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "打开 Toolbox", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = MenuBuilder::new(app).items(&[&open, &settings, &quit]).build()?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Toolbox")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                let _ = window::show_main_palette(app);
            }
            "settings" => {
                let _ = window::show_main_palette(app);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("autotool", "module:settings");
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = window::toggle_main_palette(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
