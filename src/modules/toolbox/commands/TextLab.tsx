import * as React from 'react';
import {
  ArrowLeftRight,
  BarChart3,
  Columns3,
  Info,
  Layers,
  Regex,
  Search,
  Sparkles,
  Trash2,
  Undo2,
} from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import {
  LINE_OPS,
  applyLineOp,
  affixLines,
  convertEol,
  detectEol,
  extractMatches,
  findMatches,
  formatBytes,
  pickColumns,
  replaceAll,
  splitLines,
  textStats,
  wrapLines,
  type Eol,
  type LineOpContext,
  type LineOpGroup,
  type LineOpId,
  type LineOpSpec,
} from '@/lib/textlab';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'text-lab';

/**
 * 文本处理台（V23）。
 *
 * # 用户反馈
 *
 * 「希望增加一个文本处理工具：参考 Notepad++ 中那些强大的文本处理功能，例如文本查询与替换、
 *   正则表达式筛选查询等，说明我们能否实现类似能力，并需要处理得更加智能、优雅、
 *   覆盖多种文本处理场景；同时请指出这是一个体量较大的工程，涉及的功能数量众多，
 *   因此需要明确分阶段实现的范围与优先级。」
 *
 * # 这一版（Phase 1）落地了什么
 *
 * 三个能力面，全部由 `src/lib/textlab.ts` 的纯函数驱动：
 *   1. **查找与替换** —— 普通 / 正则、区分大小写、全词、`s`/`m` 开关、捕获组引用（`$1`），
 *      带实时「匹配 N 处」与首处上下文预览；
 *   2. **行处理** —— 20 个一键操作（去重 / 排序 / 逆序 / 随机 / 行号 / 注释 / 合并 / 拆分 /
 *      按模式筛选行 / 清不可见字符 …），全部可在同一个撤销栈里回退；
 *   3. **列与包裹 + 统计** —— 按分隔符取列、逐行加前后缀、硬折行、行词字符字节统计。
 *
 * # 为什么是「就地改写 + 撤销栈」而不是「左输入右输出」
 *
 * Notepad++ 的替换是**就地改文档**的。左右分栏在窄窗口（本应用最小 640px，内容区只剩 ~540px）
 * 会各挤一半，而这类工具的用户动作是「粘贴 → 操作 → 复制」，中间态没有保留价值。
 * 所以这里只留**一个**大文本框：操作直接作用于它，右上角给撤销栈，
 * 历史上任何一步都能退回去 —— 比看两个滚动的框更接近真实用法，也天然抗窄窗口。
 *
 * # 分阶段（详见 PROJECT_STATUS §1.9）
 *
 * Phase 2 计划：多文件 / 批量、正则库、Unicode 不可见字符巡检报告、按语法格式化
 * （JSON / XML / CSV / HTML 的「美化这一块」）、处理链保存为可复用配方。
 * Phase 3 计划：GBK / BIG5 / UTF-16 编码互转、超大文件流式处理、目录级批处理。
 */

/** 顶部标签页 */
type LabTab = 'find' | 'ops' | 'column' | 'stats';

const TABS: ReadonlyArray<{ id: LabTab; label: string; hint: string }> = [
  { id: 'find', label: '查找替换', hint: '普通 / 正则查找替换，支持捕获组引用与匹配筛选' },
  { id: 'ops', label: '行处理', hint: '去重 / 排序 / 逆序 / 行号 / 注释 / 合并拆分 / 按模式筛选行' },
  { id: 'column', label: '列与包裹', hint: '按分隔符取列、逐行加前后缀、硬折行' },
  { id: 'stats', label: '统计与换行', hint: '行 / 词 / 字符 / 字节 / 去重行数，以及换行风格转换' },
];

/** 持久化状态（关掉工具再打开还在） */
interface LabState {
  text: string;
  find: string;
  replace: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  dotAll: boolean;
  multiline: boolean;
  delimiter: string;
  columnPick: string;
  prefix: string;
  suffix: string;
  wrapWidth: number;
  numberStart: number;
  numberPad: boolean;
  eol: Eol;
  tab: LabTab;
}

