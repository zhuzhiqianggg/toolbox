"""桌面图标层体检 —— 回答「用户看到的图标到底是谁画的」。

# 为什么需要它

Handy 的「接管桌面」靠隐藏系统桌面图标视图（`Progman` → `SHELLDLL_DefView`
→ `SysListView32`）。V38/V39 之后用户仍然反馈「源图标还在」，而日志里自愈
**一次都没触发** —— 也就是 Handy 自己认为「已经藏好了」。

这两句话不能同时为真，除非**我们藏的那个窗口不是用户在看的那个窗口**：

| 可能 | 探针会显示 |
| --- | --- |
| 藏对了，用户看的是第三方桌面的图标层 | 真 `SysListView32` `vis=False`，但另有桌面工具窗口 `vis=True` |
| 藏错了层（Win11 把图标视图挪到了 WorkerW 下） | 我们找的链 `vis=False`，另一条链的 `SysListView32` `vis=True` |
| `ShowWindow` 对本机无效 | 链正确、`IsWindowVisible=False`，但对象仍在屏幕上绘制（`WS_VISIBLE` 被清而风格位仍在） |

# 用法

    python scripts/audit/desktop-icon-probe.py            # 打印事实 + 判定
    python scripts/audit/desktop-icon-probe.py --json     # 机器可读
"""

from __future__ import annotations

import ctypes
import json
import sys
from ctypes import wintypes

u32 = ctypes.windll.user32

INTERESTING = {
    "Progman",
    "WorkerW",
    "SHELLDLL_DefView",
    "SysListView32",
    "SysHeader32",
    "Shell_TrayWnd",
}

# 桌面类窗口的常见「第三方」嫌疑：类名里带这些词的都值得看一眼
SUSPECT_HINTS = ("desk", "go", "360", "tencent", "wallpaper", "rainmeter", "leo")


def cls_of(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(wintypes.HWND(hwnd), buf, 256)
    return buf.value


def title_of(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(512)
    u32.GetWindowTextW(wintypes.HWND(hwnd), buf, 512)
    return buf.value


def rect_of(hwnd: int) -> tuple[int, int, int, int]:
    r = wintypes.RECT()
    u32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(r))
    return (r.left, r.top, r.right, r.bottom)


def pid_of(hwnd: int) -> int:
    pid = wintypes.DWORD()
    u32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))
    return pid.value


def pid_name(pid: int) -> str:
    """进程名（失败返回 pid 数字）。用 QueryFullProcessImageNameW 取全路径。"""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return f"pid:{pid}"
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(1024)
        ok = ctypes.windll.kernel32.QueryFullProcessImageNameW(
            wintypes.HANDLE(h), 0, buf, ctypes.byref(size)
        )
        return buf.value.split("\\")[-1] if ok else f"pid:{pid}"
    finally:
        ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(h))


def style_flags(hwnd: int) -> dict:
    GWL_STYLE = -16
    GWL_EXSTYLE = -20
    WS_VISIBLE = 0x10000000
    style = u32.GetWindowLongW(wintypes.HWND(hwnd), GWL_STYLE)
    ex = u32.GetWindowLongW(wintypes.HWND(hwnd), GWL_EXSTYLE)
    return {
        "ws_visible": bool(style & WS_VISIBLE),
        "iswindowvisible": bool(u32.IsWindowVisible(wintypes.HWND(hwnd))),
        "iconic": bool(u32.IsIconic(wintypes.HWND(hwnd))),
        "style": hex(style & 0xFFFFFFFF),
        "exstyle": hex(ex & 0xFFFFFFFF),
    }


def find_child(parent: int, cls: str) -> int:
    return u32.FindWindowExW(wintypes.HWND(parent), None, cls, None)


def children(parent: int) -> list[int]:
    out: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        out.append(int(hwnd))
        return True

    u32.EnumChildWindows(wintypes.HWND(parent), cb, 0)
    return out


def top_levels() -> list[int]:
    out: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        out.append(int(hwnd))
        return True

    u32.EnumWindows(cb, 0)
    return out


def describe(hwnd: int, depth: int = 0) -> dict:
    st = style_flags(hwnd)
    return {
        "hwnd": hex(hwnd),
        "pid": pid_of(hwnd),
        "proc": pid_name(pid_of(hwnd)),
        "depth": depth,
        **st,
        "rect": rect_of(hwnd),
    }


