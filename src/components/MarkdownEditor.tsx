import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bold,
  Code,
  Code2,
  Columns,
  Eye,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pencil,
  Quote,
  Strikethrough,
  Table,
} from 'lucide-react';
import { renderMarkdown } from '@/lib/markdown';
import '@/styles/markdown.css';

/**
 * Markdown 编辑器（V10 便签编辑器）。
 *
 * 三视图：编辑 / 分屏 / 预览；带格式工具栏与**自动格式化**：
 *   - 回车续列表（有序列表自增、任务列表新项默认未完成）；
 *   - 空列表项回车退出列表（避免空符号「跑下去」）；
 *   - Tab / Shift+Tab 缩进 2 空格（单行非列表时插入 2 空格，绝不跳出输入框）；
 *   - 成对符号自动补全 / 包裹选区；
 *   - Ctrl/Cmd + B / I / K / 1 / 2 / 3 快捷键。
 *
 * 预览侧：`marked` 解析 + `DOMPurify` 清洗（见 `@/lib/markdown`），
 * 输入停止 `PREVIEW_DEBOUNCE_MS` 后渲染，避免每个按键都跑一次解析 + 清洗。
 */

/** 视图模式 */
export type EditorMode = 'edit' | 'split' | 'preview';

export interface MarkdownEditorProps {
  /** 当前 Markdown 源文本（受控） */
  value: string;
  /** 文本变更回调（防抖落库由调用方负责，本组件不做节流） */
  onChange: (next: string) => void;
  /** 空内容占位提示 */
  placeholder?: string;
  /** 是否显示工具栏（便签小窗可关） */
  showToolbar?: boolean;
  /** 是否显示编辑器自带状态条（字数 / 行数 / 模式）；宿主自带状态条时可关掉避免重复 */
  showStatusBar?: boolean;
  /** 初始视图模式 */
  defaultMode?: EditorMode;
  /** 附加到根节点的样式类 */
  className?: string;
  /** 视图模式变更回调（便签用它把偏好写进 localStorage） */
  onModeChange?: (mode: EditorMode) => void;
  /** 输入区获得焦点（便签用它暂停远端同步，避免打字被覆盖） */
  onFocus?: () => void;
  /** 输入区失去焦点 */
  onBlur?: () => void;
}

/** 预览渲染防抖（毫秒） */
const PREVIEW_DEBOUNCE_MS = 120;
/** 缩进宽度（空格数） */
const INDENT = '  ';

/** 编辑态：文本 + 选区（纯数据，便于独立测试与复用） */
interface EditState {
  value: string;
  start: number;
  end: number;
}

/** 成对符号自动补全映射 */
const AUTO_PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '`': '`',
};

/** 安全的模式解析（localStorage / 外部传入值可能不合法） */
function normalizeMode(mode: string | undefined): EditorMode {
  return mode === 'edit' || mode === 'split' || mode === 'preview' ? mode : 'edit';
}

/**
 * 取某位置的所在行起始下标。
 * @param value 全文
 * @param index 位置
 * @returns 行首下标
 */
function lineStartOf(value: string, index: number): number {
  if (index <= 0) {
    return 0;
  }
  const found: number = value.lastIndexOf('\n', index - 1);
  return found === -1 ? 0 : found + 1;
}

/**
 * 取某位置的所在行结束下标（**不含**行尾换行符）。
 * @param value 全文
 * @param index 位置
 * @returns 行尾下标
 */
function lineEndOf(value: string, index: number): number {
  const found: number = value.indexOf('\n', index);
  return found === -1 ? value.length : found;
}

/**
 * 取行首缩进（空白前缀）。
 * @param line 单行文本
 * @returns 缩进字符串
 */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/**
 * 包裹 / 取消包裹选区（加粗、斜体、删除线、行内代码等）。
 *
 * - 已有选区 → 包裹（已包裹则取消）；
 * - 无选区 → 插入 `left + placeholder + right` 并选中 placeholder（便于直接改写）。
 */
