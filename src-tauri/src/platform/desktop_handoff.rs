//! 系统菜单期间「把桌面暂时还给系统」（V81）。
//!
//! # 用户在 V81 报的两条（原话）
//!
//! > 1. 我在桌面右键新建文件夹非常慢而且也不能点击两下重命名操作，很早之前就说了
//! >    不要改变原始桌面每个图标 文件的默认右键行为，只添加我们自己的 handy 菜单就可以了。
//! > 2. 现在功能变成我创建了文本文件和文件夹完全没有生效了，右键新建文件夹或者文本文档
//! >    直页面刷新下什都不干了。
//!
//! # 根因：菜单是真的，它的**副作用**在隐藏的视图里
//!
//! 先排除一个误会 —— 桌面空白处右键**弹的就是 Explorer 的原生菜单**：那一层是
//! `pointer-events: none` + 整窗穿透，右键落到了下面的 `SysListView32` 上，由 Explorer
//! 自己弹（注册表里我们注入的 Handy 子菜单也在里面，见 `desktop_menu.rs`）。
//! 日志里那批「原生右键菜单失败（::{…}\Desktop）：参数错误」是我们**另一条**路径
//! （`shell_context_menu`）的失败记录，与用户在桌面上看到的菜单不是一回事。
//!
//! 于是「新建文件夹无效」不是菜单的问题，而是**接管态把 `SysListView32` 藏了**：
//!
//! | 原生菜单里点「新建文件夹」之后 | 接管态下 |
//! | --- | --- |
//! | Explorer 在桌面目录建目录 | ✅ 真的建了 |
//! | 在 `SysListView32` 里插入一个 item | ✅ 插了 —— 但视图是 `SW_HIDE`，**看不见** |
//! | 立刻进入**原位改名**（列表视图的编辑框） | ✅ 开了 —— 编辑框是那个隐藏视图的子窗，**看不见也点不到** |
//! | 用户看到的 | ❌ 「什么都没发生」 |
//!
//! 「慢」同理：菜单要按 Explorer 的正常流程走完，而它的宿主视图被我们藏了。
//!
//! # 修法：**不碰右键路由，只在菜单期间把桌面还回去**
//!
//! 这是本模块最重要的一条设计纪律 —— **一个字节都不改鼠标路由**。改路由（拦截右键
//! 再转发、或者为了「让菜单看见结果」去动 `ignore_cursor_events`）都会把「默认右键
//! 行为」变成我们自己实现的东西，那正是用户从 V43 起反复反对的。
//!
//! 所以这里只做**旁听**：用 `SetWinEventHook` 听系统的菜单弹出 / 收起事件，
//! 认出「这是桌面的菜单」之后：
//!
//! 1. 把 `SysListView32` 显示回来，同时把我们的挂件窗**临时**隐藏
//!    （否则原生图标会被半透明的格子层盖住，等于没还）；
//! 2. 菜单收起后**不立刻收回** —— 原生「新建」是在菜单关闭**之后**才进原位改名的，
//!    立刻收回会把编辑框一起藏掉，用户还是改不了名。所以一直等到
//!    `SysListView32` 上不再有 `Edit` 子窗（改名结束）为止；
//! 3. 收回：隐藏原生视图、显示挂件窗，并广播 `grid:desktop-changed` 让前端立刻重扫
//!    桌面（新建出来的文件要能出现在「未归类」里，否则用户还是以为没生效）。
//!
//! # 必须守住的三个边界
//!
//! - **只认桌面的菜单**：同一个 `explorer.exe` 里还开着资源管理器窗口，在它里面右键
//!   也会弹菜单。`is_desktop_menu` 用「与桌面视图同进程 **且** 顶层是 `Progman` /
//!   `WorkerW`（或 hwnd 就是桌面视图本身）」双重判据排除它 —— 误判的代价是我们的
//!   格子在用户浏览文件夹时自己消失，绝不能发生。
//! - **收回时以「当前是否仍接管」为准**：菜单里就有我们注入的「退出桌面整理」，
//!   用户点了它之后图标**必须**留着。所以收回前重新问一次 `icons_taken()`。
//! - **超时兜底**（[`MAX_HANDOFF_SECS`]）：事件不配对时最坏结果是桌面停在原生态，
//!   挂件窗不回来 —— 那是「死路」，必须有上限。
//!
//! # V82：V81 的判据失效了（用户 09-27 二次反馈）
//!
//! 用户原话：「**现在新建文件夹还是卡住的哇**」，并贴图指出「我的电脑都变成这样了」。
//!
//! 后一条是另一件事（系统入口的右键菜单被我们复刻的菜单接管，见 `GridOverlay`
//! 里那个 `onContextMenu` 的注释 —— 已经交回原生）。前一条的原因在日志里很直白：
//! 应用日志中**只有「系统菜单旁听已启动」、一条借出记录都没有** —— 事件要么根本没
//! 送到，要么参数没被 [`is_desktop_menu`] 认出来。
//!
//! 真相是后者：`EVENT_SYSTEM_MENUPOPUPSTART` 的 `hwnd` 在很多机器上给的是
//! **菜单窗 `#32768` 自己**（不是「菜单所属的窗口」）。而 V81 的判据只认
//! 「就是桌面视图 / 它的父」和「顶层是 `Progman` / `WorkerW`」—— 对 `#32768` 来说
//! 它的顶层就是它自己、类名也叫 `#32768`，两条**双双落空**，于是每一次桌面右键
//! 都在这里被静默判掉。
//!
//! 两处修正：
//!
//! 1. [`is_desktop_menu`] 重排判据，先换 `#32768` 的 **owner** 再认，并补上
//!    「同进程 + 前台不是别的应用」的兜底（宁松勿漏：漏判的代价是用户的「新建文件夹」
//!    永远没反应，误判的代价只是浏览文件夹时格子闪一下）；
//! 2. 除了事件，[`poll_menu`] 让 `commands::grid` 的保险轮询**每 25ms 直接问一次
//!    「`#32768` 在不在」** —— 不再把整套机制赌在一个语义含糊的事件参数上。
//!
//! 两条路并存，`begin_handoff` 自身幂等，谁先认出来谁先借出。
//!
//! # 不做什么
//!
//! 条目（桌面文件 / 文件夹）上的右键**暂不改动**：它走的是 `shell_context_menu`
//! （我们替 Shell 复刻的菜单），与本次报的「桌面右键」是两条路。要不要同样交回原生，
//! 由用户拍板 —— 那条路需要先把文件定位到 `SysListView32` 的对应 item，风险量级不同。

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
// 事件常量（`EVENT_SYSTEM_MENUPOPUP*` / `WINEVENT_*`）出自 winuser.h，
// windows-rs 把它们收在 `WindowsAndMessaging`，**不在** `Accessibility`。
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, FindWindowW, GetAncestor, GetClassNameW, GetForegroundWindow, GetMessageW,
    GetWindow, GetWindowRect, GetWindowThreadProcessId, ShowWindow, WindowFromPoint,
    EVENT_SYSTEM_MENUPOPUPEND, EVENT_SYSTEM_MENUPOPUPSTART, GA_PARENT, GA_ROOT, GW_OWNER, MSG,
    SW_HIDE, SW_SHOW, SW_SHOWNOACTIVATE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
};

