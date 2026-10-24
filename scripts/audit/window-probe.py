"""桌面挂件窗「隔空体检」——不需要看见屏幕，也能知道窗口到底怎么了。

# 为什么需要它

本项目最难的排查场景是**窗口看似消失**：格子层是一个贴在桌面正上方的透明浮层，
它「不见了」有四种完全不同的成因，而用户描述的永远是同一句话（「闪一下就没有了」）：

| 成因 | 窗口自身的表现 |
| --- | --- |
| 层级被顶到别的窗口上面 | `vis=True`，但 Z 序位置偏上 |
| 被压在桌面**下面** | `vis=True`，但 Z 序在 Progman 之下 |
| 被最小化 / 隐藏 | `vis=False` 或 `iconic=True` |
| 层级没问题，是**前端没画出内容** | `vis=True` 且 Z 序正确，但窗口内容是空的 |

肉眼看不出区别，而 agent 会话里**看不到屏幕**（本机 GUI 也起不来）。
所以这个脚本换一条路：**直接问系统要事实**。

# 用法

    python scripts/audit/window-probe.py zlist              # 列出桌面附近的真实 Z 序
    python scripts/audit/window-probe.py zlist --all        # 连完整列表一起打印
    python scripts/audit/window-probe.py render             # 把挂件窗自身内容渲染成 PNG
    python scripts/audit/window-probe.py shot               # 抓整屏（会被其它窗口挡住）

产物写在 `.build-logs/`：`zlist.json` / `overlay-content.png` / `screen.png`。

# 判定要点

- `zlist` 里 **`Progman` 是 Z 序最底**；挂件窗应当紧挨在它上面（中间可以夹窗口）。
- `reassert_attach` 报的 `below=0x...` 就来自这里 —— 拿这个十六进制值去 `zlist`
  里对类名，一眼就能看出「夹在中间的是谁」（本机是搜狗输入法的隐藏助手窗）。
- `render` 显示不出格子 / 便签 ⇒ 问题在前端，与窗口层级无关。

# 环境备注

本机 PowerShell 通道的 `Add-Type` 被安全层拦截，所以这里**不依赖 PowerShell**，
只用 ctypes + 手写 PNG 编码（不装 PIL）。
"""
import ctypes
import json
import os
import struct
import sys
import zlib
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)
gdi32 = ctypes.WinDLL('gdi32', use_last_error=True)

# —— 常量 ——
GW_HWNDNEXT = 2
GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TRANSPARENT = 0x00000020
PW_RENDERFULLCONTENT = 0x00000002
SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
BI_RGB = 0

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '.build-logs')

# —— 签名 ——
user32.GetTopWindow.restype = wintypes.HWND
user32.GetTopWindow.argtypes = [wintypes.HWND]
user32.GetWindow.restype = wintypes.HWND
user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetClassNameW.restype = ctypes.c_int
user32.GetClassNameW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL
user32.IsIconic.argtypes = [wintypes.HWND]
user32.GetWindowRect.restype = wintypes.BOOL
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetDC.restype = wintypes.HDC
user32.GetDC.argtypes = [wintypes.HWND]
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
user32.PrintWindow.restype = wintypes.BOOL
user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
user32.GetSystemMetrics.restype = ctypes.c_int
user32.GetSystemMetrics.argtypes = [ctypes.c_int]

gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.BitBlt.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                         ctypes.c_int, wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD), ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", ctypes.c_long), ("biYPelsPerMeter", ctypes.c_long),
        ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


gdi32.GetDIBits.restype = ctypes.c_int
gdi32.GetDIBits.argtypes = [
    wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
    ctypes.c_void_p, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
]


def write_png(path, w, h, rows):
    """rows：自上而下，每行 w*3 的 RGB bytes。"""
    raw = b''.join(b'\x00' + r for r in rows)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(raw, 6))
    out += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(out)


def _cls(h):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(h, buf, 256)
    return buf.value


def _title(h):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(h, buf, 256)
    return buf.value


def walk_top_level(limit=4000):
    """按 Z 序从顶到底返回全部顶层窗口（index 0 = 最上面）。"""
    rows = []
    h = user32.GetTopWindow(None)
    while h and len(rows) < limit:
        r = wintypes.RECT()
        user32.GetWindowRect(h, ctypes.byref(r))
        ex = user32.GetWindowLongPtrW(h, GWL_EXSTYLE) & 0xFFFFFFFF
        rows.append({
            "idx": len(rows),
            "hwnd": "0x%x" % h,
            "class": _cls(h),
            "title": _title(h)[:48],
            "visible": bool(user32.IsWindowVisible(h)),
            "iconic": bool(user32.IsIconic(h)),
            "rect": [r.left, r.top, r.right - r.left, r.bottom - r.top],
            "ex": "0x%08x" % ex,
            "layered": bool(ex & WS_EX_LAYERED),
            "tool": bool(ex & WS_EX_TOOLWINDOW),
            "noact": bool(ex & WS_EX_NOACTIVATE),
        })
        h = user32.GetWindow(h, GW_HWNDNEXT)
    return rows


