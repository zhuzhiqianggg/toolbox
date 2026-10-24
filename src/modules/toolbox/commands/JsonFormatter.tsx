import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Braces, ChevronDown, ChevronRight, Search } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { ResultBox } from '@/components/ResultBox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { copyText as writeClipboard } from '@/lib/clipboard';
import { locateJsonError } from '@/lib/jsonLocate';
import { cn } from '@/lib/utils';
import {
  analyzeJson,
  containerPreview,
  formatMatchValue,
  isContainer,
  leafText,
  nodeCopyText,
  parseJsonPath,
  queryJsonPath,
  toCsv,
  toTypeScript,
  toYaml,
  type JsonStats,
  type JsonPathMatch,
} from '@/modules/toolbox/lib/jsonUtils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'json-formatter';

type OutputMode = 'pretty' | 'min' | 'tree' | 'csv' | 'yaml' | 'ts';
/** 缩进选项（仅格式化模式生效） */
type Indent = '2' | '4';

/** 模式 Tab 定义 */
const MODES: ReadonlyArray<{ value: OutputMode; label: string }> = [
  { value: 'pretty', label: '格式化' },
  { value: 'min', label: '压缩' },
  { value: 'tree', label: '树视图' },
  { value: 'csv', label: 'CSV' },
  { value: 'yaml', label: 'YAML' },
  { value: 'ts', label: 'TypeScript' },
];

/** 超过该长度即视为「大 JSON」：仍会格式化，但延后到空闲帧并给出提示 */
const BIG_INPUT_BYTES = 500 * 1024;
/** 树视图渲染节点上限（超出后停止展开，避免 DOM 爆炸） */
const TREE_NODE_LIMIT = 3000;
/** JSONPath 结果条数上限 */
const PATH_RESULT_LIMIT = 200;

const SAMPLE_JSON = `{
  "store": {
    "name": "Toolbox 商店",
    "book": [
      { "title": "顺风而行", "price": 39.9, "tags": ["new", "hot"], "stock": true },
      { "title": "桌面效率手册", "price": 58, "tags": ["classic"], "stock": false }
    ],
    "owner": { "id": 1001, "vip": null }
  },
  "code": 0
}`;

/** Tab 按钮（统一风格，与项目其它工具一致） */
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-2 py-1 text-xs transition-colors',
        active
          ? 'bg-brand-muted text-brand'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** 统计格子 */
function StatCell({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-md bg-muted px-2 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/**
 * 在空闲帧执行任务（大 JSON 格式化让出一帧，避免输入卡顿）。
 * 不支持 `requestIdleCallback` 的环境降级为 `setTimeout(0)`。
 */
function scheduleIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(() => callback(), { timeout: 500 });
    return () => {
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(id);
      }
    };
  }
  const id = window.setTimeout(callback, 0);
  return () => {
    window.clearTimeout(id);
  };
}

/** 从 `JSON.parse` 失败中定位行列（复用项目既有扫描器） */
function describeError(raw: string, message: string): string {
  const spot = locateJsonError(raw);
  if (spot === null) {
    return message;
  }
  return `第 ${spot.line} 行第 ${spot.column} 列：${spot.reason}\n${spot.snippet}`;
}

/** 按模式生成输出文本；不可转换时返回 warning（不抛异常） */
function renderText(
  value: unknown,
  mode: OutputMode,
  indent: Indent,
): { text: string; warning: string | null } {
  switch (mode) {
    case 'pretty':
      return { text: JSON.stringify(value, null, Number(indent)), warning: null };
    case 'min':
      return { text: JSON.stringify(value), warning: null };
    case 'tree':
      return { text: '', warning: null };
    case 'csv': {
      const result = toCsv(value);
      return result.ok
        ? { text: result.text, warning: null }
        : { text: '', warning: result.error };
    }
    case 'yaml':
      return { text: toYaml(value), warning: null };
    case 'ts':
      return { text: toTypeScript(value, 'Root'), warning: null };
    default:
      return { text: '', warning: null };
  }
}

/** 叶子值配色 */
function leafClassName(value: unknown): string {
  if (typeof value === 'string') {
    return 'text-emerald-600';
  }
  if (typeof value === 'number') {
    return 'text-blue-600';
  }
  if (typeof value === 'boolean') {
    return 'text-purple-600';
  }
  return 'text-muted-foreground';
}

/** 键名配色（对象键 / 数组索引） */
function keyClassName(isIndex: boolean): string {
  return isIndex ? 'text-amber-700' : 'text-sky-700';
}

interface TreeNodeProps {
  /** 键名（根节点为 null） */
  name: string | null;
  /** 是否为数组元素（用索引样式） */
  isIndex: boolean;
  value: unknown;
  path: string;
  depth: number;
  onCopy: (text: string, label: string) => void;
  /** 可变计数器：超过节点上限后停止渲染 */
  counter: { used: number };
}

