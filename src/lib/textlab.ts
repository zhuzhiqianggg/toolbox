/**
 * 文本处理引擎（纯函数，无 React / 无 DOM / 无第三方依赖）。
 *
 * # 为什么要单独一个模块
 *
 * 用户反馈要「参考 Notepad++ 那些强大的文本处理能力」。如果把逻辑写进组件里，
 * 每加一个操作都要动 UI；而这类工具**真正容易出错的地方全是纯文本变换**
 * （换行风格、零宽字符、正则零长度匹配、去重的「保留首次出现」语义……），
 * 这些必须能被 `scripts/regression/test-textlab.mjs` 一条条钉死。
 * 所以本文件只做「字符串进、字符串出」，界面只负责收集参数与展示结果。
 *
 * # 术语
 *
 * - **行**：按 `\r\n` / `\r` / `\n` 切分。内部一律规范化成 `\n`，输出时按用户选的
 *   `Eol` 还原 —— 直接 `split('\n')` 会在 Windows 文本上留下行尾 `\r`，
 *   于是「去重」会把 `"a"` 和 `"a\r"` 当成两行（这是最常见的假 bug）。
 * - **模式**：`find` + 一组开关（正则 / 大小写 / 全词 / 含换行 / 多行）。
 *   非正则模式下 `find` 按**字面量**处理（`*`、`(`、`.` 都不特殊），
 *   这是用户对「普通查找」的预期。
 *
 * # 性能护栏
 *
 * 所有会遍历全部匹配的入口都带 `limit`（默认见 [`MATCH_LIMIT`]）。
 * 正则零长度匹配（如 `^`、`\b`）在上万行的文本上能产出几十万条「空匹配」，
 * 不设上限会把界面卡死；超过上限时返回 `truncated: true`，由界面告知用户。
 */

// ————————————————————————————————————————————————————————————————
// 常量
// ————————————————————————————————————————————————————————————————

/** 单次查找最多收集的匹配数（超出即截断，避免零长度匹配把内存吃光） */
export const MATCH_LIMIT: number = 20_000;

/** 「不可见字符」清理档位 */
export type InvisibleMode = 'zero-width' | 'control' | 'all';

/** 换行风格 */
export type Eol = 'lf' | 'crlf' | 'cr';

// ————————————————————————————————————————————————————————————————
// 行 / 换行
// ————————————————————————————————————————————————————————————————

/** 当前文本主要使用哪种换行（用于界面默认值） */
export function detectEol(text: string): Eol {
  const crlf: number = (text.match(/\r\n/g) ?? []).length;
  const cr: number = (text.match(/\r(?!\n)/g) ?? []).length;
  const lf: number = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf >= cr && crlf >= lf && crlf > 0) {
    return 'crlf';
  }
  if (cr > lf) {
    return 'cr';
  }
  return 'lf';
}

/** `Eol` → 实际分隔符 */
export function eolChars(eol: Eol): string {
  if (eol === 'crlf') {
    return '\r\n';
  }
  return eol === 'cr' ? '\r' : '\n';
}

/**
 * 切成行数组（**丢弃**换行符本身）。
 *
 * 统一吃掉 `\r\n` / `\r` / `\n`，所以调用方拿到的行不含任何行尾残留。
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split(/\r\n|\r|\n/);
}

/** 行数组 → 文本 */
export function joinLines(lines: readonly string[], eol: Eol = 'lf'): string {
  return lines.join(eolChars(eol));
}

/** 换行风格转换（不动内容，只动分隔符） */
export function convertEol(text: string, eol: Eol): string {
  return joinLines(splitLines(text), eol);
}

// ————————————————————————————————————————————————————————————————
// 统计
// ————————————————————————————————————————————————————————————————

/** 文本统计结果 */
export interface TextStats {
  /** 行数（末尾无换行时最后一行也算一行；空文本为 0） */
  lines: number;
  /** 非空行数（全空白行不计） */
  nonEmptyLines: number;
  /** 词数（按空白切分，连续空白算一个分隔） */
  words: number;
  /** 字符数（UTF-16 码元数，与 `String.length` 一致） */
  chars: number;
  /** 去重后的行数（区分大小写、保留首尾空白） */
  uniqueLines: number;
  /** 最长行的字符数 */
  longestLine: number;
  /**
   * UTF-8 字节数。
   *
   * 用 `TextEncoder` 而不是「非 ASCII 算 3 字节」的估算 —— 后者对 emoji（4 字节）
   * 和全角标点会算错，而「这个字符串发出去占多少字节」恰恰是运维最关心的数字。
   */
  bytes: number;
}

