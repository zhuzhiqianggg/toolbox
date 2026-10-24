# -*- coding: utf-8 -*-
"""诊断：挂件层的真实 Z 序位置、扩展样式、以及往下 60 层的窗口链。

回答三个问题：
  1. 挂件层是不是 topmost（WS_EX_TOPMOST）？—— GW_HWNDNEXT 只在同 band 内走，
     如果是 topmost，就永远走不到 Progman，`z_verdict` 必然误判 TooHigh。
  2. 往下一路走到桌面宿主需要几步？—— 用来校准 REASSERT_SCAN_STEPS（现值 24）。
  3. 桌面宿主在链里到底叫什么。
"""
import ctypes
from ctypes import wintypes
import sys

u32 = ctypes.windll.user32
k32 = ctypes.windll.kernel32

GWL_EXSTYLE = -20
GWL_STYLE = -16
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_VISIBLE = 0x10000000
WS_MINIMIZE = 0x20000000

GW_HWNDNEXT = 2
GW_HWNDPREV = 3

u32.GetWindowLongW.restype = ctypes.c_long
u32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
u32.GetWindow.restype = wintypes.HWND
u32.GetWindow.argtypes = [wintypes.HWND, ctypes.c_uint]


def cls(h):
    buf = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(h, buf, 256)
    return buf.value


def title(h):
    buf = ctypes.create_unicode_buffer(512)
    u32.GetWindowTextW(h, buf, 512)
    return buf.value


def pid_of(h):
    p = wintypes.DWORD()
    u32.GetWindowThreadProcessId(h, ctypes.byref(p))
    return p.value


def proc_name(pid):
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return f"pid{pid}"
    buf = ctypes.create_unicode_buffer(512)
    size = wintypes.DWORD(512)
    ok = k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
    k32.CloseHandle(h)
    if not ok:
        return f"pid{pid}"
    return buf.value.rsplit("\\", 1)[-1]


def flags(ex):
    out = []
    if ex & WS_EX_TOPMOST:
        out.append("TOPMOST")
    if ex & WS_EX_TOOLWINDOW:
        out.append("TOOLWINDOW")
    if ex & WS_EX_NOACTIVATE:
        out.append("NOACTIVATE")
    if ex & WS_EX_LAYERED:
        out.append("LAYERED")
    if ex & WS_EX_TRANSPARENT:
        out.append("TRANSPARENT")
    return "|".join(out) or "-"


def find_overlay():
    """按进程名 handy.exe + 类名 Tauri Window 找挂件层（取面积最大的那个）。"""
    found = []
    EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, lparam):
        name = proc_name(pid_of(h))
        if name.lower() == "handy.exe" and cls(h) == "Tauri Window":
            r = wintypes.RECT()
            u32.GetWindowRect(h, ctypes.byref(r))
            found.append((h, (r.right - r.left) * (r.bottom - r.top), r))
        return True

    u32.EnumWindows(EnumWindowsProc(cb), 0)
    found.sort(key=lambda t: -t[1])
    return found


def find_host():
    progman = u32.FindWindowW("Progman", None)
    def_view = u32.FindWindowExW(progman, None, "SHELLDLL_DefView", None) if progman else None
    child = u32.FindWindowExW(def_view, None, "SysListView32", None) if def_view else None
    return progman, def_view, child


def main():
    print("=" * 78)
    print("[1] 桌面宿主")
    progman, def_view, child = find_host()
    print(f"  Progman        = {progman and hex(progman)}")
    print(f"  SHELLDLL_DefView = {def_view and hex(def_view)}")
    print(f"  SysListView32  = {child and hex(child)}")
    if child:
        ex = u32.GetWindowLongW(child, GWL_EXSTYLE)
        st = u32.GetWindowLongW(child, GWL_STYLE)
        print(f"  原生图标样式：ex={flags(ex)} style={'VISIBLE ' if st & WS_VISIBLE else 'HIDDEN '}")

    progs = find_overlay()
    if not progs:
        print("\n[!] 没找到 handy.exe 的 Tauri Window —— 挂件层可能没在显示")
        return
    h, area, rect = progs[0]
    ex = u32.GetWindowLongW(h, GWL_EXSTYLE)
    st = u32.GetWindowLongW(h, GWL_STYLE)
    print("\n" + "=" * 78)
    print("[2] 挂件层窗口")
    print(f"  hwnd  = {hex(h)}  rect=({rect.left},{rect.top},{rect.right},{rect.bottom})  面积={area}")
    print(f"  ex    = {flags(ex)}")
    print(f"  style = {'VISIBLE ' if st & WS_VISIBLE else 'HIDDEN '}{'MINIMIZE ' if st & WS_MINIMIZE else ''}")
    print(f"  topmost = {bool(ex & WS_EX_TOPMOST)}   <-- 若为 True，GW_HWNDNEXT 永远走不到 Progman")

    print("\n" + "=" * 78)
    print("[3] 从上往下完整 Z 序（挂件层往下 60 层）")
    cur = h
    step = 0
    host_at = None
    while step < 60:
        nx = u32.GetWindow(cur, GW_HWNDNEXT)
        if not nx:
            print(f"  {step:>3}  (Z 序末端 / 本 band 走完)")
            break
        step += 1
        mark = ""
        if nx == progman:
            mark = "   <== 桌面宿主"
            host_at = step
        print(f"  {step:>3}  {cls(nx):<28} {proc_name(pid_of(nx)):<16} ex={flags(u32.GetWindowLongW(nx, GWL_EXSTYLE))}{mark}")
        cur = nx
    print(f"\n  桌面宿主距挂件层 = {host_at if host_at else '60 步内没走到'}")
    print(f"  （Rust 的 REASSERT_SCAN_STEPS = 24）")

    print("\n" + "=" * 78)
    print("[4] 往上 10 层（谁盖在挂件层上面）")
    cur = h
    for i in range(10):
        pv = u32.GetWindow(cur, GW_HWNDPREV)
        if not pv:
            print(f"  -{i+1:>2}  (本 band 顶部)")
            break
        print(f"  -{i+1:>2}  {cls(pv):<28} {proc_name(pid_of(pv))}")


main()
