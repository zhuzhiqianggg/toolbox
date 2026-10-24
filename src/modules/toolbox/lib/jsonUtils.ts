/**
 * JSON 处理工具集（工具箱 JSON 格式化器专用）。
 *
 * 全部自写实现，**不引入任何第三方依赖**（不引 jsonpath-plus / js-yaml / papaparse）：
 * - 统计分析（字符数 / 行数 / 对象数 / 数组数 / 键总数 / 最大嵌套深度）；
 * - **JSONPath 基础子集解析与查询**（`$.a.b[0]` / `$.a[*].b` / `$..name` / `$.a[0,1]` / `$.a['x','y']`）；
 * - CSV 导出（对象数组 → 表格，取所有键的并集）；
 * - YAML 序列化（缩进 2 空格，处理嵌套 / 数组 / 字符串引号转义）；
 * - TypeScript 类型推断（`interface Root { ... }`，含嵌套、数组、联合类型、字段名加引号）。
 */

/** JSON 统计面板数据 */
export interface JsonStats {
  /** 输入字符数 */
  chars: number;
  /** 输入行数 */
  lines: number;
  /** 对象数量 */
  objects: number;
  /** 数组数量 */
  arrays: number;
  /** 键总数（含嵌套与重复键的每次出现） */
  keys: number;
  /** 最大嵌套深度（根为 1） */
  depth: number;
}

/** 是否为「可展开容器」（对象或数组） */
export function isContainer(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/** 是否为普通对象（排除数组与 null） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 值类型标签（树视图的类型标记） */
export function typeLabel(value: unknown): 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
}

