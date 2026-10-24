//! Windows 优化工具（V62）——「关掉永远用不到、白耗性能的系统项」。
//!
//! # 安全设计（与 `sys.rs` 同一模型，勿改）
//!
//! 前端**只能传条目 id + 目标状态**（`applied` / `default`），所有注册表路径、值、
//! 命令都在本文件白名单表 [`table()`] 硬编码，前端无法构造任意写操作。
//!
//! # 执行模型
//!
//! - **状态读取**：HKCU / HKLM 注册表读取均不需要管理员权限，`winreg` 直读，毫秒级；
//! - **HKCU 写入**：当前用户权限直写（免 UAC，即时生效类目多为资源管理器/广告开关）；
//! - **HKLM 写入**：经 PowerShell `Start-Process -Verb RunAs -Wait -PassThru` 提权执行
//!   `reg.exe`，等待退出码 —— UAC 被拒绝或 reg 失败都会返回可读中文错误；
//! - **还原语义**：每项都给出 Windows 出厂默认值，`to=default` 即写回默认（非删除值），
//!   状态判定因此是纯等值比较。
//!
//! 平台边界：仅 Windows；其他平台返回明确中文错误。

use serde::Serialize;

/// 优化项元数据 + 当前状态（前端渲染开关）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WinOptItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub group: String,
    /// 写入需要管理员授权（前端加「管理员」角标，点击会弹 UAC）
    pub elevated: bool,
    /// 单向动作（如卸载 OneDrive）：无「还原」，前端渲染为按钮而非开关
    pub action_only: bool,
    /// `applied` = 已按推荐优化；`default` = Windows 默认；`unknown` = 无法读取
    pub status: String,
    /// 应用优化 / 还原后的提示（如「重启资源管理器生效」）
    pub notice: String,
}

/// 注册表蜂巢。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hive {
    CU,
    LM,
}

/// 白名单操作（决定状态读取与写入方式）。
enum Op {
    /// 单 DWORD 开关：`applied` 为优化值，`default` 为 Windows 默认值
    Dword {
        hive: Hive,
        path: &'static str,
        name: &'static str,
        applied: u32,
        default: u32,
    },
    /// 同一路径下的多个 DWORD（任一不为 applied 即视为未优化）
    Multi {
        hive: Hive,
        path: &'static str,
        names: &'static [&'static str],
        applied: u32,
        default: u32,
    },
    /// OneDrive 开机自启（删除/重建 HKCU Run 值；值内容含用户路径，走脚本）
    OneDriveStartup,
    /// 卸载 OneDrive（单向动作，winget）
    OneDriveUninstall,
}

struct Entry {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    group: &'static str,
    elevated: bool,
    op: Op,
    /// 操作后的生效提示（空 = 无需提示）
    notice: &'static str,
}

impl Entry {
    fn action_only(&self) -> bool {
        matches!(self.op, Op::OneDriveUninstall)
    }
}

