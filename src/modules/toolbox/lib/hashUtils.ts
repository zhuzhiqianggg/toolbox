// 用相对路径而非 `@/lib/md5`：本文件要被 `scripts/regression/test-hash.mjs` 直接 import
// （靠 Node ≥ 22.18 的原生类型剥离跑源码），Node 既不认识 vite 的路径别名，
// 也不做扩展名补全 —— 所以写成带 `.ts` 的显式路径（tsconfig 已开 allowImportingTsExtensions）。
import { md5Bytes } from '../../../lib/md5.ts';

/**
 * 哈希工具底层能力：算法表、摘要计算、文件分片读取。
 *
 * 说明：Web Crypto（`crypto.subtle`）不提供 MD5，故 MD5 走 `src/lib/md5.ts` 的自实现；
 * SHA 系列统一走 `crypto.subtle.digest`，无需引入第三方依赖。
 */

/** 支持的哈希算法（与 `crypto.subtle.digest` 的算法名保持一致）。 */
export type HashAlgo = 'MD5' | 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

/** 算法展示顺序（弱 → 强）。 */
export const HASH_ALGOS: readonly HashAlgo[] = ['MD5', 'SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];

/** 各算法十六进制摘要长度（校验模式按长度自动匹配算法用）。 */
export const HASH_HEX_LENGTH: Readonly<Record<HashAlgo, number>> = {
  MD5: 32,
  'SHA-1': 40,
  'SHA-256': 64,
  'SHA-384': 96,
  'SHA-512': 128,
};

/** 文件分片大小：2MB（兼顾进度条粒度与内存占用）。 */
export const HASH_FILE_CHUNK_SIZE = 2 * 1024 * 1024;

/** 文件大小上限：100MB（再大的文件交给专业校验工具）。 */
export const HASH_MAX_FILE_SIZE = 100 * 1024 * 1024;

/** 摘要计算中间状态。 */
export interface DigestOutcome {
  /** 算法 → 小写十六进制摘要；失败的算法不出现在本记录中 */
  digests: Partial<Record<HashAlgo, string>>;
  /** 计算过程中的错误描述（部分算法失败也算，成功为 null） */
  error: string | null;
}

/** 文件读取进度。 */
export interface FileReadProgress {
  loaded: number;
  total: number;
}

/** 归一化错误信息。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ArrayBuffer → 小写十六进制。 */
export function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Web Crypto 是否可用（需安全上下文：Tauri / https / localhost 均满足）。 */
export function hasSubtleCrypto(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle === 'object' &&
    crypto.subtle !== null &&
    typeof crypto.subtle.digest === 'function'
  );
}

/** 是否为合法的十六进制摘要串（长度偶数且字符均在 0-9a-f）。 */
export function isHexDigest(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0;
}

/** 按十六进制长度自动匹配算法（无匹配返回 null）。 */
export function algoByHexLength(hex: string): HashAlgo | null {
  const length = hex.length;
  for (const algo of HASH_ALGOS) {
    if (HASH_HEX_LENGTH[algo] === length) {
      return algo;
    }
  }
  return null;
}

/**
 * 计算一份数据的全部摘要。
 *
 * MD5 为同步自实现（先出结果），SHA 系列逐个 `await`，
 * 通过 `onAlgo` 增量回调可以让 UI 边算边显示（避免大文件场景长时间空白）。
 *
 * @param data 原始字节
 * @param onAlgo 单个算法算完的回调
 */
export async function digestAll(
  data: Uint8Array,
  onAlgo?: (algo: HashAlgo, digest: string) => void,
): Promise<DigestOutcome> {
  const digests: Partial<Record<HashAlgo, string>> = {};
  let error: string | null = null;

  try {
    const digest = md5Bytes(data);
    digests.MD5 = digest;
    onAlgo?.('MD5', digest);
  } catch (cause: unknown) {
    error = `MD5 计算失败：${errorMessage(cause)}`;
  }

  if (!hasSubtleCrypto()) {
    return {
      digests,
      error: error ?? '当前环境不支持 Web Crypto（需安全上下文），SHA 系列不可用',
    };
  }

  const subtleAlgos: readonly HashAlgo[] = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];
  for (const algo of subtleAlgos) {
    try {
      // TS 5.7+ 把 Uint8Array 泛化为 Uint8Array<ArrayBufferLike>，与 DOM 的
      // BufferSource(= ArrayBufferView<ArrayBuffer>) 不兼容；运行时 Uint8Array 本就是合法的
      // BufferSource，此处仅做类型收敛（不拷贝、不改变语义）。
      const buffer = await crypto.subtle.digest(algo, data as unknown as BufferSource);
      const digest = toHex(buffer);
      digests[algo] = digest;
      onAlgo?.(algo, digest);
    } catch (cause: unknown) {
      error = `${algo} 计算失败：${errorMessage(cause)}`;
    }
  }

  return { digests, error };
}

/** 读取单个 Blob 分片为 ArrayBuffer（FileReader Promise 封装）。 */
function readSliceAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      const result: unknown = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(result);
        return;
      }
      reject(new Error('文件读取结果类型异常'));
    };
    reader.onerror = (): void => {
      reject(reader.error ?? new Error('文件读取失败'));
    };
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * 分片读取文件为完整字节数组。
 *
 * 每片 2MB 读取一次，片间让出一次事件循环 —— 大文件不会卡死 UI，
 * 且 `onProgress` 反映的是**真实读取进度**（不是假动画）。
 *
 * 注意：Web Crypto 无法增量 digest，因此读取完成后仍是一次性 digest；
 * 分片的价值在于「不卡 UI + 真实进度」。
 *
 * @param file 目标文件
 * @param onProgress 分片读取进度回调
 * @param shouldAbort 中止判定（返回 true 立即停止并抛 AbortError）
 */
export async function readFileInChunks(
  file: File,
  onProgress?: (progress: FileReadProgress) => void,
  shouldAbort?: () => boolean,
): Promise<Uint8Array> {
  const total = file.size;
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  onProgress?.({ loaded: 0, total });

  for (let offset = 0; offset < total; offset += HASH_FILE_CHUNK_SIZE) {
    if (shouldAbort?.() === true) {
      throw new DOMException('文件读取已取消', 'AbortError');
    }
    const end = Math.min(offset + HASH_FILE_CHUNK_SIZE, total);
    const buffer = await readSliceAsArrayBuffer(file.slice(offset, end));
    chunks.push(new Uint8Array(buffer));
    loaded += buffer.byteLength;
    onProgress?.({ loaded, total });
    // 让出主线程一次，保证进度条可刷新、界面可响应
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
  }

  if (shouldAbort?.() === true) {
    throw new DOMException('文件读取已取消', 'AbortError');
  }

  const merged = new Uint8Array(loaded);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }
  return merged;
}

/** 把摘要结果渲染为可下载的 .txt 文本（含来源说明头）。 */
export function digestsToText(
  digests: Partial<Record<HashAlgo, string>>,
  sourceLabel: string,
): string {
  const lines: string[] = [
    '# Toolbox 哈希计算结果',
    `# 来源：${sourceLabel}`,
    `# 时间：${new Date().toLocaleString('zh-CN')}`,
    '',
  ];
  for (const algo of HASH_ALGOS) {
    const digest = digests[algo];
    if (typeof digest === 'string' && digest.length > 0) {
      lines.push(`${algo.padEnd(8, ' ')}${digest}`);
    }
  }
  return lines.join('\n');
}
