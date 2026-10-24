//! 工作台「快捷入口」——系统级快捷动作（命令提示符 / 网络 / 系统管理面板）。
//!
//! # 安全设计（关键，勿改）
//!
//! 前端**只能传动作 id**，不接受任何可执行文件路径或命令行参数。所有可启动的目标
//! 与参数都在本文件的白名单表 [`table`] 里硬编码，前端无法构造新的命令，
//! 因此**从根上不存在命令注入面**。这比提供「通用 shell 执行」命令安全得多，
//! 也符合产品定位（工具型软件不该给自身开任意执行的后门）。
//!
//! # 三类启动方式
//!
//! - [`Launch::Open`]：交给系统 shell 打开（`ms-settings:` 协议、`.cpl` 控制面板小程序、
//!   `.msc` 管理单元、文件、目录）——底层为 Win32 `ShellExecuteW`；
//! - [`Launch::Spawn`]：直接启动固定程序（**仅限真 PE 可执行文件**，如 `taskmgr.exe`）；
//! - [`Launch::Elevated`]：经 PowerShell `Start-Process -Verb RunAs` 触发 UAC 提权后启动。
//!
//! ⚠️ `.cpl` / `.msc` / 目录**绝不能**用 `Launch::Spawn`：它们不是可执行文件，
//! `std::process::Command` 会报 `os error 193`（曾是「网络连接」等入口点不开的根因）。
//!
//! # 两级启动（V20 加固）
//!
//! `Launch::Open` 先走 `ShellExecuteW`（系统关联，体验最好），失败后**再兜一层**
//! [`launch_fallback`]：按扩展名直连固定宿主（`.cpl`→`rundll32 shell32.dll,Control_RunDLL`、
//! `.msc`→`mmc.exe`、目录→`explorer.exe`）。用户实测报过 `ShellExecute 代码 31`
//! （`SE_ERR_NOASSOC` = 注册表里该扩展名没有关联程序），说明系统关联**不保证存在**，
//! 因此不能把它当唯一路径。
//!
//! 平台边界：本模块为 Windows 系统管理面板而设，非 Windows 平台返回明确的中文错误
//! （不静默失败）。全部命令均为 `async fn`（项目 P0 约定）。

use serde::Serialize;

/// 动作元数据（前端渲染按钮用；`table()` 的顺序即展示顺序）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysAction {
    /// 动作 id（前端唯一可传的参数）
    pub id: String,
    /// 按钮标题
    pub name: String,
    /// 一句话说明
    pub description: String,
    /// 分组名（前端按组渲染）
    pub group: String,
    /// 是否需要管理员权限（前端加「管理员」角标）
    pub elevated: bool,
}

/// 启动方式。
enum Launch {
    /// 用系统默认程序打开（协议 / 文件 / 目录）
    Open(String),
    /// 直接启动（固定参数）
    Spawn { program: String, args: Vec<String> },
    /// 提权启动（触发 UAC）
    Elevated { program: String, args: Vec<String> },
}

/// 白名单条目。`launch` 为无捕获闭包，故可退化为函数指针。
struct Entry {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    group: &'static str,
    elevated: bool,
    launch: fn() -> Launch,
}

// —— 路径辅助（系统目录不写死盘符，兼容非 C: 安装） ——

/// `%SystemRoot%\System32\<name>`
fn system32(name: &str) -> String {
    match std::env::var("SystemRoot") {
        Ok(root) => format!("{root}\\System32\\{name}"),
        Err(_) => format!("C:\\Windows\\System32\\{name}"),
    }
}

/// `%SystemRoot%\System32\drivers\etc`（`name` 为空时返回目录本身，不带尾反斜杠）
fn drivers_etc(name: &str) -> String {
    let base = match std::env::var("SystemRoot") {
        Ok(root) => format!("{root}\\System32\\drivers\\etc"),
        Err(_) => "C:\\Windows\\System32\\drivers\\etc".to_string(),
    };
    if name.is_empty() {
        base
    } else {
        format!("{base}\\{name}")
    }
}

/// 无参数辅助：返回 `Launch::Open`
fn open(target: impl Into<String>) -> Launch {
    Launch::Open(target.into())
}

/// 无参数辅助：返回不带参数的 `Launch::Spawn`
fn spawn(program: impl Into<String>) -> Launch {
    Launch::Spawn {
        program: program.into(),
        args: Vec::new(),
    }
}

