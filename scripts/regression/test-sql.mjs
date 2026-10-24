/**
 * sql.ts 回归：格式化 / 语法检查 / 语法点识别，外加**示例库自洽性**。
 *
 * 为什么这个模块必须锁：
 *
 * 1. `lintSql` 是一堆正则，改一行就可能全线误报或集体失灵 —— 没有回归不敢动；
 * 2. `formatSql` 出过一次「`LEFT JOIN` 被拆成 `LEFT\nJOIN`」的事故，这类破坏
 *    **不动声色地改坏用户的 SQL**，必须钉死；
 * 3. `sqlSamples.ts` 里 27 条示例是给用户照着学的 ——
 *    **示例本身不能有语法错误**，否则「学习指导」变「误人子弟」。这条由本测试守住。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import { formatSql, lintSql, maskSqlLiterals, syntaxPointsOf } from '../../src/lib/sql.ts';
import { SQL_SAMPLE_GROUPS, SQL_SAMPLES_FLAT } from '../../src/modules/toolbox/commands/sqlSamples.ts';

let pass = 0;
let fail = 0;
const bad = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    bad.push(`${name}${extra ? ` → ${extra}` : ''}`);
  }
}

/** 该 SQL 的 error 档问题（数组方便打印原因） */
const errorsOf = (sql) => lintSql(sql).filter((item) => item.level === 'error');
/** 命中的语法点 id 列表 */
const idsOf = (sql) => syntaxPointsOf(sql).map((point) => point.id);

/* ================================================================== *
 * 1) 字面量 / 注释屏蔽
 * ================================================================== */

const masked1 = maskSqlLiterals("select 'a from b' from t").masked;
ok('字符串内容被抹平（不再含 from b）', !masked1.includes('from b'), masked1);
ok('字符串引号本身也被抹平', !masked1.includes("'"), masked1);
ok('字符串之外的 from t 保留', /from\s+t/.test(masked1), masked1);

const masked2 = maskSqlLiterals("select '-- x' from t").masked;
ok("字符串里的 -- 不当注释（from t 仍在）", /from\s+t/.test(masked2), masked2);

const masked3 = maskSqlLiterals('select 1 -- join b on x').masked;
ok('行注释被抹平', !/join/i.test(masked3), masked3);

const masked4 = maskSqlLiterals('select 1 /* join b on x */ from t').masked;
ok('块注释被抹平', !/join/i.test(masked4), masked4);

const masked5 = maskSqlLiterals('select 1 from `order` where `order`.id = 1').masked;
ok('反引号标识符内容保留（否则 join `t` 检测不出来）', /`order`/.test(masked5), masked5);

ok('未闭合单引号被识别', maskSqlLiterals("select 'abc").unterminated.length === 1);
ok('未闭合块注释被识别', maskSqlLiterals('select 1 /* abc').unterminated.length === 1);
ok('正常字符串不误报未闭合', maskSqlLiterals("select 'a''b'").unterminated.length === 0);
ok(
  '屏蔽结果与原文等长（行号才能一一对应）',
  maskSqlLiterals("select 'abc'\nfrom t").masked.length === "select 'abc'\nfrom t".length,
);
ok(
  '屏蔽后换行位置不变',
  maskSqlLiterals("select 'a\nb'").masked.split('\n').length === 2,
);

// ⚠️ V22 误报根因：抹平用的填充符若为**空格**，`select a, 'x' from t` 会被
//    屏蔽成 `select a,    from t`，尾随逗号规则「隔空」看到 from → 误报。
ok(
  '屏蔽不会制造「隔空相邻」的假象',
  !/,\s*(?=from\b|\)|;|$)/i.test(maskSqlLiterals("select a, 'x' from t").masked),
  JSON.stringify(maskSqlLiterals("select a, 'x' from t").masked),
);
ok(
  '填充符不是空白符（否则 trim/\\s* 会穿透）',
  maskSqlLiterals("select 'x'").masked.includes('\u0000'),
  JSON.stringify(maskSqlLiterals("select 'x'").masked),
);

/* ================================================================== *
 * 2) 语法检查：13 条规则逐一验证
 * ================================================================== */

// 干净的 SQL 必须一条问题都不报（单语句，不含末尾分号也无所谓）
const clean = 'select id, name from users where status = 1 order by id limit 10';
ok('干净 SQL 零问题', lintSql(clean).length === 0, JSON.stringify(lintSql(clean)));

