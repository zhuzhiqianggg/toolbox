import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * 轻量代码高亮（零依赖）。
 *
 * # 为什么自己写
 *
 * 便签（用户反馈 #6）里要支持 ```shell / ```python 这类代码块高亮。上 highlight.js
 * 或 shiki 会显著增大包体（release 体积是本项目的硬指标：Win < 30MB），
 * 而真实需求只是「关键字、字符串、注释、数字能分清颜色」，几十行规则就够了。
 *
 * # 实现
 *
 * 每种语言给一组 `TokenRule`（带名字的正则片段 + 颜色类），拼成**一个**大正则
 * （`(a)|(b)|(c)...`），扫描时看哪个捕获组命中就知道是哪种 token。
 * 顺序即优先级：注释与字符串写在关键字前面，否则字符串里的关键字会抢先变色。
 *
 * # 边界
 *
 * - 不做语法分析，因此**不会**因为半个引号就崩；最坏情况是颜色不准；
 * - 未知语言按纯文本渲染，并去掉多余缩进。
 */

/** 一条 token 规则 */
interface TokenRule {
  /** 正则片段（会被包进捕获组，注意不要有裸露的顶层 `|`） */
  pattern: string;
  /** 对应的 CSS 类 */
  cls: string;
}

/** 颜色类（对齐项目浅色主题；dark 下也有对应色） */
const CLS = {
  comment: 'text-neutral-400 italic dark:text-neutral-500',
  string: 'text-emerald-700 dark:text-emerald-400',
  keyword: 'text-violet-700 font-medium dark:text-violet-400',
  number: 'text-amber-700 dark:text-amber-500',
  func: 'text-sky-700 dark:text-sky-400',
  type: 'text-teal-700 dark:text-teal-400',
  variable: 'text-rose-700 dark:text-rose-400',
  operator: 'text-muted-foreground',
} as const;

/** 正则片段片段复用 */
const P = {
  lineComment: '(?:#[^\\n]*|//[^\\n]*)',
  blockComment: '/\\*[\\s\\S]*?\\*/',
  dqString: '"(?:\\\\.|[^"\\\\\\n])*"',
  sqString: "'(?:\\\\.|[^'\\\\\\n])*'",
  templateString: '`(?:\\\\.|[^`\\\\])*`',
  number: '\\b\\d+(?:\\.\\d+)?\\b',
};

