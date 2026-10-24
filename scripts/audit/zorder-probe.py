"""复刻 Rust 侧 `desktop_host()` + `z_verdict()` 的判定过程，用来核对「层级到底错没错」。

# 为什么需要它

V45 装机后用户反馈「点一下桌面空白处，整理好的桌面整个不见了」，而日志里是
**265 条** `Z 序不对（TooHigh，第 N 次纠正）` —— 每 6 秒纠正一次、连续 5 次后
退避 300 秒，等于「自愈废了 + 一直在重排」。

但同一次运行里 `window-probe.py zlist` 明确显示：

    Tauri Window 0x21098 下面 = 0x10158(Progman)

这是**完全正确**的层级。于是问题不在窗口位置，而在**判据本身判错了**
（旧结论：`classify_chain` 只在「往下一路走到 Z 序末端都没碰到 host」时才给
`BelowDesktop`，其余情况一律 `TooHigh`）。

本脚本把 Rust 侧那段逻辑用 ctypes 原样重放一遍，并额外打印：
  · `desktop_host()` 实际选中了哪个窗口（Progman 还是某个 WorkerW）；
  · Progman / 各个 WorkerW 的子窗口树（SHELLDLL_DefView 挂在哪一层）；
  · 从挂件窗往下走 24 步**每一步**的类名 —— 一眼看出链子在哪断的。

# 用法

    python scripts/audit/zorder-probe.py                 # 自动找挂件窗
    python scripts/audit/zorder-probe.py --hwnd 0x21098  # 指定窗口
"""
import ctypes
import sys
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)

GW_HWNDNEXT = 2
REASSERT_SCAN_STEPS = 24  # 必须与 grid.rs 的常量一致

user32.FindWindowW.restype = wintypes.HWND
user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.FindWindowExW.restype = wintypes.HWND
user32.FindWindowExW.argtypes = [wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR]
user32.GetWindow.restype = wintypes.HWND
user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetClassNameW.restype = ctypes.c_int
user32.GetClassNameW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.IsWindowVisible.argtypes = [wintypes.HWND]


def cls(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def title(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, buf, 256)
    return buf.value


def vis(hwnd) -> bool:
    return bool(user32.IsWindowVisible(hwnd))


def describe(hwnd) -> str:
    if not hwnd:
        return '(null)'
    return f'{hex(hwnd)} {cls(hwnd)!r} vis={vis(hwnd)} title={title(hwnd)!r}'


# —— 复刻 grid.rs::desktop_host() ——
def desktop_host():
    progman = user32.FindWindowW('Progman', None)
    if progman:
        def_view = user32.FindWindowExW(progman, None, 'SHELLDLL_DefView', None)
        if def_view:
            return progman, 'Progman(直接挂 SHELLDLL_DefView)'
    current = None
    for _ in range(32):
        worker = user32.FindWindowExW(None, current, 'WorkerW', None)
        if not worker:
            break
        def_view = user32.FindWindowExW(worker, None, 'SHELLDLL_DefView', None)
        if def_view:
            return worker, 'WorkerW(顶层，直接挂 SHELLDLL_DefView)'
        current = worker
    return None, '未找到'


def children(hwnd, depth=0, out=None):
    """列出 hwnd 的直接子窗口（递归两层，够看清 SHELLDLL_DefView 挂在哪）。"""
    if out is None:
        out = []
    if depth > 2 or not hwnd:
        return out
    child = user32.FindWindowExW(hwnd, None, None, None)
    while child:
        out.append('  ' * depth + describe(child))
        children(child, depth + 1, out)
        child = user32.FindWindowExW(hwnd, child, None, None)
    return out


def find_overlay() -> int:
    """按标题找挂件窗（`桌面挂件 · Handy`）。"""
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        if '桌面挂件' in title(hwnd):
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(cb, 0)
    return found[0] if found else 0


def main(argv) -> int:
    hwnd = 0
    if '--hwnd' in argv:
        hwnd = int(argv[argv.index('--hwnd') + 1], 16)
    if not hwnd:
        hwnd = find_overlay()
    if not hwnd:
        print('未找到挂件窗（Handy 未运行？）')
        return 1

    print('=== 挂件窗 ===')
    print(' ', describe(hwnd))

    host, how = desktop_host()
    print('=== desktop_host() 的判定 ===')
    print(f'  {how} → {describe(host)}')

    print('=== Progman 子窗口树 ===')
    progman = user32.FindWindowW('Progman', None)
    for line in children(progman):
        print(' ', line)

    print('=== 从挂件窗往下走（GW_HWNDNEXT，最多 %d 步）===' % REASSERT_SCAN_STEPS)
    cursor = hwnd
    chain = []
    hit_bottom = False
    for i in range(REASSERT_SCAN_STEPS):
        nxt = user32.GetWindow(cursor, GW_HWNDNEXT)
        if not nxt:
            hit_bottom = True
            print(f'  {i + 1}: (Z 序末端)')
            break
        chain.append(nxt)
        mark = ''
        if nxt == host:
            mark = '   ← 命中 desktop_host（判据应当通过）'
        elif cls(nxt) in ('Progman', 'WorkerW'):
            mark = '   ← 桌面类窗口'
        print(f'  {i + 1}: {describe(nxt)}{mark}')
        if nxt == host:
            break
        cursor = nxt

    print('=== 复刻 classify_chain() 的结论 ===')
    if host in chain:
        verdict = 'InDesktopBand（层级正确，不该纠正）'
    elif hit_bottom:
        verdict = 'BelowDesktop（被压在桌面下面）'
    else:
        verdict = f'TooHigh（走满 {REASSERT_SCAN_STEPS} 步没碰到 host）'
    print(f'  → {verdict}')
    print('  ⚠️ 若上面输出 InDesktopBand 而应用日志里仍在刷 TooHigh，'
          '说明 Rust 侧拿到的 host 与本脚本不同（见 Progman 子窗口树）。')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