/** 容器预览文本（如 `{3 键}` / `[5 项]`） */
export function containerPreview(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.length} 项]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).length} 键}`;
  }
  return '';
}

/** 叶子节点的展示文本（字符串保留引号，便于区分 "1" 与 1） */
export function leafText(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (value === null) {
    return 'null';
  }
  return String(value);
}

/** 节点值的复制文本（对象/数组 → JSON，字符串 → 原始值） */
export function nodeCopyText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * 统计输入与解析结果的规模指标。
 * 用显式栈遍历，避免深层 JSON 触发调用栈溢出。
 */
export function analyzeJson(raw: string, value: unknown): JsonStats {
  const stats: JsonStats = {
    chars: raw.length,
    lines: raw.length === 0 ? 0 : raw.split('\n').length,
    objects: 0,
    arrays: 0,
    keys: 0,
    depth: 0,
  };
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    if (current.depth > stats.depth) {
      stats.depth = current.depth;
    }
    const node = current.value;
    if (Array.isArray(node)) {
      stats.arrays += 1;
      for (const item of node) {
        if (isContainer(item)) {
          stack.push({ value: item, depth: current.depth + 1 });
        }
      }
      continue;
    }
    if (isPlainObject(node)) {
      stats.objects += 1;
      for (const key of Object.keys(node)) {
        stats.keys += 1;
        const child = node[key];
        if (isContainer(child)) {
          stack.push({ value: child, depth: current.depth + 1 });
        }
      }
    }
  }
  return stats;
}

// ——————————————————— JSONPath 基础子集 ———————————————————

/** JSONPath 段类型 */
export type PathSegment =
  /** 根 `$` */
  | { kind: 'root' }
  /** `.name` */
  | { kind: 'child'; name: string }
  /** `['a','b']` 多键 */
  | { kind: 'keys'; names: string[] }
  /** `[0]` / `[0,1]` / `[-1]` */
  | { kind: 'index'; indices: number[] }
  /** `[*]` / `.*` */
  | { kind: 'wildcard' }
  /** `..name` 递归下降 */
  | { kind: 'descendant'; name: string }
  /** `..*` 递归下降全部 */
  | { kind: 'descendantWildcard' };

/** JSONPath 命中项 */
export interface JsonPathMatch {
  /** 命中节点的规范化路径 */
  path: string;
  /** 命中值 */
  value: unknown;
}

/** 递归深度上限（防御性，避免超大 JSON 卡死） */
const PATH_MAX_DEPTH = 60;
/** 递归下降收集条数上限 */
const PATH_COLLECT_LIMIT = 500;

/** 读取 `.` 之后的字段名（遇到 `.` / `[` / `]` 停止） */
function readName(src: string, from: number): string {
  let end = from;
  while (end < src.length) {
    const ch = src.charAt(end);
    if (ch === '.' || ch === '[' || ch === ']') {
      break;
    }
    end += 1;
  }
  return src.slice(from, end).trim();
}

/** token 是否为引号包裹 */
function isQuoted(token: string): boolean {
  const t = token.trim();
  return (
    (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) ||
    (t.length >= 2 && t.startsWith("'") && t.endsWith("'"))
  );
}

/** 去掉首尾引号 */
function unquote(token: string): string {
  const t = token.trim();
  if (isQuoted(t)) {
    return t.slice(1, -1);
  }
  return t;
}

/** 按顶层逗号切分（尊重引号） */
function splitTopLevel(content: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of content) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

/** 解析 `[...]` 内部内容 */
function parseBracket(inner: string): PathSegment {
  const content = inner.trim();
  if (content.length === 0) {
    throw new Error('[] 内不能为空');
  }
  if (content === '*') {
    return { kind: 'wildcard' };
  }
  // 明确拒掉**本子集不支持**的写法，而不是把它们当成字段名去查、最后安静地返回 0 条命中
  // （`[?(@.price<10)]` 被当成键名 `?(@.price<10)`，用户只会以为自己的数据没命中）
  if (content.startsWith('?')) {
    throw new Error('本工具只支持 JSONPath 基础子集，不支持过滤表达式 [?(@.字段)]');
  }
  const parts = splitTopLevel(content);
  if (parts.length === 0) {
    throw new Error(`[] 内内容无效：${content}`);
  }
  if (parts.some((part) => !isQuoted(part) && part.includes(':'))) {
    throw new Error('本工具只支持 JSONPath 基础子集，不支持切片写法（如 [0:2]）；请用 [0,1] 逐个列出下标');
  }
  const allIndex = parts.every((part) => !isQuoted(part) && /^-?\d+$/.test(part));
  if (allIndex) {
    return { kind: 'index', indices: parts.map((part) => Number.parseInt(part, 10)) };
  }
  const names = parts.map(unquote);
  if (names.some((name) => name.length === 0)) {
    throw new Error(`[] 内的字段名无效：${content}`);
  }
  return { kind: 'keys', names };
}

/**
 * 解析 JSONPath 表达式（基础子集）。
 *
 * 支持：`$`、`.name`、`['name']`、`[0]`、`[0,1]`、`[-1]`、`[*]`、`.*`、`..name`、`..*`。
 * 非法表达式抛出带中文说明的 Error。
 */
export function parseJsonPath(expression: string): PathSegment[] {
  const src = expression.trim();
  if (src.length === 0) {
    throw new Error('请输入 JSONPath 表达式，如 $.store.book[0].title');
  }
  if (src.charAt(0) !== '$') {
    throw new Error('JSONPath 必须以 $ 开头，例如 $.store.book[0].title');
  }
  const segments: PathSegment[] = [{ kind: 'root' }];
  let i = 1;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      const end = src.indexOf(']', i);
      if (end === -1) {
        throw new Error(`括号未闭合：缺少 ]（位置 ${i + 1}）`);
      }
      segments.push(parseBracket(src.slice(i + 1, end)));
      i = end + 1;
      continue;
    }
    if (ch === '.') {
      // `..name` / `..*` 递归下降
      if (src.charAt(i + 1) === '.') {
        i += 2;
        if (i >= src.length) {
          throw new Error('.. 之后缺少字段名或 *');
        }
        if (src.charAt(i) === '[') {
          continue;
        }
        if (src.charAt(i) === '*') {
          segments.push({ kind: 'descendantWildcard' });
          i += 1;
          continue;
        }
        const name = readName(src, i);
        if (name.length === 0) {
          throw new Error(`无法解析 .. 之后的字段名（位置 ${i + 1}）`);
        }
        segments.push({ kind: 'descendant', name });
        i += name.length;
        continue;
      }
      i += 1;
      if (i >= src.length) {
        throw new Error('路径不能以 . 结尾');
      }
      if (src.charAt(i) === '[') {
        continue;
      }
      if (src.charAt(i) === '*') {
        segments.push({ kind: 'wildcard' });
        i += 1;
        continue;
      }
      const name = readName(src, i);
      if (name.length === 0) {
        throw new Error(`无法解析 . 之后的字段名（位置 ${i + 1}）`);
      }
      segments.push({ kind: 'child', name });
      i += name.length;
      continue;
    }
    throw new Error(`无法解析的字符 “${ch}”（位置 ${i + 1}）`);
  }
  return segments;
}

/** 字段名是否可直接用点号书写 */
function isIdentifier(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

/** 拼接路径片段 */
function joinPath(base: string, key: string): string {
  return isIdentifier(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

/** 取容器的一级子节点 */
function childrenOf(value: unknown, path: string): JsonPathMatch[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => ({ path: `${path}[${index}]`, value: item }));
  }
  if (isPlainObject(value)) {
    return Object.keys(value).map((key) => ({
      path: joinPath(path, key),
      value: value[key],
    }));
  }
  return [];
}

/** 递归收集指定字段名（不含根节点自身） */
function collectByName(
  value: unknown,
  name: string,
  path: string,
  out: JsonPathMatch[],
  depth: number,
): void {
  if (depth > PATH_MAX_DEPTH || out.length >= PATH_COLLECT_LIMIT) {
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (out.length >= PATH_COLLECT_LIMIT) {
        return;
      }
      collectByName(value[i], name, `${path}[${i}]`, out, depth + 1);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (out.length >= PATH_COLLECT_LIMIT) {
        return;
      }
      const childPath = joinPath(path, key);
      const child = value[key];
      if (key === name) {
        out.push({ path: childPath, value: child });
      }
      collectByName(child, name, childPath, out, depth + 1);
    }
  }
}

/** 递归收集全部子节点（不含根节点自身） */
function collectAll(value: unknown, path: string, out: JsonPathMatch[], depth: number): void {
  if (depth > PATH_MAX_DEPTH || out.length >= PATH_COLLECT_LIMIT) {
    return;
  }
  for (const child of childrenOf(value, path)) {
    if (out.length >= PATH_COLLECT_LIMIT) {
      return;
    }
    out.push(child);
    collectAll(child.value, child.path, out, depth + 1);
  }
}

/** 对单个节点应用一个路径段 */
function applySegment(item: JsonPathMatch, segment: PathSegment): JsonPathMatch[] {
  const { value, path } = item;
  switch (segment.kind) {
    case 'root':
      return [item];
    case 'child': {
      if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, segment.name)) {
        return [{ path: joinPath(path, segment.name), value: value[segment.name] }];
      }
      return [];
    }
    case 'keys': {
      if (!isPlainObject(value)) {
        return [];
      }
      const out: JsonPathMatch[] = [];
      for (const name of segment.names) {
        if (Object.prototype.hasOwnProperty.call(value, name)) {
          out.push({ path: joinPath(path, name), value: value[name] });
        }
      }
      return out;
    }
    case 'index': {
      if (!Array.isArray(value)) {
        return [];
      }
      const out: JsonPathMatch[] = [];
      for (const raw of segment.indices) {
        const index = raw < 0 ? value.length + raw : raw;
        if (index >= 0 && index < value.length) {
          out.push({ path: `${path}[${index}]`, value: value[index] });
        }
      }
      return out;
    }
    case 'wildcard':
      return childrenOf(value, path);
    case 'descendant': {
      const out: JsonPathMatch[] = [];
      collectByName(value, segment.name, path, out, 0);
      return out;
    }
    case 'descendantWildcard': {
      const out: JsonPathMatch[] = [];
      collectAll(value, path, out, 0);
      return out;
    }
    default:
      return [];
  }
}

/**
 * 执行 JSONPath 查询，返回命中列表（最多 `limit` 条）。
 * 段解析已在前置步骤完成，本函数不抛异常。
 */
export function queryJsonPath(
  root: unknown,
  segments: PathSegment[],
  limit: number = 200,
): JsonPathMatch[] {
  let current: JsonPathMatch[] = [{ path: '$', value: root }];
  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined) {
      continue;
    }
    const next: JsonPathMatch[] = [];
    for (const item of current) {
      next.push(...applySegment(item, segment));
      if (next.length >= limit) {
        break;
      }
    }
    current = next.slice(0, limit);
    if (current.length === 0) {
      return [];
    }
  }
  return current;
}

/** 命中值 → 单行预览文本 */
export function formatMatchValue(value: unknown, maxLength: number = 160): string {
  if (typeof value === 'string') {
    const quoted = JSON.stringify(value);
    if (quoted.length <= maxLength) {
      return quoted;
    }
    // 字符串在引号**内部**截断：直接切渲染后的文本会切出 `"ab…` 这种引号不闭合的半截样子，
    // 看起来像是工具坏了。容器仍按渲染文本切（`{"a":1…` 是预览，语义上就是「还有更多」）。
    const budget = Math.max(0, maxLength - 3); // 两侧引号 + 省略号各占一位，正文补满剩余额度
    return JSON.stringify(`${value.slice(0, budget)}…`);
  }
  let text = '';
  if (isContainer(value)) {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }
  if (text === undefined) {
    text = 'undefined';
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

// ——————————————————— CSV 导出 ———————————————————

/** CSV 单元格转义（含逗号 / 引号 / 换行时加引号，内部引号翻倍） */
function csvCell(value: unknown): string {
  let text = '';
  if (value === null || value === undefined) {
    text = '';
  } else if (isContainer(value)) {
    text = JSON.stringify(value) ?? '';
  } else {
    text = String(value);
  }
  const escaped = text.replace(/"/g, '""');
  return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
}

/**
 * 对象数组 → CSV（取所有对象键的并集）。
 * 根节点为单个对象时按一行输出；非对象数组时返回错误说明。
 */
export function toCsv(value: unknown): { ok: true; text: string } | { ok: false; error: string } {
  let rows: unknown[];
  if (Array.isArray(value)) {
    rows = value;
  } else if (isPlainObject(value)) {
    rows = [value];
  } else {
    return { ok: false, error: 'CSV 导出需要对象或对象数组作为根' };
  }
  if (rows.length === 0) {
    return { ok: false, error: '根节点为空数组，无内容可导出' };
  }
  const nonObject = rows.filter((row) => !isPlainObject(row)).length;
  if (nonObject > 0) {
    return {
      ok: false,
      error: `数组中有 ${nonObject} 个非对象元素，无法扁平化为 CSV（可先只选中对象数组）`,
    };
  }
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isPlainObject(row)) {
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const lines: string[] = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    if (!isPlainObject(row)) {
      continue;
    }
    lines.push(headers.map((key) => csvCell(row[key])).join(','));
  }
  return { ok: true, text: lines.join('\n') };
}

// ——————————————————— YAML 导出 ———————————————————

/** 字符串是否需要加引号 */
function needsQuote(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (/^\s/.test(value) || /\s$/.test(value)) {
    return true;
  }
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) {
    return true;
  }
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) {
    return true;
  }
  if (/[:#]/.test(value)) {
    return true;
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) {
    return true;
  }
  if (/[\n\r\t]/.test(value)) {
    return true;
  }
  return false;
}

