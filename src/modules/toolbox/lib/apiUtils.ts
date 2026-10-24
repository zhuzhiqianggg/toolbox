/**
 * 接口测试（api-tester）底层能力 —— 纯函数、无 React / DOM / Tauri 依赖，便于回归。
 *
 * 三块能力：
 *  1. `parseCurl` —— 粘贴浏览器 DevTools / 终端里的 cURL 命令直接还原成请求
 *     （这是接口测试工具最高频的冷启动方式：从别处拷一条现成请求来改）；
 *  2. 请求装配：头部行去重 / 敏感头部识别（不持久化）/ URL 校验；
 *  3. 响应展示：状态分档 / JSON 自动美化 / 体积与耗时格式化。
 *
 * 本文件被 `scripts/regression/test-api.mjs` 直接 import（Node 原生类型剥离跑源码），
 * 因此**只允许相对路径 import 且必须带 `.ts` 扩展名**（vite 别名 Node 不认识）。
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** 请求头部行（可编辑列表的行模型） */
export interface HeaderRow {
  key: string;
  value: string;
}

/** 解析 cURL 后得到的请求描述 */
export interface ParsedCurl {
  method: HttpMethod;
  url: string;
  headers: HeaderRow[];
  body: string;
}

/** cURL 里「不带值」的开关（见到就跳过，不吞下一个 token） */
const VALUELESS_FLAGS = new Set([
  '-k', '--insecure',
  '-s', '--silent',
  '-S', '--show-error',
  '-v', '--verbose',
  '-i', '--include',
  '-L', '--location',
  '-#', '--progress-bar',
  '-f', '--fail',
  '--compressed',
  '-G', '--get',
  '-g', '--globoff',
]);

/** 带一个值的选项 → 语义名 */
const VALUE_FLAGS: Record<string, string> = {
  '-X': 'method', '--request': 'method',
  '-H': 'header', '--header': 'header',
  '-d': 'data', '--data': 'data', '--data-raw': 'data', '--data-ascii': 'data', '--data-binary': 'data',
  '--data-urlencode': 'data',
  '--json': 'json',
  '--url': 'url',
  '-u': 'user', '--user': 'user',
};

/** 是否是 HTTP(S) URL（粗判，最终交给请求层验证） */
function looksLikeUrl(token: string): boolean {
  return /^https?:\/\//i.test(token) || /^[a-z][a-z0-9+.-]*:\/\//i.test(token);
}

/**
 * 把 cURL 命令切成 token：支持 `\\` 续行、单引号（字面量）、双引号（处理 `\\"` / `\\\\`）、
 * 以及 macOS DevTools 产的 `$'...'`（内部允许反斜杠转义）。
 */
