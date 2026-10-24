//! 工作台顶部贴条（workstation bar）—— 常驻桌面顶部的「今日概览」一行条。
//!
//! # 形态与定位
//!
//! 无边框、透明、**始终置顶**、不占任务栏的细长窗口，锚定主显示器工作区**顶部居中**。
//! 打开即常驻，随时瞄一眼就知道「今天还有几件事、接下来做什么」。
//!
//! # 为什么不用 grid.rs 那套
//!
//! 「桌面网格挂件」是压在**最底层**、默认点击穿透的桌面层元素，Tauri 无
//! always-on-bottom API，才需要 `SetWindowPos(HWND_BOTTOM)` + 光标命中轮询那套兜底。
//! 贴条相反 —— 它就该浮在最上层，用 Tauri 原生 `always_on_top` 一个开关即可，
//! 因此本模块没有任何平台专属 hack，Windows / macOS 行为一致。
//!
//! 数据来源：贴条是独立 WebView，但它经 `tauri-plugin-sql` 直连同一个 `handy.db`，
//! 前端 `useTodosStore` 在贴条窗里同样可用 —— 不需要为「给贴条传数据」再造 IPC。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 贴条窗 label（与 capabilities `windows` / `main.tsx` 的 `?window=workstation-bar` 对应）。
pub const BAR_LABEL: &str = "workstation-bar";

/// 贴条加载 URL（窗口分派见 `src/main.tsx`）。
const BAR_URL: &str = "index.html?window=workstation-bar";

/// 贴条**折叠态**高度（逻辑像素）—— 单行概览，建窗默认值。
const BAR_COLLAPSED_HEIGHT: f64 = 44.0;
/// 贴条高度下限（逻辑像素）。
const BAR_MIN_HEIGHT: f64 = 44.0;
/// 贴条高度上限（逻辑像素；前端量不出合理值时用它兜底）。
const BAR_MAX_HEIGHT: f64 = 420.0;
/// 贴条宽度 = 工作区宽度 × 比例，并夹在上下限之间。
const BAR_WIDTH_RATIO: f64 = 0.62;
const BAR_MIN_WIDTH: f64 = 560.0;
const BAR_MAX_WIDTH: f64 = 980.0;
/// 距工作区顶部的间距（留出一点呼吸感，不贴死屏幕边缘）。
const BAR_TOP_GAP: f64 = 10.0;

/// 贴条几何：主显示器工作区顶部居中；读不到显示器时兜底 720×44 @ (280, 10)。
fn bar_geometry(app: &AppHandle) -> (f64, f64, f64, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        if scale > 0.0 {
            let area_x = f64::from(area.position.x) / scale;
            let area_y = f64::from(area.position.y) / scale;
            let area_w = f64::from(area.size.width) / scale;
            let area_h = f64::from(area.size.height) / scale;
            let width = (area_w * BAR_WIDTH_RATIO)
                .clamp(BAR_MIN_WIDTH, BAR_MAX_WIDTH)
                .min(area_w);
            return (
                area_x + (area_w - width) / 2.0,
                area_y + BAR_TOP_GAP,
                width,
                BAR_COLLAPSED_HEIGHT.min(area_h),
            );
        }
    }
    (280.0, BAR_TOP_GAP, 720.0, BAR_COLLAPSED_HEIGHT)
}

/// 显示（幂等）贴条窗：已存在则显示并重新置顶，不存在才创建。
pub fn show_bar(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(BAR_LABEL) {
        existing
            .show()
            .map_err(|err| format!("显示工作台贴条失败：{err}"))?;
        let _ = existing.set_always_on_top(true);
        return Ok(());
    }

    let (x, y, width, height) = bar_geometry(app);
    let win = WebviewWindowBuilder::new(app, BAR_LABEL, WebviewUrl::App(BAR_URL.into()))
        .title("工作台贴条 · Handy")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(true)
        .inner_size(width, height)
        .position(x, y)
        .build()
        .map_err(|err| format!("创建工作台贴条失败：{err}"))?;

    // 显式再置顶一次：部分平台在窗口创建时会忽略 builder 的置顶标志
    let _ = win.set_always_on_top(true);
    Ok(())
}

/// 显示工作台顶部贴条（幂等）。
#[tauri::command]
pub async fn bar_show(app: AppHandle) -> Result<(), String> {
    show_bar(&app)
}