use crate::commands::grid::{desktop_icon_view, icons_taken, GRID_LABEL};
use crate::logging::write_line;

/// 菜单收起后最多把桌面留在系统手里多久（秒）。
///
/// 「新建文件夹」之后用户要打字改名，这段时间**必须**留着；但事件万一不配对
/// （子菜单 / 第三方菜单不按规矩发 `MENUPOPUPEND`），挂件窗就会一直不回来
/// —— 那是用户找不到入口的死路，所以要有硬上限。
const MAX_HANDOFF_SECS: u64 = 120;

/// 菜单收起后、判定「真的结束了」之前要求桌面保持**安静**的时长。
///
/// # V84：为什么 200ms 的轮询会输掉这场竞速（用户 09-29 三次反馈「新建很慢/没反应」）
///
/// 原生「新建 → 文件夹」的时序是：菜单关闭**之后** Explorer 才在桌面目录建目录、
/// 再在视图里开原位改名编辑框 —— 中间隔着几百毫秒的 Shell 通知与视图更新。
/// 旧写法收回线程 200ms 一查：菜单刚收、编辑框还没影，`menu_open() ‖ label_editing()`
/// 双双为 false ⇒ 当场收回 ⇒ 编辑框连同整个视图被藏进隐藏层。
/// 用户看到的就是「点了新建文件夹，半天没反应」—— 文件其实建出来了，
/// 要等 15 秒一轮的对账把它塞进未归类竖条（还得自己找到）。
///
/// 现在要求「安静满 [`HANDOFF_QUIET_GRACE`]」**或**「已经见过编辑框且它结束了」
/// 才收回：前者兜住普通右键（最多晚 1.5 秒收回，无感）；后者让真正的
/// 「新建 + 改名」全程留在可见的原生视图里，回车改名结束立刻收回（不等宽限）。
const HANDOFF_QUIET_GRACE: Duration = Duration::from_millis(1500);

