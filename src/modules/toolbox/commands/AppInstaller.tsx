import * as React from 'react';
import { Check, Loader2, Package, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { CommandShell, type SampleEntry } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import { cn } from '@/lib/utils';
import type { AppPackage } from '@/types/apps';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'app-installer';

// tool-audit-ignore: samples —— 软件安装不需要「示例输入」，分组/未安装筛选本身即是引导

/**
 * 软件安装（V84）。
 *
 * 定位：新电脑 / 重装后「一次把常用软件装齐」——目录白名单与 winget 命令全在
 * Rust 端（`commands::apps`），页面只负责筛选、触发、反馈；安装状态由注册表直读，
 * 打开即准确。每项点一次就装，装完自动刷新状态。
 */
export function AppInstaller(_props: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [apps, setApps] = React.useState<AppPackage[]>([]);
  const [loading, setLoading] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string>('');
  /** 正在安装/卸载的 key（同一时间只允许一个，winget 本身也不并发） */
  const [busy, setBusy] = React.useState<string>('');
  const [state, patch] = useToolState(COMMAND_ID, { filter: '', group: '全部', onlyMissing: false });
  const { filter, group, onlyMissing } = state;

  /** 高级入口：任意 winget 包 id */
  const [customId, setCustomId] = React.useState<string>('');
  const [customBusy, setCustomBusy] = React.useState<boolean>(false);

  const load = React.useCallback(async (): Promise<void> => {
    if (!isTauri()) {
      setError('软件安装需要在桌面应用内使用');
      return;
    }
    setLoading(true);
    setError('');
    try {
      setApps(await ipc.appsList());
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取软件列表失败');
      setApps([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const groups = React.useMemo(() => ['全部', ...Array.from(new Set(apps.map((a) => a.group)))], [apps]);

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    return apps.filter((app) => {
      if (group !== '全部' && app.group !== group) {
        return false;
      }
      if (onlyMissing && app.installed !== null) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        app.name.toLowerCase().includes(q) ||
        app.wingetId.toLowerCase().includes(q) ||
        app.description.toLowerCase().includes(q)
      );
    });
  }, [apps, filter, group, onlyMissing]);

  const missingCount = React.useMemo(() => apps.filter((a) => a.installed === null).length, [apps]);

  const samples = React.useMemo<SampleEntry[]>(
    () => [
      { label: '只看未装', apply: () => patch({ onlyMissing: true, group: '全部', filter: '' }) },
      { label: '开发', apply: () => patch({ group: '开发', onlyMissing: false, filter: '' }) },
      { label: '效率', apply: () => patch({ group: '效率', onlyMissing: false, filter: '' }) },
    ],
    [patch],
  );

  const run = React.useCallback(
    async (app: AppPackage, action: 'install' | 'uninstall'): Promise<void> => {
      const label = action === 'install' ? '安装' : '卸载';
      const toastId = toast.loading(`正在${label} ${app.name}…`);
      setBusy(app.id);
      try {
        if (action === 'install') {
          await ipc.appsInstall(app.id);
        } else {
          await ipc.appsUninstall(app.id);
        }
        toast.success(`${app.name} 已${label}完成`, { id: toastId });
      } catch (err) {
        toast.error(`${app.name} ${label}失败：${err instanceof Error ? err.message : String(err)}`, {
          id: toastId,
          duration: 8_000,
        });
      } finally {
        setBusy('');
        void load();
      }
    },
    [load],
  );

  const runCustom = React.useCallback(async (): Promise<void> => {
    const id = customId.trim();
    if (!id) {
      toast.error('请输入 winget 包 id，例如 Git.Git');
      return;
    }
    const toastId = toast.loading(`正在安装 ${id}…`);
    setCustomBusy(true);
    try {
      await ipc.appsInstallCustom(id);
      toast.success(`${id} 安装完成`, { id: toastId });
      setCustomId('');
    } catch (err) {
      toast.error(`${id} 安装失败：${err instanceof Error ? err.message : String(err)}`, {
        id: toastId,
        duration: 8_000,
      });
    } finally {
      setCustomBusy(false);
      void load();
    }
  }, [customId, load]);

  return (
    <CommandShell
      title="软件安装"
      description="winget 白名单 · 装完自动刷新状态"
      icon={<Package className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      samples={samples}
      shortcutHint="搜索名称 / 包 id；点右侧按钮即静默安装，装完自动刷新"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              autoFocus
              value={filter}
              onChange={(event) => patch({ filter: event.target.value })}
              placeholder="搜索软件名 / 包 id，如 node、Git.Git"
              aria-label="搜索软件"
              className="h-9 w-full rounded-md border border-input bg-transparent pl-8 pr-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          {filter ? (
            <Button variant="ghost" size="sm" aria-label="清除搜索" onClick={() => patch({ filter: '' })}>
              <X className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {groups.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => patch({ group: name })}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs transition-colors',
                group === name
                  ? 'bg-brand/12 text-brand ring-1 ring-inset ring-brand/25'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => patch({ onlyMissing: !onlyMissing })}
            className={cn(
              'ml-auto rounded-full px-2.5 py-1 text-xs transition-colors',
              onlyMissing
                ? 'bg-amber-500/12 text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300'
                : 'text-muted-foreground hover:bg-accent',
            )}
          >
            只看未安装{missingCount > 0 ? ` (${missingCount})` : ''}
          </button>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="scrollbar-thin flex max-h-[460px] flex-col gap-1 overflow-y-auto pr-1">
          {filtered.map((app) => {
            const installed = app.installed !== null;
            const itemBusy = busy === app.id;
            return (
              <div
                key={app.id}
                className="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{app.name}</p>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                      {app.wingetId}
                    </span>
                    {installed ? (
                      <span className="shrink-0 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 ring-1 ring-inset ring-emerald-500/25 dark:text-emerald-300">
                        {app.installed === '已安装' ? '已安装' : `v${app.installed}`}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{app.description}</p>
                </div>

                {installed ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={itemBusy || !!busy}
                    onClick={() => void run(app, 'uninstall')}
                    aria-label={`卸载 ${app.name}`}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    {itemBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    卸载
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={itemBusy || !!busy}
                    onClick={() => void run(app, 'install')}
                    className="shrink-0"
                  >
                    {itemBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    安装
                  </Button>
                )}
              </div>
            );
          })}

          {filtered.length === 0 && !loading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {apps.length === 0 ? '没有读到软件列表' : '没有匹配的软件'}
            </p>
          ) : null}
          {loading && apps.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">正在读取已安装软件…</p>
          ) : null}
        </div>

        {/* 高级入口：白名单之外的包，直接给 winget id */}
        <div className="rounded-lg border border-border/70 bg-muted/30 p-2.5">
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            白名单里没有？在终端跑 <span className="font-mono">winget search 关键词</span> 拿到 id 后粘在这里
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={customId}
              onChange={(event) => setCustomId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void runCustom();
                }
              }}
              placeholder="Publisher.Package，如 BurntSushi.ripgrep.MSVC"
              aria-label="winget 包 id"
              className="h-8 flex-1 rounded-md border border-input bg-transparent px-2.5 font-mono text-xs shadow-sm placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button size="sm" variant="outline" disabled={customBusy} onClick={() => void runCustom()}>
              {customBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              安装
            </Button>
          </div>
        </div>
      </div>
    </CommandShell>
  );
}

export default AppInstaller;
