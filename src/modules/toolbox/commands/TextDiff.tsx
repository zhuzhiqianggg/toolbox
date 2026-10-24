import * as React from 'react';
import { ArrowLeftRight, ChevronsUpDown, Download, FileDiff, ListFilter, Ungroup } from 'lucide-react';
import { diffChars, diffLines, diffWords } from 'diff';
import { CommandShell } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'text-diff';

/** 对比粒度 */
type Granularity = 'line' | 'word' | 'char';
/** 视图模式 */
type ViewMode = 'split' | 'inline';
/** 差异行类型 */
type RowKind = 'same' | 'added' | 'removed' | 'modified';
/** 行内片段标记 */
type SegMark = 'same' | 'added' | 'removed';

/** 行内片段（用于字符 / 单词级高亮） */
interface Seg {
  text: string;
  mark: SegMark;
}

/** 一侧的一行 */
interface SideLine {
  /** 行号（1 起） */
  no: number;
  /** 行内片段（行粒度时只有一段） */
  segs: Seg[];
  /** 该行纯文本 */
  text: string;
}

interface DiffRow {
  kind: RowKind;
  left: SideLine | null;
  right: SideLine | null;
}

/** 忽略选项 */
interface IgnoreOptions {
  /** 忽略首尾空白 */
  trimWhitespace: boolean;
  /** 忽略全部空白 */
  ignoreAllWhitespace: boolean;
  /** 忽略大小写 */
  ignoreCase: boolean;
  /** 忽略空行 */
  ignoreEmptyLines: boolean;
}

interface DiffStats {
  added: number;
  removed: number;
  modified: number;
  same: number;
  /** 相似度百分比（0-100） */
  similarity: number;
}

/** 滚动条差异指示标记（以百分比定位在滚动容器内） */
interface DiffMark {
  top: number;
  height: number;
  kind: RowKind;
  rowIndex: number;
}

/** 渲染条目：一行，或一段被折叠的未变更区块 */
type RenderItem = { kind: 'row'; index: number } | { kind: 'gap'; start: number; end: number };

/** 持久化的工具状态（关掉再打开不丢） */
interface DiffToolState {
  textA: string;
  textB: string;
  mode: ViewMode;
  granularity: Granularity;
  options: IgnoreOptions;
  collapse: boolean;
  showInputs: boolean;
  showDiffList: boolean;
}

const INITIAL_STATE: DiffToolState = {
  textA: '',
  textB: '',
  mode: 'split',
  granularity: 'line',
  options: {
    trimWhitespace: false,
    ignoreAllWhitespace: false,
    ignoreCase: false,
    ignoreEmptyLines: false,
  },
  collapse: true,
  showInputs: true,
  showDiffList: true,
};

/** 渲染保护：超大批量只渲染前 N 行，避免 DOM 爆炸卡死 */
const MAX_RENDER_ROWS = 4000;
/** 字符级对比的文本长度上限（jsdiff diffChars 为 O(n·m)，超限降级为行级） */
const CHAR_DIFF_LIMIT = 20_000;
/** 单词级对比的文本长度上限 */
const WORD_DIFF_LIMIT = 200_000;
/** unified diff 上下文行数 */
const CONTEXT_LINES = 3;
/** 折叠区块保留的上下文行数（上下各留这么多） */
const COLLAPSE_CONTEXT = 3;
/** 未变更行超过这个数量才折叠（少于此数折叠反而更烦） */
const COLLAPSE_MIN_RUN = 8;

/** 把 diff 块文本拆成行（丢弃末尾因换行产生的空串）。 */
function toLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** 按忽略选项归一化文本（逐行处理，保持行数语义） */
function normalizeText(text: string, options: IgnoreOptions): string {
  let lines = text.split('\n');
  if (options.ignoreEmptyLines) {
    lines = lines.filter((line) => line.trim().length > 0);
  }
  if (options.trimWhitespace) {
    lines = lines.map((line) => line.trim());
  }
  if (options.ignoreAllWhitespace) {
    lines = lines.map((line) => line.replace(/\s+/g, ''));
  }
  if (options.ignoreCase) {
    lines = lines.map((line) => line.toLowerCase());
  }
  return lines.join('\n');
}

/** 行片段拼接为纯文本 */
function segsToText(segs: readonly Seg[]): string {
  let text = '';
  for (const seg of segs) {
    text += seg.text;
  }
  return text;
}

/** 修改行的行内片段：对左右两行再做一次词 / 字符级 diff */
function inlineSegs(leftText: string, rightText: string, granularity: Granularity): { left: Seg[]; right: Seg[] } {
  const changes = granularity === 'char' ? diffChars(leftText, rightText) : diffWords(leftText, rightText);
  const left: Seg[] = [];
  const right: Seg[] = [];
  for (const change of changes) {
    if (change.added) {
      right.push({ text: change.value, mark: 'added' });
      continue;
    }
    if (change.removed) {
      left.push({ text: change.value, mark: 'removed' });
      continue;
    }
    left.push({ text: change.value, mark: 'same' });
    right.push({ text: change.value, mark: 'same' });
  }
  return { left, right };
}

