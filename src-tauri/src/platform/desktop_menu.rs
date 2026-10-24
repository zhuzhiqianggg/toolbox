//! 桌面背景右键菜单入口（V45 立项，V60 扩成**分组子菜单**）。
//!
//! # 为什么加这个
//!
//! 用户 09-19 发来一张腾讯桌面整理的截图：它在「桌面空白处右键」的菜单里加了一项
//! ——「开启桌面整理」—— 问我们是不是也该借鉴。答案是该借：**桌面右键是用户在桌面上
//! 最自然的第一反射**，比让用户去托盘里翻菜单顺手得多。
//!
//! V60 用户又发来一张截图，这次是腾讯那条子菜单**全部展开**的样子（新建格子 / 打开云文件 /
//! 一键桌面整理 / 备份布局 / 还原布局 / 退出桌面整理…），原话：「**鼠标右键可以借鉴腾讯
//! 桌面整理的功能**」。于是这里从「孤零零一项」扩成一组**分组子菜单**。
//!
//! # 怎么实现
//!
//! 走 **HKCU 注册表**（不需要管理员权限，卸载时整键删除，不留残留）：
//!
//! ```text
//! HKCU\Software\Classes\DesktopBackground\Shell\HandyDesktopGrid
//!     MUIVerb     = "Handy 桌面整理"
//!     Icon        = "<handy.exe 全路径>",0
//!     SubCommands = ""                            ← 存在且为空 = 用下面的 shell 子键
//!     \shell
//!         \{GUID-1}   MUIVerb = "打开 Handy 桌面整理" / command = "<exe>" --show-grid
//!         \{GUID-2}   MUIVerb = "新建格子"            / command = "<exe>" --new-box
//!         ...
//! ```
//!
//! `DesktopBackground\Shell` 正是「桌面空白处右键」的注册位置（`Directory\Background`
//! 是文件夹内的空白处，两者不是一回事）。
//!
//! ## ⚠️ 三个必须守住的细节（写错了都不会报错，只会「菜单不出现」）
//!
//! 1. **子键名必须是 GUID 形状**（形如 `{6F3D2A10-9E4B-4C88-A5D1-000000000001}`）。
//!    Microsoft 的《How to Implement Cascading Menus with the SubCommands Registry Entry》
//!    明确要求；写成 `HandyNewBox` 这种可读名字，在某些 Windows 版本上整条子菜单
//!    **静默消失**。所以键名是 [`SUB_ITEMS`] 里的常量，不是随手取的名字。
//! 2. **`SubCommands` 必须是「存在但为空」的 `REG_SZ`**，不能删掉这个值。
//!    删掉的话 Explorer 会退回「单命令」模式去找 `command` 子键 —— 找不到就什么都不显示。
//! 3. **旧版的 `command` 子键必须先删掉**：V45 装的是单命令版（顶层项直接挂 `command`），
//!    两者同时存在时行为未定义。升级路径上这一步不能省。
//!
//! # 点击之后发生什么
//!
//! 每个子项都是一条 `<handy.exe> --xxx`：
//!   - Handy **没在跑** → 正常启动，`lib.rs` 的 setup 读参数 → 直接把动作做掉、不弹主窗口；
//!   - Handy **正在跑**（更常见）→ 被单实例插件拦下，回调里走同一套 `handle_cli_args`。
//!
//! 两条路径共用 [`crate::handle_cli_args`]，**加菜单项时只需改 [`SUB_ITEMS`] 一处**。
//!
//! # 为什么用 `reg.exe` 而不是 windows crate 的 Registry API
//!
//! 这些键的增删是一次性动作（不是热路径），`reg.exe` 语义直白、失败信息可读，
//! 而且不必为它打开新的 windows crate feature（构建体积与编译时间的实际成本）。
//! 调用时带 `CREATE_NO_WINDOW`，不会闪黑框。

/// 菜单项在注册表里的键路径（`HKCU` 下，无需管理员权限）。
const MENU_KEY: &str = r"Software\Classes\DesktopBackground\Shell\HandyDesktopGrid";
/// 顶级项（就是那个带 ▸ 的）显示的文字
const MENU_LABEL: &str = "Handy 桌面整理";

