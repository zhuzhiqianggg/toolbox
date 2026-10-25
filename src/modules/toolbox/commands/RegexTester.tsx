import * as React from 'react';
import {
  BookOpen,
  Check,
  ChevronRight,
  FlaskConical,
  Regex,
  Replace,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { Input } from '@/components/ui/input';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import {
  DEFAULT_SAMPLE_TEXT,
  REGEX_GROUPS,
  REGEX_LIBRARY,
  SAMPLE_TEXTS,
  explainPattern,
  sampleHitCount,
  type RegexExample,
} from '@/lib/regexLibrary';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'regex-tester';
// tool-audit-ignore: samples —— 正则库（整行可点展开）已是更强的示例入口

/** 可勾选的 flags */
const FLAG_OPTIONS: ReadonlyArray<{ flag: string; label: string; hint: string }> = [
  { flag: 'g', label: '全局 g', hint: '找出所有匹配，而不是只找第一个' },
  { flag: 'i', label: '忽略大小写 i', hint: '不区分大小写' },
  { flag: 'm', label: '多行 m', hint: '^ $ 匹配每行的开头和结尾（处理日志必开）' },
  { flag: 's', label: '点匹配换行 s', hint: '. 可以匹配换行符' },
  { flag: 'u', label: 'Unicode u', hint: '支持 \\p{...} 与码点转义，处理中文建议开' },
  { flag: 'y', label: '粘连 y', hint: '必须从 lastIndex 处紧邻匹配' },
];

/** 一次匹配的结果 */
interface MatchInfo {
  index: number;
  value: string;
  groups: Record<string, string | undefined>;
  /** 编号组（1..n） */
  numbered: Array<string | undefined>;
  /** 该匹配在测试文本中占用的行号（1 起） */
  line: number;
}

type PanelTab = 'matches' | 'replace' | 'explain' | 'cases';

/**
 * 「在配套示例里命中几处」徽标。
 *
 * V25 之前，库里 30 条有 16 条是**零命中**（整串校验配了多行文本），
 * 但界面上没有任何地方为此负责 —— 用户只能怀疑自己写错了正则。
 * 现在每条都把自己的命中数亮出来：`0` 与 `-1` 都是编写缺陷，必须显眼。
 */
function HitBadge({ hits }: { hits: number }): React.JSX.Element {
  if (hits < 0) {
    return (
      <span
        title="这条正则编译不过"
        className="shrink-0 rounded bg-destructive/10 px-1 text-[9px] text-destructive"
      >
        正则无效
      </span>
    );
  }
  if (hits === 0) {
    return (
      <span
        title="配套示例文本与这条正则不匹配（编写缺陷）"
        className="shrink-0 rounded bg-amber-500/10 px-1 text-[9px] text-amber-600"
      >
        示例不匹配
      </span>
    );
  }
  return (
    <span
      title={`在配套示例文本里命中 ${hits} 处`}
      className="shrink-0 rounded bg-emerald-500/10 px-1 text-[9px] text-emerald-600"
    >
      {hits} 处
    </span>
  );
}

/** 带断言用例的条目名称（「用例验证」页签的空态用） */
const CASE_ENTRY_LABELS: string = REGEX_LIBRARY.filter((item) => (item.cases?.length ?? 0) > 0)
  .map((item) => item.label)
  .join(' / ');

interface RegexToolState {
  pattern: string;
  flags: string[];
  test: string;
  replacement: string;
  showLibrary: boolean;
  tab: PanelTab;
  selected: string;
  /** 当前展开的正则库条目（`组/名称`）；同一时刻只展开一条，列表才不会变成一堵墙 */
  expandedKey: string;
  /** 正则库搜索词（名称 / 表达式 / 说明 / 分类 都能命中） */
  libQuery: string;
}

const INITIAL_STATE: RegexToolState = {
  pattern: '1[3-9]\\d{9}|[\\w.%+-]+@[\\w.-]+\\.[A-Za-z]{2,}',
  flags: ['g'],
  test: DEFAULT_SAMPLE_TEXT,
  replacement: '',
  showLibrary: true,
  tab: 'matches',
  selected: '',
  expandedKey: '',
  libQuery: '',
};

/** 计算某个偏移量落在第几行 */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/**
 * 正则表达式测试（V20 重做）。
 *
 * # 用户反馈
 *
 * 「多给一些实例正则，带测试示例文本方便测试的……正文的测试框里面也可以提供一些
 *   测试示例文本我点击可以填充到里面……当然文本不是简单的文本能展示出正则的各种
 *   复杂场景的。」
 *
 * # 这一版的结构
 *
 * - **左库右测**：内置 30 条带说明的真实正则（分 5 类），点一条就填表达式，
 *   需要的话连配套的**多行真实样本**（Nginx 日志 / Java 堆栈 / 慢查询 / K8s YAML）一起填；
 * - **四个页签**：匹配明细（含命名组表）、替换预览、语法解释（逐 token 讲人话）、
 *   用例验证（这条正则该命中什么 / 该不命中什么，一眼看出是否名副其实）；
 * - **状态持久化**：表达式、测试文本、替换串、页签位置都记住，最小化 / 重开不丢。
 */
export function RegexTester({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<RegexToolState>(COMMAND_ID, {
    ...INITIAL_STATE,
    test: initialInput || INITIAL_STATE.test,
  });

  const flagsString = React.useMemo(() => state.flags.join(''), [state.flags]);

  const toggleFlag = (flag: string): void => {
    patch({
      flags: state.flags.includes(flag)
        ? state.flags.filter((item) => item !== flag)
        : [...state.flags, flag],
    });
  };

  /** 编译当前表达式（含错误） */
  const compiled = React.useMemo<{ regex: RegExp | null; error: string | null }>(() => {
    if (state.pattern.length === 0) {
      return { regex: null, error: null };
    }
    try {
      // 高亮与遍历都需要 g，缺失时内部补上
      const flags = flagsString.includes('g') ? flagsString : `${flagsString}g`;
      return { regex: new RegExp(state.pattern, flags), error: null };
    } catch (cause) {
      return {
        regex: null,
        error: cause instanceof Error ? cause.message : '正则表达式无效',
      };
    }
  }, [state.pattern, flagsString]);

  /** 执行匹配 */
  const analysis = React.useMemo<{
    matches: MatchInfo[];
    nodes: React.ReactNode[] | null;
    truncated: boolean;
  }>(() => {
    const regex = compiled.regex;
    if (regex === null || state.test.length === 0) {
      return { matches: [], nodes: null, truncated: false };
    }
    const found: MatchInfo[] = [];
    let match: RegExpExecArray | null;
    let guard = 0;
    const MAX = 5000;
    regex.lastIndex = 0;
    while ((match = regex.exec(state.test)) !== null) {
      const numbered: Array<string | undefined> = [];
      for (let g = 1; g < match.length; g += 1) {
        numbered.push(match[g]);
      }
      found.push({
        index: match.index,
        value: match[0],
        groups: match.groups ?? {},
        numbered,
        line: lineOf(state.test, match.index),
      });
      if (match.index === regex.lastIndex) {
        regex.lastIndex += 1; // 空匹配防死循环
      }
      guard += 1;
      if (guard >= MAX) {
        break;
      }
    }

    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    found.forEach((info, i) => {
      if (info.index > cursor) {
        nodes.push(<React.Fragment key={`t${i}`}>{state.test.slice(cursor, info.index)}</React.Fragment>);
      }
      nodes.push(
        <mark
          key={`m${i}`}
          title={`第 ${i + 1} 处 · 行 ${info.line} · 偏移 ${info.index}`}
          className={cn(
            'rounded px-0.5 text-foreground',
            i % 2 === 0 ? 'bg-emerald-200/70' : 'bg-sky-200/70',
          )}
        >
          {info.value || '∅'}
        </mark>,
      );
      cursor = info.index + info.value.length;
    });
    if (cursor < state.test.length) {
      nodes.push(<React.Fragment key="tail">{state.test.slice(cursor)}</React.Fragment>);
    }
    return { matches: found, nodes: nodes.length > 0 ? nodes : null, truncated: found.length >= MAX };
  }, [compiled.regex, state.test]);

  /** 替换预览 */
  const replaced = React.useMemo<string>(() => {
    if (compiled.regex === null || state.replacement.length === 0) {
      return '';
    }
    try {
      return state.test.replace(compiled.regex, state.replacement);
    } catch (cause) {
      return `替换失败：${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }, [compiled.regex, state.test, state.replacement]);

  /** 语法解释 */
  const tokens = React.useMemo(() => explainPattern(state.pattern), [state.pattern]);

  /** 当前选中的库条目（用例验证用） */
  const selectedEntry: RegexExample | null = React.useMemo(
    () => REGEX_LIBRARY.find((item) => `${item.group}/${item.label}` === state.selected) ?? null,
    [state.selected],
  );

  /** 正则库筛选：分类 / 名称 / 表达式 / 说明 任一命中即保留 */
  const libraryFiltered = React.useMemo<readonly RegexExample[]>(() => {
    const query = state.libQuery.trim().toLowerCase();
    if (query === '') {
      return REGEX_LIBRARY;
    }
    return REGEX_LIBRARY.filter((item) =>
      `${item.group} ${item.label} ${item.pattern} ${item.description}`.toLowerCase().includes(query),
    );
  }, [state.libQuery]);

  const useExample = (item: RegexExample, withText: boolean): void => {
    patch({
      pattern: item.pattern,
      flags: item.flags.length > 0 ? item.flags.split('') : [],
      selected: `${item.group}/${item.label}`,
      ...(withText ? { test: item.text ?? DEFAULT_SAMPLE_TEXT } : {}),
      tab: 'matches',
    });
  };

  /**
   * 每条在**自身示例文本**里的命中数。
   *
   * 计算量很小（30 条短正则），且有模块级缓存；换来的是「哪条示例是坏的」
   * 一眼可见，而不是让人怀疑自己。`scripts/regression/test-regex-library.mjs`
   * 会保证这里永远不该出现 0。
   */
  const hitCounts = React.useMemo<Map<string, number>>(
    () =>
      new Map(
        libraryFiltered.map((item) => [
          `${item.group}/${item.label}`,
          sampleHitCount(item),
        ]),
      ),
    [libraryFiltered],
  );

  const matchSummary = React.useMemo(
    () =>
      analysis.matches
        .map((item, i) => {
          const groups = Object.entries(item.groups)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `  ${key} = ${value}`)
            .join('\n');
          return `#${i + 1} 行${item.line} @${item.index}: ${item.value}${groups ? `\n${groups}` : ''}`;
        })
        .join('\n'),
    [analysis.matches],
  );

  return (
    <CommandShell
      title="正则表达式测试"
      onPaste={(t) => patch({ test: t })}
      description="30 条实战正则 + 配套示例（逐条自检命中数）+ 多行真实样本 + 替换预览 + 语法解释"
      icon={<Regex className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={matchSummary}
      shortcutHint="点正则库整行展开详情，双击直接连示例文本一起填；也可以在上方搜索框按用途找"
    >
      <div className="flex flex-col gap-4">
        {/* ——— 表达式 + flags ——— */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="re-pattern">
            正则表达式
          </label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">/</span>
            <Input
              id="re-pattern"
              autoFocus
              className="font-mono"
              value={state.pattern}
              spellCheck={false}
              placeholder="(?&lt;ip&gt;\d{1,3}(?:\.\d{1,3}){3})"
              onChange={(event) => patch({ pattern: event.target.value, selected: '' })}
            />
            <span className="shrink-0 font-mono text-sm text-muted-foreground">/{flagsString}</span>
          </div>
          {compiled.error !== null ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {`正则无效：${compiled.error}`}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {FLAG_OPTIONS.map((option) => (
              <label
                key={option.flag}
                title={option.hint}
                className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground"
              >
                <input
                  type="checkbox"
                  checked={state.flags.includes(option.flag)}
                  onChange={() => toggleFlag(option.flag)}
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>

        {/* ——— 正则库：整行可点展开（V21） ———
            用户反馈：「建议整个行都可以点击展开，而不是跑到后面找一个小小的展开按钮」。
            于是这里改成手风琴：**整行就是按钮**，点哪儿都能展开/收起；填入按钮收进
            展开后的面板里（大目标、语义清楚），30 条正则的列表也因此清爽多了。
            额外加了搜索框（30 条靠肉眼扫太费劲）与双击直达（双击整行 = 连示例文本一起填）。 */}
        <div className="rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">正则库</span>
            <span className="text-[11px] text-muted-foreground">
              {REGEX_LIBRARY.length} 条 · 每条标了在配套示例里的命中数 · 点整行展开，双击直接连示例文本一起填
            </span>
            <div className="relative ml-auto">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <input
                value={state.libQuery}
                spellCheck={false}
                onChange={(event) => patch({ libQuery: event.target.value })}
                placeholder="搜名称 / 表达式 / 用途…"
                className="h-6 w-44 rounded-md border border-input bg-transparent pl-6 pr-2 text-[11px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label="搜索正则库"
              />
              {state.libQuery !== '' ? (
                <button
                  type="button"
                  onClick={() => patch({ libQuery: '' })}
                  title="清空搜索"
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => patch({ showLibrary: !state.showLibrary })}
              className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              {state.showLibrary ? '收起' : '展开'}
            </button>
          </div>
          {state.showLibrary ? (
            <div className="scrollbar-thin max-h-[340px] overflow-y-auto p-3">
              {libraryFiltered.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  没有匹配「{state.libQuery}」的条目
                </p>
              ) : null}
              {REGEX_GROUPS.map((group) => {
                const list = libraryFiltered.filter((item) => item.group === group);
                if (list.length === 0) {
                  return null;
                }
                return (
                  <div key={group} className="mb-3 last:mb-0">
                    <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                      {group}
                      <span className="ml-1 text-muted-foreground/60">{list.length}</span>
                    </p>
                    <div className="flex flex-col gap-1">
                      {list.map((item) => {
                        const key = `${item.group}/${item.label}`;
                        const active = state.selected === key;
                        const expanded = state.expandedKey === key;
                        return (
                          <div
                            key={key}
                            className={cn(
                              'overflow-hidden rounded-lg border transition',
                              active
                                ? 'border-brand/50 bg-brand-muted/40'
                                : 'border-border hover:border-brand/30',
                            )}
                          >
                            {/* 整行可点：展开 / 收起详情 */}
                            <button
                              type="button"
                              onClick={() => patch({ expandedKey: expanded ? '' : key })}
                              onDoubleClick={() => useExample(item, true)}
                              aria-expanded={expanded}
                              title="点一下展开详情与「填入」按钮；双击直接连示例文本一起填"
                              className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition hover:bg-accent/40"
                            >
                              <ChevronRight
                                className={cn(
                                  'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                                  expanded && 'rotate-90',
                                )}
                              />
                              <span className="shrink-0 text-xs font-medium text-foreground">
                                {item.label}
                              </span>
                              <HitBadge hits={hitCounts.get(key) ?? 0} />
                              <code
                                className="min-w-0 flex-1 truncate text-left font-mono text-[10px] text-muted-foreground"
                                title={item.pattern}
                              >
                                {item.pattern}
                              </code>
                              {active ? (
                                <span className="shrink-0 rounded bg-brand/15 px-1.5 text-[9px] text-brand">
                                  当前
                                </span>
                              ) : null}
                            </button>

                            {expanded ? (
                              <div className="border-t border-border/70 bg-background/40 px-2.5 py-2">
                                <p className="text-[11px] leading-relaxed text-muted-foreground">
                                  {item.description}
                                </p>
                                {item.cases !== undefined && item.cases.length > 0 ? (
                                  <p className="mt-1 text-[10px] text-muted-foreground/70">
                                    带 {item.cases.length} 条断言用例，填入后可在「用例验证」页签自证
                                  </p>
                                ) : null}
                                <pre className="scrollbar-thin mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 font-mono text-[10px] text-foreground">
                                  {item.pattern}
                                </pre>
                                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => useExample(item, true)}
                                    className="inline-flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 text-[11px] text-white transition hover:opacity-90"
                                  >
                                    <Sparkles className="h-3 w-3" />
                                    连示例文本一起填
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => useExample(item, false)}
                                    className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
                                  >
                                    只填正则
                                  </button>
                                  <span className="ml-auto text-[10px] text-muted-foreground/70">
                                    flags：{item.flags || '无'}
                                  </span>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* ——— 测试文本 + 高亮 ——— */}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <label className="text-sm font-medium text-foreground" htmlFor="re-test">
                测试文本
              </label>
              <span className="text-[11px] text-muted-foreground">示例：</span>
              {SAMPLE_TEXTS.map((sample) => (
                <button
                  key={sample.label}
                  type="button"
                  title={`${sample.note}\n\n${sample.text.slice(0, 160)}…`}
                  onClick={() => patch({ test: sample.text })}
                  className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:border-brand/40 hover:bg-brand-muted/40 hover:text-brand"
                >
                  {sample.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => patch({ test: '' })}
                className="rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:text-destructive"
              >
                清空
              </button>
            </div>
            <textarea
              id="re-test"
              rows={12}
              spellCheck={false}
              className="scrollbar-thin w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={state.test}
              placeholder={`贴一段真实文本，或点上方示例（${SAMPLE_TEXTS.length} 种场景：日志 / 堆栈 / YAML / 脏数据……）`}
              onChange={(event) => patch({ test: event.target.value })}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                匹配高亮（{analysis.matches.length} 处）
              </span>
              {analysis.truncated ? (
                <span className="text-[11px] text-amber-600">已截断至 5000 处</span>
              ) : null}
              {analysis.matches.length > 0 ? (
                <CopyButton text={matchSummary} variant="ghost" size="sm" className="ml-auto h-6 px-2 text-[11px]" />
              ) : null}
            </div>
            <pre className="scrollbar-thin max-h-[320px] min-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-input bg-transparent p-3 font-mono text-xs leading-relaxed">
              {analysis.nodes ?? (
                <span className="text-muted-foreground">
                  填好表达式与测试文本后，命中处会在这里高亮（相邻命中交替配色，方便数个数）
                </span>
              )}
            </pre>
          </div>
        </div>

        {/* ——— 结果页签 ——— */}
        <div className="rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
            {(
              [
                { value: 'matches', label: `匹配明细（${analysis.matches.length}）`, icon: Check },
                { value: 'replace', label: '替换预览', icon: Replace },
                { value: 'explain', label: '语法解释', icon: BookOpen },
                { value: 'cases', label: '用例验证', icon: FlaskConical },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => patch({ tab: item.value })}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition',
                    state.tab === item.value
                      ? 'bg-brand-muted font-medium text-brand'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="scrollbar-thin max-h-[340px] overflow-auto p-3">
            {/* —— 匹配明细 —— */}
            {state.tab === 'matches' ? (
              analysis.matches.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-6 text-center">
                  <p className="text-xs text-muted-foreground">
                    {state.pattern.trim() === '' ? '还没有填写表达式' : '暂无匹配'}
                  </p>
                  {state.pattern.trim() === '' ? null : (
                    <p className="max-w-xl text-[11px] leading-relaxed text-muted-foreground">
                      匹配不上往往不是正则写错，而是
                      <span className="font-medium text-foreground">示例不合适</span>
                      ：整串校验类正则（开头 ^ 结尾 $）需要「每行一个值」的清单，
                      而日志类正则需要在日志里捞片段。
                      上方正则库每条都标了它在配套示例里的命中数，点
                      <span className="mx-0.5 font-medium text-foreground">
                        「连示例文本一起填」
                      </span>
                      就能拿到配好该正则的示例。
                    </p>
                  )}
                  {selectedEntry !== null ? (
                    <button
                      type="button"
                      onClick={() => useExample(selectedEntry, true)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand/90"
                    >
                      <Sparkles className="h-3 w-3" />
                      连「{selectedEntry.label}」的示例文本一起填
                    </button>
                  ) : (
                    <span className="text-[11px] text-muted-foreground/70">
                      也可以点上方「测试文本」旁的场景按钮换一段样本
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {analysis.matches.slice(0, 200).map((item, i) => {
                    const named = Object.entries(item.groups).filter(([, value]) => value !== undefined);
                    return (
                      <div key={`${item.index}-${i}`} className="rounded-lg border border-border px-2.5 py-1.5">
                        <div className="flex flex-wrap items-baseline gap-2 text-xs">
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            #{i + 1}
                          </span>
                          <span className="text-[11px] text-muted-foreground">行 {item.line}</span>
                          <code className="break-all font-mono text-foreground">{item.value || '∅（空匹配）'}</code>
                        </div>
                        {named.length > 0 || item.numbered.length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-2">
                            {item.numbered.map((value, gi) =>
                              value === undefined ? null : (
                                <span key={`n${gi}`} className="text-[11px] text-muted-foreground">
                                  ${gi + 1} = <code className="text-foreground">{value}</code>
                                </span>
                              ),
                            )}
                            {named.map(([key, value]) => (
                              <span key={key} className="text-[11px] text-muted-foreground">
                                {key} = <code className="text-foreground">{value}</code>
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {analysis.matches.length > 200 ? (
                    <p className="py-2 text-center text-[11px] text-muted-foreground">
                      仅展示前 200 条（共 {analysis.matches.length} 条）
                    </p>
                  ) : null}
                </div>
              )
            ) : null}

            {/* —— 替换预览 —— */}
            {state.tab === 'replace' ? (
              <div className="flex flex-col gap-2">
                <label className="text-xs text-muted-foreground" htmlFor="re-replace">
                  替换为（支持 <code className="mx-1">$1</code>
                  <code className="mx-1">$&lt;name&gt;</code>
                  <code className="mx-1">$&amp;</code> 引用）
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="re-replace"
                    className="font-mono"
                    value={state.replacement}
                    spellCheck={false}
                    placeholder="例如 $1_$2 或 已脱敏"
                    onChange={(event) => patch({ replacement: event.target.value })}
                  />
                  {replaced.length > 0 ? (
                    <CopyButton text={replaced} variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" />
                  ) : null}
                </div>
                {replaced.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    填一个替换串即可看到结果（例：把驼峰 `([a-z0-9])([A-Z])` 换成 `$1_$2`）
                  </p>
                ) : (
                  <pre className="scrollbar-thin max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-input bg-transparent p-3 font-mono text-xs">
                    {replaced}
                  </pre>
                )}
              </div>
            ) : null}

            {/* —— 语法解释 —— */}
            {state.tab === 'explain' ? (
              state.pattern.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">先写一条正则</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {tokens.map((token, i) => (
                    <div key={`${token.raw}-${i}`} className="flex items-baseline gap-3 rounded-md px-2 py-1 hover:bg-accent/40">
                      <code
                        className={cn(
                          'w-24 shrink-0 truncate rounded px-1.5 py-0.5 font-mono text-[11px]',
                          token.literal ? 'bg-muted text-muted-foreground' : 'bg-sky-100 text-sky-800',
                        )}
                        title={token.raw}
                      >
                        {token.raw}
                      </code>
                      <span
                        className={cn(
                          'text-xs',
                          token.literal ? 'text-muted-foreground' : 'text-foreground',
                        )}
                      >
                        {token.text}
                      </span>
                    </div>
                  ))}
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    提示：量词默认「贪婪」（尽量多吃字符），在后面加 <code className="mx-0.5">?</code>
                    变成非贪婪（`.*?` 是抓「到最近的分隔符为止」的常用写法）。
                  </p>
                </div>
              )
            ) : null}

            {/* —— 用例验证 —— */}
            {state.tab === 'cases' ? (
              selectedEntry === null || selectedEntry.cases === undefined ? (
                <p className="max-w-2xl py-6 text-center text-xs leading-relaxed text-muted-foreground">
                  带断言用例的条目：
                  <span className="ml-1 text-foreground">{CASE_ENTRY_LABELS}</span>。
                  从上方正则库点开任意一条并点「连示例文本一起填」，这里会逐条验证它
                  「该命中的命中、该拒绝的拒绝」—— 这是判断一条正则是否名副其实最直接的方式。
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <p className="mb-1 text-[11px] text-muted-foreground">
                    针对当前表达式（<code className="mx-1 font-mono">{state.pattern}</code>）逐条验证：
                  </p>
                  {selectedEntry.cases.map((item) => {
                    let actual = false;
                    try {
                      const flags = flagsString.includes('g') ? flagsString : `${flagsString}g`;
                      const probe = new RegExp(state.pattern, flags);
                      actual = probe.test(item.input);
                    } catch {
                      actual = false;
                    }
                    const pass = actual === item.expect;
                    return (
                      <div
                        key={item.input}
                        className={cn(
                          'flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs',
                          pass ? 'border-border' : 'border-destructive/40 bg-destructive/5',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-white',
                            pass ? 'bg-emerald-500' : 'bg-destructive',
                          )}
                        >
                          {pass ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                        </span>
                        <code className="break-all font-mono text-foreground">{item.input}</code>
                        <span className="text-[11px] text-muted-foreground">
                          期望{ item.expect ? '命中' : '不命中' }，实际{ actual ? '命中' : '不命中' }
                        </span>
                        <span className="ml-auto text-[11px] text-muted-foreground">{item.note}</span>
                      </div>
                    );
                  })}
                </div>
              )
            ) : null}
          </div>
        </div>
      </div>
    </CommandShell>
  );
}

export default RegexTester;
