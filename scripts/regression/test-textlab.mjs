/**
 * textlab.ts 回归：文本处理台的全部纯逻辑。
 *
 * 为什么这个模块必须锁：
 *
 * 1. 它是「工具」——用户会把生产日志、配置、清单贴进来，操作**就地改写**。
 *    一个静默的错误（比如把 `a\r` 和 `a` 当成两行、或把行首数字解析错）
 *    用户是看不出来的，只会拿到一份错的输出；
 * 2. 20 个行操作共用同一套「切行 → 处理 → 拼回」管线，
 *    换行风格（`\r\n` / `\r` / `\n`）处理错一次就是全表翻车；
 * 3. 「随机排列」若不注入随机源根本没法断言 —— 这里强制传确定性 rng，
 *    保证断言检查的是「是不是一个排列」而不是「看起来变了」。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import {
  LINE_OPS,
  applyLineOp,
  affixLines,
  compilePattern,
  convertEol,
  countMatches,
  detectEol,
  escapeRegExp,
  extractMatches,
  findMatches,
  formatBytes,
  parseColumnPick,
  pickColumns,
  replaceAll,
  splitLines,
  textStats,
  wrapLines,
} from '../../src/lib/textlab.ts';

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

/** 构造一份查找参数（只覆盖关心的字段） */
const read = (over = {}) => ({
  find: '',
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  dotAll: false,
  multiline: false,
  ...over,
});

/** 用某个行操作处理文本（带默认上下文） */
const run = (text, id, ctx = {}) => applyLineOp(text, id, ctx);

/* ================================================================== *
 * 1) 切行 / 换行风格
 * ================================================================== */

ok('LF 切行', splitLines('a\nb').length === 2);
ok('CRLF 切行（不留 \\r 残留）', splitLines('a\r\nb').join('|') === 'a|b', splitLines('a\r\nb').join('|'));
ok('CR 切行', splitLines('a\rb').join('|') === 'a|b');
ok('空串切出 0 行', splitLines('').length === 0);

ok('detectEol CRLF', detectEol('a\r\nb\r\n') === 'crlf');
ok('detectEol LF', detectEol('a\nb\n') === 'lf');
ok('detectEol 无换行默认 LF', detectEol('abc') === 'lf');
ok('convertEol LF→CRLF', convertEol('a\nb', 'crlf') === 'a\r\nb');
ok('convertEol CRLF→LF', convertEol('a\r\nb', 'lf') === 'a\nb');
ok('convertEol 二次转换幂等', convertEol(convertEol('a\r\nb', 'lf'), 'lf') === 'a\nb');

// ⚠️ 最经典的行处理 bug：切行没吃掉 \r，于是 dedupe 把 `a` 与 `a\r` 当两行
const crlfDedupe = run('a\r\na\r\nb', 'dedupe');
ok('CRLF 文本去重能真正去掉重复行', crlfDedupe.note.includes('删除 1 行'), crlfDedupe.note);
ok('CRLF 文本去重后仍是 CRLF', crlfDedupe.text === 'a\r\nb', JSON.stringify(crlfDedupe.text));

/* ================================================================== *
 * 2) 统计
 * ================================================================== */

// 'hello world\n第二行 abc' = 11 + 1 + 7 = 19 码元；字节 11 + 1 + 9 + 1 + 3 = 25
const st = textStats('hello world\n第二行 abc');
ok('行数', st.lines === 2, String(st.lines));
ok('非空行数', st.nonEmptyLines === 2);
ok('词数', st.words === 4, String(st.words));
ok('字符数', st.chars === 19, String(st.chars));
ok('UTF-8 字节数（中文按 3 字节）', st.bytes === 25, String(st.bytes));
ok('最长行', st.longestLine === 11, String(st.longestLine));

ok('空文本统计为 0', textStats('').lines === 0 && textStats('').bytes === 0);
ok('去重行数', textStats('a\na\nb').uniqueLines === 2);
ok('只有空白的行不算非空行', textStats('a\n   \nb').nonEmptyLines === 2);
ok('formatBytes 边界', formatBytes(0) === '0 B' && formatBytes(1023) === '1023 B');
ok('formatBytes KiB', formatBytes(2048) === '2.0 KiB', formatBytes(2048));

