import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { CaseSensitive } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'case-converter';

type CaseKind = 'snake' | 'camel' | 'kebab' | 'pascal' | 'title' | 'constant';

const CASE_LABELS: Record<CaseKind, string> = {
  snake: 'snake_case',
  camel: 'camelCase',
  kebab: 'kebab-case',
  pascal: 'PascalCase',
  title: 'Title Case',
  constant: 'CONSTANT_CASE',
};

/** 将任意命名风格拆分为单词数组（处理驼峰、连字符、下划线、数字边界）。 */
function splitWords(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-./\\]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

function toCase(input: string, kind: CaseKind): string {
  const words = splitWords(input);
  if (words.length === 0) {
    return '';
  }
  switch (kind) {
    case 'snake':
      return words.map((word) => word.toLowerCase()).join('_');
    case 'kebab':
      return words.map((word) => word.toLowerCase()).join('-');
    case 'constant':
      return words.map((word) => word.toUpperCase()).join('_');
    case 'camel':
      return words
        .map((word, i) =>
          i === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
        )
        .join('');
    case 'pascal':
      return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('');
    case 'title':
      return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
    default:
      return input;
  }
}

/**
 * 大小写转换：一次输入，实时输出 snake / camel / kebab / Pascal / Title / CONSTANT 六种风格，
 * 每条可单独复制。
 */
export function CaseConverter({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput);

  const results = React.useMemo<Record<CaseKind, string>>(() => {
    const kinds: CaseKind[] = ['snake', 'camel', 'kebab', 'pascal', 'title', 'constant'];
    return kinds.reduce((acc, kind) => {
      acc[kind] = toCase(input, kind);
      return acc;
    }, {} as Record<CaseKind, string>);
  }, [input]);

  /** 拆词结果（给用户反馈：六种风格都基于这几个词重排，拆错了这里一眼看出） */
  const wordCount = React.useMemo(() => splitWords(input).length, [input]);
  const hasInput = input.trim().length > 0;

  return (
    <CommandShell
      title="大小写转换"
      onPaste={(t) => setInput(t)}
      description="snake / camel / kebab / Pascal / Title / CONSTANT 互转"
      icon={<CaseSensitive className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={Object.values(results).filter((value) => value).join('\n')}
      shortcutHint="一次输入，六种风格实时输出，可逐条复制"
      samples={[
        {
          label: '变量名',
          description: 'userProfileImageUrl —— 最常见的驼峰转 snake / kebab',
          apply: () => setInput('userProfileImageUrl'),
        },
        {
          label: '数据库字段',
          description: 'order_id —— 下划线风格转小驼峰（写接口 DTO 常用）',
          apply: () => setInput('order_id'),
        },
        {
          label: '路径式输入',
          description: 'api/v2/user-profile.get —— 空格 / 点 / 斜杠都当分隔符拆词',
          apply: () => setInput('api/v2/user-profile.get'),
        },
        {
          label: '连续大写缩写',
          description: 'HTTPResponseCode —— 检验 HTTP 这类缩写能否正确拆开',
          apply: () => setInput('HTTPResponseCode'),
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground" htmlFor="case-input">
              输入文本
            </label>
            {hasInput ? (
              <span className="text-xs text-muted-foreground">
                检测到 {wordCount} 个单词{wordCount === 0 ? '，没有可识别的字母或数字' : ''}
              </span>
            ) : null}
          </div>
          <textarea
            id="case-input"
            rows={3}
            autoFocus
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={input}
            placeholder="hello world / userName / order_id"
            onChange={(event) => setInput(event.target.value)}
          />
        </div>
        {hasInput ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(Object.keys(CASE_LABELS) as CaseKind[]).map((kind) => (
              <div key={kind} className="flex flex-col gap-1 rounded-md border border-border bg-card p-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{CASE_LABELS[kind]}</span>
                  <CopyButton text={results[kind]} disabled={!results[kind]} label="复制" />
                </div>
                <code className="break-all font-mono text-sm text-foreground">{results[kind] || '—'}</code>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
            输入一个变量名、字段名或任意短语，上方六种命名风格会实时生成，每条可单独复制
          </p>
        )}
      </div>
    </CommandShell>
  );
}

export default CaseConverter;