def cmd_zlist(argv):
    show_all = '--all' in argv
    rows = walk_top_level()
    print("顶层窗口总数 = %d" % len(rows))

    prog = next((i for i, x in enumerate(rows) if x["class"] == "Progman"), None)
    print("Progman 序号 = %s（这应该就是最后一个：桌面是 Z 序最底）" % prog)

    def dump(title, items):
        print()
        print("=== %s ===" % title)
        for x in items:
            print("%4d %-16s vis=%-5s ico=%-5s rect=%-22s ex=%s L=%d T=%d N=%d  %s"
                  % (x["idx"], x["class"][:16], x["visible"], x["iconic"],
                     "%d,%d %dx%d" % tuple(x["rect"]), x["ex"],
                     x["layered"], x["tool"], x["noact"], x["title"]))

    if show_all:
        dump("全部", rows)
    else:
        tail = 20
        dump("末尾 %d 个（Z 序最底 / 桌面附近）" % tail, rows[-tail:])

    dump("所有 Tauri Window（挂件窗 / 主窗 / 贴条）",
         [x for x in rows if "Tauri" in x["class"]])

    print()
    print("=== 每个 Tauri Window 的正下方是谁（reassert 的 below 就是这里）===")
    for i, x in enumerate(rows):
        if "Tauri" in x["class"] and i + 1 < len(rows):
            n = rows[i + 1]
            print("  %s 下面 = %s(%s) vis=%s rect=%s"
                  % (x["hwnd"], n["hwnd"], n["class"], n["visible"],
                     "%d,%d %dx%d" % tuple(n["rect"])))

    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "zlist.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)
    print()
    print("完整列表已写入 %s" % os.path.normpath(path))
    return 0


def find_overlay():
    for i, x in enumerate(walk_top_level()):
        if x["class"] == "Tauri Window" and "挂件" in x["title"]:
            return int(x["hwnd"], 16), x
    return None, None


def _render(hwnd, w, h, via_printwindow):
    src = user32.GetDC(hwnd if via_printwindow else None)
    mem = gdi32.CreateCompatibleDC(src)
    bmp = gdi32.CreateCompatibleBitmap(src, w, h)
    old = gdi32.SelectObject(mem, bmp)
    if via_printwindow:
        ok = user32.PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT)
        label = "PrintWindow(PW_RENDERFULLCONTENT) = %s err=%d" % (
            "成功" if ok else "失败", ctypes.get_last_error())
    else:
        ok = gdi32.BitBlt(mem, 0, 0, w, h, src, 0, 0, SRCCOPY)
        label = "BitBlt = %s err=%d" % ("成功" if ok else "失败", ctypes.get_last_error())
    print(label)

    bi = BITMAPINFO()
    bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.bmiHeader.biWidth = w
    bi.bmiHeader.biHeight = -h
    bi.bmiHeader.biPlanes = 1
    bi.bmiHeader.biBitCount = 32
    bi.bmiHeader.biCompression = BI_RGB
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), DIB_RGB_COLORS)

    data = buf.raw
    rows = []
    nonblack = 0
    for y in range(h):
        s = data[y * w * 4:(y + 1) * w * 4]
        row = bytearray(w * 3)
        row[0::3] = s[2::4]
        row[1::3] = s[1::4]
        row[2::3] = s[0::4]
        rows.append(bytes(row))
        if y % 7 == 0:
            for x in range(0, w, 7):
                o = x * 4
                if s[o] or s[o + 1] or s[o + 2]:
                    nonblack += 1
    sampled = max(1, len(range(0, h, 7)) * len(range(0, w, 7)))
    print("采样非黑像素 = %.1f%%（≈0%% 说明这个窗口什么都没画）"
          % (100.0 * nonblack / sampled))

    gdi32.SelectObject(mem, old)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(hwnd if via_printwindow else None, src)
    return rows


def cmd_render(_argv):
    hwnd, info = find_overlay()
    if hwnd is None:
        print("没找到挂件窗（标题含「挂件」的 Tauri Window）——应用可能没在跑")
        return 1
    w, h = info["rect"][2], info["rect"][3]
    print("挂件窗 %s 标题=%r 位置=(%d,%d) 尺寸=%dx%d vis=%s ico=%s"
          % (info["hwnd"], info["title"], info["rect"][0], info["rect"][1],
             w, h, info["visible"], info["iconic"]))
    rows = _render(hwnd, w, h, via_printwindow=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "overlay-content.png")
    write_png(path, w, h, rows)
    print("已写出 %s" % os.path.normpath(path))
    return 0


def cmd_shot(_argv):
    w, h = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    print("主屏 %dx%d" % (w, h))
    rows = _render(None, w, h, via_printwindow=False)
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "screen.png")
    write_png(path, w, h, rows)
    print("已写出 %s（注意：会被前台窗口挡住，看挂件层请用 render）" % os.path.normpath(path))
    return 0


COMMANDS = {"zlist": cmd_zlist, "render": cmd_render, "shot": cmd_shot}


def main(argv):
    if len(argv) < 2 or argv[1] not in COMMANDS:
        print(__doc__)
        print("可用子命令：%s" % ", ".join(COMMANDS))
        return 2
    return COMMANDS[argv[1]](argv[2:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
