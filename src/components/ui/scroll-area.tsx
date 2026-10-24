import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 是否在纵向滚动时隐藏横向溢出（默认 true） */
  hideHorizontal?: boolean;
}

/**
 * 轻量滚动容器（细滚动条，扁平观感）。
 * 采用原生 overflow 而非 Radix ScrollArea，避免额外依赖与多层 DOM。
 */
export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, hideHorizontal = true, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'scrollbar-thin overflow-y-auto',
        hideHorizontal ? 'overflow-x-hidden' : 'overflow-x-auto',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  ),
);
ScrollArea.displayName = 'ScrollArea';
