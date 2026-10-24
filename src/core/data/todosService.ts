import { isTauri } from '@/platform/detect';
import { execute, select } from '@/lib/db';
import { BUS_EVENT_TODOS_CHANGED, busEmit } from './bus';
import { createNote as createNoteApi, type Note } from './notesService';

/**
 * 待办数据服务（M3，V09）。
 *
 * **实现选择（与便签 notesService 一致）**：
 *   - CRUD 走前端 `lib/db`（tauri-plugin-sql 直连 SQLite）：单表简单实体，免逐字段
 *     IPC 样板；Rust 侧 `commands/todos.rs` 提供同义命令作为统一写路径预留；
 *   - 提醒调度（ReminderScheduler）也走直连读 + 直连写 `reminded` 标记，
 *     系统通知经 `tauri-plugin-notification` 发出（权限判定见 ReminderScheduler）；
 *   - `remind_at` / `reminded` 的写入只发生在本窗口调度器，无需跨窗口广播去重。
 *
 * 跨窗口同步：写操作后经 `busEmit(BUS_EVENT_TODOS_CHANGED, …)` 广播。
 */

/** 待办实体（对齐 Rust `commands/todos.rs::Todo` 与 `todos` 表） */
export interface Todo {
  id: string;
  title: string;
  /** Markdown 说明（任务名称之外的补充：步骤 / 链接 / 清单）；空串表示无 */
  detail: string;
  done: boolean;
  /** 1 = 普通，2 = 重要，3 = 紧急 */
  priority: number;
  /** 到期时间（Unix 毫秒；null = 无到期） */
  dueAt: number | null;
  /** 提醒时间（Unix 毫秒；null = 不提醒） */
  remindAt: number | null;
  /** 是否已提醒（调度器写，防重复通知） */
  reminded: boolean;
  /** 关联便签 id（便签↔待办互转后指向对方） */
  noteId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 优先级预设 */
export const TODO_PRIORITIES: { id: number; name: string; className: string }[] = [
  { id: 1, name: '普通', className: 'bg-muted text-muted-foreground' },
  { id: 2, name: '重要', className: 'bg-amber-100 text-amber-800' },
  { id: 3, name: '紧急', className: 'bg-red-100 text-red-700' },
];

/** 优先级 id → 展示样式（未知值按普通处理） */
export function priorityStyle(priority: number): { id: number; name: string; className: string } {
  return TODO_PRIORITIES.find((p) => p.id === priority) ?? TODO_PRIORITIES[0]!;
}

/** 增量更新补丁（仅传入键会被写入；`dueAt`/`remindAt` 传 null 表示清空） */
export interface TodoPatch {
  title?: string;
  detail?: string;
  done?: boolean;
  priority?: number;
  dueAt?: number | null;
  remindAt?: number | null;
  reminded?: boolean;
  noteId?: string | null;
}

/** 新建入参（全部可选） */
export interface TodoCreateInput {
  title?: string;
  detail?: string;
  priority?: number;
  dueAt?: number | null;
  remindAt?: number | null;
  /** 关联便签（互转时使用） */
  noteId?: string | null;
}

/** 跨窗口同步事件载荷（`todos:changed`） */
export interface TodoChangedPayload {
  action: 'create' | 'update' | 'delete';
  id: string;
  /** create 时：完整实体 */
  todo?: Todo;
  /** update 时：增量字段 */
  patch?: TodoPatch;
  /** update 后的落库时间（接收方合并用） */
  updatedAt?: number;
}

const TODO_COLUMNS =
  'id, title, detail, done, priority, due_at, remind_at, reminded, note_id, created_at, updated_at';

/** DB 行（snake_case）→ 实体（camelCase） */
function rowToTodo(row: Record<string, unknown>): Todo {
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    detail: String(row.detail ?? ''),
    done: Number(row.done ?? 0) !== 0,
    priority: Number(row.priority ?? 1),
    dueAt: row.due_at === null || row.due_at === undefined ? null : Number(row.due_at),
    remindAt: row.remind_at === null || row.remind_at === undefined ? null : Number(row.remind_at),
    reminded: Number(row.reminded ?? 0) !== 0,
    noteId: row.note_id === null || row.note_id === undefined ? null : String(row.note_id),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** 待办需要 SQLite（仅 Tauri 宿主内可用）；否则抛出可读错误。 */
function assertDesktop(): void {
  if (!isTauri()) {
    throw new Error('待办功能需要 Handy 桌面环境（SQLite 不可用）');
  }
}

/** 生成待办 id（uuid 优先，降级时间戳+随机） */
function newTodoId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 待办排序：未完成优先 → 优先级高优先 → 有到期时间且近者优先 → 最近更新优先 */
export function sortTodos(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    if (a.done !== b.done) {
      return a.done ? 1 : -1;
    }
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    if ((a.dueAt === null) !== (b.dueAt === null)) {
      return a.dueAt === null ? 1 : -1;
    }
    if (a.dueAt !== null && b.dueAt !== null && a.dueAt !== b.dueAt) {
      return a.dueAt - b.dueAt;
    }
    return b.updatedAt - a.updatedAt;
  });
}

