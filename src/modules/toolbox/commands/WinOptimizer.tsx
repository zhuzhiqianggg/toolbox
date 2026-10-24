import * as React from 'react';
import { Crown, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import { cn } from '@/lib/utils';
import type { WinOptItem, WinOptTarget } from '@/types/winopt';
import type { CommandProps } from '@/core/types';

// tool-audit-ignore: samples —— 开关型系统设置没有「示例输入」概念，说明文案已承载引导
// tool-audit-ignore: persist —— 状态以 Windows 注册表为唯一事实源，进入页面即读真实状态

const COMMAND_ID = 'win-optimizer';

/**
 * Windows 优化（V62）。
 *
 * 定位（用户口径）：「永远用不到、白耗性能的功能可以禁用」——精选务实清单
 * （OneDrive / 隐私广告 / 系统性能 / 游戏后台），右键菜单等有用项不碰。
 * 形态：只读展示状态 + 点选切换 + 一键还原；提权项点击弹 UAC，拒绝即无副作用。
 * 键盘操作：开关均为 button[role=switch]，Tab 聚焦、空格/回车切换；Esc 返回面板。
 */

/** 状态徽章样式与文案 */
const STATUS_BADGE: Record<WinOptItem['status'], { label: string; className: string }> = {
  applied: {
    label: '已优化',
    className: 'bg-emerald-500/12 text-emerald-600 ring-emerald-500/25 dark:text-emerald-300',
  },
  default: {
    label: '系统默认',
    className: 'bg-muted text-muted-foreground ring-border',
  },
  unknown: {
    label: '未知',
    className: 'bg-amber-500/12 text-amber-600 ring-amber-500/25 dark:text-amber-300',
  },
};

/** 开关组件（role=switch，键盘可操作） */
function OptSwitch({
  checked,
  busy,
  onToggle,
}: {
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? '还原为系统默认' : '启用优化'}
      disabled={busy}
      onClick={onToggle}
      className={cn(
        'relative h-5.5 w-10 shrink-0 rounded-full transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:cursor-wait disabled:opacity-60',
        checked ? 'bg-brand' : 'bg-border',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-all duration-200',
          checked ? 'left-[1.375rem]' : 'left-0.5',
        )}
      />
    </button>
  );
}

