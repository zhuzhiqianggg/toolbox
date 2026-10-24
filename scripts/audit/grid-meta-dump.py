"""读 / 清理真实库的 `grid_meta` —— 装机前后的接管态检查。

# 用法

    python scripts/audit/grid-meta-dump.py                     # 只读：列出全部键值
    python scripts/audit/grid-meta-dump.py --clear-icons-hidden  # 把 desktop_icons_hidden 置 '0'

# 为什么需要它

装机铁律（CONVENTIONS §26）要求：接管态下停进程后必须**立刻**归还桌面图标，
并且把 `grid_meta.desktop_icons_hidden` 清成 `'0'` —— 否则下次启动
`heal_desktop_icons` 会认为「上次退出时图标是藏着的」而白跑一次恢复。
`sqlite3` 命令行不在本机 PATH 里，Python 标准库自带 `sqlite3`，所以走这条路。
"""
import os
import sqlite3
import sys

DB_PATH = os.path.join(os.environ['APPDATA'], 'com.handy.desktop', 'handy.db')
ICONS_HIDDEN_KEY = 'desktop_icons_hidden'


def dump_readonly(path: str) -> int:
    uri = 'file:' + path.replace(os.sep, '/') + '?mode=ro'
    conn = sqlite3.connect(uri, uri=True)
    try:
        rows = list(conn.execute('select key, value from grid_meta order by key'))
    except sqlite3.Error as err:
        print('读取 grid_meta 失败：', err)
        return 0
    if not rows:
        print('(grid_meta 为空)')
    for key, value in rows:
        print(f'  {key} = {value}')
    return 0


def clear_icons_hidden(path: str) -> int:
    conn = sqlite3.connect(path)
    with conn:
        changed = conn.execute(
            'update grid_meta set value = ?1 where key = ?2',
            ('0', ICONS_HIDDEN_KEY),
        ).rowcount
    conn.close()
    print(f'desktop_icons_hidden → \'0\'（影响 {changed} 行）')
    return 0


def main(argv) -> int:
    print('db =', DB_PATH, '| exists =', os.path.exists(DB_PATH))
    if not os.path.exists(DB_PATH):
        return 0
    if '--clear-icons-hidden' in argv:
        return clear_icons_hidden(DB_PATH)
    return dump_readonly(DB_PATH)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