export function tokenizeCurl(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, ' ');
  const tokens: string[] = [];
  let current = '';
  let has = false;
  let i = 0;
  const push = (): void => {
    if (has) {
      tokens.push(current);
      current = '';
      has = false;
    }
  };
  while (i < text.length) {
    const ch = text.charAt(i);
    // macOS 的 $'...' —— 与单引号一样切到收尾引号，但内部处理反斜杠转义
    if (ch === '$' && text.charAt(i + 1) === "'") {
      i += 2;
      has = true;
      while (i < text.length && text.charAt(i) !== "'") {
        if (text.charAt(i) === '\\' && i + 1 < text.length) {
          const esc = text.charAt(i + 1);
          current +=
            esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          current += text.charAt(i);
          i += 1;
        }
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      i += 1;
      has = true;
      while (i < text.length && text.charAt(i) !== "'") {
        current += text.charAt(i);
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      has = true;
      while (i < text.length && text.charAt(i) !== '"') {
        if (text.charAt(i) === '\\' && i + 1 < text.length) {
          const esc = text.charAt(i + 1);
          current += esc === '"' || esc === '\\' || esc === '$' || esc === '`' ? esc : `\\${esc}`;
          i += 2;
        } else {
          current += text.charAt(i);
          i += 1;
        }
      }
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      i += 1;
      continue;
    }
    current += ch;
    has = true;
    i += 1;
  }
  push();
  return tokens;
}

/** `K: V` 头部串拆成行；`K;`（curl 的「发空值头」）拆成 K + 空值 */
function splitHeader(raw: string): HeaderRow | null {
  const at = raw.indexOf(':');
  if (at === -1) {
    const key = raw.replace(/;$/, '').trim();
    return key.length > 0 ? { key, value: '' } : null;
  }
  const key = raw.slice(0, at).trim();
  const value = raw.slice(at + 1).trim();
  return key.length > 0 ? { key, value } : null;
}

/**
 * 解析 cURL 命令；找不到 URL 时返回 null。
 *
 * 覆盖 DevTools「Copy as cURL (bash)」与终端手写两种来源的常见写法：
 * `-X` / `-H` / `-d`(及全部别名) / `--json` / `-u` / `--url` / 续行 / 三种引号。
 * 未知开关按「不带值」保守跳过 —— 宁可少认一个参数，不可把 body 错当 URL。
 */
export function parseCurl(input: string): ParsedCurl | null {
  const tokens = tokenizeCurl(input);
  let method: HttpMethod | null = null;
  let url = '';
  let body = '';
  const headers: HeaderRow[] = [];
  let sawData = false;
  let sawJson = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }
    if (i === 0 && /^curl(?:\.exe)?$/i.test(token)) {
      continue;
    }
    if (VALUELESS_FLAGS.has(token)) {
      continue;
    }
    if (VALUE_FLAGS[token] !== undefined) {
      const value = tokens[i + 1];
      if (value === undefined) {
        break;
      }
      i += 1;
      const kind = VALUE_FLAGS[token];
      if (kind === 'method') {
        const upper = value.toUpperCase();
        if ((HTTP_METHODS as readonly string[]).includes(upper)) {
          method = upper as HttpMethod;
        }
      } else if (kind === 'header') {
        const row = splitHeader(value);
        if (row) {
          headers.push(row);
        }
      } else if (kind === 'data') {
        body = body.length > 0 ? `${body}&${value}` : value;
        sawData = true;
      } else if (kind === 'json') {
        body = body.length > 0 ? `${body}&${value}` : value;
        sawData = true;
        sawJson = true;
      } else if (kind === 'url') {
        url = value;
      } else if (kind === 'user') {
        // curl -u user:pass → Basic 认证头
        try {
          headers.push({ key: 'Authorization', value: `Basic ${btoa(value)}` });
        } catch {
          headers.push({ key: 'Authorization', value: `Basic (${value})` });
        }
      }
      continue;
    }
    // 未知 `-abc` 簇：按不带值处理（保守）
    if (/^-\w{2,}$/.test(token) || /^--[\w-]+$/.test(token)) {
      continue;
    }
    if (url.length === 0 && looksLikeUrl(token)) {
      url = token;
      continue;
    }
    // 其余自由 token 忽略（如 `$CURLVariables` 展开残留）
  }

  if (url.length === 0) {
    return null;
  }
  if (sawJson && !headers.some((h) => h.key.toLowerCase() === 'content-type')) {
    headers.push({ key: 'Content-Type', value: 'application/json' });
  }
  const finalMethod: HttpMethod = method ?? (sawData ? 'POST' : 'GET');
  return { method: finalMethod, url, headers, body };
}

/** 敏感头部：值不进持久化（沿用项目「密钥类输入不落盘」约定） */
export function isSensitiveHeader(key: string): boolean {
  return /authorization|token|secret|api[-_]?key|cookie|password/i.test(key.trim());
}

/** 头部行 → 记录：空键丢弃、键大小写不敏感去重（后者胜出） */
export function rowsToRecord(rows: readonly HeaderRow[]): Record<string, string> {
  const record: Record<string, string> = {};
  const keyByLower = new Map<string, string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) {
      continue;
    }
    // HTTP 头部名大小写不敏感：accept 与 Accept 是同一个头，别给服务器发两份
    const lower = key.toLowerCase();
    const existing = keyByLower.get(lower);
    if (existing !== undefined && existing !== key) {
      delete record[existing];
    }
    keyByLower.set(lower, key);
    record[key] = row.value;
  }
  return record;
}

/** 持久化用：敏感头的值置空（键保留，方便用户下次只补 token） */
export function rowsForPersist(rows: readonly HeaderRow[]): HeaderRow[] {
  return rows.map((row) =>
    isSensitiveHeader(row.key) ? { key: row.key, value: '' } : { key: row.key, value: row.value },
  );
}

/** URL 校验：返回错误说明；合法返回 null */
export function validateTarget(rawUrl: string): string | null {
  const value = rawUrl.trim();
  if (value.length === 0) {
    return '请填写请求 URL';
  }
  if (!/^https?:\/\//i.test(value)) {
    return 'URL 需以 http:// 或 https:// 开头';
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '仅支持 http(s) 协议';
    }
    return null;
  } catch {
    return 'URL 格式无效';
  }
}

/** 响应状态 → 展示分档（0 = 网络 / CORS 失败） */
export function statusTone(status: number): 'ok' | 'info' | 'warn' | 'error' {
  if (status === 0) {
    return 'error';
  }
  if (status < 300) {
    return 'ok';
  }
  if (status < 400) {
    return 'info';
  }
  if (status < 500) {
    return 'warn';
  }
  return 'error';
}

/** 请求体自动美化：合法 JSON 才格式化（2 空格），超 1 MB 不动（防大文本卡顿） */
export function prettyBody(raw: string): string {
  const text = raw.trim();
  if (text.length === 0 || text.length > 1_000_000) {
    return raw;
  }
  if (!(text.startsWith('{') || text.startsWith('['))) {
    return raw;
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return raw;
  }
}

/** 耗时展示：<1s 用毫秒，≥1s 用秒（保留 2 位） */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** 响应体积展示（1024 进制；与 byteUnits 的二进制口径一致，只是单行输出） */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
