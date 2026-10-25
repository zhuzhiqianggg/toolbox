import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { ChevronDown, ChevronRight, Download, Eye, EyeOff, RefreshCw, ShieldCheck } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { ResultBox } from '@/components/ResultBox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import {
  AMBIGUOUS_CHARS,
  DEFAULT_MAX_SYMBOL_RATIO,
  SIMILAR_CHARS,
  dedupeChars,
  evaluatePasswordStrength,
  generatePassword,
  hasAdjacentSymbols,
  isAlphanumeric,
  type GenerateResult,
} from '@/lib/passwordGen';
import { strengthColor, strengthText } from '@/lib/passwordStrengthUi';
import type { CommandProps } from '@/core/types';
import { cn } from '@/lib/utils';
import { downloadTextFile, timestampSuffix } from '@/modules/toolbox/lib/download';

const COMMAND_ID = 'password-generator';

/** 基础字符分类。 */
const CHAR_SETS = [
  { id: 'upper', label: '大写 A-Z', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { id: 'lower', label: '小写 a-z', chars: 'abcdefghijklmnopqrstuvwxyz' },
  { id: 'digit', label: '数字 0-9', chars: '0123456789' },
  { id: 'symbol', label: '符号', chars: '' },
] as const;

type SetId = (typeof CHAR_SETS)[number]['id'];

/** 符号全集（分组过滤的输入池）。 */
const BASE_SYMBOLS: string = [
  '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '-', '_', '=', '+',
  '[', ']', '{', '}', ';', ':', ',', '.', '<', '>', '?', '/', '~', '`',
  '|', "'", '"', '\\',
].join('');

/** 符号安全分组：按使用场景裁剪符号集。 */
interface SymbolGroup {
  id: string;
  label: string;
  hint: string;
  /** 返回该分组允许的符号子集。 */
  filter: (symbols: string) => string;
}

/** 仅保留白名单中的字符。 */
function keepOnly(source: string, allow: string): string {
  return source
    .split('')
    .filter((char) => allow.includes(char))
    .join('');
}

/** 剔除黑名单中的字符。 */
function excludeChars(source: string, banned: string): string {
  return source
    .split('')
    .filter((char) => !banned.includes(char))
    .join('');
}

const SYMBOL_GROUPS: readonly SymbolGroup[] = [
  {
    id: 'shell',
    label: 'Shell 安全',
    hint: '!@#$%^&*_-+=',
    filter: (symbols) => keepOnly(symbols, '!@#$%^&*_-+='),
  },
  { id: 'url', label: 'URL 安全', hint: '-_.~', filter: (symbols) => keepOnly(symbols, '-_.~') },
  {
    id: 'quote',
    label: '引号安全',
    hint: "不含 ' \" `",
    filter: (symbols) => excludeChars(symbols, "'\"`"),
  },
  {
    id: 'bracket',
    label: '括号安全',
    hint: '不含 ()[]{}<>',
    filter: (symbols) => excludeChars(symbols, '()[]{}<>'),
  },
  {
    id: 'sql',
    label: 'SQL 安全',
    hint: "不含 ' \" \\ ;",
    filter: (symbols) => excludeChars(symbols, "'\"\\;"),
  },
  {
    id: 'common',
    label: '常用符号',
    hint: '!@#$%^&*',
    filter: (symbols) => keepOnly(symbols, '!@#$%^&*'),
  },
];

/** 强度评分结果（多档 + 具体改进建议）。 */
interface Strength {
  /** 0–4：很弱 / 弱 / 中等 / 强 / 极强 */
  score: number;
  label: string;
  /** 具体改进建议（无建议时给出正向说明） */
  feedback: string[];
  /** 熵（bit） */
  entropy: number;
}

/**
 * 密码生成器（对齐 ops-tools 的 PasswordGenerator）：
 * 长度 4–128、4 类字符集 + 6 种符号安全分组、排除相似 / 模糊字符、自定义字符集、
 * 批量生成 1–50 条、首尾字符约束、最大符号占比、多档强度评分与改进建议、
 * 显示 / 隐藏切换与 .txt 导出。
 *
 * 安全约束：本命令为敏感命令，结果**绝不写入任何历史 / 收藏 / 持久化**。
 */
export function PasswordGenerator(_props: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);

  const [length, setLength] = usePersistedState<number>(COMMAND_ID, 'length', 16);
  const [enabled, setEnabled] = usePersistedState<Record<SetId, boolean>>(COMMAND_ID, 'enabled', {
    upper: true,
    lower: true,
    digit: true,
    symbol: true,
  });
  const [symbolGroups, setSymbolGroups] = usePersistedState<Record<string, boolean>>(COMMAND_ID, 'symbolGroups', {});
  const [excludeSimilar, setExcludeSimilar] = usePersistedState<boolean>(COMMAND_ID, 'excludeSimilar', false);
  const [excludeAmbiguous, setExcludeAmbiguous] = usePersistedState<boolean>(COMMAND_ID, 'excludeAmbiguous', false);
  const [customCharset, setCustomCharset] = usePersistedState<string>(COMMAND_ID, 'customCharset', '');
  const [count, setCount] = usePersistedState<number>(COMMAND_ID, 'count', 1);
  const [edgeLetter, setEdgeLetter] = usePersistedState<boolean>(COMMAND_ID, 'edgeLetter', true);
  const [separateSymbols, setSeparateSymbols] = usePersistedState<boolean>(COMMAND_ID, 'separateSymbols', true);
  // 键名由 maxSymbolPercent 改为 symbolPercent，默认值从「不限制」降到 25%（V25）。
  // 沿用旧键名会让已有用户继续吃 100% 的默认值 —— 那正是被投诉的行为
  // （16 位密码里冒出 5~6 个符号，还常常两个挨在一起）。
  const [symbolPercent, setSymbolPercent] = usePersistedState<number>(
    COMMAND_ID,
    'symbolPercent',
    Math.round(DEFAULT_MAX_SYMBOL_RATIO * 100),
  );
  const [advancedOpen, setAdvancedOpen] = React.useState<boolean>(false);
  const [visible, setVisible] = React.useState<boolean>(true);
  const [nonce, setNonce] = React.useState<number>(0);

  /** 符号集：按勾选的安全分组依次裁剪。 */
  const symbolChars = React.useMemo<string>(() => {
    let result = BASE_SYMBOLS;
    for (const group of SYMBOL_GROUPS) {
      if (symbolGroups[group.id] === true) {
        result = group.filter(result);
      }
    }
    return result;
  }, [symbolGroups]);

  /** 自定义字符集非空时完全接管（忽略分类开关）。 */
  const customMode = customCharset.trim().length > 0;

  /** 最终字符池。 */
  const pool = React.useMemo<string>(() => {
    if (customMode) {
      return dedupeChars(customCharset);
    }
    let base = CHAR_SETS.filter((set) => enabled[set.id])
      .map((set) => (set.id === 'symbol' ? symbolChars : set.chars))
      .join('');
    if (excludeSimilar) {
      base = excludeChars(base, SIMILAR_CHARS);
    }
    if (excludeAmbiguous) {
      base = excludeChars(base, AMBIGUOUS_CHARS);
    }
    return dedupeChars(base);
  }, [customMode, customCharset, enabled, symbolChars, excludeSimilar, excludeAmbiguous]);

  /** 池中的字母 / 非符号子集（约束用）。 */
  const letters = React.useMemo<string>(
    () => pool.split('').filter((char) => /[A-Za-z]/.test(char)).join(''),
    [pool],
  );
  const nonSymbols = React.useMemo<string>(
    () => pool.split('').filter(isAlphanumeric).join(''),
    [pool],
  );

  /**
   * 各字符类的字符池（先落一位用）：保证「勾选了某类就一定出现该类字符」。
   * 自定义字符集模式下退化为单类（池本身），不做分类保证。
   */
  const requiredSets = React.useMemo<string[]>(() => {
    if (customMode) {
      return [pool];
    }
    return CHAR_SETS.filter((set) => enabled[set.id])
      .map((set) => (set.id === 'symbol' ? symbolChars : set.chars))
      .map((chars) =>
        pool
          .split('')
          .filter((char) => chars.includes(char))
          .join(''),
      )
      .filter((chars) => chars.length > 0);
  }, [customMode, pool, enabled, symbolChars]);

  /** 约束不可满足时的警告（界面提示，不阻断生成）。 */
  const warnings = React.useMemo<string[]>(() => {
    const list: string[] = [];
    if (pool.length === 0) {
      list.push('当前字符集为空，请至少选择一类字符或填写自定义字符集');
      return list;
    }
    if (customMode) {
      list.push('已启用自定义字符集：分类开关与符号分组不再生效');
    }
    if (edgeLetter && letters.length === 0) {
      list.push('字符集不含字母，「首尾为字母」无法保证（已自动跳过）');
    }
    if (symbolPercent === 0 && nonSymbols.length === 0) {
      list.push('字符集只剩符号，「最大符号占比 0%」无法保证');
    }
    if (separateSymbols && symbolChars.length > 0 && nonSymbols.length === 0) {
      list.push('字符集只含符号，「符号不连续」无法成立');
    }
    if (symbolChars.length === 0 && enabled.symbol && !customMode) {
      list.push('符号分组交集为空，已不含任何符号');
    }
    return list;
  }, [
    pool.length,
    customMode,
    edgeLetter,
    letters.length,
    symbolPercent,
    separateSymbols,
    nonSymbols.length,
    symbolChars.length,
    enabled.symbol,
  ]);

  /**
   * 批量生成。生成算法在 `@/lib/passwordGen`（与密码库共用同一份），
   * 这里只负责把界面上的选项翻译成约束，并把各次生成的收敛说明合并去重。
   */
  const generated = React.useMemo<{ list: string[]; notes: string[]; symbolCount: number }>(() => {
    if (pool.length === 0) {
      return { list: [], notes: [], symbolCount: 0 };
    }
    const list: string[] = [];
    const notes = new Set<string>();
    let symbolCount = 0;
    for (let i = 0; i < count; i += 1) {
      const result: GenerateResult = generatePassword({
        length,
        pool,
        requiredSets,
        nonSymbols,
        symbols: symbolChars,
        maxSymbolRatio: symbolPercent / 100,
        edgeLetter,
        separateSymbols,
      });
      list.push(result.password);
      for (const note of result.notes) {
        notes.add(note);
      }
      if (i === 0) {
        symbolCount = result.symbolCount;
      }
    }
    return { list, notes: [...notes], symbolCount };
    // nonce 变化触发重新生成
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    length,
    pool,
    requiredSets,
    nonSymbols,
    symbolChars,
    count,
    edgeLetter,
    separateSymbols,
    symbolPercent,
    nonce,
  ]);

  const passwords = generated.list;

  /** 全部提示（静态约束 + 本次生成实际被收敛掉的约束） */
  const warningList = React.useMemo<string[]>(
    () => [...warnings, ...generated.notes],
    [warnings, generated.notes],
  );

  /** 首条密码的强度（列表逐条强度单独计算）。 */
  const strength = React.useMemo<Strength>(
    () => evaluatePasswordStrength(passwords[0] ?? '', Math.max(2, pool.length)),
    [passwords, pool.length],
  );

  /** 首条密码里是否仍有相邻符号（用于把「不连续」是否真的达成摆在明面上） */
  const adjacentSymbols = React.useMemo<boolean>(
    () => (passwords[0] !== undefined ? hasAdjacentSymbols(passwords[0]) : false),
    [passwords],
  );

  const regenerate = React.useCallback((): void => {
    if (pool.length === 0) {
      toast.error('当前字符集为空，无法生成');
      return;
    }
    setNonce((value) => value + 1);
  }, [pool.length]);

  /** 导出全部密码为 .txt（仅本地 Blob 下载，不做任何持久化）。 */
  const handleDownload = React.useCallback((): void => {
    if (passwords.length === 0) {
      toast.error('暂无可导出的密码');
      return;
    }
    const ok = downloadTextFile(`toolbox-passwords-${timestampSuffix()}.txt`, passwords.join('\n'));
    if (ok) {
      toast.success(`已导出 ${passwords.length} 条密码为 .txt`);
    } else {
      toast.error('导出失败，请重试');
    }
  }, [passwords]);

  const switchRow = (
    label: string,
    checked: boolean,
    onChange: (value: boolean) => void,
    hint?: string,
  ): React.JSX.Element => (
    <label className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <span className="min-w-0 text-sm text-foreground">
        {label}
        {hint ? <span className="ml-1 text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <Switch
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        aria-label={label}
      />
    </label>
  );

  return (
    <CommandShell
      title="密码生成器"
      description="本地随机强密码：符号不连排、符号占比可控、符号安全分组、排除易混淆字符、批量生成（敏感内容不写历史）"
      icon={<ShieldCheck className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      favoriteDisabled={shell.favoriteDisabled}
      copyText={passwords.join('\n')}
      primaryAction={{ label: '重新生成', onClick: regenerate, disabled: pool.length === 0 }}
      shortcutHint="调整选项自动重新生成（Esc 返回）"
      samples={[
        {
          label: '16 位通用',
          description: '四类字符全开 + 排除易混淆的 il1Lo0O；符号最多 25% 且不连排',
          apply: () => {
            setLength(16);
            setEnabled({ upper: true, lower: true, digit: true, symbol: true });
            setExcludeSimilar(true);
            setExcludeAmbiguous(false);
            setCustomCharset('');
            setCount(1);
            setSymbolPercent(25);
            setSeparateSymbols(true);
            setEdgeLetter(true);
          },
        },
        {
          label: '少符号易手输',
          description: '要照着敲的场合：16 位、符号最多 10%、排除模糊字符',
          apply: () => {
            setLength(16);
            setEnabled({ upper: true, lower: true, digit: true, symbol: true });
            setExcludeSimilar(true);
            setExcludeAmbiguous(true);
            setCustomCharset('');
            setCount(1);
            setSymbolPercent(10);
            setSeparateSymbols(true);
            setEdgeLetter(true);
          },
        },
        {
          label: '只字母数字',
          description: '有些老系统不收符号 —— 32 位把强度补回来',
          apply: () => {
            setLength(32);
            setEnabled({ upper: true, lower: true, digit: true, symbol: false });
            setExcludeSimilar(false);
            setCustomCharset('');
            setCount(1);
          },
        },
        {
          label: '强口令 40 位',
          description: '本地 CSPRNG 生成，长度优先于复杂度',
          apply: () => {
            setLength(40);
            setEnabled({ upper: true, lower: true, digit: true, symbol: true });
            setExcludeSimilar(false);
            setExcludeAmbiguous(false);
            setCustomCharset('');
            setCount(1);
            setSymbolPercent(25);
            setSeparateSymbols(true);
          },
        },
        {
          label: '批量 10 条',
          description: '一次出 10 条，给一批新账号用',
          apply: () => {
            setCount(10);
            setLength(16);
            setEnabled({ upper: true, lower: true, digit: true, symbol: true });
            setSymbolPercent(25);
            setSeparateSymbols(true);
          },
        },
      ]}
    >
      {/* 1180×820 基准：两列并排（左选项 / 右结果），窄屏（<1024px）自动回退单列。
          断点用 lg(1024) 而非 xl(1280)：工具页预设宽度就是 1180，用 xl 会在默认尺寸下退化成单列。 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ===== 左列：选项 ===== */}
        <div className="scrollbar-thin flex min-w-0 flex-col gap-4">
          {/* 长度 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground" htmlFor="pwd-length">
                长度
              </label>
              <span className="font-mono text-sm text-brand">{length}</span>
            </div>
            <Slider
              id="pwd-length"
              min={4}
              max={128}
              step={1}
              value={[length]}
              onValueChange={(values) => {
                const next = values[0];
                if (typeof next === 'number') {
                  setLength(next);
                }
              }}
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>4</span>
              <span>128</span>
            </div>
          </div>

          {/* 字符分类 */}
          <div className="grid grid-cols-2 gap-2">
            {CHAR_SETS.map((set) => (
              <label
                key={set.id}
                className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2"
              >
                <span className="text-sm text-foreground">{set.label}</span>
                <Switch
                  checked={enabled[set.id]}
                  disabled={customMode}
                  onCheckedChange={(checked) => {
                    setEnabled((current) => {
                      const next = { ...current, [set.id]: checked === true };
                      // 至少保留一类字符
                      const any = Object.values(next).some(Boolean);
                      return any ? next : current;
                    });
                  }}
                  aria-label={set.label}
                />
              </label>
            ))}
          </div>

          {/* 位置优化（V18）：默认开启，把结论直接摆在一级选项里，不必翻高级选项 */}
          <label className="flex items-start justify-between gap-3 rounded-lg border border-brand/30 bg-brand-muted/40 px-3 py-2">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                位置优化
                <span className="ml-1 text-[11px] font-normal text-brand">推荐</span>
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                首尾固定为字母；每类勾选的字符至少出现一次
              </span>
            </span>
            <Switch
              checked={edgeLetter}
              onCheckedChange={(value) => setEdgeLetter(value === true)}
              aria-label="位置优化（首尾为字母）"
            />
          </label>

          {/* 符号不连续（V25）：用户反馈「特殊字符尽量不要连着出现多个特殊字符」。
              用「同奇偶位置互不相邻」一次选点，不是生成完再修补 —— 所以是硬保证。 */}
          <label className="flex items-start justify-between gap-3 rounded-lg border border-brand/30 bg-brand-muted/40 px-3 py-2">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                符号不连续
                <span className="ml-1 text-[11px] font-normal text-brand">推荐</span>
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                任意两个符号都不相邻，不出现「a!!b」这类连排
                {pool.length > 0 && symbolChars.length > 0 ? (
                  <>
                    {' '}
                    · 本批首位 {generated.symbolCount} 个符号
                    {adjacentSymbols ? (
                      <span className="text-amber-600">（未达成，见下方提示）</span>
                    ) : null}
                  </>
                ) : null}
              </span>
            </span>
            <Switch
              checked={separateSymbols}
              onCheckedChange={(value) => setSeparateSymbols(value === true)}
              aria-label="符号不连续"
            />
          </label>

          {/* 高级选项 */}
          <div className="rounded-lg border border-border bg-card">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-3 py-2 text-sm font-medium text-foreground"
              onClick={() => setAdvancedOpen((value) => !value)}
              aria-expanded={advancedOpen}
            >
              {advancedOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              高级选项
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                符号分组 / 排除字符 / 自定义字符集 / 约束
              </span>
            </button>
            {advancedOpen ? (
              <div className="flex flex-col gap-3 border-t border-border p-3">
                {/* 符号安全分组 */}
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-foreground">符号安全分组（可多选，取交集）</span>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {SYMBOL_GROUPS.map((group) => (
                      <label
                        key={group.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5"
                      >
                        <span className="min-w-0 text-xs text-foreground">
                          {group.label}
                          <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                            {group.hint}
                          </span>
                        </span>
                        <Switch
                          checked={symbolGroups[group.id] === true}
                          disabled={customMode}
                          onCheckedChange={(checked) =>
                            setSymbolGroups((current) => ({ ...current, [group.id]: checked === true }))
                          }
                          aria-label={group.label}
                        />
                      </label>
                    ))}
                  </div>
                </div>

                {/* 排除字符（位置优化 / 符号不连续已提到一级选项，这里不再重复摆放） */}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {switchRow('排除相似字符', excludeSimilar, setExcludeSimilar, `(${SIMILAR_CHARS})`)}
                  {switchRow('排除模糊字符', excludeAmbiguous, setExcludeAmbiguous, `(${AMBIGUOUS_CHARS.slice(0, 8)}…)`)}
                </div>

                {/* 自定义字符集 */}
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  自定义字符集（填写后将完全接管可用字符）
                  <Input
                    value={customCharset}
                    onChange={(event) => setCustomCharset(event.target.value)}
                    placeholder="留空则使用上方分类与符号分组"
                    className="font-mono"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>

                {/* 最大符号占比 */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-foreground">最大符号占比</span>
                    <span className="font-mono text-xs text-brand">
                      {symbolPercent}%
                      {pool.length > 0 && symbolChars.length > 0 ? (
                        <span className="ml-1 text-muted-foreground">
                          （{length} 位最多 {Math.floor((length * symbolPercent) / 100)} 个）
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <Slider
                    min={0}
                    max={100}
                    step={5}
                    value={[symbolPercent]}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (typeof next === 'number') {
                        setSymbolPercent(next);
                      }
                    }}
                  />
                  <span className="text-[11px] leading-relaxed text-muted-foreground">
                    符号越少越好敲：一般账号 25% 足够，需要照着输入时建议 10%。勾了「符号」类就至少 1 个。
                  </span>
                </div>
              </div>
            ) : null}
          </div>

          {/* 批量数量 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">生成数量</span>
              <span className="font-mono text-sm text-brand">{count}</span>
            </div>
            <Slider
              min={1}
              max={50}
              step={1}
              value={[count]}
              onValueChange={(values) => {
                const next = values[0];
                if (typeof next === 'number') {
                  setCount(next);
                }
              }}
            />
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>1</span>
              <span>50</span>
            </div>
          </div>

          {/* 强度 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">强度</span>
              <span className="font-medium text-foreground">
                {pool.length === 0 ? (
                  '请至少选择一类字符'
                ) : (
                  <span className={cn(strengthText(strength.score))}>
                    {strength.label}
                  </span>
                )}
                <span className="ml-1 text-muted-foreground">
                  （约 {Math.round(strength.entropy)} bit 熵 · 字符池 {pool.length}
                  {pool.length > 0 ? ` · 符号 ${generated.symbolCount} 个` : ''}）
                </span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full transition-all', strengthColor(strength.score))}
                style={{ width: `${pool.length === 0 ? 0 : (strength.score + 1) * 20}%` }}
              />
            </div>
            {pool.length > 0 ? (
              <ul className="mt-1 flex flex-wrap gap-1">
                {strength.feedback.map((item) => (
                  <li
                    key={item}
                    className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {warningList.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {warningList.map((item) => (
                <li key={item} className="text-[11px] text-amber-600">
                  · {item}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* ===== 右列：结果 ===== */}
        <div className="flex min-w-0 flex-col gap-3">
          <ResultBox
            title={`生成结果（${passwords.length}）`}
            value={visible ? passwords.join('\n') : passwords.map((item) => '•'.repeat(item.length)).join('\n')}
            emptyHint="选择字符类型后自动生成"
            // 隐藏态下屏蔽结果区自带复制，避免复制到掩码串；逐条复制按钮仍复制真实密码
            copyable={visible}
            fill
            actions={
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setVisible((value) => !value)}
                >
                  {visible ? <EyeOff className="mr-1 h-3 w-3" /> : <Eye className="mr-1 h-3 w-3" />}
                  {visible ? '隐藏' : '显示'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={handleDownload}
                >
                  <Download className="mr-1 h-3 w-3" />
                  下载
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={regenerate}
                >
                  <RefreshCw className="mr-1 h-3 w-3" />
                  重新生成
                </Button>
              </div>
            }
          />

          {/* 逐条展示（独立复制 + 独立强度点） */}
          {passwords.length > 1 ? (
            <div className="scrollbar-thin flex max-h-[280px] flex-col gap-2 overflow-auto rounded-xl border border-border bg-card p-3">
              {passwords.map((password, index) => {
                const rowStrength = evaluatePasswordStrength(password, Math.max(2, pool.length));
                return (
                  <div
                    key={`${index}-${password}`}
                    className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2"
                  >
                    <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">
                      {index + 1}
                    </span>
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        strengthColor(rowStrength.score),
                      )}
                      title={`强度：${rowStrength.label}`}
                    />
                    <code className="scrollbar-thin min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground">
                      {visible ? password : '•'.repeat(password.length)}
                    </code>
                    <CopyButton text={password} disabled={password.length === 0} />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card p-3">
              <code className="block break-all font-mono text-sm text-foreground">
                {passwords[0] ? (visible ? passwords[0] : '•'.repeat(passwords[0].length)) : '—'}
              </code>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            敏感内容：不写入历史、不进入收藏、不做任何本地持久化；关闭页面即消失。
          </p>
        </div>
      </div>
    </CommandShell>
  );
}

export default PasswordGenerator;
