import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, MonitorUp, NotebookPen, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MarkdownHelp } from '@/components/MarkdownHelp';
import { RichMarkdown } from '@/components/RichMarkdown';
import { toast } from '@/components/ui/toast';
import { useNotesStore } from '@/stores/useNotesStore';
import { openNoteWindow } from '@/core/data/notesService';
import { stripMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';

/**
 * 工作台「便签」面板。
 *
 * # V20 改版（用户反馈 #6）
 *
 * 「下面笔记改成便签，这个便签里面的 code 最好能支持语法高亮的 ```shell ```python 这样的，
 *   多个便签用户可以自己右键选择贴到桌面上，默认就在工作台上直接可以看。」
 *
 * 三件事：
 *   1. **改名便签**（语义更贴近「随手记」），仍在工作台里直接读写；
 *   2. **代码高亮**：新增「预览」页签，围栏代码块按语言着色（shell / python / js / json /
 *      yaml / java / go / sql / ini），零依赖实现，见 `@/components/CodeBlock`；
 *   3. **贴到桌面**：列表项**右键**即可把该便签丢成桌面悬浮窗（复用 V08 的 note 窗，
 *      `?window=note-<id>` 路由一直在，只是之前没有入口）。
 *
 * 编辑态就是**唯一**形态：所见即所得的 `RichMarkdown`（敲 `**重点**` 当场变粗体，
 * 围栏代码块按语言上色）。V21 之前这里还有「编辑 / 预览」两个页签，用户反馈
 * 「不需要头工具栏，也需要随时渲染的方案」—— 页签于是被撤掉：渲染本来就在敲的
 * 那一刻发生，再让人切一次页签纯属多余。
 *
 * 「怎么写」的入口交给标题栏那个 `?`（`MarkdownHelp`），不再占用头部空间。
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

export function NotesPanel(): React.JSX.Element {
  const notes = useNotesStore((state) => state.notes);
  const loaded = useNotesStore((state) => state.loaded);
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

  // 选中项失效（删除 / 首次加载）时自动落到第一条
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

  /** 立即落库（切换便签 / 卸载面板 / 手动触发时调用） */
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

  // 面板卸载前强制落库
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
      .catch((error: unknown) => {
        toast.error(`新建便签失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const handleDelete = (id: string): void => {
    pendingRef.current = null;
    void useNotesStore
      .getState()
      .deleteNote(id)
      .catch((error: unknown) => {
        toast.error(`删除便签失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  /** 贴到桌面：复用 V08 的便签悬浮窗（无边框 / 可拖 / 可置顶） */
  const stickToDesktop = (id: string): void => {
    flush();
    void openNoteWindow(id)
      .then(() => toast.success('已贴到桌面', { description: '便签窗可拖动、可置顶；关闭即收回' }))
      .catch((error: unknown) => {
        toast.error(`贴到桌面失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-panel">
      <header className="flex shrink-0 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700">
          <NotebookPen className="h-4 w-4" />
        </span>
        <h3 className="shrink-0 text-sm font-semibold text-foreground">便签</h3>
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {notes.length}
        </span>
        {/* 说明文字可伸缩可截断：之前是定宽长句，窄窗口下会顶到右侧按钮上 */}
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          Markdown 边写边渲染 · 右键可贴到桌面
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <MarkdownHelp />
          <Button size="sm" className="h-7 px-2.5 text-xs" onClick={handleCreate}>
            <FilePlus2 className="h-3.5 w-3.5" />
            新建
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
        </div>
      </header>

      {!loaded ? (
        <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>
      ) : notes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-6 text-center">
          <NotebookPen className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">还没有便签</p>
          <Button size="sm" onClick={handleCreate}>
            <FilePlus2 className="h-3.5 w-3.5" />
            写第一条
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          {/* 左：便签列表（右键 → 贴到桌面） */}
          <div className="scrollbar-thin flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border p-1">
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
                  title={`${note.title.trim() || '未命名便签'} · 更新于 ${formatUpdated(note.updatedAt)}（右键：贴到桌面 / 删除）`}
                  className={cn(
                    'flex flex-col gap-1 rounded-md px-2 py-1.5 text-left transition',
                    active ? 'bg-brand-muted' : 'hover:bg-accent',
                  )}
                >
                  {/* 第一行：标题 + 更新时间（时间右贴，省下一行） */}
                  <span className="flex w-full items-baseline gap-1.5">
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-xs font-medium',
                        active ? 'text-brand' : 'text-foreground',
                      )}
                    >
                      {note.title.trim() || '未命名便签'}
                    </span>
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

          {/* 右：标题 + 正文 */}
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
              className="h-8 shrink-0 text-sm font-medium"
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
              setSelectedId(menu.noteId);
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
    </section>
  );
}

export default NotesPanel;
