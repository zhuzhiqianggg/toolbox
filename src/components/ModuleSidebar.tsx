import * as React from 'react';
import { Settings as SettingsIcon, Wrench } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { registry } from '@/core/moduleRegistry';
import { openModule, openSettings } from '@/core/navigation';
import { useAppStore } from '@/stores/useAppStore';
import { resolveIcon } from '@/lib/icons';
import { cn } from '@/lib/utils';

export interface ModuleSidebarProps {
  className?: string;
}

/**
 * 模块侧栏（面板内导航）。
 *
 * V04 起改为从 `moduleRegistry.enabled()` 读取启用模块（自动发现，无需改框架）：
 * 新增模块只需新建 `src/modules/<id>/index.ts`，侧栏条目自动出现。
 *
 * V42：`sidebar === false` 的模块（工作台 / 桌面整理）不再列在这里 ——
 * 用户的定位是「这个工具本来就是为了方便顺手使用，其他都可以直接在桌面上实现功能，
 * 不需要一个独立的窗口打开才操作」，所以主面板只留工具箱与密码存储器，那两个模块的
 * 入口在桌面挂件层的工具栏上（命令搜索里也照旧能找到）。
 *
 * V50：主窗口**只留工具箱**（用户原话「主 toolbox 窗口感觉只要工具箱就够了，其他模块
 * 都放桌面实现，只有工具箱才需要一个独立弹出窗口」）。工作台 / 密码箱 / 桌面整理的
 * 完整入口都在桌面侧栏抽屉与托盘里，此处只保留 toolbox，避免主窗塞满模块又回到
 * 「什么都要单独开个窗口」的老路。
 */
export function ModuleSidebar({ className }: ModuleSidebarProps): React.JSX.Element {
  const view = useAppStore((state) => state.view);
  // 订阅启停映射以驱动启用模块列表重渲染
  const modulesState = useAppStore((state) => state.settings.modules);
  // V50：主窗只保留工具箱。其他模块（工作台 / 密码箱 / 桌面整理）走桌面，不占用主窗。
  const modules = React.useMemo(
    () => registry.enabled().filter((mod) => mod.sidebar !== false && mod.id === 'toolbox'),
    [modulesState],
  );

  const activeId = view.kind === 'module' ? view.moduleId : undefined;

  return (
    <nav
      aria-label="模块导航"
      className={cn(
        'flex h-full w-14 flex-col items-center gap-1 border-r border-border bg-background py-3',
        className,
      )}
    >
      {/* 品牌徽标（纯展示，不做导航） */}
      <div
        className="brand-mark mb-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg shadow-card"
        aria-hidden="true"
      >
        <Wrench className="h-5 w-5 text-white" />
      </div>
      <div className="mb-2 h-px w-6 shrink-0 bg-border" aria-hidden="true" />

      {modules.map((mod) => {
        const Icon = resolveIcon(mod.icon);
        const active = mod.id === activeId;
        return (
          <Tooltip key={mod.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={mod.name}
                aria-current={active ? 'page' : undefined}
                onClick={() => openModule(mod.id)}
                className={cn(
                  'group relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-all duration-150',
                  'hover:bg-accent hover:text-accent-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active && 'bg-brand-muted text-brand shadow-sm',
                )}
              >
                {/* 选中指示条：激活模块左侧竖条，一眼看清当前位置 */}
                <span
                  className={cn(
                    'absolute -left-1 top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-brand transition-opacity',
                    active ? 'opacity-100' : 'opacity-0 group-hover:opacity-40',
                  )}
                />
                <Icon className="h-4 w-4 transition-transform duration-150 group-hover:scale-110" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{mod.name}</TooltipContent>
          </Tooltip>
        );
      })}

      <div className="mt-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="设置"
              onClick={openSettings}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors',
                'hover:bg-accent hover:text-accent-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <SettingsIcon className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">设置</TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}
