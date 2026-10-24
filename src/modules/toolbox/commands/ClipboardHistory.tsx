import * as React from 'react';
import { History as HistoryIcon, Copy, Trash2, Eraser } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { usePersistedState } from '@/hooks/usePersistedState';
import { copyText } from '@/lib/clipboard';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'clipboard-history';

// tool-audit-ignore: samples —— 本工具是被动记录器（没有输入框），示例条无处可填

const MAX_ENTRIES = 50;
const MAX_ENTRY_CHARS = 5000;

interface HistoryEntry {
  text: string;
  ts: number;
}

function preview(text: string): string {
  const oneLine = text.replace(/\r\n/g, '\n').replace(/\n/g, '⏎ ');
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 剪贴板历史：持久化环形缓冲（上限 50 条）。
 *
 * 受限于 `@tauri-apps/plugin-clipboard-manager` 当前版本**没有全局监听 API**（仅 read/write），
 * 无法在工具关闭时后台捕获系统级复制。本工具采用「打开时轮询捕获 + 手动捕获」方案：
 * 工具在前台时每 800ms 读一次剪贴板，内容有变化就入栈；配合持久化可跨会话保留。
 * 关闭态的系统级监听为后续升级项（需另写 Rust 后台监听）。
 */
export function ClipboardHistory({}: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [items, setItems] = usePersistedState<HistoryEntry[]>(COMMAND_ID, 'items', []);

  // 最近一次「被本工具观察到」的剪贴板文本；写入也同步更新，避免把我们自己写回的内容当新条目
  const lastSeenRef = React.useRef<string>('');

  const addEntry = React.useCallback(
    (text: string) => {
      const trimmed = text.slice(0, MAX_ENTRY_CHARS);
      if (!trimmed) {
        return;
      }
      if (lastSeenRef.current === trimmed) {
        return;
      }
      lastSeenRef.current = trimmed;
      setItems((prev) => {
        // 与既有最新条目相同则跳过（不重复）
        if (prev[0]?.text === trimmed) {
          return prev;
        }
        return [{ text: trimmed, ts: Date.now() }, ...prev].slice(0, MAX_ENTRIES);
      });
    },
    [setItems],
  );

  const captureCurrent = React.useCallback(async (): Promise<void> => {
    try {
      const text = await readText();
      addEntry(text);
    } catch {
      /* 非文本 / 读取失败：忽略 */
    }
  }, [addEntry]);

  // 挂载即采样一次当前剪贴板
  React.useEffect(() => {
    void captureCurrent();
    // 打开期间轮询捕获（800ms）
    const timer = window.setInterval(() => {
      void captureCurrent();
    }, 800);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyEntry = React.useCallback(async (text: string): Promise<void> => {
    const ok = await copyText(text);
    if (!ok) {
      toast.error('复制失败，请手动选择文本复制');
      return;
    }
    // 仅在写成功后同步 lastSeen，避免「写失败还被当成已观察过」而漏记后续复制
    lastSeenRef.current = text;
    toast.success('已复制到剪贴板');
  }, []);

  const removeEntry = React.useCallback(
    (ts: number) => {
      setItems((prev) => prev.filter((e) => e.ts !== ts));
    },
    [setItems],
  );

  const clearAll = React.useCallback(() => {
    setItems([]);
    lastSeenRef.current = '';
  }, [setItems]);

  return (
    <CommandShell
      title="剪贴板历史"
      description="前台自动捕获 · 跨会话保留（上限 50 条）"
      icon={<HistoryIcon className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={items.map((e) => e.text).join('\n')}
      shortcutHint="工具打开时自动记录复制内容；点击「复制」可重新写入剪贴板"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void captureCurrent()}>
            <Copy className="h-3.5 w-3.5" />
            捕获当前剪贴板
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            disabled={items.length === 0}
            className="text-muted-foreground"
          >
            <Eraser className="h-3.5 w-3.5" />
            清空
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">{items.length} / {MAX_ENTRIES}</span>
        </div>

        {items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">
            还没有记录。复制点什么，或点「捕获当前剪贴板」。
          </div>
        ) : (
          <div className="scrollbar-thin flex max-h-[420px] flex-col gap-2 overflow-auto">
            {items.map((e) => (
              <div
                key={e.ts}
                className="group flex items-start gap-3 rounded-md border border-border bg-card p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{formatTime(e.ts)}</span>
                    <span>·</span>
                    <span>{e.text.length} 字</span>
                  </div>
                  <code className="block break-all whitespace-pre-wrap font-mono text-xs text-foreground">
                    {preview(e.text)}
                  </code>
                </div>
                <div className="flex shrink-0 items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="复制"
                    title="复制此条目"
                    onClick={() => void copyEntry(e.text)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    aria-label="删除"
                    title="删除此条目"
                    onClick={() => removeEntry(e.ts)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </CommandShell>
  );
}

export default ClipboardHistory;
