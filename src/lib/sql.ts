/**
 * SQL 纯逻辑：格式化 / 语法检查 / 语法点识别。
 *
 * # 为什么单独一个模块
 *
 * 这三件事都不依赖 React 与 DOM，抽到 `src/lib` 就能被
 * `scripts/regression/test-sql.mjs` 直接 `import` 后断言（见 PROJECT_STATUS §3 约束 15）。
 * 正则检查器属于「改一行就可能全线误报」的类型，没有回归兜底不敢动。
 *
 * # 设计取舍：**不是** 解析器
 *
 * 真正的 SQL 语法分析要上词法 + 语法分析器（几百 KB 依赖），而本工具是「轻量 + 教学」定位：
 * 目标是**抓住最常见的写法错误并顺带讲清为什么错**，而不是替数据库做校验。
 * 因此规则刻意保守（宁可漏报也不误报），每条都给 `hint` 说人话。
 */

/* ------------------------------------------------------------------ *
 * 一、公共类型
 * ------------------------------------------------------------------ */

export type SqlIssueLevel =
  /** 基本一定会被数据库拒（或语义完全不成立） */
  | 'error'
  /** 能跑但很可能是写错了 / 有风险 */
  | 'warn'
  /** 能给更好的写法（学习提示） */
  | 'info';

export interface SqlIssue {
  level: SqlIssueLevel;
  /** 行号（1 起） */
  line: number;
  /** 出了什么问题 */
  message: string;
  /** 怎么改 + 为什么（教学部分） */
  hint: string;
}

export interface SqlSyntaxPoint {
  /** 稳定 id（列表 key 用） */
  id: string;
  /** 语法名，如「窗口函数」 */
  name: string;
  /** 一句话讲清它干什么 + 长什么样 */
  detail: string;
}

/* ------------------------------------------------------------------ *
 * 二、屏蔽字面量与注释
 * ------------------------------------------------------------------ */

/** 扫描过程中发现的「没闭合」问题 */
interface Unterminated {
  kind: 'string' | 'blockComment';
  offset: number;
  /** 未闭合的引号字符 */
  char: string;
}

interface ScanResult {
  /**
   * 与原文**等长**的副本：字符串内容与注释全部替换成 [`MASK_FILLER`]（换行保留）。
   * 这样后续的括号配对 / 关键字检查就不会被注释里的 `(` 或字符串里的 `--` 带偏，
   * 而行号仍然一一对应。
   */
  masked: string;
  unterminated: Unterminated[];
}

/**
 * 抹平用的填充字符。
 *
 * **不能用空格**（V22 踩过的坑）：`in ('a', 'b')` 若抹成 `in (      ,      ,      )`，
 * 「逗号后面直接跟子句关键字 / 右括号」这条规则就会把逗号后面那一串空格当成
 * 「最后一项多了个逗号」，于是**合法 SQL 被报错**。用一个既不是空白、也不是单词字符的
 * 填充符，`\,` 后面就不会「隔空」看到 `)` 或 `from`，而 `\b` 词边界依然成立。
 */
const MASK_FILLER = '\u0000';

/** 判断一段文本是否「全是填充符与空白」（去掉遮蔽内容后什么都没有） */
function isMaskBlank(text: string): boolean {
  return text.replace(/[\s\u0000]/g, '').length === 0;
}

/**
 * 把字符串字面量与注释「抹平」。
 *
 * 支持：`'...'`（含 `''` 双写转义与 `\'` 反斜杠转义）、`"..."`、`` `...` ``、
 * `-- 行注释`、`# 行注释`（MySQL）、`/* 块注释 *​/`。
 */