/** 示例：Nginx 访问日志（正则筛选 / 取列 / 统计都用得上） */
const SAMPLE_ACCESS_LOG: string = [
  '10.12.3.41 - - [15/Sep/2026:10:12:03 +0800] "GET /api/orders?page=2 HTTP/1.1" 200 1842 0.031',
  '10.12.3.41 - - [15/Sep/2026:10:12:04 +0800] "GET /api/orders?page=3 HTTP/1.1" 200 1904 0.028',
  '10.12.7.9 - - [15/Sep/2026:10:12:05 +0800] "POST /api/pay HTTP/1.1" 502 128 1.204',
  '10.12.7.9 - - [15/Sep/2026:10:12:06 +0800] "POST /api/pay HTTP/1.1" 502 128 1.198',
  '10.12.3.55 - - [15/Sep/2026:10:12:07 +0800] "GET /healthz HTTP/1.1" 200 2 0.002',
  '10.12.3.55 - - [15/Sep/2026:10:12:08 +0800] "GET /healthz HTTP/1.1" 200 2 0.003',
].join('\n');

/** 示例：待排查的 IP 清单（脏数据：重复、大小写混、行尾空格） */
const SAMPLE_IP_LIST: string = [
  '10.12.3.41',
  '10.12.3.41',
  ' 10.12.7.9 ',
  '10.12.3.55',
  '10.12.7.9',
  '192.168.10.204',
  '192.168.10.205',
  '192.168.10.206',
].join('\n');

/** 示例：拼 SQL 的 IN 列表（前后缀的经典用法） */
const SAMPLE_IN_LIST: string = ['US-EAST-1', 'EU-WEST-2', 'AP-EAST-1', 'AP-SOUTHEAST-1'].join('\n');

const INITIAL_STATE: LabState = {
  text: '',
  find: 'ERROR|WARN',
  replace: '',
  regex: true,
  caseSensitive: true,
  wholeWord: false,
  dotAll: false,
  multiline: true,
  delimiter: '\t',
  columnPick: '1',
  prefix: '',
  suffix: '',
  wrapWidth: 80,
  numberStart: 1,
  numberPad: false,
  eol: 'lf',
  tab: 'find',
};

