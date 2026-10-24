import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Clock } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { copyText } from '@/lib/clipboard';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'timestamp';

/** 输入模式：时间戳 → 日期，或 日期 → 时间戳（对齐 ops-tools 参考实现）。 */
type InputMode = 'timestamp' | 'datetime';
/** 时间戳单位。 */
type TsUnit = 'seconds' | 'milliseconds';

/**
 * 相对偏移语法：`+1d` / `-2h` / `+30m` / `+10s` / `+500ms` / `+2w` / `-1M` / `+1y`。
 * 注意大小写：`m` = 分钟、`M` = 月；`w` = 周、`y` = 年。
 */
const RELATIVE_RE = /^[+-]\d+(ms|s|m|h|d|w|M|y)$/;

/** 偏移单位（界面选择器与提示共用）。 */
const OFFSET_UNITS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'ms', label: '毫秒' },
  { id: 's', label: '秒' },
  { id: 'm', label: '分钟' },
  { id: 'h', label: '小时' },
  { id: 'd', label: '天' },
  { id: 'w', label: '周' },
  { id: 'M', label: '月' },
  { id: 'y', label: '年' },
];

interface BatchRow {
  input: string;
  seconds: number;
  milliseconds: number;
  local: string;
  utc: string;
  iso: string;
  relative: string;
  valid: boolean;
}

/**
 * 在指定时区按格式串格式化（en-CA 拿到稳定 2 位分段，再套格式模板）。
 * 格式支持：YYYY / MM / DD / HH / mm / ss。时区无效返回 null。
 */
function formatInZone(ms: number, timeZone: string, fmt: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms));
    const values: Record<string, string> = {};
    for (const part of parts) {
      values[part.type] = part.value;
    }
    return fmt
      .replace('YYYY', values.year ?? '')
      .replace('MM', values.month ?? '')
      .replace('DD', values.day ?? '')
      .replace('HH', values.hour ?? '')
      .replace('mm', values.minute ?? '')
      .replace('ss', values.second ?? '');
  } catch {
    return null;
  }
}

/** 相对时间描述（N秒/分钟/小时/天 前·后）。 */
function relativeTime(ms: number): string {
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) {
    return diffSec >= 0 ? `${diffSec}秒前` : `${abs}秒后`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (Math.abs(diffMin) < 60) {
    return diffMin >= 0 ? `${diffMin}分钟前` : `${-diffMin}分钟后`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (Math.abs(diffHour) < 24) {
    return diffHour >= 0 ? `${diffHour}小时前` : `${-diffHour}小时后`;
  }
  const diffDay = Math.floor(diffHour / 24);
  if (Math.abs(diffDay) < 30) {
    return diffDay >= 0 ? `${diffDay}天前` : `${-diffDay}天后`;
  }
  return '很久以前';
}

/** 指定时区的星期（中文短格式，如「周一」）。 */
function weekdayInZone(ms: number, timeZone: string): string {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'short' }).format(new Date(ms));
  } catch {
    return weekdays[new Date(ms).getDay()] ?? '';
  }
}

/** 拆分偏移标记（`ms` 先于 `m` 匹配，`M` = 月不与会话分钟混淆）。 */
function splitOffset(token: string): { sign: number; value: number; unitTag: string } {
  const sign = token[0] === '-' ? -1 : 1;
  const unitTag = token.match(/(ms|s|m|h|d|w|M|y)$/)?.[0] ?? 's';
  const parsed = Number.parseInt(token.slice(1).replace(/(ms|s|m|h|d|w|M|y)$/, ''), 10);
  return { sign, value: Number.isNaN(parsed) ? 0 : parsed, unitTag };
}

/**
 * 在基准时刻上叠加偏移。
 *
 * 定长单位（ms / s / m / h / d / w）走毫秒加减；日历单位（M 月 / y 年）走
 * `setMonth` / `setFullYear`，对齐「自然月 / 自然年」直觉（各月天数不同也不漂移）。
 */
