import { isTauri } from '@/platform/detect';
import { execute, select } from '@/lib/db';
import { ipc } from '@/lib/ipc';
import { BUS_EVENT_NOTES_CHANGED, busEmit } from './bus';

/**
 * 便签数据服务（M3，V08）。
 *
 * **实现选择（有意为之，经 QA 复核）**：
 *   - CRUD 走前端 `lib/db`（tauri-plugin-sql 直连 SQLite）：便签是单表、无跨表事务的
 *     简单实体，直连读写一致且免为每个字段维护 Rust IPC 样板；Rust 侧 `commands/notes.rs`
 *     提供同义命令作为统一写路径的预留；
 *   - 开/关便签窗口走 Rust IPC（`open_note_window`）：创建原生窗口（无边框、几何、置顶）
 *     只能在 Rust 侧完成，前端无法替代；
 *   - 二者读写同一 SQLite 文件（`db::db_path` 与 sql 插件 preload 同源）。
 *
 * 跨窗口同步：每次写操作后经 `busEmit(BUS_EVENT_NOTES_CHANGED, …)` 广播；其他便签
 * 窗口与主面板经 `useNotesStore` 订阅刷新（见 bus.ts / useNotesStore.ts）。
 */

/** 便签实体（对齐 Rust `commands/notes.rs::Note` 与 `notes` 表） */
export interface Note {
  id: string;
  title: string;
  body: string;
  color: string;
  pinned: boolean;
  /** 逻辑像素坐标（窗口左上角） */
  x: number;
  y: number;
  /** 逻辑像素尺寸 */
  w: number;
  h: number;
  opacity: number;
  /** 层级（预留，值大者在前） */
  z: number;
  createdAt: number;
  updatedAt: number;
}

/** 便签颜色预设 id */
export type NoteColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple' | 'gray';

/** 便签颜色预设（≥5；NoteWindow 取色器与列表色条共用） */
export const NOTE_COLORS: { id: NoteColor; name: string; className: string; swatch: string }[] = [
  { id: 'yellow', name: '便签黄', className: 'bg-amber-100 text-amber-950', swatch: '#fef3c7' },
  { id: 'green', name: '青草绿', className: 'bg-green-100 text-green-950', swatch: '#dcfce7' },
  { id: 'blue', name: '天空蓝', className: 'bg-sky-100 text-sky-950', swatch: '#e0f2fe' },
  { id: 'pink', name: '樱花粉', className: 'bg-pink-100 text-pink-950', swatch: '#fce7f3' },
  { id: 'purple', name: '薰衣紫', className: 'bg-purple-100 text-purple-950', swatch: '#f3e8ff' },
  { id: 'gray', name: '石灰灰', className: 'bg-zinc-200 text-zinc-900', swatch: '#e4e4e7' },
];

/** 颜色 id → 便签底色样式（未知值回退默认黄） */
export function noteColorClass(color: string): string {
  const preset = NOTE_COLORS.find((c) => c.id === color);
  return preset ? preset.className : 'bg-amber-100 text-amber-950';
}

/** 增量更新补丁（仅传入字段会被写入） */
export interface NotePatch {
  title?: string;
  body?: string;
  color?: string;
  pinned?: boolean;
}

/** 几何批量写入（拖动/缩放结束时调用，避免拖动中高频写库） */
export interface NoteGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 可选：不传则不写 z / opacity（保留原值） */
  z?: number;
  opacity?: number;
}

/** 新建入参（全部可选） */
export interface NoteCreateInput {
  title?: string;
  body?: string;
  color?: string;
  x?: number;
  y?: number;
}

/** 跨窗口同步事件载荷（`notes:changed`） */
export interface NoteChangedPayload {
  action: 'create' | 'update' | 'delete' | 'geometry';
  /** 目标便签 id */
  id: string;
  /** create 时：完整实体 */
  note?: Note;
  /** update 时：增量字段 */
  patch?: NotePatch;
  /** update 时：落库后的 updated_at（接收方合并用） */
  updatedAt?: number;
  /** geometry 时：几何值 */
  geometry?: NoteGeometry;
}

const NOTE_COLUMNS =
  'id, title, body, color, pinned, x, y, w, h, opacity, z, created_at, updated_at';

/** DB 行（snake_case）→ 实体（camelCase） */
function rowToNote(row: Record<string, unknown>): Note {
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    color: String(row.color ?? 'yellow'),
    pinned: Number(row.pinned ?? 0) !== 0,
    x: Number(row.x ?? 0),
    y: Number(row.y ?? 0),
    w: Number(row.w ?? 280),
    h: Number(row.h ?? 240),
    opacity: Number(row.opacity ?? 1),
    z: Number(row.z ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** 便签需要 SQLite（仅 Tauri 宿主内可用）；否则抛出可读错误。 */
function assertDesktop(): void {
  if (!isTauri()) {
    throw new Error('便签功能需要 Toolbox 桌面环境（SQLite 不可用）');
  }
}

/** 生成便签 id（uuid 优先，降级时间戳+随机） */
function newNoteId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 便签排序：置顶优先 → 层级高优先 → 最近更新优先 */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    if (a.z !== b.z) {
      return b.z - a.z;
    }
    return b.updatedAt - a.updatedAt;
  });
}