/// 全量优化项表（顺序即界面顺序；新增项**只在此处追加**）。
fn table() -> Vec<Entry> {
    vec![
        // ——— OneDrive ———
        Entry {
            id: "onedrive-startup",
            name: "禁用 OneDrive 开机自启",
            description: "删除 OneDrive 的用户级自启动项（不影响已登录的同步会话）",
            group: "OneDrive",
            elevated: false,
            op: Op::OneDriveStartup,
            notice: "",
        },
        Entry {
            id: "onedrive-explorer",
            name: "隐藏资源管理器 OneDrive 图标",
            description: "移除资源管理器侧栏的 OneDrive 入口（不卸载，随时可还原）",
            group: "OneDrive",
            elevated: false,
            op: Op::Dword {
                hive: Hive::CU,
                path: r"Software\Classes\CLSID\{018D5C66-4533-4307-9B53-224DE2ED1FE6}",
                name: "System.IsPinnedToNameSpaceTree",
                applied: 0,
                default: 1,
            },
            notice: "重启资源管理器或注销后完全生效",
        },
        Entry {
            id: "onedrive-uninstall",
            name: "卸载 OneDrive",
            description: "经 winget 静默卸载（用户级，无需管理员；卸载后可从官网重装）",
            group: "OneDrive",
            elevated: false,
            op: Op::OneDriveUninstall,
            notice: "卸载在后台进行，文件区图标可能在几秒后消失",
        },
        // ——— 隐私与广告 ———
        Entry {
            id: "telemetry",
            name: "关闭诊断数据上报",
            description: "策略级遥测调至最低（家庭版等效最低档）",
            group: "隐私与广告",
            elevated: true,
            op: Op::Dword {
                hive: Hive::LM,
                path: r"SOFTWARE\Policies\Microsoft\Windows\DataCollection",
                name: "AllowTelemetry",
                applied: 0,
                default: 1,
            },
            notice: "",
        },
        Entry {
            id: "ad-id",
            name: "关闭广告标识符",
            description: "应用不再拿唯一广告 ID 做个性化推荐",
            group: "隐私与广告",
            elevated: false,
            op: Op::Dword {
                hive: Hive::CU,
                path: r"Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo",
                name: "Enabled",
                applied: 0,
                default: 1,
            },
            notice: "",
        },
        Entry {
            id: "start-suggestions",
            name: "关闭开始菜单推广内容",
            description: "开始菜单里的应用推荐、广告 suggestions、账户提醒一起关",
            group: "隐私与广告",
            elevated: false,
            op: Op::Multi {
                hive: Hive::CU,
                path: r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager",
                names: &[
                    "SubscribedContent-338388Enabled",
                    "SubscribedContent-338389Enabled",
                    "SubscribedContent-338393Enabled",
                    "SubscribedContent-353698Enabled",
                    "SystemPaneSuggestionsEnabled",
                ],
                applied: 0,
                default: 1,
            },
            notice: "",
        },
        Entry {
            id: "spotlight",
            name: "关闭锁屏 Windows 聚焦",
            description: "锁定屏不再换推广壁纸与广告卡片",
            group: "隐私与广告",
            elevated: false,
            op: Op::Dword {
                hive: Hive::CU,
                path: r"Software\Policies\Microsoft\Windows\CloudContent",
                name: "DisableWindowsSpotlightFeatures",
                applied: 1,
                default: 0,
            },
            notice: "",
        },
        Entry {
            id: "copilot",
            name: "隐藏任务栏 Copilot",
            description: "移除任务栏右侧的 Copilot 悬浮按钮",
            group: "隐私与广告",
            elevated: false,
            op: Op::Dword {
                hive: Hive::CU,
                path: r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced",
                name: "ShowCopilotButton",
                applied: 0,
                default: 1,
            },
            notice: "重启资源管理器后图标消失",
        },
        Entry {
            id: "remote-assist",
            name: "关闭远程协助",
            description: "不接受远程协助邀请（不用远程协助的机器关掉更安全）",
            group: "隐私与广告",
            elevated: true,
            op: Op::Dword {
                hive: Hive::LM,
                path: r"SYSTEM\CurrentControlSet\Control\Remote Assistance",
                name: "fAllowToGetHelp",
                applied: 0,
                default: 1,
            },
            notice: "",
        },
        // ——— 系统性能 ———
        Entry {
            id: "sysmain",
            name: "禁用 SysMain 服务",
            description: "Superfetch 预加载在 SSD 上收益趋近于零却常驻读盘；机械硬盘用户请勿关闭",
            group: "系统性能",
            elevated: true,
            op: Op::Dword {
                hive: Hive::LM,
                path: r"SYSTEM\CurrentControlSet\Services\SysMain",
                name: "Start",
                applied: 4,
                default: 2,
            },
            notice: "重启后完全生效（4=禁用，2=自动）",
        },
        Entry {
            id: "hibernate",
            name: "关闭休眠 hiberfil.sys",
            description: "释放与内存等大的休眠文件（台式机/常用关机用户推荐；合盖即睡眠的笔记本慎开）",
            group: "系统性能",
            elevated: true,
            op: Op::Dword {
                hive: Hive::LM,
                path: r"SYSTEM\CurrentControlSet\Control\Power",
                name: "HibernateEnabled",
                applied: 0,
                default: 1,
            },
            notice: "休眠文件空间在重启后释放；「快速启动」随之不可用",
        },
        Entry {
            id: "delivery-opt",
            name: "关闭更新 P2P 分发",
            description: "不再向局域网/互联网节点上传 Windows 更新包（只下载不上传）",
            group: "系统性能",
            elevated: true,
            op: Op::Dword {
                hive: Hive::LM,
                path: r"SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization",
                name: "DODownloadMode",
                applied: 0,
                default: 1,
            },
            notice: "",
        },
        // ——— 游戏与后台 ———
        Entry {
            id: "gamedvr",
            name: "关闭 Xbox 后台录制",
            description: "Game DVR 不再常驻等待 Win+G 录制，游戏中省一段 GPU/编码开销",
            group: "游戏与后台",
            elevated: false,
            op: Op::Dword {
                hive: Hive::CU,
                path: r"System\GameConfigStore",
                name: "GameDVR_Enabled",
                applied: 0,
                default: 1,
            },
            notice: "",
        },
    ]
}

