"""把系统桌面图标视图恢复成可见 —— 装机前的安全兜底。

# 为什么需要它

Handy 的「接管桌面」会隐藏 `Progman` → `SHELLDLL_DefView` → `SysListView32`。
若在接管生效时**强制结束进程**（安装新版必须先停旧版，而 NSIS 无法覆盖被占用的
exe），`RunEvent::ExitRequested` / `Exit` 都不会触发，桌面就会留下一个
「应用没了、图标也没了」的空白桌面。

正常路径上不该发生（V44.2 已加双保险），但装机是**人为强杀**，绕过了优雅退出。
所以装机脚本停进程之后，用这个脚本把图标无条件恢复，保证交付瞬间桌面是正常的。

恢复后若用户重新启动 Handy，`restore_overlay_if_visible` 会按偏好重新接管 —— 行为一致。

# ⚠️ 顺序铁律：**先停进程，再跑本脚本**（V59.1 踩到）

产品侧有一条 250ms 的**自愈轮询**：它发现「接管偏好 = 开，但原生图标可见」就会**立刻重新隐藏**
（应用日志里那行「桌面图标曾被系统恢复（多为 Win+D / 显示桌面 / Explorer 重建），已重新接管」）。
所以若 handy.exe 还活着，本脚本的 `ShowWindow` 会在**约 3 秒内被抢回去** ——
而脚本当场读到的 `可见=True` 是**真的**，于是调用方会误以为成功、留下一个空白桌面。

本脚本现在会**主动检测**并如实报告（见 `handy_running`），不再是「报成功后悄悄失效」。

# ⚠️ 别用 `tasklist //FI "IMAGENAME eq handy.exe"` 判断进程（V59.1 踩到）

在 Git Bash 里 `//FI` 会被 MSYS 路径转换破坏，tasklist 直接报
`错误: 无效参数/选项 - '//FI'` 并**退出**；而调用方几乎都会 `2>/dev/null` 吞掉 stderr ——
于是「命令报错」看起来就是「**没有进程**」。V59.1 因此误判、在先还原后被自愈抢回。
⇒ 判据必须来自**完整进程表**（本脚本用 `tasklist /FO CSV /NH` 自行过滤，绕开这一步）。

# 用法

    python scripts/audit/desktop-icon-restore.py          # 恢复并打印结果
    python scripts/audit/desktop-icon-restore.py --dry    # 只看状态不改
"""

from __future__ import annotations

import ctypes
import subprocess
import sys
import time
from ctypes import wintypes

u32 = ctypes.windll.user32

SW_SHOW = 5
CREATE_NO_WINDOW = 0x0800_0000

# 自愈轮询是 250ms 一跳；留 3 秒足够它抢回来（也足够证明它抢不回来）
SELF_HEAL_WINDOW_S = 3.0


def cls_of(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    u32.GetClassNameW(wintypes.HWND(hwnd), buf, 256)
    return buf.value


def find_child(parent: int, cls: str) -> int:
    return u32.FindWindowExW(wintypes.HWND(parent), None, cls, None)


def find_top(cls: str) -> int:
    return u32.FindWindowW(cls, None)


def handy_running() -> list[str]:
    """返回正在运行的 handy.exe 的 PID 列表。

    必须走**完整进程表**：`tasklist //FI ...` 在 Git Bash 里会被路径转换破坏成
    「无效参数」并静默退出（见模块头），拿它当判据会得出「没有进程」的假结论。
    """
    try:
        proc = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    pids: list[str] = []
    for line in proc.stdout.splitlines():
        parts = [item.strip().strip('"') for item in line.split(",")]
        if parts and parts[0].lower() == "handy.exe":
            pids.append(parts[1] if len(parts) > 1 else "?")
    return pids


def locate_icon_list() -> list[tuple[str, int, bool]]:
    """返回所有 (来源描述, SysListView32 句柄, 当前是否可见)。"""
    found: list[tuple[str, int, bool]] = []

    # 链 A：Progman → SHELLDLL_DefView → SysListView32（经典 / 部分 Win10）
    progman = find_top("Progman")
    if progman:
        dv = find_child(progman, "SHELLDLL_DefView")
        if dv:
            lv = find_child(dv, "SysListView32")
            if lv:
                found.append(("Progman/DefView", lv, bool(u32.IsWindowVisible(wintypes.HWND(lv)))))

    # 链 B：WorkerW → SHELLDLL_DefView → SysListView32（Win10/11 常见）
    worker = 0
    while True:
        worker = u32.FindWindowExW(wintypes.HWND(0), wintypes.HWND(worker), "WorkerW", None)
        if not worker:
            break
        dv = find_child(worker, "SHELLDLL_DefView")
        if dv:
            lv = find_child(dv, "SysListView32")
            if lv:
                found.append((f"WorkerW({worker:#x})/DefView", lv, bool(u32.IsWindowVisible(wintypes.HWND(lv)))))

    return found


def probe_visibility() -> list[bool]:
    """重新枚举一次，返回各桌面图标视图的可见性（用于事后复核）。"""
    return [visible for _, _, visible in locate_icon_list()]


def main() -> int:
    dry = "--dry" in sys.argv

    running = handy_running()
    if running and not dry:
        print(
            "[restore] ⚠️ 检测到 handy.exe 仍在运行（PID {}）—— 它的自愈轮询会在约 "
            "{} 秒内把图标**重新隐藏**，本次恢复大概率白做。\n"
            "          正确顺序：先 `MSYS_NO_PATHCONV=1 taskkill /F /IM handy.exe`，再跑本脚本。".format(
                ", ".join(running), int(SELF_HEAL_WINDOW_S)
            )
        )

    targets = locate_icon_list()
    if not targets:
        print("[restore] 未找到桌面图标视图（SysListView32）；无需处理")
        return 0

    for label, hwnd, visible in targets:
        if visible:
            print(f"[restore] {label} hwnd={hwnd:#x} 已可见，跳过")
            continue
        if dry:
            print(f"[restore] {label} hwnd={hwnd:#x} 隐藏中（--dry，不修改）")
            continue
        u32.ShowWindow(wintypes.HWND(hwnd), SW_SHOW)
        after = bool(u32.IsWindowVisible(wintypes.HWND(hwnd)))
        print(f"[restore] {label} hwnd={hwnd:#x} → ShowWindow(SW_SHOW) 可见={after}")

    if dry:
        return 0

    # ── 事后复核：等过一个自愈周期，确认没有被抢回去 ──
    # 只有这一步能区分「真的恢复了」和「恢复后被自愈抢回」——两者当场都读到 True。
    if running:
        time.sleep(SELF_HEAL_WINDOW_S)
        state = probe_visibility()
        if state and not all(state):
            print(
                "[restore] ✗ 复核失败：图标已被重新隐藏（自愈抢回）——"
                "**必须先停掉 handy.exe 再跑本脚本**。桌面目前是空白状态，请重跑。"
            )
            return 2
        print(f"[restore] ✓ 复核通过：等了 {int(SELF_HEAL_WINDOW_S)} 秒仍可见（自愈未抢回）")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