/// 已经起过监听线程（进程内只起一次）。
static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);
/// 监听线程用的 `AppHandle`（事件回调里拿不到参数，只能从全局取）。
static APP: OnceLock<AppHandle> = OnceLock::new();
/// 桌面菜单的嵌套深度（子菜单也会发 START / END）。
static MENU_DEPTH: AtomicI32 = AtomicI32::new(0);
/// 当前是否处于「已把桌面还给系统」的状态。
static HANDOFF: AtomicBool = AtomicBool::new(false);
/// 已经有一个「等改名结束」的后台线程在跑。
///
/// 轮询（[`poll_menu`]）每拍都会问一次「菜单还在吗」，没有这个闸门就会
/// 每 25ms spawn 一个线程 —— 菜单收起后几百个线程同时抢着收回桌面。
static TAKEBACK_PENDING: AtomicBool = AtomicBool::new(false);
/// 诊断用：未识别的菜单事件只记一条（V81 上线后日志里一条借出都没有，
/// 得先看清真实事件长什么样；但不能刷屏）。
static LOGGED_UNKNOWN_MENU: AtomicBool = AtomicBool::new(false);

/// 我们自己弹出的菜单（桌面背景右键菜单 / 新建菜单 / 条目原生菜单）是否正处于「弹出中」。
///
/// # V89：我们自己弹菜单期间，**禁止** `begin_handoff` / `poll_menu` 把桌面借给系统
///
/// 否则会出现「我们的菜单一弹，桌面瞬态翻白成原生样式」的观感（用户 10-08 报障）：
/// 我们注入的「新建」子菜单里还嵌着 Shell 的原生子菜单（`发送到` / `包含到库中`…），
/// 那些子菜单弹出时会发真正的 `EVENT_SYSTEM_MENUPOPUPSTART`(`#32768`)，一旦被
/// `is_desktop_menu` 认成桌面菜单，就会触发借出 → 原生图标视图 `SW_SHOW`、挂件窗 `SW_HIDE`
/// → 桌面整层回到原生样式。所以 `shell_menu::run_menu` 在弹菜单前用 [`OwnMenuGuard`]
/// 置本标志为真、菜单收起（含所有子菜单）后复位；本模块的两条借出入口看到它为真就直接让路。
static OWN_MENU_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 我们自己的菜单是否在弹（本模块决策读取，由 `shell_menu` 的 RAII guard 写入）。
pub fn own_menu_active() -> bool {
    OWN_MENU_ACTIVE.load(Ordering::SeqCst)
}

/// 由 `shell_menu` 的 RAII guard 调用：菜单开 = true，关 = false。
pub fn set_own_menu_active(v: bool) {
    OWN_MENU_ACTIVE.store(v, Ordering::SeqCst);
}

