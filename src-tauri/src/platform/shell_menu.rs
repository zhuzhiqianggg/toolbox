//! Windows 原生 Shell 右键菜单（V43；V58 补保真度）。
//!
//! 用户 V43 原话：「你的格子把我图标原始的右键功能全部覆盖了，这个科学吗」。
//! 腾讯桌面整理的做法是：**格子里图标右键弹的就是系统原生菜单** —— 打开 / 打开方式 /
//! 发送到 / 剪切 / 复制 / 重命名 / 删除 / 属性，以及第三方 shell 扩展（Git、7-Zip、
//! 解压、杀毒扫描…）的项。自己仿一个仿不全，所以这里**直接调 Shell 的 `IContextMenu`**：
//!
//! 1. `SHCreateItemFromParsingName` → `IShellItem`（按路径拿 shell 对象）；
//! 2. `BindToHandler(BHID_SFUIObject)` → 该对象的 `IContextMenu`；
//! 3. `QueryContextMenu` 把菜单项填进一个新建的 popup menu；
//! 4. `TrackPopupMenuEx(TPM_RETURNCMD)` 弹出菜单并取回用户选中的命令 id；
//! 5. `InvokeCommand` 交回 Shell 执行（删除 / 复制 / 属性面板等由它自己完成）。
//!
//! **必须在有消息循环的线程上调用** —— `TrackPopupMenuEx` 自己跑模态消息循环，
//! 所以命令层用 `AppHandle::run_on_main_thread` 投递过来（见 `commands::grid::shell_context_menu`）。
//!
//! # V58 修的两个保真度缺陷（用户 09-21：「为什么我们的整理把桌面图标原始的右键行为改变了」）
//!
//! ## ① 菜单标志位
//!
//! V43 起一直传 `uFlags = 0`，而 Explorer 自己弹菜单传的是
//! `CMF_NORMAL | CMF_EXPLORE`（`CMF_CANRENAME` 视情况）。实测差异见 §测试；
//! 现在按 Explorer 的口径传。
//!
//! **刻意不传 `CMF_CANRENAME`**：Explorer 菜单里那条「重命名」**不是菜单命令**，而是
//! `DefView`（文件列表视图）自己实现的原位改名。我们这个宿主不是它的视图，传了
//! `CMF_CANRENAME` 只会让菜单长出一条**点了没反应**的项（甚至在看不见的列表上开一个
//! 隐藏编辑框）—— 那比"少一项"更坏。宁缺毋滥。
//!
//! ## ② 转发 `WM_INITMENUPOPUP` 等菜单消息（这条才是大头）
//!
//! Shell 与第三方扩展的**子菜单是懒加载**的：`QueryContextMenu` 时只放一个占位项，
//! 真正的内容在 `WM_INITMENUPOPUP` 里才补。原来的实现从不转发这个消息，于是
//! 实测（`cargo run --example menu_dump`）拿到的是：
//!
//! ```text
//! 发送到(&N)        └ 子菜单现有 1 项：蓝牙设备          ← 正常应有 压缩文件夹/邮件收件人/桌面快捷方式…
//! 包含到库中(&I)    └ 子菜单现有 1 项：正在检索库...      ← 占位文案直接露给用户看了
//! ```
//!
//! 修法是经典的 **窗口子类化**：菜单弹出期间把宿主窗口的 `WndProc` 换掉，
//! 拦住 `WM_INITMENUPOPUP` / `WM_DRAWITEM` / `WM_MEASUREITEM` / `WM_MENUCHAR`
//! 转给 `IContextMenu2::HandleMenuMsg` / `IContextMenu3::HandleMenuMsg2`，
//! 其余消息原样交回原 `WndProc`（我们只是旁听，不改宿主行为）。菜单收起即还原。
//!
//! # 测试
//!
//! `src-tauri/examples/menu_dump.rs`（诊断用，不参与发布）可以在**不弹菜单**的前提下
//! 枚举任意路径的菜单项与子菜单，用来对照 flags 差异：
//!
//! ```text
//! cargo run --release --example menu_dump -- "C:\某个\文件夹" 0x14
//! ```
//!
//! # 已知拿不到的项（不是本模块能修的）
//!
//! **360压缩**（`{9179176E-…}` / `360ZipExt64.dll`）只对**进程名是 `explorer.exe`** 的宿主
//! 生效：把同一个枚举工具复制成别的目录下的 `explorer.exe` 再跑，它的
//! 「用360压缩打开 / 解压到… / 解压到当前文件夹」四项立刻出现（40 项 → 45 项）。
//! 也就是说 `handy.exe` **不可能**通过 `IContextMenu` 拿到它 —— 换任何工具都一样。
//! 要真正拿到，只能让 explorer.exe 自己去弹菜单（本模块做不到，见 CONVENTIONS §31）。

use std::cell::RefCell;
use std::mem::size_of;
use std::path::Path;

use windows::core::{HSTRING, Interface, PCSTR, PWSTR, w};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    IContextMenu, IContextMenu2, IContextMenu3, IShellFolder, IShellItem,
    SHCreateItemFromParsingName, SHGetDesktopFolder, BHID_SFUIObject, CMINVOKECOMMANDINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CallWindowProcW, CreatePopupMenu, DefWindowProcW, DeleteMenu, DestroyMenu,
    GetAncestor, GetCursorPos, GetMenuItemCount, GetMenuStringW, GetWindowThreadProcessId,
    InsertMenuW, WindowFromPoint, GWLP_WNDPROC, GA_ROOT, HMENU, MF_BYPOSITION, MF_POPUP, MF_STRING,
    PostMessageW, SendMessageW, SetForegroundWindow, SetWindowLongPtrW, TPM_LEFTALIGN,
    TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenuEx, WM_CANCELMODE, WM_CONTEXTMENU, WM_DRAWITEM,
    WM_INITMENUPOPUP, WM_MEASUREITEM, WM_MENUCHAR, WM_NULL, WNDPROC,
};