/// 提权启动 `notepad.exe <文件>`（用于 hosts 等系统文件的编辑）
fn elevated_notepad(path: String) -> Launch {
    Launch::Elevated {
        program: system32("notepad.exe"),
        args: vec![path],
    }
}

/// 全量动作表（顺序即界面顺序；新增动作**只在此处追加**）。
fn table() -> Vec<Entry> {
    vec![
        // ——— 终端 ———
        Entry {
            id: "powershell-admin",
            name: "管理员 PowerShell",
            description: "以管理员身份打开 PowerShell",
            group: "终端",
            elevated: true,
            launch: || Launch::Elevated {
                program: system32("WindowsPowerShell\\v1.0\\powershell.exe"),
                args: vec!["-NoExit".to_string()],
            },
        },
        Entry {
            id: "cmd-admin",
            name: "管理员 CMD",
            description: "以管理员身份打开命令提示符",
            group: "终端",
            elevated: true,
            launch: || Launch::Elevated {
                program: system32("cmd.exe"),
                args: vec!["/k".to_string()],
            },
        },
        Entry {
            id: "powershell",
            name: "PowerShell",
            description: "以当前权限打开 PowerShell",
            group: "终端",
            elevated: false,
            launch: || Launch::Spawn {
                program: system32("WindowsPowerShell\\v1.0\\powershell.exe"),
                args: vec!["-NoExit".to_string()],
            },
        },
        Entry {
            id: "ipconfig",
            name: "查看 IP 配置",
            description: "ipconfig /all：本机网卡与地址一览",
            group: "终端",
            elevated: false,
            launch: || Launch::Spawn {
                program: system32("cmd.exe"),
                args: vec![
                    "/k".to_string(),
                    "ipconfig".to_string(),
                    "/all".to_string(),
                ],
            },
        },
        // ——— 网络 ———
        Entry {
            id: "ncpa",
            name: "网络连接",
            description: "ncpa.cpl：网卡属性 / IP / DNS 在这里改",
            group: "网络",
            elevated: false,
            launch: || open(system32("ncpa.cpl")),
        },
        Entry {
            id: "dns-flush",
            name: "刷新 DNS 缓存",
            description: "ipconfig /flushdns（需管理员）",
            group: "网络",
            elevated: true,
            launch: || Launch::Elevated {
                program: system32("cmd.exe"),
                args: vec![
                    "/k".to_string(),
                    "ipconfig".to_string(),
                    "/flushdns".to_string(),
                ],
            },
        },
        Entry {
            id: "hosts-edit",
            name: "编辑 hosts",
            description: "用管理员记事本打开 hosts 文件",
            group: "网络",
            elevated: true,
            launch: || elevated_notepad(drivers_etc("hosts")),
        },
        Entry {
            id: "hosts-folder",
            name: "打开 hosts 目录",
            description: "定位到 drivers\\etc 目录",
            group: "网络",
            elevated: false,
            launch: || open(drivers_etc("")),
        },
        Entry {
            id: "network-settings",
            name: "网络状态",
            description: "Windows 网络设置页",
            group: "网络",
            elevated: false,
            launch: || open("ms-settings:network-status"),
        },
        Entry {
            id: "wifi-settings",
            name: "WLAN 设置",
            description: "无线网络与已知网络管理",
            group: "网络",
            elevated: false,
            launch: || open("ms-settings:network-wifi"),
        },
        Entry {
            id: "proxy-settings",
            name: "代理设置",
            description: "系统代理 / 手动代理服务器",
            group: "网络",
            elevated: false,
            launch: || open("ms-settings:network-proxy"),
        },
        // ——— 系统管理 ———
        Entry {
            id: "taskmgr",
            name: "任务管理器",
            description: "进程 / 性能 / 启动项",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("taskmgr.exe")),
        },
        Entry {
            id: "services",
            name: "服务",
            description: "services.msc：服务启停与启动类型",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("services.msc")),
        },
        Entry {
            id: "device-mgr",
            name: "设备管理器",
            description: "devmgmt.msc：驱动与硬件",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("devmgmt.msc")),
        },
        Entry {
            id: "disk-mgr",
            name: "磁盘管理",
            description: "diskmgmt.msc：分区与盘符",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("diskmgmt.msc")),
        },
        Entry {
            id: "event-viewer",
            name: "事件查看器",
            description: "eventvwr.msc：系统与应用日志",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("eventvwr.msc")),
        },
        Entry {
            id: "firewall",
            name: "防火墙",
            description: "wf.msc：高级安全 Windows 防火墙",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("wf.msc")),
        },
        Entry {
            id: "registry",
            name: "注册表编辑器",
            description: "regedit（改动前请先备份）",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("regedit.exe")),
        },
        Entry {
            id: "system-info",
            name: "系统信息",
            description: "msinfo32：软硬件摘要",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("msinfo32.exe")),
        },
        Entry {
            id: "perfmon",
            name: "性能监视器",
            description: "perfmon：性能计数器",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("perfmon.msc")),
        },
        Entry {
            id: "env-vars",
            name: "环境变量",
            description: "用户 / 系统环境变量编辑",
            group: "系统管理",
            elevated: false,
            launch: || Launch::Spawn {
                program: system32("rundll32.exe"),
                args: vec![
                    "sysdm.cpl,EditEnvironmentVariables".to_string(),
                ],
            },
        },
        Entry {
            id: "system-props",
            name: "系统属性",
            description: "sysdm.cpl：计算机名 / 远程 / 还原",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("sysdm.cpl")),
        },
        Entry {
            id: "programs",
            name: "程序和功能",
            description: "appwiz.cpl：卸载 / 修复软件",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("appwiz.cpl")),
        },
        Entry {
            id: "windows-update",
            name: "Windows 更新",
            description: "检查更新与更新历史",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:windowsupdate"),
        },
        Entry {
            id: "startup-apps",
            name: "启动应用",
            description: "开机自启项开关",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:startupapps"),
        },
        Entry {
            id: "display-settings",
            name: "显示设置",
            description: "分辨率 / 缩放 / 多显示器",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:display"),
        },
        Entry {
            id: "storage-settings",
            name: "存储设置",
            description: "磁盘占用与感知清理",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:storagesense"),
        },
        Entry {
            id: "power",
            name: "电源选项",
            description: "powercfg.cpl：电源计划",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("powercfg.cpl")),
        },
        Entry {
            id: "date-time",
            name: "日期和时间",
            description: "timedate.cpl：时区与校时",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("timedate.cpl")),
        },
        Entry {
            id: "sound",
            name: "声音",
            description: "mmsys.cpl：播放 / 录音设备",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("mmsys.cpl")),
        },
        Entry {
            id: "control-panel",
            name: "控制面板",
            description: "经典控制面板入口",
            group: "系统管理",
            elevated: false,
            launch: || Launch::Spawn {
                program: system32("control.exe"),
                args: Vec::new(),
            },
        },
        Entry {
            id: "temp-folder",
            name: "临时文件目录",
            description: "%TEMP%：可安全清理的临时目录",
            group: "系统管理",
            elevated: false,
            launch: || {
                let dir = std::env::temp_dir();
                open(dir.to_string_lossy().to_string())
            },
        },
        // ——— 网络（续）———
        Entry {
            id: "shared-folders",
            name: "共享文件夹",
            description: "fsmgmt.msc：本机共享目录与会话",
            group: "网络",
            elevated: false,
            launch: || open(system32("fsmgmt.msc")),
        },
        // ——— 系统管理（续：运维高频）———
        Entry {
            id: "task-scheduler",
            name: "任务计划程序",
            description: "taskschd.msc：定时任务与触发器",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("taskschd.msc")),
        },
        Entry {
            id: "resource-monitor",
            name: "资源监视器",
            description: "resmon：CPU / 磁盘 / 网络实时占用",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("resmon.exe")),
        },
        Entry {
            id: "system-config",
            name: "系统配置",
            description: "msconfig：启动项 / 引导 / 服务排查",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("msconfig.exe")),
        },
        Entry {
            id: "disk-cleanup",
            name: "磁盘清理",
            description: "cleanmgr：清理系统临时文件",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("cleanmgr.exe")),
        },
        Entry {
            id: "defrag",
            name: "优化驱动器",
            description: "dfrgui：碎片整理 / SSD TRIM",
            group: "系统管理",
            elevated: true,
            launch: || Launch::Elevated {
                program: system32("dfrgui.exe"),
                args: Vec::new(),
            },
        },
        Entry {
            id: "user-accounts",
            name: "用户账户",
            description: "netplwiz：账户与自动登录设置",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("netplwiz.exe")),
        },
        Entry {
            id: "local-users",
            name: "本地用户和组",
            description: "lusrmgr.msc：账户与用户组（专业版）",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("lusrmgr.msc")),
        },
        Entry {
            id: "cert-manager",
            name: "证书管理器",
            description: "certmgr.msc：受信任证书与吊销列表",
            group: "系统管理",
            elevated: false,
            launch: || open(system32("certmgr.msc")),
        },
        Entry {
            id: "odbc",
            name: "ODBC 数据源",
            description: "odbcad32：数据库驱动与 DSN 管理",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("odbcad32.exe")),
        },
        Entry {
            id: "system-restore",
            name: "系统还原",
            description: "rstrui：创建 / 回滚还原点",
            group: "系统管理",
            elevated: false,
            launch: || spawn(system32("rstrui.exe")),
        },
        Entry {
            id: "printer-settings",
            name: "打印机和扫描仪",
            description: "设备与打印队列",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:printers"),
        },
        Entry {
            id: "bluetooth-settings",
            name: "蓝牙设置",
            description: "蓝牙设备配对与管理",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:bluetooth"),
        },
        Entry {
            id: "default-apps",
            name: "默认应用",
            description: "按协议 / 扩展名指定默认程序",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:defaultapps"),
        },
        Entry {
            id: "clipboard-settings",
            name: "剪贴板历史",
            description: "Win+V 历史与跨设备同步",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:clipboard"),
        },
        Entry {
            id: "remote-desktop",
            name: "远程桌面",
            description: "开启 / 关闭本机远程桌面",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:remotedesktop"),
        },
        Entry {
            id: "defender",
            name: "Windows 安全中心",
            description: "病毒防护 / 防火墙 / 设备安全",
            group: "系统管理",
            elevated: false,
            launch: || open("ms-settings:windowsdefender"),
        },
    ]
}

