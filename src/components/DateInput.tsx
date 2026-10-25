import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * 分段式日期输入（V76）。
 *
 * # 为什么要自己写
 *
 * 原生 `<input type="date">` 有两个绕不开的毛病：
 *
 * 1. **显示格式跟系统 locale 走** —— 中文 Windows 上常见 `yyyy/mm/dd` + 日历图标，
 *    和界面里其他地方的 `2025-10-12` 不是一个口径；
 * 2. **年段不受控** —— 可以手输 `200200`，也不会自动跳段，用户得反复点鼠标。
 *
 * 这个组件把日期拆成「年 / 月 / 日」三段：
 * - 年输满 4 位自动跳月，月 / 日输满 2 位自动跳日；
 * - 月首字符 ≥ 2（如 `9`）自动补成 `09` 并跳段，少按一次键；
 * - Backspace 在空段回退到上一段；↑ / ↓ 直接增减当前段；
 * - 年份钳制在 `minYear..maxYear`，月 1..12、日按当月天数收口，输不出非法值。
 */
export interface DateInputProps {
  /** `YYYY-MM-DD`；空串 = 未填写 */
  value: string;
  /** 三段都填完且合法时才回调完整日期，中途回调空串 */
  onChange: (value: string) => void;
  /** 年份下限（默认 1900） */
  minYear?: number;
  /** 年份上限（默认 2100） */
  maxYear?: number;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

/** 某年某月的天数 */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** `YYYY-MM-DD` → 三段字符串 */
function splitValue(value: string): { y: string; m: string; d: string } {
  const [y = '', m = '', d = ''] = value.split('-');
  return { y, m, d };
}

export function DateInput({
  value,
  onChange,
  minYear = 1900,
  maxYear = 2100,
  disabled = false,
  className,
  ariaLabel,
}: DateInputProps): React.JSX.Element {
  const initial = splitValue(value);
  const [year, setYear] = useState(initial.y);
  const [month, setMonth] = useState(initial.m);
  const [day, setDay] = useState(initial.d);

  const yearRef = useRef<HTMLInputElement>(null);
  const monthRef = useRef<HTMLInputElement>(null);
  const dayRef = useRef<HTMLInputElement>(null);
  /** 三段的「最新」快照：effect 里不能读闭包旧值，否则回声判断永远失败 */
  const segRef = useRef({ y: initial.y, m: initial.m, d: initial.d });
  segRef.current = { y: year, m: month, d: day };

  // 外部值变化（如「用今天」）同步进三段；空串不覆盖，避免打断正在输入的用户
  useEffect(() => {
    if (value === '') {
      return;
    }
    /*
     * V78 关键修复：**回声不要回写**。
     *
     * `emit()` 会把 `1990-5-2` 补零成 `1990-05-02` 交给父级，父级再作为 `value`
     * 传回来；effect 若无条件 `setDay('02')`，「日」段就被提前补成两位 ——
     * 用户接着打 `7` 得到 `027`，再被 slice(0,2) 截成 `02`，于是「输 27 变 02、
     * 7 根本打不进去」。这里按**数值**比较（`2` == `02`）识别回声并跳过。
     */
    const seg = segRef.current;
    const next = splitValue(value);
    if (
      Number(next.y) === Number(seg.y) &&
      Number(next.m) === Number(seg.m) &&
      Number(next.d) === Number(seg.d)
    ) {
      return;
    }
    setYear(next.y);
    setMonth(next.m);
    setDay(next.d);
  }, [value]);

  const composed = useMemo(() => {
    if (year.length !== 4 || month.length === 0 || day.length === 0) {
      return '';
    }
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }, [year, month, day]);

  /** 三段解析 + 合法性（用于红边提示与回调） */
  const parsed = useMemo(() => {
    if (year.length !== 4) {
      return { complete: false, valid: false } as const;
    }
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (!Number.isFinite(m) || !Number.isFinite(d) || m < 1 || d < 1) {
      return { complete: false, valid: false } as const;
    }
    const complete = month.length > 0 && day.length > 0;
    const valid =
      complete && y >= minYear && y <= maxYear && m <= 12 && d <= daysInMonth(y, m);
    return { complete, valid } as const;
  }, [year, month, day, minYear, maxYear]);

  /** 变更 → 同步父级（合法完整才给全值，否则给空串） */
  const emit = (next: { y: string; m: string; d: string }): void => {
    const y = Number(next.y);
    const m = Number(next.m);
    const d = Number(next.d);
    const complete = next.y.length === 4 && next.m !== '' && next.d !== '';
    const valid =
      complete &&
      y >= minYear &&
      y <= maxYear &&
      m >= 1 &&
      m <= 12 &&
      d >= 1 &&
      d <= daysInMonth(y, m);
    const full = `${next.y}-${next.m.padStart(2, '0')}-${next.d.padStart(2, '0')}`;
    onChange(valid ? full : '');
  };

  const digits = (text: string, max: number): string =>
    text.replace(/\D/g, '').slice(0, max);

  const updateYear = (raw: string): void => {
    const next = digits(raw, 4);
    setYear(next);
    emit({ y: next, m: month, d: day });
    if (next.length === 4) {
      monthRef.current?.focus();
    }
  };

  const updateMonth = (raw: string): void => {
    let next = digits(raw, 2);
    // 「9」这类单位数且不可能做十位（>1）→ 直接补零跳段
    if (next.length === 1 && Number(next) > 1) {
      next = `0${next}`;
    }
    setMonth(next);
    emit({ y: year, m: next, d: day });
    if (next.length === 2) {
      dayRef.current?.focus();
    }
  };

  const updateDay = (raw: string): void => {
    let next = digits(raw, 2);
    if (next.length === 1 && Number(next) > 3) {
      next = `0${next}`;
    }
    setDay(next);
    emit({ y: year, m: month, d: next });
  };

  /** 失焦收口：年份钳制、月日补零并夹到合法范围 */
  const clampOnBlur = (): void => {
    let y = Number(year);
    let m = Number(month);
    let d = Number(day);
    let changed = false;
    if (year.length === 4 && (y < minYear || y > maxYear)) {
      y = Math.min(maxYear, Math.max(minYear, y));
      changed = true;
    }
    if (month !== '' && (m < 1 || m > 12 || Number.isNaN(m))) {
      m = Math.min(12, Math.max(1, Number.isFinite(m) ? m : 1));
      changed = true;
    }
    if (day !== '' && y >= minYear && m >= 1 && m <= 12) {
      const max = daysInMonth(y, m);
      if (d < 1 || d > max || Number.isNaN(d)) {
        d = Math.min(max, Math.max(1, Number.isFinite(d) ? d : 1));
        changed = true;
      }
    }
    if (changed) {
      const nextY = year.length === 4 ? String(y) : year;
      const nextM = month !== '' ? String(m).padStart(2, '0') : month;
      const nextD = day !== '' ? String(d).padStart(2, '0') : day;
      setYear(nextY);
      setMonth(nextM);
      setDay(nextD);
      emit({ y: nextY, m: nextM, d: nextD });
    }
  };

  /** 方向键：↑ / ↓ 增减当前段 */
  const step = (
    event: React.KeyboardEvent<HTMLInputElement>,
    segment: 'y' | 'm' | 'd',
  ): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? 1 : -1;
    if (segment === 'y') {
      const base = year === '' ? minYear : Number(year);
      const y = Math.min(maxYear, Math.max(minYear, base + delta));
      updateYear(String(y));
    } else if (segment === 'm') {
      const base = month === '' ? 1 : Number(month);
      let m = base + delta;
      if (m < 1) m = 12;
      if (m > 12) m = 1;
      setMonth(String(m).padStart(2, '0'));
      emit({ y: year, m: String(m).padStart(2, '0'), d: day });
    } else {
      const base = day === '' ? 1 : Number(day);
      const max = year.length === 4 && month !== '' ? daysInMonth(Number(year), Number(month)) : 31;
      let d = base + delta;
      if (d < 1) d = max;
      if (d > max) d = 1;
      setDay(String(d).padStart(2, '0'));
      emit({ y: year, m: month, d: String(d).padStart(2, '0') });
    }
  };

