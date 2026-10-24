import * as React from 'react';
import { Lightbulb } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * 工具「示例」条（V20 新增，配合 `CommandShell.samples` 使用）。
 *
 * # 为什么要有它
 *
 * 用户反馈：「其他剩余各种工具我们要逐个核查优化完善增强功能，**示例文本可以帮助用户快速了解功能**」。
 * 冷启动一个空工具最难 —— 用户得先知道「它能干什么、该喂什么进去」。
 * 于是在标题栏下方放一条**可点击的示例**：点一下就把样例数据铺进输入框（或直接跑一遍），
 * 三秒内看懂工具在做什么，比十行说明文字有效得多。
 *
 * # 设计取向
 *
 * - **入口统一**：示例一律走 `CommandShell` 的 `samples` 属性，不各写各的，样式与位置一致；
 * - **副作用交给调用方**：`apply` 是工具自己给的闭包，可以只填输入框，也可以「填 + 立即执行」；
 * - **不喧宾夺主**：浅色底 + 小圆角 chip，hover 才出实色，收起时几乎不占视线；
 * - **无障碍**：真实 `<button>`，`title` 与 Tooltip 双通道说明（鼠标/键盘都能看到）。
 */

/** 一条示例：`apply` 由工具自行定义（填输入框 / 直接执行 / 同时设置多个字段） */
export interface SampleEntry {
  /** chip 上显示的名字，尽量短（4–10 字），能一眼看出场景 */
  label: string;
  /** 悬停说明：这条示例演示了什么、为什么值得看 */
  description?: string;
  /** 点击后做什么 */
  apply: () => void;
}

export interface SampleBarProps {
  entries: readonly SampleEntry[];
  /** 左侧引导文案，默认「示例」 */
  caption?: string;
  className?: string;
}

/**
 * 示例 chip 行。通常无需直接使用 —— 经 `CommandShell` 的 `samples` 属性传入即可。
 */
export function SampleBar({ entries, caption = '示例', className }: SampleBarProps): React.JSX.Element | null {
  if (entries.length === 0) {
    return null;
  }
  return (
    <div
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1.5 border-b border-border/70 bg-muted/40 px-5 py-2',
        className,
      )}
    >
      <span className="mr-0.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
        <Lightbulb className="h-3.5 w-3.5" />
        {caption}
      </span>
      {entries.map((entry) => (
        <Tooltip key={entry.label}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={entry.apply}
              title={entry.description ?? entry.label}
              className="max-w-[240px] truncate rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] text-foreground transition hover:border-brand/50 hover:bg-brand-muted/60 hover:text-brand"
            >
              {entry.label}
            </button>
          </TooltipTrigger>
          {entry.description ? <TooltipContent>{entry.description}</TooltipContent> : null}
        </Tooltip>
      ))}
      <span className="ml-auto hidden text-[10px] text-muted-foreground/70 sm:inline">
        点击示例即填充，可随意改动
      </span>
    </div>
  );
}

export default SampleBar;