/// 动作清单（前端渲染「快捷入口」网格）。
#[tauri::command]
pub async fn sys_action_list() -> Result<Vec<SysAction>, String> {
    Ok(table()
        .into_iter()
        .map(|entry| SysAction {
            id: entry.id.to_string(),
            name: entry.name.to_string(),
            description: entry.description.to_string(),
            group: entry.group.to_string(),
            elevated: entry.elevated,
        })
        .collect())
}

/// 以管理员身份启动（经 PowerShell `Start-Process -Verb RunAs` 触发 UAC）。
///
/// 参数均为白名单内的字面量，仍按 PowerShell 单引号规则转义（单引号翻倍），
/// 保证含空格 / 特殊字符的路径（如 non-C: 的系统盘、带空格用户名）不被拆坏。
fn launch_elevated(program: &str, args: &[String]) -> Result<(), String> {
    fn quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }
    let mut script = format!("Start-Process -FilePath {}", quote(program));
    if !args.is_empty() {
        let list = args
            .iter()
            .map(|arg| quote(arg))
            .collect::<Vec<_>>()
            .join(",");
        script.push_str(&format!(" -ArgumentList {list}"));
    }
    script.push_str(" -Verb RunAs");

    let mut command = std::process::Command::new(system32("WindowsPowerShell\\v1.0\\powershell.exe"));
    command.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 隐藏这个只负责「拉起 UAC」的中间进程，避免黑框一闪
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map_err(|err| format!("请求管理员权限失败：{err}"))?;
    Ok(())
}