/** 行粒度：基于 diffLines 构建对齐行 */
function buildLineRows(leftText: string, rightText: string, granularity: Granularity): DiffRow[] {
  const changes = diffLines(leftText, rightText);
  const rows: DiffRow[] = [];
  let aNo = 0;
  let bNo = 0;
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];
    if (!change) {
      break;
    }
    if (change.added) {
      for (const text of toLines(change.value)) {
        bNo += 1;
        rows.push({
          kind: 'added',
          left: null,
          right: { no: bNo, text, segs: [{ text, mark: 'added' }] },
        });
      }
      i += 1;
      continue;
    }
    if (change.removed) {
      const next = changes[i + 1];
      const addedLines = next && next.added ? toLines(next.value) : [];
      const removedLines = toLines(change.value);
      const max = Math.max(removedLines.length, addedLines.length);
      for (let k = 0; k < max; k += 1) {
        const leftRaw = removedLines[k];
        const rightRaw = addedLines[k];
        let left: SideLine | null = null;
        let right: SideLine | null = null;
        if (typeof leftRaw === 'string') {
          aNo += 1;
          left = { no: aNo, text: leftRaw, segs: [{ text: leftRaw, mark: 'removed' }] };
        }
        if (typeof rightRaw === 'string') {
          bNo += 1;
          right = { no: bNo, text: rightRaw, segs: [{ text: rightRaw, mark: 'added' }] };
        }
        if (left !== null && right !== null) {
          const inline = inlineSegs(left.text, right.text, granularity);
          left.segs = inline.left;
          right.segs = inline.right;
          rows.push({ kind: 'modified', left, right });
          continue;
        }
        rows.push({ kind: left !== null ? 'removed' : 'added', left, right });
      }
      i += next && next.added ? 2 : 1;
      continue;
    }
    for (const text of toLines(change.value)) {
      aNo += 1;
      bNo += 1;
      rows.push({
        kind: 'same',
        left: { no: aNo, text, segs: [{ text, mark: 'same' }] },
        right: { no: bNo, text, segs: [{ text, mark: 'same' }] },
      });
    }
    i += 1;
  }
  return rows;
}

/** 行缓冲条目（词 / 字符粒度用） */
interface Entry {
  leftSegs: Seg[];
  rightSegs: Seg[];
  blank: boolean;
  mark: SegMark;
}

function newEntry(): Entry {
  return { leftSegs: [], rightSegs: [], blank: false, mark: 'same' };
}

/** 词 / 字符粒度：把 diff 片段流按换行切分并重建成对齐行 */
function buildTokenRows(leftText: string, rightText: string, granularity: Granularity): DiffRow[] {
  const changes = granularity === 'char' ? diffChars(leftText, rightText) : diffWords(leftText, rightText);
  const entries: Entry[] = [];
  let current = newEntry();
  let lineContent = false;
  let lineMark: SegMark = 'same';

  const flush = (): void => {
    if (current.leftSegs.length > 0 || current.rightSegs.length > 0 || current.blank) {
      entries.push(current);
    }
    current = newEntry();
    lineContent = false;
    lineMark = 'same';
  };

  for (const change of changes) {
    const mark: SegMark = change.added ? 'added' : change.removed ? 'removed' : 'same';
    if (mark !== 'same') {
      lineMark = mark;
    }
    const pieces = change.value.split('\n');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i] ?? '';
      if (piece.length > 0) {
        if (mark !== 'added') {
          current.leftSegs.push({ text: piece, mark });
        }
        if (mark !== 'removed') {
          current.rightSegs.push({ text: piece, mark });
        }
        lineContent = true;
      }
      if (i < pieces.length - 1) {
        if (!lineContent) {
          current.blank = true;
          current.mark = lineMark;
        }
        flush();
      }
    }
  }
  flush();

  const rows: DiffRow[] = [];
  let aNo = 0;
  let bNo = 0;
  for (const entry of entries) {
    if (entry.blank) {
      if (entry.mark === 'added') {
        bNo += 1;
        rows.push({ kind: 'added', left: null, right: { no: bNo, segs: [], text: '' } });
      } else if (entry.mark === 'removed') {
        aNo += 1;
        rows.push({ kind: 'removed', left: { no: aNo, segs: [], text: '' }, right: null });
      } else {
        aNo += 1;
        bNo += 1;
        rows.push({
          kind: 'same',
          left: { no: aNo, segs: [], text: '' },
          right: { no: bNo, segs: [], text: '' },
        });
      }
      continue;
    }

    const leftText = segsToText(entry.leftSegs);
    const rightText = segsToText(entry.rightSegs);
    const leftRemoved = entry.leftSegs.some((seg) => seg.mark === 'removed');
    const rightAdded = entry.rightSegs.some((seg) => seg.mark === 'added');
    const kind: RowKind =
      leftRemoved && rightAdded
        ? 'modified'
        : leftRemoved
          ? 'removed'
          : rightAdded
            ? 'added'
            : 'same';

    if (kind === 'removed') {
      aNo += 1;
      rows.push({ kind, left: { no: aNo, segs: entry.leftSegs, text: leftText }, right: null });
      continue;
    }
    if (kind === 'added') {
      bNo += 1;
      rows.push({ kind, left: null, right: { no: bNo, segs: entry.rightSegs, text: rightText } });
      continue;
    }
    aNo += 1;
    bNo += 1;
    rows.push({
      kind,
      left: { no: aNo, segs: entry.leftSegs, text: leftText },
      right: { no: bNo, segs: entry.rightSegs, text: rightText },
    });
  }
  return rows;
}

/** 统计各类行数与相似度 */
function computeStats(rows: readonly DiffRow[], leftText: string, rightText: string): DiffStats {
  let added = 0;
  let removed = 0;
  let modified = 0;
  let same = 0;
  let common = 0;

  for (const row of rows) {
    if (row.kind === 'added') {
      added += 1;
      continue;
    }
    if (row.kind === 'removed') {
      removed += 1;
    } else if (row.kind === 'modified') {
      modified += 1;
    } else {
      same += 1;
    }
    if (row.left !== null) {
      for (const seg of row.left.segs) {
        if (seg.mark === 'same') {
          common += seg.text.length;
        }
      }
    }
  }

  const total = leftText.length + rightText.length;
  const similarity = total === 0 ? 100 : Math.max(0, Math.min(100, Math.round((200 * common) / total)));
  return { added, removed, modified, same, similarity };
}

/** 差异行 → unified diff 操作序列 */
interface PatchOp {
  type: ' ' | '-' | '+';
  text: string;
}