/// 我们注入到「桌面背景」菜单里的「新建」子菜单命令 id。
///
/// Shell 的 `QueryContextMenu` 只占用 `1..=0x7FFF`，所以挑 `0x9000+` 这一档，**绝不会**
/// 和 Shell 自己的命令 id 撞车，也方便 `run_menu` 在 `TrackPopupMenuEx` 返回后一眼认出
/// 「这是我们的新建项，不用走 `InvokeCommand`」。
const CMD_NEW_FOLDER: u32 = 0x9001;
const CMD_NEW_TEXT: u32 = 0x9002;

/// `LVM_FIRST + 0x77`（comctl32 v6）。取消 ListView 的原位改名框。
///
/// V90：走「转发给 Explorer 桌面视图」这条路时，用户点原生「新建」后 Explorer 会在
/// **隐藏的** `SysListView32` 上拉起改名框 —— 看不见、还抢键盘。菜单收起后立刻用它取消，
/// 把「认领 + 改名」交回我们自己的前端（见 [`show_desktop_view_context_menu`]）。
const LVM_CANCELEDITLABEL: u32 = 0x1000 + 0x77;

/// 我们「新建」项被点中后产出的结果，回传前端让它增量认领 + 原地改名。
///
/// V89：不再用 `grid:item-created` 事件（那条路在菜单还没弹时就被 V88 的 30ms 竞速
/// 判定为「没新建」触发整层刷新）。改为**命令直接返回** `Option<CreatedItem>`：
/// 菜单收起后前端立刻拿到「建了什么」，建了就走增量路径、没建（普通菜单项）就走对账路径。
#[derive(Clone, serde::Serialize)]
pub struct CreatedItem {
    /// 新建项的完整路径（桌面用户目录 + 显示名）。
    pub path: String,
    /// 显示名（含扩展名，如 `新建文件夹`、`新建文本文档.txt`）。
    pub name: String,
}

/// RAII 守卫：构造时置「我们自己的菜单正在弹」为真，析构时复位。
///
/// 由 `run_menu` 在弹菜单前创建、随函数返回（含早退 / 出错）自动析构。它驱动
/// `crate::platform::desktop_handoff` 在菜单期间**禁止**把桌面借给系统 —— 否则就会出现
/// 「我们的菜单一弹，桌面瞬态翻白成原生样式」的观感（用户 10-08 报障）。这是「桌面永不翻白」
/// 的最后一道保险：即便事件 / 轮询误判出「桌面菜单」，也不会在我们自己菜单期间借出。
struct OwnMenuGuard;
impl OwnMenuGuard {
    fn new() -> Self {
        crate::platform::desktop_handoff::set_own_menu_active(true);
        OwnMenuGuard
    }
}
impl Drop for OwnMenuGuard {
    fn drop(&mut self) {
        crate::platform::desktop_handoff::set_own_menu_active(false);
    }
}

/// 桌面用户目录（新建项落地的目标）。复用 `dirs` crate（与 `grid.rs::desktop_root` 同口径）。
fn desktop_user_root() -> Option<std::path::PathBuf> {
    dirs::desktop_dir()
}

/// `CMF_NORMAL`：普通（非 Alt）调用，取值就是 0，写出来是为了语义清楚。
const CMF_NORMAL: u32 = 0x0000;
/// `CMF_EXPLORE`：告诉扩展「调用方是资源管理器」。Explorer 自己弹菜单一定带它。
const CMF_EXPLORE: u32 = 0x0004;
/// `CMF_EXTENDEDVERBS`：Shift + 右键的「扩展动词」（在此处打开 PowerShell 窗口 / 在新进程中打开…）。
const CMF_EXTENDEDVERBS: u32 = 0x0100;

/// 菜单弹出期间挂在宿主窗口上的上下文：原 `WndProc` + 可查询的 `IContextMenu2/3`。
///
/// 用 `thread_local` 而不是全局 `static`：`TrackPopupMenuEx` 是**同线程**模态循环，
/// 子类化窗口过程也一定在同一个线程里被调用，不需要 `Send`；而且 windows-rs 的
/// 接口对象不是 `Send`，放全局还得套锁。
struct MenuHook {
    old_proc: WNDPROC,
    menu2: Option<IContextMenu2>,
    menu3: Option<IContextMenu3>,
}

thread_local! {
    static MENU_HOOK: RefCell<Option<MenuHook>> = const { RefCell::new(None) };
}

