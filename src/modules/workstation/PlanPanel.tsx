import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ListTodo, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { MdText } from '@/components/MdText';
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
      anchorMs={anchorMs}
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
        {/* 与日历面板同一套「柔色底 + 同色字」图标块语言，两块面板并排才不打架
            （V75：原来是 emerald-100 实底，和日历的 brand-muted 轻重不一致） */}
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-400">
          <ListTodo className="h-4 w-4" />
        </span>
        <h3 className="shrink-0 text-sm font-semibold text-foreground">
          计划 · {relativeDayLabel(anchorMs)}
        </h3>
        <span
          className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground"
          title={`未完成 ${pendingInScope} 条 · 共 ${visible.length} 条`}
        >
          未完成 {pendingInScope} · 共 {visible.length}
        </span>
        <button
          type="button"
          onClick={() => onHideDoneChange(!hideDone)}
          className={cn(
            'ml-auto shrink-0 rounded-md px-2 py-1 text-xs transition',
            hideDone
              ? 'bg-brand-muted text-brand'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
          title={hideDone ? '显示已完成的条目' : '把已完成的条目折叠起来'}
        >
          {hideDone ? '已隐藏完成项' : '隐藏完成项'}
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

      {/* 新增 */}
      <div className="flex shrink-0 items-center gap-2">
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
          className="h-9 text-[13px]"
          aria-label="新增事件"
        />
        <Button size="sm" className="h-9 shrink-0 px-3" onClick={handleAdd}>
          <Plus className="h-3.5 w-3.5" />
          添加
        </Button>
      </div>

      {/* 列表 */}
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto pr-0.5">
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
                <div className="mt-1 flex shrink-0 items-center gap-2 px-0.5 pt-1">
                  <span className="text-[10px] tracking-wide text-muted-foreground/70">
                    已完成 {doneRows.length}
                  </span>
                  <span className="h-px flex-1 bg-border" />
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

/** 单条待办：摘要行（整行可点） + 展开编辑区（名称 / 说明 / 优先级 / 日期） */
function TodoRow({
  todo,
  anchorMs,
  showSchedule,
  expanded,
  onToggleExpand,
  onToggleDone,
  onDelete,
  onPatch,
}: {
  todo: Todo;
  anchorMs: number;
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
   * 摘要剥掉 Markdown 记号后**整段**展示（V74：不再只取首行 —— 用户明确要
   * 多行内容在收起态也能看到；超出两行由 line-clamp-2 截断）。
   * 之前直接把 `**重点**` 原样显示，列表里全是星号，stripMarkdown 一并解决。
   */
  const summary: string = useMemo(() => stripMarkdown(todo.detail).trim(), [todo.detail]);

  /** 排期徽标（V77）：逾期 N 天 / 今天 / 明天 / 10月28日，不再显示无意义的「09:00」 */
  const schedule = scheduleLabel(todo);
  const overdueDayCount = overdueDays(todo);
  const overdue = overdueDayCount > 0 && !todo.done;
  const showBadge = schedule !== null && (overdue || showSchedule);

  return (
    <div
      className={cn(
        // V78 列表化：原来每条都是一个带边框的小卡片，十条待办就像十个补丁贴在面板上，
        // 用户直评「待办很丑」。改成**无边条目的列表**：靠 1px 分隔线 + 悬停整行高亮，
        // 展开态才上品牌色底，让「列表」读起来是一页清单而不是一堆卡片。
        'border-b border-border/45 transition last:border-b-0',
        expanded
          ? 'border-b-brand/25 bg-brand-muted/25'
          : todo.done
            ? 'hover:bg-muted/30'
            : 'hover:bg-accent/40',
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
        className={cn(
          // V75 密度分层：已完成只留一行标题（信息已收束），未完成标题 + 完整正文。
          // 对齐方式跟着变：单行居中，多行正文顶部对齐（否则小圆圈会飘在正文中间）。
          'group flex cursor-pointer gap-2.5 px-2.5',
          summary !== '' && !todo.done && !expanded ? 'items-start py-1.5' : 'items-center py-1.5',
        )}
      >
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
            summary !== '' && !todo.done && !expanded ? 'mt-[1px]' : '',
            todo.done
              ? 'border-emerald-500 bg-emerald-500'
              : 'border-muted-foreground/40 hover:border-emerald-600',
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
          * 标题区：展开时**不再重复画标题**（V77）——
          * 之前摘要行给自己的标题、编辑器里又给「名称」输入框，同一个标题露两遍，
          * 用户反馈「点击时不需要重复的两个标题」。展开后标题只在下方「名称」里编辑，
          这一行退化成状态条（勾选框 + 排期 + 收起箭头）。
          */}
        {expanded ? (
          <span className="min-w-0 flex-1 truncate text-[11px] leading-none text-muted-foreground/60">
            编辑中
          </span>
        ) : (
          <div className="min-w-0 flex-1 text-[13px] leading-snug">
            <MdText
              source={todo.title}
              inline
              fallback="未命名"
              className={cn(
                todo.done
                  ? '!text-muted-foreground line-through opacity-70'
                  : '!text-foreground',
              )}
            />
            {/* V75 信息密度（用户明确要求）：
                · 已完成 → 只留标题一行，不再铺摘要（一屏能扫更多条）；
                · 未完成 → 正文**完整展示**，不再 line-clamp 截断，一眼读得到计划内容。 */}
            {summary !== '' && !todo.done && (
              <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-muted-foreground/85">
                {summary}
              </p>
            )}
          </div>
        )}

        {/* 优先级在前、时间在后：优先级是「要不要现在看」的信号，比时间更该先被扫到 */}
        {todo.priority > 1 ? (
          <span
            className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', priority.className)}
            title={`优先级：${priority.name}`}
          >
            {priority.name}
          </span>
        ) : null}

        {showBadge ? (
          <span
            className={cn(
              // 排期徽标统一成小胶囊：逾期红底加粗、正常灰底，与日历的休/班徽标同语言
              'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] tabular-nums',
              overdue
                ? 'bg-destructive/10 font-medium text-destructive'
                : 'bg-muted text-muted-foreground',
            )}
            title={
              todo.dueAt === null
                ? ''
                : overdue
                  ? `到期日 ${dayLabel(todo.dueAt)}，已经逾期 ${overdueDayCount} 天`
                  : `到期日 ${dayLabel(todo.dueAt)}`
            }
          >
            {schedule}
          </span>
        ) : null}

        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition',
            // 默认半可见（暗示「这行可以点开」），悬停与展开态全亮
            'opacity-45 group-hover:opacity-100',
            expanded && 'rotate-180 opacity-100',
          )}
        />
      </div>

      {/* 展开编辑区 */}
      {expanded && (
        <div className="space-y-2 border-t border-brand/20 px-2.5 py-2">
          {/* 任务名称 */}
          <div>
            <span className="mb-1 block text-[10px] text-muted-foreground">名称</span>
            <RichMarkdown
              value={todo.title}
              onChange={(next: string) => onPatch({ title: next })}
              placeholder="一句话说清要做什么"
              singleLine
              onEnter={onToggleExpand}
              className="md-compact rounded-lg border border-border bg-background px-2.5 py-1"
              ariaLabel="任务名称"
            />
          </div>

          {/* 任务说明 */}
          <div>
            <span className="mb-1 block text-[10px] text-muted-foreground">说明 · Markdown</span>
            <RichMarkdown
              value={todo.detail}
              onChange={(next: string) => onPatch({ detail: next })}
              placeholder="补充步骤、链接、清单…"
              className="md-compact min-h-[56px] rounded-lg border border-border bg-background px-2.5 py-1.5"
              ariaLabel="任务说明"
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

          {/* 锚点提示：让用户知道这条挂在哪一天 */}
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
            日历当前选中 {relativeDayLabel(anchorMs)}；改日期只影响本条，不动其它条目。
          </p>
        </div>
      )}
    </div>
  );
}

export default PlanPanel;