function addOffset(baseMs: number, signedValue: number, unitTag: string): number {
  switch (unitTag) {
    case 'ms':
      return baseMs + signedValue;
    case 's':
      return baseMs + signedValue * 1000;
    case 'm':
      return baseMs + signedValue * 60_000;
    case 'h':
      return baseMs + signedValue * 3_600_000;
    case 'd':
      return baseMs + signedValue * 86_400_000;
    case 'w':
      return baseMs + signedValue * 7 * 86_400_000;
    case 'M': {
      const d = new Date(baseMs);
      d.setMonth(d.getMonth() + signedValue);
      return d.getTime();
    }
    case 'y': {
      const d = new Date(baseMs);
      d.setFullYear(d.getFullYear() + signedValue);
      return d.getTime();
    }
    default:
      return baseMs;
  }
}

/** 解析相对偏移（如 `-1d`）为「相对当前时刻」的毫秒值。 */
function parseRelative(token: string): number {
  const { sign, value, unitTag } = splitOffset(token);
  return addOffset(Date.now(), sign * value, unitTag);
}

/** 该时刻指定时区相对 UTC 的偏移（毫秒）；把「时区本地时间当 UTC 读」反推。 */
function zoneOffsetMs(ms: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms));
    const pick = (type: string): number =>
      Number(parts.find((part) => part.type === type)?.value ?? '0');
    return (
      Date.UTC(
        pick('year'),
        pick('month') - 1,
        pick('day'),
        pick('hour') % 24,
        pick('minute'),
        pick('second'),
      ) - ms
    );
  } catch {
    return 0;
  }
}

/** 指定时区「当天零点」的毫秒值（夏令时切换日做一次偏移校正）。 */
function startOfDayInZone(ms: number, timeZone: string): number {
  const offset = zoneOffsetMs(ms, timeZone);
  let start = Math.floor((ms + offset) / 86_400_000) * 86_400_000 - offset;
  const refined = zoneOffsetMs(start, timeZone);
  if (refined !== offset) {
    start = Math.floor((ms + refined) / 86_400_000) * 86_400_000 - refined;
  }
  return start;
}

/** 指定时区的自然日索引（1970-01-01 起的天数），用于周 / 月 / 年推算。 */
function dayIndexInZone(ms: number, timeZone: string): number {
  return Math.floor((ms + zoneOffsetMs(ms, timeZone)) / 86_400_000);
}

/** 由「时区本地日索引」反解该日零点毫秒值。 */
function msFromDayIndex(dayIndex: number, timeZone: string): number {
  const guess = dayIndex * 86_400_000;
  return guess - zoneOffsetMs(guess, timeZone);
}

/** 时区本地的年 / 月 / 日。 */
function datePartsInZone(ms: number, timeZone: string): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const pick = (type: string): number =>
      Number(parts.find((part) => part.type === type)?.value ?? '0');
    return { year: pick('year'), month: pick('month'), day: pick('day') };
  } catch {
    const d = new Date(ms);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
}

/** 一周中的第几天（0 = 周日），按指定时区的本地日期计算。 */
function weekdayIndexInZone(ms: number, timeZone: string): number {
  const offset = zoneOffsetMs(ms, timeZone);
  return new Date(Math.floor((ms + offset) / 86_400_000) * 86_400_000).getUTCDay();
}

/**
 * 解析单行输入为时间戳毫秒值。
 * - timestamp 模式：相对偏移 / 10 位秒 / 13 位毫秒 / 其余按所选单位；
 * - datetime 模式：Date.parse 兼容字符串（`/` 归一为 `-`）。
 * 无效返回 null。
 */
function parseLine(raw: string, mode: InputMode, unit: TsUnit): number | null {
  const token = raw.trim();
  if (token.length === 0) {
    return null;
  }
  if (mode === 'timestamp') {
    if (RELATIVE_RE.test(token)) {
      return parseRelative(token);
    }
    if (/^\d{10}$/.test(token)) {
      return Number(token) * 1000;
    }
    if (/^\d{13}$/.test(token)) {
      return Number(token);
    }
    const num = Number.parseInt(token, 10);
    if (Number.isNaN(num)) {
      return null;
    }
    return unit === 'seconds' ? num * 1000 : num;
  }
  const parsed = Date.parse(token.replace(/\//g, '-'));
  return Number.isNaN(parsed) ? null : parsed;
}

/** 固定时区展示集（6 时区，对齐 ops-tools）。 */
const TIME_ZONES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'Asia/Shanghai', label: '北京时间 (UTC+8)' },
  { id: 'UTC', label: 'UTC 时间 (UTC±0)' },
  { id: 'America/New_York', label: '纽约时间 (UTC-5/-4)' },
  { id: 'Europe/London', label: '伦敦时间 (UTC+0/+1)' },
  { id: 'Asia/Tokyo', label: '东京时间 (UTC+9)' },
  { id: 'America/Los_Angeles', label: '洛杉矶时间 (UTC-8/-7)' },
];

