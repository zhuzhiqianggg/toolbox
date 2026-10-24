# -*- coding: utf-8 -*-
"""显示器配置 vs 挂件窗几何 —— 双显示器排查探针（V83）。

# 回答哪个问题

**挂件窗现在是不是严格等于「当前主显示器工作区」？**

这就是 V83 的口径（见 `docs/02-architecture/DESKTOP-LAYER.md` §1.2）：挂件窗只覆盖
主显示器，副屏完全原生。所以只要这一条成立，布局的地基就是对的。

# 为什么要它

用户 2026-09-28 接了双显示器后，格子全挤在 1138×608 的角落里、屏幕右侧近 800px
与下方 400 多 px 全空。根因是**窗口几何被持久化**（前端用挂载时取过的过期
`scaleFactor` 换算后写库，后端开窗「DB 优先」⇒ 尺寸永久锁死）。

修法是把几何改成实时算。但**双屏环境难以在开发机上复现**（这台机器只有一块屏），
所以留这个脚本：装上之后跑一次，就能直接读出「主屏是谁、窗口在哪、差多少」。

# 怎么读结果

  ✅ 已对齐        —— 地基正确；若界面仍不对，问题在布局算法而不在几何
  ❌ 未对齐        —— 打印每个方向差多少像素（对比产品里的 2px 容差）
  ⚠️ 找不到挂件窗 —— 应用没在跑，或还没点「整理」（接管态才有这个窗口）

# 用法

    python scripts/audit/display-probe.py
"""

import ctypes
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)

# 与 `commands/grid.rs` 的 BOUNDS_TOLERANCE 保持一致：非整数缩放下
# `SetWindowPos` 与 `GetWindowRect` 会差 1–2px，这个范围内算「已对齐」。
TOLERANCE = 2

# 挂件窗的标题（见 `commands/grid.rs` → `WebviewWindowBuilder::title`）。
OVERLAY_TITLE_KEYWORD = "挂件"


class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
        ("szDevice", ctypes.c_wchar * 32),
    ]


MONITORENUMPROC = ctypes.WINFUNCTYPE(
    wintypes.BOOL,
    wintypes.HMONITOR,
    wintypes.HDC,
    ctypes.POINTER(wintypes.RECT),
    wintypes.LPARAM,
)


def monitor_list():
    """所有显示器（含主屏标记）。主屏 = `dwFlags & MONITORINFOF_PRIMARY`。"""
    found = []

    def callback(hmon, _hdc, _rect, _data):
        info = MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(info)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
            found.append(info)
        return True

    user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(callback), 0)
    return found


def class_name(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def window_text(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, buf, 256)
    return buf.value


def find_overlays():
    """所有标题含「挂件」的 Tauri 顶层窗口（正常只有 0 或 1 个）。"""
    hits = []

    def callback(hwnd, _lparam):
        title = window_text(hwnd)
        if OVERLAY_TITLE_KEYWORD in title and class_name(hwnd) == "Tauri Window":
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            pid = wintypes.DWORD(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            hits.append(
                {
                    "hwnd": hwnd,
                    "title": title,
                    "visible": bool(user32.IsWindowVisible(hwnd)),
                    "pid": pid.value,
                    "rect": (rect.left, rect.top, rect.right, rect.bottom),
                    "dpi": user32.GetDpiForWindow(hwnd) or 96,
                }
            )
        return True

    user32.EnumWindows(ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(callback), 0)
    return hits


def main():
    mons = monitor_list()
    print(f"显示器数量：{len(mons)}")
    primary = None
    for index, info in enumerate(mons):
        mon, work = info.rcMonitor, info.rcWork
        is_primary = bool(info.dwFlags & 1)
        if is_primary:
            primary = info
        print(
            "  [{idx}] {dev:<16} monitor=({ml},{mt})-({mr},{mb}) {mw}×{mh}  "
            "work=({wl},{wt})-({wr},{wb}) {ww}×{wh}  primary={pri}".format(
                idx=index,
                dev=info.szDevice.rstrip("\x00"),
                ml=mon.left,
                mt=mon.top,
                mr=mon.right,
                mb=mon.bottom,
                mw=mon.right - mon.left,
                mh=mon.bottom - mon.top,
                wl=work.left,
                wt=work.top,
                wr=work.right,
                wb=work.bottom,
                ww=work.right - work.left,
                wh=work.bottom - work.top,
                pri="YES" if is_primary else "no",
            )
        )

    if primary is None:
        print("\n❌ 拿不到主显示器 —— 系统正在重排显示器？稍后再试。")
        return 1

    work = primary.rcWork
    target = (work.left, work.top, work.right - work.left, work.bottom - work.top)
    print(f"\n主显示器工作区（几何真源）：位置 ({target[0]}, {target[1]}) 尺寸 {target[2]}×{target[3]}")

    overlays = find_overlays()
    if not overlays:
        print("\n⚠️ 没找到挂件窗（标题含「挂件」的 Tauri Window）——应用多半没在跑。")
        print("   接管态（点过「整理」）才会有这个窗口；先启动或点一次「整理」再看。")
        print("\n（以下仅凭显示器配置判断）")
        if len(mons) > 1:
            print("   · 多显示器：产品口径是**只覆盖主屏**，副屏保持原生桌面。")
        return 0

    bad = 0
    for item in overlays:
        left, top, right, bottom = item["rect"]
        cur = (left, top, right - left, bottom - top)
        print(
            f"\n挂件窗 0x{item['hwnd']:08X} pid={item['pid']} visible={item['visible']} "
            f"DPI={item['dpi'] / 96:.2f}x"
        )
        print(f"  实际：位置 ({cur[0]}, {cur[1]}) 尺寸 {cur[2]}×{cur[3]}")

        dx, dy = cur[0] - target[0], cur[1] - target[1]
        dw, dh = cur[2] - target[2], cur[3] - target[3]
        off_pos = abs(dx) > TOLERANCE or abs(dy) > TOLERANCE
        off_size = abs(dw) > TOLERANCE or abs(dh) > TOLERANCE

        print(f"  偏差：dx={dx:+d} dy={dy:+d} dw={dw:+d} dh={dh:+d}（容差 ±{TOLERANCE}px）")
        if not off_pos and not off_size:
            print("  ✅ 已对齐主显示器工作区")
        else:
            bad += 1
            print("  ❌ 未对齐 —— 窗口没有铺满主屏：")
            if off_pos:
                print(f"     位置对不上：应是 ({target[0]}, {target[1]})")
            if off_size:
                print(f"     尺寸对不上：应是 {target[2]}×{target[3]}")
            print("     期望行为：保险线程每 1 秒复核一次，发现偏差会**自动贴回去**并让前端重排。")
            print("     若持续不对：看应用日志里的「挂件窗几何已按主显示器对齐」有没有出现。")

    if len(mons) > 1:
        print(
            "\n说明：检测到多显示器。产品口径是**只算主显示器**"
            "（docs/02-architecture/DESKTOP-LAYER.md §1.2）："
            "\n  · 挂件窗严格等于主屏工作区，绝不跨屏；副屏不出现 Handy 的任何窗口；"
            "\n  · 副屏的右键 / 新建 / 拖拽因此完全是原生行为；"
            "\n  · 但**桌面图标视图是跨屏的一张单视图**，接管期间副屏的原生图标也会一起收起"
            "（平台限制，无法只藏一半）。"
        )

    print("\n结论：" + ("✅ 几何正确" if bad == 0 else f"❌ {bad} 个挂件窗几何不正确"))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
