import * as React from 'react';
import { MdText } from '@/components/MdText';
import { CodeBlock } from '@/components/CodeBlock';

/**
 * Markdown 只读渲染 + 代码块语法高亮。
 *
 * # 为什么要「分段渲染」
 *
 * 项目的 Markdown 渲染管线（`@/lib/markdown`）走 marked + DOMPurify，输出的是
 * HTML 字符串，**没法在里面插 React 组件**。而代码高亮需要把代码内容切成一堆
 * `<span class="...">`，正适合用 React 渲染。
 *
 * 于是这里做了最小侵入的处理：把源文本按 ``` 围栏**切开**，
 *   - 非代码段 → 交给既有的 `MdText`（排版、清洗全都复用，不重复造轮子）；
 *   - 代码段 → 交给 `CodeBlock`（带语言标识与高亮）。
 *
 * 好处：不动现有渲染器（风险最小），便签里 ```shell / ```python 立刻有颜色。
 */

/** 一段内容：普通 Markdown 或代码块 */
type Segment =
  | { kind: 'md'; text: string }
  | { kind: 'code'; text: string; lang: string };

/** 按 ``` 围栏切分（支持 ``` 与 ~~~，未闭合的围栏按普通文本处理） */
export function splitFences(source: string): Segment[] {
  const lines = source.split('\n');
  const segments: Segment[] = [];
  let buffer: string[] = [];
  let inCode = false;
  let lang = '';

  const flushMd = (): void => {
    const text = buffer.join('\n');
    buffer = [];
    if (text.trim().length > 0) {
      segments.push({ kind: 'md', text });
    }
  };

  for (const line of lines) {
    const fence = /^\s*(?:```|~~~)\s*([\w+#-]*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        segments.push({ kind: 'code', text: buffer.join('\n'), lang });
        buffer = [];
        inCode = false;
        lang = '';
      } else {
        flushMd();
        inCode = true;
        lang = fence[1] ?? '';
      }
      continue;
    }
    buffer.push(line);
  }

  if (inCode) {
    // 围栏没闭合：当普通文本吐回去，避免「后半段内容凭空消失」
    flushMd();
    segments.push({ kind: 'md', text: '```' + lang + '\n' + buffer.join('\n') });
  } else {
    flushMd();
  }
  return segments;
}

export interface MarkdownWithCodeProps {
  source: string;
  className?: string;
  /** 内容为空时的兜底文本 */
  fallback?: string;
}

/** 只读渲染 Markdown，其中的围栏代码块带语法高亮 */
export function MarkdownWithCode({ source, className, fallback }: MarkdownWithCodeProps): React.JSX.Element {
  const segments = React.useMemo(() => splitFences(source), [source]);

  if (source.trim() === '') {
    return (
      <p className="text-xs text-muted-foreground">
        {fallback ?? '（还没有内容）'}
      </p>
    );
  }

  return (
    <div className={className}>
      {segments.map((segment, index) =>
        segment.kind === 'code' ? (
          <CodeBlock key={`code-${index}`} code={segment.text} lang={segment.lang} />
        ) : (
          <MdText key={`md-${index}`} source={segment.text} />
        ),
      )}
    </div>
  );
}

export default MarkdownWithCode;
