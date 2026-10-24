/**
 * 剪贴板 / 输入内容智能识别（V05 建议条 + `detect.matcher` 扩展点）。
 *
 * 识别 JSON / JWT / URL / 时间戳 / Base64，并给出「一键直达」的目标命令 id。
 * 纯函数、无副作用，便于单测。
 */

export type DetectKind = 'json' | 'jwt' | 'url' | 'timestamp' | 'base64';

export interface Detection {
  kind: DetectKind;
  /** 展示名（如「JSON」） */
  label: string;
  /** 建议说明（如「格式化 JSON」） */
  suggestion: string;
  /** 对应命令 id（供命令面板一键直达；命令不存在时由 UI 兜底提示） */
  commandId: string;
}

/** 命令 id → 命令面板中的目标（与 §2.3 的 kebab-case 约定一致） */
const COMMAND_BY_KIND: Record<DetectKind, string> = {
  json: 'json-formatter',
  jwt: 'jwt-decoder',
  url: 'url-codec',
  timestamp: 'timestamp',
  base64: 'base64-codec',
};

function trimmed(text: string): string {
  return text.trim();
}

function isJson(text: string): boolean {
  const value = trimmed(text);
  if (!(value.startsWith('{') || value.startsWith('['))) {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** base64url 段 → 解码后的 JSON 值；不是合法 base64url / 不是合法 JSON 时抛错 */
function decodeBase64UrlJson(segment: string): unknown {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/**
 * 是否是 JWT。
 *
 * **必须校验第一段能解成 JSON 对象**，不能只看「三个点分段 + 字符集」——
 * 否则 `1.2.3`、`v1.2.3`、`www.example.com`、`file.name.txt`、`foo.json.bak`
 * 这类极常见的三段式文本会被判成 JWT，在建议条里弹出「解析 JWT 载荷」的错误推荐。
 *
 * 依据来自规范：JWS 的受保护头部就是 base64url 编码的 JSON 对象（RFC 7515 §4）。
 */
function isJwt(text: string): boolean {
  const value = trimmed(text);
  const parts = value.split('.');
  if (parts.length !== 3) {
    return false;
  }
  const [headerPart] = parts;
  if (headerPart === undefined || headerPart.length === 0 || !/^[A-Za-z0-9_-]+$/.test(headerPart)) {
    return false;
  }
  if (!parts.every((part) => part.length > 0 && /^[A-Za-z0-9_-]+$/.test(part))) {
    return false;
  }
  try {
    const header = decodeBase64UrlJson(headerPart);
    return typeof header === 'object' && header !== null && !Array.isArray(header);
  } catch {
    return false;
  }
}

function isUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(trimmed(text));
}

/** 10 位（秒）/ 13 位（毫秒）且落在 2001-01-01 ~ 2035-01-01 之间 */
function isTimestamp(text: string): boolean {
  const value = trimmed(text);
  if (!/^\d{10}$|^\d{13}$/.test(value)) {
    return false;
  }
  const ms = value.length === 13 ? Number(value) : Number(value) * 1000;
  const min = Date.UTC(2001, 0, 1);
  const max = Date.UTC(2035, 0, 1);
  return ms >= min && ms <= max;
}

/**
 * 是否是 Base64。
 *
 * 除了字符集与长度，**还要求解码结果是合法 UTF-8** —— 本工具承诺「文本 ↔ Base64，
 * UTF-8 安全」，所以解码后必须是可显示的文本。不校验的话，`Feedback` / `Password` /
 * `DataBase` / `Username` 这类 8 字母单词（长度是 4 的倍数、字符全在表内）会被当成 Base64。
 */
function isBase64(text: string): boolean {
  const value = trimmed(text);
  if (value.length < 8 || value.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  try {
    // 浏览器 / WebView / Node 均提供 atob；解码失败即判定为非 Base64
    const binary = atob(value);
    if (binary.length === 0) {
      return false;
    }
    // fatal: true —— 出现非法字节序列即抛错，据此排除「恰好像 Base64 的英文单词」
    new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    );
    return true;
  } catch {
    return false;
  }
}

/** 识别全部命中的类型（按优先级排序） */
export function detectContent(text: string): Detection[] {
  const value = trimmed(text);
  if (value.length === 0) {
    return [];
  }

  const detectors: Record<DetectKind, { label: string; suggestion: string; test: () => boolean }> = {
    json: { label: 'JSON', suggestion: '格式化 / 校验 JSON', test: () => isJson(value) },
    jwt: { label: 'JWT', suggestion: '解析 JWT 载荷', test: () => isJwt(value) },
    url: { label: 'URL', suggestion: '解码 URL 参数', test: () => isUrl(value) },
    timestamp: { label: '时间戳', suggestion: '转换为日期时间', test: () => isTimestamp(value) },
    base64: { label: 'Base64', suggestion: '解码 Base64 文本', test: () => isBase64(value) },
  };

  const order: DetectKind[] = ['json', 'jwt', 'url', 'timestamp', 'base64'];
  const result: Detection[] = [];
  for (const kind of order) {
    const detector = detectors[kind];
    if (detector.test()) {
      result.push({
        kind,
        label: detector.label,
        suggestion: detector.suggestion,
        commandId: COMMAND_BY_KIND[kind],
      });
    }
  }
  return result;
}

/** 识别单个最可信的类型（无命中返回 null） */
export function detectFirst(text: string): Detection | null {
  return detectContent(text)[0] ?? null;
}
