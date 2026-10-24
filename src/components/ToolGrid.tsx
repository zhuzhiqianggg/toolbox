import * as React from 'react';
import { Star } from 'lucide-react';
import { registry } from '@/core/moduleRegistry';
import { openCommand } from '@/core/navigation';
import { resolveIcon } from '@/lib/icons';
import { categoryMetaOf } from '@/core/toolCategories';
import { cn } from '@/lib/utils';
import type { CommandMeta } from '@/core/types';

export interface ToolGridProps {
  /** 模块 id（取其下命令）；与 `commands` 二选一，`commands` 优先 */
  moduleId?: string;
  /** 直接指定要渲染的命令（首页分组 / 搜索结果用） */
  commands?: readonly CommandMeta[];
  /** 展示收藏星标（默认 false；卡片本身不可点星标，仅作标记） */
  showFavoriteMark?: boolean;
  favoriteIds?: readonly string[];
  className?: string;
}

interface ToolCardProps {
  command: CommandMeta;
  favorite?: boolean;
  showFavoriteMark: boolean;
}

function ToolCard({ command, favorite, showFavoriteMark }: ToolCardProps): React.JSX.Element {
  const Icon = resolveIcon(command.icon);
  // 分类决定图标底色：没有分类（系统命令等）回落品牌色，不会开天窗
  const meta = categoryMetaOf(command.category);
  const chip = meta?.chip ?? 'bg-brand-muted text-brand';

  return (
    <button
      type="button"
      onClick={() => openCommand(command.id)}
      title={command.description}
      className={cn(
        'group relative flex flex-col gap-2.5 rounded-xl border border-border bg-card p-4 text-left',
        'shadow-card transition-all duration-200 ease-out',
        'hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        'active:translate-y-0',
      )}
    >
      <span className="flex items-center gap-3">
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 ease-out',
            'group-hover:scale-105',
            chip,
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className="truncate text-sm font-medium text-foreground">{command.name}</span>
            {showFavoriteMark && favorite ? (
              <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
            ) : null}
          </span>
          {meta ? (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {meta.name}
            </span>
          ) : null}
        </span>
      </span>
      <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {command.description}
      </span>
    </button>
  );
}

/**
 * 工具网格（点击打开命令）。
 *
 * V24：`commands` 可直接传入（首页按分类/收藏分组时用），卡片改用分类配色的图标块
 * 并加了 hover 微抬升 —— 24 个工具平铺时，颜色是唯一能让人快速扫到目标的东西。
 */
export function ToolGrid({
  moduleId,
  commands,
  showFavoriteMark = false,
  favoriteIds,
  className,
}: ToolGridProps): React.JSX.Element {
  const resolved = React.useMemo<readonly CommandMeta[]>(() => {
    if (commands) {
      return commands;
    }
    return moduleId ? registry.commandsOf(moduleId) : [];
  }, [commands, moduleId]);

  if (resolved.length === 0) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>该模块暂无可用的工具。</p>
    );
  }

  return (
    <div className={cn('grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-4', className)}>
      {resolved.map((command) => (
        <ToolCard
          key={command.id}
          command={command}
          showFavoriteMark={showFavoriteMark}
          favorite={favoriteIds?.includes(command.id)}
        />
      ))}
    </div>
  );
}
