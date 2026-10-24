import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  /** 待复制文本 */
  text: string;
  /** 按钮文案（默认「复制」） */
  label?: string;
  /** 复制成功回调 */
  onCopied?: (text: string) => void;
}

/**
 * 一键复制按钮：复制成功后短暂显示「已复制」并弹 Toast。
 * 剪贴板能力经 `lib/clipboard` 统一封装（Tauri 优先，浏览器降级）。
 */
export function CopyButton({
  text,
  label = '复制',
  variant = 'outline',
  size = 'sm',
  className,
  onCopied,
  disabled,
  ...props
}: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const handleClick = React.useCallback(async (): Promise<void> => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      onCopied?.(text);
      toast.success('已复制到剪贴板');
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error('复制失败，请手动选择文本复制');
    }
  }, [text, onCopied]);

  return (
    <Button
      {...props}
      variant={variant}
      size={size}
      disabled={disabled}
      className={cn('gap-1.5', className)}
      onClick={handleClick}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? '已复制' : label}
    </Button>
  );
}
