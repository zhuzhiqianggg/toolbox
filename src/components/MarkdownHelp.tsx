import React, { useEffect, useRef, useState } from 'react';
import { HelpCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 便签编辑器的「?」语法帮助浮层（V21）。
 *
 * # 为什么要它
 *
 * 用户反馈：「桌面 markdown 编辑不需要头工具栏……旁边 ? 小图标可以增加工具等用法介绍，
 * 当然 markdown 编辑器加个语法说明」。
 *
 * 于是编辑器的工具栏被撤掉（少一层视觉噪音、正文区更大），代价是「怎么写」这件事
 * 没有入口了 —— 这个浮层就是那个入口：把**平时记不住的几条**（代码块、任务项、表格）
 * 连同**编辑器特有的操作**（回车换行、Esc 跳出代码块、右键贴到桌面）一次说清。
 *
 * 定位：按钮 DOM 外**不裁剪**（父级 header 没有 `overflow:hidden`），因此直接用
 * `absolute right-0 top-full` 锚在按钮下方即可；面板宽度做了 `min()` 限流，
 * 窄便签窗里也不会顶出屏幕。
 */

/** 一行语法示例 */
interface SyntaxRow {
  /** 写法（等宽展示） */
  code: string;
  /** 效果说明 */
  text: string;
}

/** 最常用、最容易忘的几条 —— 按「用得上的顺序」排，不是按 Markdown 规范排 */
const SYNTAX: readonly SyntaxRow[] = [
  { code: '# 标题', text: '一级标题（## 二级，最多 ###### 六级）' },
  { code: '**重点**', text: '加粗（敲完第二个星号立刻变粗）' },
  { code: '*斜体*', text: '斜体' },
  { code: '~~删除~~', text: '删除线' },
  { code: '- 条目', text: '无序列表（敲完「- 」空格即变列表）' },
  { code: '1. 条目', text: '有序列表' },
  { code: '- [ ] 待办', text: '任务项，方框可直接点' },
  { code: '> 引用', text: '引用块' },
  { code: '`行内代码`', text: '行内代码' },
  { code: '```shell', text: '代码块围栏 + 语言（下一行开始写代码）' },
  { code: '| 列 | 列 |', text: '表格（第二行写 | --- | --- |）' },
  { code: '---', text: '分割线' },
  { code: '[文字](https://…)', text: '链接（外链在新窗口打开）' },
];

/** 编辑器自己特有的操作（不是 Markdown 语法，光看语法表学不到） */
const EDITOR_TIPS: readonly string[] = [
  '语法敲完**当场渲染**，不需要切「预览」——这里没有预览按钮。',
  '代码块里回车 = 换行；**末行空着再回车**或按 Esc 就跳出代码块。',
  '在代码块首行敲语言名再回车（如 ```sh ⏎），颜色立刻生效。',
  '空代码块里按退格 = 撤掉这个围栏。',
  '编辑区内容**自动保存**（约 0.7 秒落一次盘），关窗不丢。',
  '列表 / 便签列表上**右键**可把便签贴成桌面悬浮窗。',
];

export interface MarkdownHelpProps {
  /** 触发按钮的附加样式 */
  className?: string;
  /** 面板对齐方向：靠容器右侧（默认）或左侧 */
  align?: 'left' | 'right';
}

/**
 * 「?」帮助按钮 + 用法浮层。
 *
 * @param props 见 `MarkdownHelpProps`
 * @returns 按钮与浮层（浮层挂在按钮容器内，靠 z-index 压住正文）
 */
export function MarkdownHelp({ className, align = 'right' }: MarkdownHelpProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 点空白处 / 按 Esc 关闭
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title="Markdown 语法与用法说明"
        aria-label="Markdown 语法与用法说明"
        aria-expanded={open}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full border transition',
          open
            ? 'border-brand/50 bg-brand-muted text-brand'
            : 'border-border text-muted-foreground hover:border-brand/40 hover:text-brand',
        )}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>

      {open ? (
        <div
          className={cn(
            'absolute top-full z-50 mt-1.5 w-[min(360px,calc(100vw-48px))] overflow-hidden rounded-xl border border-border bg-card shadow-xl',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold text-foreground">怎么用这个编辑器</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="关闭"
              className="ml-auto rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          <div className="scrollbar-thin max-h-[min(420px,60vh)] overflow-y-auto p-3">
            <ul className="mb-3 flex flex-col gap-1">
              {EDITOR_TIPS.map((tip: string) => (
                <li key={tip} className="flex gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  <span className="mt-[3px] h-1 w-1 shrink-0 rounded-full bg-brand" />
                  <TipText text={tip} />
                </li>
              ))}
            </ul>

            <p className="mb-1.5 text-[11px] font-medium text-foreground">常用语法</p>
            <div className="flex flex-col gap-0.5">
              {SYNTAX.map((row: SyntaxRow) => (
                <div key={row.code} className="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-accent/40">
                  <code className="w-[118px] shrink-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground" title={row.code}>
                    {row.code}
                  </code>
                  <span className="text-[11px] text-muted-foreground">{row.text}</span>
                </div>
              ))}
            </div>

            <p className="mt-3 rounded-md bg-muted/60 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              围栏里写语言名就有语法高亮，内置：shell / python / javascript(ts) / json /
              yaml / java / go / sql / ini(toml)。其它语言按纯文本显示，不会报错。
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 把 `**xx**` 渲染成加粗（帮助文案里只有这一种标记，够用） */
function TipText({ text }: { text: string }): React.JSX.Element {
  const parts: string[] = text.split('**');
  return (
    <span>
      {parts.map((part: string, index: number) =>
        index % 2 === 1 ? (
          <strong key={index} className="font-medium text-foreground">
            {part}
          </strong>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </span>
  );
}

export default MarkdownHelp;