const ruleCases = [
  ['未闭合字符串', "select id from t where name = 'abc", 'error'],
  ['未闭合块注释', 'select id from t /* 说明', 'error'],
  ['左括号未闭合', 'select count(id from t', 'error'],
  ['多一个右括号', 'select id from t where (a = 1))', 'error'],
  ['= NULL 比较', 'select id from t where deleted_at = null', 'warn'],
  ['!= NULL 比较', 'select id from t where deleted_at != null', 'warn'],
  ['相等写成 ==', 'select id from t where a == 1', 'error'],
  ['尾随逗号', 'select id, name, from t', 'error'],
  ['SELECT 与 FROM 之间没字段', 'select from t', 'error'],
  ['FROM 后没有表名', 'select id from', 'error'],
  ['WHERE 后没有条件', 'select id from t where', 'error'],
  ['DELETE 无 WHERE', 'delete from users', 'warn'],
  ['UPDATE 无 WHERE', 'update users set status = 2', 'warn'],
  ['JOIN 缺 ON', 'select u.id from users u join orders o', 'warn'],
  ['SELECT *', 'select * from users', 'info'],
  ['关键字拼错 form', 'select * form users', 'warn'],
  ['大小写混用', 'SELECT id from users union all select id from t', 'info'],
  ['逗号后紧跟右括号（真尾随逗号）', 'select count(a, b,) from t', 'error'],
  ['多语句末条缺分号', 'select 1 as a; select 2 as b; select 3 as c', 'warn'],
  ['末条以字符串收尾且缺分号', "select 1 as a; select 2 as b; select 'x'", 'warn'],
];

for (const [name, sql, level] of ruleCases) {
  const issues = lintSql(sql);
  const hit = issues.some((item) => item.level === level);
  ok(`规则命中 · ${name}`, hit, `期望出现 ${level} 档，实得 ${JSON.stringify(issues)}`);
}

// 反例：不该误报的
const noReport = [
  ['正常字符串', "select id from t where name = 'abc'"],
  ['字符串里含 FROM', "select id from t where name = 'from here'"],
  ['注释里含 JOIN 无 ON', 'select id from t -- join b'],
  ['NULL 用 IS 判断', 'select id from t where a is null'],
  ['DELETE 带 WHERE', 'select 1 from dual; delete from users where id = 1'],
  ['反引号表名 + ON', 'select a.id from `a` join `b` on `b`.id = a.id'],
  ['USING 代替 ON', 'select a.id from a join b using (id)'],
  ['UNION ALL 合并', 'select id from a union all select id from b'],
  ['子查询带别名', 'select t.id from (select id from users) t where t.id = 1'],
  ['单语句无分号', 'select id from users where id = 1'],
  // ⚠️ 这一组钉的是 V22 真抓到的误报：字面量被抹成**空格**时，
  //    `in ('a', 'b')` 会变成 `in (   ,   ,   )`，被「尾随逗号」规则误判成多写了一个逗号。
  ['IN 列表里的字符串', "select id from t where city in ('成都', '重庆', '西安')"],
  ['末列是字符串 + FROM', "select a, 'x' from t"],
  ['字符串在语句末尾', "select a, 'x'"],
  ['函数参数含字符串与括号', "select round((a + b) / 2, 2) as avg_v from t"],
  ['多语句末尾是注释', 'select 1 as a; select 2 as b; select 3 as c; -- 结束'],
  ['末条语句以字符串收尾但带分号', "select 1 as a; select 2 as b; select 'x';"],
];
for (const [name, sql] of noReport) {
  const issues = lintSql(sql);
  ok(`不该误报 · ${name}`, issues.length === 0, JSON.stringify(issues));
}

// 行号必须指对第几行
const multiLine = 'select id\nfrom users\nwhere a = null';
const first = lintSql(multiLine)[0];
ok('行号定位正确（= NULL 在第 3 行）', first?.line === 3, JSON.stringify(first));

// 问题列表按行号排序
const sorted = lintSql("select * form users where a == 1\nand b = null");
const lines = sorted.map((item) => item.line);
ok('问题按行号升序', lines.every((line, i) => i === 0 || line >= lines[i - 1]), JSON.stringify(lines));

/* ================================================================== *
 * 3) 语法点识别
 * ================================================================== */

ok('空输入无语法点', syntaxPointsOf('').length === 0);
ok('纯空白无语法点', syntaxPointsOf('   \n  ').length === 0);