/** YAML 双引号字符串（转义 \ " 与控制字符） */
function quoteYamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** 标量 → YAML 文本 */
function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return needsQuote(value) ? quoteYamlString(value) : value;
  }
  return String(value);
}

/** 键 → YAML 文本 */
function yamlKey(key: string): string {
  return needsQuote(key) ? quoteYamlString(key) : key;
}

/** YAML 序列化（返回行数组，不含末尾换行） */
function serializeYaml(value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent);
  if (value === null || typeof value !== 'object') {
    return [`${pad}${yamlScalar(value as string | number | boolean | null)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${pad}[]`];
    }
    const lines: string[] = [];
    for (const item of value) {
      if (isContainer(item)) {
        if (Array.isArray(item) && item.length === 0) {
          lines.push(`${pad}- []`);
          continue;
        }
        if (isPlainObject(item) && Object.keys(item).length === 0) {
          lines.push(`${pad}- {}`);
          continue;
        }
        const childLines = serializeYaml(item, indent + 2);
        const first = childLines[0] ?? '';
        lines.push(`${pad}- ${first.trimStart()}`);
        for (let i = 1; i < childLines.length; i += 1) {
          lines.push(childLines[i] ?? '');
        }
        continue;
      }
      lines.push(`${pad}- ${yamlScalar(item as string | number | boolean | null)}`);
    }
    return lines;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return [`${pad}{}`];
  }
  const lines: string[] = [];
  for (const [key, item] of entries) {
    if (isContainer(item)) {
      if (Array.isArray(item) && item.length === 0) {
        lines.push(`${pad}${yamlKey(key)}: []`);
        continue;
      }
      if (isPlainObject(item) && Object.keys(item).length === 0) {
        lines.push(`${pad}${yamlKey(key)}: {}`);
        continue;
      }
      lines.push(`${pad}${yamlKey(key)}:`);
      lines.push(...serializeYaml(item, indent + 2));
      continue;
    }
    lines.push(`${pad}${yamlKey(key)}: ${yamlScalar(item as string | number | boolean | null)}`);
  }
  return lines;
}

