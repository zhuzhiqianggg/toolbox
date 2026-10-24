//! 托盘 / 菜单栏。
//!
//! Windows：系统托盘；macOS：菜单栏图标。两者共用本模块，交互差异按 `cfg` 处理。

use tauri::{
    async_runtime,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

use crate::commands;

const TRAY_ID: &str = "main-tray";

/// 创建托盘 / 菜单栏图标与菜单。
pub fn setup(app: &AppHandle) -> Result<(), String> {
    let open_item = MenuItemBuilder::with_id("open", "打开 Handy")
        .build(app)
        .map_err(|e| format!("创建托盘菜单项失败：{e}"))?;
    let settings_item = MenuItemBuilder::with_id("settings", "设置")
        .build(app)
        .map_err(|e| format!("创建托盘菜单项失败：{e}"))?;
    let autostart_item = MenuItemBuilder::with_id("autostart", "开机自启")
        .build(app)
        .map_err(|e| format!("创建托盘菜单项失败：{e}"))?;
    let overlay_item = MenuItemBuilder::with_id("toggle-overlay", "桌面整理：显示/隐藏")
        .build(app)
        .map_err(|e| format!("创建托盘菜单项失败：{e}"))?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出")
        .build(app)
        .map_err(|e| format!("创建托盘菜单项失败：{e}"))?;

    let menu = MenuBuilder::new(app)
        .items(&[&open_item, &settings_item, &autostart_item, &overlay_item])
        .separator()
        .items(&[&quit_item])
        .build()
        .map_err(|e| format!("创建托盘菜单失败：{e}"))?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Handy · 顺手")
        .menu(&menu)
        // 左键单击不弹菜单，交给下方事件处理（Windows：切换主面板）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                commands::grid::dispatch_panel_action(app, commands::grid::PANEL_ACTION_TOOLS);
            }
            "settings" => {
                // V63 落地（原 TODO(V13) 的「打开设置窗口」）：设置就在桌面面板里，
                // 不再另开一个窗口。
                commands::grid::dispatch_panel_action(app, commands::grid::PANEL_ACTION_SETTINGS);
            }
            "autostart" => {
                // TODO(V14)：调用 tauri-plugin-autostart 切换自启状态（读 settings 回显）
            }
            "toggle-overlay" => {
                // 桌面整理：显示/隐藏切换（V44.3）—— 隐藏后工具栏仍常驻，托盘是兜底入口。
                //
                // V79：这里**不再自己发** `grid:visibility`。以前只有这一条路会发，于是
                // 「桌面右键菜单 / 轮询线程自动重建」这些同样改 `overlay_visible` 的路径
                // 都只改库、不改界面（用户 09-25 实测「退出桌面整理，格子一直在」）。
                // 广播已下沉到 `commands::grid` 的 `show_overlay` / `show_launcher_only` /
                // `hide_overlay_now` —— 谁写真源谁广播，只此一处。
                let app2 = app.clone();
                async_runtime::spawn(async move {
                    if commands::grid::read_overlay_visible(&app2) {
                        let _ = commands::grid::grid_overlay_hide(app2).await;
                    } else {
                        let _ = commands::grid::grid_overlay_show(app2).await;
                    }
                });
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键抬起 → 切换主面板（Windows 习惯）
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                // V63：左键单击 = 开 / 关桌面右侧面板（原来是开 / 关主窗口）
                commands::grid::dispatch_panel_action(
                    app,
                    commands::grid::PANEL_ACTION_TOGGLE_TOOLS,
                );
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    // macOS 菜单栏：使用模板图标，随明暗主题自动反色
    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(true);
    }

    builder
        .build(app)
        .map_err(|e| format!("创建托盘图标失败：{e}"))?;
    Ok(())
}