/// 菜单期间替换宿主窗口过程：把菜单消息喂给 Shell 的 `IContextMenu2/3`，其余原样放行。
unsafe extern "system" fn menu_hook_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // 先把接口克隆出来、**立刻释放借用**：HandleMenuMsg 内部可能再抽消息（会重入到这里），
    // 持着 RefCell 借用去调外部代码 = 直接 panic。
    let (menu2, menu3, old_proc) = MENU_HOOK.with(|cell| {
        match cell.borrow().as_ref() {
            Some(hook) => (hook.menu2.clone(), hook.menu3.clone(), hook.old_proc),
            None => (None, None, None),
        }
    });

    match msg {
        WM_INITMENUPOPUP | WM_DRAWITEM | WM_MEASUREITEM => {
            // 这三条：转给 Shell（让它补项/量尺寸/画），**然后照常走宿主自己的处理**。
            if let Some(menu3) = menu3.as_ref() {
                let _ = menu3.HandleMenuMsg2(msg, wparam, lparam, None);
            } else if let Some(menu2) = menu2.as_ref() {
                let _ = menu2.HandleMenuMsg(msg, wparam, lparam);
            }
        }
        WM_MENUCHAR => {
            // 这条 Shell 要用**返回值**回话（选中项 / 动作），所以命中后必须自己 return，
            // 不能再落到宿主窗口过程去。
            if let Some(menu3) = menu3.as_ref() {
                let mut result = LRESULT(0);
                if menu3
                    .HandleMenuMsg2(msg, wparam, lparam, Some(&mut result))
                    .is_ok()
                {
                    return result;
                }
            }
        }
        _ => {}
    }

    if old_proc.is_some() {
        CallWindowProcW(old_proc, hwnd, msg, wparam, lparam)
    } else {
        // 理论上不会发生（没挂上钩时不会被调用）；真发生了也不能崩，退回默认处理。
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

/// 在**当前光标位置**弹出 `path` 对应的系统原生右键菜单。
///
/// 坐标不从前端传：菜单该出现在鼠标那儿，`GetCursorPos` 是最不会算错的做法
/// （前端的 client 坐标要经过窗口偏移 / DPI 换算，反而容易错位）。
///
/// `extended` = true 时补 `CMF_EXTENDEDVERBS`，即 Explorer 里 **Shift + 右键** 那个
/// 「扩展菜单」（多出「在此处打开 PowerShell 窗口」等项）——用户按了 Shift，就该给他
/// 原生的扩展菜单，而不是我们自己的菜单。
///
/// 返回 `Ok(None)` 只代表「菜单已经弹过并收回了」；用户在菜单里做了什么由 Shell 自己完成，
/// 我们不需要也不该插手（删除 / 复制 / 属性面板都不是我们的职责）。条目菜单不注入「新建」，
/// 所以这里永远返回 `Ok(None)`（后者供桌面背景菜单复用同一套 `run_menu` 后端）。
pub fn show_context_menu(hwnd: HWND, path: &str, extended: bool) -> Result<Option<CreatedItem>, String> {
    if path.trim().is_empty() {
        return Err("没有可操作的路径".to_string());
    }

    unsafe {
        // Tauri 主线程已初始化过 COM（APARTMENTTHREADED）；重复调用返回 S_FALSE，
        // 无害。**不要**在这里 CoUninitialize —— 那会把 Tauri 自己的 COM 一起关掉。
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let wide = HSTRING::from(path);
        let item: IShellItem = SHCreateItemFromParsingName(&wide, None)
            .map_err(|err| format!("拿不到 shell 对象：{err}"))?;
        let menu: IContextMenu = item
            .BindToHandler(None, &BHID_SFUIObject)
            .map_err(|err| format!("该对象没有右键菜单：{err}"))?;
        // 条目菜单不带「新建」（那是桌面背景菜单才有的能力）
        run_menu(hwnd, &menu, extended, false)
    }
}

/// 在**当前光标位置**弹出「桌面**背景**」的原生右键菜单（V87）。
///
/// # 为什么必须有这个（用户 10-08 的架构质疑）
///
/// 用户原话：「我们只是把桌面上的图标整理移动到整齐的位置上，你现在是直接把桌面完全
/// 改掉了呢？新建文件夹 / 新建文本文档等右键功能都不是原生的，问题很多」。
///
/// 之前（V81/V82/V84/V86）的做法是**借出**：右键时把被我们隐藏的 `SysListView32` 显示
/// 回来，让 Explorer 自己去弹菜单、自己去建文件，我们再收回。那是**补丁**——要赌
/// `#32768` 的语义（Win11 25H2 的新式菜单根本不是这个类名）、要等「安静 1.5s」、
/// 要 120s 超时兜底，而用户看到的仍然是「卡一下、要刷新、只有第一次成功」。
///
/// 正确的做法：**我们自己把那张菜单弹出来**。桌面空白右键的菜单不是「桌面的菜单」，
/// 是**桌面文件夹的背景菜单**，只有
/// `IShellFolder::CreateViewObject(IID_IContextMenu)` 给得出 —— `menu_dump` 那条
/// `BindToHandler(BHID_SFUIObject)` 的路拿到的是**条目**菜单（打开/复制/属性），
/// **压根没有「新建」**（实测见 `examples/bg_menu_dump.rs`：36 项里没有新建）。
///
/// 实测（A1 路线）这张菜单 16 项，含「新建(&W)」「下一个桌面背景」「显示设置」
/// 「个性化」，以及我们注入的「Handy 桌面整理」子菜单与全部第三方扩展。
///
/// # 一个必须说清的边界
///
/// 「查看 / 排序方式 / 刷新」**不在** `IContextMenu` 里 —— 那是 `DefView` 的
/// `IShellView` 视图菜单。所以这张菜单不给它们，需要时得由我们自己提供（见 V87-D）。
///
/// # V88：亲手把「新建」做成本地等价项（用户 10-08 报障）
///
/// 这张菜单的「新建」是 Shell 的 `CNewMenu`，它要靠 `IShellView` 才能定位目标目录并
/// 进入改名框 —— 而我们用 `CreateViewObject` 拿到的只是**没有真实 view 的** view-object
/// 菜单，所以用户点「新建 → 文件夹」时线上会报 `E_FAIL (0x80004005)`（见日志
/// `桌面背景菜单失败：执行菜单命令失败：未指定的错误`）。
///
/// 不跟 `IShellView` 死磕（那需要给一个真实宿主窗口、且在不同 Windows 版本上行为不稳定），
/// 而是**自己注入一个「新建」子菜单**：文件夹 / 文本文档。点下去时由我们在桌面用户目录
/// 里按 Windows 的命名规则（`新建文件夹` → `新建文件夹 (2)`…）建好**真实**目录 / 文件，
/// 并把 `CreatedItem` 作为命令返回值带回到前端（V89：不再是 `grid:item-created` 事件——那条路
/// 在菜单还没弹时就已被 30ms 竞速误判为「没新建」触发整层刷新）——前端据此增量认领并进入
/// 原地改名，结果和 Explorer 完全一致，且不依赖任何 Shell 视图黑盒。这同时消掉了
/// 「新建报错 / 卡 / 整体刷新」三个子投诉（V88），并把「桌面翻白」也一并根除（V89）。
pub fn show_background_context_menu(
    hwnd: HWND,
    extended: bool,
) -> Result<Option<CreatedItem>, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // 桌面**根** IShellFolder 自己就是桌面视图（`SHGetDesktopFolder()` 的返回值）。
        //
        // ⚠️ 别再走 `SHGetKnownFolderIDList(FOLDERID_Desktop)` + `BindToObject`：
        // FOLDERID_Desktop 的 PIDL **就是命名空间根本身**，拿它去 BindToObject 根
        // 必然报 `E_INVALIDARG (0x80070057)`（实测，见 bg_menu_dump 的第一次输出）。
        let root: IShellFolder =
            SHGetDesktopFolder().map_err(|err| format!("拿不到桌面 shell 文件夹：{err}"))?;
        let menu: IContextMenu = root
            .CreateViewObject(None)
            .map_err(|err| format!("桌面没有背景菜单：{err}"))?;
        run_menu(hwnd, &menu, extended, true)
    }
}