/// 桌面此刻是否被我们**主动**借给了系统（true = 菜单期间，原生视图正显示着）。
///
/// 给 `commands::grid` 的接管自愈用：它看到「原生图标露着 / 挂件窗不可见」就会当异常
/// 纠正，而借出期间这两件事**都是我们自己造成的** —— 不让路的话，刚还回去的桌面会被
/// 立刻抢回来，用户在菜单里新建的文件夹当场又不见了。
pub fn is_active() -> bool {
    HANDOFF.load(Ordering::SeqCst)
}

/// 起监听（幂等，进程内只起一次）。
///
/// 在 [`crate::commands::grid::show_overlay`] 里调：只有接管桌面之后，「菜单期间把桌面
/// 还回去」这件事才有意义（没接管时原生视图本来就是显示的）。
pub fn ensure_watcher(app: &AppHandle) {
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // 设不进去（理论上不会）就别起线程：没有 AppHandle 就没法收回挂件窗。
    if APP.set(app.clone()).is_err() {
        WATCHER_STARTED.store(false, Ordering::SeqCst);
        return;
    }
    thread::spawn(watch_thread);
    // V89：借出已停用，这条旁听只剩诊断价值（它不会再改变任何窗口状态）。
    write_line("grid", "系统菜单旁听已启动（V89 起仅作诊断，不再借出桌面）");
}

/// 监听线程：装好 `WinEventHook` 之后跑一个消息循环（`WINEVENT_OUTOFCONTEXT` 的回调
/// 是**投递到本线程**的，没有消息循环就永远收不到）。
fn watch_thread() {
    unsafe {
        let hook = SetWinEventHook(
            EVENT_SYSTEM_MENUPOPUPSTART,
            EVENT_SYSTEM_MENUPOPUPEND,
            windows::Win32::Foundation::HMODULE(std::ptr::null_mut()),
            Some(on_menu_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        if hook.0 as isize == 0 {
            write_line("grid", "系统菜单旁听启动失败：SetWinEventHook 返回空");
            WATCHER_STARTED.store(false, Ordering::SeqCst);
            return;
        }
        let mut msg = MSG::default();
        // 只有收到 WM_QUIT 才会退出；进程活着它就一直跑。
        while GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0).as_bool() {
            let _ = msg;
        }
        let _ = UnhookWinEvent(hook);
    }
}

/// 菜单弹出 / 收起回调（在系统投递的线程上跑，**不能做耗时的事**）。
unsafe extern "system" fn on_menu_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    // 不是桌面的菜单就不动 —— 资源管理器窗口里的右键绝不能把我们的格子弄没。
    if !is_desktop_menu(hwnd) {
        // 诊断（V82）：V81 上线后**一条借出记录都没有**，得先知道事件到底来没来、
        // 参数长什么样。只在第一次未识别时记一条，避免每弹一次菜单灌一行。
        if event == EVENT_SYSTEM_MENUPOPUPSTART
            && !LOGGED_UNKNOWN_MENU.swap(true, Ordering::SeqCst)
        {
            write_line(
                "grid",
                &format!(
                    "菜单事件未识别为桌面菜单（仅记这一次）：hwnd=0x{:X} class={} pid={} owner={} root={}",
                    hwnd.0 as usize,
                    class_name(hwnd),
                    pid_of(hwnd),
                    class_name(GetWindow(hwnd, GW_OWNER).unwrap_or_default()),
                    class_name(GetAncestor(hwnd, GA_ROOT)),
                ),
            );
        }
        return;
    }
    if event == EVENT_SYSTEM_MENUPOPUPSTART {
        if MENU_DEPTH.fetch_add(1, Ordering::SeqCst) == 0 {
            begin_handoff();
        }
    } else if event == EVENT_SYSTEM_MENUPOPUPEND {
        let before = MENU_DEPTH.fetch_sub(1, Ordering::SeqCst);
        if before <= 1 {
            MENU_DEPTH.store(0, Ordering::SeqCst);
            schedule_takeback();
        }
    }
}

