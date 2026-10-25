import React, { useCallback, useEffect, useRef, useState } from 'react';
import { highlightCodeHtml, isSupportedLang, normalizeLang } from '@/components/CodeBlock';
import { renderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import '@/styles/markdown.css';

/**
 * 所见即所得 Markdown 输入（RichMarkdown）。
 *
 * # 为什么需要它
 *
 * `MarkdownEditor` 是「源码 + 预览」双栏式：编辑区永远显示 `**加粗**` 这类**语法**，
 * 想看效果得扭头看另一半。用户真正要的是**边写边渲染**——敲完 `**今天**` 这四个字
 * 加两个星号，屏上就该直接变成**加粗的「今天」**，而不是留着星号让人自己脑补。
 * 于是有了本组件。
 *
 * # 实现路线（为什么是 contenteditable 而不是 textarea）
 *
 * `textarea` 只能承载纯文本，不可能做到「同一处既是输入又是渲染结果」，
 * 因此改用 `contentEditable` 容器，并在**输入事件里就地做两类转换**：
 *
 * 1. **行内即时转换**：光标前刚闭合的 `**x**` / `*x*` / `~~x~~` / `` `x` `` 立刻
 *    被替换成 `<strong>/<em>/<del>/<code>` 元素——**只改动刚输入的那一小段**，
 *    因此光标位置天然稳定，不会出现「打字打到一半被打断」的跳光标问题。
 * 2. **块级前缀转换**：行首敲出 `# ` / `- ` / `1. ` / `> ` / `[] ` 后，整块被
 *    提升为对应的块元素（标题 / 列表 / 引用 / 任务项），与 Typora、Notion 的习惯一致。
 *
 * 反向（DOM → Markdown）由 `serializeBlocks()` 负责，因此对外**始终只暴露 Markdown
 * 文本**：宿主照旧存 markdown、照旧用 `renderMarkdown()` 做只读展示，数据格式零迁移。
 *
 * # 边界处理
 *
 * - **外部值回灌**：只有 props.value 与「自己刚发出的值」不一致时才重建 DOM，
 *   否则每次输入都会重建内容、光标必丢；
 * - **粘贴**：只取纯文本，避免从网页粘进一堆内联样式把结构冲烂；
 * - **空态占位**：内容为空时显示 placeholder（CSS 伪元素做不到 `:empty` 判定，
 *   因为浏览器会在空块里塞 `<br>`，故用显式标记 + 真实节点）。
 *
 * # 浏览器内核踩过的坑（改这里之前务必先读）
 *
 * 这一层的每一处别扭都是为了绕开 `contentEditable` 的默认脾气。冒烟脚本见
 * `_smoke_drive.js`（用 `execCommand('insertText')` 逐字符驱动，读状态前要
 * `await` 一个 tick 让 React 把值刷出去，否则读到的永远是上一帧）。
 *
 * 1. **样式延续**：敲完 `**粗体**` 后光标若停在元素边界，Chrome 会把接下来敲的
 *    字继续塞进 `<strong>` 里。位置必须是「哨兵文本节点内的 offset 1」——
 *    offset 0、以及 `setStartAfter(el)` 都会延续样式。见 `convertInline`。
 * 2. **空文本节点会被回收**：拿 `createTextNode('')` 当锚点没用，浏览器在选区
 *    规范化时直接丢掉。必须用 `ZWSP` 哨兵。
 * 3. **`**x**` 的星号歧义**：逐字符输入时，第 5 个字符 `*` 会先命中单星号规则，
 *    把 `*x*` 提前变成斜体。斜体规则加了 `(?<!\*)` 前瞻断言来避让。
 * 4. **空块吞光标**：给空元素 `placeCaretAtEnd` 无效，光标会被挤回上一行。
 *    新块一律带一颗零宽种子，见 `withCaretSeed`。
 * 5. **搬动节点会重置选区**：把裸内容包进 `<div>` 后，浏览器把选区丢到容器开头，
 *    于是后续每个字符都插到行首。`wrapInlineRunAtCaret` 里必须手动还原光标。
 * 6. **零宽哨兵会混进块级标记判定**：`marker` 必须先 `stripZwsp`，否则
 *    `^#\s$` 之类的规则永远匹配不上。
 *
 * 已知取舍：在**列表项内部**敲 `> ` / `# ` 这类块级标记不会转换（列表项不是
 * 顶层块，直接替换会破坏 `<ul>` 结构），会原样保留为文本。
 *
 * # V21 增强：代码块能多行、能高亮、带语言
 *
 * 用户反馈「``` 只有一行输入不能换行等，也没有语法高亮等」。三处根因与对策：
 *
 * 1. **只有一行** —— 浏览器在 `<pre>` 里按回车默认会**跑出代码块**（另起一个
 *    `<div>`），于是代码块永远只有一行。现在回车改为**手工插入 `\n` 文本节点**
 *    留在块内；`Esc` 随时可跳出，块尾空行上**连按两下回车**才收尾（V67 收紧，
 *    见下）。
 *
 * # V67：便签里「回车不能换行」的两个真根因（用户 09-22 附截图）
 *
 * 用户原话「便签中的 markdown 编辑器有问题 …… 不能回车只能写一行，而且样式很丑」。
 * 用 `agent-browser` 真实按键复现（把库里那份 ```` ```shell ```` 内容按挂载态造出来），
 * 两条独立病根：
 *
 * 1. **换行插在了「上一行的行尾」而不是「下一行的行首」。** 旧写法
 *    `range.insertNode(createTextNode('\n'))` 之后 DOM 是 `T["AB"] + T["\n"]`、
 *    光标停在第二个节点的开头 —— 浏览器把「独立 `\n` 节点开头」当成上一行的行尾，
 *    接着敲的字符**全被插到换行之前**，屏上永远只有一行。
 *    ⇒ 改成把 `\n` **就地写进光标所在的那个文本节点**（光标挂在元素上时先锚一颗
 *    `ZWSP` 把光标规范化进文本节点），同节点内的偏移不会有歧义。
 *    → [`insertNewlineInPre`]
 * 2. **「末行是空行就收尾跳出」这条规则把第一下回车也吃掉了。** 从库里读回来的
 *    代码块内容本身就以 `\n` 收尾（围栏的常态），于是用户坐下敲的**第一下**回车就被
 *    判成收尾：不换行、还把那个 `\n` 删掉、并把光标扔到块外的空段落里 ——
 *    「写着写着跑到框外面」。
 *    ⇒ 收紧为「块尾**连着两个**换行 + 光标在块尾」才收尾（连按两下回车），
 *      单次回车**永远只换行**。→ [`handlePreEnter`] 规则 ②
 *
 * 顺带修好：[`handlePreEnter`] 规则 ① 的语言名判据从「块里不能有换行」放宽为
 * 「块里只剩一行非空内容且那行是语言名」—— 否则「``` ⏎ shell ⏎」这条 V21 习惯
 * 永远不生效（第一次回车已经把 `\n` 带进块里了）。
 * 2. **没有语言** —— 围栏规则从只认裸 ``` ``` ``` 扩展为 ```` ```lang ````，
 *    语言记在 `pre.dataset.lang`；顺手支持「先起块、再敲 `shell` 回车」的写法
 *    （仅当该词是**内置高亮语言**时才认，避免把一行 `ls` 吃掉）。
 * 3. **没有高亮** —— 复用 `CodeBlock` 的同一套词法规则，把 `pre > code` 的内容
 *    重建为带颜色的 `<span>`。重建会动 DOM、可能丢光标，因此：
 *    - 只在内容**真的变了**时重建（`hlKey` 比对，避免无谓抖动）；
 *    - 重建前后按**可见字符偏移**保存 / 还原光标；
 *    - 光标落在边界（块首 / 块尾）时插一颗 `ZWSP` 哨兵再落光标 ——
 *      沿用行内转换那套「哨兵断样式继承」的老办法，避免接着敲的字继续染成
 *      上一个 token 的颜色。
 *
 * 输入期高亮走 400ms 空转去抖：连续敲字时不动 DOM，停一拍颜色就上。
 */

export interface RichMarkdownProps {
  /** 当前 Markdown 源文本（受控；宿主存的就是它） */
  value: string;
  /** 内容变更回调（markdown 文本） */
  onChange: (next: string) => void;
  /** 空内容占位提示 */
  placeholder?: string;
  /** 附加样式（通常用来控制高度 / 内边距） */
  className?: string;
  /** 只读模式：仅渲染不可编辑（查看态用） */
  readOnly?: boolean;
  /**
   * 单行模式（任务标题用）：回车不换行，改为触发 `onEnter`。
   */
  singleLine?: boolean;
  /** 单行模式下回车触发 */
  onEnter?: () => void;
  /** 失焦（宿主可借此立即落库，不必等防抖） */
  onBlur?: () => void;
  /** 聚焦（宿主可据此暂停「远端内容覆盖本地草稿」，避免打字被打断） */
  onFocus?: () => void;
  /** 无障碍标签 */
  ariaLabel?: string;
}

/**
 * 代码块高亮去抖（毫秒）。
 *
 * 连续敲字期间不动 DOM（改 DOM 就可能动光标），停一拍再把颜色补上 ——
 * 视觉上仍是「随时渲染」，但把光标抖动的风险压到最低。
 */
const HIGHLIGHT_DEBOUNCE_MS = 400;

/**
 * 每个 `pre` 最近一次高亮对应的内容指纹。
 *
 * 用 `WeakMap` 而不是 `dataset`：指纹里含整段代码，写进 DOM 属性会让每次
 * 高亮都触发一次属性序列化。内容没变就不重建 DOM，是「光标不乱跳」的前提。
 */
const highlightedKeys = new WeakMap<HTMLElement, string>();

/** 行内即时转换规则（顺序敏感：`**` 必须早于 `*`，否则会被单星号规则截胡） */
const INLINE_RULES: ReadonlyArray<{ re: RegExp; tag: string }> = [
  { re: /\*\*([^*\n]+)\*\*$/, tag: 'strong' },
  { re: /~~([^~\n]+)~~$/, tag: 'del' },
  { re: /`([^`\n]+)`$/, tag: 'code' },
  // `(?<!\*)` 是关键：用户敲 `**粗体**` 时，第 5 个字符 `*` 会**先**命中单星号规则，
  // 把 `*粗体*` 提前变成斜体；等第 6 个 `*` 落下来已经回不去了（`*<em>粗体</em>*`）。
  // 要求开星号前面不能再是 `*`，就把「连续星号」整体让给 `**` 规则去消化。
  { re: /(?<!\*)\*([^*\n]+)\*$/, tag: 'em' },
];

/** 块级前缀规则（匹配「标记 + 尾随空格」或独占围栏） */
interface BlockRule {
  re: RegExp;
  /** 目标标签：`h1`~`h6` / `ul` / `ol` / `task` / `quote` / `pre` */
  kind: string;
}

const BLOCK_RULES: readonly BlockRule[] = [
  { re: /^(#{1,6})\s$/, kind: 'h' },
  // 分割线：独占一行的 `---` / `***` / `___`（连字符 / 星号 / 下划线三连及以上）。
  // 渲染侧 `markdown.ts` 的 `normalizeHorizontalRules` 早就把 `---` 落成 `<hr>`，这里只补
  // 「输入期转换」—— 用户敲完第三个 `-` 当场看到一条线，而不是等到下次重渲染。
  { re: /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/, kind: 'hr' },
  // 围栏代码块：裸 ``` ``` ``` 与带语言的 ```` ```shell ```` 都认；语言由捕获组带出
  { re: /^```([A-Za-z0-9+#._-]*)$/, kind: 'pre' },
  { re: /^>\s$/, kind: 'quote' },
  { re: /^\[[ xX]?\]\s$/, kind: 'task' },
  { re: /^[-*+]\s$/, kind: 'ul' },
  { re: /^\d+[.)]\s$/, kind: 'ol' },
];

/** 光标移到元素内容末尾 */
function placeCaretAtEnd(el: HTMLElement): void {
  const range: Range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection: Selection | null = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** 取光标所在位置的直接块级子元素（`root` 的孩子） */
function directBlockOf(root: HTMLElement, node: Node): HTMLElement | null {
  let current: Node | null = node;
  while (current && current.parentNode !== root) {
    current = current.parentNode;
  }
  if (current && current.nodeType === Node.ELEMENT_NODE) {
    return current as HTMLElement;
  }
  return null;
}

/** 节点是否属于「行内内容」（裸文本 / 行内元素） */
function isInlineNode(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return true;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  return !BLOCK_TAGS.has((node as HTMLElement).tagName.toLowerCase());
}

/**
 * 光标所在「块」的兜底：编辑器还空着时，浏览器把用户敲的第一笔直接挂在根节点上
 * （不套 `<div>`），此时没有块元素可供替换。这里把光标所在的这段连续行内内容
 * 就地包进一个 `<div>`，让后续逻辑与「已经有块」的情况完全一致
 * —— 否则在新笔记里敲 `# ` 永远变不出标题。
 *
 * @returns 包裹后的容器；光标不在根的直接子节点上时返回 null
 */
function wrapInlineRunAtCaret(root: HTMLElement, node: Node): HTMLElement | null {
  if (node.parentNode !== root) {
    return null;
  }
  // 先记下光标：`appendChild` 搬动节点会让浏览器把选区重置到新容器开头，
  // 若不还原，接着敲的每个字符都会插到行首（曾导致 `**粗体**` 退化成 `*<em>粗体</em>**`）。
  const selection: Selection | null = window.getSelection();
  const live: Range | null =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const savedNode: Node | null = live ? live.startContainer : null;
  const savedOffset: number = live ? live.startOffset : 0;

  const children: Node[] = Array.from(root.childNodes);
  const anchor: number = children.indexOf(node);
  if (anchor < 0) {
    return null;
  }
  let start: number = anchor;
  let end: number = anchor;
  while (start - 1 >= 0 && isInlineNode(children[start - 1]!)) {
    start -= 1;
  }
  while (end + 1 < children.length && isInlineNode(children[end + 1]!)) {
    end += 1;
  }

  const wrapper: HTMLElement = document.createElement('div');
  const after: Node | undefined = children[end + 1];
  if (after) {
    root.insertBefore(wrapper, after);
  } else {
    root.appendChild(wrapper);
  }
  for (let i: number = start; i <= end; i += 1) {
    wrapper.appendChild(children[i]!);
  }

  // 还原光标（节点仍在文档里就按原偏移放回，否则退化为行尾）
  if (savedNode && savedNode.parentNode) {
    const maxOffset: number =
      savedNode.nodeType === Node.TEXT_NODE
        ? (savedNode.nodeValue ?? '').length
        : savedNode.childNodes.length;
    const restore: Range = document.createRange();
    restore.setStart(savedNode, Math.min(savedOffset, maxOffset));
    restore.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(restore);
  } else {
    placeCaretAtEnd(wrapper);
  }
  return wrapper;
}

/** 取当前折叠光标的 (文本节点, 偏移)；非折叠或不在文本节点上时返回 null */
function caretInTextNode(): { node: Text; offset: number } | null {
  const selection: Selection | null = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const range: Range = selection.getRangeAt(0);
  if (!range.collapsed) {
    return null;
  }
  const node: Node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  return { node: node as Text, offset: range.startOffset };
}

// —— DOM → Markdown 序列化 ——

/**
 * 零宽空格（U+200B），只作**光标锚点**用，绝不进入 Markdown 文本。
 *
 * 为什么不能用「空文本节点」当锚点：转换完把光标放进 `createTextNode('')` 后，
 * 浏览器在选区规范化时会把空文本节点直接丢掉，光标随即被并回前面的
 * `<strong>` / `<em>` 里 —— 于是接着敲的普通文字莫名其妙继承加粗，
 * 敲 `*斜体*` 又叠成 `***斜体***`。带一个零宽字符的文本节点非空、不会被回收，
 * 光标才能稳稳停在格式之外；序列化时统一剥掉即可。
 */
const ZWSP = '\u200B';

/** 去掉所有零宽锚点，得到用户真正写下的文本 */
function stripZwsp(value: string): string {
  return value.replace(/\u200B/g, '');
}

/**
 * 零宽锚点在**可见文本**里的插入位（V68）。
 *
 * `ZWSP` 不占可见宽度，所以它只记「插在第几个可见字符之前」；文本末尾的锚点记成 `text.length`
 * 之后那位（= 可见长度）。
 *
 * 用途：高亮要重建 `pre > code` 的 `innerHTML`，而重建只能喂**剥掉锚点**的纯文本 ——
 * 于是锚点必须先在重建前记下来、重建后按位塞回去（[`reapplyZwsp`]）。
 */
function zwspOffsets(text: string): number[] {
  const out: number[] = [];
  let visible = 0;
  for (const ch of text) {
    if (ch === ZWSP) {
      out.push(visible);
    } else {
      visible += 1;
    }
  }
  return out;
}

/**
 * 把零宽锚点按偏移表塞回一段（刚被重建过的）DOM（V68）。
 *
 * ⚠️ **这是「代码块换行不会自己消失」的命门**，别删。
 *
 * 真机症状（用户 09-22）：「markdown code 里面我有时候回车换行，自己又删除换行到上一行后面了」。
 * 根因链：
 *   ① 代码块里回车 → `insertNewlineInPre` 往光标所在文本节点写 `\n` + 一颗 `ZWSP`，
 *      光标落在 `ZWSP` 之后 —— 那一行"空的第二行"其实是**靠这颗 ZWSP 撑着的**；
 *   ② 输入停下 400ms（`HIGHLIGHT_DEBOUNCE_MS`）→ `applyHighlight` 重建 `codeEl.innerHTML`，
 *      而它喂进去的是 `stripZwsp(textContent)` —— **锚点全被抹掉**；
 *   ③ 于是节点变成以 `\n` 收尾：那一行不显示了、光标也被并回上一行 → 用户看到的就是
 *      「换行自己没了，字跑到上一行后面」。
 *
 * 高亮本身必须保留（用户要的就是所见即所得），所以解法不是「编辑期别重建」，而是
 * **重建完把锚点按原位置塞回去**：`ZWSP` 零宽，塞回去不影响任何可见文本与高亮 token。
 *
 * @param root 刚被重建 innerHTML 的元素（`pre > code`）
 * @param offsets [`zwspOffsets`] 在**重建前**记录下来的偏移表
 */
function reapplyZwsp(root: HTMLElement, offsets: number[]): void {
  if (offsets.length === 0) {
    return;
  }
  const walker: TreeWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pending = 0;
  let seen = 0;
  let node: Node | null = walker.nextNode();
  while (node !== null) {
    const text: string = (node as Text).nodeValue ?? '';
    let out = '';
    for (const ch of text) {
      while (pending < offsets.length && offsets[pending] === seen) {
        out += ZWSP;
        pending += 1;
      }
      out += ch;
      seen += 1;
    }
    // 末尾锚点（`offsets` 里等于可见总长的那几位）要落在最后一个节点之后
    while (pending < offsets.length && offsets[pending] === seen) {
      out += ZWSP;
      pending += 1;
    }
    if (out !== text) {
      (node as Text).nodeValue = out;
    }
    node = walker.nextNode();
  }
}

/**
 * 给每个「以换行收尾」的代码块补一颗**尾锚**（V68）。
 *
 * 为什么还要单独补：挂载 / 外部换值时走的是 `root.innerHTML = renderMarkdown(value)`，
 * 那条路不经过 [`reapplyZwsp`]，而 `marked` 产出的 `<code>` 内容就是**以 `\n` 收尾**的
 * （markdown 围栏的天然形状）。少了尾锚，用户点到最后一行末尾接着敲，字就被并回上一行 ——
 * 与「回车换行自己消失」是同一个病、同一条根因。
 */
function ensureTrailingZwsp(root: HTMLElement): void {
  const pres: NodeListOf<HTMLElement> = root.querySelectorAll<HTMLElement>('pre');
  pres.forEach((pre: HTMLElement): void => {
    const codeEl: HTMLElement = ensureCodeChild(pre);
    const text: string = codeEl.textContent ?? '';
    if (!text.endsWith('\n')) {
      return;
    }
    const last: Node | null = codeEl.lastChild;
    if (
      last !== null &&
      last.nodeType === Node.TEXT_NODE &&
      (last.nodeValue ?? '').endsWith(ZWSP)
    ) {
      return;
    }
    // 最后一个子节点是元素（高亮后的 `<span>`）也没关系：尾锚接在它后面同样管用
    codeEl.appendChild(document.createTextNode(ZWSP));
  });
}

/**
 * 造一个「自带零宽种子」的空块。
 *
 * 直接给空元素 `placeCaretAtEnd` 是没用的：空块里没有文本节点，Chrome 的选区
 * 规范化会把光标**挤回上一行**（曾导致敲完 `# ` 变出空 `<h1>` 后，接着敲的
 * 「大标题」跑进上一段的删除线里）。塞一颗零宽种子，块就不再是空的，
 * 光标稳稳落在种子之后，而种子在序列化时被剥掉，不污染 Markdown。
 */
function withCaretSeed(tag: string): HTMLElement {
  const el: HTMLElement = document.createElement(tag);
  el.appendChild(document.createTextNode(ZWSP));
  return el;
}

/**
 * 取围栏代码块的语言标识。
 *
 * 两个来源：编辑期写进 `pre.dataset.lang` 的，以及 marked 渲染出来的
 * `<code class="language-shell">`。二者取其一，都没有就是「无语言围栏」。
 */
function fenceLangOf(pre: HTMLElement, codeEl: HTMLElement): string {
  const fromDataset: string = normalizeLang(pre.dataset.lang ?? '');
  if (fromDataset !== '') {
    return fromDataset;
  }
  const matched: RegExpExecArray | null = /(?:^|\s)language-([A-Za-z0-9+#._-]+)/.exec(codeEl.className);
  return normalizeLang(matched?.[1] ?? '');
}

/** 确保 `pre` 里有 `code` 子元素（marked 会产出，手工建块时也建了；这里只兜底） */
function ensureCodeChild(pre: HTMLElement): HTMLElement {
  const existing: HTMLElement | null = pre.querySelector('code');
  if (existing !== null) {
    return existing;
  }
  const code: HTMLElement = document.createElement('code');
  while (pre.firstChild !== null) {
    code.appendChild(pre.firstChild);
  }
  pre.appendChild(code);
  return code;
}

/**
 * 光标在 `scope` 内的**可见字符偏移**（零宽锚点不计入）。
 *
 * 高亮要重建 innerHTML，重建前只能用偏移量记住光标位置，重建后再换算回来。
 * @returns 光标不在 `scope` 内时返回 null（此时无需还原，随便重建）
 */
function caretOffsetIn(scope: HTMLElement): number | null {
  const selection: Selection | null = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const range: Range = selection.getRangeAt(0);
  if (!scope.contains(range.startContainer)) {
    return null;
  }
  const probe: Range = document.createRange();
  probe.selectNodeContents(scope);
  probe.setEnd(range.startContainer, range.startOffset);
  return stripZwsp(probe.toString()).length;
}

/**
 * 光标是不是正待在 `scope` 内容的**最末尾**（折叠选区、且后面再无任何内容）。
 *
 * 用途：判定「代码块收尾」（见 `handlePreEnter` 规则 ②）。少了这道检查，
 * 光标停在代码块中间、而块**尾部**恰好是空行时，按回车会把用户从块里踢出去。
 */
function caretAtEndOf(scope: HTMLElement): boolean {
  const selection: Selection | null = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return false;
  }
  const range: Range = selection.getRangeAt(0);
  if (!scope.contains(range.startContainer)) {
    return false;
  }
  const probe: Range = document.createRange();
  probe.selectNodeContents(scope);
  probe.setStart(range.startContainer, range.startOffset);
  return stripZwsp(probe.toString()) === '';
}

/**
 * 把光标放回 `scope` 内的第 `offset` 个**可见**字符处（高亮重建后调用）。
 *
 * 边界情况（偏移 0 或等于总长）不能直接落在已有文本节点里 —— 浏览器会按
 * 「紧邻前一个行内元素」延续样式，接着敲的字就染成上一个 token 的颜色。
 * 这两种情况一律插一颗 `ZWSP` 哨兵再落光标（与 `convertInline` 同一套办法）。
 *
 * ⚠️ V68：计数必须**跳过零宽锚点**。以前重建后的 DOM 里从来没有 `ZWSP`，所以「节点长度」
 * 与「可见长度」恰好相等；现在重建后会把锚点按位塞回去（[`reapplyZwsp`]），两个长度不再相等，
 * 再按节点长度算就会**把光标整体推偏**（真机上表现为「回车插到了行首、文本倒着长」）。
 */
function restoreCaretIn(scope: HTMLElement, offset: number): void {
  const selection: Selection | null = window.getSelection();
  if (!selection) {
    return;
  }
  const place = (node: Node, at: number): void => {
    const range: Range = document.createRange();
    range.setStart(node, at);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  if (offset <= 0) {
    const head: Text = document.createTextNode(ZWSP);
    scope.insertBefore(head, scope.firstChild);
    place(head, 1);
    return;
  }

  const walker: TreeWalker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let remaining: number = offset;
  let node: Node | null = walker.nextNode();
  let last: Text | null = null;
  while (node) {
    const text: Text = node as Text;
    const cells: string[] = Array.from(text.nodeValue ?? '');
    last = text;
    let visible = 0;
    let at = -1;
    for (let i = 0; i <= cells.length; i += 1) {
      if (visible === remaining) {
        at = i;
        break;
      }
      if (i < cells.length && cells[i] !== ZWSP) {
        visible += 1;
      }
    }
    if (at >= 0) {
      place(text, at);
      return;
    }
    remaining -= visible;
    node = walker.nextNode();
  }

  // 跑到末尾（或 scope 里一个文本节点都没有）：补哨兵
  const tail: Text = document.createTextNode(ZWSP);
  if (last === null) {
    scope.appendChild(tail);
  } else {
    last.after(tail);
  }
  place(tail, 1);
}

/** 行内序列化：把富文本节点还原成 markdown 行内语法 */
function serializeInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return stripZwsp(node.nodeValue ?? '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }
  const el: HTMLElement = node as HTMLElement;
  const tag: string = el.tagName.toLowerCase();
  const inner: string = Array.from(el.childNodes).map(serializeInline).join('');

  switch (tag) {
    case 'strong':
    case 'b':
      return inner === '' ? '' : `**${inner}**`;
    case 'em':
    case 'i':
      return inner === '' ? '' : `*${inner}*`;
    case 'del':
    case 's':
    case 'strike':
      return inner === '' ? '' : `~~${inner}~~`;
    case 'code':
      return inner === '' ? '' : `\`${inner}\``;
    case 'a': {
      const href: string = el.getAttribute('href') ?? '';
      return inner === '' ? '' : `[${inner}](${href})`;
    }
    case 'img': {
      const alt: string = el.getAttribute('alt') ?? '';
      const src: string = el.getAttribute('src') ?? '';
      return `![${alt}](${src})`;
    }
    case 'br':
      return '\n';
    case 'input':
      // 任务项复选框由 li 层统一处理，这里不产出文本
      return '';
    default:
      return inner;
  }
}

/** 会被当成「独立成行」的块级标签；不在表内的都算行内内容，需并入同一行 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'div',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'blockquote',
  'pre',
  'hr',
  'table',
]);

/** 块级序列化：把编辑区还原成 markdown 文本（编辑器对外只暴露这一份数据） */
function serializeBlocks(root: HTMLElement): string {
  const lines: string[] = [];
  /** 连续的行内节点（裸文本 / `<strong>` …）攒成同一行 */
  let inline: string = '';

  const flushInline = (): void => {
    if (inline.trim() !== '') {
      lines.push(inline);
    }
    inline = '';
  };

  Array.from(root.childNodes).forEach((node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      inline += stripZwsp(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const el: HTMLElement = node as HTMLElement;
    const tag: string = el.tagName.toLowerCase();

    // 行内节点（含 `<br>`）并入当前行，不单独成行。
    // 编辑器还空着时浏览器会把内容直接挂在根节点上（不套 div），若不归并，
    // 视觉上的一行 `**粗体** 普通` 会被拆成两行 Markdown 输出。
    if (!BLOCK_TAGS.has(tag)) {
      if (tag === 'br') {
        flushInline();
        return;
      }
      inline += serializeInline(el);
      return;
    }

    flushInline();

    // 标题
    const heading: RegExpExecArray | null = /^h([1-6])$/.exec(tag);
    if (heading) {
      const level: number = Number.parseInt(heading[1] ?? '1', 10);
      // 空标题（内容被删光，浏览器留下 `<h1><br></h1>`）不再吐出孤零零的 `#`，
      // 否则空文档会序列化出一个空标题。
      const body: string = serializeInline(el).replace(/\s+$/, '');
      lines.push(body === '' ? '' : `${'#'.repeat(level)} ${body}`);
      return;
    }

    // 列表（含 GFM 任务项）
    if (tag === 'ul' || tag === 'ol') {
      const items: Element[] = Array.from(el.children).filter(
        (child: Element): boolean => child.tagName.toLowerCase() === 'li',
      );
      items.forEach((li: Element, index: number): void => {
        const checkbox: HTMLInputElement | null = li.querySelector('input[type="checkbox"]');
        // li 的直接文本（排除复选框本身，它不产出文本）
        const body: string = serializeInline(li).replace(/^\s*\n/, '').trim();
        if (checkbox) {
          lines.push(`- [${checkbox.checked ? 'x' : ' '}] ${body}`);
          return;
        }
        if (tag === 'ol') {
          lines.push(`${index + 1}. ${body}`);
          return;
        }
        lines.push(`- ${body}`);
      });
      return;
    }

    // 引用
    if (tag === 'blockquote') {
      const inner: string = serializeBlocks(el);
      inner.split('\n').forEach((line: string): void => {
        lines.push(line.trim() === '' ? '>' : `> ${line}`);
      });
      return;
    }

    // 代码块（保留语言标识，尾部空行剥掉，避免每次序列化都多出一行）
    if (tag === 'pre') {
      const codeEl: HTMLElement = ensureCodeChild(el);
      const lang: string = fenceLangOf(el, codeEl);
      const code: string = stripZwsp(codeEl.textContent ?? '').replace(/\n+$/, '');
      lines.push(`\`\`\`${lang}`);
      lines.push(code);
      lines.push('```');
      return;
    }

    if (tag === 'hr') {
      lines.push('---');
      return;
    }

    // 段落 / 普通块（含浏览器自产的 div）
    lines.push(serializeInline(el));
  });

  // 收尾：把最后一段还没落行的行内内容补上
  flushInline();

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
}

/** 内容是否「视觉为空」（浏览器会在空块塞 `<br>`，零宽锚点也不算内容） */
function isVisuallyEmpty(root: HTMLElement): boolean {
  if (stripZwsp(root.textContent ?? '').trim() !== '') {
    return false;
  }
  return root.querySelector('img, hr, input') === null;
}

/**
 * 所见即所得 Markdown 输入框。
 *
 * @param props 见 `RichMarkdownProps`
 * @returns 可编辑的富文本容器
 */
export function RichMarkdown({
  value,
  onChange,
  placeholder = '',
  className = '',
  readOnly = false,
  singleLine = false,
  onEnter,
  onBlur,
  onFocus,
  ariaLabel,
}: RichMarkdownProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 自己刚发出的 markdown：用于区分「外部改值」与「自己的回声」，避免无谓重建 */
  const lastEmitted = useRef<string | null>(null);
  const [empty, setEmpty] = useState<boolean>(value.trim() === '');

  /** 把编辑区内容同步出去 */
  const emit = useCallback((): void => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    setEmpty(isVisuallyEmpty(root));
    const next: string = serializeBlocks(root);
    lastEmitted.current = next;
    onChange(next);
  }, [onChange]);

  // ————————————————————————————————————————————————————————————
  // 围栏代码块：就地高亮
  //
  // 放在这两个 effect 之前是有意的：「挂载灌初值」与「外部换值」都要顺手把既有
  // 代码块上色，若把高亮器声明在它们后面，闭包里就是 TDZ（TS 也会直接报错）。
  // ————————————————————————————————————————————————————————————

  /**
   * 就地高亮所有围栏代码块。
   *
   * 内容指纹没变就直接跳过 —— 这是「不抖」的关键：光标还原再准，也比不上
   * 根本不动 DOM。真要重建时，先按可见字符偏移记住光标，重建后再换算回去。
   */
  const applyHighlight = useCallback((): void => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const pres: HTMLElement[] = Array.from(root.querySelectorAll<HTMLElement>('pre'));
    pres.forEach((pre: HTMLElement): void => {
      const codeEl: HTMLElement = ensureCodeChild(pre);
      const text: string = codeEl.textContent ?? '';
      const raw: string = stripZwsp(text);
      const lang: string = fenceLangOf(pre, codeEl);
      // ★ V68：重建前先把零宽锚点记账 —— `innerHTML` 一重建它们就全没了，
      // 而「回车换出来的那个空行」正是靠锚点撑着的（见 [`reapplyZwsp`] 的长注释）。
      // 另外给「以换行收尾」的块补一颗尾锚：光标停在末尾时不会被并回上一行。
      const anchors: number[] = zwspOffsets(text);
      if (raw.endsWith('\n') && !anchors.includes(raw.length)) {
        anchors.push(raw.length);
      }
      // 锚点也要进指纹：只变锚点、不变文本时同样需要重建（否则空行照样丢）
      const key = `${lang}\u0000${raw}\u0000${anchors.join(',')}`;
      if (highlightedKeys.get(pre) === key) {
        return;
      }
      highlightedKeys.set(pre, key);
      if (!isSupportedLang(lang) || raw.trim() === '') {
        // 不做高亮 ⇒ 不重建 ⇒ 锚点原样还在，**绝不能**在这里再塞一遍（会翻倍）
        return;
      }
      const offset: number | null = caretOffsetIn(pre);
      codeEl.innerHTML = highlightCodeHtml(raw, lang);
      // ⚠️ 顺序不能换：**先补锚点、再落光标**。
      //
      // [`reapplyZwsp`] 靠改 `Text.nodeValue` 插锚点，而 Chrome 在改这个属性时会把**落在该
      // 文本节点内的选区**归零 —— 光标当场跳到行首。真机上就是「回车换行跑到最前面、
      // 文字倒着长」。所以锚点必须在光标落定**之前**塞完，让最后一步是 `restoreCaretIn`。
      reapplyZwsp(codeEl, anchors);
      if (offset !== null) {
        restoreCaretIn(codeEl, offset);
      }
    });
  }, []);

  /** 高亮去抖句柄（输入期用；失焦 / 换值 / 挂载时立刻跑） */
  const highlightTimerRef = useRef<number | undefined>(undefined);
  const scheduleHighlight = useCallback((): void => {
    if (highlightTimerRef.current !== undefined) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = undefined;
      applyHighlight();
    }, HIGHLIGHT_DEBOUNCE_MS);
  }, [applyHighlight]);
  useEffect(
    () => () => {
      if (highlightTimerRef.current !== undefined) {
        window.clearTimeout(highlightTimerRef.current);
      }
    },
    [],
  );

  /** 首次挂载：灌入初值（并立刻给既有代码块上色） */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    root.innerHTML = renderMarkdown(value);
    // V68：`marked` 产出的 `<code>` 内容天然**以 `\n` 收尾** ⇒ 先补尾锚再上色，
    // 否则光标落到最后一行末尾接着敲，字会被并回上一行（见 [`ensureTrailingZwsp`]）。
    ensureTrailingZwsp(root);
    setEmpty(isVisuallyEmpty(root));
    applyHighlight();
    // 仅初始化执行一次：后续同步由 value 变更的 effect 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 外部值变更 → 重建 DOM（自己的回声直接跳过，否则光标必丢） */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    if (lastEmitted.current === value) {
      return;
    }
    if (serializeBlocks(root) === value) {
      return;
    }
    root.innerHTML = renderMarkdown(value);
    ensureTrailingZwsp(root);
    setEmpty(isVisuallyEmpty(root));
    applyHighlight();
  }, [value, applyHighlight]);

  /**
   * 摘掉「空格式壳」。
   *
   * 浏览器的内容可编辑区有个默认脾气：**回车 / 在行尾继续输入时会克隆上一行的
   * 行内格式**。于是敲完 `**粗体**` 再回车，新行往往是
   * `<div><strong><br></strong></div>` —— 用户接着敲什么都被莫名加粗，敲
   * `*斜体*` 更会叠成 `***斜体***`（粗 + 斜），源文本彻底走样。
   *
   * 这里在每次输入前，把**不含任何可见内容**的格式壳摘掉（有文字、含图片/链接/
   * 复选框的一律保留），让后续输入落回中性的块级上下文。
   */
  const pruneEmptyFormatting = useCallback((): void => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const selection: Selection | null = window.getSelection();
    const range: Range | null =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const caretNode: Node | null = range ? range.startContainer : null;

    const shells: HTMLElement[] = Array.from(
      root.querySelectorAll<HTMLElement>('strong, b, em, i, del, s, strike, code'),
    );

    const landings: HTMLElement[] = [];
    shells.forEach((shell: HTMLElement): void => {
      if (stripZwsp(shell.textContent ?? '').trim() !== '') {
        return;
      }
      if (shell.querySelector('img, a, input') !== null) {
        return;
      }
      const parent: HTMLElement | null = shell.parentElement;
      if (!parent) {
        return;
      }
      if (caretNode !== null && (shell === caretNode || shell.contains(caretNode))) {
        landings.push(parent);
      }
      shell.remove();
    });

    const target: HTMLElement | undefined = landings[0];
    if (!target) {
      return;
    }
    // 摘空了就补一个占位换行，保证这行仍可见、仍可输入
    if (target.childNodes.length === 0) {
      target.appendChild(document.createElement('br'));
    }
    placeCaretAtEnd(target);
  }, []);

  // ————————————————————————————————————————————————————————————
  // 围栏代码块：换行 / 认语言 / 跳出
  // ————————————————————————————————————————————————————————————

  /**
   * 光标所在的围栏代码块（不在代码块里返回 null）。
   *
   * 从光标**向上走到根**，沿途只要碰到 `<pre>` 就认 —— 不再用 `directBlockOf`
   * 只看 `root` 的**直接孩子**（V64 修正）。旧写法下，代码块一旦被嵌进
   * `<li>` / `<blockquote>`（例如用户在列表项里写 ``` ``` `），`directBlockOf` 返回的是
   * 外层 `<li>` / `<blockquote>` 而非 `<pre>`，`preAtCaret` 拿到 `null`，于是回车走浏览器
   * 默认行为「跑出代码块另起一个 `<div>`」，代码块永远只有一行。现在沿祖先链找 `<pre>`，
   * 嵌多深都认得出来。
   */
  const preAtCaret = useCallback((): HTMLElement | null => {
    const root = rootRef.current;
    const selection: Selection | null = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) {
      return null;
    }
    let current: Node | null = selection.getRangeAt(0).startContainer;
    while (current && current !== root) {
      if (
        current.nodeType === Node.ELEMENT_NODE &&
        (current as HTMLElement).tagName.toLowerCase() === 'pre'
      ) {
        return current as HTMLElement;
      }
      current = current.parentNode;
    }
    return null;
  }, []);

  /**
   * 在光标处插入一个**真实换行**。
   *
   * 不用 `<br>`、也不用 `execCommand('insertLineBreak')` —— 前者在
   * `textContent` 里不产出 `\n`，序列化后代码块就还是「一行的」。
   * 这里直接落一个含 `\n` 的文本节点，markdown 与渲染两侧都一致。
   *
   * # ⚠️ 为什么必须写进**光标自己那个文本节点**，而不能另插一个新节点（V67 修）
   *
   * 用户 09-22 报「便签里不能回车，只能写一行」。实测（`agent-browser` 真实按键）：
   * 原来 `range.insertNode(createTextNode('\n'))` 之后 DOM 是
   * `T["AB"] + T["\n"] + T[""]`、光标停在**第二个节点**里；看着没错，但浏览器下一次
   * `insertText` 会把字符**放回第一个节点**——
   *
   * ```
   * 敲 C 之后： T["ABC"] + T["\n"]      → 文本 "ABC\n" → 屏上仍然只有一行
   * ```
   *
   * 因为「落在独立 `\n` 节点开头」这个位置对 Chrome 来说等价于「上一行的行尾」，
   * 于是新字符全被插到换行**之前**，用户看到的就是「回车没用、只能写一行」。
   *
   * 现在改成把 `\n` **就地插进光标所在的文本节点**（`before + '\n' + after`），
   * 光标落在**同一个节点**的 `offset + 1`：同节点内的偏移不会有歧义，后续输入必然
   * 落在换行**之后**，新行这才真的成立。
   */
  const insertNewlineInPre = useCallback((): void => {
    const selection: Selection | null = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range: Range = selection.getRangeAt(0);
    range.deleteContents();
    let node: Node = range.startContainer;
    let offset: number = range.startOffset;
    if (node.nodeType !== Node.TEXT_NODE) {
      // 光标挂在**元素**上（块还是空的、里面只有一颗种子或什么都没有）——
      // 这里不能直接 `insertNode('\n')`：那样光标会停在「独立 `\n` 节点的开头」，
      // 对浏览器来说等价于「上一行的行尾」，接着敲的字全被插到换行**之前**
      // （正是本函数注释里说的那个坑，实测「``` ⏎ shell」里 shell 会跑回第一行）。
      // 先锚一颗零宽哨兵把光标**规范化进文本节点**，后面两类光标就只有一条路径。
      // 必须用 `ZWSP` 而不是空串：空文本节点会被浏览器在选区规范化时回收（坑 ②）。
      const anchor: Text = document.createTextNode(ZWSP);
      range.insertNode(anchor);
      node = anchor;
      offset = ZWSP.length;
    }
    const value: string = node.nodeValue ?? '';
    // `\n` 之后**必须补一颗零宽锚点**并把光标放到它后面（V67 实测）：
    // 文本节点以 `\n` 收尾时，Chrome 会把「节点末尾」这个位置判成**上一行的行尾**，
    // 于是紧接着敲的字被插到换行**之前** —— 表现就是「回车没用、两行粘成一行」。
    // 有了一颗零宽字符垫在换行后面，「行尾」这个歧义就不存在了；序列化与高亮两侧
    // 都会把 `ZWSP` 剥掉（`stripZwsp`），不进 Markdown、不进高亮结果。
    node.nodeValue = `${value.slice(0, offset)}\n${ZWSP}${value.slice(offset)}`;
    const after: Range = document.createRange();
    after.setStart(node, offset + 1 + ZWSP.length);
    after.collapse(true);
    selection.removeAllRanges();
    selection.addRange(after);
  }, []);

  /** 跳出代码块：块后另起一个空段落并把光标落过去 */
  const exitPre = useCallback(
    (pre: HTMLElement): void => {
      const paragraph: HTMLElement = document.createElement('div');
      paragraph.appendChild(document.createElement('br'));
      pre.after(paragraph);
      placeCaretAtEnd(paragraph);
      emit();
    },
    [emit],
  );

  /**
   * 「上一次对代码块的操作，就是我们自己插的那次换行」。
   *
   * 收尾判据（规则 ②）用它，而不是去看「文本末尾是不是空行」—— 后者会把**从库里读回来的
   * 代码块**误判成「用户刚换过行」（围栏内容的末尾本来就带 `\n`），于是用户坐下敲的
   * 第一下回车就被当成收尾。见下面规则 ② 的说明。
   */
  const pendingBreakRef = useRef<boolean>(false);

  /**
   * 代码块里按回车的三种去向：
   *   ① 块里**只有一行有内容、且那行是内置高亮语言名** → 认成围栏语言并清空内容
   *      （```` ```sh ⏎ ```` 与「先起块、再敲语言名回车」两种写法都算）；
   *   ② 光标停在块尾的空行上、且**上一步就是我们插的那次换行** → 收尾跳出
   *      （＝连按两下回车，三引号写法的直觉；V67 收紧）；
   *   ③ 其余情况 → 插一个真实换行，留在代码块里继续写。
   */
  const handlePreEnter = useCallback(
    (pre: HTMLElement, shift: boolean): void => {
      const codeEl: HTMLElement = ensureCodeChild(pre);
      const text: string = stripZwsp(codeEl.textContent ?? '');
      // ① 语言名（V67 放宽判据）：把每行 trim 后丢掉空行，**只剩一行**且那行是内置语言就认。
      //    旧判据是「块里不能有换行」，而用户按「``` ⏎ shell ⏎」的节奏写时，第一次回车
      //    已经把光标带到第二行、块里必然带着一个 `\n` —— 于是那条 V21 习惯其实一直是坏的
      //    （实测：`shell` 反而被当成普通代码留在块里）。
      //    `isSupportedLang` 继续把普通文字挡在外面：`ls`、一行中文都不会被吃掉。
      const named: string[] = text
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line !== '');
      const onlyLine: string = named[0] ?? '';
      if (!shift && named.length === 1 && isSupportedLang(onlyLine)) {
        pre.dataset.lang = normalizeLang(onlyLine);
        codeEl.textContent = ZWSP;
        placeCaretAtEnd(codeEl);
        emit();
        return;
      }
      const lastBreak: number = text.lastIndexOf('\n');
      // ② 收尾跳出：光标就在**块尾**的空行上，而且**上一步操作就是我们插的那次换行**
      //    —— 也就是「写完一行，连按两下回车」，与「三引号写法」的直觉一致。
      //
      // ⚠️⚠️ V67 修（这条是用户那句「不能回车、只能写一行」的直接病因）。旧判据只看
      // 「末行是不是空的」。可**从库里读回来的代码块**内容本身就以 `\n` 收尾（markdown
      // 围栏的常态），于是用户坐下敲的**第一下**回车就被判成收尾：它不但不换行，还顺手
      // 把那个 `\n` 删掉（`replace(/\n+$/,'')`）、把光标扔到块外的空段落里 —— 用户看到的
      // 就是「回车没反应 / 写着写着跑到框外面」（09-22 便签 6 那份 ```` ```shell ````）。
      // 改成看 `pendingBreakRef` 之后：**只有连着两下回车**才收尾，单次回车永远只换行。
      const blankTail: boolean =
        !shift && lastBreak >= 0 && text.endsWith('\n') && caretAtEndOf(codeEl) &&
        pendingBreakRef.current;
      if (blankTail) {
        codeEl.textContent = text.replace(/\n+$/, '');
        pendingBreakRef.current = false;
        exitPre(pre);
        return;
      }
      insertNewlineInPre();
      pendingBreakRef.current = true;
      emit();
    },
    [emit, exitPre, insertNewlineInPre],
  );

  /** 行内即时转换：把光标前刚闭合的标记换成格式化元素 */
  const convertInline = useCallback((): boolean => {
    const caret = caretInTextNode();
    if (!caret) {
      return false;
    }
    const before: string = (caret.node.nodeValue ?? '').slice(0, caret.offset);
    for (const rule of INLINE_RULES) {
      const matched: RegExpExecArray | null = rule.re.exec(before);
      if (!matched) {
        continue;
      }
      const inner: string = matched[1] ?? '';
      const start: number = caret.offset - matched[0].length;
      const range: Range = document.createRange();
      range.setStart(caret.node, start);
      range.setEnd(caret.node, caret.offset);
      range.deleteContents();

      const el: HTMLElement = document.createElement(rule.tag);
      el.textContent = inner;
      range.insertNode(el);

      // 光标必须落回**格式之外**：若直接 `setStartAfter(el)`、或停在哨兵节点开头
      // （`range.startOffset = 0`），Chrome 都会按「紧邻前一个行内元素」判样式，
      // 把接下来敲的字继续塞进 `<strong>` 里。停在哨兵**末尾**（offset = 1），
      // 光标前一个字符就是零宽空格本身，样式继承链才真正断掉。
      const spacer: Text = document.createTextNode(ZWSP);
      el.after(spacer);
      const after: Range = document.createRange();
      after.setStart(spacer, 1);
      after.collapse(true);
      const selection: Selection | null = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(after);
      return true;
    }
    return false;
  }, []);

  /** 块级前缀转换：行首标记 → 块元素（标题 / 列表 / 引用 / 任务 / 代码块） */
  const convertBlock = useCallback((): boolean => {
    const root = rootRef.current;
    const caret = caretInTextNode();
    if (!root || !caret) {
      return false;
    }
    let block: HTMLElement | null = directBlockOf(root, caret.node);
    if (!block || block === root) {
      // 内容还裸挂在根节点上（新笔记的第一笔）→ 先补一层块容器
      block = wrapInlineRunAtCaret(root, caret.node);
    }
    if (!block) {
      return false;
    }
    // 只在「整块就是标记本身」时转换，避免误伤正文。
    // 注意要剥掉零宽锚点：上一处行内转换会在同一块里留下 `\u200B`，
    // 若拿它当首字符，`^#\s$` 之类的块级规则会永远匹配不上（曾导致 `# ` 失效）。
    const marker: string = stripZwsp(block.textContent ?? '');
    const rule: BlockRule | undefined = BLOCK_RULES.find((item: BlockRule): boolean =>
      item.re.test(marker),
    );
    if (!rule) {
      return false;
    }

    let replacement: HTMLElement;
    /** 光标最终要落进去的元素（列表是 `li`、代码块是 `code`） */
    let caretTarget: HTMLElement;
    /** 替换块之后还要追加的兄弟块（如分割线后面的空段落），无则 null */
    let afterBlock: HTMLElement | null = null;
    switch (rule.kind) {
      case 'h': {
        const level: number = marker.trim().length;
        replacement = withCaretSeed(`h${level}`);
        caretTarget = replacement;
        break;
      }
      case 'quote':
        replacement = withCaretSeed('blockquote');
        caretTarget = replacement;
        break;
      case 'pre': {
        // 语言从围栏行的捕获组带出（```shell / ```python …），无语言则为空串
        const fenceLang: string = normalizeLang(rule.re.exec(marker)?.[1] ?? '');
        replacement = document.createElement('pre');
        if (fenceLang !== '') {
          replacement.dataset.lang = fenceLang;
        }
        const code: HTMLElement = withCaretSeed('code');
        replacement.appendChild(code);
        caretTarget = code;
        break;
      }
      case 'ul':
      case 'ol': {
        replacement = document.createElement(rule.kind);
        const li: HTMLElement = withCaretSeed('li');
        replacement.appendChild(li);
        caretTarget = li;
        break;
      }
      case 'task': {
        const ul: HTMLElement = document.createElement('ul');
        ul.dataset.task = 'true';
        const li: HTMLElement = document.createElement('li');
        const box: HTMLInputElement = document.createElement('input');
        box.type = 'checkbox';
        // 让复选框在可编辑区里可点、但不被序列化成语义文本
        box.setAttribute('contenteditable', 'false');
        li.appendChild(box);
        li.appendChild(document.createTextNode(ZWSP));
        ul.appendChild(li);
        replacement = ul;
        caretTarget = li;
        break;
      }
      case 'hr': {
        // 分隔线后面补一个空段落，光标落进去接着写下一行
        // （否则分割线后没有可落光标的文本节点，紧接着敲的字没处去）
        replacement = document.createElement('hr');
        const afterP: HTMLElement = document.createElement('div');
        afterP.appendChild(document.createElement('br'));
        afterBlock = afterP;
        caretTarget = afterP;
        break;
      }
      default:
        return false;
    }

    block.replaceWith(replacement);
    if (afterBlock) {
      replacement.after(afterBlock);
    }
    placeCaretAtEnd(caretTarget);
    return true;
  }, []);

  /** 输入事件：先清空壳，再尝试两类转换，最后同步内容出去 */
  const handleInput = useCallback((): void => {
    // 用户真的打字/粘贴了 → 「上一步是我们插的换行」这个前提失效，收尾判据作废
    pendingBreakRef.current = false;
    // 代码块内部一律按裸文本处理：不做行内 / 块级转换，
    // 否则一段代码只要恰好长得像标记（例如整块就是一个 `- `）就会被「吃掉」。
    if (preAtCaret() === null) {
      pruneEmptyFormatting();
      // 块级优先（`# ` 之类），失败再试行内（`**x**` 之类）
      convertBlock() || convertInline();
    }
    emit();
    scheduleHighlight();
  }, [convertBlock, convertInline, emit, preAtCaret, pruneEmptyFormatting, scheduleHighlight]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      // 不是回车的任何按键（退格 / 方向键 / 打字）都意味着「上一次换行之后用户动过手」，
      // 于是「连按两下回车收尾」的前提不成立 → 作废。见 `pendingBreakRef`。
      if (event.key !== 'Enter') {
        pendingBreakRef.current = false;
      }
      if (singleLine && event.key === 'Enter') {
        event.preventDefault();
        onEnter?.();
        return;
      }

      // —— 围栏代码块内的按键：换行 / 认语言 / 跳出 / 撤销围栏 ——
      const pre: HTMLElement | null = preAtCaret();
      if (pre !== null) {
        if (event.key === 'Enter') {
          event.preventDefault();
          handlePreEnter(pre, event.shiftKey);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          exitPre(pre);
        } else if (
          event.key === 'Backspace' &&
          stripZwsp(ensureCodeChild(pre).textContent ?? '') === ''
        ) {
          // 空代码块里退格 = 撤掉这个围栏，还原成普通段落（否则空块删不掉）
          event.preventDefault();
          const paragraph: HTMLElement = document.createElement('div');
          paragraph.appendChild(document.createElement('br'));
          pre.replaceWith(paragraph);
          placeCaretAtEnd(paragraph);
          emit();
        }
        return;
      }

      // 空任务项 / 空列表项回车：跳出列表（避免空标记一直续下去）
      if (event.key === 'Enter' && !event.shiftKey) {
        const root = rootRef.current;
        const selection: Selection | null = window.getSelection();
        if (!root || !selection || selection.rangeCount === 0) {
          return;
        }
        const block: HTMLElement | null = directBlockOf(root, selection.getRangeAt(0).startContainer);
        const li: HTMLElement | null = block?.closest('li') ?? null;
        if (li && (li.textContent ?? '').trim() === '') {
          event.preventDefault();
          const list: HTMLElement | null = li.parentElement;
          const paragraph: HTMLElement = document.createElement('p');
          paragraph.appendChild(document.createElement('br'));
          if (list && list.children.length <= 1) {
            list.replaceWith(paragraph);
          } else {
            li.remove();
            list?.after(paragraph);
          }
          placeCaretAtEnd(paragraph);
          emit();
        }
      }
    },
    [emit, exitPre, handlePreEnter, onEnter, preAtCaret, singleLine],
  );

  /** 粘贴：只取纯文本（避免粘进外部 HTML 把结构冲烂），多行仍然合法 */
  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const text: string = event.clipboardData.getData('text/plain');
      const safe: string = singleLine ? text.replace(/\s*\n+\s*/g, ' ') : text;
      document.execCommand('insertText', false, safe);
      emit();
      scheduleHighlight();
    },
    [emit, scheduleHighlight, singleLine],
  );

  return (
    // V64：外层是**一根 flex 列**。以前它是普通块级容器，`h-full` 在父容器高度为 auto
    // 时会退化成 auto —— 于是空内容（或只有一行）时编辑区就只有一行高，鼠标划过下面
    // 是默认箭头、点下去也不落光标（用户 09-21：「便签整个内容区域鼠标应该都变成光标
    // 形状，而不是只有顶部一行才能变成光标输入形状」）。改成 flex 列、内层 `flex-1`
    // 之后，父容器给了高度的地方编辑区就撑满（便签纸），没给的地方仍按内容走。
    <div className={cn('relative flex min-h-0 flex-col', className)}>
      <div
        ref={rootRef}
        role="textbox"
        aria-multiline={!singleLine}
        aria-label={ariaLabel}
        tabIndex={readOnly ? -1 : 0}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={() => onFocus?.()}
        onBlur={() => {
          // 失焦即把待补的高亮补上（省得离开后代码还是黑的）
          if (highlightTimerRef.current !== undefined) {
            window.clearTimeout(highlightTimerRef.current);
            highlightTimerRef.current = undefined;
          }
          applyHighlight();
          emit();
          onBlur?.();
        }}
        className={cn(
          // `h-full` 在父容器高度为 auto 时自然退化为 auto（内容撑开），
          // 父容器有确定高度（如笔记正文）时则撑满并自行滚动 —— 一套样式两种场景通吃。
          // V64：`flex-1` 让它跟着 flex 列父容器撑满（同一豆腐块的每个角落都是 I-beam）；
          // 保留 `h-full` 是为了那些父容器**不是** flex、但给了确定高度的场合
          // （`NotesPanel` 的 `h-full`、`NoteWindow` 的 `flex-1`）—— 两条路取其一，谁生效都行。
          // `cursor-text`：即使光标下面没有文字（空行 / 大片留白）也显示工字光标。
          'md-preview wysiwyg scrollbar-thin h-full min-h-0 flex-1 cursor-text overflow-auto outline-none',
          readOnly && 'pointer-events-none',
        )}
      />
      {empty && placeholder !== '' && (
        // V75：占位符**不再复用外层 className**。那个 className 里含边框 / 圆角 /
        // 内边距 / 高度，套到占位符上会画出第二层框；而且字号类落在外层包装上时，
        // 这个 span 拿不到，直接回落到 16px 根字号，比 12px 正文大一圈。
        // 现在只靠继承：外层（如 `.md-compact`）给什么字号，占位符就是什么字号。
        <span className="pointer-events-none absolute left-0 top-0 w-full select-none text-muted-foreground/50">
          {placeholder}
        </span>
      )}
    </div>
  );
}

export default RichMarkdown;

/**
 * 纯函数序列化（无 DOM 依赖部分无法完全剥离，但导出便于回归脚本直接断言）。
 * 与 `MarkdownEditor.markdownOps` 同一用意：把可测逻辑显式暴露。
 */
export const richMarkdownOps = {
  serializeInline,
  serializeBlocks,
};
