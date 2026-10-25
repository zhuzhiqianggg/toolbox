//! 软件安装（V84）——「新电脑装软件」白名单 + winget 执行。
//!
//! # 安全设计（与 `winopt.rs` 同一模型）
//!
//! 前端只能传**白名单里的 key**（[`catalog()`] 静态表），winget 包 id、参数全部来自
//! 本文件，前端无法拼接任意命令行。唯一的自由入口 [`apps_install_custom`] 只接受
//! 形如 `Publisher.Package` 的 id（字符集受限），且只会拼进 `winget install --id`。
//!
//! # 状态检测
//!
//! 不依赖 `winget list`（每次 1~2 秒，装十几项要等半分钟）：直接读三处
//! Uninstall 注册表（HKLM / HKLM WOW6432Node / HKCU），用 `DisplayName` 子串匹配，
//! 毫秒级、免提权。匹配不到的（如 WSL 这类 MSIX 包）回落到 winget 的已知 id 与否，
//! 前端显示「未知」而不是误判为未安装。
//!
//! # 执行
//!
//! `winget install --id <id> -e --silent --accept-*-agreements --disable-interactivity`，
//! 走 `spawn_blocking` 避免占住异步线程；权限不足时 winget 会自己弹 UAC（系统行为），
//! 静默拒绝则以退出码 + 末尾日志返回中文错误。

use serde::Serialize;

/// 目录项（前端渲染一行）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPackage {
    /// 稳定短 id（前端只认这个）
    pub id: String,
    /// winget 包 id（展示用，也便于用户手动搜索）
    pub winget_id: String,
    pub name: String,
    /// 分组：开发 / 效率 / 系统 / 媒体
    pub group: String,
    pub description: String,
    /// `Some(version)` = 已安装；`None` = 未安装
    pub installed: Option<String>,
}

struct Pkg {
    key: &'static str,
    winget: &'static str,
    name: &'static str,
    group: &'static str,
    description: &'static str,
    /// 注册表 DisplayName 的匹配子串（小写）；空串 = 注册表查不到，按未安装处理
    probe: &'static str,
}