/* ================================================================== *
 * 3) 模式编译 / 查找
 * ================================================================== */

ok('转义函数把点转成字面量', escapeRegExp('a.b') === 'a\\.b', escapeRegExp('a.b'));
ok('空查找内容报错', compilePattern(read({ find: '' })).ok === false);
ok('非法正则有错误信息', compilePattern(read({ find: '(', regex: true })).ok === false);

const literal = findMatches('a.b axb a.b', read({ find: 'a.b' }));
ok('普通模式按字面量（不匹配 axb）', literal.matches.length === 2, String(literal.matches.length));

const ci = findMatches('Error error ERROR', read({ find: 'error' }));
ok('默认不区分大小写', ci.matches.length === 3, String(ci.matches.length));

const cs = findMatches('Error error ERROR', read({ find: 'error', caseSensitive: true }));
ok('区分大小写只命中 1 处', cs.matches.length === 1, String(cs.matches.length));

const ww = findMatches('cat category cat', read({ find: 'cat', wholeWord: true, caseSensitive: true }));
ok('全词匹配不命中 category', ww.matches.length === 2, String(ww.matches.length));

const alt = findMatches('cat dog', read({ find: 'cat|dog', regex: true, wholeWord: true }));
ok('全词 + 交替不会因边界错位漏匹配', alt.matches.length === 2, String(alt.matches.length));

const zero = findMatches('a\nb\nc', read({ find: '^', regex: true, multiline: true }));
ok('零长度匹配（^ 按行）能终止且命中 3 次', zero.matches.length === 3, String(zero.matches.length));

const grouped = findMatches('id=42', read({ find: 'id=(\\d+)', regex: true }));
ok('捕获组被收集', grouped.matches[0]?.groups[0] === '42', JSON.stringify(grouped.matches[0]));

ok('countMatches 与 findMatches 一致', countMatches('aaaa', read({ find: 'a' })) === 4);

const many = findMatches('a'.repeat(50), read({ find: 'a' }), 10);
ok('超限被截断并标记', many.matches.length === 10 && many.truncated === true);

/* ================================================================== *
 * 4) 替换 / 提取
 * ================================================================== */

const rep = replaceAll('a=1 b=2', read({ find: '(\\w)=(\\d)', regex: true, replace: '$2:$1' }));
ok('替换支持捕获组引用', rep.text === '1:a 2:b', rep.text);
ok('替换计数正确', rep.count === 2, String(rep.count));

const repLit = replaceAll('a.b axb', read({ find: 'a.b', replace: 'X' }));
ok('普通模式只换字面量', repLit.text === 'X axb', repLit.text);
ok('普通模式替换里的 $& 仍按 JS 语义', replaceAll('ab', read({ find: 'a', replace: '[$&]' })).text === '[a]b');

ok('无匹配时替换不改文本', replaceAll('abc', read({ find: 'zzz', replace: 'X' })).text === 'abc');

const ex = extractMatches('ip=10.1.1.1 ip=10.1.1.2', read({ find: '\\d+\\.\\d+\\.\\d+\\.\\d+', regex: true }));
ok('提取匹配每行一条', ex.text === '10.1.1.1\n10.1.1.2', JSON.stringify(ex.text));
ok('提取计数', ex.count === 2);

const exGroup = extractMatches('id=1 id=2', read({ find: 'id=(\\d)', regex: true }), 1);
ok('提取指定捕获组', exGroup.text === '1\n2', exGroup.text);

const exUnique = extractMatches('a a b', read({ find: '[ab]', regex: true }), 0, true);
ok('提取去重保序', exUnique.text === 'a\nb', JSON.stringify(exUnique.text));

/* ================================================================== *
 * 5) 行操作表自洽性（新增操作只改一张表，这里兜住）
 * ================================================================== */

const SAMPLE = [
  '  10.1.1.1  ',
  '10.1.1.1',
  '',
  'ERROR upstream timeout',
  'WARN slow query',
  'error upstream timeout',
  '10.1.1.2',
].join('\n');

ok('行操作 id 唯一', new Set(LINE_OPS.map((op) => op.id)).size === LINE_OPS.length);
ok(
  '每个行操作都有提示文案',
  LINE_OPS.every((op) => op.hint.length > 0 && op.label.length > 0),
);
ok(
  '需要模式的操作都标了 needsPattern',
  LINE_OPS.filter((op) => op.needsPattern === true).length === 2,
  String(LINE_OPS.filter((op) => op.needsPattern === true).length),
);

