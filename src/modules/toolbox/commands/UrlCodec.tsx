import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { ArrowLeftRight, Link2, Trash2 } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolHistory, type ToolHistoryEntry } from '@/hooks/useToolHistory';
import type { CommandProps } from '@/core/types';
import { cn } from '@/lib/utils';
import {
  URL_EXAMPLES,
  URL_METHODS,
  URL_REFERENCE_ROWS,
  buildUrl,
  computeUrlStats,
  decodeWithMethod,
  emptyParts,
  encodeWithMethod,
  formatQueryPairs,
  parseQueryPairs,
  parseUrlParts,
  type QueryPair,
  type UrlMethod,
  type UrlParts,
} from '@/modules/toolbox/lib/urlUtils';

const COMMAND_ID = 'url-codec';

/** 操作方向。 */
type Mode = 'encode' | 'decode';

/** 历史条目负载（与 ops-tools 的 URL 历史字段对齐）。 */
interface UrlHistoryPayload {
  input: string;
  output: string;
  type: Mode;
  method: UrlMethod;
  timestamp: number;
}

/** 截断长文本作为历史摘要。 */
function truncate(value: string, max = 40): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 历史去重签名。 */
function payloadSignature(payload: UrlHistoryPayload): string {
  return `${payload.type}|${payload.method}|${payload.input}|${payload.output}`;
}

/** 结构化解析的单个字段输入框。 */
function PartField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="font-mono text-foreground"
        spellCheck={false}
        autoComplete="off"
      />
    </label>
  );
}

/**
 * URL 编解码（对齐 ops-tools 的 UrlConverter 并保留我们更强的 query 解析）：
 * 三种编码方法、结构化六段编辑与重建、有效性徽章、输入统计、
 * 4 个示例一键填充、22 行常用字符编码对照表、最近 20 条转换历史。
 */
