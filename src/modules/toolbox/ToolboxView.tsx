import * as React from 'react';
import { Search, X } from 'lucide-react';
import { ToolGrid } from '@/components/ToolGrid';
import { Button } from '@/components/ui/button';
import { registry } from '@/core/moduleRegistry';
import { useFavoritesStore } from '@/stores/useFavoritesStore';
import { useRecentStore } from '@/stores/useRecentStore';
import {
  categoryMetaOf,
  orderedCategories,
  type ToolCategoryMeta,
} from '@/core/toolCategories';
import { cn } from '@/lib/utils';
import type { CommandMeta, ModuleProps, ToolCategory } from '@/core/types';

/** 一条命令的「可被搜索文本」：名称 / 描述 / 别名 / 关键词 / id / 分类名。 */
function haystackOf(command: CommandMeta): string {
  return [
    command.name,
    command.description,
    command.id,
    ...command.aliases,
    ...command.keywords,
    categoryMetaOf(command.category)?.name ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

interface SectionProps {
  title: string;
  hint?: string;
  count: number;
  commands: readonly CommandMeta[];
  favoriteIds: readonly string[];
  children?: React.ReactNode;
}

function Section({ title, hint, count, commands, favoriteIds, children }: SectionProps) {
  if (commands.length === 0 && !children) {
    return null;
  }
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
        {hint ? <span className="truncate text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      <ToolGrid commands={commands} showFavoriteMark favoriteIds={favoriteIds} />
      {children}
    </section>
  );
}

/**
 * 工具箱（M1）面板内页。
 *
 * V24 之前这里是**一张 24 宫格平铺**，工具一多就找不到（而且后续还要继续加）。
 * 现在改成「搜索 + 分类页签 + 收藏 / 最近 + 按分类分组」四层：
 *   - 有搜索词或选了分类 → 只出结果网格（带计数与空态）；
 *   - 否则进入浏览态：收藏 → 最近使用 → 按分类分组的完整清单。
 * 分组数据全部来自 `CommandMeta.category`，新增工具只要填了分类就会自动出现在对应组里。
 */
export function ToolboxView(_props: ModuleProps): React.JSX.Element {
  const all = React.useMemo(() => registry.commandsOf('toolbox'), []);
  const [query, setQuery] = React.useState('');
  const [activeCat, setActiveCat] = React.useState<'all' | ToolCategory>('all');

  const favoriteIds = useFavoritesStore((state) => state.ids);
  const recentIds = useRecentStore((state) => state.ids);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((command) => {
      if (activeCat !== 'all' && command.category !== activeCat) {
        return false;
      }
      if (!q) {
        return true;
      }
      return haystackOf(command).includes(q);
    });
  }, [all, activeCat, query]);

  // 浏览态 = 没搜索也没选分类：此时才展示收藏/最近 + 全部分组
  const browsing = query.trim().length === 0 && activeCat === 'all';

  const byId = React.useMemo(() => new Map(all.map((item) => [item.id, item])), [all]);

  const favorites = React.useMemo(
    () => favoriteIds.map((id) => byId.get(id)).filter((item): item is CommandMeta => !!item),
    [favoriteIds, byId],
  );

  const recents = React.useMemo(
    () =>
      recentIds
        .filter((id) => !favoriteIds.includes(id))
        .map((id) => byId.get(id))
        .filter((item): item is CommandMeta => !!item),
    [recentIds, favoriteIds, byId],
  );

  const groups = React.useMemo(
    () =>
      orderedCategories()
        .map((cat) => ({
          cat,
          items: all.filter((command) => command.category === cat.id),
        }))
        .filter((group) => group.items.length > 0),
    [all],
  );

  /** 分类页签：全部 + 有工具的分类（带计数） */
  const tabs = React.useMemo(() => {
    const counts = new Map<ToolCategory, number>();
    for (const command of all) {
      if (command.category) {
        counts.set(command.category, (counts.get(command.category) ?? 0) + 1);
      }
    }
    return orderedCategories()
      .filter((cat) => counts.has(cat.id))
      .map((cat) => ({ cat: cat as ToolCategoryMeta, count: counts.get(cat.id) ?? 0 }));
  }, [all]);

  const reset = (): void => {
    setQuery('');
    setActiveCat('all');
  };

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="brand-wash shrink-0 px-5 pb-4 pt-5">
        <p className="text-[13px] text-muted-foreground">
          {all.length} 个工具 · 也可用快捷键呼出命令面板直接搜名称或拼音首字母
        </p>

        {/* 搜索框 */}
        <div className="relative mt-3.5">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索工具…"
            aria-label="搜索工具"
            className={cn(
              'h-10 w-full rounded-lg border border-border bg-card pl-10 pr-9 text-sm text-foreground shadow-card',
              'placeholder:text-muted-foreground',
              'transition-colors focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-ring/15',
            )}
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="清空搜索"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        {/* 分类页签 */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setActiveCat('all')}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              activeCat === 'all'
                ? 'border-primary/30 bg-primary/10 font-medium text-primary'
                : 'border-border bg-card text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground',
            )}
          >
            全部 {all.length}
          </button>
          {tabs.map(({ cat, count }) => {
            const active = activeCat === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActiveCat(active ? 'all' : cat.id)}
                title={cat.hint}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs transition-colors',
                  active
                    ? 'border-primary/30 bg-primary/10 font-medium text-primary'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {cat.name} {count}
              </button>
            );
          })}
        </div>
      </header>

      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-5 pb-5">
        {browsing ? (
          <div className="space-y-6">
            <Section
              title="收藏"
              count={favorites.length}
              commands={favorites}
              favoriteIds={favoriteIds}
            />
            <Section
              title="最近使用"
              hint={recents.length ? '（已收藏的不重复显示）' : undefined}
              count={recents.length}
              commands={recents}
              favoriteIds={favoriteIds}
            />
            {groups.map(({ cat, items }) => (
              <Section
                key={cat.id}
                title={cat.name}
                hint={cat.hint}
                count={items.length}
                commands={items}
                favoriteIds={favoriteIds}
              />
            ))}
          </div>
        ) : filtered.length > 0 ? (
          <div className="space-y-2.5">
            <p className="text-[11px] text-muted-foreground">
              匹配到 {filtered.length} 个工具
            </p>
            <ToolGrid commands={filtered} showFavoriteMark favoriteIds={favoriteIds} />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-muted-foreground">没有匹配的工具</p>
            <Button variant="outline" size="sm" onClick={reset}>
              清空筛选
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ToolboxView;