/** 值 → YAML 文本（缩进 2 空格，末尾带换行） */
export function toYaml(value: unknown): string {
  return `${serializeYaml(value, 0).join('\n')}\n`;
}

// ——————————————————— TypeScript 类型推断 ———————————————————

/** 合并后的字段（一个字段可能对应多个取值，来自数组中不同对象的同名键） */
interface MergedField {
  key: string;
  values: unknown[];
  /** 是否在部分对象中缺失 */
  optional: boolean;
}

interface TsContext {
  /** 接口名 → 字段代码 */
  bodies: Map<string, string>;
  /** 接口名 → 字段签名（用于复用同名同构接口） */
  signatures: Map<string, string>;
  /** 接口名 → 已占用的序号 */
  counters: Map<string, number>;
}

/** 字段名 → PascalCase 接口名候选 */
function pascalCase(input: string): string {
  let out = '';
  let upperNext = true;
  for (const ch of input) {
    if (/[A-Za-z0-9]/.test(ch)) {
      out += upperNext ? ch.toUpperCase() : ch;
      upperNext = false;
    } else {
      upperNext = true;
    }
  }
  if (out.length === 0) {
    return 'Item';
  }
  return /^[0-9]/.test(out) ? `N${out}` : out;
}

/** 数组元素名 → 单数形式（去尾 s） */
function singularize(name: string): string {
  const base = pascalCase(name);
  if (base.length > 3 && base.endsWith('s') && !base.endsWith('ss')) {
    return base.slice(0, -1);
  }
  return base;
}