/** 输出格式集（6 种，对齐 ops-tools）。 */
const FORMATS: ReadonlyArray<string> = [
  'YYYY-MM-DD HH:mm:ss',
  'YYYY/MM/DD HH:mm:ss',
  'MM/DD/YYYY HH:mm:ss',
  'DD-MM-YYYY HH:mm:ss',
  'YYYY-MM-DD',
  'HH:mm:ss',
];

/** 单条结果报告（多行文本，供 ResultBox / 一键复制）。 */
function toReport(ms: number, timezone: string, fmt: string): string {
  const date = new Date(ms);
  const zoneLines = TIME_ZONES.map((zone) => {
    const formatted = formatInZone(ms, zone.id, 'YYYY-MM-DD HH:mm:ss');
    return formatted === null ? null : `${zone.label}：${formatted}`;
  }).filter((line): line is string => line !== null);
  const selected = formatInZone(ms, timezone, fmt) ?? date.toISOString();
  return [
    `所选时区（${timezone}）：${selected}`,
    ...zoneLines,
    `ISO 8601：${date.toISOString()}`,
    `Unix 秒：${Math.floor(ms / 1000)}`,
    `Unix 毫秒：${ms}`,
    `相对时间：${relativeTime(ms)}`,
    `星期：${weekdayInZone(ms, timezone)}`,
  ].join('\n');
}