/// V90：把右键**转发给 Explorer 自己的桌面视图**，让它弹出它自己的完整原生菜单。
///
/// # 为什么必须转发（用户 10-08 23:01 的两张对比图）
///
/// 用户给了两张截图，质问「这是你搞得右键菜单，你到底能不能实现原始功能」：
///
///   · **退出接管后**右键 → Explorer 原生菜单：查看 / 排序方式 / 刷新 / 下一个桌面背景 /
///     撤销 删除 / **新建（14 项：文件夹、快捷方式、BMP 图像、DOC、DOCX、WPS PDF、
///     PPT、PPTX、WPS AI 生成 PPT、RTF、文本文档、XLS、XLSX、360压缩 ZIP）** /
///     显示设置 / 个性化 / 在终端预览中打开 / 显示更多选项；
///   · **接管态**右键 → 我们复刻的菜单：只有「新建文件夹 / 新建文本文档」两项，
///     连「查看 / 排序方式 / 刷新」都没有。
///
/// 这不是「没做」，是**接口边界**：那两块钱**根本不经过 `IContextMenu`**。
///   - 查看 / 排序方式 / 刷新 → `IShellView::GetItemObject(SVGIO_VIEWMENU)`（DefView 的视图菜单）；
///   - 完整的新建列表 → Shell 的 `CNewMenu`，按注册表 `ShellNew` 枚举 + 需要真实 `IShellView`
///     才能定位目标目录并拉起改名框。
/// 我们手上只有 `IShellFolder::CreateViewObject(IID_IContextMenu)` 给的那张**残缺**菜单，
/// 复刻永远追不平（第三方注册的自定义 ShellNew 处理器更没法枚举）。**所以不复刻了，转发。**
///
/// # 原理：DefView 一直活着，我们只是把它藏起来了
///
/// `SHELLDLL_DefView` / `SysListView32` 并没有消失 —— 接管只是 `SW_HIDE`。
/// 给它底下的 `SysListView32` 发一条 `WM_CONTEXTMENU`（约定：`wParam` = 发起窗口、
/// `lParam` = **屏幕坐标**），它会按 shell 约定转给父窗口 `SHELLDLL_DefView`，
/// DefView 再取 `SVGIO_BACKGROUND` 的 `IContextMenu` 弹菜单 —— **那条链上就有上面那两块**。
/// 而 `SysListView32` **始终隐藏**，桌面**不翻白**。
///
/// # 怎么知道菜单真弹出来了（V91：**禁止**用 `SendMessage` 耗时当判据）
///
/// V90 第一版拿「`SendMessage` 耗时 ≥ 150ms」当判据 —— **实测是错的**：
/// Win11 的桌面右键菜单由 Explorer 的 XAML 宿主在**另一个线程**弹出，
/// `SendMessage` 打完招呼就回来了（这台机器实测 37–48ms）。于是每次右键都被判成
/// 「没弹出 ⇒ 回退复刻菜单」，结果是**两个菜单同时挂在屏幕上**；而 Explorer 那个
/// 又因为我们的 `TrackPopupMenuEx` 抢了模态前台**收不回去** ——
/// 用户 10-08 23:30 的原话：「右键要出两个菜单，而且一个菜单好像还一直存在」。
///
/// 现在改成**直接观测屏幕**：菜单一定弹在鼠标点，于是「鼠标点下的顶层窗口」会从
/// 「桌面 / 我们自己这层挂件窗」变成「菜单窗口」。轮询等它变：
///   · 变了 ⇒ 真弹了，**不回退**（屏幕上只有一个菜单）；
///   · 超时仍没变 ⇒ 这台机器不吃这条转发，**才**回退复刻菜单（保底有菜单）。
///
/// # 为什么拆成两半（V91）
///
/// 「等菜单」要 sleep 几十秒（用户可能慢慢挑），**绝不能放在 Tauri 的 UI 线程上** ——
/// 纯 sleep 循环没有消息泵，整个前端会冻住。所以：
///   1. [`forward_desktop_view_menu`]：**UI 线程**里跑，只发消息，立刻返回现场；
///   2. [`await_desktop_view_menu`]：**后台线程**里跑，轮询等菜单出现 → 等收起。
pub fn forward_desktop_view_menu() -> Result<DesktopViewMenuState, String> {
    let list = crate::commands::grid::desktop_icon_view()
        .ok_or_else(|| "找不到桌面图标视图（SysListView32）".to_string())?;

    // 坐标口径与 `run_menu` 完全一致：不从前端传，直接用 `GetCursorPos`（屏幕物理像素，
    // 正是 `WM_CONTEXTMENU` 要的那种）——前端的 client 坐标要过窗口偏移 / DPI，反而容易错。
    let mut point = POINT::default();
    unsafe {
        if GetCursorPos(&mut point).is_err() {
            point = POINT { x: 0, y: 0 };
        }
    }
    // MAKELPARAM：低 16 位 = x，高 16 位 = y。
    let lp = (((point.y as u32 & 0xFFFF) << 16) | (point.x as u32 & 0xFFFF)) as isize;

    // 转发前：鼠标点下压着谁（桌面 / 我们自己这层挂件窗）。
    let before = root_window_at(point);

    let started = std::time::Instant::now();
    unsafe {
        let _ = SendMessageW(list, WM_CONTEXTMENU, WPARAM(list.0 as usize), LPARAM(lp));
    }
    let send_ms = started.elapsed().as_millis();
    crate::logging::write_line(
        "grid",
        &format!("桌面右键转发 Explorer 桌面视图：SendMessage(WM_CONTEXTMENU) 返回 {send_ms}ms（不阻塞）"),
    );

    Ok(DesktopViewMenuState {
        list: list.0 as isize,
        point,
        before,
    })
}