/** 申请一个接口名：结构一致则复用，否则追加序号 */
function uniqueName(base: string, signature: string, ctx: TsContext): string {
  const existing = ctx.signatures.get(base);
  if (existing === signature) {
    return base;
  }
  if (existing === undefined) {
    ctx.signatures.set(base, signature);
    return base;
  }
  // 基础名已被**别的结构**占用 → 追加序号。
  // 这里用 while 逐个找空位，而不是递归调用自己：递归在第三次冲突时会产出
  // `Item` → `Item2` → `Item22`（序号叠序号），看着就像 bug。
  let n = Math.max(2, (ctx.counters.get(base) ?? 1) + 1);
  for (;;) {
    const candidate = `${base}${n}`;
    const taken = ctx.signatures.get(candidate);
    if (taken === undefined || taken === signature) {
      ctx.signatures.set(candidate, signature);
      ctx.counters.set(base, n);
      return candidate;
    }
    n += 1;
  }
}

/**
 * 取值 → 粗粒度类型标签（只参与「同键是否同构」的判定，不出现在最终输出里）。
 *
 * 为什么签名不能只看键名：`{ item: { a: 1 } }` 与 `{ wrap: { item: { a: 's' } } }`
 * 的两个 `a` 字段键名相同但类型不同，只看键名的签名会把它们当成同一个接口，
 * 于是第二处**静默复用**了 `a: number` —— 生成的类型与数据打架，用户完全看不出来。
 */
function kindOf(values: readonly unknown[]): string {
  const kinds = new Set<string>();
  for (const value of values) {
    if (value === null) {
      kinds.add('null');
    } else if (Array.isArray(value)) {
      kinds.add('array');
    } else if (isPlainObject(value)) {
      kinds.add('object');
    } else {
      kinds.add(typeof value);
    }
  }
  return [...kinds].sort().join(',');
}

/** 把多个同构对象合并为一个字段表 */
function mergeObjectShapes(items: unknown[]): MergedField[] | null {
  if (items.length === 0 || !items.every(isPlainObject)) {
    return null;
  }
  const map = new Map<string, MergedField>();
  for (const item of items) {
    if (!isPlainObject(item)) {
      continue;
    }
    for (const key of Object.keys(item)) {
      const field = map.get(key);
      if (field === undefined) {
        map.set(key, { key, values: [item[key]], optional: false });
      } else {
        field.values.push(item[key]);
      }
    }
  }
  for (const item of items) {
    if (!isPlainObject(item)) {
      continue;
    }
    for (const key of map.keys()) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) {
        const field = map.get(key);
        if (field !== undefined) {
          field.optional = true;
        }
      }
    }
  }
  return [...map.values()];
}