/** 单个优化项行 */
function OptRow({
  item,
  busy,
  onToggle,
  onAction,
}: {
  item: WinOptItem;
  busy: boolean;
  onToggle: (item: WinOptItem) => void;
  onAction: (item: WinOptItem) => void;
}): React.JSX.Element {
  const badge = STATUS_BADGE[item.status];
  const applied = item.status === 'applied';

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors',
        'hover:border-border hover:bg-accent/40',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
          {item.elevated ? (
            <span
              title="需要管理员授权（UAC）"
              className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-amber-600 ring-1 ring-inset ring-amber-500/30 dark:text-amber-300"
            >
              <Crown className="h-2.5 w-2.5" />
              管理员
            </span>
          ) : null}
          <span
            className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset', badge.className)}
          >
            {badge.label}
          </span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {item.description}
        </p>
      </div>

      {item.actionOnly ? (
        <button
          type="button"
          disabled={busy || applied}
          onClick={() => onAction(item)}
          className={cn(
            'shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
            'bg-rose-500/10 text-rose-600 ring-1 ring-inset ring-rose-500/25',
            'hover:bg-rose-500/20 dark:text-rose-300',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {applied ? '已卸载' : '卸载'}
        </button>
      ) : (
        <OptSwitch checked={applied} busy={busy} onToggle={() => onToggle(item)} />
      )}
    </div>
  );
}

/** 主视图：分组渲染 + 一键还原（还原入口在 CommandShell 标题栏右侧） */
export function WinOptimizer(_props: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [items, setItems] = React.useState<WinOptItem[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState(false);

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const list = await ipc.winoptList();
      setItems(list);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 切换：optimistic 更新，失败回滚 + toast */
  const handleToggle = React.useCallback(
    (item: WinOptItem): void => {
      const target: WinOptTarget = item.status === 'applied' ? 'default' : 'applied';
      if (item.elevated) {
        toast.info('即将弹出 UAC 授权窗口', { description: '取消授权不会做任何更改' });
      }
      setBusyId(item.id);
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: target } : it)),
      );
      void ipc
        .winoptApply(item.id, target)
        .then(() => {
          if (item.notice.length > 0) {
            toast.info(item.notice);
          } else if (target === 'applied') {
            toast.success(`已优化：${item.name}`);
          } else {
            toast.success(`已还原：${item.name}`);
          }
        })
        .catch((err: unknown) => {
          // 回滚显示并重读真实状态
          void refresh();
          toast.error(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusyId(null));
    },
    [refresh],
  );

  /** 单向动作（卸载 OneDrive） */
  const handleAction = React.useCallback(
    (item: WinOptItem): void => {
      setBusyId(item.id);
      void ipc
        .winoptAction(item.id)
        .then(() => {
          toast.success(`${item.name}完成`, { description: item.notice || undefined });
        })
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setBusyId(null);
          void refresh();
        });
    },
    [refresh],
  );

  /** 一键还原：把已优化项全部写回 Windows 默认 */
  const handleRestoreAll = React.useCallback((): void => {
    const appliedItems = items.filter((item) => item.status === 'applied' && !item.actionOnly);
    if (appliedItems.length === 0) {
      toast.info('没有需要还原的项');
      return;
    }
    const elevatedCount = appliedItems.filter((item) => item.elevated).length;
    if (elevatedCount > 0) {
      toast.info(`包含 ${elevatedCount} 项需要管理员授权`, { description: 'UAC 弹窗逐项确认，取消即跳过该项' });
    }
    setRestoring(true);
    let ok = 0;
    let fail = 0;
    const queue = [...appliedItems];
    const next = (): void => {
      const item = queue.shift();
      if (!item) {
        setRestoring(false);
        void refresh();
        if (fail > 0) {
          toast.warning(`还原完成：${ok} 项成功，${fail} 项失败`);
        } else {
          toast.success(`已还原 ${ok} 项为 Windows 默认`);
        }
        return;
      }
      setBusyId(item.id);
      void ipc
        .winoptApply(item.id, 'default')
        .then(() => {
          ok += 1;
        })
        .catch(() => {
          fail += 1;
        })
        .finally(next);
    };
    next();
  }, [items, refresh]);

  // 分组（保持 Rust 表顺序：首次出现的组名顺序即展示顺序）
  const groups = React.useMemo(() => {
    const map = new Map<string, WinOptItem[]>();
    for (const item of items) {
      const list = map.get(item.group);
      if (list) {
        list.push(item);
      } else {
        map.set(item.group, [item]);
      }
    }
    return [...map.entries()];
  }, [items]);

  const appliedCount = items.filter((item) => item.status === 'applied' && !item.actionOnly).length;

  return (
    <CommandShell
      title="Windows 优化"
      description="精选务实清单：只列确定安全、随时可还原的系统项"
      icon={<ShieldCheck className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      primaryAction={{
        label: '一键还原',
        onClick: handleRestoreAll,
        disabled: restoring || appliedCount === 0,
      }}
      fill
      shortcutHint="Tab 聚焦开关 · 空格 / 回车切换 · Esc 返回"
    >
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3">
        {!isTauri() ? (
          <p className="shrink-0 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300">
            浏览器预览模式：需要 Toolbox 桌面版才能读写系统状态
          </p>
        ) : null}

        {/** 加载中 / 出错：收在外壳内，保证返回与收藏始终可用 */}
        {!loaded ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
            正在读取系统状态…
          </div>
        ) : error !== null ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <TriangleAlert className="h-8 w-8 text-amber-500" />
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
        ) : (
          <>
            {/* 顶部摘要条 */}
            <div className="flex shrink-0 items-center gap-2.5 rounded-xl border border-border bg-background px-4 py-3 shadow-card">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-muted text-brand">
                <RotateCcw className={cn('h-4 w-4', restoring && 'animate-spin')} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {appliedCount > 0 ? `已优化 ${appliedCount} 项` : '全部为系统默认'}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  右键菜单等有用功能不碰；带
                  <Crown className="mx-0.5 inline h-3 w-3 align-[-1px] text-amber-500" />
                  的项应用 / 还原时需 UAC 管理员授权，取消即无副作用
                </p>
              </div>
            </div>

            {/* 分组列表 */}
            <div className="scrollbar-thin min-h-0 flex-1 overflow-auto pb-1">
              <div className="space-y-4">
                {groups.map(([group, groupItems]) => (
                  <section key={group}>
                    <h3 className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">{group}</h3>
                    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card divide-y divide-border/60">
                      {groupItems.map((item) => (
                        <OptRow
                          key={item.id}
                          item={item}
                          busy={busyId === item.id || restoring}
                          onToggle={handleToggle}
                          onAction={handleAction}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </CommandShell>
  );
}

export default WinOptimizer;