const utf8Encoder: TextEncoder = new TextEncoder();

/** 统计文本（行 / 词 / 字符 / 字节 / 去重行数） */
export function textStats(text: string): TextStats {
  const lines: string[] = splitLines(text);
  const trimmed: string = text.trim();
  return {
    lines: lines.length,
    nonEmptyLines: lines.filter((line) => line.trim().length > 0).length,
    words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
    chars: text.length,
    uniqueLines: new Set(lines).size,
    longestLine: lines.reduce((max, line) => Math.max(max, line.length), 0),
    bytes: utf8Encoder.encode(text).length,
  };
}

/** 把字节数按二进制单位格式化成人类可读（如 `1.5 KiB`） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units: readonly string[] = ['KiB', 'MiB', 'GiB'];
  let value: number = bytes / 1024;
  let index: number = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index] ?? 'KiB'}`;
}

// ————————————————————————————————————————————————————————————————
// 模式编译（查找 / 替换的地基）
// ————————————————————————————————————————————————————————————————

/** 查找参数 */
export interface FindOptions {
  /** 查找内容（非正则模式下按字面量解释） */
  find: string;
  /** 是否按正则解释 `find` */
  regex: boolean;
  /** 区分大小写 */
  caseSensitive: boolean;
  /** 全词匹配（等价于在两侧加 `\b`） */
  wholeWord: boolean;
  /** `.` 是否匹配换行（正则） */
  dotAll: boolean;
  /** `^` `$` 是否按行的首尾解释（正则） */
  multiline: boolean;
}

/** 默认查找参数：普通字面量、不区分大小写、非全词 */
export const DEFAULT_FIND: FindOptions = {
  find: '',
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  dotAll: false,
  multiline: false,
};

/** 正则转义（普通查找用，保证 `a.b` 只匹配 `a.b`） */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 编译结果 */
export interface CompiledPattern {
  ok: boolean;
  /** 编译成功时的**非全局**正则（多个入口需要自己 clone） */
  source?: RegExp;
  error?: string;
}

/**
 * 把「查找内容 + 开关」编译成正则。
 *
 * 全局标志 `g` 由调用方按需添加 —— 这里返回的是**无 `g`** 的样本正则，
 * 因为带 `g` 的正则对象有 `lastIndex` 状态，复用同一个实例做 `.test()`
 * 会出现「同一行两次结果不一样」的经典 bug。
 */
export function compilePattern(options: FindOptions): CompiledPattern {
  const raw: string = options.find;
  if (raw.length === 0) {
    return { ok: false, error: '请输入查找内容' };
  }
  const body: string = options.regex ? raw : escapeRegExp(raw);
  // 全词：把整体包进非捕获组再加边界，避免 `a|b` 变成 `\ba|b\b`
  const wrapped: string = options.wholeWord ? `\\b(?:${body})\\b` : body;
  let flags: string = '';
  if (!options.caseSensitive) {
    flags += 'i';
  }
  if (options.dotAll) {
    flags += 's';
  }
  if (options.multiline || options.regex === false) {
    // 普通查找也开 multiline：用户粘贴多行内容当「查找」时，
    // 逐行匹配比整段匹配更符合预期
    flags += 'm';
  }
  try {
    return { ok: true, source: new RegExp(wrapped, flags) };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : '正则语法错误' };
  }
}

/** 一条匹配 */
export interface MatchInfo {
  /** 起始下标 */
  index: number;
  /** 匹配长度 */
  length: number;
  /** 匹配到的文本 */
  value: string;
  /** 捕获组（不含整体匹配） */
  groups: string[];
}

/** 查找结果 */
export interface FindResult {
  ok: boolean;
  error?: string;
  matches: MatchInfo[];
  /** 是否因超过 [`MATCH_LIMIT`] 被截断 */
  truncated: boolean;
}