export function maskSqlLiterals(sql: string): ScanResult {
  const length: number = sql.length;
  const out: string[] = [];
  const unterminated: Unterminated[] = [];

  const put = (index: number): void => {
    out[index] = sql.charAt(index) === '\n' ? '\n' : MASK_FILLER;
  };

  let i = 0;
  while (i < length) {
    const c: string = sql.charAt(i);
    const next: string = sql.charAt(i + 1);

    // 行注释：-- 与 #
    if ((c === '-' && next === '-') || c === '#') {
      while (i < length && sql.charAt(i) !== '\n') {
        put(i);
        i += 1;
      }
      continue;
    }

    // 块注释
    if (c === '/' && next === '*') {
      const start: number = i;
      put(i);
      put(i + 1);
      i += 2;
      let closed = false;
      while (i < length) {
        if (sql.charAt(i) === '*' && sql.charAt(i + 1) === '/') {
          put(i);
          put(i + 1);
          i += 2;
          closed = true;
          break;
        }
        put(i);
        i += 1;
      }
      if (!closed) {
        unterminated.push({ kind: 'blockComment', offset: start, char: '*' });
      }
      continue;
    }

    // 字符串字面量
    if (c === "'" || c === '"' || c === '`') {
      const quote: string = c;
      const start: number = i;
      // 反引号包的是**标识符**（表名 / 列名），内容要留着 —— 抹掉会让 `join \`orders\`` 检测不出来。
      // 单双引号是真正的字面量，内容一律抹平。
      const blank: boolean = quote !== '`';
      const putIn = (index: number): void => {
        if (blank) {
          put(index);
        } else {
          out[index] = sql.charAt(index);
        }
      };
      putIn(i);
      i += 1;
      let closed = false;
      while (i < length) {
        const cur: string = sql.charAt(i);
        // 反斜杠转义（MySQL 风格；反引号里没有转义）
        if (cur === '\\' && quote !== '`') {
          putIn(i);
          putIn(i + 1);
          i += 2;
          continue;
        }
        if (cur === quote) {
          // 双写转义（'' 表示一个单引号）
          if (quote !== '`' && sql.charAt(i + 1) === quote) {
            putIn(i);
            putIn(i + 1);
            i += 2;
            continue;
          }
          putIn(i);
          i += 1;
          closed = true;
          break;
        }
        putIn(i);
        i += 1;
      }
      if (!closed) {
        unterminated.push({ kind: 'string', offset: start, char: quote });
      }
      continue;
    }

    out[i] = c;
    i += 1;
  }

  return { masked: out.join(''), unterminated };
}

/* ------------------------------------------------------------------ *
 * 三、语法检查
 * ------------------------------------------------------------------ */

/** 偏移量 → 行号（1 起） */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charAt(i) === '\n') {
      line += 1;
    }
  }
  return line;
}

/** 收集所有匹配（保证带 g，且防御零宽匹配死循环） */
function allMatches(source: string, pattern: RegExp): RegExpExecArray[] {
  const flags: string = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const rx = new RegExp(pattern.source, flags);
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null = rx.exec(source);
  while (m !== null) {
    out.push(m);
    if (m.index === rx.lastIndex) {
      rx.lastIndex += 1;
    }
    m = rx.exec(source);
  }
  return out;
}

/**
 * 常见拼写错误表。
 *
 * 只收录「一眼能看出是打错关键字」的词：`form`（FROM）、`selet`、`wheer` 这类。
 * 刻意**不**收 `oder`（可能是 order 也可能是列名的一部分），避免误报。
 */
const TYPOS: ReadonlyArray<{ wrong: string; right: string }> = [
  { wrong: 'form', right: 'FROM' },
  { wrong: 'selct', right: 'SELECT' },
  { wrong: 'selet', right: 'SELECT' },
  { wrong: 'selcet', right: 'SELECT' },
  { wrong: 'slect', right: 'SELECT' },
  { wrong: 'wheer', right: 'WHERE' },
  { wrong: 'whre', right: 'WHERE' },
  { wrong: 'gropu', right: 'GROUP' },
  { wrong: 'gorup', right: 'GROUP' },
  { wrong: 'havign', right: 'HAVING' },
  { wrong: 'jojn', right: 'JOIN' },
  { wrong: 'updtae', right: 'UPDATE' },
  { wrong: 'upadte', right: 'UPDATE' },
  { wrong: 'delte', right: 'DELETE' },
  { wrong: 'inser', right: 'INSERT' },
  { wrong: 'inset into', right: 'INSERT INTO' },
  { wrong: 'distint', right: 'DISTINCT' },
  { wrong: 'distanct', right: 'DISTINCT' },
];