/// 转发时的现场，交给后台线程继续等（见 [`forward_desktop_view_menu`] 的说明）。
#[derive(Clone, Copy)]
pub struct DesktopViewMenuState {
    /// `SysListView32` 的句柄（存成 `isize` 才能跨线程）。
    list: isize,
    /// 右键时的屏幕坐标（菜单就弹在这儿）。
    point: POINT,
    /// 转发前压在鼠标点上的顶层窗口（用来判「菜单出现了 / 收起了」）。
    before: isize,
}

/// 后台线程：等菜单出现 → 等菜单收起。返回「原生菜单到底弹没弹」。
///
/// `false` = 这台机器不吃这条转发，调用方应当回退到复刻菜单。
pub fn await_desktop_view_menu(state: &DesktopViewMenuState) -> bool {
    let point = state.point;
    let list = HWND(state.list as *mut std::ffi::c_void);
    let me = std::process::id();

    // —— 等菜单出现 ——
    let mut popped = false;
    let mut after = 0isize;
    let wait = std::time::Instant::now();
    while wait.elapsed().as_millis() < MENU_APPEAR_TIMEOUT_MS {
        std::thread::sleep(std::time::Duration::from_millis(40));
        let now = root_window_at(point);
        // 「换了个人压在鼠标点上，而且不是我们自己」= 菜单弹出来了。
        if now != 0 && now != state.before && window_pid(now) != me {
            popped = true;
            after = now;
            break;
        }
    }
    if !popped {
        crate::logging::write_line(
            "grid",
            &format!(
                "桌面右键转发：等 {}ms 没等到菜单，回退复刻菜单",
                wait.elapsed().as_millis()
            ),
        );
        return false;
    }

    // —— 等菜单收起（用户点中某项 / 按 Esc / 点菜单外面）——
    //
    // 前端要等这个结果回到命令后才做对账（靠「菜单前后」的文件 diff 认领新增项）。
    // V90 错在**没等**：`SendMessage` 立刻返回 ⇒ 命令立刻 resolve ⇒ 前端在
    // **菜单还开着**时对账 ⇒ 必然 diff 不出东西 ⇒ 用户点「新建」建出来的文件
    // 永远进不了竖条、也不进改名。所以必须等到菜单从鼠标点消失（或超时）。
    //
    // 期间顺手**反复取消** Explorer 在隐藏 listview 上拉起的原位改名框：
    // 原生「新建」会建好真实文件、再让 `IShellView` 在 `SysListView32` 上拉一个
    // **原位改名框** —— 用户看不见它（listview 被我们 `SW_HIDE` 了），它还会
    // `SetFocus` **抢键盘**，我们 overlay 自己的改名输入框就再也打不进字。
    // 那个框是**菜单收起那一刻**才拉起的（之前不存在），所以只能在这里持续打点。
    // 用 `PostMessage`（不是 `SendMessage`）：投递完就走，不会因为 Explorer 忙而卡死。
    let close = std::time::Instant::now();
    while close.elapsed().as_millis() < MENU_CLOSE_TIMEOUT_MS {
        unsafe {
            let _ = PostMessageW(list, LVM_CANCELEDITLABEL, WPARAM(0), LPARAM(0));
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
        let now = root_window_at(point);
        // 鼠标点上不再是那个菜单窗口 ⇒ 菜单收起了（或换了别的窗口压着）。
        if now == 0 || now == state.before || window_pid(now) == me || now != after {
            break;
        }
    }
    let closed_ms = close.elapsed().as_millis();
    // 菜单刚收起，Explorer 还在落地（建文件 + 拉改名框）—— 给它一点时间再补一枪。
    std::thread::sleep(std::time::Duration::from_millis(250));
    unsafe {
        let _ = PostMessageW(list, LVM_CANCELEDITLABEL, WPARAM(0), LPARAM(0));
        let _ = PostMessageW(list, WM_CANCELMODE, WPARAM(0), LPARAM(0));
    }

    crate::logging::write_line(
        "grid",
        &format!(
            "桌面右键转发 Explorer 桌面视图：原生完整菜单已弹出（menu={after:#x}，含查看/排序/刷新 \
             + ShellNew 新建 14 项），{closed_ms}ms 后收起"
        ),
    );
    true
}

/// 等菜单**出现**的上限（毫秒）。XAML 宿主换线程弹出，实测几十毫秒内出现；
/// 给到 1000ms 是为了兼容机器忙 / 首次加载 XAML 的情况。超时即认定「这台机器不吃这条转发」。
const MENU_APPEAR_TIMEOUT_MS: u128 = 1000;

/// 等菜单**收起**的上限（毫秒）。用户在菜单里停留多久都算正常（可能去接杯水），
/// 但命令挂在 tokio 线程上，不能无限等 —— 60s 后放弃等待，按「菜单已收起」继续
/// （前端照常对账，只是可能晚一点认领到新建项）。
const MENU_CLOSE_TIMEOUT_MS: u128 = 60_000;

/// 取「屏幕坐标点下压着的**顶层**窗口」（0 = 什么都没压着）。
///
/// `WindowFromPoint` 可能返回子窗口（菜单的子级），`GetAncestor(GA_ROOT)` 归一化到顶层，
/// 免得「菜单弹出前后子窗口句柄抖动」把判据搅乱。
fn root_window_at(point: POINT) -> isize {
    unsafe {
        let hit = WindowFromPoint(point);
        if hit.0.is_null() {
            return 0;
        }
        let root = GetAncestor(hit, GA_ROOT);
        if root.0.is_null() {
            hit.0 as isize
        } else {
            root.0 as isize
        }
    }
}

/// 窗口所属进程 id（0 = 取不到）。
fn window_pid(hwnd: isize) -> u32 {
    let mut pid = 0u32;
    unsafe {
        let _ = GetWindowThreadProcessId(HWND(hwnd as *mut std::ffi::c_void), Some(&mut pid));
    }
    pid
}

/// V89：把 Shell 原生那个「新建」从菜单里**摘掉**，只留我们自己注入的那个。
///
/// # 为什么必须摘（用户 10-08「新建文件夹 / 文本文档都失效」的真凶）
///
/// 原生「新建」是 Shell 的 `CNewMenu`：它要靠 `IShellView` 定位目标目录并拉起改名框，
/// 而我们这张 `CreateViewObject` 出来的 view-object 菜单**没有真实 view**，点下去必然
/// `E_FAIL (0x80004005)` —— 日志里那两条
/// `桌面背景菜单失败：执行菜单命令失败：未指定的错误 (0x80004005)` 就是它。
///
/// V88 只做「注入」，于是菜单顶上出现**两个同名**「新建(&W)」：一个是我们那个一定成的，
/// 一个是原生那个必报错的。用户随手一点就有一半概率踩到后者 —— 看到的就是「新建失效」。
///
/// 所以 V89 改成「**先摘后插**」：名字里带「新建 / New」的顶层项一律删除，再插入我们的。
/// 菜单里于是只剩一个「新建」，点它一定在桌面目录里真的建出文件 / 目录。
///
/// 只动**顶层**：子菜单里的项不在这层，误删的代价远大于收益。
unsafe fn strip_native_new_menu(hmenu: HMENU) {
    let count = GetMenuItemCount(hmenu);
    if count <= 0 {
        return;
    }
    // 倒序遍历：`DeleteMenu(MF_BYPOSITION)` 会让后面的项前移，正序会漏掉（每删一个就跳一个）。
    for pos in (0..count).rev() {
        let mut buf = [0u16; 128];
        let len = GetMenuStringW(hmenu, pos as u32, Some(&mut buf), MF_BYPOSITION);
        if len <= 0 {
            continue;
        }
        let text = String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]);
        // 中文「新建(&W)」；英文「&New」/「New」。只认开头，避免误伤
        // 「下一个桌面背景 / Next desktop background」这类含 new 的其它项。
        let is_new = text.contains("新建")
            || text.starts_with("&New")
            || text.starts_with("New")
            || text.starts_with("&new");
        if !is_new {
            continue;
        }
        let _ = DeleteMenu(hmenu, pos as u32, MF_BYPOSITION);
        crate::logging::write_line(
            "grid",
            &format!("桌面背景菜单：摘掉原生「新建」项（第 {pos} 项，文本「{text}」）— 它在无 view 的菜单里必然 E_FAIL"),
        );
    }
}

