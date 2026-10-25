import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Eye, EyeOff, ListTodo, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { RichMarkdown } from '@/components/RichMarkdown';
import { stripMarkdown } from '@/lib/markdown';
import { useTodosStore } from '@/stores/useTodosStore';
import { TODO_PRIORITIES, priorityStyle, type Todo, type TodoPatch } from '@/core/data/todosService';
import { cn } from '@/lib/utils';
import {
  SCOPE_LABELS,
  dayLabel,
  defaultMomentOfDay,
  filterTodos,
  overdueDays,
  relativeDayLabel,
  scheduleLabel,
  startOfDay,
  type PlanScope,
} from './planUtils';

/**
 * 工作台「计划」面板：按范围（当日 / 本周 / 本月 / 无日期 / 全部）展示待办。
 *
 * # V19 改版要点（来自用户实测反馈）
 *
 * 1. **「任务名称 + 任务说明」双字段**：标题只写一句短语，说明用 Markdown 补充上下文
 *    （步骤 / 链接 / 子清单）；数据落在 `todos.detail`（迁移 v5）。
 * 2. **整行点击展开**：不再要求「先点中这条才能操作」——点行内任意位置即展开编辑，
 *    左侧圆圈只负责勾完成，语义各归各位。
 * 3. **说明逐字渲染**：说明区用 `RichMarkdown`（所见即所得），敲 `**重点**` 当场变粗体，
 *    不再让人对着星号脑补。
 *
 * 数据仍复用 `useTodosStore`（即「待办清单」命令的同一份 SQLite 数据）——工作台只是
 * 同一份数据的**日历视角**，不引入第二套任务模型。
 */

export interface PlanPanelProps {
  todos: Todo[];
  /** 日历选中的日期（本地零点毫秒） */
  anchorMs: number;
  scope: PlanScope;
  onScopeChange: (scope: PlanScope) => void;
  hideDone: boolean;
  onHideDoneChange: (value: boolean) => void;
  /** 递增信号：变化时聚焦新增输入框（由日历点击触发） */
  focusToken: number;
}

/** 范围 chip 顺序（`day` 的文案在渲染时按选中日期动态显示） */
const SCOPE_ORDER: readonly PlanScope[] = ['day', 'week', 'month', 'undated', 'all'];