/**
 * 树视图递归节点：对象 / 数组可折叠展开（默认展开前 2 层），
 * hover 显示「复制值 / 复制 JSONPath」按钮。
 */
function TreeNode({
  name,
  isIndex,
  value,
  path,
  depth,
  onCopy,
  counter,
}: TreeNodeProps): React.JSX.Element {
  const [open, setOpen] = React.useState<boolean>(depth < 2);
  const expandable = isContainer(value);
  counter.used += 1;
  const overLimit = counter.used > TREE_NODE_LIMIT;

  const children: React.ReactNode[] = [];
  if (expandable && open && !overLimit) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (counter.used > TREE_NODE_LIMIT) {
          return;
        }
        children.push(
          <TreeNode
            key={`${path}[${index}]`}
            name={String(index)}
            isIndex
            value={item}
            path={`${path}[${index}]`}
            depth={depth + 1}
            onCopy={onCopy}
            counter={counter}
          />,
        );
      });
    } else if (typeof value === 'object' && value !== null) {
      Object.keys(value as Record<string, unknown>).forEach((key) => {
        if (counter.used > TREE_NODE_LIMIT) {
          return;
        }
        const childPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
          ? `${path}.${key}`
          : `${path}[${JSON.stringify(key)}]`;
        children.push(
          <TreeNode
            key={childPath}
            name={key}
            isIndex={false}
            value={(value as Record<string, unknown>)[key]}
            path={childPath}
            depth={depth + 1}
            onCopy={onCopy}
            counter={counter}
          />,
        );
      });
    }
  }

  const copyValue = (): void => {
    onCopy(nodeCopyText(value), '值已复制');
  };
  const copyPath = (): void => {
    onCopy(path, 'JSONPath 已复制');
  };

  return (
    <div className={cn(depth > 0 && 'ml-3 border-l border-border pl-2')}>
      <div className="group flex items-start gap-1 rounded px-1 py-0.5 hover:bg-accent/60">
        {expandable ? (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            aria-label={open ? '折叠' : '展开'}
            className="mt-[2px] shrink-0 text-muted-foreground"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="mt-[2px] w-3.5 shrink-0" />
        )}

        <span className={cn('shrink-0 font-mono text-xs', keyClassName(isIndex))}>
          {name === null ? '$' : name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">:</span>

        {expandable ? (
          <span className="font-mono text-xs text-muted-foreground">
            {containerPreview(value)}
          </span>
        ) : (
          <span className={cn('break-all font-mono text-xs', leafClassName(value))}>
            {leafText(value)}
          </span>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={copyPath}
            className="rounded border border-border bg-background px-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            {name === null ? '复制 $' : '复制路径'}
          </button>
          <button
            type="button"
            onClick={copyValue}
            className="rounded border border-border bg-background px-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            复制值
          </button>
        </span>
      </div>

      {children.length > 0 ? <div>{children}</div> : null}
      {overLimit ? (
        <div className="ml-3 py-1 text-[11px] text-muted-foreground">
          …节点过多，已停止展开（上限 {TREE_NODE_LIMIT}）
        </div>
      ) : null}
    </div>
  );
}

/** 树视图容器 */
function JsonTree({
  value,
  onCopy,
}: {
  value: unknown;
  onCopy: (text: string, label: string) => void;
}): React.JSX.Element {
  const counter = React.useMemo<{ used: number }>(() => ({ used: 0 }), [value]);
  // 每次渲染前清零：TreeNode 在渲染期递增计数（渲染非幂等），
  // StrictMode 下同一棵树会渲染两遍，不清零会让节点上限提前耗尽。
  counter.used = 0;
  return (
    <TreeNode
      name={null}
      isIndex={false}
      value={value}
      path="$"
      depth={0}
      onCopy={onCopy}
      counter={counter}
    />
  );
}

/**
 * JSON 格式化器（对齐 ops-tools 参考实现）：
 * 6 种输出模式（格式化 / 压缩 / 树视图 / CSV / YAML / TypeScript）、
 * JSONPath 查询（自写基础子集解析器）、统计面板（含最大嵌套深度）、
 * 大 JSON 空闲帧处理、语法校验错误行列定位。
 */
export function JsonFormatter({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput);
  const [mode, setMode] = usePersistedState<OutputMode>(COMMAND_ID, 'mode', 'pretty');
  const [indent, setIndent] = usePersistedState<Indent>(COMMAND_ID, 'indent', '2');
  const [pathQuery, setPathQuery] = usePersistedState<string>(COMMAND_ID, 'pathQuery', '');
  const [output, setOutput] = React.useState<string>('');
  const [warning, setWarning] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<boolean>(false);

  // 解析结果（语法错误 → error；合法 → value）
  const parsed = React.useMemo<
    { ok: true; value: unknown } | { ok: false; error: string } | { ok: false; error: null; empty: true }
  >(() => {
    const raw = input.trim();
    if (raw.length === 0) {
      return { ok: false, error: null, empty: true };
    }
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: describeError(raw, message) };
    }
  }, [input]);

  const stats = React.useMemo<JsonStats | null>(
    () => (parsed.ok ? analyzeJson(input, parsed.value) : null),
    [parsed, input],
  );

  // 输出文本：大输入延后到空闲帧执行（仍会执行，只是不阻塞输入）
  React.useEffect(() => {
    if (!parsed.ok) {
      setOutput('');
      setWarning(null);
      setBusy(false);
      return;
    }
    const isBig = input.length > BIG_INPUT_BYTES;
    setBusy(isBig);
    let cancelled = false;
    const cancel = scheduleIdle(() => {
      if (cancelled) {
        return;
      }
      const rendered = renderText(parsed.value, mode, indent);
      if (cancelled) {
        return;
      }
      setOutput(rendered.text);
      setWarning(rendered.warning);
      setBusy(false);
    });
    return () => {
      cancelled = true;
      cancel();
    };
  }, [parsed, mode, indent, input.length]);

  // JSONPath 查询（解析失败给出提示，不影响其它功能）
  const pathResult = React.useMemo<
    { ok: true; matches: JsonPathMatch[] } | { ok: false; error: string } | null
  >(() => {
    const query = pathQuery.trim();
    if (query.length === 0 || !parsed.ok) {
      return null;
    }
    try {
      const segments = parseJsonPath(query);
      const matches = queryJsonPath(parsed.value, segments, PATH_RESULT_LIMIT);
      return { ok: true, matches };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }, [pathQuery, parsed]);

  const handleCopy = React.useCallback(async (text: string, label: string): Promise<void> => {
    const ok = await writeClipboard(text);
    if (ok) {
      toast.success(label);
    } else {
      toast.error('复制失败，请手动选择文本复制');
    }
  }, []);

  const copyValue = React.useCallback(
    (text: string, label: string) => {
      void handleCopy(text, label);
    },
    [handleCopy],
  );

  const outputTitle =
    mode === 'pretty'
      ? '格式化结果'
      : mode === 'min'
        ? '压缩结果'
        : mode === 'csv'
          ? 'CSV'
          : mode === 'yaml'
            ? 'YAML'
            : 'TypeScript 类型';

  return (
    <CommandShell
      title="JSON 格式化"
      onPaste={(t) => setInput(t)}
      description="格式化 / 压缩 / 树视图 / CSV / YAML / TypeScript，支持 JSONPath 查询"
      icon={<Braces className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      fill
      copyText={mode === 'tree' ? '' : output}
      shortcutHint="粘贴 JSON 后自动处理；支持 JSONPath 如 $.store.book[0].title（Esc 返回）"
      samples={[
        {
          label: '嵌套对象',
          description: '结构完整的示例：对象 / 数组 / 布尔 / null 都有，可切树视图看折叠',
          apply: () => {
            setMode('pretty');
            setIndent('2');
            setPathQuery('');
            setInput(SAMPLE_JSON);
          },
        },
        {
          label: 'JSONPath 查询',
          description: '$.store.book[0].title —— 只看命中的那一小段',
          apply: () => {
            setMode('pretty');
            setInput(SAMPLE_JSON);
            setPathQuery('$.store.book[0].title');
          },
        },
        {
          label: '压缩成一行',
          description: '去掉所有空白，便于塞进配置或命令行参数',
          apply: () => {
            setMode('min');
            setPathQuery('');
            setInput(SAMPLE_JSON);
          },
        },
        {
          label: '转 TypeScript',
          description: '按数据推断结构生成 interface，字段名与类型都自动来',
          apply: () => {
            setMode('ts');
            setPathQuery('');
            setInput(SAMPLE_JSON);
          },
        },
        {
          label: 'book 转 CSV',
          description: '数组转 CSV 最直观：配合 JSONPath 只取 books 这一层',
          apply: () => {
            setMode('csv');
            setInput(SAMPLE_JSON);
            setPathQuery('$.store.book');
          },
        },
        {
          label: '故意写错',
          description: '少一个逗号 —— 看错误提示定位到第几行第几列',
          apply: () => {
            setMode('pretty');
            setPathQuery('');
            setInput('{\n  "a": 1\n  "b": 2\n}');
          },
        },
      ]}
    >
      {/* 撑满模式：两列并排（<1024px 回退单列），输入与结果区随窗口高度伸缩 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ——— 左列：输入 ——— */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-medium text-foreground" htmlFor="json-input">
              输入 JSON
            </label>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => setInput('')}
              >
                清空
              </Button>
            </div>
          </div>
          <textarea
            id="json-input"
            autoFocus
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder='{"name":"Toolbox","tags":["desktop","efficiency"]}'
            spellCheck={false}
            className={
              'min-h-[200px] w-full flex-1 resize-none rounded-lg border border-input bg-background p-3 font-mono text-xs ' +
              'text-foreground placeholder:text-muted-foreground ' +
              'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
            }
          />
          {!parsed.ok && parsed.error !== null ? (
            <div
              role="alert"
              className={
                'scrollbar-thin max-h-[120px] overflow-auto whitespace-pre-wrap rounded-lg border border-destructive/40 ' +
                'bg-destructive/5 p-2.5 font-mono text-xs text-destructive'
              }
            >
              {`语法错误：${parsed.error}`}
            </div>
          ) : null}
        </div>

        {/* ——— 右列：模式 / 查询 / 统计 / 输出 ——— */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {MODES.map((item) => (
              <TabButton
                key={item.value}
                active={mode === item.value}
                onClick={() => setMode(item.value)}
              >
                {item.label}
              </TabButton>
            ))}
            {mode === 'pretty' ? (
              <div className="ml-auto flex items-center gap-1">
                {(['2', '4'] as const).map((option) => (
                  <TabButton
                    key={option}
                    active={indent === option}
                    onClick={() => setIndent(option)}
                  >
                    {option} 空格
                  </TabButton>
                ))}
              </div>
            ) : null}
          </div>

          {/* JSONPath 查询 */}
          <div className="flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={pathQuery}
                onChange={(event) => setPathQuery(event.target.value)}
                placeholder="JSONPath 查询，如 $.store.book[0].title / $..name / $.a[*].b"
                aria-label="JSONPath 查询"
                className="h-8 pl-8 font-mono text-xs"
              />
            </div>
            {pathQuery.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-xs"
                onClick={() => setPathQuery('')}
              >
                清除
              </Button>
            ) : null}
          </div>
          {pathResult === null ? null : pathResult.ok ? (
            pathResult.matches.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                无匹配结果
              </div>
            ) : (
              <div className="scrollbar-thin max-h-[160px] overflow-auto rounded-md border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
                  <span>命中 {pathResult.matches.length} 条</span>
                  <CopyButton
                    text={pathResult.matches
                      .map((match) => `${match.path} = ${formatMatchValue(match.value, 400)}`)
                      .join('\n')}
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs"
                    label="复制全部"
                  />
                </div>
                <ul className="divide-y divide-border">
                  {pathResult.matches.map((match, index) => (
                    <li
                      key={`${match.path}-${index}`}
                      className="flex items-start gap-2 px-2 py-1 font-mono text-[11px]"
                    >
                      <span className="shrink-0 text-sky-700">{match.path}</span>
                      <span className="min-w-0 flex-1 break-all text-foreground">
                        {formatMatchValue(match.value)}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyValue(nodeCopyText(match.value), '值已复制')}
                        className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        复制
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              JSONPath 无效：{pathResult.error}
            </div>
          )}

          {/* 统计面板 */}
          {stats !== null ? (
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
              <StatCell label="字符数" value={stats.chars.toLocaleString()} />
              <StatCell label="行数" value={stats.lines.toLocaleString()} />
              <StatCell label="对象数" value={stats.objects.toLocaleString()} />
              <StatCell label="数组数" value={stats.arrays.toLocaleString()} />
              <StatCell label="键总数" value={stats.keys.toLocaleString()} />
              <StatCell label="最大深度" value={String(stats.depth)} />
            </div>
          ) : null}

          {busy ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              内容较大（{Math.round(input.length / 1024)} KB），格式化可能需要一点时间…
            </div>
          ) : null}

          {/* 输出区 */}
          {mode === 'tree' ? (
            <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-4 py-2">
                <span className="text-sm font-medium text-foreground">树视图</span>
                <span className="text-[11px] text-muted-foreground">
                  点击箭头折叠 / 展开，hover 显示复制按钮
                </span>
              </div>
              <div className="scrollbar-thin min-h-[200px] flex-1 overflow-auto p-3 font-mono text-xs">
                {parsed.ok ? (
                  <JsonTree value={parsed.value} onCopy={copyValue} />
                ) : (
                  <p className="text-sm text-muted-foreground">输入合法 JSON 后显示树视图</p>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="flex min-h-0 flex-1">
                <ResultBox
                  title={outputTitle}
                  value={output}
                  emptyHint={
                    parsed.ok
                      ? warning ?? '无输出'
                      : parsed.error === null
                        ? '输入合法 JSON 后显示结果'
                        : 'JSON 语法有误，请修正后重试'
                  }
                  className="w-full"
                  fill
                />
              </div>
              {warning !== null ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  {warning}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </CommandShell>
  );
}

export default JsonFormatter;