/// 弹出一张**已经拿到手**的 `IContextMenu`（`show_context_menu` /
/// [`show_background_context_menu`] 的公共后端）。
///
/// 抽取出来是因为两条路的差别**只在怎么拿到 `IContextMenu`**，后面
/// 「cast 2/3 → 建菜单 → 填充 → 子类化 → 弹出 → 收尾 → 执行命令」完全一致，
/// 而且这段里有 `SetWindowLongPtrW` / `TrackPopupMenuEx` 这种**错一步就整套失效**
/// 的时序，绝不该抄两遍。
///
/// - `inject_new`：只有桌面背景菜单才注入「新建」子菜单（见 V88），条目菜单不注入。
///
/// 返回 `Ok(Some(CreatedItem))` 表示用户点了我们注入的「新建」项（已建好真实文件 / 目录，
/// 调用方拿去增量认领 + 原地改名）；`Ok(None)` 表示菜单正常收起但没新建（普通菜单项 / 取消）。
/// 不再用事件广播：命令直接把结果带回前端，彻底消掉 V88「菜单没弹就 30ms 竞速判没新建、
/// 触发整层刷新」的残留 bug。
fn run_menu(
    hwnd: HWND,
    menu: &IContextMenu,
    extended: bool,
    inject_new: bool,
) -> Result<Option<CreatedItem>, String> {
    // 菜单期间标记「我们自己的菜单在弹」，禁止 desktop_handoff 把桌面借给系统（V89）。
    let _guard = OwnMenuGuard::new();
    unsafe {
        // 我们注入的「新建」子菜单句柄（没有则不注入），teardown 时一并销毁。
        let mut new_sub: Option<windows::Win32::UI::WindowsAndMessaging::HMENU> = None;

        // 同一个对象上查 IContextMenu3 → IContextMenu2，目的是拿到 HandleMenuMsg(2)。
        // 拿不到也不致命：只是懒加载子菜单会缺项（V57 之前的行为）—— 但不许静默：
        // 用户报「发送到是空的」时，日志里得能看出是这一步没成。
        let menu3 = menu.cast::<IContextMenu3>().ok();
        let menu2 = menu.cast::<IContextMenu2>().ok();
        if menu3.is_none() && menu2.is_none() {
            crate::logging::write_line(
                "grid",
                "原生右键菜单：该对象不支持 IContextMenu2/3，懒加载子菜单会缺项",
            );
        }

        let hmenu = CreatePopupMenu().map_err(|err| format!("创建菜单失败：{err}"))?;

        let mut flags = CMF_NORMAL | CMF_EXPLORE;
        if extended {
            flags |= CMF_EXTENDEDVERBS;
        }

        // 1 起、0x7FFF 止：命令 id 由 Shell 填在这个区间里
        if let Err(err) = menu.QueryContextMenu(hmenu, 0, 1, 0x7FFF, flags) {
            let _ = DestroyMenu(hmenu);
            return Err(format!("填充菜单项失败：{err}"));
        }

        // —— V88：注入我们自己的「新建」子菜单（仅在桌面背景菜单）——
        // 原生「新建」依赖 IShellView，在我们这套 view-object 菜单里会 E_FAIL，所以亲手做。
        // 放在最顶上，和原生项区分开；命令 id 用 0x9000+ 档，绝不与 Shell 的 1..=0x7FFF 撞车。
        if inject_new {
            // —— V89：先摘掉原生那个必然 E_FAIL 的「新建」，再插我们自己的 ——
            // 否则菜单顶上会有两个同名「新建」，用户点中原生那个就报「未指定的错误」，
            // 观感就是「新建失效」（详见 strip_native_new_menu 的文档）。
            strip_native_new_menu(hmenu);
            match CreatePopupMenu() {
                Ok(sub) => {
                    let _ = AppendMenuW(
                        sub,
                        MF_STRING,
                        CMD_NEW_FOLDER as usize,
                        PWSTR(w!("新建文件夹").as_ptr() as *mut u16),
                    );
                    let _ = AppendMenuW(
                        sub,
                        MF_STRING,
                        CMD_NEW_TEXT as usize,
                        PWSTR(w!("新建文本文档").as_ptr() as *mut u16),
                    );
                    // 插到菜单顶部（位置 0）。MF_POPUP 的 uIDNewItem 是子菜单句柄本身。
                    let inserted = InsertMenuW(
                        hmenu,
                        0,
                        MF_BYPOSITION | MF_POPUP | MF_STRING,
                        sub.0 as usize,
                        PWSTR(w!("新建(&W)").as_ptr() as *mut u16),
                    );
                    if inserted.is_err() {
                        crate::logging::write_line(
                            "grid",
                            "桌面背景菜单：插入「新建」子菜单失败，本次菜单不会有可用新建项",
                        );
                    }
                    new_sub = Some(sub);
                }
                Err(err) => crate::logging::write_line(
                    "grid",
                    &format!("桌面背景菜单：注入「新建」子菜单失败：{err}"),
                ),
            }
        }

        // 挂子类化（菜单收起后必须还原，见下方 teardown）
        // 函数指针 → 整数要分两步（直接 as usize 会触发 clippy::function_casts_as_integer）
        let hook_addr = menu_hook_proc as *const () as usize as isize;
        let old_raw = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, hook_addr);
        if old_raw == 0 {
            // 换过程失败：不致命，退化成旧的「子菜单可能缺项」行为。
            // 但不许静默 —— 用户报「子菜单是空的」时，日志里得能看出是这一步没成。
            let _ = DestroyMenu(hmenu);
            crate::logging::write_line(
                "grid",
                "原生右键菜单：窗口子类化失败，子菜单可能缺项",
            );
        } else {
            MENU_HOOK.with(|cell| {
                *cell.borrow_mut() = Some(MenuHook {
                    old_proc: std::mem::transmute::<isize, WNDPROC>(old_raw),
                    menu2,
                    menu3,
                });
            });
        }

        let mut point = POINT::default();
        if GetCursorPos(&mut point).is_err() {
            point = POINT { x: 0, y: 0 };
        }

        // 菜单要能「点外面就消失」，前台窗口必须是我们要挂的那个
        let _ = SetForegroundWindow(hwnd);
        let picked = TrackPopupMenuEx(
            hmenu,
            // windows-0.58 把这里声明成裸 u32，位标志要显式取内层值
            (TPM_RETURNCMD | TPM_LEFTALIGN | TPM_RIGHTBUTTON).0,
            point.x,
            point.y,
            hwnd,
            None,
        );
        // 菜单关掉后补一条空消息：否则菜单可能「粘」在屏幕上不消失（Shell 经典坑）
        let _ = PostMessageW(hwnd, WM_NULL, WPARAM(0), LPARAM(0));

        // —— teardown：先摘钩子再还原窗口过程，顺序不能反 ——
        MENU_HOOK.with(|cell| {
            *cell.borrow_mut() = None;
        });
        if old_raw != 0 {
            let _ = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, old_raw);
        }
        let _ = DestroyMenu(hmenu);
        // 我们注入的子菜单也要销毁，避免句柄泄漏
        if let Some(sub) = new_sub {
            let _ = DestroyMenu(sub);
        }

        let cmd = picked.0;
        // 诊断留痕：用户再报「新建失效」时，一眼能看出他点的到底是哪个命令
        // （0 = 取消 / 0x9001 = 我们的新建文件夹 / 0x9002 = 我们的新建文本文档 / 其它 = 原生项）。
        crate::logging::write_line(
            "grid",
            &format!("桌面背景菜单已收起：命令 id={cmd:#x}（0=取消，0x9001/0x9002=我们的新建）"),
        );
        // —— V88/V89：我们自己的「新建」项，不走 InvokeCommand（那条路径对 view-object 菜单会 E_FAIL）——
        // 直接建真实文件 / 目录，把结果带回前端（V89 改为返回值而非事件，避免 30ms 竞速误判）。
        if (cmd as u32) == CMD_NEW_FOLDER {
            return Ok(create_new_item("folder"));
        }
        if (cmd as u32) == CMD_NEW_TEXT {
            return Ok(create_new_item("text"));
        }
        if cmd == 0 {
            // 用户点了菜单外面 / 按了 Esc
            return Ok(None);
        }

        // MAKEINTRESOURCEA：把命令 id 当成指针传（0 基）—— Shell 约定的做法
        let mut info = CMINVOKECOMMANDINFO::default();
        info.cbSize = size_of::<CMINVOKECOMMANDINFO>() as u32;
        info.hwnd = hwnd;
        info.lpVerb = PCSTR((cmd - 1) as usize as *const u8);
        info.nShow = 1; // SW_SHOWNORMAL
        menu.InvokeCommand(&info)
            .map_err(|err| format!("执行菜单命令失败：{err}"))?;
    }
    Ok(None)
}

