# -*- coding: utf-8 -*-
"""诊断：桌面右键菜单的 WinEvent 参数（V82 查「借出没触发」）。

背景
----
V81 给接管态加了一条「系统菜单期间把桌面还给系统」的旁听
（`src-tauri/src/platform/desktop_handoff.rs`）。用户 09-27 实测后报
「新建文件夹还是卡住」，而应用日志里**只有「旁听已启动」、一条借出记录都没有**
—— 说明 `is_desktop_menu` 把事件判掉了。

`EVENT_SYSTEM_MENUPOPUPSTART` 的 `hwnd` 参数到底是「菜单所属窗口」还是
「`#32768` 菜单窗自己」，文档含糊、实测才知道，而 `is_desktop_menu` 的判据
（同进程 + 顶层是 Progman/WorkerW）**只对前者成立**。这个脚本就是为了把
这两件事一次问清楚：

1. 事件到底发不发（发的话 hwnd 是谁）；
2. 那个 hwnd 的类名 / 进程 / owner / 顶层各是什么。

做法
----
装一个全局 `WinEventHook`，然后向桌面视图投递一次 `WM_CONTEXTMENU`
（等价于在桌面空白处按一次右键），把收到的事件连同上述信息打印出来，
随后立刻发 Esc 收掉菜单 —— 菜单只会在屏幕上停留零点几秒。

用法
----
    python scripts/audit/desktop-menu-probe.py            # 只观察事件与窗口

注意：会短暂弹出一次真实的桌面右键菜单（自动关掉）。别在做展示时跑。
"""

import ctypes
import ctypes.wintypes as wt
import sys
import threading
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)

EVENT_SYSTEM_MENUPOPUPSTART = 0x0006
EVENT_SYSTEM_MENUPOPUPEND = 0x0007
WINEVENT_OUTOFCONTEXT = 0x0000
WINEVENT_SKIPOWNPROCESS = 0x0002
WM_CONTEXTMENU = 0x007B
WM_CANCELMODE = 0x001F
PM_REMOVE = 0x0001


class POINT(ctypes.Structure):
    _fields_ = [("x", wt.LONG), ("y", wt.LONG)]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wt.HWND),
        ("message", wt.UINT),
        ("wParam", wt.WPARAM),
        ("lParam", wt.LPARAM),
        ("time", wt.DWORD),
        ("pt_x", wt.LONG),
        ("pt_y", wt.LONG),
    ]


WinEventProc = ctypes.WINFUNCTYPE(
    None,
    wt.HANDLE,  # HWINEVENTHOOK
    wt.DWORD,   # event
    wt.HWND,    # hwnd
    wt.LONG,    # idObject
    wt.LONG,    # idChild
    wt.DWORD,   # idEventThread
    wt.DWORD,   # dwmsEventTime
)


def class_name(hwnd):
    if not hwnd:
        return ""
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(wt.HWND(hwnd), buf, 256)
    return buf.value


def pid_of(hwnd):
    pid = wt.DWORD(0)
    user32.GetWindowThreadProcessId(wt.HWND(hwnd), ctypes.byref(pid))
    return pid.value


def window_title(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(wt.HWND(hwnd), buf, 256)
    return buf.value


def find_child(parent, cls):
    return user32.FindWindowExW(wt.HWND(parent), None, cls, None)


def describe(label, hwnd):
    if not hwnd:
        print(f"  {label:<22} (无)")
        return
    owner = user32.GetWindow(wt.HWND(hwnd), 4)  # GW_OWNER
    root = user32.GetAncestor(wt.HWND(hwnd), 2)  # GA_ROOT
    print(
        f"  {label:<22} hwnd=0x{hwnd:08X} class={class_name(hwnd)!r} "
        f"pid={pid_of(hwnd)} title={window_title(hwnd)!r} "
        f"owner={class_name(owner)!r} root={class_name(root)!r}"
    )


def main():
    progman = user32.FindWindowW("Progman", None)
    defview = find_child(progman, "SHELLDLL_DefView")
    listview = find_child(defview, "SysListView32")

    print("=" * 92)
    print("桌面右键菜单 WinEvent 取证")
    print("=" * 92)
    describe("Progman", progman)
    describe("SHELLDLL_DefView", defview)
    describe("SysListView32", listview)

    seen = []
    done = threading.Event()

    def cb(hook, event, hwnd, id_object, id_child, thread_id, event_time):
        # 只记我们关心的两条；回调里绝不做重活
        if event in (EVENT_SYSTEM_MENUPOPUPSTART, EVENT_SYSTEM_MENUPOPUPEND):
            seen.append((event, hwnd, thread_id))
            name = "MENUPOPUPSTART" if event == EVENT_SYSTEM_MENUPOPUPSTART else "MENUPOPUPEND"
            print(
                f"  [{name}] hwnd=0x{hwnd:08X} class={class_name(hwnd)!r} "
                f"pid={pid_of(hwnd)} owner={class_name(user32.GetWindow(wt.HWND(hwnd), 4))!r} "
                f"root={class_name(user32.GetAncestor(wt.HWND(hwnd), 2))!r} tid={thread_id}"
            )

    proc = WinEventProc(cb)
    hook = user32.SetWinEventHook(
        EVENT_SYSTEM_MENUPOPUPSTART,
        EVENT_SYSTEM_MENUPOPUPEND,
        None,
        proc,
        0,
        0,
        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
    )
    if not hook:
        print(f"SetWinEventHook 失败：{ctypes.get_last_error()}")
        return 1

    def pump():
        msg = MSG()
        while not done.is_set():
            if user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
            else:
                time.sleep(0.01)

    pump_thread = threading.Thread(target=pump, daemon=True)
    pump_thread.start()
    time.sleep(0.3)

    # 从光标位置取一个点当菜单坐标（用屏幕中心也行，这里用右下角空白区更安全）
    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    x, y = pt.x, pt.y
    lparam = (y << 16) | (x & 0xFFFF)

    print("-" * 92)
    print(f"投递 WM_CONTEXTMENU 到 SysListView32（坐标 {x},{y}）…… 观察 1.5 秒")
    target = listview or defview
    print(f"  目标 hwnd=0x{target:08X} class={class_name(target)!r}")
    user32.PostMessageW(wt.HWND(target), WM_CONTEXTMENU, wt.WPARAM(target), wt.LPARAM(lparam))
    time.sleep(1.5)

    # 收掉可能弹出来的菜单：Esc（菜单窗口收到就关）
    menu_win = user32.FindWindowW("#32768", None)
    if menu_win:
        print(f"  菜单仍在屏幕上（#32768=0x{menu_win:08X}）→ 发 Esc 收起")
        user32.PostMessageW(wt.HWND(menu_win), 0x0100, wt.WPARAM(0x1B), wt.LPARAM(0))  # WM_KEYDOWN VK_ESCAPE
        time.sleep(0.2)
    user32.PostMessageW(wt.HWND(target), WM_CANCELMODE, wt.WPARAM(0), wt.LPARAM(0))
    time.sleep(0.3)

    done.set()
    user32.UnhookWinEvent(wt.HANDLE(hook))

    print("-" * 92)
    print(f"共收到 {len(seen)} 条菜单事件")
    if not seen:
        print("  ⚠️ 一条都没有 —— 说明向 SysListView32 投递 WM_CONTEXTMENU 不会触发菜单事件；")
        print("     真实右键（鼠标消息）走的可能是另一条路，需要用户手动右键来抓。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