function toOps(rows: readonly DiffRow[]): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const row of rows) {
    if (row.kind === 'same') {
      ops.push({ type: ' ', text: row.left?.text ?? '' });
      continue;
    }
    if (row.left !== null) {
      ops.push({ type: '-', text: row.left.text });
    }
    if (row.right !== null) {
      ops.push({ type: '+', text: row.right.text });
    }
  }
  return ops;
}

/** 生成 unified diff 文本（`--- 原文` / `+++ 新文` / `@@` 块） */
function buildUnifiedPatch(rows: readonly DiffRow[], nameA: string, nameB: string): string {
  const ops = toOps(rows);
  if (ops.length === 0) {
    return `--- ${nameA}\n+++ ${nameB}\n`;
  }

  const changed: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (op && op.type !== ' ') {
      changed.push(i);
    }
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const last = ranges[ranges.length - 1];
    if (last && index - last.end <= CONTEXT_LINES * 2) {
      last.end = index;
    } else {
      ranges.push({ start: index, end: index });
    }
  }

  const lines: string[] = [`--- ${nameA}`, `+++ ${nameB}`];
  for (const range of ranges) {
    const from = Math.max(0, range.start - CONTEXT_LINES);
    const to = Math.min(ops.length, range.end + 1 + CONTEXT_LINES);
    let aCountBefore = 0;
    let bCountBefore = 0;
    for (let i = 0; i < from; i += 1) {
      const op = ops[i];
      if (!op) {
        continue;
      }
      if (op.type === ' ' || op.type === '-') {
        aCountBefore += 1;
      }
      if (op.type === ' ' || op.type === '+') {
        bCountBefore += 1;
      }
    }
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let i = from; i < to; i += 1) {
      const op = ops[i];
      if (!op) {
        continue;
      }
      body.push(`${op.type}${op.text}`);
      if (op.type === ' ' || op.type === '-') {
        aCount += 1;
      }
      if (op.type === ' ' || op.type === '+') {
        bCount += 1;
      }
    }
    lines.push(`@@ -${aCountBefore + 1},${aCount} +${bCountBefore + 1},${bCount} @@`);
    lines.push(...body);
  }
  return `${lines.join('\n')}\n`;
}

/** 合并结果：未显式选择时默认取右侧（B），可逐块覆盖 */
function buildMergedText(rows: readonly DiffRow[], resolutions: Readonly<Record<number, 'left' | 'right'>>): string {
  const lines: string[] = [];
  rows.forEach((row, index) => {
    if (row.kind === 'same') {
      lines.push(row.left?.text ?? '');
      return;
    }
    const choice = resolutions[index] ?? 'right';
    if (row.kind === 'removed') {
      if (choice === 'left') {
        lines.push(row.left?.text ?? '');
      }
      return;
    }
    if (row.kind === 'added') {
      if (choice === 'right') {
        lines.push(row.right?.text ?? '');
      }
      return;
    }
    lines.push(choice === 'left' ? (row.left?.text ?? '') : (row.right?.text ?? ''));
  });
  return lines.join('\n');
}

/**
 * 计算渲染条目：把「连续未变更行」折起来（保留上下文），其余逐行渲染。
 *
 * # 为什么要折叠
 *
 * 真实对比（两份配置文件、两版代码）往往 90% 是相同的，逐行铺开的结果就是
 * 「翻十屏才看到一处差异」。
 *
 * # 与「对齐」的关系
 *
 * 折叠只影响**渲染**，不影响行结构：`DiffRow` 里左右两侧依然是同一索引的配对行，
 * 缺口（对面多出来的行）依然是 `null` → 渲染成虚线占位块。所以相同行永远同行、
 * 缺口永远虚拟空出，不会因为折叠而错位。
 */
function buildRenderItems(
  rows: readonly DiffRow[],
  collapse: boolean,
  expanded: ReadonlySet<number>,
): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    const isSame = row !== undefined && row.kind === 'same';
    if (isSame && collapse) {
      let j = i;
      while (j < rows.length && rows[j]?.kind === 'same') {
        j += 1;
      }
      const count = j - i;
      if (count >= COLLAPSE_MIN_RUN && !expanded.has(i)) {
        for (let k = i; k < i + COLLAPSE_CONTEXT; k += 1) {
          items.push({ kind: 'row', index: k });
        }
        items.push({ kind: 'gap', start: i + COLLAPSE_CONTEXT, end: j - COLLAPSE_CONTEXT - 1 });
        for (let k = j - COLLAPSE_CONTEXT; k < j; k += 1) {
          items.push({ kind: 'row', index: k });
        }
      } else {
        for (let k = i; k < j; k += 1) {
          items.push({ kind: 'row', index: k });
        }
      }
      i = j;
      continue;
    }
    items.push({ kind: 'row', index: i });
    i += 1;
  }
  return items;
}

/** 触发浏览器下载 */
function downloadFile(fileName: string, content: string): void {
  try {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    toast.error(`下载失败：${message}`);
  }
}

/** 行内片段渲染（变化字符用更深底色） */
function Segments({ segs }: { segs: readonly Seg[] }): React.JSX.Element {
  return (
    <span className="whitespace-pre-wrap break-all">
      {segs.length === 0 ? (
        <span>&nbsp;</span>
      ) : (
        segs.map((seg, index) => (
          <span
            key={index}
            className={cn(
              seg.mark === 'added' && 'rounded-sm bg-emerald-300/80 text-emerald-950',
              seg.mark === 'removed' && 'rounded-sm bg-red-300/80 text-red-950',
            )}
          >
            {seg.text}
          </span>
        ))
      )}
    </span>
  );
}

/**
 * 单侧单元格。
 *
 * `line === null` 表示「对面这一行多出来 / 少了」——渲染成**虚线占位块**而不是塌掉，
 * 这是保证左右逐行对齐的关键（用户反馈：「空行也要虚拟空出对齐」）。
 */
