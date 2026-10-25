import type { ModuleMeta } from '@/core/types';

/**
 * 便签模块元数据（V61 引入，V70 改版）。
 *
 * 视图 `notes/NoteListView`：**完整便签编辑页**——左侧列表 + 右侧 Markdown 编辑器
 * （边写边渲染 + 自动保存），置顶 / 转待办 / 贴桌面（右键）一应俱全。数据与独立
 * 便签窗（`window=note-<id>`）同源（SQLite + 跨窗口总线），无重复实现。
 *
 * 与「工作台」（id `notes`）的关系（V70 起不再重叠）：工作台只做日历/计划聚合，
 * 便签的创建与编辑统一收敛到本页。
 */
const stickyModule = {
  id: 'sticky',
  name: '便签',
  description: '便签管理 · 页面内边写边渲染 · 贴到桌面',
  icon: 'NotebookPen',
  order: 30,
  surface: ['panel'],
  tier: 'free',
  sidebar: true,
  keywords: [
    '便签',
    '笔记',
    '便签列表',
    '编辑',
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
