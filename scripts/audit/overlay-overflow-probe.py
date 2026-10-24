"""V59 追加排查：桌面画布为什么能滚轮滚动。

思路：根画布是 `fixed inset-0 overflow-y-auto`，它的可滚动溢出区只可能来自
**绝对定位的子元素超出视口高度**。本脚本把两侧的几何都算出来，直接指出超出的元素。

度量来源必须与 Rust `grid.rs` 完全一致：
  ARRANGE_MARGIN = 32   GRID_GAP = 6   CELL_EXTRA_W = 32   CELL_EXTRA_H = 30
  LOOSE_MAX_COLUMNS = 4
"""
import ctypes
import ctypes.wintypes as wt
import os
import sqlite3
import sys

ARRANGE_MARGIN = 32
GRID_GAP = 6
CELL_EXTRA_W = 32
CELL_EXTRA_H = 30
LOOSE_MAX_COLUMNS = 4

SPI_GETWORKAREA = 0x0030


def screen_and_work_area():
    """返回 (屏幕宽高, 工作区 (l,t,r,b))，单位物理像素。"""
    u = ctypes.windll.user32
    u.SetProcessDPIAware()
    sw, sh = u.GetSystemMetrics(0), u.GetSystemMetrics(1)
    rect = wt.RECT()
    ok = u.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(rect), 0)
    if not ok:
        return (sw, sh), None
    return (sw, sh), (rect.left, rect.top, rect.right, rect.bottom)


def desktop_icon_size():
    """读 HKCU\\...\\Bags\\1\\Desktop 的 IconSize（Rust `read_desktop_icon_size`）。"""
    import winreg
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\Shell\Bags\1\Desktop",
        ) as key:
            value, _ = winreg.QueryValueEx(key, "IconSize")
            return int(value)
    except OSError:
        return None


def desktop_dir():
    import winreg
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
        ) as key:
            value, _ = winreg.QueryValueEx(key, "Desktop")
            return os.path.expandvars(value)
    except OSError:
        return os.path.join(os.path.expanduser("~"), "Desktop")


def db_path():
    appdata = os.environ.get("APPDATA", "")
    return os.path.join(appdata, "com.handy.desktop", "handy.db")


def registered_paths(db):
    conn = sqlite3.connect(db)
    try:
        rows = conn.execute("SELECT DISTINCT file_path FROM grid_items").fetchall()
    finally:
        conn.close()
    return {r[0] for r in rows}


def loose_strip_rect(work_w, work_h, count, icon):
    """Rust `loose_strip_rect` 的逐行复刻。"""
    if count == 0:
        return None
    work_w = work_w if work_w > 0 else 1280
    work_h = work_h if work_h > 0 else 720
    icon = max(16, min(256, icon))
    cell_w = icon + CELL_EXTRA_W
    cell_h = icon + CELL_EXTRA_H
    pitch_y = cell_h + GRID_GAP
    avail_h = max(work_h - 2 * ARRANGE_MARGIN, cell_h)
    rows_per_col = max(avail_h // pitch_y, 1)
    n = count
    columns = max(1, min(LOOSE_MAX_COLUMNS, (n + rows_per_col - 1) // rows_per_col))
    rows = (n + columns - 1) // columns
    w = min(
        columns * cell_w + (columns - 1) * GRID_GAP,
        max(work_w - 2 * ARRANGE_MARGIN, cell_w),
    )
    h = max(min(rows * pitch_y - GRID_GAP, avail_h), cell_h)
    return {
        "x": ARRANGE_MARGIN,
        "y": ARRANGE_MARGIN,
        "w": w,
        "h": h,
        "columns": columns,
        "rows": rows,
        # 前端实际画出来的高度 = rows*cell_h + (rows-1)*gap
        "rendered_h": rows * cell_h + (rows - 1) * GRID_GAP,
        "clamped": rows * pitch_y - GRID_GAP > avail_h,
    }


def main():
    (sw, sh), area = screen_and_work_area()
    print("=== 屏幕 ===")
    print(f"  物理尺寸 {sw} x {sh}")
    if area:
        print(f"  工作区 (l,t,r,b) = {area}  → {area[2]-area[0]} x {area[3]-area[1]}")
    icon = desktop_icon_size()
    print(f"  桌面图标尺寸（注册表 IconSize）= {icon}")

    db = db_path()
    print(f"\n=== 库 {db} ===")
    print(f"  存在 = {os.path.exists(db)}")
    reg = registered_paths(db) if os.path.exists(db) else set()
    print(f"  已登记条目（grid_items 去重路径）= {len(reg)}")

    dd = desktop_dir()
    print(f"\n=== 桌面目录 {dd} ===")
    entries = []
    if os.path.isdir(dd):
        entries = [e for e in os.listdir(dd) if not e.lower() == "desktop.ini"]
    print(f"  磁盘条目 = {len(entries)}")
    loose = [e for e in entries if os.path.join(dd, e) not in reg]
    print(f"  未登记（潜在未归类）= {len(loose)}")

    # 系统图标（此电脑 / 回收站…）也进竖条，无法离线精确枚举，按注册表开关估个下限
    print("  注：竖条另含系统图标（此电脑/回收站等），实际条目数 ≥ 上面这个数")

    work_w, work_h = (area[2] - area[0], area[3] - area[1]) if area else (sw, sh)
    print(f"\n=== 竖条几何复算（work = {work_w} x {work_h}, icon = {icon or 48}）===")
    for count in sorted({len(loose), len(loose) + 4, len(loose) + 8, 40, 60, 80}):
        s = loose_strip_rect(work_w, work_h, count, icon or 48)
        if s is None:
            print(f"  count={count:3d} → 无竖条")
            continue
        bottom = s["y"] + s["h"]
        flag = ""
        if s["rendered_h"] > s["h"]:
            flag += f"  ← 前端内容比区域高 {s['rendered_h'] - s['h']}px（溢出！）"
        if bottom > work_h:
            flag += f"  ← 区域底 {bottom} 超过工作区高 {work_h}"
        print(
            f"  count={count:3d} → cols={s['columns']} rows={s['rows']} "
            f"rect=({s['x']},{s['y']},{s['w']}x{s['h']}) 前端渲染高={s['rendered_h']} "
            f"底={bottom} clamped={s['clamped']}{flag}"
        )

    print("\n=== 收纳格实际下沿（DB 里的 pos_y + height）===")
    if os.path.exists(db):
        conn = sqlite3.connect(db)
        rows = conn.execute(
            "SELECT name, pos_x, pos_y, width, height, kind FROM grid_boxes ORDER BY pos_y + height DESC LIMIT 5"
        ).fetchall()
        conn.close()
        for name, x, y, w, h, kind in rows:
            print(f"  {kind:6s} {name:14s} x={x:5d} y={y:5d} w={w:4d} h={h:4d} → 下沿={y+h} 右沿={x+w}")
    print()


if __name__ == "__main__":
    sys.exit(main())
