//! 窗口管理辅助。
//!
//! 本批（V08）覆盖：主面板显隐/聚焦、close-to-tray、便签多实例窗（`note-{id}`）。
//! 设置窗（V13）/ 桌面整理预览窗（V12）后续扩展。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 主窗口 label（与 tauri.conf.json 中 app.windows[0].label 一致）
pub const MAIN_LABEL: &str = "main";

/// 取得主窗口句柄。
fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN_LABEL)
        .ok_or_else(|| "未找到主窗口（main）".to_string())
}

/// 设置主窗口置顶状态。
///
/// 主窗口**默认不置顶**（`tauri.conf.json` 里 `alwaysOnTop: false`）：置顶会盖住
/// 系统弹框、浏览器、编辑器等窗口外的内容，只能先挪走 Handy 才能操作，很碍事。
/// 因此把置顶收敛成一个**用户自选**的设置项（`settings.mainPinned`）。
pub fn set_main_pinned(app: &AppHandle, pinned: bool) -> Result<(), String> {
    main_window(app)?
        .set_always_on_top(pinned)
        .map_err(|e| format!("设置主窗口置顶失败：{e}"))
}

/// 显示并聚焦主面板（命令面板形态）。
///
/// 主窗口若处于**最小化**态（历史遗留 `minimize()` 调用 / 系统级最小化），仅
/// `show()`（Windows ≈ `ShowWindow(SW_SHOW)`）**不会**把它还原为正常态，需先 `unminimize()`。
/// 见 V16 修复：托盘"唤不回"根因。
pub fn show_main_palette(app: &AppHandle) -> Result<(), String> {
    let win = main_window(app)?;
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
    }
    win.show().map_err(|e| format!("显示主窗口失败：{e}"))?;
    // V50：每次唤出都在所在屏幕内居中，保证上/下/左/右边距相等。
    // tauri.conf `center:true` 只在窗口首次创建时居中；此后 show/hide 会记住
    // 上次位置，用户可能挪动过或贴在不同屏边，导致再开时偏斜。
    // `center()` 以**当前窗口所在显示器**为基准居中，逻辑像素与 DPI 缩放都正确。
    win.center().map_err(|e| format!("主窗口居中失败：{e}"))?;
    win.set_focus().map_err(|e| format!("聚焦主窗口失败：{e}"))?;
    Ok(())
}

/// 隐藏主面板（不退出应用，常驻托盘）。
pub fn hide_main_palette(app: &AppHandle) -> Result<(), String> {
    let win = main_window(app)?;
    win.hide().map_err(|e| format!("隐藏主窗口失败：{e}"))
}

/// 切换主面板显隐（托盘左键 / 全局快捷键）。
///
/// 三态机（V16 修复）：**最小化 → 还原并聚焦；可见 → 隐藏到托盘；隐藏 → 显示并聚焦**。
/// 之所以单列「最小化」态：Windows 下最小化窗口仍保留 `WS_VISIBLE`，旧实现仅凭
/// `is_visible()` 二分判定会把最小化窗口当作"可见"而误执行 `hide()`，
/// 导致点托盘反而更唤不回（V16 修复前根因）。
pub fn toggle_main_palette(app: &AppHandle) -> Result<(), String> {
    let win = main_window(app)?;
    // 1) 最小化 → 还原并聚焦
    if win.is_minimized().unwrap_or(false) {
        let _ = win.unminimize();
        return win.set_focus().map_err(|e| format!("聚焦主窗口失败：{e}"));
    }
    // 2) 可见 → 隐藏；3) 隐藏 → 显示
    let visible = win
        .is_visible()
        .map_err(|e| format!("读取主窗口可见状态失败：{e}"))?;
    if visible {
        hide_main_palette(app)
    } else {
        show_main_palette(app)
    }
}