function wrapSelection(state: EditState, left: string, right: string, placeholder = ''): EditState {
  const { value, start, end } = state;
  const selected: string = value.slice(start, end);

  // 选区自身已包裹 → 取消
  if (
    selected.length >= left.length + right.length &&
    selected.startsWith(left) &&
    selected.endsWith(right)
  ) {
    const inner: string = selected.slice(left.length, selected.length - right.length);
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
  }

  // 选区外侧已包裹 → 取消
  if (
    start - left.length >= 0 &&
    value.slice(start - left.length, start) === left &&
    value.slice(end, end + right.length) === right
  ) {
    const nextStart: number = start - left.length;
    const nextValue: string = value.slice(0, nextStart) + selected + value.slice(end + right.length);
    return { value: nextValue, start: nextStart, end: nextStart + selected.length };
  }

  const body: string = selected || placeholder;
  const nextValue: string = value.slice(0, start) + left + body + right + value.slice(end);
  const innerStart: number = start + left.length;
  return { value: nextValue, start: innerStart, end: innerStart + body.length };
}

/**
 * 对选区覆盖的每一行做变换（未选中的同行内容一并处理，符合「整行操作」直觉）。
 *
 * @param state 编辑态
 * @param transform 行变换函数（index 为块内行序号）
 * @returns 新编辑态；单行时插入符落到行尾，多行时保持整块选中（便于反复切换）
 */
function mapSelectedLines(state: EditState, transform: (line: string, index: number) => string): EditState {
  const { value, start, end } = state;
  const blockStart: number = lineStartOf(value, start);
  const rawEnd: number = lineEndOf(value, end);
  const blockEnd: number = rawEnd;
  const block: string = value.slice(blockStart, blockEnd);
  const lines: string[] = block.split('\n');
  const nextLines: string[] = lines.map(transform);
  const nextBlock: string = nextLines.join('\n');
  const nextValue: string = value.slice(0, blockStart) + nextBlock + value.slice(blockEnd);

  if (lines.length === 1) {
    const caret: number = blockStart + (nextLines[0] ?? '').length;
    return { value: nextValue, start: caret, end: caret };
  }
  return { value: nextValue, start: blockStart, end: blockStart + nextBlock.length };
}

/**
 * 切换标题（H1 / H2 / H3，同级再点一次取消）。
 * @param state 编辑态
 * @param level 标题级别（1~3）
 * @returns 新编辑态
 */
