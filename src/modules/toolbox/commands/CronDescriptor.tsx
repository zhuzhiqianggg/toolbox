import * as React from 'react';
import {
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  Info,
  TriangleAlert,
  Wand2,
  X,
} from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import {
  CRON_PRESETS,
  analyzeCron,
  buildCron,
  expandMacro,
  fieldLayout,
  formatRunTime,
  humanRunTime,
  platformOf,
  type CronBuildInput,
  type CronBuildMode,
  type CronFieldResult,
  type CronFieldSpec,
  type CronPlatformInfo,
} from '@/lib/cron';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'cron-descriptor';
// tool-audit-ignore: samples —— 生成器预设已是更强的示例入口，见 CronDescriptor 顶部说明

/**
 * Cron 表达式解析（V21 重做 → V23 收敛）。
 *
 * # V23 用户反馈（两条）
 *
 * 1. 「看图片中字段拆解的展示内容，它其实和前面已有的部分是重复的，请评估是否可以去掉或合并」
 *    —— 确认重复，**已删除**独立的「字段拆解」面板。原来它和「逐段编辑」都在渲染
 *    `label / raw / text`，属于同一份数据的两种排版；现在把拆解表**独有**的两样东西
 *    （① 展开后的取值 `0, 5, 10 …`，② 出错时的定位）**并进了逐段编辑的每个格子**，
 *    信息一条不少，纵向少一整块。仅当逐段编辑无法渲染（宏写法 / 段数非法）时，
 *    才退化成一张紧凑的「展开后分段含义」小表 —— 那种情况下它是唯一的信息载体。
 * 2. 「请说明 Quartz 语法究竟是什么、在什么场景下会被实际使用，如果不属于常用语法，
 *    请判断是否应当从当前内容中移除以免造成误解」
 *    —— **结论：保留，但必须标清适用平台**（判定逻辑在 `cron.ts::platformOf`）。
 *    理由与界面呈现见下面这段说明，界面上落实为输入框下方那条**平台提示条**。
 *
 * # 关于 Quartz：为什么保留、怎么防止误解
 *
 * | | 标准 5 段 | Quartz 6 / 7 段 |
 * | --- | --- | --- |
 * | 长相 | `分 时 日 月 周` | `秒 分 时 日 月 周 [年]` |
 * | 谁在用 | Linux `crontab`、`/etc/cron.d`、cronie、BusyBox crond、**Kubernetes CronJob** | Quartz Scheduler、Spring `@Scheduled`、**XXL-JOB**、ElasticJob |
 * | 最小粒度 | 1 分钟（没有「秒」这一格） | 1 秒 |
 * | 扩展符号 | 无 | `?` 不指定 / `L` 最后一天 / `15W` 最近工作日 / `1#2` 第 2 个周一 |
 *
 * 判断依据：
 * - **它不是冷门语法，不能删。** 国内 Java 生态里 XXL-JOB 是分布式任务调度的常见选择，
 *   Spring 的 `@Scheduled(cron=…)` 也是 6 段 —— 把这些用户的需求砍掉，工具就废了一半。
 * - **但它跟 5 段不互通，混用会「静默不生效」。** 把 `0 0/5 * * * ?` 贴进 `crontab -e`，
 *   cron 不会给你一个友好提示，它只是不跑。这才是「造成误解」的真正来源 ——
 *   不是「Quartz 存在」这件事，而是**工具没有标清哪套写法喂给谁**。
 * - 所以这一版做了三件事：① 把 Quartz 从标题里降级（标题只写「标准 5 段」为准）；
 *   ② 输入框正下方常驻一条**平台提示条**，说明「当前这套写法是喂给谁的」；
 *   ③ 一旦检测到 6/7 段、或 5 段里混进了 `L` / `W` / `#` / `?`，提示条**自动变警示色**
 *   并直接写明「贴进 crontab / K8s CronJob 会报错」，把坑摊在明面上。
 *
 * # V21 已交付、本版保留的能力
 *
 * 逐段编辑（与表达式逐段对齐的输入框）、20+ 条运维预设、参数化反向生成、
 * 未来 8 次执行时间、宏写法展开。状态经 `useToolState` 持久化。
 */

