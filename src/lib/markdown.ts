import { Marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Markdown 渲染工具（便签编辑器专用）。
 *
 * 职责：
 *   - `renderMarkdown()`：Markdown → 安全 HTML（`marked` 解析 + `DOMPurify` 清洗）。
 *     便签正文可能来自任意粘贴内容，因此**必须**清洗后再交给 `dangerouslySetInnerHTML`，
 *     否则 `<img onerror>` / `<svg onload>` 之类的载荷会在桌面 WebView 里直接执行。
 *   - `stripMarkdown()`：Markdown → 纯文本，供便签列表摘要、窗口标题等场景使用。
 *
 * 设计约束：
 *   - **绝不抛异常**：渲染/清洗失败时降级为转义后的纯文本，绝不让一个坏便签炸掉整个窗口。
 *   - 空输入返回空串，避免 `<p></p>` 之类空壳污染布局。
 */

/** marked 实例：开启 GFM（表格 / 任务列表 / 删除线）+ 单换行即 `<br>`（便签随手记的直觉） */
const markedInstance: Marked = new Marked({ gfm: true, breaks: true });

/** DOMPurify hook 是否已注册（模块级只注册一次，避免重复注册拖慢每次渲染） */
let hooksInstalled = false;

/**
 * 注册 DOMPurify hook：给外链补 `target="_blank"` 与 `rel="noopener noreferrer"`。
 *
 * 只处理 `http(s)` 外链：锚点（`#xxx`）与相对链接仍在当前窗口打开，避免便签内跳转
 * 意外打开一堆空白桌面窗口。
 */
function installHooks(): void {
  if (hooksInstalled || typeof window === 'undefined') {
    return;
  }
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node: Element): void => {
    if (!node || node.tagName !== 'A') {
      return;
    }
    const href: string = node.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) {
      return;
    }
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
}

/**
 * HTML 转义（仅用于渲染异常时的降级输出）。
 * @param text 原始文本
 * @returns 转义后的文本
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char: string): string => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * 把「贴着正文的 `---`」还原成用户想要的**分割线**（V47）。
 *
 * 用户原话：「现在 --- 分割线不支持」。这不是解析器坏了，而是 CommonMark 的 setext 规则：
 * `---` 紧跟在段落行下面时会被当成「二级标题下划线」，于是
 *
 * ```text
 * 今天要做
 * ---
 * ```
 *
 * 渲染成 `<h2>今天要做</h2>`，分割线消失。语法上完全合规，但在便签这个场景里
 * 「`---` = 分割线」是压倒性的期望，而标题另有 `##`/`###` 可写。
 * 所以这里做一次**规范化**：`---` 独占一行且上一行非空时，先补一个空行，让它落成 `<hr>`。
 *
 * 只处理连字符（`*` / `_` 不参与 setext，本来就永远是 `<hr>`，不必动）。
 *
 * @param src Markdown 源文本
 * @returns 规范化后的源文本（不改变任何其他行的内容）
 */
function normalizeHorizontalRules(src: string): string {
  const lines: string[] = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s{0,3}-{3,}\s*$/.test(line)) {
      const prev: string = out.length > 0 ? (out[out.length - 1] ?? '') : '';
      if (prev.trim() !== '') {
        out.push('');
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * 将 Markdown 渲染为安全的 HTML 片段。
 *
 * @param src Markdown 源文本
 * @returns 清洗后的 HTML；空输入返回空串；异常时返回转义后的纯文本（不抛）
 */
export function renderMarkdown(src: string): string {
  if (!src) {
    return '';
  }
  try {
    installHooks();
    // marked v18 的 parse() 存在同步 / 异步重载，显式 `async: false` 走同步分支
    const raw: string = markedInstance.parse(normalizeHorizontalRules(src), { async: false });
    return DOMPurify.sanitize(raw, {
      // GFM 任务列表渲染成 `<input type="checkbox">`，显式放行以免被默认策略裁掉
      ADD_TAGS: ['input'],
      ADD_ATTR: ['target', 'rel', 'checked', 'disabled', 'type'],
      FORBID_TAGS: ['style', 'form', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
      FORBID_ATTR: ['style', 'srcset', 'formaction', 'onerror', 'onload'],
      ALLOW_DATA_ATTR: false,
    });
  } catch (error: unknown) {
    console.error('[Handy] Markdown 渲染失败，降级为纯文本：', error);
    return `<p>${escapeHtml(src)}</p>`;
  }
}

/**
 * 去掉 Markdown 标记，得到可读的纯文本。
 *
 * 用于便签列表摘要、窗口标题等「只想要文字」的场景。纯正则实现，不依赖 DOM，
 * 因此在非浏览器环境（测试 / SSR）同样可用。
 *
 * @param src Markdown 源文本
 * @returns 去标记后的纯文本；异常时返回原文本（不抛）
 */
export function stripMarkdown(src: string): string {
  if (!src) {
    return '';
  }
  try {
    let text: string = src.replace(/\r\n?/g, '\n');

    // HTML 注释
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    // 围栏代码块：去掉围栏行，保留代码本体
    text = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n?([\s\S]*?)\n?[ \t]*\1[ \t]*$/gm, '$2');
    // 行内代码
    text = text.replace(/`([^`\n]*)`/g, '$1');
    // 图片 → alt 文本
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    // 链接 → 锚文本
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    // 参考式链接定义
    text = text.replace(/^\s{0,3}\[[^\]]+\]:\s*\S+.*$/gm, '');
    // 标题
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    // 引用
    text = text.replace(/^\s{0,3}>\s?/gm, '');
    // 任务列表（`- [ ] ` / `- [x] `）
    text = text.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s*/gm, '$1');
    // 表格：先删分隔行，再把表格行的竖线全部换成空格（避免残留 `|` 占版面）
    text = text.replace(/^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/gm, '');
    text = text.replace(/^[ \t]*\|.*\|[ \t]*$/gm, (line: string): string => line.replace(/\|/g, ' '));
    // 普通列表符号
    text = text.replace(/^(\s*)[-*+]\s+/gm, '$1');
    text = text.replace(/^(\s*)\d+[.)]\s+/gm, '$1');
    // 分割线
    text = text.replace(/^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');
    // 强调
    text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
    text = text.replace(/(\*|_)(?=\S)([^\n]*?\S)\1/g, '$2');
    text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
    // 反斜杠转义
    text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');

    return (
      text
        .split('\n')
        .map((line: string): string => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim() || ''
    );
  } catch (error: unknown) {
    console.error('[Handy] Markdown 去标记失败，返回原文：', error);
    return src;
  }
}

/**
 * 取便签正文的纯文本摘要（单行，供标题 / 预览等紧凑场景）。
 *
 * @param src Markdown 源文本
 * @param maxLength 最大长度（超出以 `…` 结尾）；0 表示不截断
 * @returns 单行纯文本摘要
 */
export function toPlainSummary(src: string, maxLength = 0): string {
  const plain: string = stripMarkdown(src).replace(/\s*\n+\s*/g, ' ').trim();
  if (maxLength <= 0 || plain.length <= maxLength) {
    return plain;
  }
  return `${plain.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}