ok(
  '基础查询识别 select-basic',
  idsOf('select id from t').includes('select-basic'),
  JSON.stringify(idsOf('select id from t')),
);
ok('未用 JOIN 不报 join', !idsOf('select id from t').includes('join'));
ok(
  'WHERE / ORDER / LIMIT 一起识别',
  JSON.stringify(idsOf('select a from t where b = 1 order by a limit 1')) ===
    JSON.stringify(['select-basic', 'where', 'order-limit']),
  JSON.stringify(idsOf('select a from t where b = 1 order by a limit 1')),
);
ok('窗口函数识别', idsOf('select row_number() over (partition by a) from t').includes('window'));
ok('CTE 识别', idsOf('with c as (select 1) select * from c').includes('cte'));
ok('EXISTS 子查询识别', idsOf('select 1 from t where exists (select 1 from u)').includes('subquery'));
ok('事务识别', idsOf('start transaction; update t set a = 1 where id = 2; commit').includes('tx'));
ok('EXPLAIN 识别', idsOf('explain select id from t').includes('explain'));
// 注意：判据不能依赖「LIKE 后面跟引号」—— 字面量在抹平阶段已被填充符顶掉（V22 修正）
ok(
  "LIKE '张%' 识别为字符串函数",
  idsOf("select id from t where name like '张%'").includes('string-fn'),
  JSON.stringify(idsOf("select id from t where name like '张%'")),
);
ok('CONCAT 识别为字符串函数', idsOf('select concat(a, b) from t').includes('string-fn'));
ok('权限识别', idsOf("grant select on db.* to 'u'@'%'").includes('grant'));
ok(
  '注释里的关键词不算数',
  !idsOf('select id from t /* join b on c */').includes('join'),
  JSON.stringify(idsOf('select id from t /* join b on c */')),
);
ok(
  '字符串里的关键词不算数',
  !idsOf("select 'join b on c' as x from t").includes('join'),
  JSON.stringify(idsOf("select 'join b on c' as x from t")),
);
ok(
  '每个语法点都带 id / name / detail',
  syntaxPointsOf('select a from t where b = 1').every(
    (point) => point.id.length > 0 && point.name.length > 0 && point.detail.length > 0,
  ),
);

/* ================================================================== *
 * 4) 格式化（这里钉死的是历史上真出过的事故）
 * ================================================================== */

ok('空输入返回空串', formatSql('   \n  ', false, 2) === '');
ok(
  '子句换行 + 缩进',
  formatSql('select a,b from t where x=1', false, 2) === 'select a,b\n  from t\n  where x=1',
  JSON.stringify(formatSql('select a,b from t where x=1', false, 2)),
);
ok(
  '缩进 0 时不加空格',
  formatSql('select a from t', false, 0) === 'select a\nfrom t',
  JSON.stringify(formatSql('select a from t', false, 0)),
);

// ⚠️ 历史事故：LEFT JOIN 曾被拆成 `LEFT` + 换行 + `JOIN`
const leftJoin = formatSql('select * from a left join b on a.id = b.id', false, 2);
ok('LEFT JOIN 不被拆开', !/\bLEFT\s*\n/i.test(leftJoin), JSON.stringify(leftJoin));
ok('LEFT JOIN 保持完整（小写开关关闭时）', /left join b/.test(leftJoin), JSON.stringify(leftJoin));
ok('LEFT JOIN 的 ON 正确换行', /\n\s*on a\.id = b\.id/.test(leftJoin), JSON.stringify(leftJoin));

const innerJoin = formatSql('select * from a inner join b on a.id = b.id', false, 2);
ok('INNER JOIN 不被拆开', /inner join b/.test(innerJoin), JSON.stringify(innerJoin));
ok('INNER JOIN 的 ON 正确换行', /\n\s*on a\.id = b\.id/.test(innerJoin), JSON.stringify(innerJoin));

const unionAll = formatSql('select id from a union all select id from b', false, 2);
ok('UNION ALL 整体成行', /\n\s*union all\b/i.test(unionAll), JSON.stringify(unionAll));
ok('UNION ALL 不被 UNION 抢先拆开', !/\bunion\s*\n\s*all\b/i.test(unionAll), JSON.stringify(unionAll));

// ⚠️ 历史事故：字符串 / 反引号 / 注释内容被格式化改坏
const literal = formatSql("select * from t where name = 'from here'", false, 2);
ok('字符串字面量原样保留', literal.includes("'from here'"), JSON.stringify(literal));
ok('字符串里的 from 不触发换行', !/from here/.test(literal.replace("'from here'", '')), JSON.stringify(literal));