/** 对象 → 字段表 */
function fieldsOf(value: Record<string, unknown>): MergedField[] {
  return Object.keys(value).map((key) => ({ key, values: [value[key]], optional: false }));
}

function tsArrayType(items: unknown[], hint: string, ctx: TsContext, depth: number): string {
  if (items.length === 0) {
    return 'unknown[]';
  }
  const merged = mergeObjectShapes(items);
  if (merged !== null) {
    // 同构对象数组 → 合并为单个接口，接口名取单数（items → Item）
    return `${tsObjectType(merged, singularize(hint), ctx, depth)}[]`;
  }
  const types = new Set<string>();
  for (const item of items.slice(0, 100)) {
    types.add(tsType(item, singularize(hint), ctx, depth + 1));
  }
  const list = [...types].sort();
  const inner = list.length === 1 ? (list[0] ?? 'unknown') : `(${list.join(' | ')})`;
  return `${inner}[]`;
}

/** 字段 → 类型表达式（多个取值时合并为联合类型或合并对象结构） */
function tsFieldType(field: MergedField, hint: string, ctx: TsContext, depth: number): string {
  if (field.values.length === 1) {
    return tsType(field.values[0] ?? null, hint, ctx, depth);
  }
  const merged = mergeObjectShapes(field.values);
  if (merged !== null) {
    return tsObjectType(merged, hint, ctx, depth);
  }
  if (field.values.every(Array.isArray)) {
    const all: unknown[] = [];
    for (const value of field.values) {
      if (Array.isArray(value)) {
        all.push(...value);
      }
    }
    return tsArrayType(all, hint, ctx, depth);
  }
  const types = new Set<string>();
  for (const value of field.values.slice(0, 100)) {
    types.add(tsType(value, hint, ctx, depth + 1));
  }
  return [...types].sort().join(' | ');
}

function tsObjectType(
  fields: MergedField[],
  hint: string,
  ctx: TsContext,
  depth: number,
): string {
  const signature = fields
    .map((field) => `${field.key}:${kindOf(field.values)}`)
    .sort()
    .join('|');
  const name = uniqueName(pascalCase(hint), signature, ctx);
  if (ctx.bodies.has(name)) {
    return name;
  }
  // 先占位，避免嵌套同名结构重复生成
  ctx.bodies.set(name, '');
  const lines: string[] = [];
  for (const field of fields) {
    const keyText = isIdentifier(field.key) ? field.key : JSON.stringify(field.key);
    const typeText = tsFieldType(field, field.key, ctx, depth + 1);
    lines.push(`  ${keyText}${field.optional ? '?' : ''}: ${typeText};`);
  }
  ctx.bodies.set(name, lines.length > 0 ? lines.join('\n') : '  [key: string]: unknown;');
  return name;
}

/** 任意 JSON 值 → TypeScript 类型表达式 */
function tsType(value: unknown, hint: string, ctx: TsContext, depth: number): string {
  if (depth > 24) {
    return 'unknown';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return tsArrayType(value, hint, ctx, depth);
  }
  if (isPlainObject(value)) {
    return tsObjectType(fieldsOf(value), hint, ctx, depth);
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  return 'string';
}

/**
 * JSON 值 → TypeScript 类型声明代码。
 * 对象生成 `interface`，非对象根生成 `type Root = ...`；字段名非法时自动加引号。
 */
export function toTypeScript(value: unknown, rootName: string = 'Root'): string {
  const ctx: TsContext = {
    bodies: new Map(),
    signatures: new Map(),
    counters: new Map(),
  };
  const rootType = tsType(value, rootName, ctx, 0);
  const blocks: string[] = [];
  for (const [name, body] of ctx.bodies) {
    blocks.push(`interface ${name} {\n${body}\n}`);
  }
  if (blocks.length === 0) {
    return `type ${pascalCase(rootName)} = ${rootType};\n`;
  }
  if (!isContainer(value)) {
    blocks.unshift(`type ${pascalCase(rootName)} = ${rootType};`);
  }
  return `${blocks.join('\n\n')}\n`;
}
