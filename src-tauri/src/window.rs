//! 窗口管理辅助。
//!
//! 本批（V08）覆盖：主面板显隐/聚焦、close-to-tray、便签多实例窗（`note-{id}`）。
//! 设置窗（V13）/ 桌面整理预览窗（V12）后续扩展。

use tauri::utils::config::WindowEffectsConfig;
use tauri::window::Effect;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

/// 主窗口 label（与 tauri.conf.json 中 app.windows[0].label 一致）
pub const MAIN_LABEL: &str = "main";

/// 主窗口「被唤出显示」事件（前端 `useHotkeyOpen` 监听）。
///
/// 载荷恒为 `"resume"`（V65 用户口径）：**无论上次是怎么被藏起来的**，呼出都回到
/// 原页面 —— 工具状态（含密码库解锁态）跨呼出保留，只有用户在工具内按 `Esc`
/// 主动回到命令面板，下次呼出才停在面板。
pub const MAIN_SHOWN_EVENT: &str = "toolbox://main-shown";

/// 取得主窗口句柄。
fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN_LABEL)
        .ok_or_else(|| "未找到主窗口（main）".to_string())
}

/// 设置主窗口置顶状态。
///
/// 主窗口**默认不置顶**（`tauri.conf.json` 里 `alwaysOnTop: false`）：置顶会盖住
/// 系统弹框、浏览器、编辑器等窗口外的内容，只能先挪走 Toolbox 才能操作，很碍事。
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
    // V64：不再每次唤出强制居中 —— 窗口位置由用户拖到哪就停在哪（配合前端 windowShell
    // 的几何持久化），解决「每次呼出位置都不一样」的不一致感。首次启动仍由
    // tauri.conf `center: true` 居中；越界恢复（换屏 / 拔显示器）由前端启动装配 clamp。
    win.set_focus().map_err(|e| format!("聚焦主窗口失败：{e}"))?;
    // 广播「唤出显示」（隐藏路径不发）：V65 起语义恒为 resume（回原页面保持上下文）
    let _ = app.emit(MAIN_SHOWN_EVENT, "resume");
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
        eprintln!("[Toolbox] 未找到主窗口（{MAIN_LABEL}），跳过 close-to-tray 挂载");
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
                eprintln!("[Toolbox] 隐藏主窗口失败：{err}");
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
        Err(err) => eprintln!("[Toolbox] 读取便签几何失败，使用默认值：{err}"),
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html?window=note-{note_id}").into()),
    )
    .title("便签 · Toolbox")
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

// —— 工作台桌面停靠窗（V64）——

/// 工作台停靠窗 label。
pub const WORKSTATION_LABEL: &str = "workstation";

/// 停靠窗默认宽度（逻辑像素）：贴屏幕右缘、高度占满工作区时的「适合的宽度」。
const DOCK_DEFAULT_W: f64 = 360.0;
/// 停靠窗最小尺寸（逻辑像素），与前端紧凑布局的下限对齐。
const DOCK_MIN_W: f64 = 280.0;
const DOCK_MIN_H: f64 = 420.0;

/// 读取 `settings.json` → `settings` 对象（缺失时返回空对象）。
///
/// 与 `commands::app::load_settings` 同源（同一 `settings.json` / `settings` 键），
/// 这里只读：几何由前端 `patchSettings` 落盘，本模块只负责开窗时取回。
fn read_settings_map(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    let Ok(store) = app.store(super::commands::app::SETTINGS_STORE) else {
        return serde_json::Map::new();
    };
    match store.get(super::commands::app::SETTINGS_KEY) {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    }
}