function applyHeading(state: EditState, level: number): EditState {
  const prefix: string = `${'#'.repeat(level)} `;
  return mapSelectedLines(state, (line: string): string => {
    const indent: string = indentOf(line);
    const rest: string = line.slice(indent.length);
    const matched: RegExpExecArray | null = /^(#{1,6})\s+/.exec(rest);
    if (matched) {
      const existed: string = matched[1] ?? '';
      const content: string = rest.slice(matched[0].length);
      if (existed.length === level) {
        return indent + content;
      }
      return indent + prefix + content;
    }
    return indent + prefix + rest;
  });
}

/**
 * 切换列表（无序 / 有序 / 任务），同类标记再点一次取消。
 * @param state 编辑态
 * @param kind 列表类型
 * @returns 新编辑态
 */
function applyList(state: EditState, kind: 'ul' | 'ol' | 'task'): EditState {
  return mapSelectedLines(state, (line: string, index: number): string => {
    const indent: string = indentOf(line);
    let rest: string = line.slice(indent.length);

    const taskMatch: RegExpExecArray | null = /^([-*+])\s+\[[ xX]\]\s+/.exec(rest);
    const bulletMatch: RegExpExecArray | null = /^([-*+])\s+/.exec(rest);
    const orderedMatch: RegExpExecArray | null = /^\d+[.)]\s+/.exec(rest);

    const hasTask: boolean = taskMatch !== null;
    const hasBullet: boolean = bulletMatch !== null;
    const hasOrdered: boolean = orderedMatch !== null;
    const hasMarker: boolean = hasTask || hasBullet || hasOrdered;

    // 已是目标类型 → 取消
    const already: boolean =
      kind === 'task'
        ? hasTask && (taskMatch?.[1] ?? '') === '-'
        : kind === 'ul'
          ? hasBullet && !hasTask && (bulletMatch?.[1] ?? '') === '-'
          : hasOrdered && !hasTask && !hasBullet;
    if (hasMarker && already) {
      if (hasTask) {
        rest = rest.slice((taskMatch?.[0] ?? '').length);
      } else if (hasBullet) {
        rest = rest.slice((bulletMatch?.[0] ?? '').length);
      } else {
        rest = rest.slice((orderedMatch?.[0] ?? '').length);
      }
      return indent + rest;
    }

    // 剥掉已有标记后重建（不同列表类型之间互相转换）
    if (hasTask) {
      rest = rest.slice((taskMatch?.[0] ?? '').length);
    } else if (hasBullet) {
      rest = rest.slice((bulletMatch?.[0] ?? '').length);
    } else if (hasOrdered) {
      rest = rest.slice((orderedMatch?.[0] ?? '').length);
    }

    if (kind === 'ul') {
      return `${indent}- ${rest}`;
    }
    if (kind === 'ol') {
      return `${indent}${index + 1}. ${rest}`;
    }
    return `${indent}- [ ] ${rest}`;
  });
}

/**
 * 切换引用（`> `）。
 * @param state 编辑态
 * @returns 新编辑态
 */
function applyQuote(state: EditState): EditState {
  return mapSelectedLines(state, (line: string): string => {
    const indent: string = indentOf(line);
    const rest: string = line.slice(indent.length);
    const matched: RegExpExecArray | null = /^>\s?/.exec(rest);
    if (matched) {
      return indent + rest.slice(matched[0].length);
    }
    return `${indent}> ${rest}`;
  });
}

/**
 * 插入围栏代码块（选区作为代码体）。
 * @param state 编辑态
 * @returns 新编辑态
 */
function applyCodeBlock(state: EditState): EditState {
  const { value, start, end } = state;
  const selected: string = value.slice(start, end);
  const before: string = value.slice(0, start);
  const after: string = value.slice(end);
  const lead: string = before === '' || before.endsWith('\n') ? '' : '\n';
  const trail: string = after === '' || after.startsWith('\n') ? '' : '\n';
  const body: string = selected || '代码';
  const text: string = `${lead}\`\`\`\n${body}\n\`\`\`${trail}`;
  const bodyStart: number = start + lead.length + 4;
  return {
    value: before + text + after,
    start: bodyStart,
    end: bodyStart + body.length,
  };
}

/**
 * 在光标处插入文本（替换选区）。
 * @param state 编辑态
 * @param text 待插入文本
 * @returns 新编辑态（插入符落在插入内容末尾）
 */
function insertText(state: EditState, text: string): EditState {
  const { value, start, end } = state;
  const caret: number = start + text.length;
  return { value: value.slice(0, start) + text + value.slice(end), start: caret, end: caret };
}

/**
 * 插入链接 / 图片，并选中 `url` 占位便于直接粘贴。
 * @param state 编辑态
 * @param bang 是否为图片（`!` 前缀）
 * @returns 新编辑态
 */
function insertLink(state: EditState, bang: boolean): EditState {
  const { value, start, end } = state;
  const selected: string = value.slice(start, end);
  const label: string = selected || (bang ? '图片' : '链接');
  const text: string = `${bang ? '!' : ''}[${label}](url)`;
  const urlStart: number = start + (bang ? 1 : 0) + label.length + 3;
  return {
    value: value.slice(0, start) + text + value.slice(end),
    start: urlStart,
    end: urlStart + 3,
  };
}