// ——— 注册表读取（HKCU/HKLM 读取都不需要管理员） ———

#[cfg(target_os = "windows")]
fn read_dword(hive: Hive, path: &str, name: &str) -> Option<u32> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let predef = match hive {
        Hive::CU => HKEY_CURRENT_USER,
        Hive::LM => HKEY_LOCAL_MACHINE,
    };
    let key = RegKey::predef(predef).open_subkey(path).ok()?;
    key.get_value::<u32, _>(name).ok()
}

#[cfg(not(target_os = "windows"))]
fn read_dword(_hive: Hive, _path: &str, _name: &str) -> Option<u32> {
    None
}

/// 条目当前状态。
fn status_of(op: &Op) -> String {
    match op {
        Op::Dword {
            hive, path, name, applied, default,
        } => match read_dword(*hive, path, name) {
            Some(value) if value == *applied => "applied".into(),
            Some(value) if value == *default => "default".into(),
            Some(_) => "unknown".into(),
            None => "unknown".into(),
        },
        Op::Multi {
            hive, path, names, applied, default,
        } => {
            let values: Vec<Option<u32>> = names
                .iter()
                .map(|name| read_dword(*hive, path, name))
                .collect();
            if values.iter().any(|v| *v == Some(*applied)) && values.iter().all(|v| v.is_some())
            {
                "applied".into()
            } else if values.iter().all(|v| *v == Some(*default)) {
                "default".into()
            } else {
                "unknown".into()
            }
        }
        Op::OneDriveStartup => {
            let run_value = read_string(
                Hive::CU,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                "OneDrive",
            );
            if run_value.is_some() {
                "default".into()
            } else {
                "applied".into()
            }
        }
        Op::OneDriveUninstall => {
            let onedrive = dirs::home_dir()
                .map(|home| home.join(r"AppData\Local\Microsoft\OneDrive\OneDrive.exe"));
            match onedrive {
                Some(path) if path.exists() => "default".into(),
                Some(_) => "applied".into(),
                None => "unknown".into(),
            }
        }
    }
}

/// 读字符串值（仅 OneDriveStartup 状态用）。
#[cfg(target_os = "windows")]
fn read_string(hive: Hive, path: &str, name: &str) -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let predef = match hive {
        Hive::CU => HKEY_CURRENT_USER,
        Hive::LM => HKEY_LOCAL_MACHINE,
    };
    let key = RegKey::predef(predef).open_subkey(path).ok()?;
    key.get_value::<String, _>(name).ok()
}

#[cfg(not(target_os = "windows"))]
fn read_string(_hive: Hive, _path: &str, _name: &str) -> Option<String> {
    None
}

// ——— 写入（HKCU 直写；HKLM 经 reg.exe 提权） ———

