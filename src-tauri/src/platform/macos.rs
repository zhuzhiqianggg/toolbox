//! macOS 平台实现。
//!
//! 与 Windows 的关键差异：桌面图标由系统管控 → 仅支持「文件归类」；剪贴板/辅助功能需授权。

use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::{DesktopEntry, MoveOp, PlatformCapabilities, PlatformInfo, PlatformOps, SystemInfo};

/// macOS 平台能力实现（占位骨架，具体能力随任务补齐）。
pub struct MacOsOps;

impl PlatformOps for MacOsOps {
    fn info(&self) -> PlatformInfo {
        PlatformInfo {
            os: "macos".to_string(),
            arch: std::env::consts::ARCH.to_string(),
            os_version: std::env::var("OSTYPE").unwrap_or_else(|_| "macOS".to_string()),
            capabilities: PlatformCapabilities {
                // 桌面图标受系统管控，不开放
                desktop_icons: false,
                // 降级为「文件归类」
                desktop_file_organize: true,
                // 屏幕录制需系统授权（M6 用）
                screen_recording: false,
                system_info: true,
                tray: "menubar".to_string(),
            },
            hotkey_default: "Option+Space".to_string(),
        }
    }

    fn system_info(&self) -> Result<SystemInfo, String> {
        // TODO(V13)：sysctl / IOKit 读取
        Err("系统信息能力将在设置中心任务（V13）中实现".to_string())
    }

    fn enumerate_desktop(&self) -> Result<Vec<DesktopEntry>, String> {
        // TODO(V12)：仅枚举桌面文件（不含图标位置）；需「桌面」目录授权
        Err("桌面枚举将在桌面整理任务（V12）中实现（macOS 仅文件归类）".to_string())
    }

    fn move_desktop_entries(&self, _moves: &[MoveOp]) -> Result<(), String> {
        // TODO(V12)：文件归类移动，记录到 organize_plans
        Err("桌面整理将在任务（V12）中实现".to_string())
    }

    fn read_clipboard(&self, app: &AppHandle) -> Result<String, String> {
        // V10：经剪贴板管理插件读取（内部封装 NSPasteboard）；未授权 / 非文本内容
        // 返回错误，前端 `useClipboardWatch` 捕获后跳过本轮并引导授权。
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
        // V12：原始枚举（std::fs），过滤策略在 organizer 层。与 Windows 同实现。
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
