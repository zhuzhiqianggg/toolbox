import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/** 基础文本输入框（扁平、聚焦时品牌色描边） */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm text-foreground shadow-none transition-colors',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