/// HKCU / HKLM 蜂巢在 reg.exe 命令行里的前缀。
#[cfg(target_os = "windows")]
fn hive_prefix(hive: Hive) -> &'static str {
    match hive {
        Hive::CU => "HKCU",
        Hive::LM => "HKLM",
    }
}

/// 以管理员执行一段 PowerShell 脚本并等待退出码（UAC 拒绝 → 可读错误）。
///
/// 与 `sys.rs::launch_elevated`（点火即走）不同，优化开关需要感知成败：
/// `-Wait -PassThru` 拿到子进程退出码，脚本内部显式 `exit` 传递 reg.exe 失败。
#[cfg(target_os = "windows")]
fn run_elevated_ps(script: &str) -> Result<(), String> {
    // 脚本作为单个 -Command 参数传给提权实例（PowerShell 单引号规则转义）
    fn ps_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }
    let outer = format!(
        "try {{ $p = Start-Process -FilePath {program} -ArgumentList @('-NoProfile','-Command',{script}) -Verb RunAs -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode }} catch {{ exit 1 }}",
        program = ps_quote(&system32("WindowsPowerShell\\v1.0\\powershell.exe")),
        script = ps_quote(script),
    );

    let mut command =
        std::process::Command::new(system32("WindowsPowerShell\\v1.0\\powershell.exe"));
    command.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &outer]);
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|err| format!("请求管理员权限失败：{err}"))?;
    if output.status.success() {
        return Ok(());
    }
    // UAC 弹窗被取消时 Start-Process 抛异常，外层 powershell 退出码非 0
    Err("管理员授权被取消或操作失败（未做任何更改）".into())
}

/// 当前权限直接执行一段 PowerShell（HKCU 类操作，免 UAC）。
#[cfg(target_os = "windows")]
fn run_ps(script: &str) -> Result<(), String> {
    let mut command =
        std::process::Command::new(system32("WindowsPowerShell\\v1.0\\powershell.exe"));
    command.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", script]);
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|err| format!("执行 PowerShell 失败：{err}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err("操作未完成（PowerShell 返回非零）".into())
}

/// `%SystemRoot%\System32\<name>`（与 sys.rs 同口径）。
#[cfg(target_os = "windows")]
fn system32(name: &str) -> String {
    match std::env::var("SystemRoot") {
        Ok(root) => format!("{root}\\System32\\{name}"),
        Err(_) => format!("C:\\Windows\\System32\\{name}"),
    }
}

/// HKCU 直写 / 删除一个 DWORD。
#[cfg(target_os = "windows")]
fn write_hkcu_dword(path: &str, name: &str, value: Option<u32>) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(path)
        .map_err(|err| format!("打开注册表项失败（{path}）：{err}"))?;
    match value {
        Some(v) => key
            .set_value(name, &v)
            .map_err(|err| format!("写入注册表值失败（{name}）：{err}")),
        None => match key.delete_value(name) {
            Ok(()) => Ok(()),
            // 值本就不存在 = 目标状态已达成
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("删除注册表值失败（{name}）：{err}")),
        },
    }
}

/// 组装 `reg add` 脚本（HKLM 提权路径用）。
#[cfg(target_os = "windows")]
fn reg_add_script(hive: Hive, path: &str, name: &str, value: u32) -> String {
    format!(
        "reg add \"{}\\{}\" /v \"{}\" /t REG_DWORD /d {} /f; if (-not $?) {{ exit 1 }}",
        hive_prefix(hive),
        path,
        name,
        value
    )
}

/// 应用/还原一个条目（`to`：`applied` = 优化值，`default` = Windows 默认）。
#[tauri::command]
pub async fn winopt_apply(id: String, to: String) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Windows 优化仅支持 Windows 系统".into());
    }
    let entry = table()
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("未知的优化项：{id}"))?;
    let to_applied = match to.as_str() {
        "applied" => true,
        "default" => false,
        other => return Err(format!("未知的目标状态：{other}")),
    };
    if entry.action_only() {
        return Err("该项为单向操作，请使用 winopt_action".into());
    }

    let name = entry.name;
    run_op(&entry.op, to_applied)
        .map_err(|err| format!("{name}：{err}"))?;
    Ok(())
}

