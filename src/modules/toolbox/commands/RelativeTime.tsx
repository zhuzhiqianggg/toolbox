import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Hourglass } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useCommandShell } from '@/hooks/useCommandShell';
import { toast } from '@/components/ui/toast';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'relative-time';

/** 中文相对时间（target 相对 now）：X秒/分钟/小时/天/月/年 前·后。 */
function zhRelative(target: Date, now: Date): string {
  const diffMs = target.getTime() - now.getTime();
  const future = diffMs >= 0;
  const absSec = Math.floor(Math.abs(diffMs) / 1000);
  let value: string;
  if (absSec < 60) {
    value = `${absSec}秒`;
  } else if (absSec < 3600) {
    value = `${Math.floor(absSec / 60)}分钟`;
  } else if (absSec < 86400) {
    value = `${Math.floor(absSec / 3600)}小时`;
  } else if (absSec < 2592000) {
    value = `${Math.floor(absSec / 86400)}天`;
  } else if (absSec < 31536000) {
    value = `${Math.floor(absSec / 2592000)}个月`;
  } else {
    value = `${Math.floor(absSec / 31536000)}年`;
  }
  return future ? `${value}后` : `${value}前`;
}

/** Date → 本地 `YYYY-MM-DD HH:mm:ss`（示例必须按当前时间现算，写死日期迟早与标签对不上） */
function toLocalInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 解析日期输入：10/13 位时间戳或常见日期串。 */
function parseDateInput(raw: string): Date | null {
  const token = raw.trim();
  if (/^\d{10}$/.test(token)) {
    return new Date(Number(token) * 1000);
  }
  if (/^\d{13}$/.test(token)) {
    return new Date(Number(token));
  }
  const parsed = Date.parse(token.replace(/\//g, '-'));
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** 单位 → 秒数（中英文写法都收，mo 用 30 天近似）。 */
const UNIT_FACTORS: Record<string, number> = {
  s: 1,
  秒: 1,
  秒钟: 1,
  m: 60,
  分: 60,
  分钟: 60,
  h: 3600,
  时: 3600,
  小时: 3600,
  d: 86400,
  天: 86400,
  日: 86400,
  w: 604800,
  周: 604800,
  mo: 2592000,
  月: 2592000,
  y: 31536000,
  年: 31536000,
};

/** 解析相对表达式（如 "in 2h" / "+2h" / "2小时后" / "-1d" / "3天前"）。 */
function parseRelativeExpr(raw: string): Date | null {
  const source = raw.trim().toLowerCase();
  if (!source) {
    return null;
  }
  let future = true;
  let body = source;
  if (body.startsWith('in ')) {
    future = true;
    body = body.slice(3);
  } else if (body.startsWith('+')) {
    future = true;
    body = body.slice(1);
  } else if (body.startsWith('-')) {
    future = false;
    body = body.slice(1);
  }
  if (body.endsWith('前') || body.endsWith(' ago')) {
    future = false;
    body = body.replace(/(前| ago)$/, '');
  }
  const match = body.match(/^(\d+(?:\.\d+)?)\s*(s|秒|秒钟|m|分|分钟|h|时|小时|d|天|日|w|周|mo|月|y|年)$/);
  if (!match) {
    return null;
  }
  const amountPart = match[1];
  const unitPart = match[2];
  if (!amountPart || !unitPart) {
    return null;
  }
  const amount = Number.parseFloat(amountPart);
  const factor = UNIT_FACTORS[unitPart];
  if (factor === undefined) {
    return null;
  }
  const delta = (future ? 1 : -1) * amount * factor * 1000;
  return new Date(Date.now() + delta);
}

/** 结果统一形态：ok=false 时 text 是给用户看的错误说明（不进结果区、不可复制）。 */
interface ParseOutcome {
  ok: boolean;
  text: string;
}

/** 日期输入 → 相对描述（附「解析为」一行，方便核对时间戳被理解成了哪个时刻）。 */
function buildDescribe(raw: string): ParseOutcome {
  const token = raw.trim();
  if (token.length === 0) {
    return { ok: true, text: '' };
  }
  const date = parseDateInput(token);
  if (!date) {
    return {
      ok: false,
      text: '无法识别日期：支持 10 位秒 / 13 位毫秒时间戳，或 2024-01-01 08:00:00 这类日期串',
    };
  }
  return { ok: true, text: `${zhRelative(date, new Date())}\n解析为：${toLocalInput(date)}` };
}

/** 相对表达式 → 具体时刻（本地 / ISO / 相对描述三行）。 */
function buildExpr(raw: string): ParseOutcome {
  if (raw.trim().length === 0) {
    return { ok: true, text: '' };
  }
  const date = parseRelativeExpr(raw);
  if (!date) {
    return {
      ok: false,
      text: '无法解析：支持 in 2h / +2h / 2小时后 / -1d / 3天前 / 1.5小时 这类写法',
    };
  }
  return {
    ok: true,
    text: `本地：${date.toLocaleString()}\nISO：${date.toISOString()}\n相对：${zhRelative(date, new Date())}`,
  };
}

/**
 * 相对时间：日期 → 「3天前」人性化描述；或解析「in 2h / 2小时后」为具体时间。
 * 纯前端，中文输出。
 */
export function RelativeTime({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [tab, setTab] = usePersistedState<string>(COMMAND_ID, 'tab', 'describe');
  const [dateInput, setDateInput] = usePersistedState<string>(COMMAND_ID, 'dateInput', initialInput);
  const [exprInput, setExprInput] = usePersistedState<string>(COMMAND_ID, 'exprInput', '');

  // 每 30 秒强制重渲染一次，让「N分钟前」跟随当前时间变新。
  // 解析放在渲染期（而非 useMemo）正是为了让 tick 能刷新它。
  const [, setTick] = React.useState<number>(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const describe = buildDescribe(dateInput);
  const exprResult = buildExpr(exprInput);

  // 一键复制只取当前 Tab 的有效结果；错误说明不进剪贴板
  const active = tab === 'describe' ? describe : exprResult;
  const copyText = active.ok ? active.text : '';

  const onTabChange = React.useCallback((value: string): void => {
    setTab(value);
  }, []);

  /**
   * 填入「此刻」。
   *
   * 旧实现这个位置是个只弹一句「暂无可复制内容」的按钮 —— 既不复制也不填值，
   * 纯粹占位。改成真正有用的动作：一键把当前时间戳填进输入框，
   * 用来验证「刚刚」这类边界值是否算得对。
   */
  const fillNow = React.useCallback((): void => {
    setDateInput(String(Math.floor(Date.now() / 1000)));
    toast.success('已填入当前时间戳（秒）');
  }, []);

  return (
    <CommandShell
      title="相对时间"
      onPaste={(t) => setDateInput(t)}
      description="日期 ⇄ 人性化相对时间（中文）"
      icon={<Hourglass className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={copyText}
      shortcutHint="相对描述每 30 秒自动刷新；结果可一键复制"
      samples={
        tab === 'describe'
          ? [
              { label: '刚发生', description: '当前秒级时间戳 —— 应输出「几秒前」', apply: () => { setDateInput(String(Math.floor(Date.now() / 1000))); } },
              {
                label: '3 天前',
                description: '按当前时间回推三天 —— 跨天/跨月边界是否算对',
                apply: () => setDateInput(toLocalInput(new Date(Date.now() - 3 * 86400_000))),
              },
              {
                label: '3 小时后',
                description: '按当前时间前推三小时（多留 1 分钟，避免渲染耗时把「3」挤成「2」）',
                apply: () => setDateInput(toLocalInput(new Date(Date.now() + 3 * 3600_000 + 60_000))),
              },
              { label: '毫秒时间戳', description: '13 位时间戳与 10 位秒级时间戳都能识别（运维日志两种都常见）', apply: () => setDateInput(String(Date.now())) },
              {
                label: '跨年',
                description: '上一个自然年的起点 —— 应落到「年」档位',
                apply: () => setDateInput(`${new Date().getFullYear() - 1}-01-01 00:00:00`),
              },
            ]
          : [
              { label: 'in 2h', description: '英文写法，两小时后', apply: () => setExprInput('in 2h') },
              { label: '+2h', description: '加号前缀写法（命令行习惯）', apply: () => setExprInput('+2h') },
              { label: '2小时后', description: '中文写法，与英文等价', apply: () => setExprInput('2小时后') },
              { label: '-1d', description: '减号前缀 = 过去，一天前', apply: () => setExprInput('-1d') },
              { label: '3天前', description: '中文过去式，等价于 -3d', apply: () => setExprInput('3天前') },
              { label: '1.5小时', description: '小数与中文单位混用，检验解析健壮性', apply: () => setExprInput('1.5小时') },
              { label: '45分钟', description: '分钟粒度，常用于「给缓存设 45 分钟过期」', apply: () => setExprInput('45分钟') },
            ]
      }
    >
      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList>
          <TabsTrigger value="describe">日期 → 描述</TabsTrigger>
          <TabsTrigger value="expr">解析表达式</TabsTrigger>
        </TabsList>

        <TabsContent value="describe">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <label className="text-sm font-medium text-foreground" htmlFor="rt-date">
                日期 / 时间戳
              </label>
              <textarea
                id="rt-date"
                rows={4}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={dateInput}
                placeholder="2024-01-01 08:00:00 或 1704067200"
                onChange={(event) => setDateInput(event.target.value)}
              />
              {!describe.ok ? (
                <p role="alert" className="text-xs text-destructive">
                  {describe.text}
                </p>
              ) : null}
              <Button variant="ghost" size="sm" className="self-start" onClick={fillNow}>
                填入当前时间
              </Button>
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <ResultBox
                title="相对描述"
                value={describe.ok ? describe.text : ''}
                emptyHint="输入日期后自动计算"
                mono={false}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="expr">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <label className="text-sm font-medium text-foreground" htmlFor="rt-expr">
                相对表达式
              </label>
              <textarea
                id="rt-expr"
                rows={4}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={exprInput}
                placeholder="in 2h / +2h / 2小时后 / -1d / 3天前"
                onChange={(event) => setExprInput(event.target.value)}
              />
              {!exprResult.ok ? (
                <p role="alert" className="text-xs text-destructive">
                  {exprResult.text}
                </p>
              ) : null}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <ResultBox
                title="解析结果"
                value={exprResult.ok ? exprResult.text : ''}
                emptyHint="输入相对表达式后自动解析"
                mono
              />
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </CommandShell>
  );
}

export default RelativeTime;