/// 直接启动（固定参数，不创建窗口标记 —— 需要控制台的程序要保留自己的控制台）。
fn launch_spawn(program: &str, args: &[String]) -> Result<(), String> {
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map_err(|err| format!("启动「{program}」失败：{err}"))?;
    Ok(())
}

/// 交给系统 shell「打开」一个目标（协议 / 文件 / 目录 / 控制面板小程序）。
///
/// # 为什么必须用 `ShellExecuteW` 而不是 `Command::new`
///
/// `.cpl`（控制面板小程序）、`.msc`（管理单元）**不是 PE 可执行文件**，
/// 用 `std::process::Command` 直接执行会失败并报
/// `%1 不是有效的 Win32 应用程序 (os error 193)`。`ShellExecuteW` 走的才是
/// 资源管理器双击那条路（由注册表关联决定真实处理程序），因此
/// `ncpa.cpl` / `services.msc` / 目录 / `ms-settings:` 协议全部由此统一处理。
///
/// 也刻意不经 `tauri-plugin-shell::open`（该 API 自 2.1 起已废弃），
/// 直接用已启用的 `Win32_UI_Shell` 绑定，行为完全自主可控。
#[cfg(target_os = "windows")]
fn launch_open(target: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    /// UTF-16 + NUL 结尾（Win32 宽字符约定）
    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
    }

    let operation = wide("open");
    let file = wide(target);
    // SAFETY: 两个 PCWSTR 均指向本函数内仍存活的 NUL 结尾宽字符串；
    // 其余参数为固定字面量（无 lpParameters / lpDirectory），无别名与生命周期问题。
    let handle = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };

    // ShellExecuteW 的约定：返回值 <= 32 表示失败（32 以上是成功实例句柄）
    let code = handle.0 as isize;
    if code <= 32 {
        return Err(format!("系统未能打开「{target}」（ShellExecute 代码 {code}）"));
    }
    Ok(())
}

