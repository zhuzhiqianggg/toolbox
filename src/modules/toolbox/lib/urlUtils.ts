/**
 * URL 编解码底层能力：三种编码方法、结构化解析 / 重建、查询参数、统计与对照表。
 *
 * 全部基于浏览器原生 `encodeURIComponent` / `decodeURIComponent` / `URL` / `URLSearchParams`。
 */

/** 编码方法。 */
export type UrlMethod = 'component' | 'uri' | 'form';

/** 方法说明（顶部切换用）。 */
export const URL_METHODS: ReadonlyArray<{ id: UrlMethod; label: string; hint: string }> = [
  {
    id: 'component',
    label: '标准编码',
    hint: 'encodeURIComponent：编码除 A-Z a-z 0-9 - _ . ! ~ * \' ( ) 外的所有字符',
  },
  {
    id: 'uri',
    label: 'URI 编码',
    hint: 'encodeURI：保留 : / ? & = # 等 URI 保留字符，整串 URL 可直接用',
  },
  {
    id: 'form',
    label: '表单编码',
    hint: 'application/x-www-form-urlencoded：空格编码为 +',
  },
];

/** URL 的六个可编辑组成部分。 */
export interface UrlParts {
  /** 协议，含尾部冒号，如 `https:` */
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
  /** 查询串，含前导 `?` */
  search: string;
  /** 片段，含前导 `#` */
  hash: string;
}

/** 解析结果。 */
export interface ParsedUrl {
  /** 是否解析成功 */
  ok: boolean;
  /** 是否自动补充了 `http://` 才能解析 */
  repaired: boolean;
  parts: UrlParts | null;
  error: string | null;
}

/** URL 输入统计。 */
export interface UrlStats {
  /** 字符数（按 Unicode 码点计数，emoji 算 1） */
  chars: number;
  /** UTF-8 字节数 */
  bytes: number;
  /** 是否含中文 / 日文 / 韩文 */
  hasCjk: boolean;
  /** 是否含需要编码的特殊字符 */
  hasSpecial: boolean;
}

/** 解析出的查询参数键值对。 */
export interface QueryPair {
  key: string;
  value: string;
}

const EMPTY_PARTS: UrlParts = {
  protocol: '',
  hostname: '',
  port: '',
  pathname: '',
  search: '',
  hash: '',
};

/** 是否像「带协议」的绝对 URL（`scheme:` 前缀）。 */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * 是否其实是「主机:端口」而不是「协议:」。
 *
 * 为什么必须有这个判断：`new URL('example.com:8080/path')` **不会报错** ——
 * WHATWG 把非特殊协议整段当 opaque path，于是它读成
 * 「协议 `example.com:` + 路径 `8080/path`」，**hostname / port 双双为空**。
 * 用户粘一个 `localhost:5173`（本地调试最常见的写法）进来，界面会安静地
 * 展示一份错误的结构分解 —— 静默错答案比报错危险得多。
 *
 * 判据（两条都够实用，且不会误伤 mailto: / tel: / data: / urn: 这类无 `//` 的协议）：
 *   - 冒号前含 `.` → 是域名（`example.com:8080`）；
 *   - 冒号后直接跟数字 → 是端口（`localhost:5173`、`weird:8080`）。
 */
function looksLikeHostPort(value: string): boolean {
  const colon = value.indexOf(':');
  if (colon < 0) {
    return false;
  }
  const before = value.slice(0, colon);
  const after = value.slice(colon + 1);
  return before.includes('.') || /^\d/.test(after);
}

/** 中日韩字符判定：CJK 扩展 A、CJK 基本区、兼容表意文字、日文假名、韩文音节。 */
const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

/** 按方法编码。 */
export function encodeWithMethod(input: string, method: UrlMethod): string {
  if (method === 'uri') {
    return encodeURI(input);
  }
  const component = encodeURIComponent(input);
  return method === 'form' ? component.replace(/%20/g, '+') : component;
}