const backtick = formatSql('select `a`.`b` from `t`', false, 2);
ok('反引号标识符原样保留', backtick.includes('`a`.`b`') && backtick.includes('`t`'), JSON.stringify(backtick));

const comment = formatSql('select 1 -- keep me\nfrom t', false, 2);
ok('行注释内容保留', comment.includes('-- keep me'), JSON.stringify(comment));
ok('行注释不吞掉后面的语句（仍是 2 行）', comment.split('\n').length === 2, JSON.stringify(comment));

// 大写开关
const upper = formatSql('select a from t where a = 1', true, 2);
ok('大写开关开启后关键字全大写', upper === 'SELECT a\n  FROM t\n  WHERE a = 1', JSON.stringify(upper));
ok('大写开关开启后表名/列名不动', upper.includes('SELECT a'), JSON.stringify(upper));
ok(
  '大写开关关闭时不强行大写',
  !formatSql('select a from t', false, 2).includes('FROM'),
  JSON.stringify(formatSql('select a from t', false, 2)),
);

// 格式化产物再跑检查不应引入 error（幂等 + 不破坏语法）
for (const sql of [
  'select u.id, count(o.id) as c from users u left join orders o on o.user_id = u.id where o.status <> "canceled" group by u.id having count(o.id) > 3 order by c desc',
  "insert into audit_log (id, action) values (1, 'login'), (2, 'export')",
  'update users set status = 2 where id = 1',
]) {
  const formatted = formatSql(sql, true, 2);
  ok(`格式化不引入语法错误 · ${sql.slice(0, 36)}…`, errorsOf(formatted).length === 0, JSON.stringify(errorsOf(formatted)));
  ok(`格式化幂等 · ${sql.slice(0, 36)}…`, formatSql(formatted, true, 2) === formatted);
}

/* ================================================================== *
 * 5) 示例库自洽性（「学习指导」不能误人子弟）
 * ================================================================== */

ok('示例分组数量 ≥ 8', SQL_SAMPLE_GROUPS.length >= 8, String(SQL_SAMPLE_GROUPS.length));
ok('示例总数 ≥ 20', SQL_SAMPLES_FLAT.length >= 20, String(SQL_SAMPLES_FLAT.length));

const LEVELS = new Set(['基础', '进阶', '运维', '数据变更', '结构']);
const sampleIds = SQL_SAMPLES_FLAT.map((sample) => sample.id);
ok('示例 id 全局唯一', new Set(sampleIds).size === sampleIds.length, JSON.stringify(sampleIds));
ok(
  '分组 id 唯一',
  new Set(SQL_SAMPLE_GROUPS.map((group) => group.id)).size === SQL_SAMPLE_GROUPS.length,
);

for (const group of SQL_SAMPLE_GROUPS) {
  ok(`分组「${group.name}」有说明`, typeof group.blurb === 'string' && group.blurb.length > 0);
  ok(`分组「${group.name}」非空`, group.samples.length > 0);
}

for (const sample of SQL_SAMPLES_FLAT) {
  ok(`示例「${sample.title}」难度合法`, LEVELS.has(sample.level), sample.level);
  ok(`示例「${sample.title}」有 takeaway`, sample.takeaway.length > 0);
  ok(`示例「${sample.title}」至少 2 条讲解`, sample.points.length >= 2, String(sample.points.length));
  ok(
    `示例「${sample.title}」讲解无空条目`,
    sample.points.every((point) => point.length > 0),
  );
  ok(`示例「${sample.title}」SQL 非空`, sample.sql.trim().length > 0);
  // 核心承诺：示例本身没有语法错误
  ok(`示例「${sample.title}」无语法错误`, errorsOf(sample.sql).length === 0, JSON.stringify(errorsOf(sample.sql)));
  // 核心承诺：语法藏在示例里 —— 每条示例至少能识别出一个语法点
  ok(`示例「${sample.title}」可识别语法点`, idsOf(sample.sql).length > 0, JSON.stringify(idsOf(sample.sql)));
  // 示例点下去就填充并格式化，格式化后也不能报错
  ok(
    `示例「${sample.title}」格式化后无语法错误`,
    errorsOf(formatSql(sample.sql, true, 2)).length === 0,
    JSON.stringify(errorsOf(formatSql(sample.sql, true, 2))),
  );
}

console.log([`PASS ${pass}`, `FAIL ${fail}`, ...bad.map((item) => `  ✗ ${item}`)].join('\n'));
process.exit(fail === 0 ? 0 : 1);