/** 各语言规则（顺序 = 优先级） */
const LANGS: Record<string, TokenRule[]> = {
  shell: [
    { pattern: P.lineComment, cls: CLS.comment },
    { pattern: `(?:${P.dqString}|${P.sqString})`, cls: CLS.string },
    {
      pattern:
        '\\b(?:if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|local|export|declare|readonly|set|unset|shift|exit|source|trap|eval)\\b',
      cls: CLS.keyword,
    },
    {
      pattern:
        '\\b(?:echo|printf|read|test|mkdir|rmdir|rm|cp|mv|ln|chmod|chown|grep|egrep|pgrep|awk|sed|cut|sort|uniq|head|tail|cat|tee|find|xargs|curl|wget|systemctl|journalctl|df|du|ps|kill|sleep|git|docker|kubectl)\\b',
      cls: CLS.func,
    },
    { pattern: '\\$\\{[^}]*\\}|\\$[A-Za-z_][A-Za-z0-9_]*|\\$[?#@*!$0-9]', cls: CLS.variable },
    { pattern: P.number, cls: CLS.number },
    { pattern: '(?:&&|\\|\\||[|&><]=?|!=|==|-eq|-ne|-z|-n)', cls: CLS.operator },
  ],
  python: [
    { pattern: P.lineComment, cls: CLS.comment },
    { pattern: `(?:'''[\\s\\S]*?'''|"""[\\s\\S]*?"""|${P.dqString}|${P.sqString})`, cls: CLS.string },
    { pattern: '@[A-Za-z_][\\w.]*', cls: CLS.type },
    {
      pattern:
        '\\b(?:def|class|return|yield|if|elif|else|for|while|break|continue|pass|import|from|as|with|try|except|finally|raise|lambda|global|nonlocal|assert|del|async|await|in|is|not|and|or|None|True|False)\\b',
      cls: CLS.keyword,
    },
    {
      pattern:
        '\\b(?:print|len|range|enumerate|zip|open|int|str|float|bool|list|dict|set|tuple|sum|min|max|sorted|map|filter|isinstance|type|super|self)\\b',
      cls: CLS.func,
    },
    { pattern: P.number, cls: CLS.number },
  ],
  javascript: [
    { pattern: `${P.blockComment}|${P.lineComment}`, cls: CLS.comment },
    { pattern: `${P.templateString}|${P.dqString}|${P.sqString}`, cls: CLS.string },
    {
      pattern:
        '\\b(?:const|let|var|function|return|if|else|for|while|do|break|continue|new|class|extends|super|import|export|from|default|try|catch|finally|throw|await|async|yield|typeof|instanceof|in|of|this|null|undefined|true|false|void|delete)\\b',
      cls: CLS.keyword,
    },
    { pattern: '\\b[A-Z][A-Za-z0-9_]*\\b', cls: CLS.type },
    { pattern: P.number, cls: CLS.number },
  ],
  json: [
    { pattern: '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)', cls: CLS.type },
    { pattern: '"(?:\\\\.|[^"\\\\])*"', cls: CLS.string },
    { pattern: '\\b(?:true|false|null)\\b', cls: CLS.keyword },
    { pattern: '-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b', cls: CLS.number },
  ],
  yaml: [
    { pattern: P.lineComment, cls: CLS.comment },
    { pattern: '^[ \\t-]*[\\w.$-]+(?=\\s*:)', cls: CLS.type },
    { pattern: `(?:${P.dqString}|${P.sqString})`, cls: CLS.string },
    { pattern: '\\b(?:true|false|null|yes|no|on|off)\\b', cls: CLS.keyword },
    { pattern: '\\b\\d+(?:\\.\\d+)?(?:Gi|Mi|Ki|s|m|h)?\\b', cls: CLS.number },
    { pattern: '[&*][\\w-]+', cls: CLS.variable },
  ],
  java: [
    { pattern: `${P.blockComment}|${P.lineComment}`, cls: CLS.comment },
    { pattern: P.dqString, cls: CLS.string },
    { pattern: '@[A-Za-z_][\\w.]*', cls: CLS.type },
    {
      pattern:
        '\\b(?:public|private|protected|static|final|abstract|class|interface|enum|extends|implements|new|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|throws|this|super|void|int|long|double|float|boolean|char|byte|short|String|null|true|false|import|package|synchronized|volatile|transient|instanceof)\\b',
      cls: CLS.keyword,
    },
    { pattern: P.number, cls: CLS.number },
  ],
  go: [
    { pattern: `${P.blockComment}|${P.lineComment}`, cls: CLS.comment },
    { pattern: `${P.templateString}|${P.dqString}`, cls: CLS.string },
    {
      pattern:
        '\\b(?:package|import|func|return|if|else|for|range|switch|case|default|break|continue|var|const|type|struct|interface|map|chan|go|defer|select|nil|true|false|make|new|len|cap|append)\\b',
      cls: CLS.keyword,
    },
    { pattern: '\\b(?:string|int|int64|float64|bool|byte|error|rune)\\b', cls: CLS.type },
    { pattern: P.number, cls: CLS.number },
  ],
  sql: [
    { pattern: '--[^\\n]*', cls: CLS.comment },
    { pattern: `${P.sqString}`, cls: CLS.string },
    {
      pattern:
        '\\b(?:SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|AS|AND|OR|NOT|NULL|IS|IN|LIKE|BETWEEN|UNION|ALL|DISTINCT|COUNT|SUM|AVG|MAX|MIN|CASE|WHEN|THEN|ELSE|END|EXPLAIN|DESC|ASC)\\b',
      cls: CLS.keyword,
    },
    { pattern: P.number, cls: CLS.number },
  ],
  ini: [
    { pattern: '[;#][^\\n]*', cls: CLS.comment },
    { pattern: '^\\[[^\\]]+\\]', cls: CLS.type },
    { pattern: '^[\\w.$-]+(?=\\s*=)', cls: CLS.variable },
    { pattern: `(?:${P.dqString}|${P.sqString})`, cls: CLS.string },
    { pattern: P.number, cls: CLS.number },
  ],
};

/** 语言别名归一 */
const ALIAS: Record<string, string> = {
  sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', powershell: 'shell', ps1: 'shell',
  py: 'python', python3: 'python',
  js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', node: 'javascript', typescript: 'javascript',
  yml: 'yaml',
  java: 'java', kotlin: 'java',
  golang: 'go',
  mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
  conf: 'ini', config: 'ini', toml: 'ini', env: 'ini', properties: 'ini',
};

/** 编译后的高亮器（按语言缓存，避免每次渲染重建正则） */
const compiled = new Map<string, { re: RegExp; classes: string[] } | null>();

function compile(lang: string): { re: RegExp; classes: string[] } | null {
  if (compiled.has(lang)) {
    return compiled.get(lang) ?? null;
  }
  const rules = LANGS[lang];
  if (!rules) {
    compiled.set(lang, null);
    return null;
  }
  const classes = rules.map((rule) => rule.cls);
  const re = new RegExp(rules.map((rule) => `(${rule.pattern})`).join('|'), 'gm');
  const built = { re, classes };
  compiled.set(lang, built);
  return built;
}

