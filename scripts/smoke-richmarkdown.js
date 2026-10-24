/*
 * RichMarkdown（所见即所得编辑器）逐字符回归驱动。
 *
 * # 用法
 *
 *   node scripts/dev-static.cjs 41901 &          # 必须与下面几条在同一次 bash 调用里，
 *                                                # 否则后台进程会被作业对象回收
 *   agent-browser open "http://127.0.0.1:41901/index.html?demo=richmarkdown"
 *   agent-browser wait --load load
 *   agent-browser eval "$(cat scripts/smoke-richmarkdown.js)"
 *   agent-browser close
 *
 * 该文件是**一个 IIFE 表达式**（不是模块），交给 `agent-browser eval` 求值；
 * 返回值是逐步骤的 JSON 报告（html / source / 选区 / 标签计数 / 捕获到的异常）。
 *
 * # 为什么不能用 `agent-browser keyboard type`
 *
 * 它走整串 `insertText`，实测 `'# '` 落进 contentEditable 会变成 `NBSP + #`，
 * 还会凭空多出 `*`（`'# '` → `"# *"`）——完全是虚假的失败信号。这里改用
 * `document.execCommand('insertText', false, ch)` **逐字符**驱动，才会逐次触发
 * `input` 事件，与真人敲键等价。
 *
 * # 为什么每步都要 await
 *
 * React 18 对非 React 事件里的 setState 走微任务批处理。同步块里操作完立刻读
 * `<pre data-testid="md-source">` 拿到的永远是**上一帧**，会被误判成「onChange 没触发」。
 *
 * 断言要点（对照 `src/components/RichMarkdown.tsx` 头部「浏览器内核踩过的坑」）：
 *   - `**粗体**` 后紧接普通文字，普通文字**不得**落进 `<strong>`；
 *   - `*斜体*` / `` `代码` `` / `~~删除~~` 的源文本必须不带多余星号；
 *   - 全新编辑器第一笔敲 `# ` 必须变成 `<h1>`（裸挂根节点的兜底路径）。
 */
(async () => {
  const ed = document.querySelector('[aria-label="所见即所得输入框"]');
  if (!ed) return JSON.stringify({ mounted: false });

  const errors = [];
  window.addEventListener('error', (e) => errors.push('err:' + String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push('rej:' + String(e.reason)));

  // 诊断输出必须把不可见字符显式标出来，否则零宽字符在日志里完全隐身
  const vis = (s) =>
    String(s == null ? '' : s).replace(/\u200B/g, '<Z>').replace(/\u00A0/g, '<N>');
  const n = (t) => ed.querySelectorAll(t).length;
  const describe = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 'none';
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType === 3) {
      const p = node.parentElement;
      const idx = p ? Array.prototype.indexOf.call(p.childNodes, node) : -1;
      return 'text[' + vis(node.nodeValue) + ']@' +
        (p ? p.tagName.toLowerCase() : '?') + '#' + idx + '@' + r.startOffset;
    }
    return 'el:' + node.nodeName.toLowerCase() + '@' + r.startOffset;
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const report = {};
  const snap = async (label) => {
    await tick(); // 等 React 把状态刷进 <pre data-testid="md-source">
    const src = document.querySelector('[data-testid="md-source"]');
    report[label] = {
      html: vis(ed.innerHTML),
      source: src ? vis(src.textContent) : '<missing>',
      sel: describe(),
      strong: n('strong'), em: n('em'), code: n('code'), del: n('del'),
      h1: n('h1'), ul: n('ul'), li: n('li'), blockquote: n('blockquote'),
    };
  };
  const type = (s) => {
    for (const ch of s) document.execCommand('insertText', false, ch);
  };
  const enter = () => document.execCommand('insertParagraph');
  const clearAll = () => {
    document.execCommand('selectAll');
    document.execCommand('delete');
  };

  ed.focus();
  const r0 = document.createRange();
  r0.selectNodeContents(ed);
  r0.collapse(false);
  const s0 = window.getSelection();
  s0.removeAllRanges();
  s0.addRange(r0);

  // —— 阶段一：全新空编辑器，第一笔就是 `# `（内容裸挂在根节点的兜底路径）——
  type('# ');
  await snap('P1_1_first_hash_space');
  type('第一行标题');
  await snap('P1_2_first_h1_text');
  enter();
  type('正文段落');
  await snap('P1_3_paragraph');

  clearAll();
  await snap('P2_0_cleared');

  // —— 阶段二：行内语法 ——
  type('**粗体**');
  await snap('P2_1_bold');
  type(' 普通');
  await snap('P2_2_plain_after_bold');
  enter(); type('*斜体*');
  await snap('P2_3_italic');
  enter(); type('`代码`');
  await snap('P2_4_code');
  enter(); type('~~删除~~');
  await snap('P2_5_del');

  // —— 阶段三：块级语法 ——
  enter(); type('# ');
  await snap('P3_1_hash_space');
  type('大标题');
  await snap('P3_2_h1_text');
  enter(); type('- ');
  await snap('P3_3_dash_space');
  type('列表项');
  await snap('P3_4_ul_text');
  enter(); type('> ');
  await snap('P3_5_quote');
  type('引用内容');
  await snap('P3_6_quote_text');

  report.__errors = errors;
  return JSON.stringify(report, null, 1);
})()
