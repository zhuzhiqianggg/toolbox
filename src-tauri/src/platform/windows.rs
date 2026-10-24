//! Windows 平台实现。

use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::{DesktopEntry, MoveOp, PlatformCapabilities, PlatformInfo, PlatformOps, SystemInfo};

/// Windows 平台能力实现（占位骨架，具体能力随任务补齐）。
pub struct WindowsOps;

impl PlatformOps for WindowsOps {
    fn info(&self) -> PlatformInfo {
        PlatformInfo {
            os: "windows".to_string(),
            arch: std::env::consts::ARCH.to_string(),
            os_version: std::env::var("OS").unwrap_or_else(|_| "Windows".to_string()),
            capabilities: PlatformCapabilities {
                // 可枚举桌面图标（经 Shell API）
                desktop_icons: true,
                desktop_file_organize: true,
                // 屏幕录制无需系统级授权（M6 用）
                screen_recording: true,
                system_info: true,
                tray: "tray".to_string(),
            },
            hotkey_default: "Alt+Space".to_string(),
        }
    }

    fn system_info(&self) -> Result<SystemInfo, String> {
        // TODO(V13)：接入 sysinfo，填充 CPU/内存；系统版本走 Win32 API
        Err("系统信息能力将在设置中心任务（V13）中实现".to_string())
    }

    fn enumerate_desktop(&self) -> Result<Vec<DesktopEntry>, String> {
        // TODO(V12)：读取桌面目录并枚举条目（可选 Shell API 获取图标位置）
        Err("桌面枚举将在桌面整理任务（V12）中实现".to_string())
    }

    fn move_desktop_entries(&self, _moves: &[MoveOp]) -> Result<(), String> {
        // TODO(V12)：按整理计划移动文件并记录到 organize_plans
        Err("桌面整理将在任务（V12）中实现".to_string())
    }

    fn read_clipboard(&self, app: &AppHandle) -> Result<String, String> {
        // V10：经剪贴板管理插件读取（内部封装 Win32 剪贴板 API）；非文本内容返回错误，
        // 前端 `useClipboardWatch` 捕获后跳过本轮，不落库。
        app.clipboard()
            .read_text()
            .map_err(|err| format!("读取剪贴板失败：{err}"))
    }

    fn write_clipboard(&self, text: &str, app: &AppHandle) -> Result<(), String> {
        // V11：回贴——把历史条目写回系统剪贴板（经剪贴板管理插件）。
        app.clipboard()
            .write_text(text)
            .map_err(|err| format!("写入剪贴板失败：{err}"))
    }

    fn enumerate_desktop_items(&self, dir: &Path) -> Result<Vec<DesktopEntry>, String> {
        // V12：原始枚举（std::fs），过滤策略在 organizer 层。
        let mut items = Vec::new();
        let entries = std::fs::read_dir(dir).map_err(|err| format!("读取目录失败：{err}"))?;
        for entry in entries {
            let entry = entry.map_err(|err| format!("读取目录条目失败：{err}"))?;
            let file_type = entry.file_type().map_err(|err| format!("读取类型失败：{err}"))?;
            items.push(DesktopEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().display().to_string(),
                is_dir: file_type.is_dir(),
            });
        }
        items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(items)
    }

    fn move_item(&self, src: &Path, dest: &Path) -> Result<(), String> {
        // V12：fs::rename（同盘原子）；调用方保证 dest 不存在（冲突已提前改名）。
        std::fs::rename(src, dest).map_err(|err| {
            format!(
                "移动失败（{} → {}）：{err}",
                src.display(),
                dest.display()
            )
        })
    }
}
