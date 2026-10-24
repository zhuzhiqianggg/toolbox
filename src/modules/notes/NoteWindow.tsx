import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pin, PinOff, X } from 'lucide-react';
import { useNotesStore } from '@/stores/useNotesStore';
import {
  NOTE_COLORS,
  type Note,
  closeCurrentWindow,
  noteColorClass,
  setAlwaysOnTop,
} from '@/core/data/notesService';
import { isTauri } from '@/platform/detect';
import { MarkdownHelp } from '@/components/MarkdownHelp';
import { RichMarkdown } from '@/components/RichMarkdown';

/**
 * 便签独立窗口视图（V08）。
 *
 * 窗口形态：Rust 侧无边框窗口（`note-<id>`），本组件承担：
 *   - 拖拽区（`data-tauri-drag-region` 标题栏）+ 置顶 / 关闭按钮；
 *   - 正文编辑：**600ms 防抖落库**（≥500ms，避免拖动/连续输入高频写库）；
 *   - 取色器：6 种颜色预设（NOTE_COLORS）；
 *   - 几何持久化：监听窗口 moved / resized 事件，**停稳 500ms 后**批量写库；
 *   - 跨窗口同步：远端变更（其他窗口编辑/删除同一条）非聚焦时跟随刷新。
 *
 * 状态来源：`useNotesStore`（本窗口独立实例，hydrate 拉全量 + 总线订阅增量）。
 *
 * # V21：去掉编辑器工具栏，改成随时渲染
 *
 * 用户反馈「桌面 markdown 编辑都也不需要头工具栏，也需要随时渲染的方案」。
 * 原先这里挂的是 `MarkdownEditor`（工具栏 + 编辑/分屏/预览三视图 + 模式记忆），
 * 在只有一张便签大小的窗口里，工具栏把正文挤得所剩无几，而「预览」还要用户自己切。
 * 现在直接换成 `RichMarkdown`：**没有工具栏、没有模式、敲完即渲染**，
 * 语法与用法说明挪到标题栏的 `?` 里（`MarkdownHelp`）。
 */

/** 正文落库防抖（毫秒，≥500ms） */
const BODY_SAVE_DEBOUNCE_MS = 600;
/** 几何落库防抖（拖动/缩放停稳后写入） */
const GEOMETRY_SAVE_DEBOUNCE_MS = 500;

export interface NoteWindowProps {
  /** 便签 id（由 main.tsx 从 `?window=note-<id>` 解析注入） */
  noteId: string;
}

/** 置顶按钮（图标随状态切换，置顶时填充）。 */
function PinButton({ pinned, onClick }: { pinned: boolean; onClick: () => void }): React.JSX.Element {
  const Icon = pinned ? Pin : PinOff;
  return (
    <button
      type="button"
      onClick={onClick}
      title={pinned ? '取消置顶' : '置顶'}
      className="rounded p-1 opacity-50 transition hover:bg-black/10 hover:opacity-100"
    >
      <Icon className="h-3.5 w-3.5" fill={pinned ? 'currentColor' : 'none'} />
    </button>
  );
}

