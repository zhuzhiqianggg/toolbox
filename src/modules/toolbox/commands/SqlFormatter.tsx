import * as React from 'react';
import {
  BookOpen,
  CircleAlert,
  Database,
  Eraser,
  Info,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { CodeBlock } from '@/components/CodeBlock';
import { CopyButton } from '@/components/CopyButton';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import { cn } from '@/lib/utils';
import {
  formatSql,
  lintSql,
  syntaxPointsOf,
  type SqlIssue,
  type SqlIssueLevel,
  type SqlSyntaxPoint,
} from '@/lib/sql';
import { SQL_SAMPLE_GROUPS, SQL_SAMPLES_FLAT, type SqlSample, type SqlSampleGroup } from './sqlSamples';
// tool-audit-ignore: samples —— 本工具的示例入口是 sqlSamples.ts 的示例库（10 组 30 条教学示例，
// 点一条即填输入框并展开讲解），比标题栏下方的静态示例 chip 更完整，故不重复接 SampleBar。
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'sql-formatter';

/**
 * SQL 工具（V22 改造为「工具 + 学习」双用）。
 *
 * # 为什么改
 *
 * 用户原话：「sql 工具里面可以添加多种的 sql 示例，既是学习指导也是样例；
 * 我们系统既是便携工具也是学习指导，例如 sql 里就可以把语法藏在示例中，
 * 方便使用的过程中也学习；如果 sql 语法有错误也可以提示，注意 sql 语法高亮。」
 *
 * 于是这个页面从「一个输入框 + 一个结果框」扩成三块能力：
 *
 * 1. **示例库**（顶部）—— 10 组、30 条按主题分组的真实 SQL（MySQL 8.0 口径），
 *    点一条即填充输入框，右侧同步展开这条示例的讲解（`takeaway` + 逐条 `points`）；
 * 2. **语法检查**（左下）—— 实时跑 `lintSql`，报错分 error / warn / info 三档，
 *    每条都给「怎么改 + 为什么」，而不是只丢一个红叉；
 * 3. **边用边学**（右下）—— 从当前输入里**自动识别**用到了哪些语法点（`syntaxPointsOf`），
 *    点开就是一句话讲解 —— 语法不是查来的，是在改自己那段 SQL 时顺手看到的。
 *
 * # 与 `src/lib/sql.ts` 的分工
 *
 * 格式化 / 检查 / 语法点识别三件事全是纯逻辑，放在 `src/lib/sql.ts`，
 * 由 `scripts/regression/test-sql.mjs` 直接 import 断言。本文件只负责长什么样。
 *
 * # 高亮
 *
 * 结果区走 `CodeBlock lang="sql"`（复用便签代码块那套零依赖词法，颜色两处永远一致）。
 * 输入框保持朴素 textarea —— `contentEditable` 做输入高亮会在中文输入法下崩光标，
 * 不值得为「输入时也彩色」冒这个险。
 */

/* ------------------------------------------------------------------ *
 * 一、样式映射
 * ------------------------------------------------------------------ */

/** 示例难度 / 用途 → chip 配色（浅色底 + 深色字，dark 下有对应色） */
const LEVEL_CLS: Record<SqlSample['level'], string> = {
  '基础': 'border-brand/30 bg-brand-muted/60 text-brand',
  '进阶': 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  '运维': 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-500',
  '数据变更': 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400',
  '结构': 'border-teal-500/30 bg-teal-500/10 text-teal-700 dark:text-teal-400',
};

/* ------------------------------------------------------------------ *
 * 二、小工具
 * ------------------------------------------------------------------ */

/**
 * 渲染讲解文案里的轻量标记：`` `代码` `` → 内联等宽，`**粗体**` → 加粗。
 *
 * 示例讲解与检查提示里混着关键字与强调，走完整 Markdown 渲染太重（这些文案是
 * 我们自己写的常量，不是用户输入），三行内联规则就够，且不需要 DOMPurify。
 */
function renderRich(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]*`|\*\*[^*]+\*\*)/g;
  let cursor = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const token: string = String(match[0]);
    if (token.startsWith('`')) {
      nodes.push(
        <code
          key={`c${key}`}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px] text-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <strong key={`b${key}`} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    }
    key += 1;
    cursor = match.index + token.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

