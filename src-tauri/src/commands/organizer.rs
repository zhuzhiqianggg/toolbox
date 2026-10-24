//! 桌面整理（M2）—— **V48 起只剩「扫描」**。
//!
//! # 这个模块不再移动任何文件
//!
//! 用户 09-19 原话：
//! > 「现在桌面整理模块有个垃圾就是什么归纳收拢，我们就是桌面整理，不负责直接 mv
//! >  文件到新的目录下，桌面整理就是单纯的桌面整理美化收纳，**打开桌面的目录文件夹后
//! >  布局没有任何变化的那种**」。
//!
//! V12–V47 期间本模块提供 scan / preview / apply / undo / list_plans 五件套，
//! 其中 `apply` 会真的 `fs::rename` 把桌面文件搬进 `桌面/Handy整理/<组名>/`。
//! 那是一个**归档工具**的语义，与「桌面整理 = 呈现与美化」根本冲突，也是「桌面整理
//! 会动我文件」这个误解的唯一来源。V48 把 preview / apply / undo / list_plans 连同
//! 计划表读写、`unique_dest`、`skip_reason`、`group_for` 一并删除 ——
//! **应用里不存在任何把用户文件搬出桌面的代码路径**。
//!
//! 现在保留的只有：
//!   - [`scan_items`]：只读枚举桌面直接子项（供 `grid_auto_arrange` 归类、
//!     以及 `organizer_scan_desktop` 在界面上显示「作用目录」与条目数）；
//!   - [`OrganizerItem`] / [`category_for`]：扩展名 → 类别名的映射，被桌面格子的
//!     自动归类复用（两处同一份，不会漂移）。
//!
//! 安全边界：
//!   - 本模块**不写文件系统**（无 create_dir / rename / remove）；
//!   - `dir` 参数**仅供测试与自定义目录**，None = 用户真实桌面；测试一律只读、
//!     且只允许在 TEMP 沙箱目录内进行。
//!
//! 平台差异收敛在 `platform` 层（`enumerate_desktop_items`），本模块与 OS 无关。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::platform::{self, PlatformOps};

/// by-type 六类扩展名映射表（写死常量，便于维护；扩展名小写、不带点）。
/// 顺序即匹配优先级；未命中 → 「其他」。文件夹不参与扩展名分类。
const EXT_CATEGORIES: &[(&str, &[&str])] = &[
    (
        "图片",
        &["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "ico", "tif", "tiff"],
    ),
    (
        "文档",
        &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "odt"],
    ),
    ("压缩包", &["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]),
    (
        "音视频",
        &["mp3", "wav", "flac", "aac", "ogg", "m4a", "mp4", "avi", "mkv", "mov", "wmv", "flv"],
    ),
    ("安装包", &["exe", "msi", "msix", "appx", "apk", "dmg", "pkg"]),
];
const CATEGORY_OTHER: &str = "其他";

// —— 实体结构（serde camelCase 对齐前端 `types/organizer.ts`）——

/// 扫描条目（`scan_items` 输出）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// `.lnk` 快捷方式（默认不整理，仅扫描展示）
    pub is_lnk: bool,
    /// 小写扩展名（无扩展名为空串）
    pub ext: String,
    /// 字节数（文件夹为 0）
    pub size: u64,
    /// 修改时间（Unix 秒）
    pub mtime: i64,
    /// by-type 分类名（文件夹为空串）
    pub category: String,
}

/// 扫描结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub dir: String,
    pub items: Vec<OrganizerItem>,
}

// —— 基础工具 ——

/// 缺省桌面目录（`dirs` crate：Windows SHGetKnownFolderPath / macOS NSHomeDirectory 封装）。
fn default_desktop_dir() -> Result<PathBuf, String> {
    dirs::desktop_dir().ok_or_else(|| "无法定位桌面目录".to_string())
}

/// 解析扫描根目录：显式 `dir`（**仅供测试 / 自定义目录**）或用户桌面。
fn resolve_root(dir: Option<String>) -> Result<PathBuf, String> {
    match dir {
        Some(d) if !d.trim().is_empty() => Ok(PathBuf::from(d.trim().to_string())),
        _ => default_desktop_dir(),
    }
}

/// by-type 分类（扩展名 → 类别名；未命中 → 「其他」）
fn category_for(ext: &str) -> &'static str {
    for (category, exts) in EXT_CATEGORIES {
        if exts.contains(&ext) {
            return category;
        }
    }
    CATEGORY_OTHER
}

/// Windows 文件属性位：隐藏 / 系统判定（纯函数，便于无 FFI 单测）。
#[cfg(target_os = "windows")]
fn attrs_hidden_or_system(attrs: u32) -> bool {
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}

/// 隐藏 / 系统文件判定（按路径）：
///   - Windows：`FILE_ATTRIBUTE_HIDDEN`(0x2) / `FILE_ATTRIBUTE_SYSTEM`(0x4)
///     经 `symlink_metadata` + `MetadataExt::file_attributes()` 读取（不跟随链接）；
///   - 其他平台：Unix 惯例的点开头隐藏文件。
/// 读取失败按「不隐藏」处理（宁可显示出来，也不静默漏掉用户的东西）。
fn is_hidden_or_system_path(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::fs::MetadataExt;
                attrs_hidden_or_system(meta.file_attributes())
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = &meta; // 非 Windows 不使用属性位
                path.file_name()
                    .map(|n| n.to_string_lossy().starts_with('.'))
                    .unwrap_or(false)
            }
        }
        Err(_) => false,
    }
}

// —— 核心逻辑（无 Tauri 依赖，可被 TEMP 沙箱测试直接调用）——

