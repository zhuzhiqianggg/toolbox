import React, { useMemo } from 'react';
import { renderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import '@/styles/markdown.css';

/**
 * 只读 Markdown 渲染（`.md-preview` 排版）。
 *
 * 用于「展示一段 Markdown，但不提供编辑」的场景：待办标题 / 说明摘要、贴条里的条目、
 * 笔记预览等。与 `RichMarkdown`（可编辑）共用同一套 CSS，因此**编辑态与展示态长得一样**，
 * 不会出现「编辑时是 A 样、存完变 B 样」的割裂。
 */

export interface MdTextProps {
  /** Markdown 源文本 */
  source: string;
  /**
   * 行内模式：段落 / 标题压成 inline，使渲染结果**跟着行内排**（列表行里显示标题用）。
   */
  inline?: boolean;
  /** 附加样式 */
  className?: string;
  /** 源为空时的兜底文本（不传则不渲染） */
  fallback?: string;
}

/**
 * 只读渲染一段 Markdown。
 *
 * @param props 见 `MdTextProps`
 * @returns 渲染节点；源为空时返回兜底文本或 `null`
 */
export function MdText({ source, inline = false, className, fallback }: MdTextProps): React.JSX.Element | null {
  const html: string = useMemo((): string => renderMarkdown(source), [source]);

  if (source.trim() === '') {
    return fallback === undefined ? null : <span className={className}>{fallback}</span>;
  }

  return (
    <div
      className={cn('md-preview', inline && 'md-inline', className)}
      // 内容已过 DOMPurify 清洗（见 @/lib/markdown），可安全注入
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export default MdText;