/** 全量列表（已按 pinned → z → updatedAt 排序） */
export async function listNotes(): Promise<Note[]> {
  assertDesktop();
  const rows = await select<Record<string, unknown>>(
    `SELECT ${NOTE_COLUMNS} FROM notes ORDER BY pinned DESC, z DESC, updated_at DESC`,
  );
  return rows.map(rowToNote);
}

/** 单条读取（不存在返回 null） */
export async function getNote(id: string): Promise<Note | null> {
  assertDesktop();
  const rows = await select<Record<string, unknown>>(
    `SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`,
    [id],
  );
  return rows.length > 0 ? rowToNote(rows[0]!) : null;
}

/** 新建便签（id 前端生成，创建后可立即开窗）；成功后广播 create。 */
export async function createNote(input: NoteCreateInput = {}): Promise<Note> {
  assertDesktop();
  const now = Date.now();
  // 级联偏移：避免多张新便签完全重叠（与 Rust notes_create 的缺省策略一致）
  const note: Note = {
    id: newNoteId(),
    title: input.title ?? '',
    body: input.body ?? '',
    color: input.color ?? 'yellow',
    pinned: false,
    x: input.x ?? 96 + (now % 5) * 32,
    y: input.y ?? 96 + (now % 7) * 28,
    w: 280,
    h: 240,
    opacity: 1,
    z: 0,
    createdAt: now,
    updatedAt: now,
  };
  await execute(
    `INSERT INTO notes (${NOTE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      note.id,
      note.title,
      note.body,
      note.color,
      note.pinned ? 1 : 0,
      note.x,
      note.y,
      note.w,
      note.h,
      note.opacity,
      note.z,
      note.createdAt,
      note.updatedAt,
    ],
  );
  await busEmit<NoteChangedPayload>(BUS_EVENT_NOTES_CHANGED, {
    action: 'create',
    id: note.id,
    note,
  });
  return note;
}

/** 增量更新（仅写入传入字段，自动刷新 updated_at）；成功后广播 update。 */
export async function updateNote(id: string, patch: NotePatch): Promise<void> {
  assertDesktop();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.body !== undefined) {
    sets.push('body = ?');
    params.push(patch.body);
  }
  if (patch.color !== undefined) {
    sets.push('color = ?');
    params.push(patch.color);
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?');
    params.push(patch.pinned ? 1 : 0);
  }
  if (sets.length === 0) {
    return;
  }
  const updatedAt = Date.now();
  sets.push('updated_at = ?');
  params.push(updatedAt, id);

  await execute(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`, params);
  await busEmit<NoteChangedPayload>(BUS_EVENT_NOTES_CHANGED, {
    action: 'update',
    id,
    patch,
    updatedAt,
  });
}

/** 删除便签；成功后广播 delete（其他窗口移除本地副本）。 */
export async function deleteNote(id: string): Promise<void> {
  assertDesktop();
  await execute('DELETE FROM notes WHERE id = ?', [id]);
  await busEmit<NoteChangedPayload>(BUS_EVENT_NOTES_CHANGED, { action: 'delete', id });
}

/**
 * 批量写几何（x,y,w,h + 可选 z/opacity）——拖动/缩放**结束**时调用。
 * 注意：几何写不刷新 updated_at（移动不算内容更新，避免列表排序抖动）。
 */
export async function setGeometry(id: string, geometry: NoteGeometry): Promise<void> {
  assertDesktop();
  const sets = ['x = ?', 'y = ?', 'w = ?', 'h = ?'];
  const params: unknown[] = [geometry.x, geometry.y, geometry.w, geometry.h];
  if (geometry.z !== undefined) {
    sets.push('z = ?');
    params.push(geometry.z);
  }
  if (geometry.opacity !== undefined) {
    sets.push('opacity = ?');
    params.push(geometry.opacity);
  }
  params.push(id);
  await execute(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`, params);
  await busEmit<NoteChangedPayload>(BUS_EVENT_NOTES_CHANGED, { action: 'geometry', id, geometry });
}

// —— 窗口操作（仅 Tauri 宿主内生效；浏览器调试降级为 no-op）——

/** 打开（或聚焦）便签独立窗口（Rust 侧创建原生无边框窗口）。 */
export async function openNoteWindow(id: string): Promise<void> {
  if (!isTauri()) {
    return;
  }
  await ipc.openNoteWindow(id);
}

/** 关闭当前便签窗口（便签窗口关闭即销毁；数据已即时落库，无丢失风险）。 */
export async function closeCurrentWindow(): Promise<void> {
  if (!isTauri()) {
    return;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

/** 置顶/取消置顶当前窗口（跟随 pinned 状态切换时调用）。 */
export async function setAlwaysOnTop(on: boolean): Promise<void> {
  if (!isTauri()) {
    return;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setAlwaysOnTop(on);
}