/** 批量结果 → CSV 文本。 */
function rowsToCsv(rows: readonly BatchRow[]): string {
  const header = 'input,seconds,milliseconds,local,utc,iso,relative';
  const body = rows.map((row) =>
    [row.input, row.seconds, row.milliseconds, row.local, row.utc, row.iso, row.relative]
      .map((cell) => String(cell).replace(/"/g, '""'))
      .map((cell) => (/[",\n]/.test(cell) ? `"${cell}"` : cell))
      .join(','),
  );
  return [header, ...body].join('\n');
}

/** 结果单元格（输出网格的统一小卡片）。 */
function StatCell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="rounded-md bg-muted p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold break-all ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

/**
 * 顶部当前时间横幅：实时显示当前 Unix 秒 / 毫秒 / 所选时区格式化时间，
 * 每秒刷新，右侧「复制」按钮复制形如 `秒:{s} 毫秒:{ms} {formatted}` 的文本。
 * 增量功能，不影响原有快捷按钮。
 */
function NowBanner({ timezone, fmt }: { timezone: string; fmt: string }): React.JSX.Element {
  const [nowMs, setNowMs] = React.useState<number>(Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const seconds = Math.floor(nowMs / 1000);
  const formatted = formatInZone(nowMs, timezone, fmt) ?? '';

  const copyNow = React.useCallback(async (): Promise<void> => {
    const ok = await copyText(`秒:${seconds} 毫秒:${nowMs} ${formatted}`);
    if (ok) {
      toast.success('已复制当前时间');
    } else {
      toast.error('复制失败');
    }
  }, [seconds, nowMs, formatted]);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted p-2">
      <div className="flex flex-1 flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          当前 Unix 秒：<span className="font-mono font-semibold text-foreground">{seconds}</span>
        </span>
        <span>
          毫秒：<span className="font-mono font-semibold text-foreground">{nowMs}</span>
        </span>
        <span>
          本地时间：<span className="font-mono font-semibold text-foreground">{formatted}</span>
        </span>
      </div>
      <Button size="sm" variant="ghost" className="text-xs" onClick={copyNow}>
        复制
      </Button>
    </div>
  );
}

/**
 * 时间戳转换（V15 对齐 ops-tools 参考实现）：
 * 双向转换（时间戳 ⇄ 日期）、秒/毫秒单位、相对偏移（+1d/-2h）、
 * 相对时间与星期、6 时区、6 输出格式、批量多行、快捷时间（当前/当天零点/当天结束）、
 * 一键复制 + 批量结果复制为 CSV / JSON。
 */
export function TimestampConverter({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [mode, setMode] = usePersistedState<InputMode>(COMMAND_ID, 'mode', 'timestamp');
  const [unit, setUnit] = usePersistedState<TsUnit>(COMMAND_ID, 'unit', 'seconds');
  const [text, setText] = usePersistedState<string>(COMMAND_ID, 'text', initialInput);
  const [timezone, setTimezone] = usePersistedState<string>(COMMAND_ID, 'timezone', 'Asia/Shanghai');
  const [fmt, setFmt] = usePersistedState<string>(COMMAND_ID, 'fmt', FORMATS[0] ?? 'YYYY-MM-DD HH:mm:ss');
  /** 相对偏移：数值 + 单位 + 方向（原生支持 周 / 月 / 年，比手打 `+1h` 更好发现）。 */
  const [offsetValue, setOffsetValue] = usePersistedState<string>(COMMAND_ID, 'offsetValue', '1');
  const [offsetUnit, setOffsetUnit] = usePersistedState<string>(COMMAND_ID, 'offsetUnit', 'd');
  const [offsetForward, setOffsetForward] = usePersistedState<boolean>(COMMAND_ID, 'offsetForward', true);

  const lines = React.useMemo<string[]>(
    () => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0),
    [text],
  );
  const isBatch = lines.length > 1;

  // 单条结果：ms + 报告文本（无效输入返回 null）
  const single = React.useMemo<{ ms: number; report: string } | null>(() => {
    if (lines.length === 0) {
      return null;
    }
    const ms = parseLine(lines[0] ?? '', mode, unit);
    return ms === null ? null : { ms, report: toReport(ms, timezone, fmt) };
  }, [lines, mode, unit, timezone, fmt]);

  // 批量结果：逐行转换（无效行 valid=false，照常展示便于定位）
  const batch = React.useMemo<BatchRow[] | null>(() => {
    if (!isBatch) {
      return null;
    }
    return lines.map((line) => {
      const ms = parseLine(line, mode, unit);
      if (ms === null) {
        return {
          input: line,
          seconds: 0,
          milliseconds: 0,
          local: '',
          utc: '',
          iso: '',
          relative: '无效输入',
          valid: false,
        };
      }
      const date = new Date(ms);
      return {
        input: line,
        seconds: Math.floor(ms / 1000),
        milliseconds: ms,
        local: formatInZone(ms, timezone, 'YYYY-MM-DD HH:mm:ss') ?? '',
        utc: formatInZone(ms, 'UTC', 'YYYY-MM-DD HH:mm:ss') ?? '',
        iso: date.toISOString(),
        relative: relativeTime(ms),
        valid: true,
      };
    });
  }, [isBatch, lines, mode, unit, timezone]);

  // 相对时间每 30 秒自动刷新（保持「N分钟前」新鲜）
  const [, setTick] = React.useState<number>(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  // 快捷时间点统一走 fillMoment（尊重当前 Tab），不再单独维护「当前时间」填充逻辑。

  /**
   * 按**当前 Tab** 写入一个时刻 —— 绝不擅自切换 Tab。
   * 时间戳 Tab 填 10 位秒，日期 Tab 填 `YYYY-MM-DD HH:mm:ss`。
   */
  const fillMoment = React.useCallback(
    (ms: number): void => {
      if (mode === 'datetime') {
        const formatted = formatInZone(ms, timezone, 'YYYY-MM-DD HH:mm:ss');
        if (formatted === null) {
          toast.error(`时区「${timezone}」无效，无法格式化`);
          return;
        }
        setText(formatted);
        return;
      }
      setText(String(Math.floor(ms / 1000)));
    },
    [mode, timezone],
  );

  /**
   * 应用相对偏移：基准取「当前解析结果 → 批量首行 → 此刻」，同样尊重当前 Tab。
   * 单位覆盖 毫秒 / 秒 / 分钟 / 小时 / 天 / 周 / 月 / 年。
   */
  const applyOffset = React.useCallback((): void => {
    const magnitude = Number(offsetValue);
    if (!Number.isFinite(magnitude) || magnitude === 0) {
      toast.warning('请输入非零的偏移数值（可为负数）');
      return;
    }
    const base =
      single?.ms ??
      (batch && batch[0]?.valid ? parseLine(batch[0].input, mode, unit) : null) ??
      Date.now();
    const newMs = addOffset(base, (offsetForward ? 1 : -1) * magnitude, offsetUnit);
    if (mode === 'datetime') {
      const formatted = formatInZone(newMs, timezone, 'YYYY-MM-DD HH:mm:ss');
      if (formatted === null) {
        toast.error(`时区「${timezone}」无效，无法格式化`);
        return;
      }
      setText(formatted);
      return;
    }
    setText(String(Math.floor(newMs / 1000)));
  }, [offsetValue, offsetForward, offsetUnit, single, batch, mode, unit, timezone]);

  /**
   * 快捷时间点（全部按**所选时区的本地日历**计算）。
   *
   * 关键行为修正：点击后**只填充输入框，绝不改当前 Tab**。此前在「时间戳」Tab
   * 点「当天零点」会被强行切到「日期」Tab，正是 `setMode('datetime')` 造成的。
   */
  const quickMoments = React.useMemo<
    ReadonlyArray<{ id: string; label: string; resolve: () => number }>
  >(() => {
    const DAY = 86_400_000;
    /** 该时区今天零点 */
    const todayStart = (): number => startOfDayInZone(Date.now(), timezone);
    /** 本地年月日 */
    const parts = (): { year: number; month: number; day: number } =>
      datePartsInZone(Date.now(), timezone);
    return [
      { id: 'now', label: '此刻', resolve: () => Date.now() },
      { id: 'today-start', label: '今天 00:00', resolve: todayStart },
      { id: 'today-end', label: '今天 23:59:59', resolve: () => todayStart() + DAY - 1000 },
      { id: 'yesterday', label: '昨天 00:00', resolve: () => todayStart() - DAY },
      { id: 'tomorrow', label: '明天 00:00', resolve: () => todayStart() + DAY },
      {
        id: 'week-start',
        label: '本周一 00:00',
        resolve: () => {
          const weekday = weekdayIndexInZone(Date.now(), timezone);
          return todayStart() - ((weekday + 6) % 7) * DAY;
        },
      },
      {
        id: 'week-end',
        label: '本周日 23:59:59',
        resolve: () => {
          const weekday = weekdayIndexInZone(Date.now(), timezone);
          return todayStart() + ((7 - weekday) % 7) * DAY + DAY - 1000;
        },
      },
      {
        id: 'month-start',
        label: '本月 1 号 00:00',
        resolve: () => {
          const { day } = parts();
          return msFromDayIndex(dayIndexInZone(Date.now(), timezone) - (day - 1), timezone);
        },
      },
      {
        id: 'next-month-start',
        label: '下月 1 号 00:00',
        resolve: () => {
          const { year, month, day } = parts();
          const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
          const remain = daysInMonth - day;
          return msFromDayIndex(dayIndexInZone(Date.now(), timezone) + remain, timezone);
        },
      },
      {
        id: 'year-start',
        label: '今年 1 月 1 日',
        resolve: () => {
          const { year, month, day } = parts();
          const localDayUtc = Date.UTC(year, month - 1, day);
          const dayOfYear = Math.round((localDayUtc - Date.UTC(year, 0, 1)) / DAY);
          return msFromDayIndex(dayIndexInZone(Date.now(), timezone) - dayOfYear, timezone);
        },
      },
    ];
  }, [timezone]);

  const copyBatchCsv = React.useCallback(async (): Promise<void> => {
    if (!batch || batch.length === 0) {
      toast.warning('暂无批量结果');
      return;
    }
    const ok = await copyText(rowsToCsv(batch));
    if (ok) {
      toast.success('CSV 已复制到剪贴板');
    } else {
      toast.error('复制失败');
    }
  }, [batch]);

  const copyBatchJson = React.useCallback(async (): Promise<void> => {
    if (!batch || batch.length === 0) {
      toast.warning('暂无批量结果');
      return;
    }
    const ok = await copyText(JSON.stringify(batch, null, 2));
    if (ok) {
      toast.success('JSON 已复制到剪贴板');
    } else {
      toast.error('复制失败');
    }
  }, [batch]);

  const copyTextValue = isBatch ? (batch ? rowsToCsv(batch) : '') : (single?.report ?? '');

  /**
   * 切换 Tab 时**联动转换输入内容**（时间戳 ⇄ 日期）。
   *
   * 逐行转换，批量场景同样生效；无法解析的行原样保留，绝不吞掉用户输入。
   * 这样「从日期切到时间戳 Tab 时输入框还留着日期字符串」的错位感就消失了。
   */
  const switchMode = React.useCallback(
    (next: InputMode): void => {
      if (next === mode) {
        return;
      }
      const source = mode;
      const converted = text
        .split(/\r?\n/)
        .map((line) => {
          const token = line.trim();
          if (token.length === 0) {
            return line;
          }
          const ms = parseLine(token, source, unit);
          if (ms === null) {
            return line;
          }
          if (next === 'datetime') {
            return formatInZone(ms, timezone, 'YYYY-MM-DD HH:mm:ss') ?? line;
          }
          return String(Math.floor(ms / 1000));
        })
        .join('\n');
      setMode(next);
      if (next === 'timestamp') {
        // 转换结果统一为 10 位秒，单位选择器同步归位
        setUnit('seconds');
      }
      setText(converted);
    },
    [mode, text, unit, timezone],
  );

  const modeButton = (value: InputMode, label: string): React.JSX.Element => (
    <Button
      key={value}
      size="sm"
      variant={mode === value ? 'default' : 'ghost'}
      className="h-7 px-2.5 text-xs"
      onClick={() => switchMode(value)}
    >
      {label}
    </Button>
  );

  return (
    <CommandShell
      title="时间戳转换"
      onPaste={(t) => setText(t)}
      description="Unix 时间戳（秒 / 毫秒）与日期时间互转，多时区多格式"
      icon={<Clock className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={copyTextValue}
      shortcutHint="支持多行批量；相对偏移如 +1h / -2d（也可用下方「应用偏移」）；「当前时间」按当前 Tab 填入"
      samples={[
        {
          label: '当前秒级',
          description: '填入此刻的秒级时间戳（10 位），再切「时间戳 → 日期」看换算',
          apply: () => {
            setMode('timestamp');
            setUnit('seconds');
            setText(String(Math.floor(Date.now() / 1000)));
          },
        },
        {
          label: '毫秒时间戳',
          description: '13 位毫秒时间戳 —— 单位选错就差 1000 倍，这里直接对比',
          apply: () => {
            setMode('timestamp');
            setUnit('milliseconds');
            setText(String(Date.now()));
          },
        },
        {
          label: '带时区的 ISO',
          description: 'ISO 8601 转时间戳：同一时刻在不同时区显示不同，但时间戳相同',
          apply: () => {
            setMode('datetime');
            setText('2026-09-16T09:30:00+08:00');
          },
        },
        {
          label: '多行批量',
          description: '时间戳与日期混排也能逐行识别，适合从日志里整段粘',
          apply: () => {
            setMode('timestamp');
            setUnit('seconds');
            setText('1700000000\n2026-01-01 00:00:00\n1767225600');
          },
        },
        {
          label: '相对偏移 +1M',
          description: '相对语法：m 是分钟、M 是月、w 是周、y 是年',
          apply: () => {
            setMode('datetime');
            setText('+1M');
          },
        },
      ]}
    >
      {/* 顶部当前时间横幅（默认展示、每秒刷新、可复制） */}
      <NowBanner timezone={timezone} fmt={fmt} />

      {/* V15：两列基准（≥1024px 并排）：左输入 / 选项，右结果，操作条通栏 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
        {/* 模式切换：切换时自动把输入内容换算到另一种表示 */}
        <div className="flex flex-wrap items-center gap-1.5">
          {modeButton('timestamp', '时间戳 → 日期')}
          {modeButton('datetime', '日期 → 时间戳')}
          <span className="ml-1 text-[11px] text-muted-foreground">
            切换时输入框内容自动换算
          </span>
        </div>

        {/* 输入区 */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground" htmlFor="ts-input">
            {mode === 'timestamp' ? '时间戳（每行一条，可批量）' : '日期时间（每行一条，可批量）'}
          </label>
          <textarea
            id="ts-input"
            autoFocus
            rows={isBatch ? 4 : 2}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={text}
            placeholder={
              mode === 'timestamp'
                ? '1704067200 / 1704067200000 / +1d / -2w / +1M / -1y\n（多行批量）'
                : '2024-01-01 08:00:00 / 2024-01-01T00:00:00Z\n（多行批量）'
            }
            onChange={(event) => setText(event.target.value)}
          />
          {mode === 'timestamp' ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>单位</span>
              <select
                className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                value={unit}
                onChange={(event) => setUnit(event.target.value as TsUnit)}
              >
                <option value="seconds">秒 (10 位)</option>
                <option value="milliseconds">毫秒 (13 位)</option>
              </select>
              <span className="ml-2">10 / 13 位自动识别</span>
            </div>
          ) : null}
        </div>

        {/* 时区 + 输出格式 */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            所选时区
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            >
              {TIME_ZONES.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            输出格式
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={fmt}
              onChange={(event) => setFmt(event.target.value)}
            >
              {FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </select>
          </label>
        </div>

        </div>

        {/* 结果区 */}
        <div className="flex min-w-0 flex-col gap-3">
        {isBatch && batch ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>批量结果：{batch.length} 条（无效 {batch.filter((row) => !row.valid).length} 条）</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={copyBatchCsv}>
                  复制 CSV
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={copyBatchJson}>
                  复制 JSON
                </Button>
              </div>
            </div>
            <div className="overflow-auto rounded-md border scrollbar-thin">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5">输入</th>
                    <th className="px-2 py-1.5">Unix 秒</th>
                    <th className="px-2 py-1.5">当地时间</th>
                    <th className="px-2 py-1.5">UTC</th>
                    <th className="px-2 py-1.5">相对</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.map((row, index) => (
                    <tr key={`${row.input}-${index}`} className={row.valid ? '' : 'text-destructive'}>
                      <td className="px-2 py-1.5 font-mono">{row.input}</td>
                      <td className="px-2 py-1.5 font-mono">{row.valid ? row.seconds : '—'}</td>
                      <td className="px-2 py-1.5 font-mono">{row.local || '—'}</td>
                      <td className="px-2 py-1.5 font-mono">{row.utc || '—'}</td>
                      <td className="px-2 py-1.5">{row.relative}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : single ? (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <StatCell label={`所选时区（${timezone}）`} value={formatInZone(single.ms, timezone, fmt) ?? '—'} />
              <StatCell label="UTC" value={formatInZone(single.ms, 'UTC', 'YYYY-MM-DD HH:mm:ss') ?? '—'} />
              <StatCell label="ISO 8601" value={new Date(single.ms).toISOString()} />
              <StatCell label="Unix 秒" value={String(Math.floor(single.ms / 1000))} mono />
              <StatCell label="Unix 毫秒" value={String(single.ms)} mono />
              <StatCell label={`星期（${timezone}）`} value={weekdayInZone(single.ms, timezone)} />
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted p-2">
              <div>
                <div className="text-xs text-muted-foreground">相对时间</div>
                <div className="mt-0.5 text-sm font-semibold">{relativeTime(single.ms)}</div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                6 时区明细见「一键复制」结果
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {lines.length === 0
              ? '输入时间戳或日期后自动转换'
              : '无法识别输入，请检查格式'}
          </div>
        )}
        </div>

        {/* 快捷时间点 + 相对偏移（通栏）：一律只填输入框，绝不切换 Tab */}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">快捷时间点</span>
            {quickMoments.map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant="secondary"
                className="h-7 px-2.5 text-xs"
                onClick={() => fillMoment(item.resolve())}
              >
                {item.label}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 px-2.5 text-xs text-destructive"
              onClick={() => setText('')}
            >
              清空
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">相对偏移</span>
            <select
              className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              value={offsetForward ? 'forward' : 'backward'}
              onChange={(event) => setOffsetForward(event.target.value === 'forward')}
              aria-label="偏移方向"
            >
              <option value="forward">之后 +</option>
              <option value="backward">之前 −</option>
            </select>
            <input
              className="h-7 w-20 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={offsetValue}
              onChange={(event) => setOffsetValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  applyOffset();
                }
              }}
              aria-label="偏移数值"
            />
            <select
              className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              value={offsetUnit}
              onChange={(event) => setOffsetUnit(event.target.value)}
              aria-label="偏移单位"
            >
              {OFFSET_UNITS.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.label}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 px-2.5 text-xs"
              onClick={applyOffset}
            >
              应用偏移
            </Button>
            <span className="text-[11px] text-muted-foreground">
              在当前 Tab 内计算；月 / 年按自然月、自然年叠加
            </span>
          </div>
        </div>
      </div>
    </CommandShell>
  );
}

export default TimestampConverter;
