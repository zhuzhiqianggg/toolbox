import type * as React from 'react';
import { Toaster as SonnerToaster, toast } from 'sonner';

/**
 * Toast：直接接入 `sonner`（TASKS §1.1 指定），全局单例。
 * - 在应用根（AppLayout）挂载一次 `<Toaster />`；
 * - 业务代码 `import { toast } from '@/components/ui/toast'` 后调用 `toast.success(...)` / `toast.error(...)`。
 */
export { toast };

/** 全局 Toast 容器（浅色扁平，右上角） */
export function Toaster(): React.JSX.Element {
  return (
    <SonnerToaster
      position="top-center"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'rounded-lg border border-border bg-card text-foreground shadow-popover text-sm',
        },
      }}
    />
  );
}
