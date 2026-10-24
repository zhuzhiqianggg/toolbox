"""读真实库的 `grid_boxes`（只读）—— 排布事故取证用。

# 用法

    python scripts/audit/grid-boxes-dump.py

按 `pos_x` 排序打印每个格子的 kind / id / 位置 / 宽高 / 条目数，
并顺带把「同一 x 区间里既住着挂件又住着收纳格」的**串列**情况标出来 ——
这正是用户反馈「便签跟格子挤在一列里，不好看」的判据。
"""
import os
import sqlite3
import sys

DB_PATH = os.path.join(os.environ['APPDATA'], 'com.handy.desktop', 'handy.db')
WIDGET_KINDS = {'calendar', 'note', 'weather', 'workstation', 'clock', 'todo'}


def main() -> int:
    print('db =', DB_PATH, '| exists =', os.path.exists(DB_PATH))
    if not os.path.exists(DB_PATH):
        return 0
    uri = 'file:' + DB_PATH.replace(os.sep, '/') + '?mode=ro'
    conn = sqlite3.connect(uri, uri=True)
    cols = [r[1] for r in conn.execute('pragma table_info(grid_boxes)')]
    print('grid_boxes 列：', ', '.join(cols))
    rows = list(conn.execute(
        'select kind, id, name, pos_x, pos_y, width, height '
        'from grid_boxes order by pos_x, pos_y'
    ))
    items = dict(conn.execute(
        'select box_id, count(*) from grid_items group by box_id'
    ))
    print(f'\n共 {len(rows)} 个格子：')
    for kind, bid, name, x, y, w, h in rows:
        tag = 'WIDGET' if kind in WIDGET_KINDS else 'box   '
        n = items.get(bid, 0)
        print(f'  [{tag}] {kind:<12} {str(name)[:14]:<16} '
              f'x={x:<5} y={y:<5} w={w:<4} h={h:<4} items={n:<3}')

    # 串列检测：收纳格的中心落在某个挂件的 x 区间内 → 视觉上「挤在一列」
    widgets = [r for r in rows if r[0] in WIDGET_KINDS]
    boxes = [r for r in rows if r[0] not in WIDGET_KINDS]
    bad = []
    for kind, bid, name, x, y, w, h in boxes:
        for wk, _, wn, wx, _, ww, _ in widgets:
            if x < wx + ww and wx < x + w:
                bad.append((kind, name, x, wk, wn, wx, ww))
    if bad:
        print('\n⚠ 收纳格与挂件在同一 x 区间（视觉串列）：')
        for kind, name, x, wk, wn, wx, ww in bad:
            print(f'  {kind}/{name} x={x} ↔ {wk}/{wn} x={wx} w={ww}')
    else:
        print('\n✓ 没有收纳格与挂件串列')
    conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