/**
 * 插入 3 行 2 列表格骨架。
 * @param state 编辑态
 * @returns 新编辑态
 */
function insertTable(state: EditState): EditState {
  const skeleton: string = ['| 列 1 | 列 2 |', '| --- | --- |', '| 内容 | 内容 |', '| 内容 | 内容 |'].join('\n');
  const { value, start, end } = state;
  const before: string = value.slice(0, start);
  const after: string = value.slice(end);
  const lead: string = before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail: string = after === '' ? '\n' : after.startsWith('\n') ? '' : '\n';
  const text: string = `${lead}${skeleton}${trail}`;
  const caret: number = start + text.length;
  return { value: before + text + after, start: caret, end: caret };
}

/**
 * 插入分割线（`---`），并保证前后是独立行。
 * @param state 编辑态
 * @returns 新编辑态
 */
function insertHr(state: EditState): EditState {
  const { value, start, end } = state;
  const before: string = value.slice(0, start);
  const after: string = value.slice(end);
  const lead: string = before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail: string = after === '' ? '\n' : after.startsWith('\n') ? '' : '\n';
  const text: string = `${lead}---${trail}`;
  const caret: number = start + text.length;
  return { value: before + text + after, start: caret, end: caret };
}

/**
 * 整体缩进 / 反缩进选区覆盖的每一行。
 * @param state 编辑态
 * @param outdent 是否反缩进
 * @returns 新编辑态
 */
function indentBlock(state: EditState, outdent: boolean): EditState {
  return mapSelectedLines(state, (line: string): string => {
    if (outdent) {
      return line.replace(/^(\t| {1,2})/, '');
    }
    return INDENT + line;
  });
}

/**
 * 空列表项 / 空引用行回车：删掉空标记并换行，退出列表。
 * @param state 编辑态
 * @returns 新编辑态
 */
function exitEmptyMarker(state: EditState): EditState {
  const { value, start } = state;
  const blockStart: number = lineStartOf(value, start);
  let blockEnd: number = value.indexOf('\n', start);
  blockEnd = blockEnd === -1 ? value.length : blockEnd + 1;
  const before: string = value.slice(0, blockStart);
  const after: string = value.slice(blockEnd);
  const next: string = before === '' && after === '' ? '' : `${before}\n${after}`;
  const caret: number = Math.min(blockStart + 1, next.length);
  return { value: next, start: caret, end: caret };
}

/**
 * 回车处理：续列表 / 退出空列表项；返回 null 表示交回浏览器默认行为。
 * @param state 编辑态
 * @returns 新编辑态或 null
 */