for (const op of LINE_OPS) {
  const ctx = { read: read({ find: 'ERROR', regex: false }) };
  let result = null;
  try {
    result = run(SAMPLE, op.id, ctx);
  } catch (error) {
    ok(`行操作 ${op.id} 不应抛异常`, false, String(error));
    continue;
  }
  ok(`行操作 ${op.id} 有结果或明确失败`, result.ok === true || typeof result.error === 'string');
  ok(`行操作 ${op.id} 失败时原样返回文本`, result.ok === true || result.text === SAMPLE);
}

/* ================================================================== *
 * 6) 行操作语义
 * ================================================================== */

const dup = run('b\na\nb\nb', 'dedupe');
ok('去重保留首次出现的位置', dup.text === 'b\na', JSON.stringify(dup.text));
ok('去重说明含删除行数', dup.note === '删除 2 行重复内容', dup.note);

ok('忽略大小写去重合并 error/ERROR', run('Error\nerror\nError', 'dedupe-ci').text === 'Error');
ok('区分大小写去重不合并', run('Error\nerror\nError', 'dedupe').text === 'Error\nerror');

ok('删空行', run('a\n\n  \nb', 'remove-empty').text === 'a\nb');
ok('去首尾空白', run('  a  \n\tb\t', 'trim').text === 'a\nb');
ok('去行尾空白不动行首', run('  a  \n b ', 'trim-end').text === '  a\n b');

ok('字典序排序（大写在前）', run('b\nA\na', 'sort').text === 'A\na\nb');
ok('降序排序', run('a\nb\nc', 'sort-desc').text === 'c\nb\na');
ok('忽略大小写排序不把大写单独拎前面', run('b\nA', 'sort-ci').text === 'A\nb', run('b\nA', 'sort-ci').text);
ok('逆序', run('a\nb\nc', 'reverse').text === 'c\nb\na');
ok('按长度排序', run('ccc\na\nbb', 'sort-len').text === 'a\nbb\nccc');

// 数值排序：不能用字典序，「10」必须排在「9」之后
ok('按数值排序把 10 排在 9 之后', run('10\n9\n2', 'sort-num').text === '2\n9\n10', run('10\n9\n2', 'sort-num').text);
ok('数值排序取不到数字的行排最后', run('5ms\nabc\n1ms', 'sort-num').text === '1ms\n5ms\nabc');

const fixedRandom = () => 0.42;
const shuffledA = run('a\nb\nc\nd\ne', 'shuffle', { random: fixedRandom });
const shuffledB = run('a\nb\nc\nd\ne', 'shuffle', { random: fixedRandom });
ok('随机排列在固定随机源下可复现', shuffledA.text === shuffledB.text, shuffledA.text);
ok(
  '随机排列不增不减元素',
  shuffledA.text.split('\n').sort().join('') === 'abcde',
  shuffledA.text,
);

ok('加行号', run('a\nb', 'number', { start: 1 }).text === '1 a\n2 b');
ok('加行号可从指定值起', run('a\nb', 'number', { start: 10 }).text === '10 a\n11 b');
ok('行号补零', run('a\nb', 'number', { start: 1, padded: true }).text === '01 a\n02 b');
ok('注释', run('a\nb', 'comment').text === '# a\n# b');
ok('取消注释（# 与 // 都能去）', run('# a\n// b\nc', 'uncomment').text === 'a\nb\nc');
ok('注释→取消注释可往返', run(run('a\nb', 'comment').text, 'uncomment').text === 'a\nb');

ok('合并成一行', run('a\nb\nc', 'join', { delimiter: ',' }).text === 'a,b,c');
ok('合并分隔符为空时回落逗号', run('a\nb', 'join', { delimiter: '' }).text === 'a,b');
ok('按分隔符拆行', run('a,b,c', 'split', { delimiter: ',' }).text === 'a\nb\nc');
ok('拆分时不产生末尾空行', !run('a,b,', 'split', { delimiter: ',' }).text.endsWith('\n'));