/**
 * 收集全部匹配。
 *
 * 用 `exec` 手写循环而不是 `matchAll`：需要拿到 `index` 做「按行定位」，
 * 且必须在**零长度匹配**时手动推进 `lastIndex`，否则 `^` 这类模式会原地打转。
 */
export function findMatches(
  text: string,
  options: FindOptions,
  limit: number = MATCH_LIMIT,
): FindResult {
  const compiled: CompiledPattern = compilePattern(options);
  if (!compiled.ok || compiled.source === undefined) {
    return { ok: false, error: compiled.error, matches: [], truncated: false };
  }
  const re: RegExp = new RegExp(compiled.source.source, compiled.source.flags + 'g');
  const matches: MatchInfo[] = [];
  let truncated: boolean = false;
  let hit: RegExpExecArray | null = re.exec(text);
  while (hit !== null) {
    matches.push({
      index: hit.index,
      length: hit[0].length,
      value: hit[0],
      groups: hit.slice(1).map((group) => group ?? ''),
    });
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    if (hit[0].length === 0) {
      re.lastIndex += 1; // 零长度：手动前进，避免死循环
    }
    hit = re.exec(text);
  }
  return { ok: true, matches, truncated };
}

/** 匹配计数（只数不存，给「替换 N 处」的实时提示用） */
export function countMatches(text: string, options: FindOptions): number {
  return findMatches(text, options, MATCH_LIMIT).matches.length;
}

// ————————————————————————————————————————————————————————————————
// 查找替换
// ————————————————————————————————————————————————————————————————

/** 替换选项 = 查找参数 + 替换文本 */
export interface ReplaceOptions extends FindOptions {
  /** 替换为（支持 `$1` `$&` `$<name>` 等 JS 替换模式；普通模式下同样生效） */
  replace: string;
}

/** 替换结果 */
export interface ReplaceResult {
  ok: boolean;
  error?: string;
  /** 替换后的文本（失败时原样返回入参） */
  text: string;
  /** 实际替换处数 */
  count: number;
  truncated: boolean;
}

/**
 * 全局替换。
 *
 * 普通（非正则）模式下也让 `$1` 之类的替换模式保持 JS 语义 —— 因为它此时等价于
 * 「整段匹配」`$&`，而 `$&` / `$$` 在普通替换里同样有用（如给每处命中加括号）。
 * 唯一的坑是普通文本里的 `$` 需要写成 `$$`，这一点在界面上给了提示。
 */
export function replaceAll(text: string, options: ReplaceOptions): ReplaceResult {
  const found: FindResult = findMatches(text, options);
  if (!found.ok || found.matches.length === 0) {
    return { ok: found.ok, error: found.error, text, count: 0, truncated: found.truncated };
  }
  const compiled: CompiledPattern = compilePattern(options);
  if (!compiled.ok || compiled.source === undefined) {
    return { ok: false, error: compiled.error, text, count: 0, truncated: false };
  }
  const re: RegExp = new RegExp(compiled.source.source, compiled.source.flags + 'g');
  const next: string = text.replace(re, options.replace);
  return {
    ok: true,
    text: next,
    count: found.matches.length,
    truncated: found.truncated,
  };
}

/**
 * 提取全部匹配（每行一条）。
 *
 * @param group 捕获组序号：0 = 整体匹配，>0 = 第 n 个捕获组
 * @param unique 是否去重（保序）
 */
export function extractMatches(
  text: string,
  options: FindOptions,
  group: number = 0,
  unique: boolean = false,
): ReplaceResult {
  const found: FindResult = findMatches(text, options);
  if (!found.ok) {
    return { ok: false, error: found.error, text: '', count: 0, truncated: false };
  }
  const picked: string[] = found.matches.map((match) => {
    if (group <= 0) {
      return match.value;
    }
    return match.groups[group - 1] ?? '';
  });
  const lines: string[] = unique ? [...new Set(picked)] : picked;
  return {
    ok: true,
    text: joinLines(lines, 'lf'),
    count: lines.length,
    truncated: found.truncated,
  };
}

// ————————————————————————————————————————————————————————————————
// 行操作表（界面与回归共用同一张事实源）
// ————————————————————————————————————————————————————————————————

