import * as React from 'react';
import { Command } from 'cmdk';
import { Search, Star, Wrench } from 'lucide-react';
import { SearchSuggest } from '@/components/SearchSuggest';
import { registry } from '@/core/moduleRegistry';
import { isListableCommand } from '@/core/sensitive';
import { openCommand, openModule, openSettings } from '@/core/navigation';
import { useAppStore } from '@/stores/useAppStore';
import { useFavoritesStore } from '@/stores/useFavoritesStore';
import { useRecentStore } from '@/stores/useRecentStore';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import { resolveIcon } from '@/lib/icons';
import { toPinyinInitials } from '@/lib/search';
import { cn } from '@/lib/utils';
import type { CommandMeta, ModuleMeta } from '@/core/types';

/** 首屏「最近使用」展示上限 */
const RECENT_SHOWN = 6;

/** 模块名 / 关键词 / 拼音首字母是否命中查询。 */
function matchModule(mod: ModuleMeta, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return true;
  }
  const haystack = [mod.name, mod.description, ...mod.keywords].join(' ').toLowerCase();
  if (haystack.includes(q)) {
    return true;
  }
  return toPinyinInitials(mod.name).includes(q);
}

/** 命令行（cmdk item）。 */
function CommandRow({ command }: { command: CommandMeta }): React.JSX.Element {
  const Icon = resolveIcon(command.icon);
  const favorite = useFavoritesStore((state) => state.ids.includes(command.id));
  return (
    <Command.Item
      value={`cmd:${command.id}`}
      onSelect={() => openCommand(command.id)}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none',
        'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{command.name}</span>
      {favorite ? <Star className="h-3.5 w-3.5 shrink-0 fill-brand text-brand" /> : null}
      <span className="shrink-0 truncate text-xs text-muted-foreground">{command.description}</span>
    </Command.Item>
  );
}

/** 模块行（cmdk item）。 */
function ModuleRow({ module }: { module: ModuleMeta }): React.JSX.Element {
  const Icon = resolveIcon(module.icon);
  return (
    <Command.Item
      value={`mod:${module.id}`}
      onSelect={() => openModule(module.id)}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none',
        'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{module.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">模块</span>
    </Command.Item>
  );
}

/** 系统动作行（设置 / 关于 / 收藏当前…；动作式命令）。 */
function ActionRow({ command }: { command: CommandMeta }): React.JSX.Element {
  const Icon = resolveIcon(command.icon);
  return (
    <Command.Item
      value={`sys:${command.id}`}
      onSelect={() => {
        void command.run?.();
      }}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none',
        'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{command.name}</span>
      <span className="shrink-0 truncate text-xs text-muted-foreground">{command.description}</span>
    </Command.Item>
  );
}

/** 按时间段问候（与工作台同一口径：5–12 早 / 12–18 下午 / 其余晚上） */
function greetingOf(hour: number): string {
  if (hour >= 5 && hour < 12) {
    return '早上好';
  }
  if (hour >= 12 && hour < 18) {
    return '下午好';
  }
  return '晚上好';
}

/**
 * 命令面板（V05 统一入口）。
 *
 * - 键盘交互：↑↓ 选择、Enter 打开、Esc（有输入→清空；无输入→隐藏主面板/常驻托盘）；
 * - 首屏：收藏 + 最近使用 + 模块 + 系统命令（`Esc` 空输入时经 Rust 隐藏，浏览器降级为无操作）；
 * - 搜索：`registry.searchCommands`（拼音首字母 + fuse 模糊）。
 */