/** 检查档位 → 图标（颜色表示严重程度，图标形状做无色彩时的冗余提示） */
function IssueIcon({ level }: { level: SqlIssueLevel }): React.JSX.Element {
  if (level === 'error') {
    return <CircleAlert className="mt-[3px] h-3.5 w-3.5 shrink-0 text-destructive" />;
  }
  if (level === 'warn') {
    return <TriangleAlert className="mt-[3px] h-3.5 w-3.5 shrink-0 text-amber-500" />;
  }
  return <Info className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

/** 档位计数徽标 */
function CountPill({ level, count }: { level: SqlIssueLevel; count: number }): React.JSX.Element | null {
  if (count === 0) {
    return null;
  }
  const cls: string =
    level === 'error'
      ? 'bg-destructive/10 text-destructive'
      : level === 'warn'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-500'
        : 'bg-muted text-muted-foreground';
  const label: string = level === 'error' ? '错误' : level === 'warn' ? '警告' : '提示';
  return (
    <span className={cn('rounded-full px-1.5 py-0.5 text-[10.5px] font-medium', cls)}>
      {count} 个{label}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * 三、子面板
 * ------------------------------------------------------------------ */

/** 语法检查面板：实时列出 `lintSql` 的结果 */
function LintPanel({ issues }: { issues: readonly SqlIssue[] }): React.JSX.Element {
  const errors: number = issues.filter((item) => item.level === 'error').length;
  const warns: number = issues.filter((item) => item.level === 'warn').length;
  const infos: number = issues.filter((item) => item.level === 'info').length;

  return (
    <div className="flex max-h-[200px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
        <span className="text-sm font-medium text-foreground">语法检查</span>
        <CountPill level="error" count={errors} />
        <CountPill level="warn" count={warns} />
        <CountPill level="info" count={infos} />
        <span className="ml-auto hidden text-[10.5px] text-muted-foreground/80 sm:inline">
          覆盖常见写法问题，非完整解析器
        </span>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {issues.length === 0 ? (
          <p className="py-2 text-[11.5px] leading-relaxed text-muted-foreground">
            没查出常见问题。规则只覆盖那些「一眼能看出写错」的情况（括号、引号、NULL 比较、
            漏 WHERE、关键字拼错……），最终能不能跑还是以数据库为准。
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {issues.map((issue: SqlIssue, index: number): React.JSX.Element => (
              <li key={`${issue.level}-${issue.line}-${index}`} className="flex gap-2 py-1.5">
                <IssueIcon level={issue.level} />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] leading-snug text-foreground">
                    {issue.line > 0 ? (
                      <span className="mr-1.5 rounded bg-muted px-1 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                        第 {issue.line} 行
                      </span>
                    ) : null}
                    {issue.message}
                  </p>
                  <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
                    {renderRich(issue.hint)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 当前示例的讲解卡（点示例后才出现） */
function SampleCard({ sample }: { sample: SqlSample }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
            LEVEL_CLS[sample.level],
          )}
        >
          {sample.level}
        </span>
        <span className="text-[12.5px] font-medium text-foreground">{sample.title}</span>
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-foreground">
        {renderRich(sample.takeaway)}
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {sample.points.map((point: string, index: number): React.JSX.Element => (
          <li key={index} className="flex gap-2">
            <span className="mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded bg-card font-mono text-[10px] text-brand">
              {index + 1}
            </span>
            <span className="min-w-0 text-[11.5px] leading-relaxed text-muted-foreground">
              {renderRich(point)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 语法点识别：把当前 SQL 用到的语法点列成可展开的 chip */
function PointsCard({
  points,
  expandedId,
  onToggle,
}: {
  points: readonly SqlSyntaxPoint[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}): React.JSX.Element {
  const expanded: SqlSyntaxPoint | undefined = points.find((item) => item.id === expandedId);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-medium text-muted-foreground">
        {points.length === 0
          ? '还没识别到语法点'
          : `这段 SQL 用到了 ${points.length} 个语法点，点开看讲解`}
      </span>
      {points.length === 0 ? (
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          在左边写点 SQL，或点上方任意示例 —— 这里会自动列出它涉及的知识点。
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {points.map((point: SqlSyntaxPoint): React.JSX.Element => (
            <button
              key={point.id}
              type="button"
              onClick={() => onToggle(point.id)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11px] transition',
                expandedId === point.id
                  ? 'border-brand/50 bg-brand-muted/70 text-brand'
                  : 'border-border bg-card text-foreground hover:border-brand/40 hover:bg-brand-muted/40',
              )}
            >
              {point.name}
            </button>
          ))}
        </div>
      )}
      {expanded ? (
        <p className="rounded-lg border border-border/70 bg-muted/40 p-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          {renderRich(expanded.detail)}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 四、主体
 * ------------------------------------------------------------------ */

/** 持久化的工具状态（关掉工具再打开不丢草稿，见 useToolState 注释） */
interface SqlToolState {
  input: string;
  uppercase: boolean;
  indent: number;
}

export function SqlFormatter({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<SqlToolState>(COMMAND_ID, {
    input: initialInput,
    uppercase: true,
    indent: 2,
  });

  /** 当前示例分组（示例条只显示一组，避免 27 条铺满屏幕） */
  const [groupId, setGroupId] = React.useState<string>(
    () => SQL_SAMPLE_GROUPS[0]?.id ?? 'basic',
  );
  /** 最近点过的示例（右侧讲解卡的数据源） */
  const [activeSampleId, setActiveSampleId] = React.useState<string | null>(null);
  /** 展开的语法点 */
  const [expandedPointId, setExpandedPointId] = React.useState<string | null>(null);

  const activeGroup: SqlSampleGroup =
    SQL_SAMPLE_GROUPS.find((group: SqlSampleGroup): boolean => group.id === groupId) ??
    SQL_SAMPLE_GROUPS[0]!;

  const activeSample: SqlSample | null = React.useMemo((): SqlSample | null => {
    if (activeSampleId === null) {
      return null;
    }
    return SQL_SAMPLES_FLAT.find((item: SqlSample): boolean => item.id === activeSampleId) ?? null;
  }, [activeSampleId]);

  /** 格式化结果（字符串 / 注释内容原样保留，只调换行与缩进） */
  const output: string = React.useMemo<string>(
    () => formatSql(state.input, state.uppercase, state.indent),
    [state.input, state.uppercase, state.indent],
  );

  /** 常见写法问题 */
  const issues: SqlIssue[] = React.useMemo<SqlIssue[]>(() => lintSql(state.input), [state.input]);

  /** 这段 SQL 用到的语法点（自动识别，无需用户操作） */
  const points: SqlSyntaxPoint[] = React.useMemo<SqlSyntaxPoint[]>(
    () => syntaxPointsOf(state.input),
    [state.input],
  );

  const applySample = (sample: SqlSample): void => {
    patch({ input: sample.sql });
    setActiveSampleId(sample.id);
    setExpandedPointId(null);
  };

  const handleTogglePoint = (id: string): void => {
    setExpandedPointId((prev: string | null): string | null => (prev === id ? null : id));
  };

  const lineCount: number = output.length === 0 ? 0 : output.split('\n').length;

  return (
    <CommandShell
      title="SQL 格式化 · 检查 · 学习"
      onPaste={(t) => patch({ input: t })}
      description="美化 SQL、查常见写法错误、顺带把语法点讲清楚（MySQL 8.0 口径）"
      icon={<Database className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={output}
      fill
      shortcutHint="格式化只调整换行与缩进，字符串与注释内容原样保留"
    >
      {/* V24：窄窗口（<lg）下**不强制撑满**，内容按自然高度堆叠、由本容器滚动。
          之前 `min-h-0 flex-1` 一路往下传，680px 时「SQL 输入」卡片被压到只剩 53px 标题栏
          （布局审计实测 scrollHeight 58 / clientHeight 53）—— 与 V23 工作台那次是同一个坑：
          flex-1 在高度不足时会先把内容压扁，而不是产生滚动条。 */}
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto lg:overflow-hidden">
        {/* ① 示例库：分组 tab + 该组示例。点一条 = 填充输入框 + 展开讲解 */}
        <section className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <header className="flex items-center gap-2 border-b border-border px-4 py-2">
            <BookOpen className="h-3.5 w-3.5 text-brand" />
            <span className="text-sm font-medium text-foreground">示例库</span>
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              点一条即填充，右侧同步给出讲解
            </span>
            <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground/80">
              {SQL_SAMPLE_GROUPS.length} 组 · {SQL_SAMPLES_FLAT.length} 条 · MySQL 8.0
            </span>
          </header>
          <div className="flex flex-col gap-2 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {SQL_SAMPLE_GROUPS.map((group: SqlSampleGroup): React.JSX.Element => (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => setGroupId(group.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11px] transition',
                    group.id === activeGroup.id
                      ? 'border-brand/50 bg-brand-muted/70 text-brand'
                      : 'border-border bg-card text-muted-foreground hover:border-brand/40 hover:text-foreground',
                  )}
                >
                  {group.name}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{activeGroup.blurb}</p>
            <div className="flex flex-wrap gap-1.5">
              {activeGroup.samples.map((sample: SqlSample): React.JSX.Element => (
                <button
                  key={sample.id}
                  type="button"
                  onClick={() => applySample(sample)}
                  title={sample.takeaway}
                  className={cn(
                    'max-w-[240px] truncate rounded-lg border px-2.5 py-1 text-left text-[11.5px] transition',
                    sample.id === activeSampleId
                      ? 'border-brand/50 bg-brand-muted/60 text-brand'
                      : 'border-border bg-card text-foreground hover:border-brand/40 hover:bg-brand-muted/40',
                  )}
                >
                  {sample.title}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* ② 主区：左输入右结果 */}
        <div className="grid grid-cols-1 gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-2">
          {/* 左列：输入 + 选项 + 检查 */}
          <div className="flex min-w-0 flex-col gap-3 lg:min-h-0">
            <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card lg:min-h-0 lg:flex-1">
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
                <label className="text-sm font-medium text-foreground" htmlFor="sql-input">
                  SQL 输入
                </label>
                <span className="text-[10.5px] text-muted-foreground/80">
                  {state.input.length} 字符
                </span>
                <button
                  type="button"
                  onClick={() => patch({ input: '' })}
                  disabled={state.input.length === 0}
                  className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  <Eraser className="h-3 w-3" />
                  清空
                </button>
              </div>
              <textarea
                id="sql-input"
                spellCheck={false}
                autoComplete="off"
                className="scrollbar-thin min-h-[220px] flex-1 resize-none bg-transparent px-3 py-2.5 font-mono text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground lg:min-h-0"
                value={state.input}
                placeholder={'select id, name, email\nfrom users\nwhere status = 1\norder by created_at desc\nlimit 20'}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                  patch({ input: event.target.value })
                }
              />
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-[12.5px] text-foreground">
                <Switch
                  checked={state.uppercase}
                  onCheckedChange={(checked: boolean) => patch({ uppercase: checked })}
                />
                关键字大写
              </label>
              <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                缩进
                <input
                  type="number"
                  min={0}
                  max={8}
                  value={state.indent}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    patch({
                      indent: Math.max(
                        0,
                        Math.min(8, Number.parseInt(event.target.value, 10) || 0),
                      ),
                    })
                  }
                  className="h-7 w-16 rounded-md border border-input bg-background px-2 text-[12.5px] text-foreground"
                />
                空格
              </label>
            </div>

            <LintPanel issues={issues} />
          </div>

          {/* 右列：结果 + 学习（整体滚动，长 SQL 也不会把学习卡挤没） */}
          <div className="flex min-w-0 flex-col gap-3 pr-1 lg:scrollbar-thin lg:min-h-0 lg:overflow-y-auto">
            <div className="shrink-0 overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <span className="text-sm font-medium text-foreground">格式化结果</span>
                <span className="text-[10.5px] text-muted-foreground/80">
                  {lineCount > 0 ? `${lineCount} 行` : ''}
                </span>
                <div className="ml-auto">
                  <CopyButton text={output} disabled={output.length === 0} />
                </div>
              </div>
              {output.length === 0 ? (
                <p className="px-4 py-6 text-[12.5px] text-muted-foreground">
                  左边写点 SQL，或点上方示例 —— 这里给出美化后的结果（带语法高亮）。
                </p>
              ) : (
                <CodeBlock code={output} lang="sql" className="my-0 rounded-none border-0" />
              )}
            </div>

            <div className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
              <header className="flex items-center gap-2 border-b border-border px-4 py-2">
                <Sparkles className="h-3.5 w-3.5 text-brand" />
                <span className="text-sm font-medium text-foreground">边用边学</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {activeSample === null ? '语法点讲解' : `当前示例：${activeSample.title}`}
                </span>
              </header>
              <div className="flex flex-col gap-3 px-4 py-3">
                {activeSample ? <SampleCard sample={activeSample} /> : null}
                <PointsCard
                  points={points}
                  expandedId={expandedPointId}
                  onToggle={handleTogglePoint}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </CommandShell>
  );
}

export default SqlFormatter;
