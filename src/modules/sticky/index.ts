import type { ModuleMeta } from '@/core/types';

/**
 * 便签模块元数据（V61）。
 *
 * 视图复用 `notes/NoteListView`（便签列表：新建 / 独立窗打开 / 置顶 / 删除 / 转待办），
 * 数据与独立便签窗（`window=note-<id>`）同源（SQLite + 跨窗口总线），无重复实现。
 *
 * 与「工作台」（id `notes`）的关系：工作台是聚合面板（日历/计划/速记），本模块是
 * 便签的列表管理页；两边指向同一份 notesService 数据。
 */
const stickyModule = {
  id: 'sticky',
  name: '便签',
  description: '桌面便签列表 · 置顶 · 多彩快记',
  icon: 'NotebookPen',
  order: 30,
  surface: ['panel'],
  tier: 'free',
  sidebar: true,
  keywords: [
    '便签',
    '笔记',
    '便签列表',
    'sticky',
    'note',
    'bj',
    'bianqian',
  ],
  route: 'sticky',
  contributes: {
    commands: [],
  },
  loadView: () => import('../notes/NoteListView'),
} satisfies ModuleMeta;

export default stickyModule;