/// V89：**借出机制整体停用**。
///
/// 接管态下的桌面右键（含真·桌面空白）已经全部由 Handy 自己弹菜单 —— 空白区右键先被
/// 根画布的 `onContextMenu` 兜住（`GridOverlay.tsx` 的整窗命中区让它不再穿透），
/// 菜单本身由 `shell_menu::show_background_context_menu` 弹出。于是 V81–V86 这套
/// 「菜单期间把桌面借给系统」再没有合法触发源，而它**唯一的可见后果**就是用户 10-08
/// 报的那个：「新建完桌面翻白成原生样式」。
///
/// 状态机与 [`is_active`] 全部保留（外部读到恒 `false`，接管自愈照常工作，不会退化成
/// 「自愈以为桌面被抢走了」），只是借出动作不再发生。
const HANDOFF_DISABLED: bool = true;

/// 菜单弹出来了 —— 把桌面还给系统。
fn begin_handoff() {
    // V89：借出机制已停用（见 [`HANDOFF_DISABLED`]）。
    if HANDOFF_DISABLED {
        return;
    }
    // 我们自己弹菜单期间，绝不把桌面借给系统（那会瞬态翻白成原生样式）。
    // 由 `shell_menu::OwnMenuGuard` 置位，菜单（含子菜单）全收起后复位。
    if own_menu_active() {
        return;
    }
    let Some(app) = APP.get() else {
        return;
    };
    if HANDOFF.swap(true, Ordering::SeqCst) {
        return;
    }
    // 没接管（原生视图本来就在显示）→ 什么都不用做，等收起时刷一次数据即可。
    if !icons_taken() {
        HANDOFF.store(false, Ordering::SeqCst);
        return;
    }
    let Some(list) = desktop_icon_view() else {
        HANDOFF.store(false, Ordering::SeqCst);
        return;
    };
    unsafe {
        // 挂件窗必须一起收起来：它压在原生视图上面，只是半透明，
        // 不收起的话「还回去的桌面」会被格子糊住，等于白还。
        if let Some(overlay) = overlay_hwnd(app) {
            let _ = ShowWindow(overlay, SW_HIDE);
        }
        let _ = ShowWindow(list, SW_SHOW);
    }
    write_line("grid", "系统菜单：桌面暂时还给系统（原生图标显示，用完自动收回）");
}

/// 菜单收起了 —— 等「原位改名」结束再把桌面收回来。
fn schedule_takeback() {
    if TAKEBACK_PENDING.swap(true, Ordering::SeqCst) {
        return; // 已经有一个在等了
    }
    let Some(app) = APP.get().cloned() else {
        TAKEBACK_PENDING.store(false, Ordering::SeqCst);
        return;
    };
    // 另起线程等：回调线程上不能睡（会拖住整个事件投递）。
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(MAX_HANDOFF_SECS);
        // V84：见 [`HANDOFF_QUIET_GRACE`] 的注释 —— 「菜单收了」≠「结束了」，
        // 必须等编辑框有机会出现；见过编辑框的话，它一结束立刻收回。
        let mut saw_edit = false;
        let mut quiet_since: Option<Instant> = None;
        loop {
            thread::sleep(Duration::from_millis(150));
            if Instant::now() >= deadline {
                break;
            }
            let menu = menu_open();
            let editing = label_editing();
            if editing {
                saw_edit = true;
            }
            if menu || editing {
                quiet_since = None;
                continue;
            }
            let since = quiet_since.get_or_insert_with(Instant::now);
            if saw_edit || since.elapsed() >= HANDOFF_QUIET_GRACE {
                break;
            }
        }
        end_handoff(&app);
        TAKEBACK_PENDING.store(false, Ordering::SeqCst);
    });
}

