# -*- coding: utf-8 -*-
"""诊断：桌面空白处的鼠标落点归谁（V82）。

问的是什么
----------
接管态下，用户报「右键新建文件夹没反应」。桌面空白处那一下右键**应该**穿透到
系统桌面视图（`SHELLDLL_DefView` / `SysListView32`），由 Explorer 弹原生菜单；
如果它落到了我们自己的挂件窗上，就会被前端 `onContextMenu` 吃掉、弹成 Handy 菜单
—— 那「新建」自然无从谈起。

挂件窗的穿透是**跟随光标**判定的（`want = interactive || cursor_hit(&win)`），
所以静态查询没有意义：必须真的把光标挪过去、等穿透状态更新完，再问
`WindowFromPoint` 是谁。

做法
----
把光标依次移到屏幕上的若干候选点（九宫格采样），每点停 300ms 让挂件窗完成
穿透判定，然后 `WindowFromPoint` 打印落点窗口的类名与 pid；结束时光标复位。
**不点击、不按键**，对桌面无副作用（只会看到光标跳几下）。

用法
----
    python scripts/audit/desktop-hit-probe.py
"""

import ctypes
import ctypes.wintypes as wt
import sys
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)


class POINT(ctypes.Structure):
    _fields_ = [("x", wt.LONG), ("y", wt.LONG)]


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


def main():
    original = POINT()
    user32.GetCursorPos(ctypes.byref(original))
    screen_w = user32.GetSystemMetrics(0)
    screen_h = user32.GetSystemMetrics(1)

    # 采样：横向 5 档（最右一档刻意落在工作台区域）+ 纵向 3 档
    points = []
    for fy in (0.15, 0.5, 0.85):
        for fx in (0.10, 0.35, 0.55, 0.72, 0.90):
            points.append((int(screen_w * fx), int(screen_h * fy)))

    print("=" * 92)
    print("桌面鼠标落点取证（接管态：桌面图标视图已隐藏）")
    print("=" * 92)
    print(f"屏幕 {screen_w}x{screen_h}，候选点 {len(points)} 个，光标原位 ({original.x},{original.y})")
    print("-" * 92)

    tally = {}
    for x, y in points:
        user32.SetCursorPos(x, y)
        time.sleep(0.30)  # 等挂件窗把穿透状态更新到光标所在处
        hwnd = user32.WindowFromPoint(POINT(x, y))
        name = class_name(hwnd)
        owner = user32.GetWindow(wt.HWND(hwnd), 4)  # GW_OWNER
        print(
            f"  ({x:5d},{y:5d})  ->  0x{hwnd:08X}  {name:<28} pid={pid_of(hwnd):<6} "
            f"owner={class_name(owner)!r}"
        )
        tally[(name, pid_of(hwnd))] = tally.get((name, pid_of(hwnd)), 0) + 1

    user32.SetCursorPos(original.x, original.y)
    time.sleep(0.2)

    print("-" * 92)
    print("落点分布：")
    for (name, pid), count in sorted(tally.items(), key=lambda kv: -kv[1]):
        print(f"  {name:<30} pid={pid:<6} {count} 个点")

    handy_hits = sum(c for (n, _), c in tally.items() if n.startswith("com.handy"))
    if handy_hits:
        print()
        print(f"  ⚠️ {handy_hits}/{len(points)} 个点落在 Handy 自己的挂件窗上")
        print("     ⇒ 这些位置的右键会被前端吃掉（弹我们的菜单），到不了系统桌面。")
    else:
        print()
        print("  ✓ 没有点落在 Handy 挂件窗上 —— 空白处的右键能到系统桌面视图。")
    print("光标已复位。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