/// 非 Windows 平台：明确报错，不静默失败。
#[cfg(not(target_os = "windows"))]
fn launch_open(target: &str) -> Result<(), String> {
    Err(format!("「{target}」的打开方式仅支持 Windows 系统"))
}

/// `ShellExecuteW` 失败后的**二级兜底**：绕过系统关联，直接用该类型的固定宿主程序。
///
/// # 为什么还需要这一层（V20 血泪）
///
/// 用户实测「网络连接」由 `os error 193` 变成了
/// `ShellExecute 代码 31`，代码 31 = `SE_ERR_NOASSOC`，意思是**注册表里 `.cpl`
/// 没有关联程序**（精简版系统、被优化工具清过关联、或第三方软件抢注后卸载残留，
/// 都会造成这种状态）。结论：**不能假设系统关联一定存在**。
///
/// 因此这里按扩展名硬走「一定有」的宿主：
///   - `.cpl`（控制面板小程序）→ `rundll32.exe shell32.dll,Control_RunDLL <cpl>`
///     （这正是 `.cpl` 的标准关联命令行，`ncpa.cpl` / `sysdm.cpl` / `mmsys.cpl` 通吃）；
///   - `.msc`（管理单元）→ `mmc.exe <msc>`（`mmc.exe` 是系统自带、一定存在）；
///   - 目录 → `explorer.exe <dir>`。
///
/// 返回 `None` = 该目标没有兜底路径（如 `ms-settings:` 协议），把原始错误抛回。
fn launch_fallback(target: &str) -> Option<Result<(), String>> {
    let lower = target.to_ascii_lowercase();
    if lower.ends_with(".cpl") {
        return Some(launch_spawn(
            &system32("rundll32.exe"),
            &[
                "shell32.dll,Control_RunDLL".to_string(),
                target.to_string(),
            ],
        ));
    }
    if lower.ends_with(".msc") {
        return Some(launch_spawn(&system32("mmc.exe"), &[target.to_string()]));
    }
    if std::path::Path::new(target).is_dir() {
        return Some(launch_spawn(&system32("explorer.exe"), &[target.to_string()]));
    }
    None
}

/// 执行一个快捷动作（`actionId` 必须在白名单内，否则报错）。
#[tauri::command]
pub async fn sys_action_run(action_id: String) -> Result<(), String> {
    let Some(entry) = table().into_iter().find(|item| item.id == action_id) else {
        return Err(format!("未知的快捷动作：{action_id}"));
    };
    if !cfg!(target_os = "windows") {
        return Err(format!("「{}」目前仅支持 Windows 系统", entry.name));
    }
    let name = entry.name;
    let outcome = match (entry.launch)() {
        // 先走系统关联（成功时体验最好：由正确的宿主承载）；
        // 关联缺失（代码 31）等失败情形再走二级兜底，保证「点了就能开」。
        Launch::Open(target) => match launch_open(&target) {
            Ok(()) => Ok(()),
            Err(primary) => match launch_fallback(&target) {
                Some(Ok(())) => Ok(()),
                Some(Err(secondary)) => {
                    Err(format!("{primary}；备用方式也未能打开：{secondary}"))
                }
                None => Err(primary),
            },
        },
        Launch::Spawn { program, args } => launch_spawn(&program, &args),
        Launch::Elevated { program, args } => launch_elevated(&program, &args),
    };
    outcome.map_err(|err| format!("{name}：{err}"))
}
