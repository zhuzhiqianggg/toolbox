import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  Cake,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Gift,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/useAppStore';
import { dayInfo, ganZhi, type DayInfo } from '@/lib/lunar';
import { HOLIDAY_LATEST_YEAR, holidayOf, upcomingHolidays } from '@/lib/holidays';
import type { Anniversary } from '@/core/types';
import {
  ANNIVERSARY_KINDS,
  anniversariesOf,
  newAnniversaryId,
  toDateKey,
  yearsSince,
} from '@/lib/anniversaries';
import { buildMonthGrid, dayLabel, isSameDay, startOfDay } from './planUtils';

/**
 * 工作台月历面板（V21 增强）。
 *
 * # 用户反馈
 *
 * 「既然这样我们日历里面最好可以添加农历、节假日等内容，工作日、休息日等都可以清晰展示
 *   出来就更好了，类似中华万年历那样，也可以添加生日等记录用户自己的一些日历。」
 *
 * # 这一版加了什么
 *
 * 1. **农历**：每个格子第二行显示农历日（初一显示月名），传统节日红色高亮；
 * 2. **节气**：24 节气当天用青色显示节气名（立春 / 清明 / 冬至…）；
 * 3. **法定节假日 / 调休**：放假日打红色「休」角标，调休上班日打灰蓝「班」角标，
 *    数据来自 `@/lib/holidays`（国务院办公厅公布口径）；
 * 4. **纪念日**：生日 / 纪念日可自行添加，按「每年重复」或「仅此一次」匹配，
 *    格子上打一个小图标，下方提供增删面板；
 * 5. **下一个假期**：面板底部直接告诉你「下次放假还有几天」。
 *
 * 布局仍是「零第三方日历库」：42 格固定网格 + 本地日期工具（planUtils）+
 * 纯函数农历引擎（`@/lib/lunar`），行为可预测、开销极小。
 */

export interface CalendarPanelProps {
  /** 当前选中的日期（本地零点毫秒） */
  anchorMs: number;
  /** 选中某天 */
  onSelect: (dayMs: number) => void;
  /** 每天的未完成待办数（键为当天零点毫秒） */
  pendingByDay: ReadonlyMap<number, number>;
}

/** 星期表头（周一开始，与 startOfWeek 一致） */
const WEEKDAY_HEADERS: readonly string[] = ['一', '二', '三', '四', '五', '六', '日'];