/// 接管态下每个保险 tick 调一次：**菜单的弹出 / 收起也用轮询兜一遍**。
///
/// # 为什么事件之外还要轮询（V82）
///
/// V81 只靠 `SetWinEventHook`，上线后用户实测「新建文件夹还是卡住」，而日志里
/// **只有「旁听已启动」、一条借出记录都没有** —— 事件要么没来，要么参数没被
/// [`is_desktop_menu`] 认出来。`EVENT_SYSTEM_MENUPOPUPSTART` 的 `hwnd` 到底是
/// 「菜单所属窗口」还是「`#32768` 菜单窗自己」，文档写得含糊，赌它不如换个直接观测量：
/// **系统菜单窗 `#32768` 此刻在不在**（它就是 Windows 所有弹出菜单的窗口类）。
///
/// 两条路并存：谁先认出来谁就借出，`begin_handoff` 自身幂等。
pub fn poll_menu() {
    // V89：借出机制已停用（见 [`HANDOFF_DISABLED`]），这里只是保留旁听，不再有任何动作。
    if HANDOFF_DISABLED {
        return;
    }
    // 我们自己弹菜单期间不借出桌面（避免瞬态翻白）。
    if own_menu_active() {
        return;
    }
    // 没接管的话，原生视图本来就在显示，借出没有意义。
    if !icons_taken() {
        return;
    }
    // V86：**编辑框是比菜单更硬的观测量**。
    //
    // 用户 09-30 三次报「新建还是慢 / 第一次行第二次没反应 / 要手动刷新」，日志里
    // **一条借出都没有** —— 这台机器是 Win11 25H2 且没有恢复经典菜单：桌面背景右键
    // 弹的是**新式菜单宿主窗口**，不是 `#32768`，上面的查找永远落空。
    // 但「新建 → 文件夹 / 文本文档」的终点是**原位改名编辑框**——它是
    // `SysListView32` 的 `Edit` 子窗，不管菜单长什么样都绕不过去。所以：
    // 编辑框一出现（哪怕视图还藏着）就借出，用户立刻看到原生桌面 + 改名框；
    // 收回交给下面 `else if` 那条路（菜单不在 + `HANDOFF` 在 → `schedule_takeback`，
    // 它会等编辑框结束再收回）。
    if !HANDOFF.load(Ordering::SeqCst) && label_editing() {
        write_line("grid", "桌面出现原位改名编辑框 → 把桌面还给系统（新建/重命名可见）");
        begin_handoff();
        return;
    }
    let menu = unsafe {
        FindWindowW(PCWSTR(wide("#32768").as_ptr()), PCWSTR::null()).unwrap_or_default()
    };
    let open = !menu.0.is_null() && unsafe { is_desktop_menu(menu) };
    if open {
        if !HANDOFF.load(Ordering::SeqCst) {
            write_line("grid", "轮询发现桌面右键菜单已弹出 → 把桌面暂时还给系统");
            begin_handoff();
        }
    } else if HANDOFF.load(Ordering::SeqCst) && !TAKEBACK_PENDING.load(Ordering::SeqCst) {
        schedule_takeback();
    }
}

/// 收回：隐藏原生视图、显示挂件窗、通知前端重扫桌面。
fn end_handoff(app: &AppHandle) {
    if HANDOFF.swap(false, Ordering::SeqCst) {
        if let Some(list) = desktop_icon_view() {
            unsafe {
                // ⚠️ 以「现在是否仍接管」为准：菜单里就有「退出桌面整理」，
                // 用户点了它之后图标必须留着 —— 这里再藏一次就变成「点了没反应」。
                if icons_taken() {
                    let _ = ShowWindow(list, SW_HIDE);
                }
            }
        }
        // SW_SHOWNOACTIVATE：收回时不抢焦点（用户可能正在改名 / 打字）
        if let Some(overlay) = overlay_hwnd(app) {
            unsafe {
                let _ = ShowWindow(overlay, SW_SHOWNOACTIVATE);
            }
        }
        write_line("grid", "系统菜单：桌面已收回");
    }
    // 无论有没有真的还过，菜单里可能新建 / 删了文件 —— 让前端立刻重扫一次。
    let _ = app.emit("grid:desktop-changed", ());
}

/// 挂件窗自身的 Win32 句柄。
fn overlay_hwnd(app: &AppHandle) -> Option<HWND> {
    app.get_webview_window(GRID_LABEL)
        .and_then(|w| w.hwnd().ok())
        .map(|h| HWND(h.0 as *mut std::ffi::c_void))
}

