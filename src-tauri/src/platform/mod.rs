//! 平台适配层：把 Windows / macOS 差异收敛到 `PlatformOps` trait 的 per-OS 实现。
//!
//! 业务代码（命令层）只依赖 trait，不出现运行时字符串判 OS。

use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

#[cfg(target_os = "windows")]
mod windows;

/// Windows 原生 Shell 右键菜单（V43）。macOS 走 Finder 的菜单，另行适配。
#[cfg(target_os = "windows")]
pub mod shell_menu;

/// 桌面背景右键菜单入口（V45，借鉴腾讯桌面整理）：HKCU 注册表，无需管理员权限。
pub mod desktop_menu;

/// 系统菜单期间把桌面「暂时还给系统」（V81）：旁听菜单弹出 / 收起，不改鼠标路由。
#[cfg(target_os = "windows")]
pub mod desktop_handoff;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
compile_error!("Handy · 顺手 目前仅支持 Windows 与 macOS 平台");

/// 平台能力清单（供前端做降级展示 / 授权引导）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    /// 是否可操作桌面「图标」（macOS = false）
    pub desktop_icons: bool,
    /// 是否可做文件归类
    pub desktop_file_organize: bool,
    /// 屏幕录制权限（M6 用，本期 false 占位）
    pub screen_recording: bool,
    /// 是否可读取系统信息
    pub system_info: bool,
    /// 常驻形态：Windows = "tray"，macOS = "menubar"
    pub tray: String,
}

/// 平台信息（经 `platform_info` 命令注入前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// "windows" | "macos" | "linux" | "unknown"
    pub os: String,
    /// "x86_64" | "aarch64" | ...
    pub arch: String,
    pub os_version: String,
    pub capabilities: PlatformCapabilities,
    /// 平台默认呼出快捷键文案
    pub hotkey_default: String,
}

/// 系统信息（设置页用，V13）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os_name: String,
    pub os_version: String,
    pub cpu_count: usize,
    pub total_memory_mb: u64,
}

/// 桌面条目（M2 桌面整理用，V12）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 桌面条目移动操作（V12）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOp {
    pub from: String,
    pub to: String,
}

/// 平台能力抽象。具体能力在对应 OS 实现；未实现的方法返回可读中文错误（降级而非 panic）。
pub trait PlatformOps: Send + Sync {
    /// 平台基础信息与能力位
    fn info(&self) -> PlatformInfo;
    /// 系统信息（CPU/内存/版本）
    fn system_info(&self) -> Result<SystemInfo, String>;
    /// 桌面条目枚举（M2：Win 可含图标，mac 仅文件）
    fn enumerate_desktop(&self) -> Result<Vec<DesktopEntry>, String>;
    /// 移动桌面条目到目标目录（M2 归类）
    fn move_desktop_entries(&self, moves: &[MoveOp]) -> Result<(), String>;
    /// 读取剪贴板文本（V10）。
    ///
    /// 经剪贴板管理插件实现（其内部封装各 OS 的剪贴板 API：Windows 剪贴板 /
    /// macOS NSPasteboard），`app` 用于取插件句柄；非文本内容或读取失败返回可读错误。
    fn read_clipboard(&self, app: &AppHandle) -> Result<String, String>;
    /// 写入剪贴板文本（V11 回贴）。
    ///
    /// 经剪贴板管理插件实现；写入失败（极少见）返回可读错误。
    fn write_clipboard(&self, text: &str, app: &AppHandle) -> Result<(), String>;
    /// 枚举目录直接子项（V12 桌面整理扫描）。
    ///
    /// 只做**原始枚举**（文件 / 文件夹 / `.lnk` 全部列出，含路径与类型）；
    /// 隐藏/系统属性、symlink、`.lnk` 等**安全过滤策略收敛在 organizer 层**，
    /// 本方法不做业务判断。读取失败返回可读错误。
    fn enumerate_desktop_items(&self, dir: &Path) -> Result<Vec<DesktopEntry>, String>;
    /// 移动文件 / 文件夹（V12 整理执行）。
    ///
    /// 仅执行 `fs::rename`（同盘原子语义；桌面 → 其子目录必为同盘，跨盘场景不在此
    /// 处理，失败上抛由调用方记录）。**冲突处理（改名 / 不覆盖）由调用方在移动前
    /// 解决**：dest 必须是调用方已确认不存在的路径。
    fn move_item(&self, src: &Path, dest: &Path) -> Result<(), String>;
}

/// 当前平台实现。
#[cfg(target_os = "windows")]
pub fn current() -> impl PlatformOps {
    windows::WindowsOps
}

/// 当前平台实现。
#[cfg(target_os = "macos")]
pub fn current() -> impl PlatformOps {
    macos::MacOsOps
}
