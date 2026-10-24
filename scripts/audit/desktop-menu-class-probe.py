# -*- coding: utf-8 -*-
"""取证：真实右键（鼠标消息）桌面空白处，弹出的菜单窗口叫什么类名。

为什么要有它（V86）
--------------------
09-30 早用户报「右键新建还是慢、第二次起没反应」，而应用日志里**一条借出都没有**。
`poll_menu` 只认 `#32768`；Win11 的桌面右键菜单若不是这个类（新式菜单宿主窗口），
轮询就永远看不见。V82 的 `desktop-menu-probe.py` 是向视图 `PostMessage(WM_CONTEXTMENU)`
—— 那条路径可能与真实鼠标不一致，所以这里用**真实鼠标消息**取证一次。

做法
----
1. 快照当前所有可见顶层窗口；
2. 找一个 `WindowFromPoint` 落在 `Progman` / `SHELLDLL_DefView` / `SysListView32`
   的空白点（避开展示，取屏幕右侧偏中）；
3. `mouse_event` 真实右键一次；
4. 2.5 秒内轮询 diff，抓所有新出现的可见窗口（类名 / pid / owner / root）；
5. 发 Esc 收菜单。

用法
----
    python scripts/audit/desktop-menu-class-probe.py

注意：会在屏幕上真的弹一次右键菜单（自动关掉）。别在做展示时跑。
"""

import ctypes
import ctypes.wintypes as wt
import sys
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
KEYEVENTF_KEYUP = 0x0002
VK_ESCAPE = 0x1B
GW_OWNER = 4
GA_ROOT = 2

ENUM = []


def _cb(hwnd, _):
    ENUM.append(hwnd)
    return True


EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def visible_windows():
    ENUM.clear()
    user32.EnumWindows(EnumProc(_cb), 0)
    return {h for h in ENUM if user32.IsWindowVisible(h)}


def class_name(h):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(h, buf, 256)
    return buf.value


def pid_of(h):
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
    return pid.value


def title_of(h):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(h, buf, 256)
    return buf.value


def main():
    sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    # 网格扫描：找一个落在桌面背景上的点（避开屏幕边缘 80px）
    target = None
    seen_cls = {}
    for y in range(80, sh - 80, 60):
        for x in range(80, sw - 80, 60):
            pt = wt.POINT(x, y)
            hwnd = user32.WindowFromPoint(pt)
            cls = class_name(hwnd) if hwnd else ""
            seen_cls[cls] = seen_cls.get(cls, 0) + 1
            if target is None and cls in (
                "Progman", "WorkerW", "SHELLDLL_DefView", "SysListView32"
            ):
                target = (x, y, cls)
    print("WindowFromPoint 命中分布：", sorted(seen_cls.items(), key=lambda kv: -kv[1]))
    if target is None:
        print("没找到能穿透到桌面背景的空白点，停手（避免右键被别的窗口接走）")
        return 1
    x, y, hit_cls = target
    print(f"右键点 ({x},{y})，WindowFromPoint 命中 {hit_cls}")

    before = visible_windows()
    # 真实右键：绝对坐标归一化到 0..65535
    ax = int(x * 65535 / (sw - 1)) & 0xFFFF
    ay = int(y * 65535 / (sh - 1)) & 0xFFFF
    user32.SetCursorPos(x, y)
    time.sleep(0.15)
    user32.mouse_event(MOUSEEVENTF_RIGHTDOWN, ax, ay, 0, 0)
    time.sleep(0.05)
    user32.mouse_event(MOUSEEVENTF_RIGHTUP, ax, ay, 0, 0)

    found = []
    deadline = time.time() + 2.5
    while time.time() < deadline:
        time.sleep(0.05)
        cur = visible_windows()
        for h in cur - before:
            cls = class_name(h)
            owner = user32.GetWindow(h, GW_OWNER)
            root = user32.GetAncestor(h, GA_ROOT)
            rec = (
                hex(h), cls, pid_of(h), repr(title_of(h)),
                f"owner={class_name(owner) if owner else None!r}",
                f"root={class_name(root) if root else None!r}",
            )
            if rec not in found:
                found.append(rec)
        if any(f[1] == "#32768" or "Xaml" in f[1] or "Menu" in f[1] for f in found):
            break

    time.sleep(0.3)
    if found:
        print("新出现的可见窗口：")
        for r in found:
            print("  ", r)
    else:
        print("2.5 秒内没有任何新窗口 —— 右键被别的窗口吞了？")
    # Esc 收菜单
    user32.keybd_event(VK_ESCAPE, 0, 0, 0)
    user32.keybd_event(VK_ESCAPE, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(0.3)
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