/// 扫描目录直接子项（原始枚举 + 元数据补全）—— **只读，不写任何东西**。
///
/// **只排除两类**：隐藏/系统属性文件、symlink/junction（枚举阶段就不该碰）。
/// `.lnk` 与文件夹保留在结果里（用户看得见），是否归拢由调用方决定。
pub(crate) fn scan_items(dir: &Path) -> Result<Vec<OrganizerItem>, String> {
    let entries = platform::current().enumerate_desktop_items(dir)?;
    let mut items = Vec::new();
    for entry in entries {
        let path = PathBuf::from(&entry.path);
        // 安全过滤（枚举阶段即排除）：隐藏/系统属性文件、symlink/junction
        if is_hidden_or_system_path(&path) {
            continue;
        }
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|err| format!("读取元数据失败（{}）：{err}", path.display()))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        let mtime: i64 = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let category = if entry.is_dir {
            String::new()
        } else {
            category_for(&ext).to_string()
        };
        items.push(OrganizerItem {
            name: entry.name,
            path: entry.path,
            is_dir: entry.is_dir,
            is_lnk: !entry.is_dir && ext == "lnk",
            ext,
            size: if entry.is_dir { 0 } else { meta.len() },
            mtime,
            category,
        });
    }
    Ok(items)
}

// —— Tauri 命令（薄包装）——

/// 扫描桌面（只读）。界面上用来显示「作用目录」与可整理条目数。
///
/// V48 起本模块**只有这一个命令** —— `organizer_preview_plan` / `organizer_apply` /
/// `organizer_undo` / `organizer_list_plans` / `organizer_update_plan_items` 已删除，
/// 因为它们的存在本身就是「桌面整理会搬走我的文件」这个误解的来源。
#[tauri::command]
pub async fn organizer_scan_desktop(dir: Option<String>) -> Result<ScanResult, String> {
    let root = resolve_root(dir)?;
    let items = scan_items(&root)?;
    Ok(ScanResult { dir: root.display().to_string(), items })
}

// —— TEMP 沙箱测试（红线：绝不触碰真实用户目录；沙箱目录在 %TEMP% 下自建自清理）——

#[cfg(test)]
mod tests {
    use super::*;

    /// TEMP 沙箱：`%TEMP%/handy-org-test-<pid>-<seq>/desktop`。
    /// 原子序号保证并行测试互不干扰（绝不触碰真实用户目录）。
    fn sandbox() -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let root =
            std::env::temp_dir().join(format!("handy-org-test-{}-{n}", std::process::id()));
        let desktop = root.join("desktop");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&desktop).unwrap();
        desktop
    }

    fn touch(dir: &Path, name: &str, content: &[u8]) {
        std::fs::write(dir.join(name), content).unwrap();
    }

    #[test]
    fn attrs_bits() {
        // Windows 属性位纯逻辑（无 FFI）：隐藏(0x2)/系统(0x4) 命中，只读(0x1) 不命中
        #[cfg(target_os = "windows")]
        {
            assert!(attrs_hidden_or_system(0x2));
            assert!(attrs_hidden_or_system(0x4));
            assert!(attrs_hidden_or_system(0x2 | 0x4 | 0x10));
            assert!(!attrs_hidden_or_system(0x0));
            assert!(!attrs_hidden_or_system(0x1));
        }
    }

    /// 扫描只读：分类正确、文件夹与 `.lnk` 保留、扫描后目录内容**一字未改**。
    #[test]
    fn scan_is_read_only_and_classifies() {
        let desktop = sandbox();
        touch(&desktop, "a.jpg", b"img");
        touch(&desktop, "b.pdf", b"doc");
        touch(&desktop, "c.zip", b"zip");
        touch(&desktop, "d.mp3", b"audio");
        touch(&desktop, "e.exe", b"app");
        touch(&desktop, "f.unknown", b"?");
        touch(&desktop, "g.lnk", b"lnk");
        std::fs::create_dir(desktop.join("somefolder")).unwrap();

        // 扫描前记录目录快照
        let before = {
            let mut names: Vec<String> = std::fs::read_dir(&desktop)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
                .collect();
            names.sort();
            names
        };

        let items = scan_items(&desktop).unwrap();
        let by_name: std::collections::HashMap<&str, &OrganizerItem> =
            items.iter().map(|i| (i.name.as_str(), i)).collect();

        assert_eq!(by_name["a.jpg"].category, "图片");
        assert_eq!(by_name["b.pdf"].category, "文档");
        assert_eq!(by_name["c.zip"].category, "压缩包");
        assert_eq!(by_name["d.mp3"].category, "音视频");
        assert_eq!(by_name["e.exe"].category, "安装包");
        assert_eq!(by_name["f.unknown"].category, "其他");
        // 文件夹与快捷方式保留在扫描结果里（是否归拢由调用方决定）
        assert!(by_name["somefolder"].is_dir);
        assert_eq!(by_name["somefolder"].category, "");
        assert!(by_name["g.lnk"].is_lnk);

        // ★ 关键断言：扫描之后桌面目录**内容与顺序完全一致**（本模块不写文件系统）
        let after = {
            let mut names: Vec<String> = std::fs::read_dir(&desktop)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
                .collect();
            names.sort();
            names
        };
        assert_eq!(before, after, "扫描不允许改动桌面目录内容");
        assert_eq!(after.len(), 8, "8 个条目一个都不能多一个都不能少");
    }

    /// 显式 `dir` 生效（`resolve_root`），避免测试误扫真实桌面。
    #[test]
    fn resolve_root_prefers_explicit_dir() {
        let desktop = sandbox();
        let resolved = resolve_root(Some(desktop.display().to_string())).unwrap();
        assert_eq!(resolved, desktop);
        // 空白串回落用户桌面（不在此断言具体路径，只断言不会 panic）
        assert!(resolve_root(Some("   ".into())).is_ok());
    }
}
