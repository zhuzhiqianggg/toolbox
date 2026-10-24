import * as React from 'react';
import { ModuleSidebar } from '@/components/ModuleSidebar';
import { ResizeHandles } from '@/components/ResizeHandles';
import { TitleBar } from '@/components/TitleBar';
import { Toaster } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface AppLayoutProps {
  children: React.ReactNode;
  /** 自定义侧栏；缺省渲染 `ModuleSidebar` */
  sidebar?: React.ReactNode;
  /** 是否显示侧栏（便签等轻量窗可关闭） */
  showSidebar?: boolean;
  className?: string;
}

/**
 * 主面板整体布局：标题栏（无边框窗口自绘）+ 左侧模块侧栏 + 右侧内容区。
 *
 * V15：窗口放开为可缩放后，根节点改为纵向 flex（标题栏独占一行），
 * 并在最外层铺 `ResizeHandles`（8 方向热区）供边缘 / 四角拖拽缩放。
 * 内容区保持 `min-w-0` + 自滚动，避免宽内容把布局撑破。
 */
export function AppLayout({
  children,
  sidebar,
  showSidebar = true,
  className,
}: AppLayoutProps): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          'relative flex h-full w-full flex-col overflow-hidden bg-background text-foreground',
          className,
        )}
      >
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          {showSidebar ? (sidebar ?? <ModuleSidebar />) : null}
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
        </div>
        <ResizeHandles />
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
