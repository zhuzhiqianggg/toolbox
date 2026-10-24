import React, { useState } from 'react';
import { RichMarkdown } from '@/components/RichMarkdown';

/**
 * 开发调试页：所见即所得输入框（`?demo=richmarkdown`）。
 *
 * # 为什么需要它
 *
 * `RichMarkdown` 的编辑体验（敲完 `**粗体**` 是否当场变粗体、光标是否乱跳）
 * 只能在**真实浏览器内核**里验证 —— 而工作台里的笔记 / 计划依赖 SQLite，
 * 浏览器预览下是空的，压根到不了这个组件。于是留一个独立的调试入口：
 * 不需要任何数据，打开即得一个可编辑的富文本区，配合自动化脚本做回归。
 *
 * 生产包里它会随主 chunk 之外按需加载，**不影响正常用户路径**。
 */
export default function RichMarkdownDemo(): React.JSX.Element {
  // `?md=<百分号编码的 markdown>` 直接灌一份初值。
  //
  // 为什么必须能灌初值：真机上便签的内容是从 SQLite 读回来、走
  // `root.innerHTML = renderMarkdown(value)` **挂载**进去的 —— 那条路与「用户一个字一个字
  // 敲出来」的路完全不同（前者产出的 `<code>` 以 `\n` 收尾，后者不会）。
  // 自动化脚本若只把 innerHTML 直接抄进去，就绕过了 React 与挂载 effect，
  // 等于测了个假场景（V68 的「回车换行自己消失」正是挂在挂载那条路上）。
  const [markdown, setMarkdown] = useState<string>(() => {
    const raw: string | null = new URLSearchParams(window.location.search).get('md');
    return raw ?? '';
  });

  return (
    <div className="mx-auto flex h-screen max-w-2xl flex-col gap-4 p-8">
      <header>
        <h1 className="text-lg font-semibold text-foreground">RichMarkdown 冒烟页</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          在下面直接敲 Markdown 语法：<code>**加粗**</code>、<code>*斜体*</code>、
          <code>`代码`</code>、<code>~~删除~~</code>、行首 <code># </code>、
          <code>- </code>、<code>1. </code>、<code>&gt; </code>、<code>[] </code>。
          预期：语法敲完当场渲染，不留标记。
        </p>
      </header>

      <div className="min-h-[220px] rounded-lg border border-border bg-background px-3 py-2">
        <RichMarkdown
          value={markdown}
          onChange={setMarkdown}
          placeholder="在这里敲 **加粗** 试试…"
          ariaLabel="所见即所得输入框"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          底层 Markdown 源（应始终是「语法」形态）
        </span>
        <pre
          data-testid="md-source"
          className="scrollbar-thin min-h-0 flex-1 overflow-auto rounded-lg bg-muted p-3 text-xs"
        >
          {markdown}
        </pre>
      </div>
    </div>
  );
}
