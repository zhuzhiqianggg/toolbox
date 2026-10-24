/**
 * JSON 语法错误行列定位（RFC 8259 校验器的定位用途子集）。
 *
 * 背景：新版 V8/Chromium 的 `JSON.parse` 错误信息**不再包含数字 position**
 * （旧版 `Unexpected token x in JSON at position 123`，新版只给文本片段），
 * 因此在 parse 失败后用本扫描器给出稳定的「第 N 行第 M 列」定位。
 *
 * 使用约束：**仅在 `JSON.parse` 已失败后调用**。若本扫描器返回 `null`
 * （理论上不应发生），调用方须回退展示原始错误信息，不得当作"合法 JSON"。
 */

export interface JsonErrorSpot {
  /** 出错行号（1 起） */
  line: number;
  /** 出错列号（1 起） */
  column: number;
  /** 出错行文本片段（过长时以出错列为中心截断到 ~120 字符） */
  snippet: string;
  /** 失败原因（中文，面向用户） */
  reason: string;
}

const WS = new Set([' ', '\t', '\n', '\r']);
const DIGIT = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
const HEX = new Set([...DIGIT, 'a', 'b', 'c', 'd', 'e', 'f', 'A', 'B', 'C', 'D', 'E', 'F']);
const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

/** 定位 JSON 语法错误；输入合法（或无法定位）返回 null。 */
export function locateJsonError(input: string): JsonErrorSpot | null {
  const len = input.length;
  let line = 1;
  let col = 1;
  let i = 0;

  class SpotError extends Error {
    constructor(readonly spot: JsonErrorSpot) {
      super(spot.reason);
    }
  }

  /**
   * 在当前位置抛出错误（带行/列与该行片段）。
   * `at` 可选：把报错位置挪到**真正的元凶**（如尾随逗号应指向那个逗号，
   * 而不是它后面的 `}`），否则默认用当前扫描位置。
   */
  const fail = (
    reason: string,
    at?: { line: number; column: number; index: number },
  ): never => {
    const idx = at ? at.index : i;
    const errLine = at ? at.line : line;
    const errCol = at ? at.column : col;
    const lineStart = input.lastIndexOf('\n', Math.max(0, idx - 1)) + 1;
    let lineEnd = input.indexOf('\n', idx);
    if (lineEnd === -1) {
      lineEnd = len;
    }
    let snippet = input.slice(lineStart, lineEnd);
    if (snippet.length > 120) {
      const center = idx - lineStart;
      const from = Math.max(0, center - 60);
      snippet = (from > 0 ? '…' : '') + snippet.slice(from, from + 118) + '…';
    }
    throw new SpotError({ line: errLine, column: errCol, snippet, reason });
  };

  /** 前进一个字符并维护行列号。 */
  const next = (): void => {
    if (input.charAt(i) === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    i += 1;
  };

  const skipWs = (): void => {
    while (i < len && WS.has(input.charAt(i))) {
      next();
    }
  };

  const expectWord = (word: string): void => {
    for (const c of word) {
      if (input.charAt(i) !== c) {
        fail(`无效字面量：此处应为 ${word}`);
      }
      next();
    }
  };

  const parseString = (): void => {
    next(); // 消费开引号
    for (;;) {
      if (i >= len) {
        fail('字符串未闭合（缺少结束引号 "）');
      }
      const ch = input.charAt(i);
      if (ch === '"') {
        next();
        return;
      }
      if (ch === '\\') {
        next();
        const esc = input.charAt(i);
        if (i >= len) {
          fail('转义符 \\ 后缺少字符');
        }
        if (SIMPLE_ESCAPES.has(esc)) {
          next();
          continue;
        }
        if (esc === 'u') {
          next();
          for (let k = 0; k < 4; k += 1) {
            if (i >= len || !HEX.has(input.charAt(i))) {
              fail('\\u 转义需要 4 位十六进制数字');
            }
            next();
          }
          continue;
        }
        fail(`无效的转义字符 \\${esc}`);
      }
      if (ch.charCodeAt(0) < 0x20) {
        fail('字符串中出现未转义的控制字符');
      }
      next();
    }
  };

  const parseNumber = (): void => {
    if (input.charAt(i) === '-') {
      next();
    }
    if (i >= len || !DIGIT.has(input.charAt(i))) {
      fail('数字格式无效');
    }
    if (input.charAt(i) === '0') {
      next();
    } else {
      while (i < len && DIGIT.has(input.charAt(i))) {
        next();
      }
    }
    if (input.charAt(i) === '.') {
      next();
      if (i >= len || !DIGIT.has(input.charAt(i))) {
        fail('小数点后缺少数字');
      }
      while (i < len && DIGIT.has(input.charAt(i))) {
        next();
      }
    }
    const exp = input.charAt(i);
    if (exp === 'e' || exp === 'E') {
      next();
      const sign = input.charAt(i);
      if (sign === '+' || sign === '-') {
        next();
      }
      if (i >= len || !DIGIT.has(input.charAt(i))) {
        fail('指数部分缺少数字');
      }
      while (i < len && DIGIT.has(input.charAt(i))) {
        next();
      }
    }
  };

  const parseValue = (): void => {
    skipWs();
    if (i >= len) {
      fail('意外的结尾：此处缺少 JSON 值');
    }
    const ch = input.charAt(i);
    // 这些符号只能出现在值的位置之外，说明「这里本该有个值却没有」。
    // 不单独判的话会掉进 parseNumber 报「数字格式无效」，对用户是误导。
    if (ch === '}' || ch === ']' || ch === ',' || ch === ':') {
      fail(`此处缺少 JSON 值（不应出现 ${ch}）`);
    }
    if (ch === '{') {
      next();
      skipWs();
      if (i >= len) {
        fail('对象未闭合（缺少 }）');
      }
      if (input.charAt(i) === '}') {
        next();
        return;
      }
      for (;;) {
        skipWs();
        if (i >= len) {
          fail('对象未闭合（缺少 }）');
        }
        if (input.charAt(i) !== '"') {
          fail('对象的键必须是双引号字符串');
        }
        parseString();
        skipWs();
        if (i >= len) {
          fail('对象未闭合（缺少 }）');
        }
        if (input.charAt(i) !== ':') {
          fail('键后面缺少冒号 :');
        }
        next();
        parseValue();
        skipWs();
        if (i >= len) {
          fail('对象未闭合（缺少 }）');
        }
        if (input.charAt(i) === ',') {
          const comma = { line, column: col, index: i };
          next();
          skipWs();
          if (i < len && input.charAt(i) === '}') {
            fail('对象的最后一个成员后面多了一个逗号（JSON 不允许尾随逗号）', comma);
          }
          if (i >= len) {
            fail('对象未闭合（缺少 }）');
          }
          continue;
        }
        if (input.charAt(i) === '}') {
          next();
          return;
        }
        fail('对象成员之间应为 , 或以 } 结束');
      }
    }
    if (ch === '[') {
      next();
      skipWs();
      if (i >= len) {
        fail('数组未闭合（缺少 ]）');
      }
      if (input.charAt(i) === ']') {
        next();
        return;
      }
      for (;;) {
        parseValue();
        skipWs();
        if (i >= len) {
          fail('数组未闭合（缺少 ]）');
        }
        if (input.charAt(i) === ',') {
          const comma = { line, column: col, index: i };
          next();
          skipWs();
          if (i < len && input.charAt(i) === ']') {
            fail('数组的最后一个元素后面多了一个逗号（JSON 不允许尾随逗号）', comma);
          }
          if (i >= len) {
            fail('数组未闭合（缺少 ]）');
          }
          continue;
        }
        if (input.charAt(i) === ']') {
          next();
          return;
        }
        fail('数组元素之间应为 , 或以 ] 结束');
      }
    }
    if (ch === '"') {
      parseString();
      return;
    }
    if (ch === 't') {
      expectWord('true');
      return;
    }
    if (ch === 'f') {
      expectWord('false');
      return;
    }
    if (ch === 'n') {
      expectWord('null');
      return;
    }
    parseNumber();
  };

  try {
    parseValue();
    skipWs();
    if (i < len) {
      fail('JSON 结束后存在多余内容');
    }
    return null;
  } catch (error: unknown) {
    if (error instanceof SpotError) {
      return error.spot;
    }
    return null;
  }
}
