import * as React from 'react';
import { Network as NetworkIcon, RefreshCw, Copy, X } from 'lucide-react';
import { CommandShell, type SampleEntry } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import { ipc, type PortEntry } from '@/lib/ipc';
import { copyText } from '@/lib/clipboard';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'port-query';

/**
 * 端口占用查询：调 Rust 命令 `port_occupants`（netstat + tasklist 解析），
 * 展示协议 / 本地地址:端口 / 状态 / PID / 进程名，支持按端口或进程名过滤，
 * 每条可一键复制 `taskkill` 命令（不直接结束进程，避免误杀系统进程）。
 */
export function PortQuery({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [entries, setEntries] = React.useState<PortEntry[]>([]);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string>('');
  // 过滤词持久化（V62）：切走再回来不丢；用剪贴板建议 / 历史打开时以 initialInput 起始
  const [state, patch] = useToolState(COMMAND_ID, { filter: initialInput });
  const filter = state.filter;
  const setFilter = React.useCallback((value: string): void => patch({ filter: value }), [patch]);

  /** 示例条（V62）：常用过滤场景一键填入 */
  const samples = React.useMemo<SampleEntry[]>(
    () => [
      { label: '80 端口', apply: () => setFilter('80') },
      { label: 'chrome 进程', apply: () => setFilter('chrome') },
      { label: 'LISTEN 态', apply: () => setFilter('LISTEN') },
    ],
    [setFilter],
  );

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const data = await ipc.portOccupants();
      setEntries(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '查询失败');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) {
      return entries;
    }
    return entries.filter(
      (e) =>
        e.localPort.toString().includes(q) ||
        e.processName.toLowerCase().includes(q) ||
        e.localAddress.toLowerCase().includes(q) ||
        e.pid.toString().includes(q),
    );
  }, [entries, filter]);

  const taskkillCmd = (e: PortEntry): string => `taskkill /PID ${e.pid} /F`;

  return (
    <CommandShell
      title="端口占用查询"
      onPaste={(t) => setFilter(t)}
      description="协议 / 端口 / 状态 / PID / 进程名"
      icon={<NetworkIcon className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      samples={samples}
      copyText={filtered.map((e) => `${e.localPort}\t${e.state}\t${e.pid}\t${e.processName}`).join('\n')}
      shortcutHint="按端口号 / 进程名 / PID 过滤；复制按钮生成 taskkill 命令（不直接结束进程）"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            autoFocus
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="过滤：端口 / 进程名 / PID，如 8080、chrome"
            aria-label="过滤端口占用"
            className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {filter.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label="清除过滤"
              onClick={() => setFilter('')}
            >
              <X className="h-3.5 w-3.5" />
              清除
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={'h-3.5 w-3.5' + (loading ? ' animate-spin' : '')} />
            刷新
          </Button>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="text-xs text-muted-foreground">
          共 {filtered.length} 条{filter ? `（已过滤，总数 ${entries.length}）` : ''}
        </div>

        <div className="scrollbar-thin max-h-[420px] overflow-auto rounded-md border border-border">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">协议</th>
                <th className="px-3 py-2 font-medium">本地端口</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">PID</th>
                <th className="px-3 py-2 font-medium">进程</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, idx) => (
                <tr key={`${e.protocol}-${e.localAddress}-${idx}`} className="border-t border-border">
                  <td className="px-3 py-2 text-foreground">{e.protocol}</td>
                  <td className="px-3 py-2 font-mono text-foreground">{e.localPort}</td>
                  <td className="px-3 py-2 text-muted-foreground">{e.state || '—'}</td>
                  <td className="px-3 py-2 font-mono text-muted-foreground">{e.pid}</td>
                  <td className="px-3 py-2 text-foreground">{e.processName}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label="复制结束命令"
                      title={taskkillCmd(e)}
                      onClick={() => {
                        void copyText(taskkillCmd(e));
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
              {loading && filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    正在读取端口占用…
                  </td>
                </tr>
              ) : null}
              {filtered.length === 0 && !loading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {entries.length === 0 ? '没有查询到端口占用' : '没有匹配的结果'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </CommandShell>
  );
}

export default PortQuery;
