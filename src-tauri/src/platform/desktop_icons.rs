//! 桌面图标显隐自愈（Windows）。
//!
//! 前身（toolbox）曾以「隐藏系统桌面图标 + 自绘覆盖层」方式接管桌面。Toolbox 已彻底
//! 移除该机制，本模块只在启动时兜底：若用户机器上残留「图标被隐藏」的旧状态
//! （例如旧版本进程被强杀、没走到还图标的退出分支），无条件恢复显示。

use windows::core::w;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, FindWindowExW, FindWindowW, GetClassNameW, ShowWindow, SW_SHOW,
};

/// 找到桌面图标 ListView（Progman 或 WorkerW 下的 `SysListView32`）并恢复显示。
///
/// 经典层级：`Progman → SHELLDLL_DefView → SysListView32`；壁纸软件切换壁纸后
/// `SHELLDLL_DefView` 可能被挪到某个顶层 `WorkerW` 下，两种都找。
pub fn restore_desktop_icons() {
    unsafe {
        let Ok(progman) = FindWindowW(w!("Progman"), w!("Program Manager")) else {
            return;
        };
        if show_list_under(progman) {
            return;
        }
        // 逐个扫顶层 WorkerW
        let mut worker = match FindWindowExW(HWND::default(), HWND::default(), w!("WorkerW"), w!("WorkerW")) {
            Ok(h) => h,
            Err(_) => return,
        };
        while !worker.is_invalid() {
            if show_list_under(worker) {
                return;
            }
            worker = match FindWindowExW(HWND::default(), worker, w!("WorkerW"), w!("WorkerW")) {
                Ok(h) => h,
                Err(_) => return,
            };
        }
    }
}

/// 在 `parent` 下找 `SHELLDLL_DefView → SysListView32` 并 `ShowWindow(SW_SHOW)`。
/// 找到并处理了返回 `true`。
unsafe fn show_list_under(parent: HWND) -> bool {
    unsafe extern "system" fn find_defview(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut buf);
        if n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == "SHELLDLL_DefView" {
            *(lparam.0 as *mut Option<HWND>) = Some(hwnd);
            return BOOL(0); // 已找到，停止枚举
        }
        BOOL(1) // 继续
    }

    let mut defview: Option<HWND> = None;
    let _ = EnumChildWindows(
        parent,
        Some(find_defview),
        LPARAM(&mut defview as *mut _ as isize),
    );
    let Some(defview) = defview else { return false };

    unsafe extern "system" fn show_list(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut buf);
        if n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == "SysListView32" {
            let _ = ShowWindow(hwnd, SW_SHOW);
            *(lparam.0 as *mut bool) = true;
            return BOOL(0);
        }
        BOOL(1)
    }

    let mut shown = false;
    let _ = EnumChildWindows(
        defview,
        Some(show_list),
        LPARAM(&mut shown as *mut bool as isize),
    );
    shown
}

// 保持 WPARAM 导入告警消除（枚举回调签名里用不到，留作扩展位）
#[allow(unused)]
fn _wparam_assert(_: WPARAM) {}