/** 语言别名归一；空串 = 纯文本 */
export function normalizeLang(lang: string): string {
  const key = lang.trim().toLowerCase();
  return key.length === 0 ? '' : (ALIAS[key] ?? key);
}

/** 该语言是否内置高亮规则（未知语言按纯文本渲染，不算错） */
export function isSupportedLang(lang: string): boolean {
  const key = normalizeLang(lang);
  return key !== '' && LANGS[key] !== undefined;
}

/** 一个带颜色的代码片段 */
export interface CodeToken {
  text: string;
  /** 空串 = 不着色 */
  cls: string;
}

/**
 * 把代码切成带颜色的片段（纯函数、无 React 依赖）。
 *
 * 抽出这一层是为了让 `CodeBlock`（React 渲染）与便签编辑器里的富文本代码块
 * （要在 `contentEditable` 里重建 innerHTML，只能用 **HTML 字符串**）
 * 共用同一套词法规则 —— 两边颜色因此永远一致，改一处两边都生效。
 */
export function tokenizeCode(code: string, lang: string): CodeToken[] {
  const engine = compile(normalizeLang(lang));
  if (engine === null) {
    return code === '' ? [] : [{ text: code, cls: '' }];
  }
  const { re, classes } = engine;
  const tokens: CodeToken[] = [];
  let cursor = 0;
  let guard = 0;
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    guard += 1;
    if (guard > 20000) {
      break;
    }
    // 全空匹配（例如裸的 `|` 规则）会导致死循环，跳过
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (match.index > cursor) {
      tokens.push({ text: code.slice(cursor, match.index), cls: '' });
    }
    const groupIndex = match.slice(1).findIndex((value) => value !== undefined);
    tokens.push({ text: match[0], cls: classes[groupIndex] ?? '' });
    cursor = match.index + match[0].length;
  }
  if (cursor < code.length) {
    tokens.push({ text: code.slice(cursor), cls: '' });
  }
  return tokens;
}

/** 代码文本 → HTML 安全的字符（只转义会破坏结构的三个字符，引号无需转） */
function escapeCode(text: string): string {
  return text.replace(/[&<>]/g, (char: string): string => {
    if (char === '&') {
      return '&amp;';
    }
    if (char === '<') {
      return '&lt;';
    }
    return '&gt;';
  });
}

/**
 * 代码 → 带 `<span class="…">` 的 HTML 字符串。
 *
 * 便签编辑器要「就地高亮」代码块，而 `contentEditable` 里没法塞 React 节点，
 * 只能重建 `innerHTML` —— 这就是那个入口。文本一律先转义，不存在注入面。
 */
export function highlightCodeHtml(code: string, lang: string): string {
  return tokenizeCode(code, lang)
    .map((token: CodeToken): string =>
      token.cls === ''
        ? escapeCode(token.text)
        : `<span class="${token.cls}">${escapeCode(token.text)}</span>`,
    )
    .join('');
}

/** 把一段代码切成带颜色的 React 片段 */
function highlight(code: string, lang: string): React.ReactNode[] {
  return tokenizeCode(code, lang).map((token: CodeToken, index: number): React.ReactNode =>
    token.cls === '' ? (
      token.text
    ) : (
      <span key={index} className={token.cls}>
        {token.text}
      </span>
    ),
  );
}

export interface CodeBlockProps {
  code: string;
  /** 语言标识（缺省 = 纯文本） */
  lang?: string;
  className?: string;
}

/**
 * 代码块（带语法高亮）。
 *
 * 支持的常见语言：shell / python / javascript(ts) / json / yaml / java / go / sql / ini(toml)，
 * 其余按纯文本渲染，不会报错也不会变色。
 */
export function CodeBlock({ code, lang = '', className }: CodeBlockProps): React.JSX.Element {
  const normalized = React.useMemo(() => normalizeLang(lang), [lang]);

  const nodes = React.useMemo(() => highlight(code.replace(/\s+$/, ''), normalized), [code, normalized]);
  const supported = isSupportedLang(normalized);

  return (
    <div className={cn('my-2 overflow-hidden rounded-lg border border-border bg-muted/40', className)}>
      <div className="flex items-center justify-between border-b border-border/70 px-2.5 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {normalized === '' ? 'text' : normalized}
          {supported ? '' : '（未内置高亮，按纯文本显示）'}
        </span>
      </div>
      <pre className="scrollbar-thin overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
        <code>{nodes}</code>
      </pre>
    </div>
  );
}

export default CodeBlock;