/// 子菜单项：`(注册表键名（必须 GUID 形状）, 菜单文字, 命令行参数, 是否在它之前画分隔线)`。
///
/// 增删改菜单**只改这一张表** —— 注册表写入与 `lib.rs` 的参数分派都由它驱动。
///
/// 分组口径对齐腾讯桌面整理那张截图：能新建的东西在前、重活（整理 / 布局）居中、
/// 开关与出口在后。我们**不做云盘 / 个人中心 / 检查更新**那些项：产品里没有对应能力，
/// 放上去就是假按钮（宁缺毋滥，见 `shell_menu.rs` 开头同一条纪律）。
///
/// 同一条纪律也砍掉过一个我们**自己先写上、后来又删掉**的项：「显示 / 隐藏便签」。
/// V48 起便签就是 `kind='note'` 的格子，产品里根本没有「便签显隐」这个开关 ——
/// 为它现造一个状态，会撞上这个模块最贵的一课（`grid.rs` 文件头）：用户对
/// 「东西自己不见了、还找不到规律」的容忍度是零。菜单项必须指向**已经存在**的能力。
const SUB_ITEMS: &[(&str, &str, &str, bool)] = &[
    (
        "{6F3D2A10-9E4B-4C88-A5D1-000000000001}",
        "打开 Handy 桌面整理",
        "--show-grid",
        false,
    ),
    (
        "{6F3D2A10-9E4B-4C88-A5D1-000000000002}",
        "新建格子",
        "--new-box",
        true,
    ),
    (
        "{6F3D2A10-9E4B-4C88-A5D1-000000000003}",
        "新建便签",
        "--new-note",
        false,
    ),
    (
        "{6F3D2A10-9E4B-4C88-A5D1-000000000004}",
        "一键桌面整理",
        "--arrange",
        true,
    ),
    (
        "{6F3D2A10-9E4B-4C88-A5D1-000000000006}",
        "备份布局",
        "--save-layout",
        true,
    ),
    (
        "{6F3D2A10-9E4B-4C88-A5D1-000000000007}",
        "还原布局",
        "--restore-layout",
        false,
    ),
    (
        "{6F3D2A10-9E4B-4C88-A5D1-000000000008}",
        "设置中心",
        "--open-settings",
        true,
    ),
    (
        "{6F3D2A10-9E4B-4C88-A5D1-000000000009}",
        "退出桌面整理",
        "--hide-grid",
        false,
    ),
];

/// `CommandFlags` 里「在本项之前画一条分隔线」的位（`EPCF_SEPARATORBEFORE`）。
///
/// 写错这个值的后果很轻（顶多不画线，或把某项变成加粗的默认项），所以没有做防御；
/// 但如果哪天发现菜单里多了一条加粗项，先回来查这个数。
const EPCF_SEPARATOR_BEFORE: &str = "32";

/// 菜单结构的版本号 —— **改了 [`SUB_ITEMS`] 或 [`MENU_LABEL`] 就要 +1**。
///
/// 这是升级路径上唯一的开关，不能省：`grid::ensure_desktop_menu` 每次启动都先问
/// [`status()`]，而旧版 `status()` 只看「顶层键在不在」。老用户注册表里已经躺着
/// V45 那个**单命令版**的键，于是 `status()` 永远返回 true、`install()` 永远不被调用
/// —— 新加的子菜单项**一辈子也推不到老用户机器上**，而他们只会在截图里看到别人的菜单。
///
/// 于是 `status()` 的语义收紧为「装的正是当前这一版」：注册表里写一个 `Version` 值，
/// 只有与它相等才算已装。版本对不上 → 判定未装 → 启动时自动重建。
const MENU_VERSION: &str = "60";
/// 存版本号的注册表值名
const VERSION_VALUE: &str = "Version";

/// 菜单项是否**已按当前版本**装好（见 [`MENU_VERSION`]）。
#[cfg(target_os = "windows")]
pub fn status() -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let out = Command::new("reg")
        .args([
            "query",
            &format!("HKCU\\{MENU_KEY}"),
            "/v",
            VERSION_VALUE,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|err| format!("调用 reg.exe 失败：{err}"))?;
    // 键不存在 / 值不存在（老版本装过）→ reg 返回非 0，两种都算「未装」，于是会自动重建。
    if !out.status.success() {
        return Ok(false);
    }
    // 输出形如：`    Version    REG_SZ    60`，取行尾那个 token。
    // 解析不出来时**返回 false**（= 需要重装）—— 这个方向是自愈的；
    // 反过来返回 true 会让菜单永远停在坏状态（CONVENTIONS 的「解析为空即 FAIL」纪律）。
    let stdout = String::from_utf8_lossy(&out.stdout);
    let found = stdout
        .lines()
        .find(|line| line.contains(VERSION_VALUE))
        .and_then(|line| line.split_whitespace().last())
        .unwrap_or("");
    Ok(found == MENU_VERSION)
}

