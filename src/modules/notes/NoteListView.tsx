import React, { useEffect } from 'react';
import { ExternalLink, ListTodo, Pin, Plus, StickyNote, Trash2 } from 'lucide-react';
import { useNotesStore } from '@/stores/useNotesStore';
import { noteColorClass, openNoteWindow } from '@/core/data/notesService';
import { createTodoFromNote } from '@/core/data/todosService';
import { toast } from '@/components/ui/toast';
import { stripMarkdown } from '@/lib/markdown';

/**
 * 便签列表视图（V08）。
 *
 * 双承载：主面板内页（模块 `loadView`）与命令视图（命令「便签列表」`load`）复用。
 * 提供：新建、打开独立窗口、置顶切换、删除；列表随跨窗口变更实时刷新（总线订阅）。
 */

export interface NoteListViewProps {
  /** 兼容 CommandProps（命令视图注入，未使用） */
  initialInput?: string;
  /** 兼容 ModuleProps（模块内页注入，未使用） */
  windowKind?: string;
}

export default function NoteListView(_props: NoteListViewProps = {}): React.JSX.Element {
  const notes = useNotesStore((state) => state.notes);
  const loaded = useNotesStore((state) => state.loaded);
  const error = useNotesStore((state) => state.error);
  const hydrate = useNotesStore((state) => state.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const handleCreate = (): void => {
    void useNotesStore
      .getState()
      .createNote()
      .then((note) => openNoteWindow(note.id))
      .catch((err: unknown) => console.error('[Toolbox] 新建便签失败：', err));
  };

  const handleOpen = (id: string): void => {
    void openNoteWindow(id).catch((err: unknown) => console.error('[Toolbox] 打开便签失败：', err));
  };

  const handleTogglePin = (id: string): void => {
    void useNotesStore.getState().togglePin(id).catch(() => undefined);
  };

  const handleDelete = (id: string): void => {
    void useNotesStore.getState().deleteNote(id).catch(() => undefined);
  };

  /** 便签 → 待办（V09 互转）：新建关联待办，原便签保留 */
  const handleConvertToTodo = (noteId: string): void => {
    const note = notes.find((n) => n.id === noteId);
    if (!note) {
      return;
    }
    void createTodoFromNote(note)
      .then(() => toast.success('已转为待办（可在待办清单查看）'))
      .catch((err: unknown) =>
        toast.error(`转为待办失败：${err instanceof Error ? err.message : String(err)}`),
      );
  };

  return (
    <div className="flex h-full flex-col">
      {/* 工具条 */}
      <div className="flex items-center justify-between px-4 py-2">
        <p className="text-xs text-muted-foreground">
          共 {notes.length} 张{loaded ? '' : '（加载中…）'}
        </p>
        <button
          type="button"
          onClick={handleCreate}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand/90"
        >
          <Plus className="h-3.5 w-3.5" />
          新建便签
        </button>
      </div>

      {/* 错误态 */}
      {error && (
        <div className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          加载便签失败：{error}
        </div>
      )}

      {/* 空态 */}
      {loaded && notes.length === 0 && !error && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
          <StickyNote className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">还没有便签</p>
          <p className="text-xs text-muted-foreground/70">点击「新建便签」，在桌面上随手记录</p>
        </div>
      )}

      {/* 列表 */}
      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-4 pb-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {notes.map((note) => (
            <div
              key={note.id}
              className={`flex flex-col gap-2 rounded-lg border border-black/5 p-3 shadow-sm ${noteColorClass(
                note.color,
              )}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                  {note.title || '未命名便签'}
                </span>
                {note.pinned && <Pin className="h-3 w-3 shrink-0" fill="currentColor" />}
              </div>
              {/* 摘要：去掉 Markdown 标记，避免 `**`/`#` 之类符号占据卡片 */}
              <p className="line-clamp-4 min-h-0 flex-1 whitespace-pre-wrap text-xs leading-relaxed opacity-80">
                {stripMarkdown(note.body) || (note.body ? note.body : '（空便签）')}
              </p>
              <div className="flex items-center gap-1 border-t border-black/5 pt-2">
                <span className="min-w-0 flex-1 truncate text-[10px] opacity-50">
                  {new Date(note.updatedAt).toLocaleString()}
                </span>
                <button
                  type="button"
                  title={note.pinned ? '取消置顶' : '置顶'}
                  onClick={() => handleTogglePin(note.id)}
                  className="rounded p-1 opacity-50 transition hover:bg-black/10 hover:opacity-100"
                >
                  <Pin className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="转为待办"
                  onClick={() => handleConvertToTodo(note.id)}
                  className="rounded p-1 opacity-50 transition hover:bg-black/10 hover:opacity-100"
                >
                  <ListTodo className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="打开窗口"
                  onClick={() => handleOpen(note.id)}
                  className="rounded p-1 opacity-50 transition hover:bg-black/10 hover:opacity-100"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={() => handleDelete(note.id)}
                  className="rounded p-1 opacity-50 transition hover:bg-black/10 hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