/// 为主窗口挂载「关闭 → 隐藏到托盘」行为（V02 交付项）。
///
/// 仅对主窗口（label = `main`）生效：用户点击系统关闭按钮、或用快捷键 `Alt+F4`、
/// 或前端调用 `close()` 时，**不退出应用**，而是 `prevent_close()` 阻止销毁并 `hide()`
/// 隐藏窗口，保持托盘常驻；真正退出由托盘菜单「退出」（`app.exit(0)`）负责。
///
/// 说明：便签（`note-*`）等其他窗口在 V08/V12/V13 创建时应各自决定关闭语义，**不复用**本函数。
pub fn attach_close_to_tray(app: &AppHandle) {
    let Some(win) = app.get_webview_window(MAIN_LABEL) else {
        eprintln!("[Handy] 未找到主窗口（{MAIN_LABEL}），跳过 close-to-tray 挂载");
        return;
    };
    // 事件回调需 `'static`：克隆一份窗口句柄移入闭包，用于在回调内隐藏窗口。
    let handle = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // 阻止默认关闭（默认会销毁窗口并可能触发应用退出）。
            api.prevent_close();
            // 隐藏到托盘，应用保持常驻（不退出）。
            if let Err(err) = handle.hide() {
                eprintln!("[Handy] 隐藏主窗口失败：{err}");
            }
        }
    });
}

// —— 便签多实例窗（V08）——

/// 便签默认尺寸（与 `schema.sql` 中 notes 表默认值一致）。
const NOTE_DEFAULT_W: f64 = 280.0;
const NOTE_DEFAULT_H: f64 = 240.0;

/// 便签窗口 label（`note-<id>`）。
pub fn note_label(note_id: &str) -> String {
    format!("note-{note_id}")
}

/// 创建（或聚焦已存在的）便签窗口。
///
/// - 无边框（`decorations(false)`），拖拽由前端 `data-tauri-drag-region` 承担；
/// - 初始几何取自 `notes` 表（读取失败时用默认值兜底，不阻断开窗）；
/// - `pinned = 1` 时置顶（`always_on_top(true)`）；
/// - 已存在同 label 窗口 → 显示并聚焦（幂等，重复「打开」不会开多个窗）。
pub fn create_note_window(app: &AppHandle, note_id: &str) -> Result<WebviewWindow, String> {
    let label = note_label(note_id);

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(existing);
    }

    // 几何：DB 优先（坐标/尺寸为逻辑像素），缺省兜底
    let (mut x, mut y, mut w, mut h, mut pinned) =
        (96.0_f64, 96.0_f64, NOTE_DEFAULT_W, NOTE_DEFAULT_H, false);
    match crate::commands::notes::load_note(app, note_id) {
        Ok(Some(note)) => {
            x = note.x as f64;
            y = note.y as f64;
            w = note.w as f64;
            h = note.h as f64;
            pinned = note.pinned;
        }
        Ok(None) => return Err(format!("便签不存在或已被删除（{note_id}）")),
        Err(err) => eprintln!("[Handy] 读取便签几何失败，使用默认值：{err}"),
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html?window=note-{note_id}").into()),
    )
    .title("便签 · Handy")
    .decorations(false)
    .resizable(true)
    .minimizable(false)
    .maximizable(false)
    .inner_size(w.max(160.0), h.max(120.0))
    .position(x, y);

    if pinned {
        builder = builder.always_on_top(true);
    }

    builder
        .build()
        .map_err(|err| format!("创建便签窗口失败：{err}"))
}

/// 关闭并销毁便签窗口（便签关闭即销毁，不驻留托盘；内容已由前端即时落库）。
/// 窗口本就不存在时为幂等空操作。
pub fn close_note_window(app: &AppHandle, note_id: &str) -> Result<(), String> {
    let label = note_label(note_id);
    if let Some(win) = app.get_webview_window(&label) {
        win.close()
            .map_err(|err| format!("关闭便签窗口失败：{err}"))?;
    }
    Ok(())
}

// TODO(V12)：window_open("organizer") —— 桌面整理预览窗
// TODO(V13)：window_open("settings") —— 设置中心窗
