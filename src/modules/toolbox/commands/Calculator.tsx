import * as React from 'react';
import { Calculator as CalculatorIcon } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { useCommandShell } from '@/hooks/useCommandShell';
import { usePersistedState } from '@/hooks/usePersistedState';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'calculator';

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; op: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' }
  | { kind: 'uminus' };

const CONSTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const FUNCS: Record<string, (args: number[]) => number> = {
  sqrt: ([a = 0]) => Math.sqrt(a),
  cbrt: ([a = 0]) => Math.cbrt(a),
  abs: ([a = 0]) => Math.abs(a),
  sign: ([a = 0]) => Math.sign(a),
  round: ([a = 0]) => Math.round(a),
  floor: ([a = 0]) => Math.floor(a),
  ceil: ([a = 0]) => Math.ceil(a),
  trunc: ([a = 0]) => Math.trunc(a),
  sin: ([a = 0]) => Math.sin(a),
  cos: ([a = 0]) => Math.cos(a),
  tan: ([a = 0]) => Math.tan(a),
  asin: ([a = 0]) => Math.asin(a),
  acos: ([a = 0]) => Math.acos(a),
  atan: ([a = 0]) => Math.atan(a),
  ln: ([a = 0]) => Math.log(a),
  log: ([a = 0]) => Math.log10(a),
  log2: ([a = 0]) => Math.log2(a),
  exp: ([a = 0]) => Math.exp(a),
  pow: ([a = 0, b = 0]) => Math.pow(a, b),
  min: (args) => Math.min(...args),
  max: (args) => Math.max(...args),
};

/** 词法分析：把表达式拆成 token 流，处理一元负号。 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let expectOperand = true; // 起始 / 紧跟运算符或左括号时，负号视为一元
  while (i < input.length) {
    const ch = input[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const match = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(input.slice(i));
      if (!match) {
        throw new Error('数字解析失败');
      }
      const matched = match[0] ?? '';
      tokens.push({ kind: 'num', value: Number.parseFloat(matched) });
      i += matched.length;
      expectOperand = false;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(input.slice(i));
      const name = match ? match[0] : '';
      tokens.push({ kind: 'ident', name });
      i += name.length;
      expectOperand = false;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      expectOperand = true;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      expectOperand = false;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' });
      i += 1;
      expectOperand = true;
      continue;
    }
    if ('+-*/%^'.includes(ch)) {
      if (ch === '-' && expectOperand) {
        tokens.push({ kind: 'uminus' });
      } else {
        tokens.push({ kind: 'op', op: ch });
      }
      i += 1;
      expectOperand = true;
      continue;
    }
    throw new Error(`不支持的字符：${ch}`);
  }
  return tokens;
}

const PRECEDENCE: Record<string, number> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  '%': 2,
  '^': 3,
  'u-': 4,
};

/** 调度场算法：中缀 → 逆波兰。 */
function toRpn(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const stack: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'num' || token.kind === 'ident') {
      output.push(token);
      continue;
    }
    if (token.kind === 'op' || token.kind === 'uminus') {
      const op: string = token.kind === 'uminus' ? 'u-' : token.op;
      const prec = PRECEDENCE[op] ?? 0;
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (!top) {
          break;
        }
        let topPrec = -1;
        if (top.kind === 'op') {
          topPrec = PRECEDENCE[top.op] ?? 0;
        } else if (top.kind === 'uminus') {
          topPrec = PRECEDENCE['u-'] ?? 0;
        } else {
          break;
        }
        if (topPrec > prec || (topPrec === prec && op !== '^')) {
          output.push(stack.pop() as Token);
          continue;
        }
        break;
      }
      stack.push(token);
      continue;
    }
    if (token.kind === 'comma') {
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (!top || top.kind === 'lparen') {
          break;
        }
        output.push(stack.pop() as Token);
      }
      continue;
    }
    if (token.kind === 'lparen') {
      stack.push(token);
      continue;
    }
    if (token.kind === 'rparen') {
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (!top || top.kind === 'lparen') {
          break;
        }
        output.push(stack.pop() as Token);
      }
      const popped = stack.pop();
      if (popped?.kind !== 'lparen') {
        throw new Error('括号不匹配');
      }
      // 左括号后的 ident 视为函数
      if (stack.length > 0) {
        const fn = stack[stack.length - 1];
        if (fn && fn.kind === 'ident') {
          output.push(stack.pop() as Token);
        }
      }
    }
  }
  while (stack.length > 0) {
    const top = stack.pop() as Token;
    if (top.kind === 'lparen' || top.kind === 'rparen') {
      throw new Error('括号不匹配');
    }
    output.push(top);
  }
  return output;
}

/** 逆波兰求值。 */
function evalRpn(rpn: Token[]): number {
  const stack: number[] = [];
  for (const token of rpn) {
    if (token.kind === 'num') {
      stack.push(token.value);
    } else if (token.kind === 'ident') {
      if (token.name in CONSTS) {
        const val = CONSTS[token.name];
        stack.push(val ?? 0);
      } else if (token.name in FUNCS) {
        // 函数已在上一步由右括号触发，不应在此再见到
        throw new Error(`函数 ${token.name} 调用方式错误`);
      } else {
        throw new Error(`未知标识符：${token.name}`);
      }
    } else if (token.kind === 'uminus') {
      const a = stack.pop();
      if (a === undefined) {
        throw new Error('表达式不完整');
      }
      stack.push(-a);
    } else if (token.kind === 'op') {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) {
        throw new Error('表达式不完整');
      }
      switch (token.op) {
        case '+':
          stack.push(a + b);
          break;
        case '-':
          stack.push(a - b);
          break;
        case '*':
          stack.push(a * b);
          break;
        case '/':
          stack.push(a / b);
          break;
        case '%':
          stack.push(a % b);
          break;
        case '^':
          stack.push(Math.pow(a, b));
          break;
        default:
          throw new Error(`未知运算符：${token.op}`);
      }
    }
  }
  if (stack.length !== 1) {
    throw new Error('表达式无法化简为一个值');
  }
  return stack[0]!;
}