/**
 * 按方法解码。
 * @throws 输入含非法转义序列（如孤立的 `%`）时抛出 `Error`
 */
export function decodeWithMethod(input: string, method: UrlMethod): string {
  const source = method === 'form' ? input.replace(/\+/g, ' ') : input;
  // decodeURIComponent 是 decodeURI 的超集：能正确处理 encodeURI 产出的串，
  // 因此 'uri' / 'component' 两种方法的解码口径一致。
  return decodeURIComponent(source);
}

/** 生成空 parts（受控输入框的初始值）。 */
export function emptyParts(): UrlParts {
  return { ...EMPTY_PARTS };
}

/**
 * 解析 URL 为六个组成部分。
 *
 * 缺少协议时自动补 `http://` 再解析（容错），并通过 `repaired` 标记告知 UI 展示黄色徽章。
 */
export function parseUrlParts(raw: string): ParsedUrl {
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, repaired: false, parts: null, error: null };
  }
  let candidate = value;
  let repaired = false;
  if (value.startsWith('//')) {
    // 协议相对写法（`//host/path`）：只补协议名，别补成 `http:////host/path` ——
    // 那样 authority 是空的，hostname 会解析成空串。
    candidate = `http:${value}`;
    repaired = true;
  } else if (!SCHEME_RE.test(candidate) || looksLikeHostPort(candidate)) {
    candidate = `http://${value}`;
    repaired = true;
  }
  try {
    const url = new URL(candidate);
    return {
      ok: true,
      repaired,
      parts: {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        pathname: url.pathname,
        search: url.search,
        hash: url.hash,
      },
      error: null,
    };
  } catch (cause: unknown) {
    return {
      ok: false,
      repaired: false,
      parts: null,
      error: '无法解析为 URL（地址含非法字符，或缺少协议）',
    };
  }
}

/** 六个部分 → 完整 URL（补全缺失的 `:` `//` `/` `?` `#` 前缀）。 */
export function buildUrl(parts: UrlParts): string {
  // 协议字段用户可能写成 `https` / `https:` / `https://` 三种形态，统一收敛成 `https`
  const protocol = parts.protocol.trim().replace(/[:\/]+$/, '');
  const hostname = parts.hostname.trim();
  const port = parts.port.trim().replace(/^:+/, '');
  const pathname = parts.pathname.trim();
  let search = parts.search.trim();
  let hash = parts.hash.trim();

  if (search.length > 0 && !search.startsWith('?')) {
    search = `?${search}`;
  }
  if (hash.length > 0 && !hash.startsWith('#')) {
    hash = `#${hash}`;
  }

  const authority = port.length > 0 ? `${hostname}:${port}` : hostname;
  if (authority.length === 0) {
    return protocol.length > 0
      ? `${protocol}:${pathname}${search}${hash}`
      : `${pathname}${search}${hash}`;
  }
  const path = pathname.length > 0 && !pathname.startsWith('/') ? `/${pathname}` : pathname;
  return `${protocol.length > 0 ? `${protocol}://` : '//'}${authority}${path}${search}${hash}`;
}

/** 从完整 URL（或裸查询串）解析出查询参数列表。 */
export function parseQueryPairs(raw: string): QueryPair[] {
  const value = raw.trim();
  if (value.length === 0) {
    return [];
  }
  let query = value;
  const questionIndex = value.indexOf('?');
  if (questionIndex >= 0) {
    query = value.slice(questionIndex + 1);
  }
  const hashIndex = query.indexOf('#');
  if (hashIndex >= 0) {
    query = query.slice(0, hashIndex);
  }
  if (query.length === 0) {
    return [];
  }
  const pairs: QueryPair[] = [];
  new URLSearchParams(query).forEach((itemValue, itemKey) => {
    pairs.push({ key: itemKey, value: itemValue });
  });
  return pairs;
}

