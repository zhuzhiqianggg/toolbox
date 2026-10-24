import React, { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  CalendarDays,
  ListTodo,
  Pencil,
  Plus,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { useTodosStore } from '@/stores/useTodosStore';
import { useNotesStore } from '@/stores/useNotesStore';
import {
  TODO_PRIORITIES,
  type Todo,
  createNoteFromTodo,
  priorityStyle,
} from '@/core/data/todosService';
import { openModule } from '@/core/navigation';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * 待办清单视图（V09）。
 *
 * 双承载：主面板内页与命令视图（「待办清单」命令）复用。
 * 提供：新建（标题 + 优先级 + 到期 + 提醒）、完成切换、过滤、编辑、
 * 转为笔记（互转）、在工作台打开来源笔记、删除；空态 / 错误态齐备。
 *
 * V18 变更：原先「来源便签」会弹独立桌面悬浮窗，现改为切到工作台的笔记面板并定位到该条
 * （见 `handleOpenSourceNote`）；`NoteWindow` / `NoteListView` 仍保留但无入口，属休眠代码。
 */

/** 提醒偏移选项（相对到期时间；提前量超过 1 天的场景用自定义编辑覆盖） */
const REMIND_OPTIONS: { id: string; name: string; offsetMs: number }[] = [
  { id: 'none', name: '不提醒', offsetMs: 0 },
  { id: 'due', name: '到期时', offsetMs: 0 },
  { id: '10m', name: '提前 10 分钟', offsetMs: 10 * 60 * 1000 },
  { id: '1h', name: '提前 1 小时', offsetMs: 60 * 60 * 1000 },
  { id: '1d', name: '提前 1 天', offsetMs: 24 * 60 * 1000 },
];

type FilterKind = 'all' | 'open' | 'done';

/** datetime-local 输入值（'yyyy-MM-ddTHH:mm'）→ Unix 毫秒（空串 → null） */
function parseLocalInput(value: string): number | null {
  if (value.trim().length === 0) {
    return null;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Unix 毫秒 → datetime-local 输入值（null → ''） */
function toLocalInput(ms: number | null): string {
  if (ms === null) {
    return '';
  }
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 依据提醒选项与到期时间计算 remind_at（无到期时提醒置空） */
function computeRemindAt(optionId: string, dueAt: number | null): number | null {
  if (dueAt === null || optionId === 'none') {
    return null;
  }
  const option = REMIND_OPTIONS.find((o) => o.id === optionId);
  if (!option || option.id === 'due') {
    return dueAt;
  }
  return Math.max(dueAt - option.offsetMs, 0);
}

/** 时间展示 */
function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface TodoViewProps {
  /** 兼容 CommandProps（命令视图注入，未使用） */
  initialInput?: string;
  /** 兼容 ModuleProps（模块内页注入，未使用） */
  windowKind?: string;
}

export default function TodoView(_props: TodoViewProps = {}): React.JSX.Element {
  const todos = useTodosStore((state) => state.todos);
  const loaded = useTodosStore((state) => state.loaded);
  const error = useTodosStore((state) => state.error);
  const hydrate = useTodosStore((state) => state.hydrate);

  const [filter, setFilter] = useState<FilterKind>('all');
  // —— 新建表单 ——
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState(1);
  const [newDue, setNewDue] = useState('');
  const [newRemind, setNewRemind] = useState('none');
  // —— 行内编辑 ——
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editPriority, setEditPriority] = useState(1);
  const [editDue, setEditDue] = useState('');
  const [editRemind, setEditRemind] = useState('none');

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const counts = useMemo(
    () => ({
      all: todos.length,
      open: todos.filter((t) => !t.done).length,
      done: todos.filter((t) => t.done).length,
    }),
    [todos],
  );

  const visible = useMemo(() => {
    if (filter === 'open') {
      return todos.filter((t) => !t.done);
    }
    if (filter === 'done') {
      return todos.filter((t) => t.done);
    }
    return todos;
  }, [todos, filter]);

  const handleAdd = (): void => {
    const title = newTitle.trim();
    if (title.length === 0) {
      return;
    }
    const dueAt = parseLocalInput(newDue);
    const remindAt = computeRemindAt(newRemind, dueAt);
    void useTodosStore
      .getState()
      .createTodo({ title, priority: newPriority, dueAt, remindAt })
      .then(() => {
        setNewTitle('');
        setNewPriority(1);
        setNewDue('');
        setNewRemind('none');
      })
      .catch((err: unknown) => toast.error(`新建待办失败：${err instanceof Error ? err.message : String(err)}`));
  };

  const startEdit = (todo: Todo): void => {
    setEditingId(todo.id);
    setEditTitle(todo.title);
    setEditPriority(todo.priority);
    setEditDue(toLocalInput(todo.dueAt));
    // 依据 remindAt 与 dueAt 的差值反推选项（差值不在预设中按「到期时」近似展示）
    let id = 'none';
    if (todo.remindAt !== null && todo.dueAt !== null) {
      const diff = todo.dueAt - todo.remindAt;
      id = REMIND_OPTIONS.find((o) => o.id !== 'none' && o.offsetMs === diff)?.id ?? 'due';
    }
    setEditRemind(id);
  };

  const handleSaveEdit = (): void => {
    if (!editingId) {
      return;
    }
    const dueAt = parseLocalInput(editDue);
    const remindAt = computeRemindAt(editRemind, dueAt);
    void useTodosStore
      .getState()
      .updateTodo(editingId, {
        title: editTitle.trim() || '未命名待办',
        priority: editPriority,
        dueAt,
        remindAt,
      })
      .then(() => setEditingId(null))
      .catch((err: unknown) => toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`));
  };

  const handleConvertToNote = (todo: Todo): void => {
    void createNoteFromTodo(todo)
      .then(() => toast.success('已转为笔记（可在工作台的笔记面板查看）'))
      .catch((err: unknown) => toast.error(`转为笔记失败：${err instanceof Error ? err.message : String(err)}`));
  };

  /**
   * 「打开来源笔记」：V18 起**不再弹桌面悬浮便签窗**，改为切到工作台的笔记面板并定位到该条
   * （对应用户反馈「不要便签了 —— 便签该放进工作台，不要悬浮到桌面」）。
   *
   * 定位通过 `useNotesStore.requestFocus` 传递：待办与工作台同在主窗口、共用同一 store 实例，
   * 所以不需要跨窗口 IPC 或额外路由参数。
   */
  const handleOpenSourceNote = (noteId: string): void => {
    useNotesStore.getState().requestFocus(noteId);
    openModule('notes');
  };

  const handleDelete = (id: string): void => {
    void useTodosStore.getState().deleteTodo(id).catch(() => undefined);
  };

  return (
    <div className="flex h-full flex-col">
      {/* 新建条 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <input
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              handleAdd();
            }
          }}
          placeholder="要做什么？回车快速添加"
          className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-brand"
        />
        <select
          value={newPriority}
          onChange={(event) => setNewPriority(Number(event.target.value))}
          className="h-8 rounded-md border bg-transparent px-1 text-xs text-foreground outline-none"
          title="优先级"
        >
          {TODO_PRIORITIES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          type="datetime-local"
          value={newDue}
          onChange={(event) => setNewDue(event.target.value)}
          className="h-8 rounded-md border bg-transparent px-1 text-xs text-foreground outline-none"
          title="到期时间"
        />
        <select
          value={newRemind}
          onChange={(event) => setNewRemind(event.target.value)}
          className="h-8 rounded-md border bg-transparent px-1 text-xs text-foreground outline-none"
          title="提醒"
        >
          {REMIND_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-brand px-3 text-xs font-medium text-white transition hover:bg-brand/90"
        >
          <Plus className="h-3.5 w-3.5" />
          添加
        </button>
      </div>

      {/* 过滤条 */}
      <div className="flex items-center gap-1 px-4 py-2 text-xs">
        {(
          [
            ['all', `全部 ${counts.all}`],
            ['open', `进行中 ${counts.open}`],
            ['done', `已完成 ${counts.done}`],
          ] as [FilterKind, string][]
        ).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            onClick={() => setFilter(kind)}
            className={cn(
              'rounded-full px-2.5 py-1 transition',
              filter === kind
                ? 'bg-brand text-white'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 错误态 */}
      {error && (
        <div className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          加载待办失败：{error}
        </div>
      )}

      {/* 空态 */}
      {loaded && visible.length === 0 && !error && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
          <ListTodo className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            {filter === 'done' ? '还没有已完成的待办' : '没有待办事项'}
          </p>
          <p className="text-xs text-muted-foreground/70">在上方输入并回车，随手记一条</p>
        </div>
      )}

      {/* 列表 */}
      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-4 pb-4">
        <div className="flex flex-col gap-1.5">
          {visible.map((todo) => {
            const prio = priorityStyle(todo.priority);
            const overdue = !todo.done && todo.dueAt !== null && todo.dueAt < Date.now();
            return editingId === todo.id ? (
              /* 行内编辑表单 */
              <div key={todo.id} className="rounded-lg border border-brand/40 bg-muted/40 p-2.5">
                <div className="flex items-center gap-2">
                  <input
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                    className="h-7 min-w-0 flex-1 rounded border bg-transparent px-2 text-sm text-foreground outline-none"
                    autoFocus
                  />
                  <select
                    value={editPriority}
                    onChange={(event) => setEditPriority(Number(event.target.value))}
                    className="h-7 rounded border bg-transparent px-1 text-xs text-foreground outline-none"
                  >
                    {TODO_PRIORITIES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="datetime-local"
                    value={editDue}
                    onChange={(event) => setEditDue(event.target.value)}
                    className="h-7 rounded border bg-transparent px-1 text-xs text-foreground outline-none"
                  />
                  <select
                    value={editRemind}
                    onChange={(event) => setEditRemind(event.target.value)}
                    className="h-7 rounded border bg-transparent px-1 text-xs text-foreground outline-none"
                  >
                    {REMIND_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleSaveEdit}
                    className="ml-auto h-7 rounded-md bg-brand px-3 text-xs font-medium text-white transition hover:bg-brand/90"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="h-7 rounded-md border px-3 text-xs text-muted-foreground transition hover:bg-accent"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              /* 常规行 */
              <div
                key={todo.id}
                className="group flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 transition hover:border-border hover:bg-accent/50"
              >
                <button
                  type="button"
                  aria-label={todo.done ? '标记未完成' : '标记完成'}
                  onClick={() => {
                    void useTodosStore.getState().toggleDone(todo.id).catch(() => undefined);
                  }}
                  className={cn(
                    'shrink-0 transition',
                    todo.done ? 'text-brand' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {todo.done ? (
                    <ListTodo className="h-4 w-4" />
                  ) : (
                    <span className="block h-4 w-4 rounded-full border-2 border-current" />
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-sm',
                        todo.done ? 'text-muted-foreground line-through' : 'text-foreground',
                      )}
                    >
                      {todo.title}
                    </span>
                    <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', prio.className)}>
                      {prio.name}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                    {todo.dueAt !== null && (
                      <span className={cn('inline-flex items-center gap-0.5', overdue && 'font-medium text-red-600')}>
                        <CalendarDays className="h-3 w-3" />
                        {overdue ? '已逾期 ' : '到期 '}
                        {formatDateTime(todo.dueAt)}
                      </span>
                    )}
                    {todo.remindAt !== null && !todo.done && (
                      <span className="inline-flex items-center gap-0.5">
                        <Bell className="h-3 w-3" />
                        {todo.reminded ? '已提醒' : '将提醒'}
                      </span>
                    )}
                    {todo.noteId && (
                      <button
                        type="button"
                        onClick={() => handleOpenSourceNote(todo.noteId!)}
                        title="在工作台的笔记面板打开来源笔记"
                        className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                      >
                        <StickyNote className="h-3 w-3" />
                        来源笔记
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                  <button
                    type="button"
                    title="转为笔记（写入工作台笔记面板）"
                    onClick={() => handleConvertToNote(todo)}
                    className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
                  >
                    <StickyNote className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="编辑"
                    onClick={() => startEdit(todo)}
                    className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title="删除"
                    onClick={() => handleDelete(todo.id)}
                    className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