export function calc(expression: string): number {
  if (expression.trim().length === 0) {
    throw new Error('请输入表达式');
  }
  const tokens = tokenize(expression);
  const rpn = toRpn(tokens);
  return evalRpn(rpn);
}

/** 把浮点结果格式化成简洁字符串。 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return value > 0 ? '∞' : value < 0 ? '-∞' : 'NaN';
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  // 截断到 12 位有效，并去掉尾随 0
  const fixed = value.toPrecision(12);
  return String(Number.parseFloat(fixed));
}

interface HistoryItem {
  expr: string;
  result: string;
}

/**
 * 计算器：安全表达式求值（调度场算法，绝不 eval）。
 * 支持 + - * / % ^、括号、一元负号、函数（sqrt/abs/sin/.../min/max/pow）与常量 pi/e。
 * 输入实时出结果；按 Enter（无 Shift）才把当前表达式记入历史，
 * 避免输入过程中每个可求值的前缀（如 12、123）都刷进历史。
 */
export function Calculator({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [expr, setExpr] = usePersistedState<string>(COMMAND_ID, 'expr', initialInput || '');
  const [history, setHistory] = usePersistedState<HistoryItem[]>(COMMAND_ID, 'history', []);

  const { result, error } = React.useMemo(() => {
    if (expr.trim().length === 0) {
      return { result: '', error: '' };
    }
    try {
      return { result: formatNumber(calc(expr)), error: '' };
    } catch (err) {
      return { result: '', error: err instanceof Error ? err.message : '计算失败' };
    }
  }, [expr]);

  const commitToHistory = React.useCallback(
    (expression: string, value: string) => {
      setHistory((prev) => {
        const next = [{ expr: expression, result: value }, ...prev.filter((h) => h.expr !== expression)].slice(0, 20);
        return next;
      });
    },
    [setHistory],
  );

  const resultText = result || error || '';

  const insertToken = (token: string): void => {
    setExpr((prev) => prev + token);
  };

  return (
    <CommandShell
      title="计算器"
      onPaste={(t) => setExpr(t)}
      description="实时计算 · 支持括号/函数/常量"
      icon={<CalculatorIcon className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={result}
      shortcutHint="输入实时计算 · Enter 记入历史 · 支持 sqrt/log/min/max/pow 与 pi、e（Esc 返回）"
      samples={[
        {
          label: '面积',
          description: '3.14 * 5 ^ 2 —— 圆面积公式',
          apply: () => setExpr('3.14 * 5 ^ 2'),
        },
        {
          label: '对数',
          description: 'log(1000) —— 以 10 为底',
          apply: () => setExpr('log(1000)'),
        },
        {
          label: '最值',
          description: 'max(1, 2, 3, 4) —— 多参函数',
          apply: () => setExpr('max(1, 2, 3, 4)'),
        },
        {
          label: '混合',
          description: '(2 + 3) * 4 - sqrt(16) —— 括号与函数混用',
          apply: () => setExpr('(2 + 3) * 4 - sqrt(16)'),
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="calc-input">
            表达式
          </label>
          <textarea
            id="calc-input"
            autoFocus
            rows={2}
            className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={expr}
            placeholder="例如 1 + 2 * (3 - 4) / 5"
            onChange={(event) => setExpr(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                // Enter（无 Shift）把当前有效结果记入历史；无效表达式不记
                if (result && !error) {
                  commitToHistory(expr, result);
                }
              }
            }}
          />
        </div>

        <div
          className={
            'flex min-h-[3rem] items-center justify-between gap-3 rounded-lg border px-4 py-3 ' +
            (error ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-card')
          }
        >
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{error ? '错误' : '结果'}</div>
            <div
              className={
                'break-all font-mono text-lg ' + (error ? 'text-destructive' : 'text-foreground')
              }
            >
              {resultText || '—'}
            </div>
          </div>
        </div>

        {/* 便捷输入区 */}
        <div className="flex flex-wrap gap-1.5">
          {['7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', '.', '(', ')', '+', '^']
            .map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => insertToken(t)}
                className="h-9 w-9 rounded-md border border-border bg-card text-sm text-foreground transition-colors hover:bg-muted"
              >
                {t}
              </button>
            ))}
          <button
            type="button"
            onClick={() => setExpr('')}
            className="h-9 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-muted"
          >
            清空
          </button>
        </div>

        {/* 历史记录：Enter 显式记入；限高滚动避免长列表把页面撑长 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">历史（点击回填，最多 20 条）</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-destructive"
              disabled={history.length === 0}
              onClick={() => setHistory([])}
            >
              清空历史
            </Button>
          </div>
          {history.length === 0 ? (
            <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
              暂无历史；输入表达式得出结果后按 Enter 记入
            </div>
          ) : (
            <div className="scrollbar-thin flex max-h-[240px] flex-col gap-1.5 overflow-auto">
              {history.map((item, idx) => (
                <button
                  key={`${item.expr}-${idx}`}
                  type="button"
                  onClick={() => setExpr(item.expr)}
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-muted"
                >
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{item.expr}</span>
                  <span className="shrink-0 font-mono text-sm text-foreground">= {item.result}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </CommandShell>
  );
}

export default Calculator;