/// 精选目录：都是「装系统必装、winget 一定能装到」的包。
/// 改这里要同步 `src/types/apps.ts` 的注释（前端不硬编码列表，直接读接口）。
fn catalog() -> &'static [Pkg] {
    &[
        // ——— 开发 ———
        Pkg {
            key: "git",
            winget: "Git.Git",
            name: "Git",
            group: "开发",
            description: "版本控制，装完自带 Git Bash / 凭证管理器",
            probe: "git",
        },
        Pkg {
            key: "nodejs",
            winget: "OpenJS.NodeJS.LTS",
            name: "Node.js LTS",
            group: "开发",
            description: "前端运行时 + npm（LTS 长期支持版）",
            probe: "node.js",
        },
        Pkg {
            key: "python",
            winget: "Python.Python.3.12",
            name: "Python 3.12",
            group: "开发",
            description: "含 pip；建议安装时勾选 Add to PATH",
            probe: "python 3.12",
        },
        Pkg {
            key: "vscode",
            winget: "Microsoft.VisualStudioCode",
            name: "VS Code",
            group: "开发",
            description: "轻量编辑器（用户级安装，免管理员）",
            probe: "visual studio code",
        },
        Pkg {
            key: "powershell",
            winget: "Microsoft.PowerShell",
            name: "PowerShell 7",
            group: "开发",
            description: "跨平台新版 PowerShell，替代系统自带的 5.1",
            probe: "powershell 7",
        },
        Pkg {
            key: "terminal",
            winget: "Microsoft.WindowsTerminal",
            name: "Windows Terminal",
            group: "开发",
            description: "多标签终端，Win11 自带但常缺新版",
            probe: "windows terminal",
        },
        Pkg {
            key: "wsl",
            winget: "Microsoft.WSL",
            name: "WSL 2",
            group: "开发",
            description: "Linux 子系统（已装 Docker 的话一般已经有了）",
            probe: "windows subsystem for linux",
        },
        Pkg {
            key: "docker",
            winget: "Docker.DockerDesktop",
            name: "Docker Desktop",
            group: "开发",
            description: "容器环境（依赖 WSL 2，装完需重启一次）",
            probe: "docker desktop",
        },
        Pkg {
            key: "postman",
            winget: "Postman.Postman",
            name: "Postman",
            group: "开发",
            description: "接口调试（本地已有 API 测试工具，可选）",
            probe: "postman",
        },
        // ——— 效率 ———
        Pkg {
            key: "7zip",
            winget: "7zip.7zip",
            name: "7-Zip",
            group: "效率",
            description: "解压压缩；右键菜单可解 7z / rar",
            probe: "7-zip",
        },
        Pkg {
            key: "everything",
            winget: "voidtools.Everything",
            name: "Everything",
            group: "效率",
            description: "秒级文件名搜索（NTFS 索引）",
            probe: "everything",
        },
        Pkg {
            key: "powertoys",
            winget: "Microsoft.PowerToys",
            name: "PowerToys",
            group: "效率",
            description: "窗口分屏 / 取色 / 批量重命名 / 快速启动",
            probe: "powertoys",
        },
        Pkg {
            key: "notepadpp",
            winget: "Notepad++.Notepad++",
            name: "Notepad++",
            group: "效率",
            description: "大文件 / 日志查看，比记事本快得多",
            probe: "notepad++",
        },
        Pkg {
            key: "bandizip",
            winget: "Bandisoft.Bandizip",
            name: "Bandizip",
            group: "效率",
            description: "解压工具，自动识别编码（中文文件名不乱码）",
            probe: "bandizip",
        },
        // ——— 系统 ———
        Pkg {
            key: "crystaldiskinfo",
            winget: "CrystalDewWorld.CrystalDiskInfo",
            name: "CrystalDiskInfo",
            group: "系统",
            description: "硬盘健康度 / 温度 / 通电时间，新机建议装一个",
            probe: "crystaldiskinfo",
        },
        Pkg {
            key: "crystaldiskmark",
            winget: "CrystalDewWorld.CrystalDiskMark",
            name: "CrystalDiskMark",
            group: "系统",
            description: "测 SSD 顺序 / 随机读写，验机跑分用",
            probe: "crystaldiskmark",
        },
        // ——— 媒体 ———
        Pkg {
            key: "chrome",
            winget: "Google.Chrome",
            name: "Chrome",
            group: "媒体",
            description: "浏览器（Edge 已自带，按需装）",
            probe: "google chrome",
        },
        Pkg {
            key: "vlc",
            winget: "VideoLAN.VLC",
            name: "VLC",
            group: "媒体",
            description: "万能播放器，几乎什么格式都能放",
            probe: "vlc",
        },
        Pkg {
            key: "potplayer",
            winget: "Daum.PotPlayer",
            name: "PotPlayer",
            group: "媒体",
            description: "轻量播放器，硬解省电",
            probe: "potplayer",
        },
        Pkg {
            key: "wechat",
            winget: "Tencent.WeChat",
            name: "微信",
            group: "媒体",
            description: "桌面版微信（本机可能已装）",
            probe: "wechat",
        },
    ]
}

/// 从注册表收集「已安装软件」的 (小写 DisplayName, 版本) 列表。
#[cfg(target_os = "windows")]
fn installed_index() -> Vec<(String, String)> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    const SUB: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    const SUB32: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

    let mut out: Vec<(String, String)> = Vec::new();
    let targets = [
        (HKEY_LOCAL_MACHINE, SUB),
        (HKEY_LOCAL_MACHINE, SUB32),
        (HKEY_CURRENT_USER, SUB),
    ];
    for (hive, path) in targets {
        let Ok(root) = RegKey::predef(hive).open_subkey_with_flags(path, KEY_READ) else {
            continue;
        };
        for name in root.enum_keys().flatten() {
            let Ok(key) = root.open_subkey_with_flags(&name, KEY_READ) else {
                continue;
            };
            let display: String = key.get_value("DisplayName").unwrap_or_default();
            if display.is_empty() {
                continue;
            }
            // SystemComponent=1 的条目是系统内部组件，不算「装了软件」
            if key.get_value::<u32, _>("SystemComponent").unwrap_or(0) == 1 {
                continue;
            }
            let version: String = key.get_value("DisplayVersion").unwrap_or_default();
            out.push((display.to_lowercase(), version));
        }
    }
    out
}