/** 把字符下标换算成行号（1 起；只在首几个匹配上调用，代价可忽略） */
function lineOf(text: string, index: number): number {
  let line: number = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

/** 单个字符/短词的展示（超长截断，避免把界面撑破） */
function shorten(value: string, max: number = 28): string {
  const flat: string = value.replace(/\r?\n/g, '⏎');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 选项开关 chip */
function ToggleChip({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={hint}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-md border px-2 py-1 text-[11px] transition',
        active
          ? 'border-brand/50 bg-brand-muted text-brand'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}

/** 操作按钮（行处理 / 取列等一键动作） */
function ActionChip({
  label,
  hint,
  onClick,
  icon,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  icon?: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={hint}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-left text-xs text-foreground transition hover:border-brand/40 hover:bg-accent/40"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * 文本处理台：查找替换 / 行处理 / 列与包裹 / 统计，就地改写 + 撤销栈。
 */
export function TextLab({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<LabState>(COMMAND_ID, {
    ...INITIAL_STATE,
    text: initialInput || INITIAL_STATE.text,
  });

  /** 撤销栈（不进持久化：草稿续上就够，撤销历史跨会话没有意义） */
  const [undoStack, setUndoStack] = React.useState<string[]>([]);

  const textRef = React.useRef<string>(state.text);
  textRef.current = state.text;

  /** 统一的「改写文本」入口：把当前内容压栈，再写入新内容 */
  const commit = React.useCallback(
    (next: string, note: string): void => {
      const prev: string = textRef.current;
      if (next === prev) {
        toast.info(note.length > 0 ? note : '没有需要改动的行');
        return;
      }
      setUndoStack((stack) => [...stack.slice(-29), prev]);
      patch({ text: next });
      toast.success(note);
    },
    [patch],
  );

  const undo = (): void => {
    setUndoStack((stack) => {
      const last: string | undefined = stack[stack.length - 1];
      if (last === undefined) {
        return stack;
      }
      patch({ text: last });
      return stack.slice(0, -1);
    });
  };

  // ——— 查找参数（多处复用：替换 / 筛选行 / 匹配预览） ———
  const read = React.useMemo(
    () => ({
      find: state.find,
      regex: state.regex,
      caseSensitive: state.caseSensitive,
      wholeWord: state.wholeWord,
      dotAll: state.dotAll,
      multiline: state.multiline,
    }),
    [
      state.find,
      state.regex,
      state.caseSensitive,
      state.wholeWord,
      state.dotAll,
      state.multiline,
    ],
  );

  /** 匹配统计 + 前 3 处上下文（`find` 为空时不算，省一次全量扫描） */
  const preview = React.useMemo(() => {
    if (state.find.length === 0) {
      return { count: 0, lines: 0, samples: [] as Array<{ line: number; value: string }>, error: '' };
    }
    const found = findMatches(state.text, read);
    if (!found.ok) {
      return { count: 0, lines: 0, samples: [], error: found.error ?? '正则语法错误' };
    }
    const touched: Set<number> = new Set<number>();
    const samples: Array<{ line: number; value: string }> = [];
    for (const match of found.matches) {
      const line: number = lineOf(state.text, match.index);
      touched.add(line);
      if (samples.length < 3) {
        samples.push({ line, value: match.value });
      }
    }
    return { count: found.matches.length, lines: touched.size, samples, error: '' };
  }, [state.text, state.find, read]);

  const stats = React.useMemo(() => textStats(state.text), [state.text]);

  /** 行操作上下文 */
  const opContext: LineOpContext = React.useMemo(
    () => ({
      read,
      delimiter: state.delimiter,
      start: state.numberStart,
      padded: state.numberPad,
      random: Math.random,
    }),
    [read, state.delimiter, state.numberStart, state.numberPad],
  );

  /** 执行一个行操作（chips 与「筛选行」按钮共用同一条通道） */
  const runOp = (id: LineOpId): void => {
    const spec: LineOpSpec | undefined = LINE_OPS.find((op) => op.id === id);
    if (spec?.needsPattern === true && state.find.length === 0) {
      toast.error('这个操作需要先在「查找替换」里填写查找内容');
      patch({ tab: 'find' });
      return;
    }
    const result = applyLineOp(state.text, id, opContext);
    if (!result.ok) {
      toast.error(result.error ?? '操作失败');
      return;
    }
    commit(result.text, result.note);
  };

  const doReplace = (): void => {
    const result = replaceAll(state.text, { ...read, replace: state.replace });
    if (!result.ok) {
      toast.error(result.error ?? '替换失败');
      return;
    }
    if (result.count === 0) {
      toast.info('没有找到匹配内容');
      return;
    }
    commit(result.text, `已替换 ${result.count} 处`);
  };

  /** 查找 / 替换框里按 Enter 直接触发「全部替换」（输入法组词中不拦截） */
  const handleFindKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      doReplace();
    }
  };

  const doExtract = (): void => {
    const result = extractMatches(state.text, read, 0, false);
    if (!result.ok) {
      toast.error(result.error ?? '提取失败');
      return;
    }
    if (result.count === 0) {
      toast.info('没有找到匹配内容');
      return;
    }
    commit(result.text, `已提取 ${result.count} 处匹配（每行一条）`);
  };

  const doPickColumns = (): void => {
    const result = pickColumns(state.text, state.delimiter, state.columnPick, true);
    if (!result.ok) {
      toast.error(result.error ?? '取列失败');
      return;
    }
    commit(result.text, result.note);
  };

  const doAffix = (): void => {
    if (state.prefix.length === 0 && state.suffix.length === 0) {
      toast.error('请先填写前缀或后缀');
      return;
    }
    commit(affixLines(state.text, state.prefix, state.suffix), '已给每行加上前后缀');
  };

  const doWrap = (): void => {
    commit(wrapLines(state.text, state.wrapWidth), `已按 ${state.wrapWidth} 字硬折行`);
  };

  const doEol = (eol: Eol): void => {
    patch({ eol });
    const count: number = splitLines(state.text).length;
    commit(convertEol(state.text, eol), `换行风格已统一为 ${eol === 'lf' ? 'LF（Unix）' : eol === 'crlf' ? 'CRLF（Windows）' : 'CR（旧 Mac）'}（${count} 行）`);
  };

  const grouped: ReadonlyArray<{ group: LineOpGroup; items: LineOpSpec[] }> = React.useMemo(() => {
    const order: LineOpGroup[] = ['清洗', '排序与重排', '行号与注释', '合并与拆分', '按模式筛选'];
    return order.map((group) => ({
      group,
      items: LINE_OPS.filter((op) => op.group === group),
    }));
  }, []);

  const eolNow: Eol = React.useMemo(() => detectEol(state.text), [state.text]);

  return (
    <CommandShell
      title="文本处理台"
      onPaste={(t) => patch({ text: t })}
      description="查找替换（正则/捕获组） · 行处理 · 取列 · 统计 —— 就地改写，随时撤销"
      icon={<Search className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={state.text}
      fill
      shortcutHint={`${stats.lines} 行 · ${stats.words} 词 · ${stats.chars} 字符 · ${formatBytes(stats.bytes)}${undoStack.length > 0 ? ` · 可撤销 ${undoStack.length} 步` : ''}`}
      samples={[
        {
          label: 'Nginx 日志挑错',
          description: '把日志铺进来，试着「只留匹配行」筛 502、或取第 9 列看耗时',
          apply: () => {
            patch({ text: SAMPLE_ACCESS_LOG, tab: 'find', find: '502' });
            setUndoStack([]);
          },
        },
        {
          label: 'IP 清单清洗',
          description: '演示：去首尾空白 → 去重 → 排序，三步把脏清单理干净',
          apply: () => {
            patch({ text: SAMPLE_IP_LIST, tab: 'ops', delimiter: '\t', columnPick: '1' });
            setUndoStack([]);
          },
        },
        {
          label: '拼 SQL IN 列表',
          description: '演示「列与包裹」：每行加前缀 `\'` 与后缀 `\',`，直接贴进 IN (...)',
          apply: () => {
            patch({ text: SAMPLE_IN_LIST, tab: 'column', prefix: "'", suffix: "'," });
            setUndoStack([]);
          },
        },
        {
          label: '正则提取',
          description: '用 `\\d+\\.\\d+\\.\\d+\\.\\d+` 正则把文本里所有 IP 抠出来',
          apply: () => {
            patch({
              text: SAMPLE_ACCESS_LOG,
              tab: 'find',
              regex: true,
              find: '\\d+\\.\\d+\\.\\d+\\.\\d+',
              replace: '',
            });
            setUndoStack([]);
          },
        },
      ]}
    >
      <div className="scrollbar-thin flex h-full min-h-0 flex-col gap-3 overflow-y-auto pr-1">
        {/* ——— 大文本区（唯一工作区，操作就地生效） ——— */}
        <div className="flex min-h-[132px] flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <label className="text-sm font-medium text-foreground" htmlFor="lab-text">
              文本
            </label>
            <span className="text-[11px] text-muted-foreground">
              操作直接作用于这段文本，改完在下方「撤销」即可回退
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs"
                disabled={undoStack.length === 0}
                onClick={undo}
                title="回退上一次操作"
              >
                <Undo2 className="mr-1 h-3.5 w-3.5" />
                撤销{undoStack.length > 0 ? ` (${undoStack.length})` : ''}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs"
                disabled={state.text.length === 0}
                onClick={() => {
                  setUndoStack((stack) => [...stack.slice(-29), state.text]);
                  patch({ text: '' });
                }}
                title="清空文本（可撤销）"
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                清空
              </Button>
            </div>
          </div>
          <textarea
            id="lab-text"
            autoFocus
            spellCheck={false}
            value={state.text}
            onChange={(event) => patch({ text: event.target.value })}
            placeholder={'把要处理的文本贴进来：\n\n· 日志 / 清单：用「行处理」去重、排序、按正则筛行\n· 表格 / 日志列：用「列与包裹」按分隔符取列\n· 批量改名 / 拼 SQL：用「列与包裹」加前后缀\n· 上面点一条示例，三秒看懂它能干什么'}
            className="scrollbar-thin w-full min-h-0 flex-1 resize-none rounded-xl border border-input bg-transparent px-3 py-2 font-mono text-[12.5px] leading-relaxed shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        {/* ——— 操作台（标签页；一行只占一份高度，窄窗口也不挤） ——— */}
        <div className="shrink-0 rounded-xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                title={tab.hint}
                aria-pressed={state.tab === tab.id}
                onClick={() => patch({ tab: tab.id })}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs transition',
                  state.tab === tab.id
                    ? 'bg-brand-muted font-medium text-brand'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
            <span className="ml-auto hidden min-w-0 truncate text-[11px] text-muted-foreground lg:inline">
              {TABS.find((tab) => tab.id === state.tab)?.hint ?? ''}
            </span>
          </div>

          <div className="scrollbar-thin max-h-[46vh] min-h-0 overflow-y-auto p-3">
            {/* ——— 查找替换 ——— */}
            {state.tab === 'find' ? (
              <div className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <ToggleChip
                    active={!state.regex}
                    label="普通文本"
                    hint="按字面量查找，`*` `(` `.` 都不特殊"
                    onClick={() => patch({ regex: false })}
                  />
                  <ToggleChip
                    active={state.regex}
                    label="正则"
                    hint="按正则表达式查找，支持捕获组与 $1 引用"
                    onClick={() => patch({ regex: true })}
                  />
                  <span className="mx-1 h-4 w-px bg-border" />
                  <ToggleChip
                    active={state.caseSensitive}
                    label="区分大小写"
                    hint="打开后 `Error` 与 `error` 不再互相匹配"
                    onClick={() => patch({ caseSensitive: !state.caseSensitive })}
                  />
                  <ToggleChip
                    active={state.wholeWord}
                    label="全词"
                    hint="只匹配完整单词，`cat` 不会命中 `category`"
                    onClick={() => patch({ wholeWord: !state.wholeWord })}
                  />
                  <ToggleChip
                    active={state.dotAll}
                    label=". 含换行"
                    hint="正则模式下让 `.` 也能匹配换行符（s 标志）"
                    onClick={() => patch({ dotAll: !state.dotAll })}
                  />
                  <ToggleChip
                    active={state.multiline}
                    label="^$ 按行"
                    hint="正则模式下让 `^` `$` 匹配每行的首尾（m 标志）"
                    onClick={() => patch({ multiline: !state.multiline })}
                  />
                </div>

                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">查找</span>
                    <input
                      value={state.find}
                      spellCheck={false}
                      onChange={(event) => patch({ find: event.target.value })}
                      onKeyDown={handleFindKeyDown}
                      placeholder={state.regex ? 'ERROR|WARN 或 \\d+\\.\\d+' : '输入要查找的文本'}
                      className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-xs text-foreground"
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">
                      替换为（可用 $1 $2 引用捕获组，$& 表示整段匹配；普通 `$` 写 `$$`）
                    </span>
                    <input
                      value={state.replace}
                      spellCheck={false}
                      onChange={(event) => patch({ replace: event.target.value })}
                      onKeyDown={handleFindKeyDown}
                      placeholder="留空 = 删除匹配内容（按 Enter 直接替换）"
                      className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-xs text-foreground"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button size="sm" className="h-7 px-2.5 text-xs" onClick={doReplace}>
                    <ArrowLeftRight className="mr-1 h-3.5 w-3.5" />
                    全部替换
                  </Button>
                  <ActionChip
                    label="提取匹配"
                    hint="把所有匹配结果抽出来，每行一条（常用于「从日志里捞 IP / 订单号」）"
                    onClick={doExtract}
                  />
                  <ActionChip
                    label="只留匹配行"
                    hint="删除不包含匹配内容的整行"
                    icon={<Regex className="h-3.5 w-3.5 text-muted-foreground" />}
                    onClick={() => runOp('keep-matching')}
                  />
                  <ActionChip
                    label="删掉匹配行"
                    hint="把包含匹配内容的整行删掉（过滤日志噪音最常用）"
                    onClick={() => runOp('drop-matching')}
                  />
                </div>

                {/* 匹配概览 */}
                <div className="rounded-lg bg-muted/50 px-2.5 py-2 text-[11px] text-muted-foreground">
                  {preview.error.length > 0 ? (
                    <span className="text-destructive">正则有误：{preview.error}</span>
                  ) : state.find.length === 0 ? (
                    <span>填写「查找」后这里会显示匹配数量与位置。</span>
                  ) : preview.count === 0 ? (
                    <span>没有匹配到内容。</span>
                  ) : (
                    <span>
                      匹配 <b className="text-foreground">{preview.count}</b> 处，涉及{' '}
                      <b className="text-foreground">{preview.lines}</b> 行：
                      {preview.samples.map((sample) => (
                        <span key={`${sample.line}-${sample.value}`} className="ml-1.5">
                          第 {sample.line} 行「
                          <code className="rounded bg-card px-1 font-mono">{shorten(sample.value)}</code>
                          」
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            ) : null}

            {/* ——— 行处理 ——— */}
            {state.tab === 'ops' ? (
              <div className="flex flex-col gap-3">
                {grouped.map((bucket) => (
                  <div key={bucket.group}>
                    <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                      {bucket.group}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {bucket.items.map((op) => (
                        <ActionChip
                          key={op.id}
                          label={op.label}
                          hint={op.hint}
                          onClick={() => runOp(op.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <div className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/40 p-2.5">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">行号起始</span>
                    <input
                      type="number"
                      value={state.numberStart}
                      onChange={(event) => patch({ numberStart: Number(event.target.value) || 1 })}
                      className="w-20 rounded-md border border-input bg-transparent px-2 py-1 text-xs text-foreground"
                    />
                  </label>
                  <label className="flex items-center gap-2 pb-1 text-[11px] text-foreground">
                    <input
                      type="checkbox"
                      checked={state.numberPad}
                      onChange={(event) => patch({ numberPad: event.target.checked })}
                      className="h-3.5 w-3.5"
                    />
                    行号补零（0001）
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">合并 / 拆分用分隔符</span>
                    <input
                      value={state.delimiter === '\t' ? '\\t' : state.delimiter}
                      spellCheck={false}
                      onChange={(event) =>
                        patch({
                          delimiter: event.target.value === '\\t' ? '\t' : event.target.value,
                        })
                      }
                      className="w-28 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs text-foreground"
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {/* ——— 列与包裹 ——— */}
            {state.tab === 'column' ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">分隔符（\t 表示 Tab）</span>
                    <input
                      value={state.delimiter === '\t' ? '\\t' : state.delimiter}
                      spellCheck={false}
                      onChange={(event) =>
                        patch({
                          delimiter: event.target.value === '\\t' ? '\t' : event.target.value,
                        })
                      }
                      className="w-28 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs text-foreground"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">取第几列（如 1、2,4、2-4）</span>
                    <input
                      value={state.columnPick}
                      spellCheck={false}
                      onChange={(event) => patch({ columnPick: event.target.value })}
                      className="w-32 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs text-foreground"
                    />
                  </label>
                  <Button size="sm" className="h-7 px-2.5 text-xs" onClick={doPickColumns}>
                    <Columns3 className="mr-1 h-3.5 w-3.5" />
                    取列
                  </Button>
                </div>

                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">前缀</span>
                    <input
                      value={state.prefix}
                      spellCheck={false}
                      onChange={(event) => patch({ prefix: event.target.value })}
                      placeholder="如 '"
                      className="w-28 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs text-foreground"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">后缀</span>
                    <input
                      value={state.suffix}
                      spellCheck={false}
                      onChange={(event) => patch({ suffix: event.target.value })}
                      placeholder="如 ',"
                      className="w-28 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs text-foreground"
                    />
                  </label>
                  <Button size="sm" className="h-7 px-2.5 text-xs" onClick={doAffix}>
                    <Layers className="mr-1 h-3.5 w-3.5" />
                    加前后缀
                  </Button>
                  <span className="pb-1 text-[11px] text-muted-foreground">
                    空行默认跳过
                  </span>
                </div>

                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">折行宽度（字符）</span>
                    <input
                      type="number"
                      min={10}
                      max={400}
                      value={state.wrapWidth}
                      onChange={(event) => patch({ wrapWidth: Number(event.target.value) || 80 })}
                      className="w-24 rounded-md border border-input bg-transparent px-2 py-1 text-xs text-foreground"
                    />
                  </label>
                  <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={doWrap}>
                    硬折行
                  </Button>
                  <span className="flex items-center gap-1 pb-1 text-[11px] text-muted-foreground">
                    <Info className="h-3 w-3" />
                    按固定宽度切，不做智能断词
                  </span>
                </div>
              </div>
            ) : null}

            {/* ——— 统计与换行 ——— */}
            {state.tab === 'stats' ? (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {[
                    { label: '行数', value: String(stats.lines) },
                    { label: '非空行', value: String(stats.nonEmptyLines) },
                    { label: '去重后行数', value: String(stats.uniqueLines) },
                    { label: '词数', value: String(stats.words) },
                    { label: '字符数', value: String(stats.chars) },
                    { label: 'UTF-8 字节', value: formatBytes(stats.bytes) },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="rounded-lg border border-border bg-background px-2.5 py-2"
                    >
                      <p className="text-[10.5px] text-muted-foreground">{item.label}</p>
                      <p className="mt-0.5 font-mono text-sm font-medium text-foreground">
                        {item.value}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    当前换行风格：
                    <b className="text-foreground">
                      {eolNow === 'crlf' ? 'CRLF（Windows）' : eolNow === 'cr' ? 'CR（旧 Mac）' : 'LF（Unix）'}
                    </b>
                    {stats.longestLine > 0 ? ` · 最长行 ${stats.longestLine} 字符` : ''}
                  </span>
                  <span className="mx-1 h-4 w-px bg-border" />
                  <ActionChip
                    label="统一成 LF"
                    hint="Linux / 容器 / git 场景：把 Windows 风格换行转成 LF"
                    onClick={() => doEol('lf')}
                  />
                  <ActionChip
                    label="统一成 CRLF"
                    hint="Windows 记事本 / 部分老工具需要 CRLF"
                    onClick={() => doEol('crlf')}
                  />
                  <ActionChip
                    label="统一成 CR"
                    hint="仅旧 Mac 文本才需要，一般用不上"
                    onClick={() => doEol('cr')}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* ——— 底部状态（含「上一句提示」式的操作反馈） ——— */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <BarChart3 className="h-3.5 w-3.5" />
            {stats.lines} 行 · {stats.nonEmptyLines} 非空 · {stats.words} 词 · {stats.chars} 字符 ·{' '}
            {formatBytes(stats.bytes)}
          </span>
          <span className="flex items-center gap-1">
            <Sparkles className="h-3.5 w-3.5" />
            所有处理都在本机完成，文本不上传
          </span>
        </div>
      </div>
    </CommandShell>
  );
}

export default TextLab;
