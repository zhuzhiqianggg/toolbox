import * as React from 'react';
import { Copy, Sigma as SigmaIcon } from 'lucide-react';
import { CommandShell, type SampleEntry } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'number-base';

/**
 * 进制转换（命令 id: number-base）。
 *
 * 定位：程序员的「数字透镜」——一个输入框看清任意整数在二 / 八 / 十 / 十六进制
 * 及自定义进制（2-36）下的形态。核心取舍：
 * - **BigInt 全程承载**：超过 2^53 的整数用 Number 会静默丢精度（如 9007199254740993），
 *   BigInt 精确无损；`BigInt.prototype.toString(radix)` 原生支持 2-36，无需手写进位循环；
 * - **前缀自动识别**：0x / 0b / 0o / 纯数字分别映射十六 / 二 / 八 / 十进制，
 *   下划线作视觉分隔符（0b1010_1010），解析前统一剥离；负号支持；
 * - **Enter 确认制**：输入过程不重算（与 UrlParser 的实时模式刻意区分），
 *   非法输入走行内红条而非 toast，避免连续输入时的提示轰炸。
 */

/** 持久化的工具状态：输入草稿 + 自定义进制 */
interface NumberBaseState {
  input: string;
  customBase: number;
}

/**
 * 数字字面量校验：可选正负号 + 四种形态之一。
 * 下划线 / 空白分隔符已在解析前剥离；十进制允许前导零（BigInt 无八进制歧义，010 = 10）。
 */
const LITERAL_RE = /^[+-]?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+)$/;

/** 自定义进制可选项：2-36（36 = 10 数字 + 26 字母的上限） */
const RADIX_OPTIONS: readonly number[] = Array.from({ length: 35 }, (_, i) => i + 2);

/** 解析输入为 BigInt（自动识别进制）。空串或非法返回 null。 */
function parseBigint(raw: string): bigint | null {
  const cleaned = raw.replace(/[\s_]/g, '');
  if (cleaned.length === 0 || !LITERAL_RE.test(cleaned)) {
    return null;
  }
  try {
    return BigInt(cleaned);
  } catch {
    return null;
  }
}

/** 识别输入采用的进制（仅用于结果区上方的确认提示） */
function detectRadixLabel(cleaned: string): string {
  if (/^0[xX]/.test(cleaned)) {
    return '十六进制（0x 前缀）';
  }
  if (/^0[bB]/.test(cleaned)) {
    return '二进制（0b 前缀）';
  }
  if (/^0[oO]/.test(cleaned)) {
    return '八进制（0o 前缀）';
  }
  return '十进制';
}

/** 复制到剪贴板并给出 Toast 反馈（行内复制按钮此前成功/失败都无任何提示）。 */
function copyWithFeedback(text: string): void {
  void copyText(text).then((ok) => {
    if (ok) {
      toast.success('已复制到剪贴板');
    } else {
      toast.error('复制失败，请手动选择文本复制');
    }
  });
}

interface ResultRowProps {
  label: string;
  value: string;
}