function handleEnter(state: EditState): EditState | null {
  const { value, start, end } = state;
  if (start !== end) {
    return insertText(state, '\n');
  }

  // —— 围栏代码块内一律换行，不续列表（V47）——
  //
  // 用户原话：「code ```输入貌似只能输入一行内容，不能自动根据我的输入扩展行数」。
  // 代码里 `- ` / `1. ` / `> ` 全是**字面内容**，不是列表标记；不拦住的话，
  // 在代码块里回车会被塞进一个 "- " 前缀，代码直接写坏。
  // 判据：光标之前出现了奇数个围栏行 ⇒ 此刻在围栏内部。
  const fences: number = (value.slice(0, start).match(/^[ \t]*(?:`{3,}|~{3,})/gm) ?? []).length;
  if (fences % 2 === 1) {
    return insertText(state, '\n');
  }

  const blockStart: number = lineStartOf(value, start);
  const lineBefore: string = value.slice(blockStart, start);

  // 任务列表：`- [ ] ` / `- [x] ` → 新项默认未完成
  const task: RegExpExecArray | null = /^(\s*)([-*+])\s+\[([ xX])\]\s?/.exec(lineBefore);
  if (task) {
    const content: string = lineBefore.slice(task[0].length);
    if (content.trim() === '') {
      return exitEmptyMarker(state);
    }
    return insertText(state, `\n${task[1] ?? ''}${task[2] ?? '-'} [ ] `);
  }

  // 有序列表：序号自增
  const ordered: RegExpExecArray | null = /^(\s*)(\d+)([.)])\s?/.exec(lineBefore);
  if (ordered) {
    const content: string = lineBefore.slice(ordered[0].length);
    if (content.trim() === '') {
      return exitEmptyMarker(state);
    }
    const num: number = Number.parseInt(ordered[2] ?? '1', 10);
    return insertText(state, `\n${ordered[1] ?? ''}${num + 1}${ordered[3] ?? '.'} `);
  }

  // 无序列表：沿用同一符号
  const bullet: RegExpExecArray | null = /^(\s*)([-*+])\s?/.exec(lineBefore);
  if (bullet) {
    const content: string = lineBefore.slice(bullet[0].length);
    if (content.trim() === '') {
      return exitEmptyMarker(state);
    }
    return insertText(state, `\n${bullet[1] ?? ''}${bullet[2] ?? '-'} `);
  }

  // 引用：续 `> `，空引用行则退出
  const quote: RegExpExecArray | null = /^(\s*)>\s?/.exec(lineBefore);
  if (quote) {
    const content: string = lineBefore.slice(quote[0].length);
    if (content.trim() === '') {
      return exitEmptyMarker(state);
    }
    return insertText(state, `\n${quote[1] ?? ''}> `);
  }

  return null;
}

/** 工具栏按钮定义 */
interface ToolbarItem {
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  group: number;
}

/** 工具栏按钮（按 group 分段） */
const TOOLBAR_ITEMS: ToolbarItem[] = [
  { id: 'bold', title: '加粗 (Ctrl/Cmd+B)', icon: Bold, group: 0 },
  { id: 'italic', title: '斜体 (Ctrl/Cmd+I)', icon: Italic, group: 0 },
  { id: 'strike', title: '删除线', icon: Strikethrough, group: 0 },
  { id: 'code', title: '行内代码', icon: Code, group: 0 },
  { id: 'h1', title: '一级标题 (Ctrl+1)', icon: Heading1, group: 1 },
  { id: 'h2', title: '二级标题 (Ctrl+2)', icon: Heading2, group: 1 },
  { id: 'h3', title: '三级标题 (Ctrl+3)', icon: Heading3, group: 1 },
  { id: 'ul', title: '无序列表', icon: List, group: 2 },
  { id: 'ol', title: '有序列表', icon: ListOrdered, group: 2 },
  { id: 'task', title: '任务列表', icon: ListChecks, group: 2 },
  { id: 'quote', title: '引用', icon: Quote, group: 2 },
  { id: 'fence', title: '代码块', icon: Code2, group: 3 },
  { id: 'link', title: '链接 (Ctrl/Cmd+K)', icon: Link, group: 3 },
  { id: 'image', title: '图片', icon: Image, group: 3 },
  { id: 'table', title: '表格', icon: Table, group: 3 },
  { id: 'hr', title: '分割线', icon: Minus, group: 3 },
];

/** 视图模式切换按钮 */
const MODE_ITEMS: Array<{ id: EditorMode; title: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'edit', title: '仅编辑', icon: Pencil },
  { id: 'split', title: '分屏（左编辑 / 右预览）', icon: Columns },
  { id: 'preview', title: '仅预览', icon: Eye },
];

/** 图标按钮（工具栏 / 模式切换共用） */
function IconButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      // 保持 textarea 焦点与选区：阻止默认的 mousedown 抢焦点
      onMouseDown={(event: React.MouseEvent<HTMLButtonElement>): void => event.preventDefault()}
      onClick={onClick}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded transition ${
        active ? 'bg-black/10 opacity-100' : 'opacity-55 hover:bg-black/10 hover:opacity-100'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Markdown 编辑器。
 *
 * @param props 见 `MarkdownEditorProps`
 * @returns 编辑器节点
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder = '记点什么…支持 Markdown',
  showToolbar = true,
  showStatusBar = true,
  defaultMode = 'edit',
  className = '',
  onModeChange,
  onFocus,
  onBlur,
}: MarkdownEditorProps): React.JSX.Element {
  const [mode, setMode] = useState<EditorMode>(() => normalizeMode(defaultMode));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  /** 待应用的选区（文本变更 → 重渲染后写入 DOM） */
  const pendingSelection = useRef<[number, number] | null>(null);
  /** 滚动同步互斥锁（避免编辑区 / 预览区互相抖动） */
  const syncingRef = useRef(false);

  // 预览防抖：输入停止后再解析，避免每个按键都跑 marked + DOMPurify
  const [previewSrc, setPreviewSrc] = useState<string>(value);
  useEffect(() => {
    const timer: number = window.setTimeout(() => {
      setPreviewSrc(value);
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  const html: string = useMemo(() => renderMarkdown(previewSrc), [previewSrc]);

  // 外部（localStorage 恢复等）变更后同步视图模式
  useEffect(() => {
    setMode((prev: EditorMode): EditorMode => {
      const next: EditorMode = normalizeMode(defaultMode);
      return prev === next ? prev : next;
    });
  }, [defaultMode]);

  // 文本变更后应用挂起的选区（受控组件：值回到 DOM 之后再 setSelectionRange）
  useEffect(() => {
    const pending = pendingSelection.current;
    if (!pending) {
      return;
    }
    const el = textareaRef.current;
    pendingSelection.current = null;
    if (!el) {
      return;
    }
    el.focus();
    el.setSelectionRange(pending[0], pending[1]);
  });

  /** 读取当前编辑态（文本 + 选区） */
  const readState = useCallback((): EditState => {
    const el = textareaRef.current;
    return {
      value,
      start: el?.selectionStart ?? value.length,
      end: el?.selectionEnd ?? value.length,
    };
  }, [value]);

  /** 提交一次编辑（先记选区，值落地后再应用） */
  const applyEdit = useCallback(
    (next: EditState): void => {
      pendingSelection.current = [next.start, next.end];
      onChange(next.value);
    },
    [onChange],
  );

  /** 切换视图模式 */
  const changeMode = useCallback(
    (next: EditorMode): void => {
      setMode(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  /** 工具栏动作分发 */
  const runAction = useCallback(
    (id: string): void => {
      const state: EditState = readState();
      switch (id) {
        case 'bold':
          applyEdit(wrapSelection(state, '**', '**'));
          return;
        case 'italic':
          applyEdit(wrapSelection(state, '*', '*'));
          return;
        case 'strike':
          applyEdit(wrapSelection(state, '~~', '~~'));
          return;
        case 'code':
          applyEdit(wrapSelection(state, '`', '`'));
          return;
        case 'h1':
          applyEdit(applyHeading(state, 1));
          return;
        case 'h2':
          applyEdit(applyHeading(state, 2));
          return;
        case 'h3':
          applyEdit(applyHeading(state, 3));
          return;
        case 'ul':
          applyEdit(applyList(state, 'ul'));
          return;
        case 'ol':
          applyEdit(applyList(state, 'ol'));
          return;
        case 'task':
          applyEdit(applyList(state, 'task'));
          return;
        case 'quote':
          applyEdit(applyQuote(state));
          return;
        case 'fence':
          applyEdit(applyCodeBlock(state));
          return;
        case 'link':
          applyEdit(insertLink(state, false));
          return;
        case 'image':
          applyEdit(insertLink(state, true));
          return;
        case 'table':
          applyEdit(insertTable(state));
          return;
        case 'hr':
          applyEdit(insertHr(state));
          return;
        default:
          return;
      }
    },
    [applyEdit, readState],
  );

  /** 按键处理：快捷键 + 自动格式化 */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      const mod: boolean = event.metaKey || event.ctrlKey;

      if (mod && !event.altKey) {
        const key: string = event.key.toLowerCase();
        switch (key) {
          case 'b':
            event.preventDefault();
            applyEdit(wrapSelection(readState(), '**', '**'));
            return;
          case 'i':
            event.preventDefault();
            applyEdit(wrapSelection(readState(), '*', '*'));
            return;
          case 'k':
            event.preventDefault();
            applyEdit(insertLink(readState(), false));
            return;
          case '1':
          case '2':
          case '3': {
            event.preventDefault();
            applyEdit(applyHeading(readState(), Number.parseInt(key, 10)));
            return;
          }
          default:
            break;
        }
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        const state: EditState = readState();
        const multiLine: boolean = state.value.slice(state.start, state.end).includes('\n');
        const lineStart: number = lineStartOf(state.value, state.start);
        const currentLine: string = state.value.slice(lineStart, lineEndOf(state.value, state.start));
        const inList: boolean = /^\s*([-*+]|\d+[.)])\s+/.test(currentLine) || /^\s*>\s?/.test(currentLine);
        if (multiLine || inList) {
          applyEdit(indentBlock(state, event.shiftKey));
          return;
        }
        applyEdit(insertText(state, INDENT));
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey && !mod) {
        const next: EditState | null = handleEnter(readState());
        if (next) {
          event.preventDefault();
          applyEdit(next);
        }
        return;
      }

      // —— 围栏代码块：连敲第三个反引号时摊成三行（V47）——
      //
      // 用户原话：「code ```输入貌似只能输入一行内容，不能自动根据我的输入扩展行数」。
      // 根因：`AUTO_PAIRS` 把反引号也当成了「成对符号」—— 敲第一个 ` 立刻补出 ``，
      // 敲到第三个时又命中"右侧已有闭符号就跳过"分支，于是三个反引号**在同一行被就地闭合**，
      // 围栏从头到尾只有一行，代码无处可写。
      //
      // 这里特判「补上的第三个反引号」= 用户明确要一个代码块：直接摊成
      // ```\n<缩进>\n```，并把光标放到中间那行。缩进跟随当前行，
      // 这样在列表项里也能插代码块。单个反引号的行内代码仍走原有自动配对。
      if (event.key === '`' && !mod && !event.altKey) {
        const state: EditState = readState();
        const twoBefore: string = state.value.slice(Math.max(0, state.start - 2), state.start);
        if (state.start === state.end && twoBefore === '``') {
          event.preventDefault();
          const lineStart: number = lineStartOf(state.value, state.start);
          const indent: string = /^[ \t]*/.exec(state.value.slice(lineStart, state.start))?.[0] ?? '';
          const head: string = state.value.slice(0, state.start - 2);
          const tail: string = state.value.slice(state.end);
          // 三行：开围栏 / 缩进占位 / 闭围栏
          const block: string = `\`\`\`\n${indent}\n${indent}\`\`\``;
          const caret: number = head.length + 4 + indent.length;
          applyEdit({ value: `${head}${block}${tail}`, start: caret, end: caret });
          return;
        }
      }

      const closing: string | undefined = AUTO_PAIRS[event.key];
      if (closing !== undefined && !mod && !event.altKey) {
        const state: EditState = readState();
        event.preventDefault();
        if (state.start !== state.end) {
          applyEdit(wrapSelection(state, event.key, closing));
          return;
        }
        // 右侧已有相同闭符号 → 跳过，避免重复
        if (state.value.slice(state.end, state.end + 1) === closing) {
          applyEdit({ value: state.value, start: state.end + 1, end: state.end + 1 });
          return;
        }
        const caret: number = state.start + 1;
        applyEdit({
          value: state.value.slice(0, state.start) + event.key + closing + state.value.slice(state.end),
          start: caret,
          end: caret,
        });
      }
    },
    [applyEdit, readState],
  );

  /** 分屏滚动同步：按滚动百分比做简单映射 */
  const handleEditorScroll = useCallback((): void => {
    if (mode !== 'split' || syncingRef.current) {
      return;
    }
    const editor = textareaRef.current;
    const preview = previewRef.current;
    if (!editor || !preview) {
      return;
    }
    const editorMax: number = editor.scrollHeight - editor.clientHeight;
    const previewMax: number = preview.scrollHeight - preview.clientHeight;
    if (editorMax <= 0 || previewMax <= 0) {
      return;
    }
    syncingRef.current = true;
    preview.scrollTop = (editor.scrollTop / editorMax) * previewMax;
    window.requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  }, [mode]);

  const charCount: number = value.length;
  const lineCount: number = value === '' ? 0 : value.split('\n').length;

  return (
    <div className={`flex min-h-0 min-w-0 flex-col ${className}`}>
      {/* 工具栏：窄窗自动换行，不溢出 */}
      {showToolbar && (
        <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-black/5 px-1.5 py-1">
          {TOOLBAR_ITEMS.map((item, index) => {
            const Icon = item.icon;
            const prev = index > 0 ? TOOLBAR_ITEMS[index - 1] : undefined;
            return (
              <React.Fragment key={item.id}>
                {prev && prev.group !== item.group && <span className="mx-0.5 h-4 w-px shrink-0 bg-black/10" />}
                <IconButton title={item.title} onClick={() => runAction(item.id)}>
                  <Icon className="h-3.5 w-3.5" />
                </IconButton>
              </React.Fragment>
            );
          })}
          <span className="mx-0.5 h-4 w-px shrink-0 bg-black/10" />
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {MODE_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <IconButton
                  key={item.id}
                  title={item.title}
                  active={mode === item.id}
                  onClick={() => changeMode(item.id)}
                >
                  <Icon className="h-3.5 w-3.5" />
                </IconButton>
              );
            })}
          </span>
        </div>
      )}

      {/* 编辑区 / 预览区 */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {mode !== 'preview' && (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onScroll={handleEditorScroll}
            onFocus={onFocus}
            onBlur={onBlur}
            placeholder={placeholder}
            spellCheck={false}
            className={`scrollbar-thin min-h-0 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-sm leading-relaxed text-inherit outline-none placeholder:opacity-40 ${
              mode === 'split' ? 'basis-1/2' : ''
            }`}
          />
        )}

        {mode === 'split' && <div className="w-px shrink-0 bg-black/10" />}

        {mode !== 'edit' && (
          <div
            ref={previewRef}
            className={`md-preview scrollbar-thin min-h-0 min-w-0 flex-1 overflow-auto px-3 py-2 ${
              mode === 'split' ? 'basis-1/2' : ''
            }`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>

      {/* 状态条：字数 / 行数 / 当前模式 */}
      {showStatusBar && (
        <div className="flex h-5 shrink-0 items-center gap-2 px-2 text-[10px] opacity-40">
          <span>{charCount} 字</span>
          <span>{lineCount} 行</span>
          <span className="ml-auto">{mode === 'edit' ? '编辑' : mode === 'split' ? '分屏' : '预览'}</span>
        </div>
      )}
    </div>
  );
}

export default MarkdownEditor;

/**
 * 纯文本算子集合（**无 DOM 依赖**，供单元测试 / 回归脚本直接调用）。
 *
 * 自动格式化逻辑全部实现为「(文本, 选区) → (新文本, 新选区)」的纯函数，
 * 因此可以在 Node 环境直接断言，无需浏览器；导出它们不影响运行时行为。
 */
export const markdownOps = {
  lineStartOf,
  lineEndOf,
  wrapSelection,
  mapSelectedLines,
  applyHeading,
  applyList,
  applyQuote,
  applyCodeBlock,
  insertText,
  insertLink,
  insertTable,
  insertHr,
  indentBlock,
  handleEnter,
};