/** 行操作的参数上下文（只有筛选 / 拆分类操作需要） */
export interface LineOpContext {
  /** 筛选类操作用的模式 */
  read: FindOptions;
  /** 合并 / 拆分用的分隔符 */
  delimiter: string;
  /** 行号样式的起始值 */
  start: number;
  /** 是否给行号加 `0001 ` 这样的零填充 */
  padded: boolean;
  /** 随机排列用的随机源（注入以便回归可复现） */
  random: () => number;
}

/** 行操作分组（界面按组渲染，回归按组遍历） */
export type LineOpGroup = '清洗' | '排序与重排' | '行号与注释' | '合并与拆分' | '按模式筛选';

/** 行操作 id */
export type LineOpId =
  | 'dedupe'
  | 'dedupe-ci'
  | 'remove-empty'
  | 'trim'
  | 'trim-end'
  | 'remove-invisible'
  | 'sort'
  | 'sort-desc'
  | 'sort-ci'
  | 'sort-num'
  | 'sort-len'
  | 'reverse'
  | 'shuffle'
  | 'number'
  | 'comment'
  | 'uncomment'
  | 'join'
  | 'split'
  | 'keep-matching'
  | 'drop-matching';

/** 行操作规格 */
export interface LineOpSpec {
  id: LineOpId;
  label: string;
  /** 悬浮提示：说清「做什么 + 什么场景用」 */
  hint: string;
  group: LineOpGroup;
  /** 需要查找模式（正则 / 关键字）才能执行 */
  needsPattern?: boolean;
}

/**
 * 行操作清单 —— **唯一事实源**。
 *
 * 界面按 `group` 渲染成按钮组，回归脚本遍历同一条目并断言「对样例文本都能跑通
 * 且不产生非法输出」。新增操作只在这里追加一条 + 在 [`applyLineOp`] 补一个分支，
 * 界面自动获得入口（与工具箱「新增命令只改数组」的思路一致）。
 */
export const LINE_OPS: readonly LineOpSpec[] = [
  {
    id: 'dedupe',
    label: '去重',
    hint: '移除内容完全相同的重复行，保留首次出现的位置',
    group: '清洗',
  },
  {
    id: 'dedupe-ci',
    label: '去重（忽略大小写）',
    hint: '同上，但 `Error` 与 `error` 视为同一行',
    group: '清洗',
  },
  {
    id: 'remove-empty',
    label: '删空行',
    hint: '删掉空行与只含空白字符的行',
    group: '清洗',
  },
  {
    id: 'trim',
    label: '去首尾空白',
    hint: '删掉每行开头与结尾的空格 / 制表符',
    group: '清洗',
  },
  {
    id: 'trim-end',
    label: '去行尾空白',
    hint: '只处理行尾 —— 代码 / 配置里最常需要清的就是行尾空格',
    group: '清洗',
  },
  {
    id: 'remove-invisible',
    label: '清不可见字符',
    hint: '删掉零宽空格、BOM、软连字符等看不见却会让字符串比较失败的字符',
    group: '清洗',
  },
  {
    id: 'sort',
    label: '排序',
    hint: '按字典序升序（区分大小写，大写在前）',
    group: '排序与重排',
  },
  {
    id: 'sort-desc',
    label: '排序（降序）',
    hint: '按字典序降序',
    group: '排序与重排',
  },
  {
    id: 'sort-ci',
    label: '排序（忽略大小写）',
    hint: '`apple` 与 `Apple` 相邻，适合混排人名 / 文件名',
    group: '排序与重排',
  },
  {
    id: 'sort-num',
    label: '按数值排序',
    hint: '按行首数字大小排序：`10` 排在 `9` 之后，而不是之前',
    group: '排序与重排',
  },
  {
    id: 'sort-len',
    label: '按长度排序',
    hint: '短行在前 —— 排日志 / 查最长字段时好用',
    group: '排序与重排',
  },
  {
    id: 'reverse',
    label: '逆序',
    hint: '把整体顺序倒过来（不排序，只颠倒）',
    group: '排序与重排',
  },
  {
    id: 'shuffle',
    label: '随机排列',
    hint: '打乱顺序 —— 抽检 / 取样用',
    group: '排序与重排',
  },
  {
    id: 'number',
    label: '加行号',
    hint: '每行前面加序号，便于引用「第 37 行」',
    group: '行号与注释',
  },
  {
    id: 'comment',
    label: '注释',
    hint: '每行前加 `# `（配置 / shell 场景）',
    group: '行号与注释',
  },
  {
    id: 'uncomment',
    label: '取消注释',
    hint: '去掉行首的 `# ` / `// ` —— 注释与取消注释成对使用',
    group: '行号与注释',
  },
  {
    id: 'join',
    label: '合并成一行',
    hint: '用指定分隔符把多行接成一行（默认逗号）',
    group: '合并与拆分',
  },
  {
    id: 'split',
    label: '按分隔符拆行',
    hint: '把 `a,b,c` 这类单行拆成多行，便于去重 / 排序',
    group: '合并与拆分',
  },
  {
    id: 'keep-matching',
    label: '只留匹配行',
    hint: '用上方「查找」框的模式筛选：只保留命中的行',
    group: '按模式筛选',
    needsPattern: true,
  },
  {
    id: 'drop-matching',
    label: '删掉匹配行',
    hint: '用上方「查找」框的模式筛选：删掉命中的行',
    group: '按模式筛选',
    needsPattern: true,
  },
];