const keepLog = run(SAMPLE, 'keep-matching', { read: read({ find: 'error' }) });
ok(
  '只留匹配行（不区分大小写命中 ERROR 与 error；WARN 行被剔除）',
  keepLog.text.split('\n').length === 2 && !/WARN/.test(keepLog.text),
  keepLog.text,
);
const dropLog = run(SAMPLE, 'drop-matching', { read: read({ find: 'error' }) });
ok('删掉匹配行', !/error/i.test(dropLog.text), dropLog.text);

const noPattern = run(SAMPLE, 'keep-matching', { read: read({ find: '' }) });
ok('筛选操作缺模式时明确失败而不是静默', noPattern.ok === false && noPattern.text === SAMPLE);

// 不可见字符：肉眼看不出差别，但会让字符串比较失败
const invisible = run('a\u200Bb\uFEFFc', 'remove-invisible');
ok('清除零宽字符与 BOM', invisible.text === 'abc', JSON.stringify(invisible.text));
ok('清除数写进说明', invisible.note.includes('2'), invisible.note);
ok('没有不可见字符时不谎报', run('abc', 'remove-invisible').note.includes('没有发现'));

/* ================================================================== *
 * 7) 列处理
 * ================================================================== */

ok('parseColumnPick 逗号', parseColumnPick('1,3').join(',') === '1,3');
ok('parseColumnPick 区间', parseColumnPick('2-4').join(',') === '2,3,4');
ok('parseColumnPick 混合去重升序', parseColumnPick('3,1-2,3').join(',') === '1,2,3');
ok('parseColumnPick 忽略非法', parseColumnPick('a,-,0').length === 0, String(parseColumnPick('a,-,0').length));

const tsv = 'a\tb\tc\nd\te\tf';
ok('取单列（Tab 分隔）', pickColumns(tsv, '\t', '2').text === 'b\ne', pickColumns(tsv, '\t', '2').text);
ok('取多列', pickColumns(tsv, '\t', '1,3').text === 'a\tc\nd\tf');
ok('取列区间', pickColumns('1,2,3,4', ',', '2-3').text === '2,3');
ok(
  '取不存在的列给空串（不炸）',
  pickColumns('a,b\nc,d', ',', '2,5').text === 'b,\nd,',
  JSON.stringify(pickColumns('a,b\nc,d', ',', '2,5').text),
);
ok('非法列号表达式明确失败', pickColumns('a,b', ',', 'x').ok === false);
ok('取列保留原换行风格', pickColumns('a\tb\r\nc\td', '\t', '1').text === 'a\r\nc');

/* ================================================================== *
 * 8) 前后缀 / 折行
 * ================================================================== */

ok('前后缀作用到每行', affixLines('a\nb', "'", "',") === "'a',\n'b',", affixLines('a\nb', "'", "',"));
ok('前后缀默认跳过空行', affixLines('a\n\nb', '<', '>') === '<a>\n\n<b>', affixLines('a\n\nb', '<', '>'));
ok('前后缀可要求处理空行', affixLines('a\n\nb', '<', '>', false) === '<a>\n<>\n<b>');
ok('前后缀保留 CRLF', affixLines('a\r\nb', '<', '>') === '<a>\r\n<b>');

// 宽度下限 10：不是故意刁难，而是「折成 2 个字宽」这种输入没有意义，
// 与其产出几百行碎片，不如按 10 兜住
ok('硬折行', wrapLines('a'.repeat(25), 10) === `${'a'.repeat(10)}\n${'a'.repeat(10)}\n${'a'.repeat(5)}`, JSON.stringify(wrapLines('a'.repeat(25), 10)));
ok('折行宽度的下限保护', wrapLines('a'.repeat(7), 1).split('\n').length === 1);
ok('折行不丢内容', wrapLines('abcdefghijklmnopqrstuvw', 7).replace(/\n/g, '') === 'abcdefghijklmnopqrstuvw');
ok('折行保留空行', wrapLines('ab\n\ncd', 10) === 'ab\n\ncd');

/* ================================================================== *
 * 结果
 * ================================================================== */

console.log(`PASS ${pass} / FAIL ${fail}`);
if (bad.length > 0) {
  console.log('--- 失败明细 ---');
  for (const item of bad) {
    console.log('  ✗ ' + item);
  }
}
process.exit(fail === 0 ? 0 : 1);
