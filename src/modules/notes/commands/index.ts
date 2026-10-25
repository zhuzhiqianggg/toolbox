import type { CommandMeta } from '@/core/types';
import { createNote } from '@/core/data/notesService';
import { useNotesStore } from '@/stores/useNotesStore';
import { openModule } from '@/core/navigation';

/**
 * 工作台（原「便签·待办」M3）命令清单。
 *
 * V70 调整（用户反馈「工作台和便签重叠，便签编辑不方便」——便签从工作台面板摘除，
 * 完整编辑体验收敛到侧栏「便签」页 `modules/notes/NoteListView`）：
 *   - `note-create`：落库后切到「便签」页（列表 + 分屏 Markdown 编辑器，自动选中新建的便签）；
 *   - `note-list`：直接打开「便签」页；
 *   - `todo-list` 保持原样：整屏待办管理（优先级 / 到期 / 提醒 / 互转）仍在这里。
 *
 * 数据层不动：笔记仍是 `notes` 表，经 `useNotesStore` 读写，历史数据零迁移。
 */
export const notesCommands: CommandMeta[] = [
  {
    id: 'note-create',
    moduleId: 'notes',
    name: '新建便签',
    description: '在便签页新建一条 Markdown 便签（边写边渲染）',
    icon: 'StickyNote',
    aliases: ['new note', 'add note'],
    keywords: ['新建', '笔记', '便签', '记事', 'xj', 'xinjian', 'bj', 'biji'],
    tier: 'free',
    run: async () => {
      const note = await createNote({ title: '新便签', body: '' });
      // 便签页的 focusRequest 联动会定位到新建这条（与待办「打开来源便签」同机制）
      useNotesStore.getState().requestFocus(note.id);
      openModule('sticky');
    },
  },
  {
    id: 'note-list',
    moduleId: 'notes',
    name: '便签',
    description: '打开便签页（列表 + Markdown 分屏编辑）',
    icon: 'StickyNote',
    aliases: ['notes'],
    keywords: ['笔记', '便签', '列表', '管理', 'notes', 'bj', 'biji', 'lb'],
    tier: 'free',
    run: () => {
      openModule('sticky');
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