#[cfg(not(target_os = "windows"))]
fn installed_index() -> Vec<(String, String)> {
    Vec::new()
}

/// 在已安装索引里按 `probe` 找版本号。
fn probe_version(index: &[(String, String)], probe: &str) -> Option<String> {
    if probe.is_empty() {
        return None;
    }
    index
        .iter()
        .find(|(name, _)| name.contains(probe))
        .map(|(_, version)| {
            if version.is_empty() {
                "已安装".to_string()
            } else {
                version.clone()
            }
        })
}

/// 列出白名单目录 + 当前安装状态。
#[tauri::command]
pub async fn apps_list() -> Result<Vec<AppPackage>, String> {
    let index = installed_index();
    Ok(catalog()
        .iter()
        .map(|p| AppPackage {
            id: p.key.to_string(),
            winget_id: p.winget.to_string(),
            name: p.name.to_string(),
            group: p.group.to_string(),
            description: p.description.to_string(),
            installed: probe_version(&index, p.probe),
        })
        .collect())
}

/// 运行 winget 并返回「退出码 + 末尾日志」。阻塞式，由调用方放进 `spawn_blocking`。
#[cfg(target_os = "windows")]
fn run_winget(args: &[&str]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = std::process::Command::new("winget")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|err| format!("调用 winget 失败（可能未安装 App Installer）：{err}"))?;

    // winget 输出是 UTF-8，但中文环境下控制台字体提示会混入少量非 UTF-8 字节，宽松解码
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));

    // 只保留末尾 14 行：winget 前面是进度条噪声，结论都在最后
    let tail: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.contains('\u{8}'))
        .collect();
    let tail = tail[tail.len().saturating_sub(14)..].join("\n");

    if output.status.success() {
        Ok(tail)
    } else {
        Err(if tail.is_empty() {
            "winget 返回失败，但没有输出（可能被安全软件拦截）".to_string()
        } else {
            tail
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn run_winget(_args: &[&str]) -> Result<String, String> {
    Err("软件安装仅支持 Windows 系统".into())
}

/// 白名单 id → winget 包 id
fn winget_of(key: &str) -> Option<&'static str> {
    catalog()
        .iter()
        .find(|p| p.key == key)
        .map(|p| p.winget)
}

/// 安装（或升级）白名单里的一项。
#[tauri::command]
pub async fn apps_install(id: String) -> Result<String, String> {
    let winget = winget_of(&id).ok_or_else(|| format!("未知的软件：{id}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        run_winget(&[
            "install",
            "--id",
            winget,
            "-e",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
        ])
    })
    .await
    .map_err(|err| format!("安装任务异常中断：{err}"))?
}

/// 卸载白名单里的一项。
#[tauri::command]
pub async fn apps_uninstall(id: String) -> Result<String, String> {
    let winget = winget_of(&id).ok_or_else(|| format!("未知的软件：{id}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        run_winget(&[
            "uninstall",
            "--id",
            winget,
            "-e",
            "--silent",
            "--disable-interactivity",
        ])
    })
    .await
    .map_err(|err| format!("卸载任务异常中断：{err}"))?
}

/// 高级入口：安装任意 winget 包 id。
///
/// 只做字符集与长度校验（`Publisher.Package` 形态），不会拼进 shell —— 直接作为
/// `--id` 参数传给 winget 进程，因此不存在命令注入面。
#[tauri::command]
pub async fn apps_install_custom(winget_id: String) -> Result<String, String> {
    let id = winget_id.trim().to_string();
    if id.len() < 3 || id.len() > 80 || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+')) {
        return Err("包 id 只能包含字母 / 数字 / . - _ +（形如 Publisher.Package）".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_winget(&[
            "install",
            "--id",
            &id,
            "-e",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
        ])
    })
    .await
    .map_err(|err| format!("安装任务异常中断：{err}"))?
}
