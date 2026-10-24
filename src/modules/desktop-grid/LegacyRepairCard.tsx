/**
 * 诊断与修复卡片（V37）。用户能在界面上自助处理两件事：
 *
 * **① 历史收纳残留**
 * V33–V36 的「真实收纳」把用户桌面文件搬进了 `桌面/Handy整理/<容器>/`，而
 * `copy_dir_recursive` 的自复制缺陷（见 `grid.rs::move_with_conflict_rename`）在桌面上
 * 炸出 **5 个目录 / 129,714 条目 / 296 GB / 最深 1001 层 / 最长路径 7082 字符**。
 * 这里提供一条安全的回家路：先「撤回桌面」（**只移动，绝不删除**），确认无误后再「清理残留」。
 *
 * **② 日志**
 * 用户回传日志的入口。以前排查只能靠用户开控制台、或者我事后翻磁盘 —— 现在
 * 「打开日志目录 / 看最近内容 / 清空」都在这儿，出错时把日志发回来就能定位。
 *
 * 写操作全部先 `dryRun` 预演，把**真实数字**摊开给用户看，再执行。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ipc } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { reportOperation } from '@/lib/errorSink';
import { confirmAction } from '@/lib/confirmAction';
import type { LegacyRootInfo, LogInfo } from '@/types/grid';

/** 字节数 → 人能读的大小（仅本卡片展示用） */
function humanBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${index === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/** 日志预览只看最后这么多行，避免把整块界面撑爆 */
const LOG_TAIL_LINES = 200;

export function LegacyRepairCard(): React.JSX.Element {
  const [roots, setRoots] = useState<LegacyRootInfo[]>([]);
  const [scanning, setScanning] = useState(true);
  const [working, setWorking] = useState<'reclaim' | 'cleanup' | null>(null);
  const [logInfo, setLogInfo] = useState<LogInfo | null>(null);
  const [logTail, setLogTail] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    setScanning(true);
    try {
      setRoots(await ipc.gridLegacyScan());
    } catch (error) {
      reportOperation('扫描历史收纳目录', error);
    } finally {
      setScanning(false);
    }
  }, []);

  const refreshLog = useCallback(async (): Promise<void> => {
    try {
      const [info, tail] = await Promise.all([ipc.logInfo(), ipc.logReadTail()]);
      setLogInfo(info);
      setLogTail(tail);
    } catch (error) {
      reportOperation('读取日志', error);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshLog();
  }, [refresh, refreshLog]);

  // `entries` 只数两层（不受上限影响，是精确值）；另两个在深目录里会被封顶，届时显示「≥ N」
  const entries = roots.reduce((sum, root) => sum + root.entries, 0);
  const totalBytes = roots.reduce((sum, root) => sum + root.bytes, 0);
  const nested = roots.reduce((sum, root) => sum + root.nestedEntries, 0);
  const truncated = roots.some((root) => root.truncated);

  const reclaim = useCallback(async (): Promise<void> => {
    setWorking('reclaim');
    try {
      // 先预演 —— 用户点「确定」时看到的必须是真实数量，不是估计值
      const preview = await ipc.gridLegacyReclaim(true);
      if (preview.moved === 0) {
        toast.info('没有需要撤回的条目', {
          description:
            preview.skipped > 0
              ? `${preview.skipped} 个条目的桌面已有同名，无需再搬`
              : undefined,
        });
        return;
      }
      const ok = await confirmAction(
        `把 ${preview.moved} 个条目撤回桌面？\n\n` +
          `· 只是移动，不删除任何文件；\n` +
          `· 桌面已有同名的 ${preview.skipped} 个会自动跳过（同一份文件不搬两遍）；\n` +
          `· 撤回后 Handy整理 目录会空出来，可以再点「清理残留」把空间还给你。`,
      );
      if (!ok) {
        return;
      }
      const result = await ipc.gridLegacyReclaim(false);
      await refresh();
      toast.success(`已撤回 ${result.moved} 个条目到桌面`, {
        description:
          result.failures.length > 0
            ? `${result.failures.length} 个失败，详情见日志`
            : '文件一个都没少',
      });
      result.failures.forEach((line) => reportOperation('撤回条目', line));
    } catch (error) {
      reportOperation('撤回历史收纳目录', error);
      toast.error('撤回失败，详情已写进日志');
    } finally {
      setWorking(null);
    }
  }, [refresh]);

  const cleanup = useCallback(async (): Promise<void> => {
    setWorking('cleanup');
    try {
      const preview = await ipc.gridLegacyCleanup(true);
      if (preview.removed === 0) {
        toast.info('没有可以清理的目录', {
          description: preview.skipped[0] ?? '先把条目撤回桌面再来清理',
        });
        return;
      }
      const ok = await confirmAction(
        `删除 ${preview.removed} 个 Handy整理 残留目录，释放约 ${humanBytes(preview.freedBytes)}？\n\n` +
          `· 这些目录放的都是「已经撤回桌面」的文件（或是自己套自己的重复副本）；\n` +
          `· 里面只要还有「桌面上找不到同名」的条目，就会自动跳过不删；\n` +
          `· 删除不可撤销。`,
      );
      if (!ok) {
        return;
      }
      const result = await ipc.gridLegacyCleanup(false);
      await refresh();
      toast.success(`已清理 ${result.removed} 个目录`, {
        description: `释放约 ${humanBytes(result.freedBytes)}${
          result.skipped.length > 0 ? `；${result.skipped.length} 个因没撤干净被跳过` : ''
        }`,
      });
      result.skipped.forEach((line) => reportOperation('跳过清理', line));
      result.failures.forEach((line) => reportOperation('清理失败', line));
      await refreshLog();
    } catch (error) {
      reportOperation('清理历史收纳目录', error);
      toast.error('清理失败，详情已写进日志');
    } finally {
      setWorking(null);
    }
  }, [refresh, refreshLog]);

  const tailLines = logTail.split('\n').slice(-LOG_TAIL_LINES).join('\n');

  return (
    <div className="mb-5 space-y-3">
      {/* —— 历史收纳残留 —— */}
      <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0',
              entries > 0 ? 'text-amber-500' : 'text-muted-foreground',
            )}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs font-medium text-foreground">历史收纳残留</p>
            {scanning ? (
              <p className="text-xs text-muted-foreground">正在检查…</p>
            ) : roots.length === 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                未发现遗留的 桌面/Handy整理/ 目录 —— 你的桌面是干净的。
              </p>
            ) : (
              <>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  发现 <span className="font-medium text-foreground">{roots.length}</span> 个
                  Handy整理 目录，里面有{' '}
                  <span className="font-medium text-foreground">{entries}</span> 个条目等着回家，
                  占用约{' '}
                  <span className="font-medium text-foreground">
                    {truncated ? '≥ ' : ''}
                    {humanBytes(totalBytes)}
                  </span>
                  {nested > 0 && (
                    <>
                      （其中 {truncated ? '≥ ' : ''}
                      {nested} 条是自己套自己的重复副本，清理时一并删除）
                    </>
                  )}
                  。
                </p>
                {truncated && (
                  <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-500">
                    目录嵌套太深，<span className="font-medium">统计已封顶</span>
                    （单棵最多数 10000 条以免开着页面就卡住），实际规模只会更大。
                  </p>
                )}
                <ul className="space-y-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  {roots.map((root) => (
                    <li key={root.path} className="truncate" title={root.path}>
                      · {root.name} —— {root.entries} 个待撤回条目 / {root.truncated ? '≥ ' : ''}
                      {humanBytes(root.bytes)}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button size="sm" onClick={() => void reclaim()} disabled={working !== null}>
                    {working === 'reclaim' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Undo2 className="h-3.5 w-3.5" />
                    )}
                    撤回桌面
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void cleanup()}
                    disabled={working !== null}
                  >
                    {working === 'cleanup' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    清理残留
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={scanning}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    重新检查
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* —— 日志 —— */}
      <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
        <div className="flex items-start gap-3">
          <FileText className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs font-medium text-foreground">日志</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              操作与报错都会写进这里。遇到问题先
              <span className="font-medium text-foreground">打开日志目录</span>
              把 <span className="font-medium text-foreground">handy.log</span> 发我，
              比「点了没反应」这种描述有用得多。
              {logInfo !== null && (
                <>
                  {' '}
                  当前 {humanBytes(logInfo.size)}
                  {logInfo.rotated > 0 ? `，另有 ${logInfo.rotated} 份历史日志` : ''}。
                </>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void ipc
                    .logOpenDir()
                    .catch((error: unknown) => reportOperation('打开日志目录', error));
                }}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                打开日志目录
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void refreshLog()}>
                <RefreshCw className="h-3.5 w-3.5" />
                刷新
              </Button>
              <Button
                variant="ghost"
                size="sm"
              onClick={async () => {
                if (!(await confirmAction('清空日志？已写下的排查线索会一起没了。'))) {
                  return;
                }
                  void ipc
                    .logClear()
                    .then(() => refreshLog())
                    .catch((error: unknown) => reportOperation('清空日志', error));
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                清空
              </Button>
            </div>
            {tailLines.trim() !== '' && (
              <pre className="scrollbar-thin mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-neutral-900/70 p-2 text-[10px] leading-relaxed text-neutral-300">
                {tailLines}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
