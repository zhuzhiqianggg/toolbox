import * as React from 'react';
import { CopyButton } from '@/components/CopyButton';
import { cn } from '@/lib/utils';

export interface ResultBoxProps {
  /** 结果区标题 */
  title?: string;
  /** 结果文本 */
  value: string;
  /** 空值时的提示文案 */
  emptyHint?: string;
  /** 是否使用等宽字体（默认 true，适合 JSON/哈希/代码） */
  mono?: boolean;
  /** 是否显示复制按钮（默认 true） */
  copyable?: boolean;
  /** 附加操作区（如「转便签」） */
  actions?: React.ReactNode;
  /**
   * 填充父容器高度（V15）：两列布局下结果列与输入列等高，
   * 放大窗口后不再残留大片空白。为真时取消 420px 高度上限。
   */
  fill?: boolean;
  className?: string;
}

/** 结果展示区：标题栏 + 复制按钮 + 等宽结果文本（浅色扁平卡片） */
export function ResultBox({
  title = '结果',
  value,
  emptyHint = '暂无结果',
  mono = true,
  copyable = true,
  actions,
  fill = false,
  className,
}: ResultBoxProps): React.JSX.Element {
  const isEmpty = value.length === 0;

  return (
    <div
      className={cn(
        'flex flex-col rounded-xl border border-border bg-card',
        fill && 'min-h-0 flex-1',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <div className="flex items-center gap-2">
          {actions}
          {copyable ? <CopyButton text={value} disabled={isEmpty} /> : null}
        </div>
      </div>
      <div
        className={cn(
          'scrollbar-thin overflow-auto p-4',
          fill ? 'min-h-[160px] flex-1' : 'min-h-[120px] max-h-[420px]',
        )}
      >
        {isEmpty ? (
          <p className="text-sm text-muted-foreground">{emptyHint}</p>
        ) : (
          <pre
            className={cn(
              'whitespace-pre-wrap break-words text-sm text-foreground',
              mono && 'font-mono',
            )}
          >
            {value}
          </pre>
        )}
      </div>
    </div>
  );
}