/// 写入菜单项（幂等：重复调用只是重新覆盖一遍）。
///
/// 每次启动都会走一遍（见 `grid::ensure_desktop_menu`），所以**加项 / 改名 / 改参数
/// 在新版装好后自动生效**，不需要用户手动做什么。
///
/// ⚠️ 开头是**整键删除再重建**，不是「就地覆盖」。因为 `install()` 只会写、不会删：
/// 一旦 [`SUB_ITEMS`] 里去掉过某一项（V60 就去掉了曾写上的「显示 / 隐藏便签」），
/// 老用户注册表里那一项会留下来，指向一个已经没人处理的参数 —— 一个点不动的假按钮。
/// 重建才能保证注册表**恰好等于** [`SUB_ITEMS`]，这也是「只改这一张表」这句承诺的前提。
#[cfg(target_os = "windows")]
pub fn install() -> Result<(), String> {
    let exe = current_exe_string()?;

    // 先清空（键不存在时 reg 返回非 0，**故意忽略** —— 「本来就没有」正是想要的结果）。
    let _ = run_reg(&["delete", &format!("HKCU\\{MENU_KEY}"), "/f"]);

    // —— 顶层项：MUIVerb + Icon + SubCommands(空) ——
    run_reg(&[
        "add",
        &format!("HKCU\\{MENU_KEY}"),
        "/v",
        "MUIVerb",
        "/d",
        MENU_LABEL,
        "/f",
    ])?;
    run_reg(&[
        "add",
        &format!("HKCU\\{MENU_KEY}"),
        "/v",
        "Icon",
        "/d",
        &format!("\"{exe}\",0"),
        "/f",
    ])?;
    // ⚠️ 空串是**语义的一部分**（见文件头细节 ②），别删这一行、也别改成别的值。
    run_reg(&[
        "add",
        &format!("HKCU\\{MENU_KEY}"),
        "/v",
        "SubCommands",
        "/t",
        "REG_SZ",
        "/d",
        "",
        "/f",
    ])?;

    // —— 子项 ——
    for (guid, label, flag, separator_before) in SUB_ITEMS {
        let item = format!("HKCU\\{MENU_KEY}\\shell\\{guid}");
        run_reg(&["add", &item, "/v", "MUIVerb", "/d", label, "/f"])?;
        if *separator_before {
            run_reg(&[
                "add",
                &item,
                "/v",
                "CommandFlags",
                "/t",
                "REG_DWORD",
                "/d",
                EPCF_SEPARATOR_BEFORE,
                "/f",
            ])?;
        }
        run_reg(&[
            "add",
            &format!("{item}\\command"),
            "/ve",
            "/d",
            &format!("\"{exe}\" {flag}"),
            "/f",
        ])?;
    }
    // ⚠️ 版本号**最后**写：中途失败（比如 reg.exe 被杀）时它就不在，下次启动会重建。
    // 写在前面的坏处是「半成品菜单被标成已完成」，那才是最难查的一种坏。
    run_reg(&[
        "add",
        &format!("HKCU\\{MENU_KEY}"),
        "/v",
        VERSION_VALUE,
        "/t",
        "REG_SZ",
        "/d",
        MENU_VERSION,
        "/f",
    ])?;
    Ok(())
}

/// 删除菜单项（不存在时也当成功 —— 用户点「关闭」的意图已经达成）。
#[cfg(target_os = "windows")]
pub fn remove() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let _ = Command::new("reg")
        .args(["delete", &format!("HKCU\\{MENU_KEY}"), "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|err| format!("调用 reg.exe 失败：{err}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn current_exe_string() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|err| format!("取当前程序路径失败：{err}"))
}

#[cfg(target_os = "windows")]
fn run_reg(args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let out = Command::new("reg")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|err| format!("调用 reg.exe 失败：{err}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if detail.is_empty() {
            "reg.exe 执行失败".to_string()
        } else {
            detail
        })
    }
}

// —— macOS：暂不提供（Finder 的「服务」菜单是另一套机制，后续按需适配） ——

#[cfg(target_os = "macos")]
pub fn status() -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "macos")]
pub fn install() -> Result<(), String> {
    Err("当前平台的桌面右键菜单入口尚未实现".to_string())
}