export function NoteWindow({ noteId }: NoteWindowProps): React.JSX.Element {
  const note = useNotesStore((state) => state.notes.find((n) => n.id === noteId));
  const loaded = useNotesStore((state) => state.loaded);
  const hydrate = useNotesStore((state) => state.hydrate);
  const loadError = useNotesStore((state) => state.error);

  // 正文草稿（本地态；落库经 store → service 防抖）
  const [body, setBody] = useState('');
  /** 正文编辑器是否聚焦（聚焦期间不跟随远端变更，避免打字被覆盖） */
  const editingRef = useRef(false);

  // 启动装配（幂等）
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // 远端同步：非聚焦时跟随最新内容；聚焦（正在编辑）时不动草稿
  const remoteBody: string | undefined = note?.body;
  useEffect(() => {
    if (remoteBody === undefined || editingRef.current) {
      return;
    }
    setBody((prev) => (prev === remoteBody ? prev : remoteBody));
  }, [remoteBody]);

  // 正文防抖落库（草稿与库内不一致时启动计时；远端跟随到达后自然相等、不再写）
  useEffect(() => {
    if (!note || body === note.body) {
      return;
    }
    const timer = window.setTimeout(() => {
      void useNotesStore.getState().updateNote(note.id, { body });
    }, BODY_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [body, note, noteId]);

  // 几何持久化：moved / resized 停稳后批量写库（拖动中只更新内存，不写库）
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let unlisteners: Array<() => void> = [];

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const scaleFactor = await win.scaleFactor();
        const initialPos = await win.outerPosition();
        const initialSize = await win.innerSize();
        let geo = {
          x: initialPos.toLogical(scaleFactor).x,
          y: initialPos.toLogical(scaleFactor).y,
          w: initialSize.toLogical(scaleFactor).width,
          h: initialSize.toLogical(scaleFactor).height,
        };

        const scheduleSave = (): void => {
          if (timer !== undefined) {
            window.clearTimeout(timer);
          }
          timer = window.setTimeout(() => {
            if (!cancelled) {
              void useNotesStore.getState().setGeometry(noteId, { ...geo });
            }
          }, GEOMETRY_SAVE_DEBOUNCE_MS);
        };

        const onMoved = await win.onMoved(({ payload }) => {
          const pos = payload.toLogical(scaleFactor);
          geo = { ...geo, x: pos.x, y: pos.y };
          scheduleSave();
        });
        const onResized = await win.onResized(({ payload }) => {
          const size = payload.toLogical(scaleFactor);
          geo = { ...geo, w: size.width, h: size.height };
          scheduleSave();
        });
        if (cancelled) {
          onMoved();
          onResized();
          return;
        }
        unlisteners = [onMoved, onResized];
      } catch (error: unknown) {
        console.error('[Toolbox] 便签几何监听失败（不影响编辑）：', error);
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, [noteId]);

  const handleClose = useCallback((): void => {
    void closeCurrentWindow();
  }, []);

  const handleTogglePin = useCallback((): void => {
    if (!note) {
      return;
    }
    const next = !note.pinned;
    void useNotesStore
      .getState()
      .togglePin(note.id)
      .then(() => setAlwaysOnTop(next))
      .catch((error: unknown) => console.error('[Toolbox] 切换置顶失败：', error));
  }, [note]);

  const handlePickColor = useCallback((color: string): void => {
    void useNotesStore.getState().updateNote(noteId, { color }).catch(() => undefined);
  }, [noteId]);

  // —— 加载中 ——
  if (!loaded) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">便签加载中…</p>
      </div>
    );
  }

  // —— 便签不存在 / 加载失败 ——
  if (!note) {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <p className="text-sm font-medium text-foreground">便签不存在或已被删除</p>
        <p className="text-xs text-muted-foreground">
          {loadError ? `原因：${loadError}` : '它可能在其他窗口被关闭或删除了。'}
        </p>
        <button
          type="button"
          onClick={handleClose}
          className="rounded-md border px-3 py-1.5 text-xs text-foreground transition hover:bg-muted"
        >
          关闭窗口
        </button>
      </div>
    );
  }

  const colorClass = noteColorClass(note.color);

  return (
    <div
      className={`flex h-screen w-screen flex-col overflow-hidden shadow-2xl ring-1 ring-black/10 ${colorClass}`}
    >
      {/* 标题栏：拖拽区 + 置顶 / 关闭 */}
      <header
        data-tauri-drag-region
        className={`flex h-9 shrink-0 cursor-grab select-none items-center gap-1 px-2 active:cursor-grabbing ${colorClass}`}
      >
        <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-xs font-medium opacity-60">
          {note.title || '便签'}
        </span>
        <MarkdownHelp align="right" />
        <PinButton pinned={note.pinned} onClick={handleTogglePin} />
        <button
          type="button"
          onClick={handleClose}
          title="关闭"
          className="rounded p-1 opacity-50 transition hover:bg-black/10 hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* 正文：无所见即所得编辑区（无工具栏 / 无模式，敲完即渲染并自动保存） */}
      <RichMarkdown
        value={body}
        onChange={setBody}
        onFocus={() => {
          editingRef.current = true;
        }}
        onBlur={() => {
          editingRef.current = false;
        }}
        placeholder="记点什么…支持 Markdown（```shell 回车即代码块，右上角「?」看语法）"
        className="min-h-0 flex-1 px-2.5 py-2 text-xs"
        ariaLabel="便签正文"
      />

      {/* 底部：取色器 + 字数 */}
      <footer className="flex h-8 shrink-0 items-center gap-1.5 border-t border-black/5 px-2">
        {NOTE_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            title={c.name}
            onClick={() => handlePickColor(c.id)}
            className={`h-3.5 w-3.5 rounded-full transition ${
              note.color === c.id ? 'ring-2 ring-black/40' : 'ring-1 ring-black/10 hover:ring-black/30'
            }`}
            style={{ backgroundColor: c.swatch }}
          />
        ))}
        <span className="ml-auto text-[10px] opacity-40">
          {body.length} 字 · {body === '' ? 0 : body.split('\n').length} 行
        </span>
      </footer>
    </div>
  );
}

/** 供类型引用（Note 类型外部消费提示） */
export type { Note };
