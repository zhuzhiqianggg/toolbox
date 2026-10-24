/**
 * `diff` (jsdiff 7.x) 缺少自带类型声明，这里补齐本项目用到的 API 子集。
 *
 * 仅声明所需部分，避免为未使用的能力引入噪音；如后续用到更多 API，按需追加。
 */
declare module 'diff' {
  /** 差异片段（jsdiff Change 对象） */
  export interface Change {
    /** 该片段文本 */
    value: string;
    /** 新增片段 */
    added?: boolean;
    /** 删除片段 */
    removed?: boolean;
    /** 行/词数（diffLines 时可用） */
    count?: number;
  }

  export interface DiffOptions {
    /** 是否将换行符视为独立 token */
    newlineIsToken?: boolean;
    /** 忽略空白差异 */
    ignoreWhitespace?: boolean;
    /** 忽略大小写差异 */
    ignoreCase?: boolean;
    /** 逐片段回调（大输入时用于流式处理） */
    callback?: (change: Change) => void;
  }

  /** 逐字符差异 */
  export function diffChars(oldStr: string, newStr: string, options?: DiffOptions): Change[];
  /** 逐词差异 */
  export function diffWords(oldStr: string, newStr: string, options?: DiffOptions): Change[];
  /** 逐行差异 */
  export function diffLines(oldStr: string, newStr: string, options?: DiffOptions): Change[];
}
