import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, ListTodo, MonitorUp, NotebookPen, Pin, PinOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MarkdownHelp } from '@/components/MarkdownHelp';
import { RichMarkdown } from '@/components/RichMarkdown';
import { toast } from '@/components/ui/toast';
import { useNotesStore } from '@/stores/useNotesStore';
import { createTodoFromNote } from '@/core/data/todosService';
import { noteColorClass, openNoteWindow } from '@/core/data/notesService';
import { stripMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

/**
 * 便签页（V70 改版：列表 → 完整编辑页）。
 *
 * # 背景（用户原话）
 *
 * 「工作台和便签也存在重叠，我们不是有单独便签页面吗？而且便签功能感觉编辑等都不方便」
 *
 * 此前便签是**只读卡片墙**：想改内容必须先「打开窗口」丢一个桌面悬浮小窗出来；
 * 而完整的编辑器（边写边渲染 + 自动保存）却藏在主窗口「工作台」页的下排面板里，
 * 两处各管一半、互相重叠。V70 把两边合并：
 *   - **便签页 = 唯一的便签管理入口**：左侧列表 + 右侧编辑器全高双栏，点哪条写哪条；
 *   - 工作台页不再内嵌便签面板（聚焦日历 / 计划聚合），能力全部搬到这里；
 *   - 「贴到桌面」保留：列表项**右键**或工具条按钮，随时把便签丢成桌面悬浮窗；
 *   - 置顶 / 转待办（V09 互转）收进右键菜单，不再占卡片角落。
 *
 * 编辑态就是**唯一**形态：所见即所得的 `RichMarkdown`（敲 `**重点**` 当场变粗体，
 * 围栏代码块按语言上色）。「怎么写」的入口交给标题栏的 `?`（`MarkdownHelp`）。
 */

/** 自动落库防抖（毫秒） */
const AUTOSAVE_DEBOUNCE_MS = 700;

/** 待落库草稿 */
interface PendingDraft {
  id: string;
  title: string;
  body: string;
}

/** 右键菜单位置与目标 */
interface ContextMenuState {
  x: number;
  y: number;
  noteId: string;
}

/** 更新时间（`9/16 14:05`） */
function formatUpdated(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 列表里用的极简时间：今天只给 `HH:mm`，其它天给 `M/D` —— 列表一行就那么点宽 */
function formatUpdatedShort(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
}

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

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  // 右键菜单：点任意处关闭
  useEffect(() => {
    if (menu === null) {
      return;
    }
    const close = (): void => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  // 选中项失效（删除 / 首次加载）时自动落到第一条（置顶的排前面）
  useEffect(() => {
    if (selectedId !== null && notes.some((note) => note.id === selectedId)) {
      return;
    }
    setSelectedId(notes[0]?.id ?? null);
  }, [notes, selectedId]);

  const selected = useMemo(
    () => notes.find((note) => note.id === selectedId) ?? null,
    [notes, selectedId],
  );

  const pendingRef = useRef<PendingDraft | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  /** 立即落库（切换便签 / 卸载页面 / 手动触发时调用） */
  const flush = useCallback((): void => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    if (!pending) {
      return;
    }
    void useNotesStore
      .getState()
      .updateNote(pending.id, { title: pending.title, body: pending.body })
      .catch((error: unknown) => {
        toast.error(`便签保存失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }, []);

  // 仅当选中便签变化时载入草稿：避免 store 每次更新都把正在输入的内容覆盖掉
  const selectedKey = selected?.id ?? null;
  const selectedTitle = selected?.title ?? '';
  const selectedBody = selected?.body ?? '';
  useEffect(() => {
    flush();
    setTitle(selectedTitle);
    setBody(selectedBody);
    // 依赖刻意只取 id：切到另一条便签才重新载入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  /** 外部聚焦请求（待办的「打开来源便签」走这里） */
  const focusRequestId = useNotesStore((state) => state.focusRequestId);
  useEffect(() => {
    if (focusRequestId === null || !notes.some((note) => note.id === focusRequestId)) {
      return;
    }
    flush();
    setSelectedId(focusRequestId);
    useNotesStore.getState().clearFocusRequest();
  }, [focusRequestId, notes, flush]);

  // 页面卸载前强制落库
  useEffect(
    () => () => {
      flush();
    },
    [flush],
  );

  const activeId = selected?.id ?? '';

  const schedule = useCallback(
    (id: string, nextTitle: string, nextBody: string): void => {
      if (id.length === 0) {
        return;
      }
      pendingRef.current = { id, title: nextTitle, body: nextBody };
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(flush, AUTOSAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const handleCreate = (): void => {
    flush();
    void useNotesStore
      .getState()
      .createNote({ title: '新便签', body: '' })
      .then((note) => setSelectedId(note.id))
      .catch((err: unknown) => {
        toast.error(`新建便签失败：${err instanceof Error ? err.message : String(err)}`);
      });
  };

  const handleDelete = (id: string): void => {
    pendingRef.current = null;
    void useNotesStore
      .getState()
      .deleteNote(id)
      .catch((err: unknown) => {
        toast.error(`删除便签失败：${err instanceof Error ? err.message : String(err)}`);
      });
  };

  const handleTogglePin = (id: string): void => {
    void useNotesStore
      .getState()
      .togglePin(id)
      .catch((err: unknown) => {
        toast.error(`置顶失败：${err instanceof Error ? err.message : String(err)}`);
      });
  };

  /** 便签 → 待办（V09 互转）：新建关联待办，原便签保留 */
  const handleConvertToTodo = (id: string): void => {
    flush();
    const note = notes.find((item) => item.id === id);
    if (!note) {
      return;
    }
    void createTodoFromNote(note)
      .then(() => toast.success('已转为待办（可在待办清单查看）'))
      .catch((err: unknown) =>
        toast.error(`转为待办失败：${err instanceof Error ? err.message : String(err)}`),
      );
  };

  /** 贴到桌面：复用便签悬浮窗（无边框 / 可拖 / 可置顶） */
  const stickToDesktop = (id: string): void => {
    flush();
    void openNoteWindow(id)
      .then(() => toast.success('已贴到桌面', { description: '便签窗可拖动、可置顶；关闭即收回' }))
      .catch((err: unknown) => {
        toast.error(`贴到桌面失败：${err instanceof Error ? err.message : String(err)}`);
      });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具条 */}
      <header className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {notes.length}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          左侧选一条直接写 · Markdown 边写边渲染 · 右键可贴到桌面
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <MarkdownHelp />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-brand"
            onClick={() => selected !== null && handleTogglePin(selected.id)}
            disabled={selected === null}
            title={selected?.pinned ? '取消置顶' : '置顶（排到列表最前）'}
          >
            {selected?.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            {selected?.pinned ? '取消置顶' : '置顶'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-brand"
            onClick={() => selected !== null && stickToDesktop(selected.id)}
            disabled={selected === null}
            title="把当前便签贴成桌面悬浮窗"
          >
            <MonitorUp className="h-3.5 w-3.5" />
            贴到桌面
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={() => selected !== null && handleDelete(selected.id)}
            disabled={selected === null}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </Button>
          <Button size="sm" className="h-7 px-2.5 text-xs" onClick={handleCreate}>
            <FilePlus2 className="h-3.5 w-3.5" />
            新建
          </Button>
        </div>
      </header>

      {/* 错误态 */}
      {error !== null && (
        <div className="mx-4 mb-2 shrink-0 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          加载便签失败：{error}
        </div>
      )}

      {!loaded && error === null ? (
        <p className="flex-1 py-8 text-center text-sm text-muted-foreground">加载中…</p>
      ) : notes.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
          <NotebookPen className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">还没有便签</p>
          <Button size="sm" onClick={handleCreate}>
            <FilePlus2 className="h-3.5 w-3.5" />
            写第一条
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 px-4 pb-4">
          {/* 左：便签列表（右键 → 贴到桌面 / 置顶 / 转待办 / 删除） */}
          <div className="scrollbar-thin flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border bg-card p-1">
            {notes.map((note) => {
              const excerpt = stripMarkdown(note.body).replace(/\s+/g, ' ').trim();
              const active = note.id === selectedId;
              return (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => {
                    flush();
                    setSelectedId(note.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, noteId: note.id });
                  }}
                  title={`${note.title.trim() || '未命名便签'} · 更新于 ${formatUpdated(note.updatedAt)}（右键：贴到桌面 / 置顶 / 转待办 / 删除）`}
                  className={cn(
                    'flex flex-col gap-1 rounded-md px-2 py-1.5 text-left transition',
                    active ? 'bg-brand-muted' : 'hover:bg-accent',
                  )}
                >
                  {/* 第一行：便签色条 + 标题 + 置顶标记 + 更新时间 */}
                  <span className="flex w-full items-baseline gap-1.5">
                    <span
                      className={cn('h-2 w-2 shrink-0 self-center rounded-full', noteColorClass(note.color))}
                      aria-hidden
                    />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-xs font-medium',
                        active ? 'text-brand' : 'text-foreground',
                      )}
                    >
                      {note.title.trim() || '未命名便签'}
                    </span>
                    {note.pinned && <Pin className="h-3 w-3 shrink-0 text-brand" fill="currentColor" />}
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                      {formatUpdatedShort(note.updatedAt)}
                    </span>
                  </span>
                  {/* 第二行：正文摘要（已剥掉 Markdown 记号，不会再露星号） */}
                  <span
                    className={cn(
                      'truncate text-[10px] leading-4',
                      active ? 'text-brand/70' : 'text-muted-foreground',
                    )}
                  >
                    {excerpt.length > 0 ? excerpt : '空便签'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 右：标题 + 正文（编辑器撑满剩余高度） */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <Input
              value={title}
              onChange={(event) => {
                const next = event.target.value;
                setTitle(next);
                schedule(activeId, next, body);
              }}
              onBlur={flush}
              placeholder="便签标题"
              className="h-9 shrink-0 text-sm font-medium"
              aria-label="便签标题"
            />
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-background">
              <RichMarkdown
                value={body}
                onChange={(next: string) => {
                  setBody(next);
                  schedule(activeId, title, next);
                }}
                onBlur={flush}
                placeholder="直接写：**重点** 变粗体、- 开头变列表、# 开头变标题；敲 ``` 再回车就能粘代码并自动高亮。点右上角「?」看全部语法。"
                className="h-full px-3 py-2 text-sm"
                ariaLabel="便签正文"
              />
            </div>
            <p className="shrink-0 truncate text-[11px] text-muted-foreground">
              敲完立刻渲染并自动保存 · 代码块里回车换行，末行空着再回车（或 Esc）跳出
            </p>
          </div>
        </div>
      )}

      {/* 自定义右键菜单（Tauri 生产环境禁用系统右键菜单，需自绘） */}
      {menu !== null ? (
        <div
          className="fixed z-50 min-w-[140px] overflow-hidden rounded-lg border border-border bg-card py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              stickToDesktop(menu.noteId);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition hover:bg-accent"
          >
            <MonitorUp className="h-3.5 w-3.5" />
            贴到桌面
          </button>
          <button
            type="button"
            onClick={() => {
              handleTogglePin(menu.noteId);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition hover:bg-accent"
          >
            <Pin className="h-3.5 w-3.5" />
            置顶 / 取消置顶
          </button>
          <button
            type="button"
            onClick={() => {
              handleConvertToTodo(menu.noteId);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition hover:bg-accent"
          >
            <ListTodo className="h-3.5 w-3.5" />
            转为待办
          </button>
          <button
            type="button"
            onClick={() => {
              handleDelete(menu.noteId);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-destructive transition hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除便签
          </button>
        </div>
      ) : null}
    </div>
  );
}