/// 隐藏工作台顶部贴条（不销毁，再次 `bar_show` 复用同一窗口）。
#[tauri::command]
pub async fn bar_hide(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(BAR_LABEL) {
        win.hide()
            .map_err(|err| format!("隐藏工作台贴条失败：{err}"))?;
    }
    Ok(())
}

/// 贴条高度上限：不超过工作区高度的 60%（免得展开态贴条吃掉半个屏幕）。
fn bar_max_height(app: &AppHandle) -> f64 {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        if scale > 0.0 {
            let area_h = f64::from(monitor.work_area().size.height) / scale;
            return BAR_MAX_HEIGHT.min(area_h * 0.6).max(BAR_MIN_HEIGHT);
        }
    }
    BAR_MAX_HEIGHT
}

/// 动态调整贴条高度（折叠 / 展开）：**锚点不变** —— 仍是工作区顶部居中，只改高度。
///
/// 贴条高度取决于内容：折叠 = 单行 44px，展开 = 今日待办有几行就多高。
/// 前端量出真实内容高度后回报本命令，Rust 侧只做区间钳制与重定位。
/// `resizable(false)` 只拦用户手动拖拽边框，不影响程序性 `set_size`。
#[tauri::command]
pub async fn bar_set_height(app: AppHandle, height: f64) -> Result<(), String> {
    // 窗口没开着就静默忽略：前端在隐藏后仍可能收到一次 ResizeObserver 回调
    let Some(win) = app.get_webview_window(BAR_LABEL) else {
        return Ok(());
    };
    if !height.is_finite() || height <= 0.0 {
        return Ok(());
    }
    let target = height.clamp(BAR_MIN_HEIGHT, bar_max_height(&app));
    let (x, y, width, _) = bar_geometry(&app);
    win.set_size(tauri::LogicalSize::new(width, target))
        .map_err(|err| format!("调整贴条高度失败：{err}"))?;
    // 高度变化后重新贴回顶部居中（否则 Windows 会以中心为锚点把窗口上下拉伸）
    win.set_position(tauri::LogicalPosition::new(x, y))
        .map_err(|err| format!("调整贴条位置失败：{err}"))?;
    Ok(())
}

/// 切换贴条置顶（V21）。
///
/// 贴条默认置顶（`always_on_top`），但一直压在所有窗口之上很碍事 ——
/// 用户要的是「想看时抬眼就能看到，不想看时别老挡着」。
/// 于是把置顶做成**可切换**：关掉后贴条退化成普通窗口，被其它窗口盖住、
/// 切回桌面时又露出来；开关状态存在 `settings.barOnTop`，
/// 由贴条自己在挂载时调用本命令纠正（`show_bar` 仍默认置顶）。
#[tauri::command]
pub async fn bar_set_pinned(app: AppHandle, pinned: bool) -> Result<(), String> {
    let Some(win) = app.get_webview_window(BAR_LABEL) else {
        return Ok(()); // 窗口没开着：只落设置，下次开窗由前端应用
    };
    win.set_always_on_top(pinned)
        .map_err(|err| format!("切换贴条置顶失败：{err}"))
}

/// 从贴条唤出「工作台」。
///
/// V63：**不再是主窗口**。贴条自己改不了挂件窗的 store，所以走「派发面板动作 +
/// 挂件窗取走执行」（见 `commands/grid.rs` 的 [`dispatch_panel_action`]），与
/// `bar_open_command` 同一条路。
#[tauri::command]
pub async fn bar_open_workstation(app: AppHandle) -> Result<(), String> {
    crate::commands::grid::dispatch_panel_action(
        &app,
        &format!("{}module:notes", crate::commands::grid::PANEL_OPEN_PREFIX),
    );
    Ok(())
}

/// 从贴条搜索框直接打开指定工具（V28，用户反馈）。
///
/// V63：**在桌面右侧面板里就地打开**，不再唤主窗口（用户：「工具线弹出框就够了吧」）。
/// 工具 id 来自贴条前端的 `registry.commandsOf('toolbox')`；面板里找不到对应项时由
/// 前端 `openTarget` 兜底（提示未找到）。
#[tauri::command]
pub async fn bar_open_command(app: AppHandle, command_id: String) -> Result<(), String> {
    let id = command_id.trim().to_string();
    if id.is_empty() {
        return Err("工具 id 不能为空".to_string());
    }
    crate::commands::grid::dispatch_panel_action(
        &app,
        &format!("{}{}", crate::commands::grid::PANEL_OPEN_PREFIX, id),
    );
    Ok(())
}