/** 生成器模式选项 */
const BUILD_MODES: ReadonlyArray<{ value: CronBuildMode; label: string; hint: string }> = [
  { value: 'minutes', label: '每 N 分钟', hint: '标准写法 */N * * * *' },
  { value: 'hours', label: '每 N 小时', hint: '0 */N * * *' },
  { value: 'daily', label: '每天固定时刻', hint: 'M H * * *' },
  { value: 'weekdays', label: '工作日固定时刻', hint: 'M H * * 1-5' },
  { value: 'weekly', label: '每周某天', hint: 'M H * * D' },
  { value: 'weeklyRange', label: '每周某区间', hint: 'M H * * 1-5' },
  { value: 'monthly', label: '每月某号', hint: 'M H D * *' },
  { value: 'dayList', label: '每月多号', hint: 'M H 1,15 * *' },
  { value: 'seconds', label: '每 N 秒（Quartz）', hint: '6 段：0/N * * * * ? —— 只能给 Java 侧调度器用' },
  { value: 'lastDay', label: '每月最后一天（Quartz）', hint: '6 段：M H L * ? —— crontab 不支持 L' },
];

/** 生成器里各「间隔」组的常用值快选（省得一个个敲数字） */
const STEP_SUGGESTIONS: Record<'seconds' | 'minutes' | 'hours', readonly number[]> = {
  seconds: [5, 10, 15, 20, 30],
  minutes: [2, 3, 5, 6, 10, 15, 20, 30],
  hours: [2, 3, 4, 6, 8, 12],
};

/** 「间隔」类模式的元信息：单位、上限、以及去 `STEP_SUGGESTIONS` 取常用值的键 */
const STEP_MODE_INFO: Partial<
  Record<CronBuildMode, { unit: string; max: number; key: 'seconds' | 'minutes' | 'hours' }>
> = {
  seconds: { unit: '秒', max: 59, key: 'seconds' },
  minutes: { unit: '分钟', max: 59, key: 'minutes' },
  hours: { unit: '小时', max: 23, key: 'hours' },
};

const WEEKDAY_PICKER: readonly string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

interface CronToolState {
  input: string;
  showBuild: boolean;
  showPresets: boolean;
  /** 平台说明的「详情」是否展开（默认收起，避免首屏太满） */
  showPlatform: boolean;
  build: CronBuildInput;
}

/**
 * 生成器参数的完整默认值。
 *
 * 单独抽出来是因为 `useToolState` 只做**浅合并**：老版本存过的 `build` 会整块盖掉
 * 新默认值，新增字段（`weekdayTo` / `days`）在旧草稿里就是 `undefined`。
 * 渲染前统一 `{...DEFAULT_BUILD, ...state.build}` 兜一层，缺字段也不会生成出 `NaN`。
 */
const DEFAULT_BUILD: CronBuildInput = {
  mode: 'daily',
  every: 5,
  hour: 9,
  minute: 0,
  weekday: 1,
  weekdayTo: 5,
  day: 1,
  days: [1, 15],
};

const INITIAL_STATE: CronToolState = {
  input: '0 9 * * 1-5',
  showBuild: false,
  showPresets: false,
  showPlatform: false,
  build: { ...DEFAULT_BUILD },
};

