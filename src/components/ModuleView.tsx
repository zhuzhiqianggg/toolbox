import * as React from 'react';
import { registry } from '@/core/moduleRegistry';
import { ToolGrid } from '@/components/ToolGrid';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAppStore } from '@/stores/useAppStore';
import { resolveIcon } from '@/lib/icons';
import type { ComponentType } from 'react';
import type { ModuleProps } from '@/core/types';

/**
 * 模块面板内页宿主（V04）。
 *
 * 若模块声明了 `loadView`，惰性加载其自定义视图（未启用模块不加载代码）；
 * 否则回退到通用内容：模块标题 + 该模块的命令网格（`ToolGrid`）。
 */
export function ModuleView({ moduleId }: { moduleId: string }): React.JSX.Element {
  const showPalette = useAppStore((state) => state.showPalette);
  const mod = registry.get(moduleId);
  const [Custom, setCustom] = React.useState<ComponentType<ModuleProps> | null>(null);

  React.useEffect(() => {
    let alive = true;
    setCustom(null);
    if (!mod?.loadView) {
      return () => {
        alive = false;
      };
    }
    mod
      .loadView()
      // guardLoad：START/OK/FAIL 写 Toolbox.log + 10s 超时兜底（避免视图静默挂起）
      .then(() => import('@/lib/diag'))
      .then(({ guardLoad }) => guardLoad(`module:${moduleId}`, () => mod.loadView!()))
      .then((loaded) => {
        if (alive) {
          setCustom(() => loaded.default);
        }
      })
      .catch(() => {
        if (alive) {
          setCustom(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [mod]);

  if (!mod) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">未找到模块「{moduleId}」</p>
        <Button variant="outline" size="sm" onClick={showPalette}>
          返回命令面板
        </Button>
      </div>
    );
  }

  const Icon = resolveIcon(mod.icon);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-muted text-brand">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">{mod.name}</h2>
          <p className="truncate text-xs text-muted-foreground">{mod.description}</p>
        </div>
      </header>
      <Separator />
      {Custom ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <Custom windowKind="main" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 scrollbar-thin overflow-auto p-4">
          <ToolGrid moduleId={moduleId} />
        </div>
      )}
    </div>
  );
}