/** 默认行操作上下文 */
export const DEFAULT_LINE_CTX: LineOpContext = {
  read: DEFAULT_FIND,
  delimiter: ',',
  start: 1,
  padded: false,
  random: Math.random,
};

// ————————————————————————————————————————————————————————————————
// 行操作实现
// ————————————————————————————————————————————————————————————————

/** 行操作结果 */
export interface LineOpResult {
  ok: boolean;
  error?: string;
  text: string;
  /** 给用户看的一句话说明（如「删除 12 行重复」） */
  note: string;
  /** 行数变化（正数 = 变多） */
  delta: number;
}

/** 零宽 / BOM 类字符（肉眼不可见，却会让字符串比较、Shebang 解析失败） */
const INVISIBLE_RE: RegExp = /[\u200B-\u200D\u2060\uFEFF\u00AD\u180E]/g;

/** 取行首数字（`12 ms` / `-3.5` / `1,024` 都能取到），取不到返回 null */
function leadingNumber(line: string): number | null {
  const match: RegExpMatchArray | null = line.trim().match(/^-?[\d.,]+/);
  if (match === null) {
    return null;
  }
  const cleaned: string = (match[0].split(',').join('')).split('.')[0] ?? '';
  const value: number = Number.parseInt(cleaned, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Fisher–Yates 洗牌（非原地，返回新数组）。
 *
 * 随机源从 [`LineOpContext.random`] 注入：回归脚本传固定序列即可复现结果，
 * 否则「随机排列」这条断言只能写成「长度不变」这种没营养的检查。
 */
function shuffleArray<T>(items: readonly T[], random: () => number): T[] {
  const out: T[] = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j: number = Math.floor(random() * (i + 1));
    const a: T | undefined = out[i];
    const b: T | undefined = out[j];
    if (a === undefined || b === undefined) {
      continue;
    }
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** 用「模式」判定一行是否命中（命中与否只看有没有匹配，不关心位置） */
function lineMatches(line: string, read: FindOptions): boolean {
  const found: FindResult = findMatches(line, read, 1);
  return found.ok && found.matches.length > 0;
}

/**
 * 执行一个行操作。
 *
 * 所有操作都是「文本进、文本出」，不抛异常：失败（如正则写错）返回 `ok: false`
 * 与原文本，由界面提示 —— 工具类界面里抛异常等于白屏，比报错难查得多。
 */
export function applyLineOp(
  text: string,
  id: LineOpId,
  context: Partial<LineOpContext> = {},
): LineOpResult {
  const ctx: LineOpContext = { ...DEFAULT_LINE_CTX, ...context };
  const eol: Eol = detectEol(text);
  const lines: string[] = splitLines(text);
  const before: number = lines.length;
  const done = (next: readonly string[], note: string): LineOpResult => ({
    ok: true,
    text: joinLines(next, eol),
    note,
    delta: next.length - before,
  });
  const fail = (error: string): LineOpResult => ({ ok: false, error, text, note: '', delta: 0 });

  switch (id) {
    case 'dedupe':
    case 'dedupe-ci': {
      const seen: Set<string> = new Set<string>();
      const next: string[] = [];
      for (const line of lines) {
        const key: string = id === 'dedupe-ci' ? line.toLowerCase() : line;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        next.push(line);
      }
      return done(next, `删除 ${before - next.length} 行重复内容`);
    }
    case 'remove-empty': {
      const next: string[] = lines.filter((line) => line.trim().length > 0);
      return done(next, `删除 ${before - next.length} 行空行`);
    }
    case 'trim': {
      return done(lines.map((line) => line.trim()), '已去掉每行首尾空白');
    }
    case 'trim-end': {
      return done(lines.map((line) => line.replace(/[ \t]+$/, '')), '已去掉每行行尾空白');
    }
    case 'remove-invisible': {
      const hits: number = lines.reduce(
        (sum, line) => sum + (line.match(INVISIBLE_RE) ?? []).length,
        0,
      );
      return done(
        lines.map((line) => line.replace(INVISIBLE_RE, '')),
        hits === 0 ? '没有发现不可见字符' : `清除 ${hits} 个不可见字符`,
      );
    }
    case 'sort':
    case 'sort-desc':
    case 'sort-ci': {
      const sorted: string[] = [...lines].sort((a, b) =>
        id === 'sort-ci' ? a.localeCompare(b, 'zh-Hans-CN') : a < b ? -1 : a > b ? 1 : 0,
      );
      return done(id === 'sort-desc' ? sorted.reverse() : sorted, '已重新排序');
    }
    case 'sort-num': {
      const sorted: string[] = [...lines].sort((a, b) => {
        const left: number | null = leadingNumber(a);
        const right: number | null = leadingNumber(b);
        if (left === null && right === null) {
          return 0;
        }
        // 取不到数字的行排到最后，而不是当成 0 混在数字中间
        if (left === null) {
          return 1;
        }
        if (right === null) {
          return -1;
        }
        return left - right;
      });
      return done(sorted, '已按行首数值排序');
    }
    case 'sort-len': {
      const sorted: string[] = [...lines].sort((a, b) => a.length - b.length);
      return done(sorted, '已按行长排序');
    }
    case 'reverse': {
      return done([...lines].reverse(), '已逆序');
    }
    case 'shuffle': {
      return done(shuffleArray(lines, ctx.random), '已随机排列');
    }
    case 'number': {
      const width: number = String(ctx.start + Math.max(0, before - 1)).length;
      const next: string[] = lines.map((line, index) => {
        const value: number = ctx.start + index;
        const label: string = ctx.padded ? String(value).padStart(Math.max(2, width), '0') : String(value);
        return `${label} ${line}`;
      });
      return done(next, `已加行号（从 ${ctx.start} 起）`);
    }
    case 'comment': {
      return done(lines.map((line) => `# ${line}`), '已逐行加 `# `');
    }
    case 'uncomment': {
      return done(lines.map((line) => line.replace(/^\s*(?:#|\/\/)\s?/, '')), '已去掉行首注释符');
    }
    case 'join': {
      const separator: string = ctx.delimiter.length > 0 ? ctx.delimiter : ',';
      const joined: string = lines.join(separator);
      return { ok: true, text: joined, note: `已合并成 1 行（用「${separator}」连接）`, delta: 1 - before };
    }
    case 'split': {
      const separator: string = ctx.delimiter.length > 0 ? ctx.delimiter : ',';
      const next: string[] = [];
      for (const line of lines) {
        for (const piece of line.split(separator)) {
          next.push(piece.trim());
        }
      }
      const filtered: string[] = next.filter((line, index) => !(line.length === 0 && index === next.length - 1));
      return done(filtered, `已按「${separator}」拆成 ${filtered.length} 行`);
    }
    case 'keep-matching':
    case 'drop-matching': {
      if (ctx.read.find.length === 0) {
        return fail('「按模式筛选」需要先在查找框里填内容');
      }
      const keep: boolean = id === 'keep-matching';
      const next: string[] = lines.filter((line) => lineMatches(line, ctx.read) === keep);
      const removed: number = before - next.length;
      return done(
        next,
        keep ? `保留 ${next.length} 行、移除 ${removed} 行` : `删除 ${removed} 行匹配内容`,
      );
    }
    default: {
      // 穷尽性检查：新增 LineOpId 却忘了实现时，这里会编译报错而不是静默不干活
      const never: never = id;
      return fail(`未实现的操作：${String(never)}`);
    }
  }
}

// ————————————————————————————————————————————————————————————————
// 列处理（Notepad++ 的「列模式」简化版）
// ————————————————————————————————————————————————————————————————

/** 取列结果 */
export interface ColumnResult {
  ok: boolean;
  error?: string;
  text: string;
  note: string;
}

/**
 * 按分隔符取列。
 *
 * @param pick 列号表达式：`1`、`2,4`、`2-4`（1 起数，支持混合如 `1,3-4`）
 * @param trim 是否去掉取值后的首尾空白
 *
 * 用 `,` 的简单分割（不支持带引号的 CSV）—— 那种场景属于 `csv-json` 工具的活，
 * 这里保持「按字符切」的直觉语义，不假装懂 CSV。
 */
export function pickColumns(
  text: string,
  delimiter: string,
  pick: string,
  trim: boolean = true,
): ColumnResult {
  const sep: string = delimiter.length > 0 ? delimiter : '\t';
  const indexes: number[] = parseColumnPick(pick);
  if (indexes.length === 0) {
    return { ok: false, error: '列号要写成 `1`、`2,4` 或 `2-4`', text, note: '' };
  }
  const eol: Eol = detectEol(text);
  const lines: string[] = splitLines(text);
  const next: string[] = lines.map((line) => {
    const cells: string[] = line.split(sep);
    return indexes
      .map((index) => {
        const cell: string | undefined = cells[index - 1];
        if (cell === undefined) {
          return '';
        }
        return trim ? cell.trim() : cell;
      })
      .join(sep);
  });
  return {
    ok: true,
    text: joinLines(next, eol),
    note: `已取第 ${indexes.join('、')} 列（分隔符「${sep === '\t' ? 'Tab' : sep}」）`,
  };
}

/** 解析列号表达式 `1,3-4`（非法片段忽略；去重并升序） */
export function parseColumnPick(pick: string): number[] {
  const out: Set<number> = new Set<number>();
  for (const raw of pick.split(/[,，\s]+/)) {
    if (raw.length === 0) {
      continue;
    }
    const dash: number = raw.indexOf('-', 1);
    if (dash > 0) {
      const from: number = Number.parseInt(raw.slice(0, dash), 10);
      const to: number = Number.parseInt(raw.slice(dash + 1), 10);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        continue;
      }
      const low: number = Math.max(1, Math.min(from, to));
      const high: number = Math.min(200, Math.max(from, to));
      for (let i = low; i <= high; i += 1) {
        out.add(i);
      }
      continue;
    }
    const value: number = Number.parseInt(raw, 10);
    if (Number.isFinite(value) && value >= 1 && value <= 200) {
      out.add(value);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ————————————————————————————————————————————————————————————————
// 前后缀 / 包裹 / 换行宽度
// ————————————————————————————————————————————————————————————————

/** 给每行加前后缀（生成 SQL 的 `IN (...)` 列表这种活） */
export function affixLines(
  text: string,
  prefix: string,
  suffix: string,
  skipEmpty: boolean = true,
): string {
  const eol: Eol = detectEol(text);
  const lines: string[] = splitLines(text).map((line) => {
    if (skipEmpty && line.trim().length === 0) {
      return line;
    }
    return `${prefix}${line}${suffix}`;
  });
  return joinLines(lines, eol);
}

/**
 * 硬换行：按显示宽度折行（英文按字符、中文按 2 宽度算）。
 *
 * 不做智能断词 —— 这是「把长行折短」而不是排版引擎；断词交给用户用
 * 查找替换处理更可控。
 */
export function wrapLines(text: string, width: number): string {
  const limit: number = Math.max(10, Math.trunc(width));
  const eol: Eol = detectEol(text);
  const out: string[] = [];
  for (const line of splitLines(text)) {
    let rest: string = line;
    if (rest.length === 0) {
      out.push('');
      continue;
    }
    let guard: number = 0;
    while (rest.length > limit && guard < 10_000) {
      out.push(rest.slice(0, limit));
      rest = rest.slice(limit);
      guard += 1;
    }
    out.push(rest);
  }
  return joinLines(out, eol);
}