def main(argv: list[str]) -> int:
    report: dict = {"chains": [], "suspects": [], "all_icon_views": []}

    progman = u32.FindWindowW("Progman", None)
    report["progman"] = hex(progman) if progman else None

    # ① 我们代码走的那条链：Progman → SHELLDLL_DefView → SysListView32
    chain: list[dict] = []
    if progman:
        chain.append(describe(progman))
        def_view = find_child(progman, "SHELLDLL_DefView")
        if def_view:
            chain.append(describe(def_view, 1))
            lv = find_child(def_view, "SysListView32")
            if lv:
                chain.append(describe(lv, 2))
    report["chains"].append({"name": "Progman 链（Handy 实际操作的链）", "nodes": chain})

    # ② 所有挂 SHELLDLL_DefView 的 WorkerW（Win11 / 动态壁纸会把图标视图挪到这里）
    worker_hits: list[dict] = []
    seen = 0
    cur = 0
    while seen < 64:
        w = u32.FindWindowExW(None, wintypes.HWND(cur), "WorkerW", None)
        if not w:
            break
        seen += 1
        dv = find_child(w, "SHELLDLL_DefView")
        if dv:
            node = {"worker": describe(w), "defview": describe(dv, 1)}
            lv = find_child(dv, "SysListView32")
            if lv:
                node["listview"] = describe(lv, 2)
            worker_hits.append(node)
        cur = w
    report["chains"].append({"name": "WorkerW 链", "nodes": worker_hits})

    # ③ 全桌面上所有 SysListView32（找出「另一个在显示的图标视图」）
    for top in top_levels():
        for h in [top, *children(top)]:
            if cls_of(h) == "SysListView32":
                report["all_icon_views"].append(describe(h))

    # ④ 嫌疑第三方桌面工具：类名/进程名带关键词的可见顶层窗
    for top in top_levels():
        if not u32.IsWindowVisible(wintypes.HWND(top)):
            continue
        c = cls_of(top).lower()
        proc = pid_name(pid_of(top)).lower()
        if any(k in c or k in proc for k in SUSPECT_HINTS):
            report["suspects"].append({**describe(top), "class": cls_of(top), "title": title_of(top)})

    if "--json" in argv:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    def line(d: dict, extra: str = "") -> str:
        return (
            f"  {'  ' * d['depth']}{cls_of(int(d['hwnd'], 16)):<20} "
            f"vis={str(d['iswindowvisible']):<5} ws_vis={str(d['ws_visible']):<5} "
            f"iconic={str(d['iconic']):<5} rect={d['rect']} "
            f"pid={d['pid']}({d['proc']}){extra}"
        )

    print("=" * 92)
    print("桌面图标层体检")
    print("=" * 92)
    for ch in report["chains"]:
        print(f"\n[{ch['name']}]")
        nodes = ch["nodes"]
        if isinstance(nodes, list) and nodes and "worker" in nodes[0]:
            for n in nodes:
                print(line(n["worker"]))
                print(line(n["defview"]))
                if "listview" in n:
                    print(line(n["listview"]))
        elif nodes:
            for d in nodes:
                print(line(d))
        else:
            print("  （无）")
    print("\n[所有 SysListView32（全桌面）]")
    for d in report["all_icon_views"]:
        print(line(d))
    if not report["all_icon_views"]:
        print("  （无）")
    print("\n[可疑的第三方桌面窗口（可见顶层）]")
    for d in report["suspects"]:
        print(line(d, extra=f" class={d['class']} title={d['title']!r}"))
    if not report["suspects"]:
        print("  （无）")

    # 判定
    print("\n[判定]")
    chains = report["chains"][0]["nodes"]
    ours = None
    for d in chains:
        if cls_of(int(d["hwnd"], 16)) == "SysListView32":
            ours = d
    worker_visible = []
    for n in report["chains"][1]["nodes"]:
        if "listview" in n and n["listview"]["iswindowvisible"]:
            worker_visible.append(n)
    if ours is None:
        print("  · Handy 代码走的链上**找不到** SysListView32 → 隐藏必然失败（会被记成「本机不支持」）")
    elif ours["iswindowvisible"]:
        print("  · Handy 操作的 SysListView32 **可见** → 自愈应当触发；没触发说明轮询线程没跑")
    else:
        print("  · Handy 操作的 SysListView32 已隐藏 ✓")
    if worker_visible:
        print("  · ⚠️ 但 WorkerW 链上还有一个**可见**的图标视图 → 用户看到的可能是它")
    others = [
        d
        for d in report["all_icon_views"]
        if ours is None or d["hwnd"] != ours["hwnd"]
    ]
    for d in others:
        flag = "可见" if d["iswindowvisible"] else "已隐藏"
        print(f"  · 另有 SysListView32 {d['hwnd']}（{d['proc']}）{flag}")
    if report["suspects"]:
        print("  · ⚠️ 第三方桌面工具在运行，桌面图标/层级可能被它接管")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