/** 全量列表（已按 sortTodos 排序） */
export async function listTodos(): Promise<Todo[]> {
  assertDesktop();
  const rows = await select<Record<string, unknown>>(
    `SELECT ${TODO_COLUMNS} FROM todos ORDER BY done ASC, priority DESC, ` +
      `CASE WHEN due_at IS NULL THEN 1 ELSE 0 END ASC, due_at ASC, updated_at DESC`,
  );
  return rows.map(rowToTodo);
}

/** 单条读取（不存在返回 null） */
export async function getTodo(id: string): Promise<Todo | null> {
  assertDesktop();
  const rows = await select<Record<string, unknown>>(
    `SELECT ${TODO_COLUMNS} FROM todos WHERE id = ?`,
    [id],
  );
  return rows.length > 0 ? rowToTodo(rows[0]!) : null;
}

/** 新建待办（id 前端生成）；成功后广播 create。 */
export async function createTodo(input: TodoCreateInput = {}): Promise<Todo> {
  assertDesktop();
  const now = Date.now();
  const todo: Todo = {
    id: newTodoId(),
    title: input.title ?? '',
    detail: input.detail ?? '',
    done: false,
    priority: input.priority ?? 1,
    dueAt: input.dueAt ?? null,
    remindAt: input.remindAt ?? null,
    reminded: false,
    noteId: input.noteId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await execute(
    `INSERT INTO todos (${TODO_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      todo.id,
      todo.title,
      todo.detail,
      todo.done ? 1 : 0,
      todo.priority,
      todo.dueAt,
      todo.remindAt,
      todo.reminded ? 1 : 0,
      todo.noteId,
      todo.createdAt,
      todo.updatedAt,
    ],
  );
  await busEmit<TodoChangedPayload>(BUS_EVENT_TODOS_CHANGED, {
    action: 'create',
    id: todo.id,
    todo,
  });
  return todo;
}

/** 增量更新（仅写入传入键，`dueAt`/`remindAt` 传 null 清空；自动刷新 updated_at）。 */
export async function updateTodo(id: string, patch: TodoPatch): Promise<void> {
  assertDesktop();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.detail !== undefined) {
    sets.push('detail = ?');
    params.push(patch.detail);
  }
  if (patch.done !== undefined) {
    sets.push('done = ?');
    params.push(patch.done ? 1 : 0);
    // 完成的待办不再提醒（与 Rust todos_toggle_done 语义一致）
    if (patch.done) {
      sets.push('reminded = 1');
    }
  }
  if (patch.priority !== undefined) {
    sets.push('priority = ?');
    params.push(patch.priority);
  }
  if (patch.dueAt !== undefined) {
    sets.push('due_at = ?');
    params.push(patch.dueAt);
  }
  if (patch.remindAt !== undefined) {
    sets.push('remind_at = ?');
    params.push(patch.remindAt);
  }
  if (patch.reminded !== undefined) {
    sets.push('reminded = ?');
    params.push(patch.reminded ? 1 : 0);
  }
  if (patch.noteId !== undefined) {
    sets.push('note_id = ?');
    params.push(patch.noteId);
  }
  if (sets.length === 0) {
    return;
  }
  const updatedAt = Date.now();
  sets.push('updated_at = ?');
  params.push(updatedAt, id);

  await execute(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`, params);
  await busEmit<TodoChangedPayload>(BUS_EVENT_TODOS_CHANGED, {
    action: 'update',
    id,
    patch,
    updatedAt,
  });
}

/** 删除待办；成功后广播 delete。 */
export async function deleteTodo(id: string): Promise<void> {
  assertDesktop();
  await execute('DELETE FROM todos WHERE id = ?', [id]);
  await busEmit<TodoChangedPayload>(BUS_EVENT_TODOS_CHANGED, { action: 'delete', id });
}

// —— 便签↔待办互转（V09）——

/** 从便签标题/正文首行提取待办标题 */
function deriveTodoTitle(note: Note): string {
  const fromTitle = note.title.trim();
  if (fromTitle.length > 0) {
    return fromTitle;
  }
  const firstLine = note.body.split('\n').find((line) => line.trim().length > 0) ?? '';
  return firstLine.trim().slice(0, 50) || '未命名待办';
}

/**
 * 便签 → 待办：新建一条关联该便签的待办（沿用便签标题/正文首行作标题）。
 * 原便签保留不动；待办 `noteId` 指向便签，可从待办跳回便签窗口。
 */
export async function createTodoFromNote(note: Note): Promise<Todo> {
  return createTodo({ title: deriveTodoTitle(note), noteId: note.id });
}

/**
 * 待办 → 便签：新建一张以待办标题为标题的便签，并回写 `noteId` 关联。
 * 原待办保留不动（由用户自行决定是否删除）；成功返回新便签。
 */
export async function createNoteFromTodo(todo: Todo): Promise<Note> {
  const note = await createNoteApi({ title: todo.title, body: '' });
  await updateTodo(todo.id, { noteId: note.id });
  return note;
}