/// 计算停靠窗默认几何：主显示器工作区**右缘 / 上下严丝合缝**（V65 用户要求，
/// 去 V64 的 8px 留白）：右缘贴边、顶到工作区顶、高度占满工作区（不盖任务栏）。
///
/// 拿不到显示器信息时退化为 `(0, 0, DOCK_DEFAULT_W, 600)` 兜底（开窗不因探测失败而中断）。
fn default_dock_geometry(app: &AppHandle) -> (f64, f64, f64, f64) {
    let monitor = app.primary_monitor().ok().flatten();
    let Some(monitor) = monitor else {
        return (0.0, 0.0, DOCK_DEFAULT_W, 600.0);
    };
    // work_area = 扣除任务栏后的可用区域（物理像素），换算为逻辑像素参与计算
    let work = monitor.work_area();
    let scale = if monitor.scale_factor() > 0.0 { monitor.scale_factor() } else { 1.0 };
    let x = work.position.x as f64 / scale;
    let y = work.position.y as f64 / scale;
    let w = work.size.width as f64 / scale;
    let h = work.size.height as f64 / scale;
    (x + w - DOCK_DEFAULT_W, y, DOCK_DEFAULT_W, h)
}

/// 创建（或显示已存在的）工作台停靠窗。
///
/// - **透明 + Acrylic 亚克力材质 + 无阴影**（V65：让窗口「长在桌面上」而非浮块）：
///   桌面壁纸透过磨砂底色若隐若现，随系统深浅色主题变化；
/// - 置顶 + 不进任务栏 + **不抢焦点**（`focused(false)`）：常驻「盯住」窗，
///   出现时不打断用户正在输入的任何窗口；
/// - 几何：`settings.workstationDockGeometry`（前端拖动 / 缩放后落盘）优先，
///   首次使用取主显示器右缘贴边、上下严丝合缝的默认值；
/// - 已存在同 label 窗口 → 仅显示（不重复聚焦，避免打断）。
pub fn create_or_show_workstation_dock(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(WORKSTATION_LABEL) {
        let _ = existing.show();
        return Ok(());
    }

    // 几何：settings 优先（逻辑像素），缺省用「右缘贴边、上下严丝合缝」默认值
    let stored = read_settings_map(app)
        .get("workstationDockGeometry")
        .cloned()
        .and_then(|v| serde_json::from_value::<(f64, f64, f64, f64)>(v).ok());
    let (x, y, w, h) = stored.unwrap_or_else(|| default_dock_geometry(app));

    WebviewWindowBuilder::new(
        app,
        WORKSTATION_LABEL,
        WebviewUrl::App("index.html?window=workstation".into()),
    )
    .title("工作台 · Toolbox")
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(true)
    .maximizable(false)
    .minimizable(false)
    .always_on_top(true)
    .focused(false)
    .skip_taskbar(true)
    .effects(WindowEffectsConfig {
        // Acrylic（Win10+）：磨砂透明底，桌面质感；不支持时系统回退为实色，不影响可用性
        effects: vec![Effect::Acrylic],
        state: None,
        radius: None,
        color: None,
    })
    .inner_size(w.max(DOCK_MIN_W), h.max(DOCK_MIN_H))
    .min_inner_size(DOCK_MIN_W, DOCK_MIN_H)
    .position(x, y)
    .build()
    .map_err(|err| format!("创建工作台停靠窗失败：{err}"))?;
    // 关闭钮 → 隐藏（窗口常驻，恢复零开销；不销毁也就无需重建几何）
    attach_workstation_dock_close_to_hide(app);
    Ok(())
}

/// 隐藏工作台停靠窗（窗口保留，恢复零开销；本就不存在时为幂等空操作）。
pub fn hide_workstation_dock(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(WORKSTATION_LABEL) {
        win.hide().map_err(|err| format!("隐藏工作台停靠窗失败：{err}"))?;
    }
    Ok(())
}

/// 挂载停靠窗「关闭 → 隐藏」行为（窗口常驻，几何随窗口保留）。
pub fn attach_workstation_dock_close_to_hide(app: &AppHandle) {
    let Some(win) = app.get_webview_window(WORKSTATION_LABEL) else {
        return;
    };
    let handle = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
        }
    });
}

// TODO(V12)：window_open("organizer") —— 桌面整理预览窗
// TODO(V13)：window_open("settings") —— 设置中心窗
