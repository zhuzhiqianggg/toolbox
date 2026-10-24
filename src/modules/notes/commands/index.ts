import type { CommandMeta } from '@/core/types';
import { createNote } from '@/core/data/notesService';
import { openModule } from '@/core/navigation';

/**
 * 工作台（原「便签·待办」M3）命令清单。
 *
 * V18 调整（用户反馈「不要便签了，便签该放进工作台」）：
 *   - **取消桌面悬浮便签窗入口**：`note-create` 改为「在工作台里新建笔记」——
 *     落库后直接切到工作台面板（笔记列表 + 分屏 Markdown 编辑器），
 *     不再创建一个独立悬浮窗口；
 *   - `note-list` 同样收敛为「打开工作台」，避免出现第二套笔记界面；
 *     （原全屏列表视图 `NoteListView` 与悬浮窗 `NoteWindow` 代码保留休眠，未删除）
 *   - `todo-list` 保持原样：整屏待办管理（优先级 / 到期 / 提醒 / 互转）仍在这里。
 *
 * 数据层不动：笔记仍是 `notes` 表，经 `useNotesStore` 读写，历史数据零迁移。
 */
export const notesCommands: CommandMeta[] = [
  {
    id: 'note-create',
    moduleId: 'notes',
    name: '新建笔记',
    description: '在工作台里新建一条 Markdown 笔记（边写边渲染）',
    icon: 'StickyNote',
    aliases: ['new note', 'add note'],
    keywords: ['新建', '笔记', '便签', '记事', 'xj', 'xinjian', 'bj', 'biji'],
    tier: 'free',
    run: async () => {
      await createNote({ title: '新笔记', body: '' });
      openModule('notes');
    },
  },
  {
    id: 'note-list',
    moduleId: 'notes',
    name: '笔记',
    description: '打开工作台内的笔记面板（Markdown 分屏编辑）',
    icon: 'StickyNote',
    aliases: ['notes'],
    keywords: ['笔记', '便签', '列表', '管理', 'notes', 'bj', 'biji', 'lb'],
    tier: 'free',
    run: () => {
      openModule('notes');
    },
  },
  {
    id: 'todo-list',
    moduleId: 'notes',
    name: '待办清单',
    description: '查看与管理待办任务、到期提醒',
    icon: 'ClipboardList',
    aliases: ['todo', 'todos'],
    keywords: ['待办', '清单', '任务', '提醒', '到期', 'todo', 'db', 'qd'],
    layout: 'full',
    tier: 'free',
    load: () => import('@/modules/todos/TodoView'),
  },
];