export function UrlCodec({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const history = useToolHistory<UrlHistoryPayload>({ toolId: COMMAND_ID, limit: 20 });

  const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput);
  const [mode, setMode] = usePersistedState<Mode>(COMMAND_ID, 'mode', 'decode');
  const [method, setMethod] = usePersistedState<UrlMethod>(COMMAND_ID, 'method', 'component');
  /** 结构化字段的编辑草稿（null = 跟随输入解析结果）。 */
  const [draft, setDraft] = React.useState<UrlParts | null>(null);

  /** 输入变化后草稿失效，重新跟随解析结果。 */
  React.useEffect(() => {
    setDraft(null);
  }, [input]);

  /** 转换结果。 */
  const result = React.useMemo<{ text: string; error: string | null }>(() => {
    if (input.trim().length === 0) {
      return { text: '', error: null };
    }
    try {
      return {
        text: mode === 'encode' ? encodeWithMethod(input, method) : decodeWithMethod(input, method),
        error: null,
      };
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { text: '', error: `转换失败：${message}（请检查 % 转义序列是否完整）` };
    }
  }, [input, mode, method]);

  /** 结构化解析。 */
  const parsed = React.useMemo(() => parseUrlParts(input), [input]);
  const parts = draft ?? parsed.parts ?? emptyParts();

  /** 有效性徽章：有效（绿）/ 需要补充协议（黄）/ 无效（红）。 */
  const validity = React.useMemo<{ label: string; className: string }>(() => {
    if (input.trim().length === 0) {
      return { label: '等待输入', className: 'bg-muted text-muted-foreground' };
    }
    if (!parsed.ok) {
      return { label: '无效', className: 'bg-destructive/10 text-destructive' };
    }
    if (parsed.repaired) {
      return { label: '需要补充协议', className: 'bg-amber-500/15 text-amber-700' };
    }
    return { label: '有效', className: 'bg-emerald-500/10 text-emerald-700' };
  }, [input, parsed]);

  /** 输入统计。 */
  const stats = React.useMemo(() => computeUrlStats(input), [input]);

  /** query 参数（decode 模式解析解码后的 URL —— 我们的优势能力）。 */
  const queryPairs = React.useMemo<QueryPair[]>(
    () => (mode === 'decode' ? parseQueryPairs(result.text) : []),
    [mode, result.text],
  );

  // 历史：防抖写入 + 与最新一条去重
  const latestPayloadRef = React.useRef<UrlHistoryPayload | null>(null);
  const [resultSig, setResultSig] = React.useState<string>('');
  React.useEffect(() => {
    if (input.trim().length === 0 || result.text.length === 0) {
      setResultSig('');
      return;
    }
    latestPayloadRef.current = {
      input,
      output: result.text,
      type: mode,
      method,
      timestamp: Date.now(),
    };
    setResultSig(`${mode}|${method}|${input}|${result.text}`);
  }, [input, result.text, mode, method]);

  React.useEffect(() => {
    if (resultSig.length === 0) {
      return;
    }
    const payload = latestPayloadRef.current;
    if (!payload) {
      return;
    }
    const timer = window.setTimeout(() => {
      const latest = history.entries[0];
      if (latest?.payload && payloadSignature(latest.payload) === payloadSignature(payload)) {
        return;
      }
      history.push({
        summary: `${payload.type === 'encode' ? '编码' : '解码'} · ${truncate(payload.input, 28)} → ${truncate(payload.output, 28)}`,
        payload,
      });
    }, 1200);
    return () => {
      window.clearTimeout(timer);
    };
    // history.push 引用稳定，此处只依赖结果签名
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultSig]);

  /** 交换：把结果作为新输入并翻转方向。 */
  const swap = React.useCallback((): void => {
    if (result.text.length === 0) {
      toast.warning('暂无可交换的结果');
      return;
    }
    setInput(result.text);
    setMode((current) => (current === 'encode' ? 'decode' : 'encode'));
  }, [result.text]);

  /** 重新构建 URL：把六个字段拼回完整 URL 并回填输入框。 */
  const rebuild = React.useCallback((): void => {
    const built = buildUrl(parts);
    if (built.trim().length === 0) {
      toast.error('六个字段均为空，无法构建 URL');
      return;
    }
    setInput(built);
    toast.success('已重新构建 URL');
  }, [parts]);

  /** 历史回填。 */
  const applyHistory = React.useCallback((entry: ToolHistoryEntry<UrlHistoryPayload>): void => {
    const payload = entry.payload;
    if (!payload) {
      return;
    }
    setInput(payload.input);
    setMode(payload.type);
    setMethod(payload.method);
    toast.success('已回填历史输入');
  }, []);

  /** 修改单个结构字段。 */
  const updatePart = React.useCallback(
    (key: keyof UrlParts, value: string): void => {
      setDraft((current) => ({ ...(current ?? parsed.parts ?? emptyParts()), [key]: value }));
    },
    [parsed.parts],
  );

  return (
    <CommandShell
      title="URL 编解码"
      onPaste={(t) => setInput(t)}
      description="三种编码方法 + 结构化解析重建 + 查询参数解析 + 编码对照表与历史"
      icon={<Link2 className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={result.text}
      primaryAction={{
        label: mode === 'encode' ? '切换为解码' : '切换为编码',
        onClick: () => setMode((current) => (current === 'encode' ? 'decode' : 'encode')),
      }}
      shortcutHint="粘贴 URL 自动解析 · 结构化字段可编辑后重建（Esc 返回）"
      samples={[
        {
          label: '带参数的 URL',
          description: '自动拆出协议 / 主机 / 路径 / 参数，每段都能改了再重建',
          apply: () => {
            setMode('decode');
            setMethod('component');
            setInput('https://example.com/search?q=%E9%A1%BA%E6%89%8B&page=2#top');
          },
        },
        {
          label: '中文查询转义',
          description: '把带空格的中文参数编码成 %XX，可直接贴进浏览器',
          apply: () => {
            setMode('encode');
            setMethod('component');
            setInput('https://example.com/search?q=顺手 效率工具');
          },
        },
        {
          label: '整条 URL 编码',
          description: '标准编码：连 : / ? 一起转义，整串适合当参数值',
          apply: () => {
            setMode('encode');
            setMethod('uri');
            setInput('https://example.com/a b?c=1&d=2');
          },
        },
        {
          label: '表单风格（+ 号）',
          description: 'application/x-www-form-urlencoded：空格编码成 +',
          apply: () => {
            setMode('encode');
            setMethod('form');
            setInput('name=顺手 效率工具&city=成都');
          },
        },
        {
          label: '解码散落转义串',
          description: '从日志 / 报错里复制出来的一串 %XX → 中文',
          apply: () => {
            setMode('decode');
            setMethod('component');
            setInput('%E9%A1%BA%E6%89%8B%20Toolbox');
          },
        },
      ]}
    >
      {/* 1180×820 基准：两列并排（左输入 / 右结果），窄屏（<1024px）自动回退单列。
          断点用 lg(1024) 而非 xl(1280)：工具页预设宽度就是 1180，用 xl 会在默认尺寸下退化成单列。 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ===== 左列：输入 ===== */}
        <div className="flex min-w-0 flex-col gap-3">
          {/* 操作方向 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant={mode === 'encode' ? 'default' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setMode('encode')}
            >
              编码
            </Button>
            <Button
              size="sm"
              variant={mode === 'decode' ? 'default' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => setMode('decode')}
            >
              解码
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={swap}>
              <ArrowLeftRight className="mr-1 h-3 w-3" />
              交换
            </Button>
            <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', validity.className)}>
              {validity.label}
            </span>
          </div>

          {/* 编码方法 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">编码方法</span>
            <div className="flex flex-wrap gap-1.5">
              {URL_METHODS.map((item) => (
                <Button
                  key={item.id}
                  size="sm"
                  variant={method === item.id ? 'default' : 'ghost'}
                  className="h-7 px-2.5 text-xs"
                  title={item.hint}
                  onClick={() => setMethod(item.id)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {URL_METHODS.find((item) => item.id === method)?.hint ?? ''}
            </p>
          </div>

          {/* 输入区 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground" htmlFor="url-input">
                {mode === 'encode' ? '原文' : 'URL / 转义串'}
              </label>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => setInput('')}
              >
                清空
              </Button>
            </div>
            <textarea
              id="url-input"
              autoFocus
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                mode === 'encode' ? '输入要转义的文本' : 'https://example.com/?a=1&b=中文'
              }
              className={
                'min-h-[180px] w-full flex-1 resize-y rounded-lg border border-input bg-background p-3 font-mono text-sm ' +
                'text-foreground placeholder:text-muted-foreground ' +
                'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
              }
            />
          </div>

          {/* 统计 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: '字符数', value: String(stats.chars) },
              { label: 'UTF-8 字节', value: String(stats.bytes) },
              { label: '含中文', value: stats.hasCjk ? '是' : '否' },
              { label: '含特殊字符', value: stats.hasSpecial ? '是' : '否' },
            ].map((item) => (
              <div key={item.label} className="rounded-md bg-muted px-2 py-1.5">
                <div className="text-[11px] text-muted-foreground">{item.label}</div>
                <div className="mt-0.5 font-mono text-xs font-semibold text-foreground">
                  {item.value}
                </div>
              </div>
            ))}
          </div>

          {/* 示例 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">示例（点击填充）</span>
            <div className="flex flex-wrap gap-1.5">
              {URL_EXAMPLES.map((item) => (
                <Button
                  key={item.label}
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => {
                    setInput(item.value);
                    setMode('decode');
                  }}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>
        </div>

        {/* ===== 右列：结果 ===== */}
        <div className="flex min-w-0 flex-col gap-3">
          <ResultBox
            title="转换结果"
            value={result.text}
            emptyHint="输入内容后自动转换"
            fill
          />
          {result.error ? (
            <Input readOnly value={result.error} className="border-destructive/40 text-destructive" />
          ) : null}
          {queryPairs.length > 0 ? (
            <ResultBox
              title={`查询参数（${queryPairs.length}）`}
              value={formatQueryPairs(queryPairs)}
              mono={false}
            />
          ) : null}
        </div>

        {/* ===== 结构化解析（通栏） ===== */}
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">URL 结构化解析</span>
            <span className="text-xs text-muted-foreground">
              {parsed.repaired ? '已自动补充 http:// 后解析' : parsed.ok ? '解析成功' : '尚无可解析内容'}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <PartField
              label="协议 protocol"
              value={parts.protocol}
              placeholder="https:"
              onChange={(value) => updatePart('protocol', value)}
            />
            <PartField
              label="主机 hostname"
              value={parts.hostname}
              placeholder="example.com"
              onChange={(value) => updatePart('hostname', value)}
            />
            <PartField
              label="端口 port"
              value={parts.port}
              placeholder="8080"
              onChange={(value) => updatePart('port', value)}
            />
            <PartField
              label="路径 pathname"
              value={parts.pathname}
              placeholder="/docs/index.html"
              onChange={(value) => updatePart('pathname', value)}
            />
            <PartField
              label="查询串 search"
              value={parts.search}
              placeholder="?a=1&b=2"
              onChange={(value) => updatePart('search', value)}
            />
            <PartField
              label="片段 hash"
              value={parts.hash}
              placeholder="#section-1"
              onChange={(value) => updatePart('hash', value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={rebuild}>
              重新构建 URL
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft(null)}
              disabled={draft === null}
            >
              还原为解析结果
            </Button>
            <span className="text-[11px] text-muted-foreground">
              改完任意字段后点「重新构建 URL」，生成的完整 URL 会回填到左侧输入框
            </span>
          </div>
        </div>

        {/* ===== 编码对照表（通栏） ===== */}
        <div className="flex min-w-0 flex-col gap-2 lg:col-span-2">
          <span className="text-sm font-medium text-foreground">
            常用字符编码对照表
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {URL_REFERENCE_ROWS.length} 项
            </span>
          </span>
          <div className="scrollbar-thin max-h-[260px] overflow-auto rounded-xl border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-muted text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5">字符</th>
                  <th className="px-3 py-1.5">URL 编码</th>
                  <th className="px-3 py-1.5">表单编码</th>
                  <th className="px-3 py-1.5">说明</th>
                </tr>
              </thead>
              <tbody>
                {URL_REFERENCE_ROWS.map((row) => (
                  <tr key={row.char} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono">
                      {row.char === ' ' ? '␠（空格）' : row.char}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-brand">{row.component}</td>
                    <td className="px-3 py-1.5 font-mono">{row.form}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ===== 历史（通栏） ===== */}
        <div className="flex min-w-0 flex-col gap-2 lg:col-span-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">
              转换历史
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                最近 {history.entries.length} / 20 条
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-destructive"
              onClick={() => {
                history.clear();
                toast.success('历史记录已清空');
              }}
              disabled={history.entries.length === 0}
            >
              清空
            </Button>
          </div>
          {history.entries.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              暂无历史记录；完成一次编码或解码后会自动记录
            </div>
          ) : (
            <div className="scrollbar-thin grid max-h-[200px] grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
              {history.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => applyHistory(entry)}
                    title="点击回填"
                  >
                    <div className="truncate text-xs font-medium text-foreground">{entry.summary}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {new Date(entry.payload?.timestamp ?? entry.createdAt).toLocaleString('zh-CN', {
                        hour12: false,
                      })}
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    aria-label="删除该记录"
                    onClick={() => history.remove(entry.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </CommandShell>
  );
}

export default UrlCodec;