/** 单行结果：名称 + 等宽值 + 行内复制。长串 truncate，悬停 title 看全量。 */
function ResultRow({ label, value }: ResultRowProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground" title={value}>
        {value}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        aria-label={`复制${label}`}
        title={`复制${label}`}
        onClick={() => copyWithFeedback(value)}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function NumberBase({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<NumberBaseState>(COMMAND_ID, {
    input: initialInput,
    customBase: 32,
  });
  // Enter 提交的快照：输入草稿实时持久化，但解析只认提交值
  const [submitted, setSubmitted] = React.useState<string>(() => initialInput || state.input);

  const commit = React.useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      setSubmitted(trimmed);
      patch({ input: trimmed });
    },
    [patch],
  );

  // 历史 / 剪贴板来源的初始输入优先于本地草稿（仅挂载对齐一次）
  React.useEffect(() => {
    if (initialInput.length > 0) {
      commit(initialInput);
    }
  }, [initialInput, commit]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(state.input);
    }
  };

  const value = React.useMemo(() => parseBigint(submitted), [submitted]);
  const hasError = submitted.length > 0 && value === null;

  // 识别提示：提交值非空且合法时展示（帮用户确认前缀被按预期理解）
  const radixHint = React.useMemo(() => {
    if (value === null) {
      return '';
    }
    const cleaned = submitted.replace(/[\s_]/g, '');
    return `已识别为${detectRadixLabel(cleaned)} · 十进制共 ${value.toString(10).length} 位`;
  }, [submitted, value]);

  // 一键复制：惰性拼多行（含自定义进制），结果未就绪时交空串由外壳置灰
  const getCopyTextValue = React.useCallback((): string => {
    if (value === null) {
      return '';
    }
    return [
      `二进制: ${value.toString(2)}`,
      `八进制: ${value.toString(8)}`,
      `十进制: ${value.toString(10)}`,
      `十六进制: ${value.toString(16)}`,
      `自定义（${state.customBase} 进制）: ${value.toString(state.customBase)}`,
    ].join('\n');
  }, [value, state.customBase]);

  const samples = React.useMemo<readonly SampleEntry[]>(
    () => [
      { label: '255', description: '十进制整数，一个字节能表示的最大值', apply: () => commit('255') },
      { label: '0xFF', description: '0x 前缀自动识别为十六进制', apply: () => commit('0xFF') },
      {
        label: '0b1010_1010',
        description: '二进制字面量 + 下划线分隔符，半字节对齐更易读',
        apply: () => commit('0b1010_1010'),
      },
      { label: '2024', description: '普通十进制，四行进制结果一眼对照', apply: () => commit('2024') },
      {
        label: '9007199254740993',
        description: '超过 2^53 的大数 —— Number 会静默丢精度，这里由 BigInt 精确保留',
        apply: () => commit('9007199254740993'),
      },
      {
        label: '-0o17',
        description: '负数 + 八进制前缀组合，四行结果同步带符号',
        apply: () => commit('-0o17'),
      },
    ],
    [commit],
  );

  const customValue = value === null ? '' : value.toString(state.customBase);

  return (
    <CommandShell
      title="进制转换"
      description="二 / 八 / 十 / 十六进制 + 自定义进制，BigInt 大数不丢精度"
      icon={<SigmaIcon className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      getCopyText={getCopyTextValue}
      shortcutHint="Enter 解析 · 0x / 0b / 0o 前缀自动识别 · 下划线作分隔符 · Esc 返回"
      samples={samples}
    >
      <div className="flex flex-col gap-3">
        <input
          type="text"
          value={state.input}
          onChange={(event) => patch({ input: event.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="如 255、0xFF、0b1010_1010、-0o17、9007199254740993"
          autoFocus
          aria-label="数字输入"
          className={cn(
            'h-9 flex-1 rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            hasError && 'border-destructive/60 focus-visible:ring-destructive',
          )}
        />

        {radixHint !== '' ? (
          <div className="text-xs text-muted-foreground">{radixHint}</div>
        ) : null}

        {hasError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            无法识别的数字：支持 0x 十六进制 / 0b 二进制 / 0o 八进制 / 十进制，可含正负号与下划线分隔符
          </div>
        ) : null}

        {value !== null ? (
          <section className="rounded-xl border border-border bg-card p-4 shadow-card">
            <div className="flex flex-col gap-2">
              <ResultRow label="二进制" value={value.toString(2)} />
              <ResultRow label="八进制" value={value.toString(8)} />
              <ResultRow label="十进制" value={value.toString(10)} />
              <ResultRow label="十六进制" value={value.toString(16)} />
              {/* 自定义进制行：label 位置换成 2-36 下拉，其余与标准行同构 */}
              <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                <select
                  value={state.customBase}
                  onChange={(event) => patch({ customBase: Number(event.target.value) })}
                  aria-label="选择自定义进制"
                  className="h-7 shrink-0 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {RADIX_OPTIONS.map((b) => (
                    <option key={b} value={b}>
                      {b} 进制
                    </option>
                  ))}
                </select>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-sm text-foreground"
                  title={customValue}
                >
                  {customValue}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label="复制自定义进制结果"
                  title="复制自定义进制结果"
                  onClick={() => copyWithFeedback(customValue)}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </section>
        ) : submitted.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/50 px-4 py-10 text-center text-sm text-muted-foreground">
            输入数字后按 Enter 解析 · 超过 2^53 的大数由 BigInt 精确保留
          </div>
        ) : null}
      </div>
    </CommandShell>
  );
}

export default NumberBase;