  /** 空段退格 → 回上一段 */
  const backspace = (
    event: React.KeyboardEvent<HTMLInputElement>,
    current: string,
    prev: React.RefObject<HTMLInputElement> | null,
  ): void => {
    if (event.key === 'Backspace' && current === '' && prev !== null) {
      event.preventDefault();
      prev.current?.focus();
    }
  };

  const segmentClass =
    'bg-transparent text-center tabular-nums text-foreground outline-none placeholder:text-muted-foreground/45 disabled:cursor-not-allowed';

  return (
    <div
      className={cn(
        'flex h-7 items-center gap-0.5 rounded-md border border-input bg-background px-2 text-xs transition',
        'focus-within:border-brand/60 focus-within:ring-1 focus-within:ring-brand/30',
        parsed.complete && !parsed.valid && 'border-destructive/60 text-destructive',
        disabled && 'opacity-60',
        className,
      )}
      aria-label={ariaLabel}
    >
      <input
        ref={yearRef}
        value={year}
        onChange={(event) => updateYear(event.target.value)}
        onBlur={clampOnBlur}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && event.currentTarget.selectionStart === year.length) {
            monthRef.current?.focus();
          }
          step(event, 'y');
        }}
        onFocus={(event) => event.currentTarget.select()}
        inputMode="numeric"
        placeholder="YYYY"
        disabled={disabled}
        aria-label="年"
        className={cn(segmentClass, 'w-[4ch] flex-none')}
      />
      <span className="select-none text-muted-foreground/35">-</span>
      <input
        ref={monthRef}
        value={month}
        onChange={(event) => updateMonth(event.target.value)}
        onBlur={clampOnBlur}
        onKeyDown={(event) => {
          backspace(event, month, yearRef);
          step(event, 'm');
        }}
        onFocus={(event) => event.currentTarget.select()}
        inputMode="numeric"
        placeholder="MM"
        disabled={disabled}
        aria-label="月"
        className={cn(segmentClass, 'w-[2ch] flex-none')}
      />
      <span className="select-none text-muted-foreground/35">-</span>
      <input
        ref={dayRef}
        value={day}
        onChange={(event) => updateDay(event.target.value)}
        onBlur={clampOnBlur}
        onKeyDown={(event) => {
          backspace(event, day, monthRef);
          step(event, 'd');
        }}
        onFocus={(event) => event.currentTarget.select()}
        inputMode="numeric"
        placeholder="DD"
        disabled={disabled}
        aria-label="日"
        className={cn(segmentClass, 'w-[2ch] flex-none')}
      />
    </div>
  );
}

export default DateInput;