/// 执行条目操作（分派到注册表 / 脚本）。
#[cfg(target_os = "windows")]
fn run_op(op: &Op, to_applied: bool) -> Result<(), String> {
    match op {
        Op::Dword {
            hive, path, name, applied, default,
        } => {
            let value = if to_applied { *applied } else { *default };
            match hive {
                Hive::CU => write_hkcu_dword(path, name, Some(value)),
                Hive::LM => {
                    run_elevated_ps(&reg_add_script(*hive, path, name, value))
                }
            }
        }
        Op::Multi {
            hive, path, names, applied, default,
        } => {
            let value = if to_applied { *applied } else { *default };
            match hive {
                Hive::CU => {
                    for name in names.iter() {
                        write_hkcu_dword(path, name, Some(value))?;
                    }
                    Ok(())
                }
                Hive::LM => {
                    let script = names
                        .iter()
                        .map(|name| reg_add_script(*hive, path, name, value))
                        .collect::<Vec<_>>()
                        .join(" ");
                    run_elevated_ps(&script)
                }
            }
        }
        Op::OneDriveStartup => {
            if to_applied {
                run_ps(
                    r"Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'OneDrive' -ErrorAction SilentlyContinue; exit 0",
                )
            } else {
                // 还原：仅在 OneDrive 本体仍存在时重建自启动值（exit 2 = 本体不存在）
                run_ps(
                    r#"$od = Join-Path $env:LOCALAPPDATA 'Microsoft\OneDrive\OneDrive.exe'; if (Test-Path $od) { New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'OneDrive' -Value ('"' + $od + '" /background') -PropertyType String -Force | Out-Null; exit 0 } else { exit 2 }"#,
                )
                .map_err(|err| {
                    if err.contains("非零") {
                        "未检测到 OneDrive 本体，无需还原自启动项".into()
                    } else {
                        err
                    }
                })
            }
        }
        Op::OneDriveUninstall => Err("单向操作请走 winopt_action".into()),
    }
}

#[cfg(not(target_os = "windows"))]
fn run_op(_op: &Op, _to_applied: bool) -> Result<(), String> {
    Err("Windows 优化仅支持 Windows 系统".into())
}

/// 单向动作（卸载 OneDrive）。
#[tauri::command]
pub async fn winopt_action(id: String) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Windows 优化仅支持 Windows 系统".into());
    }
    let entry = table()
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("未知的优化动作：{id}"))?;
    if !entry.action_only() {
        return Err("该项不是单向操作，请使用 winopt_apply".into());
    }
    let name = entry.name;
    run_action(&entry.op).map_err(|err| format!("{name}：{err}"))
}

#[cfg(target_os = "windows")]
fn run_action(op: &Op) -> Result<(), String> {
    match op {
        Op::OneDriveUninstall => run_ps(
            r"winget uninstall --id Microsoft.OneDrive --silent --disable-interactivity --accept-source-agreements; exit $LASTEXITCODE",
        )
        .map_err(|_| {
            "卸载未完成（winget 不存在、网络受限或卸载被拦截）。可在「设置 → 应用」里手动卸载".into()
        }),
        _ => Err("该项不是单向操作".into()),
    }
}

#[cfg(not(target_os = "windows"))]
fn run_action(_op: &Op) -> Result<(), String> {
    Err("Windows 优化仅支持 Windows 系统".into())
}

/// 优化项清单（元数据 + 实时状态）。
#[tauri::command]
pub async fn winopt_list() -> Result<Vec<WinOptItem>, String> {
    Ok(table()
        .into_iter()
        .map(|entry| WinOptItem {
            id: entry.id.to_string(),
            name: entry.name.to_string(),
            description: entry.description.to_string(),
            group: entry.group.to_string(),
            elevated: entry.elevated,
            action_only: entry.action_only(),
            status: status_of(&entry.op),
            notice: entry.notice.to_string(),
        })
        .collect())
}