/** 查询参数 → 可展示的 `key = value` 文本（每行一条）。 */
export function formatQueryPairs(pairs: readonly QueryPair[]): string {
  return pairs.map((pair) => `${pair.key} = ${pair.value}`).join('\n');
}

/** 输入统计：字符数 / UTF-8 字节数 / 是否含中文 / 是否含特殊字符。 */
export function computeUrlStats(input: string): UrlStats {
  return {
    chars: Array.from(input).length,
    bytes: new TextEncoder().encode(input).length,
    hasCjk: CJK_RE.test(input),
    hasSpecial: input.length > 0 && encodeURIComponent(input) !== input,
  };
}

/** 一键填充示例。 */
export const URL_EXAMPLES: ReadonlyArray<{ label: string; value: string }> = [
  {
    label: '普通 URL',
    value: 'https://example.com/docs/getting-started?ref=toolbox#section-2',
  },
  {
    label: '中文 URL',
    value: 'https://zh.wikipedia.org/wiki/中文编码',
  },
  {
    label: '已编码 URL',
    value: 'https%3A%2F%2Fexample.com%2Fsearch%3Fq%3Dhello%2520world%26lang%3Dzh',
  },
  {
    label: '多查询参数',
    value:
      'https://api.example.com/v1/items?page=1&size=20&sort=created_at&order=desc&filter=active&q=关键词',
  },
];

/** 对照表单行。 */
export interface UrlReferenceRow {
  char: string;
  /** URL 编码（encodeURIComponent） */
  component: string;
  /** 表单编码（application/x-www-form-urlencoded） */
  form: string;
  note: string;
}

/** 常用字符编码对照表说明（说明列写清关键坑点）。 */
const REFERENCE_NOTES: ReadonlyArray<{ char: string; note: string }> = [
  { char: ' ', note: '空格在表单编码中是 +，标准编码为 %20' },
  { char: '!', note: '非保留字符，两种编码结果一致' },
  { char: '"', note: '在 HTML 属性中还需额外转义为 &quot;' },
  { char: '#', note: '片段标识符分隔符，必须编码' },
  { char: '$', note: '非保留字符，两种编码结果一致' },
  { char: '%', note: '百分号自身必须编码为 %25，否则会被当作转义前缀' },
  { char: '&', note: '查询参数分隔符，必须编码' },
  { char: "'", note: '单引号，URI 中允许但建议编码' },
  { char: '(', note: 'RFC 3986 非保留字符，可不编码' },
  { char: ')', note: 'RFC 3986 非保留字符，可不编码' },
  { char: '*', note: 'RFC 3986 非保留字符，可不编码' },
  { char: '+', note: '标准编码为 %2B；表单编码中 + 代表空格，故必须编码' },
  { char: ',', note: 'RFC 3986 非保留字符，可不编码' },
  { char: '/', note: '路径分隔符，必须编码以免改变层级' },
  { char: ':', note: '协议与端口分隔符，必须编码' },
  { char: ';', note: '子分隔符，参数值中建议编码' },
  { char: '=', note: '参数键值分隔符，必须编码' },
  { char: '?', note: '查询串起始分隔符，必须编码' },
  { char: '@', note: '用户信息分隔符，必须编码' },
  { char: '[', note: 'IPv6 主机分隔符，URI 中必须编码' },
  { char: ']', note: 'IPv6 主机分隔符，URI 中必须编码' },
  { char: '中', note: '中文等非 ASCII 字符按 UTF-8 逐字节编码（3 字节 → %E4%B8%AD）' },
];

/** 常用字符编码对照表（编码值运行时计算，避免手写出错）。 */
export const URL_REFERENCE_ROWS: ReadonlyArray<UrlReferenceRow> = REFERENCE_NOTES.map((item) => ({
  char: item.char,
  component: encodeURIComponent(item.char),
  form: encodeURIComponent(item.char).replace(/%20/g, '+'),
  note: item.note,
}));
