"""真机库全量取证（只读）—— 排布 / 挂件事故排查用。

    python scripts/audit/db-probe.py

打印：表清单、grid_meta、grid_boxes 全字段、各 kind 计数。
"""
import os
import sqlite3
import sys

DB_PATH = os.path.join(os.environ['APPDATA'], 'com.zhuzhiqiang.toolbox', 'toolbox.db')


def main() -> int:
    print('db =', DB_PATH, '| exists =', os.path.exists(DB_PATH))
    if not os.path.exists(DB_PATH):
        return 0
    uri = 'file:' + DB_PATH.replace(os.sep, '/') + '?mode=ro'
    conn = sqlite3.connect(uri, uri=True)
    print('\n表：', [r[0] for r in conn.execute(
        "select name from sqlite_master where type='table' order by name")])
    print('\ngrid_meta：')
    try:
        for key, value in conn.execute('select key, value from grid_meta order by key'):
            print(f'  {key} = {value}')
    except sqlite3.Error as err:
        print('  (无)', err)
    print('\ngrid_boxes（按 kind, pos_x）：')
    for row in conn.execute(
        'select id, kind, name, pos_x, pos_y, width, height, sort, '
        'coalesce(substr(content,1,40),\'\') from grid_boxes '
        'order by kind, pos_x, pos_y'
    ):
        print('  ', row)
    print('\nkind 计数：')
    for row in conn.execute('select kind, count(*) from grid_boxes group by kind'):
        print('  ', row)
    conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
