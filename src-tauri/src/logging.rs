//! 统一日志：客户端操作与应用错误都落盘，让「用户测出问题 → 回传日志 → 定位」
//! 这条链路真的走得通（V37 起）。
//!
//! - 落点 `%LOCALAPPDATA%\Toolbox\toolbox.log`（与 `grid-debug.log` 同一目录，用户好找）；
//! - 单份超过 [`MAX_BYTES`] 自动轮转，只保留最近 [`KEEP`] 份 —— 永不无限增长；
//! - 前端错误、IPC 失败、收纳/移动/删除等**写操作**都要在这里留痕：V36 那次
//!   「桌面文件被复制成 5 份」之所以只能靠事后翻磁盘才查清，就是因为关键写操作
//!   **一行日志都没留**。这条是硬性要求，不是可选项。

use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

/// 日志文件名。
pub const FILE_NAME: &str = "toolbox.log";
const LEGACY_FILE_NAME: &str = "grid-debug.log";
/// 单份日志大小上限（超过即轮转）。
const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 轮转后保留的份数（`toolbox.log.1` … `toolbox.log.N`）。
const KEEP: u32 = 3;

/// 日志目录（`%LOCALAPPDATA%\Toolbox`）。
pub fn log_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|base| base.join("Toolbox"))
}

/// 当前日志文件路径。
pub fn log_path() -> Option<PathBuf> {
    log_dir().map(|dir| dir.join(FILE_NAME))
}

/// 本地时间戳（与旧 `grid-debug.log` 的格式保持一致，便于和旧日志对照）。
pub fn timestamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 写一行日志。`category` 用短词：`app` / `grid` / `fs` / `ui` / `db` / `net`。
///
/// 一律不返回错误、不 panic —— 日志写不进去也绝不能影响主流程。
pub fn write_line(category: &str, message: &str) {
    // 单测里不落盘（V40）：`cargo test` 会跑到用户真实目录的 toolbox.log 里插进一堆
    // 测试行，而这条日志是**故障复盘的事实源** —— 掺进假的「整理布局 / 接管图标」记录，
    // 下次排查真问题时就会被误导。测试只关心返回值，不关心日志。
    if cfg!(test) {
        return;
    }
    let line = format!("[{}][{}] {}\n", timestamp(), category, message);
    if let Some(dir) = log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(FILE_NAME);
        rotate_if_needed(&path);
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = file.write_all(line.as_bytes());
        }
    }
    println!("[Toolbox][{category}] {message}");
}

/// 记录一次失败（带上下文），统一格式方便回传后一眼看出谁挂了。
pub fn write_error(category: &str, context: &str, detail: &str) {
    write_line(category, &format!("✖ {context}：{detail}"));
}

/// 会话分隔：每次启动画一条横线并写版本，回传的日志里能分清是哪一次运行。
pub fn start_session(version: &str) {
    write_line(
        "app",
        &format!("──────── 启动 Toolbox {version} ────────"),
    );
}

/// 超过上限就把 `toolbox.log` → `.1` → `.2` …，最老的一份丢掉。
fn rotate_if_needed(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() < MAX_BYTES {
        return;
    }
    let Some(dir) = path.parent() else {
        return;
    };
    let _ = std::fs::remove_file(dir.join(format!("{FILE_NAME}.{KEEP}")));
    for n in (1..KEEP).rev() {
        let from = dir.join(format!("{FILE_NAME}.{n}"));
        if from.exists() {
            let _ = std::fs::rename(&from, dir.join(format!("{FILE_NAME}.{}", n + 1)));
        }
    }
    let _ = std::fs::rename(path, dir.join(format!("{FILE_NAME}.1")));
}

// —— Tauri 命令（供前端上报错误与查看日志） ——

/// 前端错误上报入口。
///
/// 前端 `window.onerror` / `unhandledrejection` / React ErrorBoundary 都打到这里，
/// 于是「界面点了没反应」「弹了个看不懂的错」这类问题也能在日志里留下证据。
#[tauri::command]
pub async fn log_frontend(
    level: String,
    message: String,
    detail: Option<String>,
) -> Result<(), String> {
    let category = match level.as_str() {
        "error" => "ui:error",
        "warn" => "ui:warn",
        _ => "ui",
    };
    let mut text = message;
    if let Some(extra) = detail.filter(|value| !value.trim().is_empty()) {
        // 缩进两行，回传后一眼看出这是同一个错误堆栈的一部分
        text.push_str("\n    ↳ ");
        text.push_str(&extra.replace('\n', "\n    ↳ "));
    }
    write_line(category, &text);
    Ok(())
}

/// 在文件管理器里打开日志目录（找不到就建一个）。
#[tauri::command]
pub async fn log_open_dir() -> Result<String, String> {
    let dir = log_dir().ok_or_else(|| "无法定位日志目录".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建日志目录失败：{err}"))?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer")
            .arg(&dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| format!("打开日志目录失败：{err}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|err| format!("打开日志目录失败：{err}"))?;
    }
    Ok(dir.to_string_lossy().to_string())
}

/// 读日志尾部（默认最后 64 KB），供设置页直接展示，用户不必自己找文件。
#[tauri::command]
pub async fn log_read_tail(max_bytes: Option<usize>) -> Result<String, String> {
    let path = log_path().ok_or_else(|| "无法定位日志文件".to_string())?;
    if !path.exists() {
        return Ok(String::new());
    }
    let mut file =
        std::fs::File::open(&path).map_err(|err| format!("读取日志失败（{}）：{err}", path.display()))?;
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let cap = (max_bytes.unwrap_or(64 * 1024) as u64).min(len);
    if cap < len {
        // 从头跳过，只读尾部；跳到多字节字符中间也没关系，下面用 lossy 解码兜住
        let _ = file.seek(std::io::SeekFrom::Start(len - cap));
    }
    let mut buf = Vec::new();
    let _ = file.read_to_end(&mut buf);
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// 清空日志（用户手动回收空间用；清完立刻补一行说明，避免「日志怎么空了」）。
#[tauri::command]
pub async fn log_clear() -> Result<(), String> {
    if let Some(path) = log_path() {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|err| format!("清空日志失败：{err}"))?;
        }
    }
    write_line("app", "日志已清空");
    Ok(())
}

/// 诊断信息：日志文件位置与大小，设置页直接显示，用户回传时照着念就能定位。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogInfo {
    /// 日志目录
    pub dir: String,
    /// 当前日志文件
    pub path: String,
    /// 当前文件字节数
    pub size: u64,
    /// 历史轮转份数（不含当前）
    pub rotated: u32,
}

/// 读取日志文件概况。
#[tauri::command]
pub async fn log_info() -> Result<LogInfo, String> {
    let dir = log_dir().ok_or_else(|| "无法定位日志目录".to_string())?;
    let path = dir.join(FILE_NAME);
    let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let rotated = (1..=KEEP)
        .filter(|n| dir.join(format!("{FILE_NAME}.{n}")).exists())
        .count() as u32;
    Ok(LogInfo {
        dir: dir.to_string_lossy().to_string(),
        path: path.to_string_lossy().to_string(),
        size,
        rotated,
    })
}

/// 旧日志文件名（V36 及之前只写 `grid-debug.log`）。
///
/// 保留这个常量只为在日志里提示用户「老日志在哪」——V37 起所有内容都写 `toolbox.log`，
/// 设置页不再区分，避免用户找两份文件。
pub fn legacy_log_path() -> Option<PathBuf> {
    log_dir().map(|dir| dir.join(LEGACY_FILE_NAME))
}