function DiffCell({
  line,
  kind,
  side,
  active = false,
  id,
}: {
  line: SideLine | null;
  kind: RowKind;
  side: 'left' | 'right';
  active?: boolean;
  id?: string;
}): React.JSX.Element {
  if (line === null) {
    return (
      <div
        id={id}
        title="对面在这一行有内容，本侧没有（虚拟空出以保持逐行对齐）"
        className="min-h-[22px] rounded border border-dashed border-neutral-300/70 bg-neutral-100/40 dark:border-neutral-700 dark:bg-neutral-800/30"
        aria-hidden="true"
      />
    );
  }
  const isAdded = side === 'right' && (kind === 'added' || kind === 'modified');
  const isRemoved = side === 'left' && (kind === 'removed' || kind === 'modified');
  const marker = isAdded ? '+' : isRemoved ? '-' : ' ';
  return (
    <div
      id={id}
      className={cn(
        'flex min-h-[22px] items-start gap-2 rounded px-2 py-0.5 font-mono text-xs leading-5',
        isAdded && 'bg-emerald-100 dark:bg-emerald-950/40',
        isRemoved && 'bg-red-100 dark:bg-red-950/40',
        active && 'ring-2 ring-inset ring-brand',
      )}
    >
      <span className="w-9 shrink-0 select-none text-right text-muted-foreground/70 tabular-nums">
        {line.no}
      </span>
      <span
        className={cn(
          'w-3 shrink-0 select-none font-semibold',
          isAdded && 'text-emerald-700 dark:text-emerald-400',
          isRemoved && 'text-red-700 dark:text-red-400',
          !isAdded && !isRemoved && 'text-muted-foreground/40',
        )}
      >
        {marker}
      </span>
      <Segments segs={line.segs} />
    </div>
  );
}

/** 小开关按钮（忽略选项用） */
function ToggleChip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'rounded-md border px-2 py-0.5 text-xs transition-colors',
        active
          ? 'border-brand/40 bg-brand-muted text-brand'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}

/**
 * 文本对比（V20 重构）。
 *
 * # 用户反馈
 *
 * 「要跟 PyCharm / VSCode 对比插件一样：可以分两列查看或者统一查看，两列查看需要统一对齐，
 *   相同的行要在同行对齐展示，空行和需要虚拟展示空缺，但是要保证相同的行跟随整体对齐……
 *   颜色现在的可以就是功能需要优化，现在左右没有跟随基准行滚动。」
 *
 * # 这一版改了三件事
 *
 * 1. **对齐 + 同步滚动一次解决**：并排视图不再用「两个独立滚动容器」，
 *    改成**一个滚动容器 + CSS 网格两列** —— 行对行天然对齐（同一行索引共用一个网格行），
 *    滚动天然同步（本来就是一个滚动条）。旧版两个容器各滚各的，正是用户抱怨的点；
 * 2. **缺口虚拟空出**：对面多出来的行渲染成虚线占位块，相同行永远同行；
 * 3. **折叠未变更区块**：相同的连续行折起来（上下各留 3 行上下文），
 *    点击「展开 N 行」原地展开 —— 大文件里直奔差异，不用翻十屏。
 *
 * 另外：输入区可折叠，表达式与文本经 `useToolState` 持久化，
 * 关掉工具 / 最小化后再打开，原来对比的两段文本还在（用户反馈 #3）。
 */