#[cfg(target_os = "macos")]
pub fn remove() -> Result<(), String> {
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// 子键名必须是 GUID 形状 —— 这不是洁癖，是 Explorer 的硬要求：
    /// 非 GUID 名字会让**整条子菜单静默消失**（见文件头细节 ①）。
    ///
    /// 这条守得住一个具体的翻车方式：将来有人往 [`SUB_ITEMS`] 里加项时顺手写了个
    /// `"HandyNewBox"`，编译器、类型检查、其它单测全都不会响。
    #[test]
    fn sub_item_keys_are_guid_shaped() {
        for (guid, _, _, _) in SUB_ITEMS {
            assert!(
                guid.starts_with('{') && guid.ends_with('}'),
                "子键名必须是 {{...}} 形状，实际：{guid}"
            );
            let body = &guid[1..guid.len() - 1];
            assert_eq!(body.len(), 36, "GUID 正文必须是 36 个字符（8-4-4-4-12）：{guid}");
            assert_eq!(
                body.matches('-').count(),
                4,
                "GUID 必须恰好有 4 个连字符：{guid}"
            );
            assert!(
                body.chars()
                    .all(|c| c.is_ascii_hexdigit() || c == '-'),
                "GUID 只能含十六进制字符与连字符：{guid}"
            );
        }
        let uniq: BTreeSet<&str> = SUB_ITEMS.iter().map(|(g, _, _, _)| *g).collect();
        assert_eq!(uniq.len(), SUB_ITEMS.len(), "子键名不许重复（后面的会覆盖前面的）");
    }

    /// 参数不许重复 —— 两个菜单项挂同一个参数，等于有一项永远点不出想要的效果。
    #[test]
    fn sub_item_flags_are_unique_and_prefixed() {
        for (_, label, flag, _) in SUB_ITEMS {
            assert!(
                flag.starts_with("--"),
                "菜单项「{label}」的参数必须是 --xxx 形状：{flag}"
            );
            // 参数最终会拼进 `"<exe>" --xxx` 写进注册表。含空格 / 引号会把它拆成多个参数，
            // 而 `handle_cli_args` 是**逐个参数精确比对**的 —— 那样这项就静默失效了。
            assert!(
                !flag.contains(' ') && !flag.contains('"'),
                "菜单项「{label}」的参数不许含空格或引号：{flag}"
            );
        }
        let uniq: BTreeSet<&str> = SUB_ITEMS.iter().map(|(_, _, f, _)| *f).collect();
        assert_eq!(uniq.len(), SUB_ITEMS.len(), "菜单参数不许重复");
    }

    /// 分隔线不该是**第一项**的（画在菜单顶上只会多一条突兀的横线）。
    #[test]
    fn first_sub_item_has_no_separator() {
        assert!(
            !SUB_ITEMS[0].3,
            "第一项之前不该画分隔线（菜单顶部不需要横线）"
        );
    }

    /// 版本标记必须是有内容的 —— 空版本号会让 [`status()`] 把任何旧安装都判成「已是最新」，
    /// 等于把升级路径重新堵死（那正是加这个常量的原因）。
    #[test]
    fn version_marker_is_present_and_numeric() {
        assert!(!MENU_VERSION.is_empty(), "菜单版本号不能为空");
        assert!(
            MENU_VERSION.chars().all(|c| c.is_ascii_digit()),
            "菜单版本号只用数字，避免 reg.exe 命令行转义问题：{MENU_VERSION}"
        );
        assert!(!VERSION_VALUE.is_empty(), "版本值的名字不能为空");
    }

    /// 菜单内容的**守门测试**：改动 [`SUB_ITEMS`] 必须是有意识的，并且连带做完这几件事。
    ///
    /// 它挡的是一类编译器和类型检查都不会吭声的错：菜单里写了 `--xxx`，而
    /// `lib.rs::handle_cli_args` 里没人处理这个参数 —— 用户点了菜单，什么都没发生；
    /// 或者反过来，参数在代码里删了、菜单项留在注册表里，同样是个死按钮。
    ///
    /// 断言失败时按这个顺序改：
    ///   ① `lib.rs::handle_cli_args` 加/删对应分支（前端动作还要在 `GridOverlay` 里处理
    ///      `handy://desktop-action`）；
    ///   ② 下面的期望表；
    ///   ③ [`MENU_VERSION`] 加一（否则老用户机器上的菜单不会更新）。
    #[test]
    fn menu_items_are_the_expected_set() {
        let flags: Vec<&str> = SUB_ITEMS.iter().map(|(_, _, flag, _)| *flag).collect();
        assert_eq!(
            flags,
            vec![
                "--show-grid",
                "--new-box",
                "--new-note",
                "--arrange",
                "--save-layout",
                "--restore-layout",
                "--open-settings",
                "--hide-grid",
            ],
            "菜单项变了：确认 lib.rs 都处理了，再同步这张期望表并把 MENU_VERSION 加一"
        );
    }
}
