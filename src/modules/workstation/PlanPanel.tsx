import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, ChevronDown, ListTodo, Plus, Trash2 } from 'lucide-react';
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
  defaultMomentOfDay,
  dueLabel,
  filterTodos,
  isOverdue,
  relativeDayLabel,
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

/** 取说明的首行（收起态做单行摘要用） */
function firstLineOf(source: string): string {
  const line: string = source.split('\n').find((item: string): boolean => item.trim() !== '') ?? '';
  return line.trim();
}

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
          dueAt === null ? '已添加到「无日期」' : `已添加到 ${relativeDayLabel(anchorMs)} 09:00`,
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
    scope === 'undated' ? '写一条不设日期的事，回车即入' : '写一条计划，回车即入（默认 09:00）';
  const addHintTitle =
    scope === 'undated'
      ? '写一条不设日期的事，回车即入'
      : `写一条并回车，挂到 ${relativeDayLabel(anchorMs)} 09:00`;

  /** 行渲染：未完成与已完成共用同一套行组件，先后顺序由上面的分组决定 */
  const renderRow = (todo: Todo): React.JSX.Element => (
    <TodoRow
      key={todo.id}
      todo={todo}
      anchorMs={anchorMs}
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
    <section className="flex h-full min-h-[260px] flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-panel lg:min-h-0">
      <header className="flex shrink-0 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
          <ListTodo className="h-4 w-4" />
        </span>
        <h3 className="shrink-0 text-sm font-semibold text-foreground">
          计划 · {relativeDayLabel(anchorMs)}
        </h3>
        <span
          className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground"
          title={`未完成 ${pendingInScope} 条 · 共 ${visible.length} 条`}
        >
          未完成 {pendingInScope} · 共 {visible.length}
        </span>
        <button
          type="button"
          onClick={() => onHideDoneChange(!hideDone)}
          className={cn(
            'ml-auto shrink-0 rounded-md px-2 py-1 text-[11px] transition',
            hideDone
              ? 'bg-brand-muted text-brand'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
          title={hideDone ? '显示已完成的条目' : '把已完成的条目折叠起来'}
        >
          {hideDone ? '已隐藏完成项' : '隐藏完成项'}
        </button>
      </header>

      {/* 范围切换 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {SCOPE_ORDER.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onScopeChange(item)}
            className={cn(
              'rounded-md px-2 py-1 text-xs transition',
              scope === item
                ? 'bg-brand-muted font-medium text-brand'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
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
          className="h-9 text-sm"
          aria-label="新增事件"
        />
        <Button size="sm" className="h-9 shrink-0 px-3" onClick={handleAdd}>
          <Plus className="h-3.5 w-3.5" />
          添加
        </Button>
      </div>

      {/* 列表 */}
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
        {visible.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border py-10 text-center">
            <ListTodo className="h-6 w-6 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">这个范围还没有条目</p>
            <p className="text-xs text-muted-foreground/70">在上方输入框写一条，回车即入</p>
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
  expanded,
  onToggleExpand,
  onToggleDone,
  onDelete,
  onPatch,
}: {
  todo: Todo;
  anchorMs: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleDone: () => void;
  onDelete: () => void;
  onPatch: (next: TodoPatch) => void;
}): React.JSX.Element {
  const priority = priorityStyle(todo.priority);
  /** 摘要要剥掉 Markdown 记号：之前直接把 `**重点**` 原样显示，列表里全是星号 */
  const summary: string = useMemo(() => stripMarkdown(firstLineOf(todo.detail)), [todo.detail]);

  return (
    <div
      className={cn(
        // V73 统一行卡片：未完成=浅卡可点，已完成=灰底弱化，展开=品牌色聚焦，
        // 三态同一套圆角/边框/内边距，与日历面板的格子视觉对齐
        'rounded-lg border transition',
        expanded
          ? 'border-brand/40 bg-brand-muted/20'
          : todo.done
            ? 'border-transparent bg-muted/40'
            : 'border-border/60 bg-background/50 hover:border-brand/30 hover:bg-accent/40',
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
        className="group flex cursor-pointer items-center gap-2.5 px-2.5 py-2"
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

        <div className="min-w-0 flex-1">
          <MdText
            source={todo.title}
            inline
            fallback="未命名"
            className={cn(
              'text-[13px] leading-snug',
              todo.done ? 'text-muted-foreground line-through opacity-70' : 'text-foreground',
            )}
          />
          {!expanded && summary !== '' && (
            <p
              className={cn(
                'mt-0.5 truncate text-[11px] text-muted-foreground/80',
                todo.done && 'opacity-60',
              )}
            >
              {summary}
            </p>
          )}
        </div>

        {/* 优先级在前、时间在后：优先级是「要不要现在看」的信号，比时间更该先被扫到 */}
        {todo.priority > 1 ? (
          <span
            className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px]', priority.className)}
            title={`优先级：${priority.name}`}
          >
            {priority.name}
          </span>
        ) : null}

        {todo.dueAt !== null ? (
          <span
            className={cn(
              // 时间统一成小胶囊徽标：逾期红底、正常灰底，与日历的节假日徽标同语言
              'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] tabular-nums',
              isOverdue(todo) ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
            )}
            title={isOverdue(todo) ? `已逾期 · ${dueLabel(todo.dueAt)}` : dueLabel(todo.dueAt)}
          >
            <CalendarClock className="h-3 w-3" />
            {dueLabel(todo.dueAt)}
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
        <div className="space-y-2.5 border-t border-brand/20 px-2.5 py-2.5">
          {/* 任务名称 */}
          <div>
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              任务名称
            </span>
            <RichMarkdown
              value={todo.title}
              onChange={(next: string) => onPatch({ title: next })}
              placeholder="任务名称"
              singleLine
              onEnter={onToggleExpand}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px]"
              ariaLabel="任务名称"
            />
          </div>

          {/* 任务说明 */}
          <div>
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              任务说明 · Markdown 即时渲染
            </span>
            <RichMarkdown
              value={todo.detail}
              onChange={(next: string) => onPatch({ detail: next })}
              placeholder="补充说明：步骤、链接、清单…（**加粗**、- 列表、`代码` 都会立刻渲染）"
              className="min-h-[64px] rounded-lg border border-border bg-background px-2.5 py-2 text-[13px]"
              ariaLabel="任务说明"
            />
          </div>

          {/* 操作条 */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">优先级</span>
            {TODO_PRIORITIES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onPatch({ priority: item.id })}
                className={cn(
                  'rounded-md px-2 py-0.5 text-[11px] transition',
                  todo.priority === item.id
                    ? item.className
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {item.name}
              </button>
            ))}

            <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">日期</span>
            <button
              type="button"
              onClick={() => onPatch({ dueAt: startOfDay(Date.now()) + 9 * 3600_000 })}
              className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
            >
              今天
            </button>
            <button
              type="button"
              onClick={() => onPatch({ dueAt: startOfDay(Date.now()) + 86_400_000 + 9 * 3600_000 })}
              className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
            >
              明天
            </button>
            <button
              type="button"
              onClick={() => onPatch({ dueAt: null })}
              className={cn(
                'rounded-md px-2 py-0.5 text-[11px] transition',
                todo.dueAt === null
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              无日期
            </button>
            <span className="ml-auto text-[11px] text-muted-foreground">
              当前：{todo.dueAt === null ? '无日期' : dueLabel(todo.dueAt)}
            </span>

            <button
              type="button"
              onClick={onDelete}
              className="rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-destructive"
              aria-label={`删除 ${todo.title}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* 锚点提示：让用户知道这条挂在哪一天 */}
          <p className="text-[10px] text-muted-foreground/60">
            日历当前选中 {relativeDayLabel(anchorMs)}；改日期只影响本条，不动其它条目。
          </p>
        </div>
      )}
    </div>
  );
}

export default PlanPanel;