export function TextDiff({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<DiffToolState>(COMMAND_ID, {
    ...INITIAL_STATE,
    textA: initialInput || INITIAL_STATE.textA,
  });
  const { textA, textB, mode, granularity, options, collapse } = state;

  const [mergeMode, setMergeMode] = React.useState<boolean>(false);
  const [resolutions, setResolutions] = React.useState<Record<number, 'left' | 'right'>>({});
  const [activeDiff, setActiveDiff] = React.useState<number>(0);
  /** 已展开的折叠区块（键 = 区块起始行索引） */
  const [expanded, setExpanded] = React.useState<ReadonlySet<number>>(() => new Set<number>());
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const normalizedA = React.useMemo<string>(() => normalizeText(textA, options), [textA, options]);
  const normalizedB = React.useMemo<string>(() => normalizeText(textB, options), [textB, options]);

  const tooLongForGranularity =
    (granularity === 'char' &&
      (normalizedA.length > CHAR_DIFF_LIMIT || normalizedB.length > CHAR_DIFF_LIMIT)) ||
    (granularity === 'word' &&
      (normalizedA.length > WORD_DIFF_LIMIT || normalizedB.length > WORD_DIFF_LIMIT));

  const rows = React.useMemo<DiffRow[] | null>(() => {
    if (normalizedA.length === 0 && normalizedB.length === 0) {
      return null;
    }
    if (tooLongForGranularity || granularity === 'line') {
      return buildLineRows(normalizedA, normalizedB, granularity);
    }
    return buildTokenRows(normalizedA, normalizedB, granularity);
  }, [normalizedA, normalizedB, granularity, tooLongForGranularity]);

  const stats = React.useMemo<DiffStats | null>(
    () => (rows === null ? null : computeStats(rows, normalizedA, normalizedB)),
    [rows, normalizedA, normalizedB],
  );

  const unified = React.useMemo<string>(
    () => (rows === null ? '' : buildUnifiedPatch(rows, '原文 A', '新文 B')),
    [rows],
  );

  const merged = React.useMemo<string>(
    () => (rows === null ? '' : buildMergedText(rows, resolutions)),
    [rows, resolutions],
  );

  const hasDiff = rows !== null && rows.some((row) => row.kind !== 'same');

  // 粒度 / 忽略项变化会重建行结构：逐块合并选择与折叠展开态都必须重置
  React.useEffect(() => {
    setResolutions({});
    setExpanded(new Set<number>());
  }, [granularity, options, textA, textB]);

  const toggleOption = React.useCallback(
    (key: keyof IgnoreOptions): void => {
      patch({ options: { ...options, [key]: !options[key] } });
    },
    [options, patch],
  );

  const setResolution = React.useCallback((index: number, choice: 'left' | 'right'): void => {
    setResolutions((prev) => ({ ...prev, [index]: choice }));
  }, []);

  const applyAll = React.useCallback(
    (choice: 'left' | 'right'): void => {
      if (rows === null) {
        return;
      }
      const next: Record<number, 'left' | 'right'> = {};
      rows.forEach((row, index) => {
        if (row.kind !== 'same') {
          next[index] = choice;
        }
      });
      setResolutions(next);
      toast.success(choice === 'left' ? '已全部接受左侧' : '已全部接受右侧');
    },
    [rows],
  );

  const visibleRows = React.useMemo<DiffRow[]>(
    () => (rows === null ? [] : rows.slice(0, MAX_RENDER_ROWS)),
    [rows],
  );

  /** 折叠后的渲染条目（expanded 变化必须重算，否则点「展开」不会生效） */
  const renderItems = React.useMemo<RenderItem[]>(
    () => buildRenderItems(visibleRows, collapse, expanded),
    [visibleRows, collapse, expanded],
  );

  /** 当前处于折叠态的区块（跳转前需要先展开） */
  const collapsedRegions = React.useMemo<Array<{ start: number; end: number }>>(() => {
    const list: Array<{ start: number; end: number }> = [];
    for (const item of renderItems) {
      if (item.kind === 'gap') {
        list.push({ start: item.start, end: item.end });
      }
    }
    return list;
  }, [renderItems]);

  /** 差异列表：从可见行派生（仅含非相同行） */
  const diffs = React.useMemo<Array<{ rowIndex: number; kind: RowKind; lineNo: number; rightNo: number }>>(() => {
    const list: Array<{ rowIndex: number; kind: RowKind; lineNo: number; rightNo: number }> = [];
    visibleRows.forEach((row, index) => {
      if (row.kind === 'same') {
        return;
      }
      list.push({
        rowIndex: index,
        kind: row.kind,
        lineNo: row.left?.no ?? row.right?.no ?? 0,
        rightNo: row.right?.no ?? row.left?.no ?? 0,
      });
    });
    return list;
  }, [visibleRows]);

  const swap = React.useCallback((): void => {
    patch({ textA: textB, textB: textA });
    setResolutions({});
  }, [patch, textA, textB]);

  // —— 差异导航 ——

  /** 确保目标行可见（若落在折叠区里，先展开再滚动） */
  const scrollToRow = React.useCallback(
    (rowIndex: number): void => {
      const region = collapsedRegions.find((item) => rowIndex >= item.start && rowIndex <= item.end);
      if (region !== undefined) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(region.start - COLLAPSE_CONTEXT);
          return next;
        });
      }
      window.setTimeout(() => {
        const el = document.getElementById(`diff-row-${rowIndex}`);
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, region !== undefined ? 60 : 0);
    },
    [collapsedRegions],
  );

  const goToDiff = React.useCallback(
    (direction: 'next' | 'prev'): void => {
      if (diffs.length === 0) {
        return;
      }
      const next =
        direction === 'next'
          ? Math.min(activeDiff + 1, diffs.length - 1)
          : Math.max(activeDiff - 1, 0);
      setActiveDiff(next);
      const target = diffs[next];
      if (target !== undefined) {
        scrollToRow(target.rowIndex);
      }
    },
    [activeDiff, diffs, scrollToRow],
  );

  const handleSelectDiff = React.useCallback(
    (index: number): void => {
      setActiveDiff(index);
      const target = diffs[index];
      if (target !== undefined) {
        scrollToRow(target.rowIndex);
      }
    },
    [diffs, scrollToRow],
  );

  // 滚动条差异指示：测量每个差异行在滚动容器中的百分比位置
  const [marks, setMarks] = React.useState<DiffMark[]>([]);
  React.useEffect(() => {
    const container = scrollRef.current;
    if (container === null || diffs.length === 0) {
      setMarks([]);
      return;
    }
    const scrollHeight = container.scrollHeight;
    const containerRect = container.getBoundingClientRect();
    if (scrollHeight === 0) {
      setMarks([]);
      return;
    }
    const next: DiffMark[] = [];
    for (const diff of diffs) {
      const el = document.getElementById(`diff-row-${diff.rowIndex}`);
      if (el === null) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      const offsetTop = rect.top - containerRect.top + container.scrollTop;
      next.push({
        top: (offsetTop / scrollHeight) * 100,
        height: Math.max(1.2, (rect.height / scrollHeight) * 100),
        kind: diff.kind,
        rowIndex: diff.rowIndex,
      });
    }
    setMarks(next);
  }, [diffs, renderItems, mode, mergeMode]);

  React.useEffect(() => {
    setActiveDiff((prev) => (diffs.length === 0 ? 0 : Math.min(prev, diffs.length - 1)));
  }, [diffs]);

  // 键盘导航：↑/k 上一处差异，↓/j 下一处差异（输入框聚焦时不拦截）
  React.useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault();
        goToDiff('next');
      } else if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault();
        goToDiff('prev');
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [goToDiff]);

  const handleIndicatorClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (marks.length === 0) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const clickY = ((event.clientY - rect.top) / rect.height) * 100;
      let closest: DiffMark | null = null;
      let closestDist = Infinity;
      for (const mark of marks) {
        const center = mark.top + mark.height / 2;
        const dist = Math.abs(center - clickY);
        if (dist < closestDist) {
          closestDist = dist;
          closest = mark;
        }
      }
      if (closest === null) {
        return;
      }
      const current = closest;
      const index = diffs.findIndex((item) => item.rowIndex === current.rowIndex);
      if (index >= 0) {
        setActiveDiff(index);
        scrollToRow(current.rowIndex);
      }
    },
    [marks, diffs, scrollToRow],
  );

  const isActiveRow = (index: number): boolean =>
    diffs.length > 0 && activeDiff < diffs.length && diffs[activeDiff]?.rowIndex === index;

  return (
    <CommandShell
      title="文本对比"
      description="行 / 单词 / 字符三档粒度 · 左右逐行对齐同步滚动 · 折叠未变更"
      icon={<FileDiff className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={mergeMode ? merged : unified}
      shortcutHint="↑/↓ 或 j/k 跳到上一处 / 下一处差异；关掉工具再打开，输入还在"
      samples={[
        {
          label: '配置改动',
          description: '改了一行端口、加了一行 gzip，看行内高亮定位到具体片段',
          apply: () => {
            patch({
              textA: `server {
  listen 80;
  server_name handy.local;
  root /var/www;
}`,
              textB: `server {
  listen 8080;
  server_name handy.local;
  gzip on;
  root /var/www;
}`,
              mode: 'split',
              granularity: 'line',
            });
          },
        },
        {
          label: '代码重构',
          description: '函数改名 + 参数变多：切「单词」粒度才看清真正的改动点',
          apply: () => {
            patch({
              textA: `function fetchUser(id) {
  return api.get('/user/' + id);
}`,
              textB: `function fetchUserDetail(userId, opts) {
  return api.get('/user/' + userId, opts);
}`,
              mode: 'inline',
              granularity: 'word',
            });
          },
        },
        {
          label: '表格数据',
          description: '两版 CSV：用「字符」粒度能看出单元格里改的是哪个数字',
          apply: () => {
            patch({
              textA: `name,qty,price
顺手键盘,12,299
顺手鼠标,8,129`,
              textB: `name,qty,price
顺手键盘,15,299
顺手鼠标,8,139`,
              mode: 'split',
              granularity: 'char',
            });
          },
        },
        {
          label: '大段相同',
          description: '配合「折叠未变更的行」——只留下差异与上下文',
          apply: () => {
            patch({
              textA: `第一步：打开设置
第二步：选择网络
第三步：保存并重启
第四步：确认生效`,
              textB: `第一步：打开设置
第二步：选择网络
第三步：保存并重启服务
第四步：确认生效`,
              mode: 'split',
              granularity: 'line',
              collapse: true,
            });
          },
        },
        {
          label: '清空两栏',
          description: '把左右两栏都清空，重新开始',
          apply: () => {
            patch({ textA: '', textB: '' });
          },
        },
      ]}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {/* ——— 工具条 ——— */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            {(['split', 'inline'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => patch({ mode: item })}
                className={cn(
                  'rounded-md px-2 py-1 text-xs transition-colors',
                  mode === item
                    ? 'bg-brand-muted text-brand'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {item === 'split' ? '并排（对齐）' : '行内（统一）'}
              </button>
            ))}
          </div>
          <span className="h-4 w-px bg-border" />
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">粒度</span>
            {(
              [
                { value: 'line', label: '行' },
                { value: 'word', label: '单词' },
                { value: 'char', label: '字符' },
              ] as const
            ).map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => patch({ granularity: item.value })}
                className={cn(
                  'rounded-md px-2 py-1 text-xs transition-colors',
                  granularity === item.value
                    ? 'bg-brand-muted text-brand'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="h-4 w-px bg-border" />
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-muted-foreground">忽略</span>
            <ToggleChip active={options.trimWhitespace} onClick={() => toggleOption('trimWhitespace')} title="忽略每行首尾空格">
              首尾空白
            </ToggleChip>
            <ToggleChip
              active={options.ignoreAllWhitespace}
              onClick={() => toggleOption('ignoreAllWhitespace')}
              title="忽略所有空格差异（含行内）"
            >
              全部空白
            </ToggleChip>
            <ToggleChip active={options.ignoreCase} onClick={() => toggleOption('ignoreCase')} title="忽略大小写差异">
              大小写
            </ToggleChip>
            <ToggleChip active={options.ignoreEmptyLines} onClick={() => toggleOption('ignoreEmptyLines')} title="忽略纯空行">
              空行
            </ToggleChip>
          </div>
          <span className="h-4 w-px bg-border" />
          <ToggleChip active={collapse} onClick={() => patch({ collapse: !collapse })} title="把连续未变更的行折起来，只留上下文">
            <span className="inline-flex items-center gap-1">
              <Ungroup className="h-3 w-3" />
              折叠未变更
            </span>
          </ToggleChip>
          <ToggleChip active={mergeMode} onClick={() => setMergeMode((prev) => !prev)} title="逐块选择接受左 / 右，生成合并结果">
            合并模式
          </ToggleChip>
          <ToggleChip active={state.showInputs} onClick={() => patch({ showInputs: !state.showInputs })}>
            {state.showInputs ? '收起输入' : '展开输入'}
          </ToggleChip>
        </div>

        {/* ——— 输入区 ——— */}
        {state.showInputs ? (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                原文 A（{textA.split('\n').length} 行 · {textA.length} 字符）
              </span>
              <textarea
                aria-label="原文本 A"
                value={textA}
                onChange={(event) => patch({ textA: event.target.value })}
                placeholder="原文本 A（粘贴后自动对比；内容会保留到下次打开）"
                spellCheck={false}
                className={
                  'h-[150px] w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-xs ' +
                  'text-foreground placeholder:text-muted-foreground ' +
                  'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
                }
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                新文 B（{textB.split('\n').length} 行 · {textB.length} 字符）
              </span>
              <textarea
                aria-label="新文本 B"
                value={textB}
                onChange={(event) => patch({ textB: event.target.value })}
                placeholder="新文本 B"
                spellCheck={false}
                className={
                  'h-[150px] w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-xs ' +
                  'text-foreground placeholder:text-muted-foreground ' +
                  'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
                }
              />
            </div>
          </div>
        ) : null}

        {/* ——— 统计条 ——— */}
        {stats !== null ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-xs">
            <span className="text-emerald-700 dark:text-emerald-400">+{stats.added} 新增</span>
            <span className="text-red-700 dark:text-red-400">-{stats.removed} 删除</span>
            <span className="text-amber-700 dark:text-amber-500">~{stats.modified} 修改</span>
            <span className="text-muted-foreground">{stats.same} 相同</span>
            <span className="ml-auto font-semibold text-foreground">相似度 {stats.similarity}%</span>
            {tooLongForGranularity ? (
              <span className="text-amber-600">文本过长，已自动回退行级对比</span>
            ) : null}
          </div>
        ) : null}

        {/* ——— 差异视图 ——— */}
        {rows === null ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            在上方输入两段文本后自动对比
          </div>
        ) : hasDiff ? (
          <div className="flex gap-3">
            <div className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
              {/* 头部：视图说明 + 导航 */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
                <span className="text-sm font-medium text-foreground">差异</span>
                <span className="text-[11px] text-muted-foreground">
                  {mode === 'split'
                    ? '左右同一行对齐 · 单一滚动条（天然同步）· 虚线块=对侧多出的行'
                    : '统一视图：删除行在上、新增行在下，同一处改动连在一起'}
                </span>
                {rows.length > MAX_RENDER_ROWS ? (
                  <span className="text-xs text-amber-600">
                    共 {rows.length} 行，仅渲染前 {MAX_RENDER_ROWS} 行
                  </span>
                ) : null}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => goToDiff('prev')}
                    disabled={diffs.length === 0}
                    title="上一处差异（↑ / k）"
                  >
                    ↑ 上一处
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => goToDiff('next')}
                    disabled={diffs.length === 0}
                    title="下一处差异（↓ / j）"
                  >
                    ↓ 下一处
                  </Button>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {diffs.length === 0 ? '0 / 0' : `${activeDiff + 1} / ${diffs.length}`}
                  </span>
                  <ToggleChip
                    active={state.showDiffList}
                    onClick={() => patch({ showDiffList: !state.showDiffList })}
                    title="右侧列出所有差异行，点击跳转"
                  >
                    <span className="inline-flex items-center gap-1">
                      <ListFilter className="h-3 w-3" />
                      差异列表
                    </span>
                  </ToggleChip>
                </div>
              </div>

              {/* 列头：让两侧的「行号列」有明确归属 */}
              {mode === 'split' ? (
                <div className="grid grid-cols-2 gap-2 border-b border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                  <span>原文 A</span>
                  <span>新文 B</span>
                </div>
              ) : null}

              <div className="relative h-[420px]">
                <div ref={scrollRef} className="scrollbar-thin h-full overflow-auto p-2">
                  {mode === 'split' ? (
                    /* 并排：单一滚动容器 + 网格两列 → 行对行对齐、滚动天然同步 */
                    <div className="grid grid-cols-2 gap-2">
                      {renderItems.map((item) => {
                        if (item.kind === 'gap') {
                          const count = item.end - item.start + 1;
                          return (
                            <button
                              key={`gap-${item.start}`}
                              type="button"
                              onClick={() =>
                                setExpanded((prev) => {
                                  const next = new Set(prev);
                                  next.add(item.start - COLLAPSE_CONTEXT);
                                  return next;
                                })
                              }
                              className="col-span-2 flex h-6 items-center justify-center gap-1.5 rounded border border-dashed border-border bg-muted/30 text-[11px] text-muted-foreground transition hover:bg-accent/60 hover:text-foreground"
                              title="点击展开这段未变更的内容"
                            >
                              <ChevronsUpDown className="h-3 w-3" />
                              展开 {count} 行未变更内容
                            </button>
                          );
                        }
                        const index = item.index;
                        const row = visibleRows[index];
                        if (row === undefined) {
                          return null;
                        }
                        const active = isActiveRow(index);
                        return (
                          <React.Fragment key={`row-${index}`}>
                            <div className="flex flex-col gap-0.5">
                              <DiffCell
                                line={row.left}
                                kind={row.kind}
                                side="left"
                                active={active}
                                id={`diff-row-${index}`}
                              />
                              {mergeMode && row.kind !== 'same' ? (
                                <MergeBar row={row} index={index} choice={resolutions[index]} onChoose={setResolution} />
                              ) : null}
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <DiffCell line={row.right} kind={row.kind} side="right" active={active} />
                              {mergeMode && row.kind !== 'same' ? <div className="min-h-[22px]" aria-hidden="true" /> : null}
                            </div>
                          </React.Fragment>
                        );
                      })}
                    </div>
                  ) : (
                    /* 行内（统一视图）：相同的行只出现一次，改动处删/增相邻 */
                    <div className="flex flex-col gap-0.5">
                      {renderItems.map((item) => {
                        if (item.kind === 'gap') {
                          const count = item.end - item.start + 1;
                          return (
                            <button
                              key={`gap-${item.start}`}
                              type="button"
                              onClick={() =>
                                setExpanded((prev) => {
                                  const next = new Set(prev);
                                  next.add(item.start - COLLAPSE_CONTEXT);
                                  return next;
                                })
                              }
                              className="flex h-6 items-center justify-center gap-1.5 rounded border border-dashed border-border bg-muted/30 text-[11px] text-muted-foreground transition hover:bg-accent/60 hover:text-foreground"
                            >
                              <ChevronsUpDown className="h-3 w-3" />
                              展开 {count} 行未变更内容
                            </button>
                          );
                        }
                        const index = item.index;
                        const row = visibleRows[index];
                        if (row === undefined) {
                          return null;
                        }
                        const active = isActiveRow(index);
                        return (
                          <div key={`i-${index}`} id={`diff-row-${index}`} className="flex flex-col gap-0.5">
                            {row.kind === 'same' ? (
                              <DiffCell line={row.left} kind="same" side="left" active={false} />
                            ) : (
                              <>
                                {row.left !== null ? (
                                  <DiffCell line={row.left} kind={row.kind} side="left" active={active} />
                                ) : null}
                                {row.right !== null ? (
                                  <DiffCell line={row.right} kind={row.kind} side="right" active={active} />
                                ) : null}
                              </>
                            )}
                            {mergeMode && row.kind !== 'same' ? (
                              <MergeBar row={row} index={index} choice={resolutions[index]} onChoose={setResolution} />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 右侧细条：差异位置总览，点击跳转 */}
                {marks.length > 0 ? (
                  <div
                    className="absolute bottom-2 right-0 top-2 z-10 w-3 cursor-pointer bg-muted/20"
                    onClick={handleIndicatorClick}
                    title="点击跳转到最近的差异"
                  >
                    {marks.map((mark) => {
                      const isCurrent =
                        diffs.length > 0 && activeDiff < diffs.length && diffs[activeDiff]?.rowIndex === mark.rowIndex;
                      return (
                        <div
                          key={mark.rowIndex}
                          className={cn(
                            'absolute left-0 right-0 rounded-full',
                            mark.kind === 'added'
                              ? 'bg-emerald-500'
                              : mark.kind === 'removed'
                                ? 'bg-red-500'
                                : 'bg-amber-500',
                            isCurrent && 'ring-2 ring-inset ring-brand',
                          )}
                          style={{ top: `${mark.top}%`, height: `${mark.height}%` }}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>

            {state.showDiffList && diffs.length > 0 ? (
              <DiffListPanel diffs={diffs} activeDiff={activeDiff} onSelect={handleSelectDiff} />
            ) : null}
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            两段文本内容一致，无差异
          </div>
        )}

        {/* ——— 合并结果 ——— */}
        {mergeMode && rows !== null ? (
          <div className="rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
              <span className="text-sm font-medium text-foreground">合并结果</span>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => applyAll('left')}>
                  全部接受左
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => applyAll('right')}>
                  全部接受右
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setResolutions({});
                    toast.success('已重置为默认（取右侧 B）');
                  }}
                >
                  重置
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => downloadFile('handy-diff-merged.txt', merged)}
                >
                  下载合并结果
                </Button>
              </div>
            </div>
            <div className="scrollbar-thin max-h-[180px] overflow-auto p-3">
              <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">{merged}</pre>
            </div>
            <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              默认取右侧（B）内容；点差异块下方的「接受左 / 接受右」可逐块覆盖。
            </div>
          </div>
        ) : null}

        {/* ——— 底部操作 ——— */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => downloadFile('handy-diff-left.txt', normalizedA)}>
            <Download className="h-3.5 w-3.5" />
            下载左侧
          </Button>
          <Button size="sm" variant="outline" onClick={() => downloadFile('handy-diff-right.txt', normalizedB)}>
            <Download className="h-3.5 w-3.5" />
            下载右侧
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => downloadFile('handy-diff.patch', unified)}
            disabled={rows === null}
          >
            <Download className="h-3.5 w-3.5" />
            下载 unified diff
          </Button>
          <Button size="sm" variant="ghost" onClick={swap}>
            <ArrowLeftRight className="h-3.5 w-3.5" />
            交换 A / B
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            onClick={() => {
              patch({ textA: '', textB: '' });
              setResolutions({});
            }}
          >
            清空
          </Button>
        </div>
      </div>
    </CommandShell>
  );
}

/** 差异块的「接受左 / 接受右」操作条 */
function MergeBar({
  row,
  index,
  choice,
  onChoose,
}: {
  row: DiffRow;
  index: number;
  choice?: 'left' | 'right';
  onChoose: (index: number, choice: 'left' | 'right') => void;
}): React.JSX.Element {
  const resolved = choice ?? 'right';
  const leftLabel = row.kind === 'added' ? '不采纳' : '接受左';
  const rightLabel = row.kind === 'removed' ? '不采纳' : '接受右';
  return (
    <div className="flex items-center gap-1 pl-2">
      <button
        type="button"
        onClick={() => onChoose(index, 'left')}
        className={cn(
          'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
          resolved === 'left'
            ? 'border-red-300 bg-red-50 text-red-700'
            : 'border-border text-muted-foreground hover:text-foreground',
        )}
      >
        ← {leftLabel}
      </button>
      <button
        type="button"
        onClick={() => onChoose(index, 'right')}
        className={cn(
          'rounded border px-1.5 py-0.5 text-[10px] transition-colors',
          resolved === 'right'
            ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
            : 'border-border text-muted-foreground hover:text-foreground',
        )}
      >
        {rightLabel} →
      </button>
    </div>
  );
}

/** 差异列表面板：列出每条差异「A 行 / B 行 · 增删改」，点击跳转 */
function DiffListPanel({
  diffs,
  activeDiff,
  onSelect,
}: {
  diffs: ReadonlyArray<{ rowIndex: number; kind: RowKind; lineNo: number; rightNo: number }>;
  activeDiff: number;
  onSelect: (index: number) => void;
}): React.JSX.Element {
  return (
    <div className="w-56 shrink-0 overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-sm font-medium text-foreground">
        差异列表 ({diffs.length})
      </div>
      <div className="scrollbar-thin max-h-[420px] overflow-auto p-1">
        {diffs.map((diff, index) => {
          const isCurrent = index === activeDiff;
          const label = diff.kind === 'added' ? '新增' : diff.kind === 'removed' ? '删除' : '修改';
          const dot =
            diff.kind === 'added' ? 'bg-emerald-500' : diff.kind === 'removed' ? 'bg-red-500' : 'bg-amber-500';
          return (
            <button
              key={`${diff.rowIndex}-${index}`}
              type="button"
              onClick={() => onSelect(index)}
              className={cn(
                'mb-1 w-full rounded-md border px-2 py-1 text-left text-xs transition-colors',
                isCurrent
                  ? 'border-brand/40 bg-brand-muted text-brand'
                  : 'border-border hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', dot)} />
                <span className="font-mono tabular-nums">
                  {diff.lineNo} ↔ {diff.rightNo}
                </span>
                <span className="ml-auto">{label}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default TextDiff;
