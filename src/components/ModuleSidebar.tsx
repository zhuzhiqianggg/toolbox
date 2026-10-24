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
 * V61（用户口径）：侧栏恢复完整模块导航 —— 工作台（`notes`）/ 工具箱（`toolbox`）/
 * 便签（`sticky`）都列在主面板侧栏，模块声明 `sidebar: false` 才隐藏。
 * 模块级启停仍由设置中心管辖（`registry.enabled()` 已过滤停用模块）。
 */
export function ModuleSidebar({ className }: ModuleSidebarProps): React.JSX.Element {
  const view = useAppStore((state) => state.view);
  // 订阅启停映射以驱动启用模块列表重渲染
  const modulesState = useAppStore((state) => state.settings.modules);
  const modules = React.useMemo(
    () => registry.enabled().filter((mod) => mod.sidebar !== false),
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
