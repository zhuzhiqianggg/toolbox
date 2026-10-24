# -*- coding: utf-8 -*-
"""验证：桌面右键是否真的触发了「借出 → 收回」（V82）。

为什么要有它
------------
V81 那版借出机制上线后，用户报「新建文件夹还是卡住」，而日志里
**一条借出记录都没有** —— 机制静默失效，靠用户反馈才发现。
V82 修完判据与轮询兜底之后，这个脚本把「在桌面空白处真的按一次右键」
和「日志里有没有出现借出 / 收回」连着做一遍，一次拿到结论。

做法
----
1. 找一个**真的能穿透到系统桌面**的点（`WindowFromPoint` 落点是
   `SHELLDLL_DefView` / `SysListView32` / `Progman`）—— 找不到就停手，
   因为那种情况下右键会被别的窗口接走，验证没有意义；
2. 把光标挪过去、模拟一次真实右键（`mouse_event`）；
3. 读 Handy 应用日志的增量，看有没有「系统菜单：桌面暂时还给系统」；
4. 发 Esc 收掉菜单，等它自动收回；
5. 光标复位。

用法
----
    python scripts/audit/desktop-menu-roundtrip.py

注意：会在桌面上真的弹一次右键菜单（自动关掉），并让桌面短暂变回原生。
"""

import ctypes
import ctypes.wintypes as wt
import os
import sys
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)

MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
KEYEVENTF_KEYUP = 0x0002
VK_ESCAPE = 0x1B

DESKTOP_CLASSES = ("SHELLDLL_DefView", "SysListView32", "Progman", "WorkerW")


class POINT(ctypes.Structure):
    _fields_ = [("x", wt.LONG), ("y", wt.LONG)]


def class_name(hwnd):
    if not hwnd:
        return ""
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(wt.HWND(hwnd), buf, 256)
    return buf.value


def log_path():
    local = os.environ.get("LOCALAPPDATA", "")
    return os.path.join(local, "Handy", "handy.log")


def read_log_tail(path, since_line):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        return [], 0
    return lines[since_line:], len(lines)


def find_passthrough_point():
    """找一个落点在系统桌面视图上的点（= 右键能到达系统桌面）。"""
    original = POINT()
    user32.GetCursorPos(ctypes.byref(original))
    screen_w = user32.GetSystemMetrics(0)
    screen_h = user32.GetSystemMetrics(1)
    found = None
    for fy in (0.45, 0.6, 0.75, 0.3, 0.9):
        for fx in (0.08, 0.2, 0.32, 0.45, 0.6):
            x, y = int(screen_w * fx), int(screen_h * fy)
            user32.SetCursorPos(x, y)
            time.sleep(0.25)
            hwnd = user32.WindowFromPoint(POINT(x, y))
            cls = class_name(hwnd)
            if cls in DESKTOP_CLASSES:
                found = (x, y, cls)
                break
        if found:
            break
    user32.SetCursorPos(original.x, original.y)
    time.sleep(0.2)
    return found, (original.x, original.y)


def main():
    path = log_path()
    if not os.path.exists(path):
        print(f"找不到应用日志：{path}")
        return 1

    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        base_line = len(fh.readlines())

    print("=" * 92)
    print("桌面右键「借出 → 收回」往返验证")
    print("=" * 92)
    print(f"日志 {path}（基线第 {base_line} 行）")

    point, original = find_passthrough_point()
    if point is None:
        print()
        print("⚠️ 找不到能穿透到系统桌面的点 —— 此刻桌面被别的窗口盖着（例如最大化的浏览器）。")
        print("   这种情况下右键本来就到不了桌面，验证无意义，已停手；桌面未被改动。")
        return 2
    x, y, cls = point
    print(f"找到穿透点 ({x},{y})  落点窗口 {cls}")

    print("-" * 92)
    print("在该点模拟一次真实右键 ……")
    user32.SetCursorPos(x, y)
    time.sleep(0.25)
    user32.mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0)
    time.sleep(0.05)
    user32.mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0)
    time.sleep(1.2)

    new_lines, _ = read_log_tail(path, base_line)
    borrowed = [ln.strip() for ln in new_lines if "系统菜单" in ln]

    # 收掉菜单：Esc，再点一下空白（原生菜单是模态的，Esc 最稳）
    user32.keybd_event(VK_ESCAPE, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(VK_ESCAPE, 0, KEYEVENTF_KEYUP, 0)
    time.sleep(2.0)

    after_lines, _ = read_log_tail(path, base_line)
    all_new = [ln.strip() for ln in after_lines if "系统菜单" in ln]

    print("-" * 92)
    if all_new:
        print("日志新增：")
        for ln in all_new:
            print("  " + ln)
    else:
        print("日志新增：无（没有出现任何「系统菜单」相关记录）")

    if any("还给系统" in ln for ln in all_new):
        print()
        print("✅ 借出已触发；若同时能看到「桌面已收回」，说明往返闭环正常。")
    else:
        print()
        print("❌ 借出仍未触发 —— 请把上面的完整日志片段发回，这就是下一轮的线索。")

    user32.SetCursorPos(original[0], original[1])
    time.sleep(0.2)
    print("光标已复位。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