/**
 * 检查一段 SQL，返回按行号排序的问题列表。
 *
 * @param sql 原始 SQL 文本
 */
export function lintSql(sql: string): SqlIssue[] {
  const issues: SqlIssue[] = [];
  const push = (level: SqlIssueLevel, offset: number, message: string, hint: string): void => {
    issues.push({ level, line: lineOf(sql, offset), message, hint });
  };

  const { masked, unterminated } = maskSqlLiterals(sql);

  // —— 1) 字面量 / 注释没闭合 ——
  for (const item of unterminated) {
    if (item.kind === 'string') {
      push(
        'error',
        item.offset,
        `第 ${lineOf(sql, item.offset)} 行的 ${item.char} 引号没有闭合`,
        `字符串要用成对的 ${item.char} 包起来。如果字符串里本来就有 ${item.char}，写两遍（''）或用反斜杠（\\'）转义。`,
      );
    } else {
      push(
        'error',
        item.offset,
        '块注释 /* 没有闭合',
        '块注释要用 */ 收尾。少一个 */ 会把后面所有 SQL 都变成注释，整个语句等于没写。',
      );
    }
  }

  // —— 2) 括号配对 ——
  const stack: number[] = [];
  for (let i = 0; i < masked.length; i += 1) {
    const c: string = masked.charAt(i);
    if (c === '(') {
      stack.push(i);
    } else if (c === ')') {
      if (stack.length === 0) {
        push('error', i, '多了一个右括号 )', '这个 ) 找不到对应的 (。常见原因是括号里少写了一段条件又顺手删了左括号。');
      } else {
        stack.pop();
      }
    }
  }
  for (const open of stack) {
    push('error', open, '左括号 ( 没有闭合', '数一数这一层的 ( 与 )：子查询、IN 列表、函数参数都是各算一层。');
  }

  // 括号的问题已经报过，后面的规则看 masked 就够
  const lower: string = masked.toLowerCase();

  // —— 3) NULL 比较 ——
  for (const m of allMatches(masked, /(?:=|!=|<>)\s*null\b/i)) {
    push(
      'warn',
      m.index,
      '不能用 = / != 去比较 NULL',
      'NULL 表示「不知道」，所以 `age = NULL` 的结果是 NULL 而不是 true，永远筛不出数据。要写 `IS NULL` / `IS NOT NULL`。',
    );
  }

  // —— 4) 相等写成 == ——
  for (const m of allMatches(masked, /[^=<>!]==[^=]/)) {
    push('error', m.index, 'SQL 的相等判断是一个 =', '`==` 是 C/Java/JS 的写法；SQL 里写 `=` 即可（`==` 在多数数据库上直接语法报错）。');
  }

  // —— 5) 尾随逗号 ——
  for (const m of allMatches(masked, /,\s*(?=from\b|where\b|group\s+by|order\s+by|having\b|limit\b|\)|;|$)/i)) {
    push(
      'error',
      m.index,
      '逗号后面直接跟了子句关键字（多写了一个逗号）',
      '字段 / 值列表的最后一项后面不要留逗号。写 `select id, name from t`，不要 `select id, name, from t`。',
    );
  }

  // —— 6) SELECT 与 FROM 之间没东西 / FROM 后没表名 ——
  for (const m of allMatches(masked, /select\s+from\b/i)) {
    push('error', m.index, 'SELECT 和 FROM 之间没有字段', 'SELECT 后面要列出字段（或 `*`），例如 `select id, name from users`。');
  }
  for (const m of allMatches(masked, /\bfrom\s*(?=where\b|group\s+by|order\s+by|having\b|limit\b|;|$)/i)) {
    push('error', m.index, 'FROM 后面没有表名', 'FROM 后面必须跟表名（或子查询 / 视图名），例如 `from users u`。');
  }

  // —— 7) WHERE 后缺条件 ——
  for (const m of allMatches(masked, /\bwhere\s*(?=group\s+by|order\s+by|having\b|limit\b|;|$)/i)) {
    push('error', m.index, 'WHERE 后面没有条件', 'WHERE 后面要跟筛选条件，例如 `where status = 1`。不需要筛选就把 WHERE 整段删掉。');
  }

  // —— 8) DELETE / UPDATE 没有 WHERE（全表操作） ——
  if (/\bwhere\b/i.test(lower) === false) {
    const del = allMatches(masked, /\bdelete\s+from\b/i);
    for (const m of del) {
      push('warn', m.index, 'DELETE 没有 WHERE，会清空整张表', '真要清空请用 `TRUNCATE TABLE`（更快且不可回滚）；只删部分数据补上 `WHERE`。');
    }
    const upd = allMatches(masked, /\bupdate\s+\S+\s+set\b/i);
    for (const m of upd) {
      push('warn', m.index, 'UPDATE 没有 WHERE，会改到全表每一行', '改一行就先验证 `SELECT` 出唯一的那一行，再把条件原样搬到 UPDATE 的 WHERE 里。');
    }
  }

  // —— 9) JOIN 缺 ON / USING ——
  for (const m of allMatches(masked, /\bjoin\s+[`"\w.]+/gi)) {
    // 取 JOIN 起到下一个子句关键字为止的片段
    const rest: string = masked.slice(m.index);
    const nextClause: number = rest.search(/\b(?:join|where|group\s+by|order\s+by|having|limit|union|;)\b/i);
    const segment: string = nextClause > 0 ? rest.slice(0, nextClause) : rest;
    if (!/\bon\b|\busing\s*\(/i.test(segment)) {
      push(
        'warn',
        m.index,
        'JOIN 没写 ON / USING（变成笛卡尔积）',
        'JOIN 必须说明「按什么相等」：`join orders o on o.user_id = u.id`；两表同名字段可用 `using (user_id)`。',
      );
    }
  }

  // —— 10) SELECT * ——
  for (const m of allMatches(masked, /select\s+(?:distinct\s+)?\*/i)) {
    push('info', m.index, 'SELECT * 取回了全部字段', '临时排查用它很方便；写进代码建议显式列字段 —— 表加列时 `SELECT *` 会悄悄改变返回结构，且通常拖慢查询（用不上覆盖索引）。');
  }

  // —— 11) 疑似拼写错误 ——
  // 定级 warn 而不是 error：`form` 这类词也可能是合法的列名 / 表名，只提示不拍板
  for (const { wrong, right } of TYPOS) {
    for (const m of allMatches(masked, new RegExp(`\\b${wrong.replace(/\s+/g, '\\s+')}\\b`, 'gi'))) {
      push('warn', m.index, `疑似把 ${right} 写成了「${m[0]}」`, `SQL 关键字拼错一般会直接报语法错误。检查是不是 ${right}。`);
    }
  }

  // —— 12) 关键字大小写混用 ——
  const hasUpper: boolean = /\bSELECT\b/.test(masked);
  const hasLower: boolean = /\bselect\b/.test(masked);
  if (hasUpper && hasLower) {
    push('info', 0, 'SELECT 关键字大小写混用', '大小写本身不影响执行，但一致才读得舒服。多数团队用全大写关键字 + 小写标识符。');
  }

  // —— 13) 多语句缺分号 ——
  const parts: string[] = masked.split(';');
  // 末段不能用 trim() 判空：注释 / 字符串被抹成了填充符，trim 去不掉
  const trailing: string = parts.length > 1 ? parts[parts.length - 1]! : '';
  if (parts.length > 2 && !isMaskBlank(trailing)) {
    const offset: number = masked.length - trailing.length;
    push('warn', offset, '最后一条语句没有以分号结尾', '多条语句之间用 `;` 分隔，最后一条也建议补上分号，粘贴到客户端时不容易跟下一段黏在一起。');
  }

  return issues.sort((a, b) => a.line - b.line);
}

/* ------------------------------------------------------------------ *
 * 四、语法点识别（边用边学）
 * ------------------------------------------------------------------ */

interface PointSpec extends SqlSyntaxPoint {
  /** 命中判据（对抹平后的文本匹配，避免注释里的示例格式误命中） */
  test: RegExp;
}

/**
 * 语法点表。
 *
 * 顺序 = 展示顺序：从最基础的 SELECT 一路排到窗口函数 / DDL / 事务，
 * 用户从上往下读就是一条学习路径。
 */
const POINT_SPECS: ReadonlyArray<PointSpec> = [
  {
    id: 'select-basic',
    name: '基础查询 SELECT / FROM',
    test: /\bselect\b[\s\S]*\bfrom\b/i,
    detail: '`SELECT 字段 FROM 表` 是所有查询的骨架：SELECT 决定「要哪些列」，FROM 决定「从哪张表」。',
  },
  {
    id: 'where',
    name: '条件筛选 WHERE',
    test: /\bwhere\b/i,
    detail: '`WHERE 条件` 在分组之前先过滤掉行。常用谓词：`=` `<` `>` `BETWEEN` `IN` `LIKE` `IS NULL`。',
  },
  {
    id: 'order-limit',
    name: '排序与分页 ORDER BY / LIMIT',
    test: /\border\s+by\b|\blimit\b|\boffset\b/i,
    detail: '`ORDER BY 列 [ASC|DESC]` 决定行的顺序；`LIMIT n OFFSET m` 取第 m 条之后的 n 条（分页）。排序字段建索引才能避免全表排序。',
  },
  {
    id: 'aggregate',
    name: '聚合函数与分组 GROUP BY / HAVING',
    test: /\b(group\s+by|having)\b|\b(count|sum|avg|max|min)\s*\(/i,
    detail: '`COUNT/SUM/AVG/MAX/MIN` 把多行压成一个值；`GROUP BY 列` 指定按哪几列分组；`HAVING` 在分组之后过滤（WHERE 在分组之前）。',
  },
  {
    id: 'join',
    name: '多表连接 JOIN',
    test: /\bjoin\b/i,
    detail: '`A JOIN B ON 条件` 把两表按条件拼起来。`INNER JOIN` 只留匹配上的行；`LEFT JOIN` 保留左表全部行（右表没有的补 NULL）。',
  },
  {
    id: 'subquery',
    name: '子查询',
    test: /\bfrom\s*\(\s*select\b|\bin\s*\(\s*select\b|\bexists\s*\(\s*select\b/i,
    detail: '把一条 SELECT 当成值来用：`IN (SELECT ...)` 做集合判断，`FROM (SELECT ...) t` 当临时表（必须给别名），`EXISTS (SELECT ...)` 判断存在性。',
  },
  {
    id: 'cte',
    name: '公共表表达式 WITH（CTE）',
    test: /\bwith\b[\s\S]*\bas\s*\(/i,
    detail: '`WITH 名字 AS (SELECT ...) SELECT ...` 把复杂查询拆成几步命名好的临时结果，比嵌套子查询好读得多，也便于复用。',
  },
  {
    id: 'window',
    name: '窗口函数 OVER()',
    test: /\bover\s*\(/i,
    detail: '`函数() OVER (PARTITION BY ... ORDER BY ...)` 在「不合并行」的前提下做组内计算，例如排名 `ROW_NUMBER()`、累计 `SUM(...) OVER (...)`。和 GROUP BY 的区别：GROUP BY 会把行压掉，窗口函数不会。',
  },
  {
    id: 'case',
    name: '条件表达式 CASE WHEN',
    test: /\bcase\b[\s\S]*\bwhen\b/i,
    detail: 'SQL 里的 if/else：`CASE WHEN 条件 THEN 值 ... ELSE 兜底 END`，常用于分组打标与把 NULL 变成可读文案。',
  },
  {
    id: 'null-fn',
    name: 'NULL 处理',
    test: /\bis\s+(?:not\s+)?null\b|\bcoalesce\s*\(|\bifnull\s*\(/i,
    detail: '判空必须用 `IS NULL` / `IS NOT NULL`（= NULL 永远不成立）；`COALESCE(a, b)` 取第一个非 NULL 值，`IFNULL(a, 0)` 是 MySQL 的两参版。',
  },
  {
    id: 'union',
    name: '结果集合并 UNION / UNION ALL',
    test: /\bunion\b/i,
    detail: '把两条 SELECT 的结果上下摞起来。`UNION` 会去重（有排序开销），`UNION ALL` 不去重、更快 —— 确定无重复时优先 `UNION ALL`。',
  },
  {
    id: 'distinct',
    name: '去重 DISTINCT',
    test: /\bselect\s+distinct\b/i,
    detail: '`SELECT DISTINCT 列` 返回去重后的值。如果只是为了「去重取一条」，`GROUP BY` 或窗口函数通常更好读。',
  },
  {
    id: 'string-fn',
    name: '字符串函数',
    // 注意不能写成 `\blike\s+'`：字面量在抹平阶段已被填充符顶掉，靠「后面跟引号」判断
    // 反而恒不命中（V22 修正）。
    test: /\bconcat\s*\(|\bsubstring\s*\(|\bsubstr\s*\(|\breplace\s*\(|\btrim\s*\(|\blike\b/i,
    detail: '`CONCAT` 拼接、`SUBSTRING` 截取、`TRIM` 去空白、`LIKE \'a%\'` 模糊匹配（前导 % 会让索引失效）。',
  },
  {
    id: 'date-fn',
    name: '日期函数',
    test: /\bnow\s*\(|\bcurdate\s*\(|\bdate_add\s*\(|\bdate_format\s*\(|\binterval\b|\bdatediff\s*\(/i,
    detail: '`NOW()` 当前时间、`DATE_FORMAT(d, \'%Y-%m-%d\')` 格式化、`DATE_ADD(d, INTERVAL 7 DAY)` 做日期加减。',
  },
  {
    id: 'insert',
    name: '插入 INSERT',
    test: /\binsert\s+into\b/i,
    detail: '`INSERT INTO 表 (列...) VALUES (值...)`，可一次插多组值。生产环境注意：显式列出列名，否则表加列后会错位。',
  },
  {
    id: 'update',
    name: '更新 UPDATE',
    test: /\bupdate\b[\s\S]*\bset\b/i,
    detail: '`UPDATE 表 SET 列 = 值 WHERE 条件`。WHERE 漏写就是全表更新 —— 先用 SELECT 同样的条件验证影响范围。',
  },
  {
    id: 'delete',
    name: '删除 DELETE',
    test: /\bdelete\s+from\b|\btruncate\s+table\b/i,
    detail: '`DELETE FROM 表 WHERE 条件` 逐行删（可回滚、触发触发器）；`TRUNCATE TABLE` 清空整表（快、不可回滚）。',
  },
  {
    id: 'ddl',
    name: '表结构 DDL',
    test: /\bcreate\s+(?:table|view|database|schema)\b|\balter\s+table\b|\bdrop\s+(?:table|view|index)\b/i,
    detail: '`CREATE TABLE` 建表、`ALTER TABLE` 改结构、`DROP` 删除。DDL 在多数数据库里是隐式提交的，改之前先备份或加事务。',
  },
  {
    id: 'index',
    name: '索引 CREATE INDEX',
    test: /\bcreate\s+(?:unique\s+)?index\b/i,
    detail: '`CREATE INDEX 名 ON 表 (列)` 加速等值 / 范围查询。注意「最左前缀」：`(a, b)` 的联合索引能用上 `a`、`a+b`，单查 `b` 用不上。',
  },
  {
    id: 'explain',
    name: '执行计划 EXPLAIN',
    test: /\bexplain\b|\banalyze\b|\bdesc\s+select\b/i,
    detail: '`EXPLAIN 你的SQL` 不真的执行，而是告诉你优化器打算怎么取数：`type`（ALL 全表扫 / ref 索引用上）、`key`（实际用了哪个索引）、`rows`（预估扫多少行）。慢查询第一步就是看它。',
  },
  {
    id: 'tx',
    name: '事务 BEGIN / COMMIT',
    test: /\bbegin\b|\bstart\s+transaction\b|\bcommit\b|\brollback\b/i,
    detail: '`BEGIN` 开启事务 → 若干语句 → `COMMIT` 提交或 `ROLLBACK` 回滚。批量改数据时用它兜底，出问题能整体撤销。',
  },
  {
    id: 'grant',
    name: '权限 GRANT / REVOKE',
    test: /\bgrant\b|\brevoke\b/i,
    detail: '`GRANT 权限 ON 库.表 TO \'用户\'@\'主机\'` 授权，`REVOKE` 收回。生产上按最小权限给，别图省事给 ALL。',
  },
];

/**
 * 识别这段 SQL 用到了哪些语法点（命中顺序 = 学习路径顺序）。
 *
 * 判据是对**抹平后的文本**做关键字匹配，所以注释里的示例不会被算进来。
 */
export function syntaxPointsOf(sql: string): SqlSyntaxPoint[] {
  if (sql.trim().length === 0) {
    return [];
  }
  const { masked } = maskSqlLiterals(sql);
  return POINT_SPECS.filter((spec: PointSpec): boolean => spec.test.test(masked)).map(
    (spec: PointSpec): SqlSyntaxPoint => ({ id: spec.id, name: spec.name, detail: spec.detail }),
  );
}

/* ------------------------------------------------------------------ *
 * 五、格式化
 * ------------------------------------------------------------------ */

/**
 * 主子句关键字（换行 + 缩进）。
 *
 * 注意：**必须单次交替匹配**。早期实现是「一个关键字跑一遍 replace」，
 * 结果 `left join` 先被 `LEFT JOIN` 插了换行、又被后面的 `JOIN` 匹配到中间那个空格，
 * 输出成 `LEFT\n  JOIN` —— 单次交替（长的排前面）能一次性吃掉整段，不会二次拆开。
 */
const CLAUSES: ReadonlyArray<string> = [
  'DELETE FROM',
  'INSERT INTO',
  'INNER JOIN',
  'CROSS JOIN',
  'RIGHT JOIN',
  'UNION ALL',
  'LEFT JOIN',
  'FULL JOIN',
  'GROUP BY',
  'ORDER BY',
  'OFFSET',
  'SELECT',
  'VALUES',
  'UPDATE',
  'HAVING',
  'WHERE',
  'LIMIT',
  'UNION',
  'FROM',
  'JOIN',
  'SET',
  'ON',
];

/** 用于大写化的关键字（含子句与常见谓词 / 函数） */
const KEYWORDS: ReadonlyArray<string> = [
  ...CLAUSES,
  'PARTITION BY',
  'AND',
  'OR',
  'NOT',
  'IN',
  'EXISTS',
  'BETWEEN',
  'LIKE',
  'AS',
  'DISTINCT',
  'WITH',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'IS',
  'NULL',
  'ASC',
  'DESC',
  'COUNT',
  'SUM',
  'AVG',
  'MAX',
  'MIN',
  'COALESCE',
  'OVER',
];

/** 行注释后的强制换行哨兵（不会出现在正常 SQL 里） */
const NEWLINE_SENTINEL = '\u0001';

interface ProtectedSql {
  /** 字符串 / 注释已换成占位符的副本 */
  text: string;
  /** 把占位符换回原文 */
  restore: (text: string) => string;
}

/**
 * 把字符串字面量与注释整段换成占位符（并给行注释补一个强制换行哨兵）。
 *
 * 为什么格式化前必须先做这一步：
 * - `where name = 'from here'` 里的 `from` 会被子句换行规则当成关键字切开，**改坏了 SQL**；
 * - 注释里的关键字同理；
 * - 而 `-- 注释` 一旦被折叠空白吃掉换行，它会吞掉后面整段语句。
 */
function protectSqlLiterals(sql: string): ProtectedSql {
  const store: string[] = [];
  const mark = (raw: string, kind: 'S' | 'C' | 'L'): string => {
    store.push(raw);
    // 两侧补空格：保证占位符不会跟相邻 token 黏在一起，子句规则才认得出后面的关键字
    return ` \u00A7${kind}${store.length - 1}\u00A7 `;
  };

  let out = '';
  let i = 0;
  const len: number = sql.length;
  while (i < len) {
    const c: string = sql.charAt(i);
    const n: string = sql.charAt(i + 1);

    // 行注释：-- 与 #
    if ((c === '-' && n === '-') || c === '#') {
      let j = i;
      while (j < len && sql.charAt(j) !== '\n') {
        j += 1;
      }
      out += `${mark(sql.slice(i, j), 'L')}${NEWLINE_SENTINEL}`;
      i = j;
      continue;
    }

    // 块注释
    if (c === '/' && n === '*') {
      let j = i + 2;
      while (j < len && !(sql.charAt(j) === '*' && sql.charAt(j + 1) === '/')) {
        j += 1;
      }
      j = Math.min(len, j + 2);
      out += mark(sql.slice(i, j), 'C');
      i = j;
      continue;
    }

    // 字符串 / 标识符
    if (c === "'" || c === '"' || c === '`') {
      const quote: string = c;
      let j = i + 1;
      while (j < len) {
        const cur: string = sql.charAt(j);
        if (cur === '\\' && quote !== '`') {
          j += 2;
          continue;
        }
        if (cur === quote) {
          if (quote !== '`' && sql.charAt(j + 1) === quote) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += mark(sql.slice(i, j), 'S');
      i = j;
      continue;
    }

    out += c;
    i += 1;
  }

  return {
    text: out,
    restore: (text: string): string =>
      text.replace(/\u00A7([SCL])(\d+)\u00A7/g, (_all: string, _kind: string, id: string): string => store[Number(id)] ?? ''),
  };
}

/**
 * 轻量 SQL 美化：主子句换行 + 缩进，可选关键字大写。
 *
 * 启发式实现（**不是**解析器）：对「一条 SELECT / INSERT / UPDATE / DELETE」这种日常语句够用，
 * 复杂嵌套 SQL 不要指望它排版。可保证的一点是**不会改坏内容** ——
 * 字符串、反引号标识符、注释整段被保护，原样还原，只调整它们外面的换行与缩进。
 */
export function formatSql(sql: string, uppercase: boolean, indent: number): string {
  if (sql.trim().length === 0) {
    return '';
  }
  const { text, restore } = protectSqlLiterals(sql);

  // 折叠空白（保留行注释的强制换行哨兵）
  let working: string = text.replace(/[^\S\u0001]+/g, ' ').trim();

  // 子句换行：单次交替匹配，长的子句排前面。
  // 这里**只负责断行**，不改大小写 —— 大小写交给下面的「关键字大写」开关，
  // 否则开关关掉时子句仍被强行大写，开关就名不副实了。
  const alternation: string = [...CLAUSES]
    .sort((a, b) => b.length - a.length)
    .map((clause) => clause.replace(/ /g, '\\s+'))
    .join('|');
  working = working.replace(new RegExp(`\\s+(?:${alternation})\\b`, 'gi'), (matched: string) => `\n${matched.trim()}`);

  // 哨兵 → 真换行
  working = working.replace(/\u0001/g, '\n');

  const lines: string[] = working
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let out: string = lines.map((line, i) => (i === 0 ? line : `${' '.repeat(indent)}${line}`)).join('\n');

  if (uppercase) {
    // 占位符（字符串 / 注释）不含关键字形态，可以整段跑大写正则
    for (const keyword of [...KEYWORDS].sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`\\b${keyword.replace(/ /g, '\\s+')}\\b`, 'gi');
      out = out.replace(re, (m) => m.toUpperCase());
    }
  }

  /**
   * 收尾清理：上面的保护占位符两侧各补了一个空格（为了让子句规则认得出关键字边界），
   * 结果排版上会留下 `'login' )`、`` `u` . `id` `` 这类多余空格。
   * 这里在**还原之前**统一收拾 —— 此刻字符串 / 注释还是占位符，不会被误伤。
   */
  out = out
    .replace(/\s+([,;)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/,\s+/g, ', ')
    .replace(/\s*\.\s*/g, '.');

  return restore(out);
}

