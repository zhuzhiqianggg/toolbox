/**
 * Base64 编解码底层能力：字符编码、URL 安全变体、MIME 换行、文件读写。
 *
 * 全部基于浏览器原生 API（`TextEncoder` / `btoa` / `FileReader`），无第三方依赖，
 * 浏览器与 Tauri WebView 行为一致。
 */

/** 文本字符编码（影响中文等非 ASCII 字符的编码结果）。 */
export type TextEncoding = 'utf-8' | 'utf-16' | 'ascii';

/** 编码选项下拉。 */
export const TEXT_ENCODINGS: ReadonlyArray<{ id: TextEncoding; label: string; hint: string }> = [
  { id: 'utf-8', label: 'UTF-8', hint: '中文 3 字节，最常用' },
  { id: 'utf-16', label: 'UTF-16', hint: 'UTF-16LE，中文 2 字节' },
  { id: 'ascii', label: 'ASCII', hint: '非 ASCII 字符将被丢弃高位' },
];

/** MIME 风格换行宽度（RFC 2045）。 */
export const BASE64_WRAP_WIDTH = 76;

/** 文件上传上限：10MB（再大建议用命令行）。 */
export const BASE64_MAX_FILE_SIZE = 10 * 1024 * 1024;

/** 字符串 → UTF-16LE 字节（`TextEncoder` 不支持 UTF-16，需手工处理）。 */
function toUtf16LeBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return bytes;
}

/** UTF-16LE 字节 → 字符串（奇数长度时忽略最后一个孤立字节）。 */
function fromUtf16LeBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const low = bytes[i] ?? 0;
    const high = bytes[i + 1] ?? 0;
    out += String.fromCharCode((high << 8) | low);
  }
  return out;
}

/** 文本 → 字节（按所选字符编码）。 */
export function textToBytes(text: string, encoding: TextEncoding): Uint8Array {
  if (encoding === 'utf-16') {
    return toUtf16LeBytes(text);
  }
  if (encoding === 'ascii') {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) {
      bytes[i] = text.charCodeAt(i) & 0x7f;
    }
    return bytes;
  }
  return new TextEncoder().encode(text);
}

/** 字节 → 文本（按所选字符编码）。 */
export function bytesToText(bytes: Uint8Array, encoding: TextEncoding): string {
  if (encoding === 'utf-16') {
    return fromUtf16LeBytes(bytes);
  }
  if (encoding === 'ascii') {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      out += String.fromCharCode((bytes[i] ?? 0) & 0x7f);
    }
    return out;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** 字节 → Base64（分块拼接，避免超大数组展开导致调用栈溢出）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Base64 → 字节。非法输入抛错（由调用方转成友好提示）。 */
export function base64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 标准 Base64 → URL 安全 Base64（`+`→`-`、`/`→`_`、去掉尾部 `=`）。 */
export function toUrlSafe(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL 安全 Base64 → 标准 Base64（还原字符并补齐 `=`）。 */
export function fromUrlSafe(input: string): string {
  let normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = normalized.length % 4;
  if (remainder === 2) {
    normalized += '==';
  } else if (remainder === 3) {
    normalized += '=';
  } else if (remainder === 1) {
    // 长度模 4 余 1 不是合法 Base64，补 3 个 '=' 让 atob 抛出明确错误
    normalized += '===';
  }
  return normalized;
}

/** 按 MIME 风格每 N 个字符插入换行。 */
export function wrapLines(base64: string, width: number = BASE64_WRAP_WIDTH): string {
  if (width <= 0) {
    return base64;
  }
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += width) {
    lines.push(base64.slice(i, i + width));
  }
  return lines.join('\n');
}

/** 归一化待解码输入：去掉所有空白字符（含 MIME 换行与误粘贴的空格）。 */
export function normalizeBase64Input(input: string): string {
  return input.replace(/\s+/g, '');
}

/** 编解码选项。 */
export interface Base64Options {
  /** 文本字符编码 */
  encoding: TextEncoding;
  /** 是否启用 URL 安全变体 */
  urlSafe: boolean;
  /** 是否每 76 字符换行 */
  wrap: boolean;
}

/** 编码：文本 → Base64（应用 URL 安全 / 换行选项）。 */
export function encodeBase64(text: string, options: Base64Options): string {
  const raw = bytesToBase64(textToBytes(text, options.encoding));
  const safe = options.urlSafe ? toUrlSafe(raw) : raw;
  return options.wrap ? wrapLines(safe) : safe;
}

/**
 * 解码：Base64 → 文本。
 * @throws 输入不是合法 Base64 时抛出 `Error`
 */
export function decodeBase64(input: string, options: Base64Options): string {
  const cleaned = normalizeBase64Input(input);
  if (cleaned.length === 0) {
    return '';
  }
  const restored = options.urlSafe ? fromUrlSafe(cleaned) : cleaned;
  const bytes = base64ToBytes(restored);
  return bytesToText(bytes, options.encoding);
}

/** 读取文件为 Base64 字符串（dataURL 去掉前缀）。 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      const result: unknown = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('文件读取结果类型异常'));
        return;
      }
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = (): void => {
      reject(reader.error ?? new Error('文件读取失败'));
    };
    reader.readAsDataURL(file);
  });
}

/** 读取文件为文本。 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      const result: unknown = reader.result;
      if (typeof result === 'string') {
        resolve(result);
        return;
      }
      reject(new Error('文件读取结果类型异常'));
    };
    reader.onerror = (): void => {
      reject(reader.error ?? new Error('文件读取失败'));
    };
    reader.readAsText(file);
  });
}