export function CalendarPanel({ anchorMs, onSelect, pendingByDay }: CalendarPanelProps): React.JSX.Element {
  const anchorDate = useMemo(() => new Date(anchorMs), [anchorMs]);
  /** 当前展示的月份（与选中日期解耦，允许翻月浏览后仍保留选中） */
  const [view, setView] = useState<{ year: number; month: number }>(() => ({
    year: anchorDate.getFullYear(),
    month: anchorDate.getMonth(),
  }));

  const anniversaries = useAppStore((state) => state.settings.anniversaries);
  const updateSettings = useAppStore((state) => state.updateSettings);

  /** 纪念日管理面板展开态 + 新增表单 */
  const [showAnniversaries, setShowAnniversaries] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftDate, setDraftDate] = useState('');
  const [draftYearly, setDraftYearly] = useState(true);
  const [draftKind, setDraftKind] = useState<Anniversary['kind']>('birthday');

  // 选中日期跨月（例如点「回到今天」或从别处跳转）时，视图月份跟随
  useEffect(() => {
    setView({ year: anchorDate.getFullYear(), month: anchorDate.getMonth() });
  }, [anchorDate]);

  const cells = useMemo(() => buildMonthGrid(view.year, view.month), [view]);
  const todayMs = startOfDay(Date.now());

  /** 每格的农历 / 节气 / 节假日信息：一次算完，避免渲染里重复推导 */
  const dayMeta = useMemo(() => {
    const map = new Map<number, { info: DayInfo; kind: string; name: string | null }>();
    for (const dayMs of cells) {
      const d = new Date(dayMs);
      const info = dayInfo(d.getFullYear(), d.getMonth() + 1, d.getDate());
      const holiday = holidayOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
      map.set(dayMs, { info, kind: holiday.kind, name: holiday.name });
    }
    return map;
  }, [cells]);

  const nextHolidays = useMemo(() => upcomingHolidays(Date.now(), 1), []);

  const shiftMonth = (delta: number): void => {
    setView((prev) => {
      const d = new Date(prev.year, prev.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };

  /** 新增纪念日：日期缺省用当前选中那天 */
  const addAnniversary = (): void => {
    const label = draftLabel.trim();
    if (label === '') {
      return;
    }
    const fallback = new Date(anchorMs);
    const date = draftDate !== '' ? draftDate : toDateKey(fallback.getFullYear(), fallback.getMonth() + 1, fallback.getDate());
    const next: Anniversary = {
      id: newAnniversaryId(),
      label,
      date,
      yearly: draftYearly,
      kind: draftKind,
    };
    void updateSettings({ anniversaries: [...anniversaries, next] }).catch(() => undefined);
    setDraftLabel('');
  };

  const removeAnniversary = (id: string): void => {
    void updateSettings({
      anniversaries: anniversaries.filter((item) => item.id !== id),
    }).catch(() => undefined);
  };

  const gz = ganZhi(view.year);

  return (
    <section className="scrollbar-thin flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-panel lg:h-full lg:min-h-0 lg:overflow-y-auto">
      <header className="flex shrink-0 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-muted text-brand">
          <CalendarDays className="h-4 w-4" />
        </span>
        <h3 className="text-sm font-semibold tabular-nums text-foreground">
          {view.year} 年 {view.month + 1} 月
        </h3>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {gz.ganZhi}年 · 属{gz.zodiac}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => shiftMonth(-1)} aria-label="上个月">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => onSelect(todayMs)}
          >
            今天
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => shiftMonth(1)} aria-label="下个月">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
        {WEEKDAY_HEADERS.map((label) => (
          <span key={label} className="py-0.5">
            {label}
          </span>
        ))}
      </div>

      {/*
        * 42 格固定网格：每格两行（公历日 / 农历+休班），行高固定保证翻月不跳动。
        *
        * ⚠️ V23：`flex-1` 只在 `lg`（两栏并排）下加。
        * 窄窗口下这里是单栏，面板高度由内容决定；此时若还挂 `flex-1`
        * （`flex-basis: 0%`），浏览器会把 6 行日历压进「剩余高度」里，
        * 结果就是**月末两周被裁掉**（V23 无头实测在 680px 宽复现：日历只显示到 20 号）。
        */}
      <div className="grid grid-cols-7 gap-1 lg:flex-1">
        {cells.map((dayMs) => {
          const date = new Date(dayMs);
          const inMonth = date.getMonth() === view.month && date.getFullYear() === view.year;
          const isToday = dayMs === todayMs;
          const isSelected = isSameDay(dayMs, anchorMs);
          const pending = pendingByDay.get(dayMs) ?? 0;
          const meta = dayMeta.get(dayMs);
          const marks = anniversariesOf(anniversaries, dayMs);
          const holidayKind = meta?.kind ?? 'workday';
          const isOff = holidayKind === 'holiday';
          const isMakeup = holidayKind === 'makeup';
          const festival = meta?.info.lunarFestival ?? null;
          const term = meta?.info.term ?? null;

          const tooltip = [
            dayLabel(dayMs),
            meta?.info.lunar ? `农历${meta.info.lunar.monthName}${meta.info.lunar.dayName}` : null,
            meta?.name ?? null,
            term,
            marks.length > 0 ? `纪念日：${marks.map((item) => item.label).join('、')}` : null,
            pending > 0 ? `${pending} 项未完成` : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' · ');

          return (
            <button
              key={dayMs}
              type="button"
              onClick={() => onSelect(dayMs)}
              title={tooltip}
              className={cn(
                'group relative flex flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 py-1 transition',
                inMonth ? 'text-foreground' : 'text-muted-foreground/45',
                !isSelected && 'hover:bg-accent',
                isSelected && 'bg-brand text-brand-foreground',
                isToday && !isSelected && 'ring-1 ring-inset ring-brand/50',
                isOff && !isSelected && !isToday && 'bg-destructive/[0.07]',
              )}
            >
              {/* 第一行：公历日 + 待办数 */}
              <span className="flex w-full items-baseline justify-center gap-0.5 leading-none">
                <span
                  className={cn(
                    'tabular-nums text-xs font-medium',
                    isOff && !isSelected && 'text-destructive',
                  )}
                >
                  {date.getDate()}
                </span>
                {pending > 0 ? (
                  <span
                    className={cn(
                      'text-[9px] leading-none',
                      isSelected ? 'text-brand-foreground/90' : 'text-brand',
                    )}
                  >
                    ●{pending}
                  </span>
                ) : null}
              </span>

              {/* 第二行：农历 / 节气 / 节日（节日与节气配色区分） */}
              <span
                className={cn(
                  'w-full truncate text-center text-[9px] leading-none',
                  isSelected
                    ? 'text-brand-foreground/85'
                    : festival !== null
                      ? 'font-medium text-destructive'
                      : term !== null
                        ? 'font-medium text-sky-600'
                        : 'text-muted-foreground/80',
                )}
              >
                {meta?.info.badge ?? ''}
              </span>

              {/* 角标：休 / 班 / 纪念日 */}
              {isOff || isMakeup || marks.length > 0 ? (
                <span className="absolute right-0.5 top-0.5 flex items-center gap-0.5">
                  {marks.length > 0 ? (
                    <Cake className={cn('h-2.5 w-2.5', isSelected ? 'text-brand-foreground/80' : 'text-pink-500')} />
                  ) : null}
                  {isOff ? (
                    <span className="rounded bg-destructive/15 px-0.5 text-[8px] leading-[10px] text-destructive">
                      休
                    </span>
                  ) : null}
                  {isMakeup ? (
                    <span className="rounded bg-muted px-0.5 text-[8px] leading-[10px] text-muted-foreground">
                      班
                    </span>
                  ) : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* 图例 + 下一个假期 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="rounded bg-destructive/15 px-1 text-destructive">休</span>放假
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="rounded bg-muted px-1">班</span>调休上班
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="font-medium text-destructive">红字</span>节日
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="font-medium text-sky-600">青字</span>节气
        </span>
        <span className="inline-flex items-center gap-1">
          <Cake className="h-2.5 w-2.5 text-pink-500" />
          纪念日
        </span>
        {nextHolidays.length > 0 ? (
          <span className="ml-auto text-muted-foreground/80">
            下一个假期：
            {nextHolidays[0]!.inDays === 0
              ? `正在放「${nextHolidays[0]!.name}」`
              : `${nextHolidays[0]!.name}（${nextHolidays[0]!.inDays} 天后 · ${nextHolidays[0]!.days} 天）`}
          </span>
        ) : null}
      </div>

      {/* 纪念日管理 */}
      <div className="rounded-lg border border-border">
        <button
          type="button"
          onClick={() => setShowAnniversaries((prev) => !prev)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition hover:bg-accent/50"
        >
          <Gift className="h-3 w-3" />
          <span className="font-medium text-foreground">纪念日</span>
          <span>{anniversaries.length > 0 ? `${anniversaries.length} 条` : '还没有，可添加生日 / 纪念日'}</span>
          <ChevronDown
            className={cn('ml-auto h-3 w-3 transition', showAnniversaries && 'rotate-180')}
          />
        </button>

        {showAnniversaries ? (
          <div className="space-y-2 border-t border-border p-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-[10px] text-muted-foreground">
                名称
                <input
                  value={draftLabel}
                  onChange={(event) => setDraftLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      addAnniversary();
                    }
                  }}
                  placeholder="如：妈妈生日"
                  className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                日期
                <input
                  type="date"
                  value={draftDate}
                  onChange={(event) => setDraftDate(event.target.value)}
                  className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                />
              </label>
              <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                类型
                <select
                  value={draftKind}
                  onChange={(event) => setDraftKind(event.target.value as Anniversary['kind'])}
                  className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none"
                >
                  {ANNIVERSARY_KINDS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex h-7 items-center gap-1 text-[10px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={draftYearly}
                  onChange={(event) => setDraftYearly(event.target.checked)}
                />
                每年重复
              </label>
              <Button size="sm" className="h-7 px-2.5 text-xs" onClick={addAnniversary}>
                <Plus className="h-3.5 w-3.5" />
                添加
              </Button>
            </div>

            {anniversaries.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                日期留空 = 用当前选中的那一天。勾「每年重复」后按「月-日」每年提醒（生日 / 结婚纪念日）。
              </p>
            ) : (
              <ul className="space-y-1">
                {anniversaries.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-md border border-border/70 px-2 py-1 text-[11px]"
                  >
                    <Cake className="h-3 w-3 shrink-0 text-pink-500" />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.label}</span>
                    <span className="tabular-nums text-muted-foreground">{item.date}</span>
                    {item.yearly ? (
                      <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                        第 {yearsSince(item, new Date().getFullYear())} 年
                      </span>
                    ) : (
                      <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">单次</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeAnniversary(item.id)}
                      title="删除"
                      className="rounded p-0.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[10px] text-muted-foreground/70">
              节假日数据收录至 {HOLIDAY_LATEST_YEAR} 年（国务院办公厅公布口径），后续年份可在
              `src/lib/holidays.ts` 追加。
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default CalendarPanel;