/// 还有菜单开着吗（`#32768` 是 Windows 菜单窗口的类名）。
fn menu_open() -> bool {
    unsafe {
        FindWindowW(PCWSTR(wide("#32768").as_ptr()), PCWSTR::null())
            .map(|h| !h.0.is_null())
            .unwrap_or(false)
    }
}

/// 桌面视图上正在原位改名吗（列表视图的改名编辑框是它的 `Edit` 子窗）。
///
/// 必须在收回前判这个：原生「新建」是**菜单关闭之后**才进改名的，
/// 收到 `MENUPOPUPEND` 就收回，会把刚弹出的编辑框一起藏掉。
fn label_editing() -> bool {
    let Some(list) = desktop_icon_view() else {
        return false;
    };
    unsafe {
        FindWindowExW(
            list,
            HWND(std::ptr::null_mut()),
            PCWSTR(wide("Edit").as_ptr()),
            PCWSTR::null(),
        )
        .map(|h| !h.0.is_null())
        .unwrap_or(false)
    }
}

/// 这个菜单是不是**桌面**的（不是资源管理器窗口里的）。
///
/// # V82：V81 的判据失效了
///
/// V81 只认「`hwnd` 就是桌面视图 / 它的父，或 `hwnd` 的顶层是 `Progman` / `WorkerW`」。
/// 用户 09-27 实测后日志里**一条借出记录都没有** —— 真实事件的 `hwnd` 不属于这两类。
/// 最可能的就是菜单窗 `#32768` 本身（它的顶层就是它自己，类名是 `#32768`，
/// 两个判据双双落空）。
///
/// 现在按「可信度从高到低」排，**任一条成立即认**：
///
/// 1. `hwnd`（或 `#32768` 的 owner）就是桌面视图 / 它的父 `DefView`；
/// 2. 同上的窗口，顶层是 `Progman` / `WorkerW`（桌面背景）；
/// 3. 与桌面视图**同进程**且顶层在桌面链上 —— 排除同一个 `explorer.exe` 里的
///    资源管理器窗口（它的顶层是 `CabinetWClass`）；
/// 4. 兜底：菜单弹出时**前台窗口是桌面背景**（`TrackPopupMenu` 的 owner 通常在前台）。
///
/// 第 4 条刻意偏「宽」。漏判的代价是用户的「新建文件夹」永远没反应（他们 09-27
/// 二次报的原话就是「还是卡住的」），误判的代价只是浏览文件夹时桌面格子闪一下
/// —— 两者不对称，所以宁松勿漏。
unsafe fn is_desktop_menu(hwnd: HWND) -> bool {
    if hwnd.0.is_null() {
        return false;
    }
    let Some(list) = desktop_icon_view() else {
        return false;
    };
    let def_view = GetAncestor(list, GA_PARENT);
    let mut list_pid = 0u32;
    GetWindowThreadProcessId(list, Some(&mut list_pid));
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));

    // 判据 1 / 2 共用的「这是不是桌面那扇窗」。
    let is_desktop_window = |w: HWND| -> bool {
        if w.0.is_null() {
            return false;
        }
        if w == list || (!def_view.0.is_null() && w == def_view) {
            return true;
        }
        let top = GetAncestor(w, GA_ROOT);
        if top.0.is_null() {
            return false;
        }
        let cls = class_name(top);
        cls == "Progman" || cls == "WorkerW"
    };

    if is_desktop_window(hwnd) {
        return true;
    }
    // 菜单窗自己认不出来 —— 换它的 owner 再认一遍（V82 的关键补丁）。
    let is_menu_win = class_name(hwnd) == "#32768";
    if is_menu_win {
        let owner = GetWindow(hwnd, GW_OWNER).unwrap_or_default();
        if is_desktop_window(owner) {
            return true;
        }
        // 判据 3（最直接的一条）：**看这个菜单压在谁身上**。
        //
        // 菜单是弹在右键位置上的，所以菜单左上角往外挪一格，就是用户当初点的那扇窗。
        // 这一条不依赖前台窗口是谁 —— 用户刚点过浏览器 / IDE 再回来右键桌面时，
        // 前台仍是那个应用，判据 5 / 6 都会落空，只有这条还能认出来。
        if let Some(under) = window_under_menu(hwnd) {
            if is_desktop_window(under) {
                return true;
            }
            // 压在别的**应用窗口**上 ⇒ 不是桌面菜单，直接否掉。
            // 菜单窗自己（子菜单 / 阴影偏移）和我们自己的挂件窗不算「别的应用」，
            // 那种情况不做判断、继续往下走。
            let cls = class_name(under);
            let is_other_app = !cls.is_empty()
                && cls != "#32768"
                && cls != "Progman"
                && cls != "WorkerW"
                && cls != "SHELLDLL_DefView"
                && !cls.starts_with("com.handy");
            if is_other_app {
                return false;
            }
        }
    }

    // 判据 3：同进程 + 顶层在桌面链上。
    if pid != 0 && pid == list_pid {
        let top = GetAncestor(hwnd, GA_ROOT);
        if !top.0.is_null() {
            let cls = class_name(top);
            if cls == "Progman" || cls == "WorkerW" || cls == "SHELLDLL_DefView" {
                return true;
            }
        }
    }

    let fg = GetForegroundWindow();
    let fg_cls = if fg.0.is_null() {
        String::new()
    } else {
        class_name(fg)
    };

    // 判据 4：兜底 —— 前台窗口就是桌面背景。
    if fg_cls == "Progman" || fg_cls == "WorkerW" || fg_cls == "SHELLDLL_DefView" {
        return true;
    }

    // 判据 5（V82 兜底中的兜底）：**它是 Shell 的菜单窗**，而且前台不是别的应用。
    //
    // 为什么这条也敢放：`#32768` 是 Win32 弹出菜单的窗口类，而 Handy 自己的菜单是
    // **HTML 画的**（根本没有 `#32768` 这种窗口）。所以能走到这里的菜单窗只可能来自
    // Shell。再要求「前台不是第三方应用的窗口」，就排掉了「用户在浏览器 / IDE 里
    // 右键」那种情形 —— 那时前台一定是那个应用的窗口。
    if is_menu_win && pid != 0 && pid == list_pid {
        let fg_is_other_app = !fg_cls.is_empty()
            && fg_cls != "Progman"
            && fg_cls != "WorkerW"
            && fg_cls != "SHELLDLL_DefView"
            && fg_cls != "#32768"
            && !fg_cls.starts_with("com.handy");
        if !fg_is_other_app {
            return true;
        }
    }

    false
}