export function CommandPalette(): React.JSX.Element {
  const [query, setQuery] = React.useState('');

  // 订阅相关切片以保证启停/收藏/最近变化时重渲染
  const modulesState = useAppStore((state) => state.settings.modules);
  const favoriteIds = useFavoritesStore((state) => state.ids);
  const recentIds = useRecentStore((state) => state.ids);

  const modules = React.useMemo(() => registry.enabled(), [modulesState]);
  const systemCommands = React.useMemo(
    () => registry.commands().filter((command) => command.moduleId === 'system'),
    [modulesState],
  );
  const favoriteCommands = React.useMemo(
    () =>
      favoriteIds
        .map((id) => registry.findCommand(id))
        .filter(
          (command): command is CommandMeta =>
            command !== undefined && isListableCommand(command),
        ),
    [favoriteIds, modulesState],
  );
  const recentCommands = React.useMemo(
    () =>
      recentIds
        .map((id) => registry.findCommand(id))
        .filter(
          (command): command is CommandMeta =>
            command !== undefined && isListableCommand(command),
        )
        .slice(0, RECENT_SHOWN),
    [recentIds, modulesState],
  );
  const results = React.useMemo(
    () => (query.trim().length > 0 ? registry.searchCommands(query, { limit: 30 }) : []),
    [query, modulesState],
  );
  const matchedModules = React.useMemo(
    () => (query.trim().length > 0 ? modules.filter((mod) => matchModule(mod, query)) : []),
    [modules, query],
  );

  const trimmed = query.trim();

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'Escape') {
        return;
      }
      if (query.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        setQuery('');
        return;
      }
      // 空输入：隐藏主面板（常驻托盘）；浏览器环境无操作
      if (isTauri()) {
        event.preventDefault();
        void ipc.appHideMain();
      }
    },
    [query],
  );

  return (
    <Command
      shouldFilter={false}
      loop
      onKeyDown={handleKeyDown}
      className="flex h-full flex-col"
    >
      <div className="brand-wash shrink-0 border-b border-border bg-background px-4 pb-3.5 pt-4">
        <div className="flex items-center gap-2.5">
          <span
            className="brand-mark flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-card"
            aria-hidden="true"
          >
            <Wrench className="h-4 w-4 text-white" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold leading-tight tracking-tight">
              <span className="brand-gradient-text">Toolbox</span>
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {greetingOf(new Date().getHours())}，需要什么工具直接搜
            </p>
          </div>
          <kbd className="hidden shrink-0 items-center rounded-md border border-border bg-background/70 px-2 py-1 text-[10px] font-medium text-muted-foreground shadow-card sm:block">
            Alt + Space
          </kbd>
        </div>

        <div
          className={cn(
            'mt-3 flex items-center gap-2 rounded-lg border border-border bg-background px-3 shadow-card',
            'transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-ring/15',
          )}
        >
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="搜索工具或模块，支持拼音首字母（如 sjc → 时间戳）"
            className="h-9 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {query.length > 0 ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="shrink-0 rounded px-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              清除
            </button>
          ) : null}
        </div>
      </div>

      <SearchSuggest />

      <Command.List className="min-h-0 flex-1 scrollbar-thin overflow-auto p-2">
        <Command.Empty className="px-3 py-8 text-center text-sm text-muted-foreground">
          未找到匹配的命令
        </Command.Empty>

        {trimmed.length > 0 ? (
          <>
            {matchedModules.length > 0 ? (
              <Command.Group
                heading="模块"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {matchedModules.map((mod) => (
                  <ModuleRow key={mod.id} module={mod} />
                ))}
              </Command.Group>
            ) : null}
            {results.length > 0 ? (
              <Command.Group
                heading="命令"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {results.map((command) => (
                  <CommandRow key={command.id} command={command} />
                ))}
              </Command.Group>
            ) : null}
          </>
        ) : (
          <>
            {favoriteCommands.length > 0 ? (
              <Command.Group
                heading="收藏"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {favoriteCommands.map((command) => (
                  <CommandRow key={`fav-${command.id}`} command={command} />
                ))}
              </Command.Group>
            ) : null}
            {recentCommands.length > 0 ? (
              <Command.Group
                heading="最近使用"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {recentCommands.map((command) => (
                  <CommandRow key={`recent-${command.id}`} command={command} />
                ))}
              </Command.Group>
            ) : null}
            {modules.length > 0 ? (
              <Command.Group
                heading="模块"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                {modules.map((mod) => (
                  <ModuleRow key={mod.id} module={mod} />
                ))}
              </Command.Group>
            ) : null}
            <Command.Group
              heading="系统"
              className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {systemCommands.map((command) => (
                <ActionRow key={command.id} command={command} />
              ))}
            </Command.Group>
          </>
        )}
      </Command.List>

      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
        <span>↑↓ 选择 · Enter 打开 · Esc 返回 / 关闭</span>
        <button
          type="button"
          onClick={openSettings}
          className="rounded px-2 py-0.5 transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          设置
        </button>
      </div>
    </Command>
  );
}

export default CommandPalette;