/** 小徽标 */
function Badge({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'error' | 'info';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
        tone === 'ok' && 'bg-emerald-100 text-emerald-700',
        tone === 'warn' && 'bg-amber-100 text-amber-800',
        tone === 'error' && 'bg-destructive/10 text-destructive',
        tone === 'info' && 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

/**
 * 行内富文本：把 `` `code` `` 渲染成等宽小片。
 *
 * 平台说明里到处是 `crontab -e`、`@Scheduled`、`L` 这类关键字，纯文本一坨读起来很糊；
 * 这里做最小实现（只认反引号，不引入 markdown 渲染器），既保住可读性，
 * 又不会像 V22 以前那样把 `**加粗**` 的星号原样漏到界面上。
 */
function InlineText({ text }: { text: string }): React.JSX.Element {
  const parts: string[] = text.split('`');
  return (
    <>
      {parts.map((part: string, index: number) =>
        index % 2 === 1 ? (
          <code key={index} className="mx-0.5 rounded bg-black/5 px-1 font-mono text-[10.5px]">
            {part}
          </code>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

/** 字段取值展开文案（格子下方那行小字） */function valuesLine(field: CronFieldResult | undefined): { text: string; full: string } | null {
  if (field === undefined || !field.ok || field.values === null || field.values.length === 0) {
    return null;
  }
  const all: number[] = field.values;
  const text: string =
    all.length <= 8
      ? all.join(' ')
      : `${all.slice(0, 6).join(' ')} … 共 ${all.length} 个`;
  return { text, full: `展开取值（${all.length} 个）：${all.join(', ')}` };
}

/**
 * Cron 表达式解析：逐段编辑 + 中文描述 + 下次执行时间 + 反向生成 + 平台兼容提示。
 */
export function CronDescriptor({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<CronToolState>(COMMAND_ID, {
    ...INITIAL_STATE,
    input: initialInput || INITIAL_STATE.input,
  });

  const analysis = React.useMemo(() => analyzeCron(state.input), [state.input]);
  const hasSeconds: boolean = analysis.form === 'quartz';
  const platform: CronPlatformInfo = React.useMemo(() => platformOf(analysis), [analysis]);
  const macroExpanded: string | null = React.useMemo(() => expandMacro(state.input), [state.input]);

  /** 生成器参数（补齐旧草稿缺失的字段，见 `DEFAULT_BUILD`） */
  const build: CronBuildInput = React.useMemo(
    () => ({ ...DEFAULT_BUILD, ...state.build }),
    [state.build],
  );
  const generated: string = React.useMemo(() => buildCron(build), [build]);

  /** 按空白切段；逐段编辑器与生成的表达式都基于它 */
  const segments: string[] = React.useMemo(
    () => state.input.trim().split(/\s+/).filter((part) => part.length > 0),
    [state.input],
  );
  /** 当前段数对应的界面规格；null = 段数不合法（只能编原始表达式） */
  const layout: readonly CronFieldSpec[] | null = React.useMemo(
    () => fieldLayout(segments.length),
    [segments.length],
  );
  const isMacro: boolean = state.input.trim().startsWith('@');

  /**
   * 改写第 index 段并重组成完整表达式。
   *
   * 段内的空白直接吃掉（cron 靠空白分段，留着空格会把一段劈成两段）；
   * 清空某段时回落成 `*`，否则 `join(' ')` 会产出连续空格、段数跟着变，界面会跳。
   */
  const withSegment = (index: number, raw: string): string => {
    const next = [...segments];
    next[index] = raw.replace(/\s+/g, '') || '*';
    return next.join(' ');
  };

  const [copied, setCopied] = React.useState(false);
  const copyExpression = (): void => {
    void navigator.clipboard
      .writeText(state.input.trim())
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error('复制失败'));
  };

  const apply = (expr: string): void => {
    patch({ input: expr });
  };

  return (
    <CommandShell
      title="Cron 表达式解析"
      onPaste={(t) => patch({ input: t })}
      description="标准 5 段（crontab / K8s）逐段编辑 · 中文描述 · 下次执行时间 · 反向生成"
      icon={<CalendarClock className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={analysis.ok ? analysis.summary : ''}
      shortcutHint="逐段编辑：每个格子改一段，上方表达式实时同步；Esc 返回"
    >
      <div className="flex flex-col gap-4">
        {/* ——— 表达式输入 ——— */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm font-medium text-foreground" htmlFor="cron-input">
              Cron 表达式
            </label>
            {analysis.ok ? (
              <Badge tone={platform.platform === 'quartz' ? 'warn' : 'ok'}>{platform.title}</Badge>
            ) : (
              <Badge tone="error">
                <X className="h-3 w-3" />
                无法解析
              </Badge>
            )}
            <button
              type="button"
              onClick={copyExpression}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? '已复制' : '复制表达式'}
            </button>
          </div>
          <input
            id="cron-input"
            value={state.input}
            spellCheck={false}
            placeholder="0 9 * * 1-5   （标准 5 段：分 时 日 月 周）"
            onChange={(event) => patch({ input: event.target.value })}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-base tracking-wide shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />

          {/* ——— 平台提示条（V23 新增）———
              这是「避免 Quartz 造成误解」的主入口：常驻一行说清「这套写法喂给谁」，
              有坑时变警示色并把坑直接写出来；详情默认收起，需要时展开看完整对照。 */}
          {analysis.ok ? (
            <div
              className={cn(
                'rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed',
                platform.risky
                  ? 'border-amber-300 bg-amber-50 text-amber-900'
                  : 'border-border bg-muted/40 text-muted-foreground',
              )}
            >
              <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                <span className="shrink-0 font-medium">
                  {platform.risky ? (
                    <TriangleAlert className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                  ) : (
                    <Info className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                  )}
                  适用：{platform.title}
                </span>
                <span className="min-w-0 flex-1">
                  <InlineText text={platform.summary} />
                </span>
                <button
                  type="button"
                  onClick={() => patch({ showPlatform: !state.showPlatform })}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 transition hover:bg-black/5"
                >
                  {state.showPlatform ? '收起详情' : '详情'}
                  <ChevronDown
                    className={cn('h-3 w-3 transition-transform', state.showPlatform && 'rotate-180')}
                  />
                </button>
              </div>

              {platform.warnings.length > 0 ? (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {platform.warnings.map((warning) => (
                    <li key={warning} className="flex gap-1.5">
                      <span className="mt-[3px] h-1 w-1 shrink-0 rounded-full bg-current" />
                      <span className="min-w-0">
                        <InlineText text={warning} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {state.showPlatform ? (
                <div className="mt-2 grid grid-cols-1 gap-2 border-t border-border/60 pt-2 sm:grid-cols-2">
                  <div>
                    <p className="font-medium">标准 5 段 · 分 时 日 月 周</p>
                    <p className="mt-0.5">
                      Linux <code className="rounded bg-black/5 px-1">crontab -e</code>、
                      <code className="mx-1 rounded bg-black/5 px-1">/etc/cron.d</code>、cronie、BusyBox
                      crond、Kubernetes CronJob 的 <code className="rounded bg-black/5 px-1">schedule</code>{' '}
                      都是这一套。最小粒度 <b>1 分钟</b>，没有「秒」这一格。
                    </p>
                  </div>
                  <div>
                    <p className="font-medium">Quartz 6 / 7 段 · 秒 分 时 日 月 周 [年]</p>
                    <p className="mt-0.5">
                      用 Quartz 的地方才会认：Quartz Scheduler、Spring{' '}
                      <code className="rounded bg-black/5 px-1">@Scheduled</code>、XXL-JOB、
                      ElasticJob。多了「秒」以及 <code className="rounded bg-black/5 px-1">?</code>（不指定）
                      / <code className="rounded bg-black/5 px-1">L</code>（最后一天）/
                      <code className="rounded bg-black/5 px-1">15W</code>（最近工作日）/
                      <code className="rounded bg-black/5 px-1">1#2</code>（第 2 个周一）。
                    </p>
                  </div>
                  <p className="sm:col-span-2">
                    一句话记法：<b>给服务器写任务（crontab / K8s）用 5 段；给 Java 应用写任务（XXL-JOB / Spring）才用 6 段。</b>
                    需要秒级但只有 crontab 可用时，正确做法是放宽到「每 1 分钟」或改用 systemd timer，
                    而不是把 6 段塞进去。
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ——— 逐段编辑（V23：取值与出错定位已内联到这里，「字段拆解」面板随之删除） ——— */}
          {layout !== null && !isMacro ? (
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs font-medium text-foreground">逐段编辑</span>
                <span className="text-[11px] text-muted-foreground">
                  改哪段点哪段，上面的表达式实时同步；格子下方的灰字是该段含义，再下一行是<b>展开后的取值</b>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const first: HTMLInputElement | null = document.querySelector('#cron-seg-0');
                    first?.focus();
                  }}
                  className="ml-auto rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
                >
                  跳到第 1 段
                </button>
              </div>
              <div
                className="grid gap-2"
                style={{ gridTemplateColumns: `repeat(${layout.length}, minmax(0, 1fr))` }}
              >
                {layout.map((spec: CronFieldSpec, index: number) => {
                  const field: CronFieldResult | undefined = analysis.fields[index];
                  const value: string = segments[index] ?? '';
                  const bad: boolean = field !== undefined && !field.ok;
                  const values: { text: string; full: string } | null = valuesLine(field);
                  return (
                    <div key={spec.key} className="flex min-w-0 flex-col items-stretch gap-1">
                      <span
                        className="text-center text-[11px] font-medium text-muted-foreground"
                        title={spec.hint}
                      >
                        {spec.label}
                      </span>
                      <input
                        id={`cron-seg-${index}`}
                        value={value}
                        spellCheck={false}
                        aria-label={`${spec.label} 段`}
                        title={spec.hint}
                        onChange={(event) => patch({ input: withSegment(index, event.target.value) })}
                        className={cn(
                          'w-full rounded-md border bg-transparent px-1.5 py-1 text-center font-mono text-xs shadow-sm transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                          bad ? 'border-destructive/50 text-destructive' : 'border-input text-foreground',
                        )}
                      />
                      <span
                        className={cn(
                          'min-h-[2.6em] text-center text-[10px] leading-snug',
                          bad ? 'text-destructive' : 'text-muted-foreground',
                        )}
                        title={field !== undefined && !field.ok ? field.error : spec.hint}
                      >
                        {field === undefined
                          ? '—'
                          : field.ok
                            ? field.text
                            : `⚠ ${field.error ?? '格式错误'}`}
                      </span>
                      {values !== null ? (
                        <span
                          className="truncate text-center font-mono text-[10px] text-muted-foreground/70"
                          title={values.full}
                        >
                          {values.text}
                        </span>
                      ) : (
                        // 占位：让有取值 / 无取值的格子行高一致，避免整排参差
                        <span aria-hidden className="select-none text-center text-[10px] text-transparent">
                          ·
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
              {isMacro
                ? '这是宏写法（@daily 等），本身只有 1 段，没法逐段编辑 —— 下面列出了它展开后的分段含义，也可以点「展开成 5 段继续编辑」。'
                : `当前 ${segments.length} 段，不是 5 / 6 / 7 段，没法逐段编辑 —— 先在上面的输入框里把段数补齐。`}
            </p>
          )}

          {!analysis.ok ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {analysis.error}
            </p>
          ) : null}
        </div>

        {/* ——— 宏：展开后的分段含义（仅在逐段编辑不可用时出现） ——— */}
        {isMacro && analysis.fields.length > 0 ? (
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-foreground">展开后的分段含义</span>
              {macroExpanded !== null ? (
                <button
                  type="button"
                  onClick={() => patch({ input: macroExpanded })}
                  className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition hover:border-brand/40 hover:bg-accent/40 hover:text-foreground"
                >
                  展开成 5 段继续编辑（{macroExpanded}）
                </button>
              ) : null}
            </div>
            <div className="flex flex-col gap-1">
              {analysis.fields.map((field: CronFieldResult) => {
                const values: { text: string; full: string } | null = valuesLine(field);
                return (
                  <div
                    key={field.key}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px]"
                  >
                    <span className="w-8 shrink-0 text-muted-foreground">{field.label}</span>
                    <code className="shrink-0 rounded bg-muted px-1 font-mono text-[11px]">
                      {field.raw}
                    </code>
                    <span className="min-w-0 flex-1 text-foreground">
                      {field.ok ? field.text : `⚠ ${field.error ?? '格式错误'}`}
                    </span>
                    {values !== null ? (
                      <span
                        className="truncate font-mono text-[10px] text-muted-foreground/70"
                        title={values.full}
                      >
                        {values.text}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* ——— 中文描述 ——— */}
        {analysis.ok ? (
          <div className="rounded-xl border border-border bg-card p-4 shadow-panel">
            <p className="text-sm font-medium text-foreground">{analysis.summary}</p>
            {analysis.normalized !== state.input.trim() && analysis.form === 'macro' ? (
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                展开：{analysis.normalized}
              </p>
            ) : null}
            {analysis.dayOrWeek ? (
              <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  「日」和「周」<b>同时</b>限定时，两者是<b>或</b>的关系（传统 Vixie cron 语义）：
                  例如「每月 1 日 或 每周一」都会触发，不是「1 日且是周一」。
                  无论是标准 cron 还是 Quartz，都<b>表达不了「且」</b>——Quartz 甚至强制两段之一必须写成{' '}
                  <code className="rounded bg-amber-100 px-1">?</code>（不指定），设了之后那一段条件就被丢掉了。
                  真需要「既在几号、又是周几」的交集，只能拆成两条任务或在脚本里自行判断。
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

        {/* ——— 下次执行时间 ——— */}
        {analysis.ok && analysis.next.length > 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
              <span className="text-sm font-medium text-foreground">接下来 8 次执行</span>
              <span className="text-[11px] text-muted-foreground">本机时区 · 由当前时间起算</span>
            </div>
            <div className="flex flex-wrap gap-2 p-3">
              {analysis.next.map((time, index) => {
                const isFirst: boolean = index === 0;
                return (
                  <span
                    key={time}
                    className={cn(
                      'inline-flex items-baseline gap-1.5 rounded-lg border px-2.5 py-1.5',
                      isFirst ? 'border-brand/40 bg-brand-muted/60' : 'border-border',
                    )}
                  >
                    <span className="text-[11px] text-muted-foreground">{humanRunTime(time)}</span>
                    <span className="font-mono text-xs font-medium text-foreground">
                      {formatRunTime(time, hasSeconds)}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        ) : analysis.ok ? (
          <p className="rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
            该表达式在未来 2 年内没有可推算的执行时间（例如限定了已过去的年份，或 `@reboot` 这类无时间语义的写法）。
          </p>
        ) : null}

        {/* ——— 预设 ——— */}
        <div className="rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <span className="text-sm font-medium text-foreground">常用表达式</span>
            <span className="text-[11px] text-muted-foreground">
              点一下填进输入框；带「Quartz」的只能给 Java 侧调度器用
            </span>
            <button
              type="button"
              onClick={() => patch({ showPresets: !state.showPresets })}
              className="ml-auto rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              {state.showPresets ? '收起' : '展开'}
            </button>
          </div>
          {state.showPresets ? (
            <div className="flex flex-col gap-3 p-3">
              {['高频', '每天', '每周', '每月', '进阶'].map((group) => {
                const list = CRON_PRESETS.filter((preset) => preset.group === group);
                if (list.length === 0) {
                  return null;
                }
                return (
                  <div key={group}>
                    <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{group}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {list.map((preset) => (
                        <button
                          key={preset.expr + preset.label}
                          type="button"
                          title={preset.note || preset.expr}
                          onClick={() => apply(preset.expr)}
                          className={cn(
                            'group inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left transition',
                            state.input.trim() === preset.expr
                              ? 'border-brand/50 bg-brand-muted/60'
                              : 'border-border hover:border-brand/40 hover:bg-accent/40',
                          )}
                        >
                          <span className="text-xs text-foreground">{preset.label}</span>
                          <code className="font-mono text-[10px] text-muted-foreground">
                            {preset.expr}
                          </code>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* ——— 反向生成器 ——— */}
        <div className="rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <Wand2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">说人话生成表达式</span>
            <span className="text-[11px] text-muted-foreground">
              {BUILD_MODES.find((item) => item.value === build.mode)?.hint ?? ''}
            </span>
            <button
              type="button"
              onClick={() => patch({ showBuild: !state.showBuild })}
              className="ml-auto rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              {state.showBuild ? '收起' : '展开'}
            </button>
          </div>
          {state.showBuild ? (
            <div className="flex flex-col gap-3 p-3">
              {/* 模式 */}
              <div className="flex flex-wrap items-center gap-1.5">
                {BUILD_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    title={mode.hint}
                    onClick={() => patch({ build: { ...build, mode: mode.value } })}
                    className={cn(
                      'rounded-md border px-2 py-1 text-[11px] transition',
                      build.mode === mode.value
                        ? 'border-brand/50 bg-brand-muted text-brand'
                        : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-end gap-3">
                {/* 间隔类模式：数值 + 常用值快选 */}
                {STEP_MODE_INFO[build.mode] !== undefined ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">
                      间隔（{STEP_MODE_INFO[build.mode]?.unit}）
                    </span>
                    <div className="flex flex-wrap items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        max={STEP_MODE_INFO[build.mode]?.max}
                        value={build.every}
                        aria-label="间隔数值"
                        onChange={(event) =>
                          patch({ build: { ...build, every: Number(event.target.value) } })
                        }
                        className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                      />
                      {STEP_SUGGESTIONS[STEP_MODE_INFO[build.mode]?.key ?? 'minutes'].map((step) => (
                        <button
                          key={step}
                          type="button"
                          onClick={() => patch({ build: { ...build, every: step } })}
                          className={cn(
                            'rounded border px-2 py-1 text-[11px] transition',
                            build.every === step
                              ? 'border-brand/50 bg-brand-muted text-brand'
                              : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                          )}
                        >
                          {step}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* 固定时刻类模式：时 + 分 */}
                {STEP_MODE_INFO[build.mode] === undefined ? (
                  <>
                    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                      时
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={build.hour}
                        onChange={(event) =>
                          patch({ build: { ...build, hour: Number(event.target.value) } })
                        }
                        className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                      分
                      <input
                        type="number"
                        min={0}
                        max={59}
                        value={build.minute}
                        onChange={(event) =>
                          patch({ build: { ...build, minute: Number(event.target.value) } })
                        }
                        className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                      />
                    </label>
                  </>
                ) : null}

                {build.mode === 'weekly' ? (
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    星期
                    <select
                      value={build.weekday}
                      onChange={(event) =>
                        patch({ build: { ...build, weekday: Number(event.target.value) } })
                      }
                      className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                    >
                      {WEEKDAY_PICKER.map((label, index) => (
                        <option key={label} value={index}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {build.mode === 'weeklyRange' ? (
                  <div className="flex items-end gap-1">
                    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                      从
                      <select
                        value={build.weekday}
                        onChange={(event) =>
                          patch({ build: { ...build, weekday: Number(event.target.value) } })
                        }
                        className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                      >
                        {WEEKDAY_PICKER.map((label, index) => (
                          <option key={label} value={index}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                      到
                      <select
                        value={build.weekdayTo}
                        onChange={(event) =>
                          patch({ build: { ...build, weekdayTo: Number(event.target.value) } })
                        }
                        className="rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                      >
                        {WEEKDAY_PICKER.map((label, index) => (
                          <option key={label} value={index}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}

                {build.mode === 'monthly' ? (
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    几号
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={build.day}
                      onChange={(event) =>
                        patch({ build: { ...build, day: Number(event.target.value) } })
                      }
                      className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-sm text-foreground"
                    />
                  </label>
                ) : null}

                {build.mode === 'dayList' ? (
                  <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                    几号（逗号分隔，如 1,15）
                    <input
                      value={build.days.join(',')}
                      spellCheck={false}
                      onChange={(event) => {
                        const days = event.target.value
                          .split(/[,，\s]+/)
                          .map((piece) => Number.parseInt(piece, 10))
                          .filter((value) => Number.isFinite(value) && value >= 1 && value <= 31);
                        patch({ build: { ...build, days: [...new Set(days)].sort((a, b) => a - b) } });
                      }}
                      className="w-52 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-sm text-foreground"
                    />
                  </label>
                ) : null}

                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <code className="rounded-md bg-muted px-2 py-1 font-mono text-sm text-foreground">
                    {generated}
                  </code>
                  <Button size="sm" className="h-7 px-2.5 text-xs" onClick={() => apply(generated)}>
                    填入
                  </Button>
                </div>
              </div>

              {build.mode === 'seconds' || build.mode === 'lastDay' ? (
                <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    这个模式生成的是 <b>Quartz 6 段</b>表达式，只能给 Quartz / Spring / XXL-JOB
                    这类 Java 侧调度器用；贴进 <code className="rounded bg-amber-100 px-1">crontab</code> 或
                    K8s CronJob 会不生效。
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </CommandShell>
  );
}

export default CronDescriptor;