/// 窗口所属进程 id（诊断日志用）。
fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

/// 这个菜单窗口「压在谁身上」—— 菜单左上角往外挪一格，问那儿是哪个窗口。
///
/// 菜单是弹在右键位置上的，所以那个点上的窗口就是用户当初点的那扇。这条判据
/// **不依赖前台窗口是谁**：用户刚点过浏览器 / IDE 再回来右键桌面时，前台仍是那个
/// 应用，别的判据全都落空，只有这条还能认出来。
///
/// 贴着屏幕左上角的菜单取不到外侧点，这时退回菜单自己的右下角外侧。
/// 返回 `None` 表示连菜单矩形都拿不到（不做判断，交回其它判据）。
unsafe fn window_under_menu(menu: HWND) -> Option<HWND> {
    let mut rect = RECT::default();
    if GetWindowRect(menu, &mut rect).is_err() {
        return None;
    }
    let mut pt = POINT {
        x: rect.left - 1,
        y: rect.top - 1,
    };
    if pt.x < 0 || pt.y < 0 {
        pt = POINT {
            x: rect.right + 1,
            y: rect.bottom + 1,
        };
    }
    let under = WindowFromPoint(pt);
    if under.0.is_null() {
        None
    } else {
        Some(under)
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 让 `LPARAM` / `WPARAM` 的导入在本文件里不悬空（消息循环里用到它们的类型）。
#[allow(dead_code)]
fn _assert_msg_types(_: MSG) -> (WPARAM, LPARAM) {
    (WPARAM(0), LPARAM(0))
}