export function PlanPanel({
  todos,
  anchorMs,
  scope,
  onScopeChange,
  hideDone,
  onHideDoneChange,
  focusToken,
}: PlanPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 日历点击「＋」后聚焦输入框：形成「点日历 → 直接打字记事件」的连贯动作
  useEffect(() => {
    if (focusToken > 0) {
      inputRef.current?.focus();
    }
  }, [focusToken]);

  const visible = useMemo(
    () => filterTodos(todos, scope, anchorMs, hideDone),
    [todos, scope, anchorMs, hideDone],
  );
  /**
   * 分两组渲染：未完成在上、已完成压到列表末尾（带分隔）。
   * 之前是一锅乱炖，勾掉的和没做长的混在一起，用户反馈「列表太乱」。
   */
  const pendingRows = useMemo(
    () => visible.filter((todo: Todo): boolean => !todo.done),
    [visible],
  );
  const doneRows = useMemo(
    () => visible.filter((todo: Todo): boolean => todo.done),
    [visible],
  );
  const pendingInScope = pendingRows.length;

  /** 统一写入口：出错统一提示，避免每处都写一遍 try/catch */
  const patch = useCallback((id: string, next: TodoPatch): void => {
    void useTodosStore
      .getState()
      .updateTodo(id, next)
      .catch((error: unknown) => {
        toast.error(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }, []);

  const handleAdd = (): void => {
    const title = draft.trim();
    if (title.length === 0) {
      inputRef.current?.focus();
      return;
    }
    const dueAt = scope === 'undated' ? null : defaultMomentOfDay(anchorMs);
    void useTodosStore
      .getState()
      .createTodo({ title, dueAt })
      .then((created) => {
        setDraft('');
        // 建完直接展开：紧接着就能补说明，少一次点击
        setExpandedId(created.id);
        toast.success(
          dueAt === null ? '已添加到「无日期」' : `已添加到 ${relativeDayLabel(anchorMs)}`,
        );
      })
      .catch((error: unknown) => {
        toast.error(`新增事件失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const handleToggle = (id: string): void => {
    void useTodosStore
      .getState()
      .toggleDone(id)
      .catch((error: unknown) => {
        toast.error(`更新失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const handleDelete = (id: string): void => {
    void useTodosStore
      .getState()
      .deleteTodo(id)
      .catch((error: unknown) => {
        toast.error(`删除失败：${error instanceof Error ? error.message : String(error)}`);
      });
  };

  /**
   * 输入框提示：placeholder 只留最短的一句（面板窄的时候会被截断），
   * 完整的「挂到哪一天」挂在 title 上，鼠标停一下就能看到。
   */
  const addHint =
    scope === 'undated' ? '写一条不设日期的事，回车即入' : '写一条计划，回车即入';
  const addHintTitle =
    scope === 'undated'
      ? '写一条不设日期的事，回车即入'
      : `写一条并回车，挂到 ${relativeDayLabel(anchorMs)}`;

  /**
   * 是否显示排期徽标：当日范围里每条都挂在这一天（标题已经写了「计划 · 今天」），
   * 再逐条重复「今天」纯属噪音；跨天范围才需要它区分先后。
   */
  const showSchedule = scope === 'week' || scope === 'month' || scope === 'all';

  /** 行渲染：未完成与已完成共用同一套行组件，先后顺序由上面的分组决定 */
  const renderRow = (todo: Todo): React.JSX.Element => (
    <TodoRow
      key={todo.id}
      todo={todo}
      showSchedule={showSchedule}
      expanded={expandedId === todo.id}
      onToggleExpand={() =>
        setExpandedId((prev: string | null): string | null => (prev === todo.id ? null : todo.id))
      }
      onToggleDone={() => handleToggle(todo.id)}
      onDelete={() => handleDelete(todo.id)}
      onPatch={(next: TodoPatch) => patch(todo.id, next)}
    />
  );

  return (
    <section className="flex h-full min-h-[260px] flex-col gap-2.5 overflow-hidden rounded-xl border border-border bg-card p-3 shadow-panel lg:min-h-0">
      <header className="flex shrink-0 items-center gap-2">
        {/* 与日历面板同一套「柔色底 + 同色字」图标块语言，两块面板并排才不打架 */}
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-400">
          <ListTodo className="h-3.5 w-3.5" />
        </span>
        <h3 className="shrink-0 text-[13px] font-semibold text-foreground">
          计划 · {relativeDayLabel(anchorMs)}
        </h3>
        {/* V80：原来是一枚「未完成 N · 共 M」胶囊，和标题、按钮挤在一行读起来很乱；
            收成 2/7 这样的窄计数，信息不丢，横向压力也没了 */}
        <span
          className="shrink-0 text-[11px] tabular-nums text-muted-foreground/80"
          title={`未完成 ${pendingInScope} 条 · 共 ${visible.length} 条`}
        >
          {pendingInScope}/{visible.length}
        </span>
        <button
          type="button"
          onClick={() => onHideDoneChange(!hideDone)}
          className={cn(
            'ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition',
            hideDone
              ? 'bg-brand-muted text-brand'
              : 'text-muted-foreground/70 hover:bg-accent hover:text-foreground',
          )}
          title={hideDone ? '显示已完成的条目' : '隐藏已完成的条目'}
          aria-label={hideDone ? '显示已完成的条目' : '隐藏已完成的条目'}
        >
          {hideDone ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </header>

      {/* 范围切换：改成**分段控件**（浅槽 + 品牌色滑块），与纪念日表单里的
          「类型 / 历法」同一套语言 —— 之前是几个散着的文字按钮，看不出是「一组」 */}
      <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/45 p-0.5">
        {SCOPE_ORDER.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onScopeChange(item)}
            className={cn(
              'flex-1 rounded-[6px] px-1.5 py-1 text-[11px] transition',
              scope === item
                ? 'bg-background font-medium text-brand shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item === 'day' ? relativeDayLabel(anchorMs) : SCOPE_LABELS[item]}
          </button>
        ))}
      </div>

      {/* 新增：输入框与按钮同一高度（h-8），一行内不再高低不齐 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              handleAdd();
            }
          }}
          placeholder={addHint}
          title={addHintTitle}
          className="h-8 text-[12px]"
          aria-label="新增事件"
        />
        <Button size="sm" className="h-8 shrink-0 px-2.5 text-xs" onClick={handleAdd}>
          <Plus className="h-3.5 w-3.5" />
          添加
        </Button>
      </div>

      {/* 列表：行间用 1px 分隔线（不靠卡片边框），每行结构、行高一致 */}
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col divide-y divide-border/40 overflow-y-auto pr-0.5">
        {visible.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border py-10 text-center">
            <ListTodo className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">这个范围还没有条目</p>
            <p className="text-[11px] text-muted-foreground/70">在上方输入框写一条，回车即入</p>
          </div>
        ) : (
          <>
            {pendingRows.length > 0 ? (
              pendingRows.map(renderRow)
            ) : (
              <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                这个范围的未完成项都清空了
              </p>
            )}

            {doneRows.length > 0 ? (
              <>
                {/* 分组标签：与列表行同高节奏（24px），不再用 mt/pt 硬凑间距 */}
                <div className="flex h-7 shrink-0 items-center gap-2 px-2">
                  <span className="text-[10px] tracking-wide text-muted-foreground/70">
                    已完成 {doneRows.length}
                  </span>
                  <span className="h-px flex-1 bg-border/70" />
                </div>
                {doneRows.map(renderRow)}
              </>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/** 单条待办：正文行（整行可点） + 展开编辑区（正文 / 优先级 / 日期） */
function TodoRow({
  todo,
  showSchedule,
  expanded,
  onToggleExpand,
  onToggleDone,
  onDelete,
  onPatch,
}: {
  todo: Todo;
  /** 是否显示排期徽标（当日范围不显示，避免逐条重复「今天」） */
  showSchedule: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleDone: () => void;
  onDelete: () => void;
  onPatch: (next: TodoPatch) => void;
}): React.JSX.Element {
  const priority = priorityStyle(todo.priority);
  /**
   * 正文（V79）：**不再分「标题 / 说明」两级** —— 用户原话「待办就不需要标题了，
   * 全部都是正文」。两段内容合并成一段纯文本，同字号、同颜色读下来，列表才像
   * 一页清单；存储层不动（首行仍落 `title`、其余落 `detail`），主窗待办清单不受影响。
   */
  const body: string = useMemo(() => {
    const head = stripMarkdown(todo.title).trim();
    const rest = stripMarkdown(todo.detail).trim();
    return [head, rest].filter((part: string): boolean => part !== '').join('\n');
  }, [todo.title, todo.detail]);

  /** 编辑区同一口径的源文本（不剥 Markdown，保留用户原始写法） */
  const bodySource: string = todo.detail.trim() === '' ? todo.title : `${todo.title}\n${todo.detail}`;
  /** 写回：首行 → title，其余 → detail */
  const onBodyChange = (next: string): void => {
    const cut = next.indexOf('\n');
    if (cut < 0) {
      onPatch({ title: next, detail: '' });
      return;
    }
    onPatch({ title: next.slice(0, cut), detail: next.slice(cut + 1) });
  };


  /** 排期徽标（V77）：逾期 N 天 / 今天 / 明天 / 10月28日，不再显示无意义的「09:00」 */
  const schedule = scheduleLabel(todo);
  const overdueDayCount = overdueDays(todo);
  const overdue = overdueDayCount > 0 && !todo.done;
  const showBadge = schedule !== null && (overdue || showSchedule);

  /**
   * 优先级 → 行首 2px 细条颜色（V80）。
   * 之前优先级是「重要 / 紧急」文字徽标，有徽标的行和没徽标的行宽度不一样，
   * 一列待办看下来左右缘全是锯齿 —— 改成**不占位的色条**：结构完全一致，
   * 优先级照样一眼可见。
   */
  const priorityAccent =
    todo.done || todo.priority < 2
      ? 'bg-transparent'
      : todo.priority >= 3
        ? 'bg-rose-500/80'
        : 'bg-amber-400/80';

  const badgeText = showBadge && schedule !== null ? schedule : '';

  return (
    <div
      className={cn(
        // V80 统一行高：每一行都是 h-11（44px），正文最多两行 line-clamp —— 之前正文
        // 不限高，三行、五行、一行的条目混在一列里，用户直评「看着都不平衡均匀」。
        'transition',
        expanded ? 'bg-brand-muted/25' : todo.done ? 'hover:bg-muted/30' : 'hover:bg-accent/40',
      )}
    >
      {/* 摘要行：点任意位置都能展开（用户反馈「必须点前面圆圈才行」） */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleExpand();
          }
        }}
        className="group relative flex h-11 cursor-pointer items-center gap-2.5 px-2"
      >
        <span
          aria-hidden
          title={`优先级：${priority.name}`}
          className={cn('absolute inset-y-2 left-0 w-[2px] rounded-r-full', priorityAccent)}
        />
        <button
          type="button"
          aria-label={todo.done ? '标记未完成' : '标记完成'}
          onClick={(event) => {
            // 只勾完成，不触发展开
            event.stopPropagation();
            onToggleDone();
          }}
          className={cn(
            'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 transition',
            todo.done
              ? 'border-emerald-500 bg-emerald-500'
              : 'border-muted-foreground/50 hover:border-emerald-600',
          )}
        >
          {todo.done ? (
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 text-white">
              <path
                d="M2 6.2L4.6 8.8L10 3.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
        </button>

        {/*
          * 正文区（V79/V80）：只有一个文本块，两行封顶 —— 合并「标题 + 说明」后
          * 内容可以很长，收起态无论如何只占两行，行高才整齐；全文展开后编辑。
          */}
        {expanded ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/60">
            编辑中
          </span>
        ) : (
          <p
            title={body === '' ? undefined : body}
            className={cn(
              'line-clamp-2 min-w-0 flex-1 whitespace-pre-line text-[13px] leading-[1.4]',
              todo.done ? 'text-muted-foreground line-through opacity-70' : 'text-foreground',
            )}
          >
            {body === '' ? '未命名' : body}
          </p>
        )}

        {/* 固定宽度的排期列：**有没有徽标都占同一格**，正文右缘才对得齐 */}
        <span
          className={cn(
            'w-[62px] shrink-0 truncate text-right text-[10px] tabular-nums',
            badgeText === '' ? 'invisible' : '',
            overdue ? 'font-medium text-destructive' : 'text-muted-foreground/70',
          )}
          title={
            todo.dueAt === null || badgeText === ''
              ? undefined
              : overdue
                ? `到期日 ${dayLabel(todo.dueAt)}，已经逾期 ${overdueDayCount} 天`
                : `到期日 ${dayLabel(todo.dueAt)}`
          }
        >
          {badgeText === '' ? '—' : badgeText}
        </span>

        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition',
            // 默认隐身但**始终占位**（右缘不因悬停跳动），悬停 / 展开才露出来
            'opacity-0 group-hover:opacity-100',
            expanded && 'rotate-180 opacity-100',
          )}
        />
      </div>

      {/* 展开编辑区 */}
      {expanded && (
        <div className="space-y-2 border-t border-brand/20 px-2.5 py-2">
          {/* 正文（V79）：合并成一个输入框 —— 首行仍是「一句话主题」，换行继续写就是
              原来的说明；不再给「名称 / 说明」两个标签，也不再有重复的标题。 */}
          <div>
            <span className="mb-1 block text-[10px] text-muted-foreground">正文</span>
            <RichMarkdown
              value={bodySource}
              onChange={onBodyChange}
              placeholder="写下要做什么，换行继续补充细节…"
              className="md-compact min-h-[64px] rounded-lg border border-border bg-background px-2.5 py-1.5"
              ariaLabel="正文"
            />
          </div>

          {/* 操作条：优先级一行、日期一行（V75）
              原来是单行 flex-wrap，面板一窄就乱换行，「优先级」标签甚至会被甩到下一行。
              拆成两行固定结构后，两块永远各占一行，视觉上可预期。 */}
          <div className="space-y-1.5 rounded-lg bg-muted/40 px-2 py-1.5">
            <div className="flex items-center gap-1">
              <span className="w-8 shrink-0 text-[10px] text-muted-foreground">优先级</span>
              {TODO_PRIORITIES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onPatch({ priority: item.id })}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[11px] transition',
                    todo.priority === item.id
                      ? item.className
                      : 'text-muted-foreground hover:bg-background hover:text-foreground',
                  )}
                >
                  {item.name}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1">
              <span className="w-8 shrink-0 text-[10px] text-muted-foreground">日期</span>
              <button
                type="button"
                onClick={() => onPatch({ dueAt: startOfDay(Date.now()) + 9 * 3600_000 })}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-background hover:text-foreground"
              >
                今天
              </button>
              <button
                type="button"
                onClick={() => onPatch({ dueAt: startOfDay(Date.now()) + 86_400_000 + 9 * 3600_000 })}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-background hover:text-foreground"
              >
                明天
              </button>
              <button
                type="button"
                onClick={() => onPatch({ dueAt: null })}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px] transition',
                  todo.dueAt === null
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:bg-background hover:text-foreground',
                )}
              >
                无日期
              </button>
              <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                当前 {todo.dueAt === null ? '无日期' : relativeDayLabel(todo.dueAt)}
              </span>
              <button
                type="button"
                onClick={onDelete}
                className="rounded p-1 text-muted-foreground transition hover:bg-background hover:text-destructive"
                aria-label={`删除 ${todo.title}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PlanPanel;