/// 给「新建」项算一个不重名的名字（对齐 Explorer：`新建文件夹` → `新建文件夹 (2)` → …）。
///
/// `prefix` 是主名（如 `新建文件夹` / `新建文本文档`），`ext` 是扩展名（文件夹为空串、
/// 文本文档为 `.txt`）。返回的是**完整显示名**（含扩展名），调用方直接 `root.join(name)`。
fn unique_new_name(root: &Path, prefix: &str, ext: &str) -> String {
    let first = format!("{prefix}{ext}");
    if !root.join(&first).exists() {
        return first;
    }
    // 从 2 开始递增：Windows 的命名习惯是「新建文件夹」「新建文件夹 (2)」「新建文件夹 (3)」…
    let mut n = 2u32;
    loop {
        let candidate = format!("{prefix} ({n}){ext}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
        n = n.saturating_add(1);
        if n > 9999 {
            // 极端情况兜底：加时间戳后缀，保证一定不重名（理论不会走到）。
            return format!("{prefix}_{}.{ext}", now_ms_placeholder());
        }
    }
}

/// 占位时间戳（仅在 9999 个重名这种极端场景下用，正常路径用不到）。
fn now_ms_placeholder() -> u64 {
    // 不引时间库，直接用系统启动滴答近似即可（仅兜底命名，无精度要求）。
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// V88/V89：在我们的「新建」项被点中时，真的在桌面用户目录里建好对应文件 / 目录。
///
/// 这一步**完全等价于** Explorer 的「新建文件夹 / 新建文本文档」——落地的就是真实目录 /
/// 文件，原生桌面（未接管时）照常能看到；接管态下则进入未归类竖条（前端拿到返回值后认领）。
///
/// V89 起改为**返回值** `Option<CreatedItem>`（不再向前端广播 `grid:item-created` 事件）：
/// 命令层把 `Option<CreatedItem>` 直接带回前端，前端据此决定「增量认领 + 原地改名」还是
/// 「全量对账」，彻底消掉 V88 那套「事件 + 30ms 竞速」在菜单还没弹时就误判「没新建」、
/// 触发整层刷新的残留 bug。
fn create_new_item(kind: &str) -> Option<CreatedItem> {
    let root = match desktop_user_root() {
        Some(dir) => dir,
        None => {
            crate::logging::write_line("grid", "新建失败：定位不到桌面用户目录");
            return None;
        }
    };
    let (prefix, ext) = match kind {
        "folder" => ("新建文件夹", ""),
        "text" => ("新建文本文档", ".txt"),
        _ => {
            crate::logging::write_line("grid", &format!("新建失败：不支持的类型 {kind}"));
            return None;
        }
    };
    let name = unique_new_name(&root, prefix, ext);
    let path = root.join(&name);

    let ok = match kind {
        "folder" => std::fs::create_dir(&path).is_ok(),
        "text" => std::fs::write(&path, &[] as &[u8]).is_ok(),
        _ => false,
    };
    if !ok {
        crate::logging::write_line("grid", &format!("新建失败：无法创建 {path:?}"));
        return None;
    }

    crate::logging::write_line("grid", &format!("桌面新建成功：{path:?}"));
    Some(CreatedItem {
        path: path.to_string_lossy().to_string(),
        name,
    })
}
