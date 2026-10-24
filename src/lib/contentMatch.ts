// 用相对路径而非 `@/lib/detect`：本文件要被 `scripts/regression/test-detect.mjs` 直接 import
// （靠 Node ≥ 22.18 的原生类型剥离跑源码），Node 既不认识 vite 的路径别名，
// 也不做扩展名补全 —— 所以写成带 `.ts` 的显式路径（tsconfig 已开 allowImportingTsExtensions）。
import { detectContent, type DetectKind } from './detect.ts';

/**
 * 内容识别与「内容类型 → 工具箱命令」直达映射（原 clipboard 模块，现提取为共享工具）。
 *
 * 复用 `@/lib/detect` 的内置识别启发式（JSON / JWT / URL / 时间戳 / Base64），
 * 并把**直达命令映射**修正为本仓库实际注册的命令 id（已核对
 * `src/modules/toolbox/commands/index.ts`，不使用 detect.ts 里的旧映射）：
 *
 *   - JSON      → `json-formatter`（JSON 格式化）
 *   - JWT       → `jwt-decoder`（JWT 解码；该命令为敏感命令，打开不留痕）
 *   - URL       → `qrcode-generator`（链接更适合生成二维码）
 *   - 时间戳    → `timestamp`（时间戳转换）
 *   - 文件路径  → 无直达工具，仅作类型徽章展示
 *
 * 全部为**纯函数**（无副作用、无 IO、无 React 依赖），便于独立测试。
 */

/** 内容形态（用于列表图标 / 展示分支） */
export type ClipContentKind = 'text' | 'file-path' | 'image';

/** 识别结果类型 */
export type ClipMatchType = 'json' | 'jwt' | 'url' | 'timestamp' | 'file-path';

/** 识别结果：类型 + 展示提示 + （可选）一键直达的命令 id */
export interface ClipMatch {
  type: ClipMatchType;
  /** 展示提示（如「格式化 / 校验 JSON」） */
  displayHint?: string;
  /** 直达命令 id（已核对真实注册 id；无合适工具时缺省） */
  suggestedCommandId?: string;
}

/** suggestedCommandId → 工具展示名（推荐动作按钮文案用） */
export const SUGGESTED_COMMAND_NAMES: Record<string, string> = {
  'json-formatter': 'JSON 格式化',
  'jwt-decoder': 'JWT 解码',
  'qrcode-generator': '二维码生成',
  timestamp: '时间戳转换',
};

/** 识别类型 → 直达命令 id（对齐 toolbox 实际注册 id；file-path 无直达工具） */
const COMMAND_BY_TYPE: Partial<Record<ClipMatchType, string>> = {
  json: 'json-formatter',
  jwt: 'jwt-decoder',
  url: 'qrcode-generator',
  timestamp: 'timestamp',
};

/**
 * 是否形似文件路径（Windows 盘符 / UNC / POSIX 绝对路径）。
 * 要求单行、非空、非纯空白；用于把「复制的文件路径」与普通文本区分开。
 */
export function isFilePath(text: string): boolean {
  const value = text.trim();
  if (value.length === 0 || value.includes('\n')) {
    return false;
  }
  // Windows 盘符路径：C:\Users\me\file.txt —— 反斜杠与正斜杠两种写法都合法（`C:/Users/me` 同样可执行）
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return true;
  }
  // UNC 共享路径：\\server\share\file
  if (/^\\\\[^\\\s]+\\/.test(value)) {
    return true;
  }
  // POSIX 绝对路径：/usr/local/bin
  if (value.length > 1 && /^\/[^\s/]*(?:\/[^\s/]+)*\/?$/.test(value)) {
    return true;
  }
  return false;
}

/**
 * 判定内容形态。
 * 优先采用存储的 `kind`（未来图片类），否则按内容启发式判定文件路径，兜底文本。
 */
export function classifyClip(content: string, kind = 'text'): ClipContentKind {
  const k = kind.toLowerCase();
  if (k === 'image' || k === 'images') {
    return 'image';
  }
  if (k === 'file' || k === 'files' || k === 'path' || k === 'file-path') {
    return 'file-path';
  }
  if (isFilePath(content)) {
    return 'file-path';
  }
  return 'text';
}

/**
 * 内容识别（单条最可信结果；无命中返回 null）。
 *
 * 启发式复用 `detect.ts`（JSON / JWT / URL / 时间戳 / Base64），取**首个命中且
 * 存在直达工具**的类型；其后兜底「文件路径」判定。Base64 因无直达工具不作为
 * 推荐动作，仅不参与直达。
 */
export function matchClipContent(text: string): ClipMatch | null {
  const detections = detectContent(text);
  const hit = detections.find((d) => d.kind in COMMAND_BY_TYPE);
  if (hit) {
    const commandId = COMMAND_BY_TYPE[hit.kind as ClipMatchType];
    if (commandId) {
      return {
        type: hit.kind as ClipMatchType,
        displayHint: hit.suggestion,
        suggestedCommandId: commandId,
      };
    }
  }
  if (isFilePath(text)) {
    return { type: 'file-path', displayHint: '文件路径' };
  }
  return null;
}

/** 识别类型的展示名（类型徽章用） */
export const MATCH_TYPE_LABELS: Record<ClipMatchType, string> = {
  json: 'JSON',
  jwt: 'JWT',
  url: 'URL',
  timestamp: '时间戳',
  'file-path': '文件路径',
};
