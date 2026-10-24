/**
 * jsonUtils.ts 回归（V26 新增）。
 *
 * # 为什么必须锁
 *
 * 这一个文件承担了 JSON 格式化 / JSONPath / 转 CSV / 转 YAML / 转 TypeScript
 * 五条对外承诺，26 KB，此前**一条断言都没有**。它的错误有两种最坏形态：
 *
 *   1. **静默给错类型**：JSON→TS 的「接口名复用」只看键名不看值类型，
 *      于是 `{item:{a:1}}` 与 `{wrap:{item:{a:'s'}}}` 里第二处会复用第一处的
 *      `a: number` —— 生成的类型与数据打架，用户看不出来（本套锁死这条）；
 *   2. **示例描述与实现不符**：V25 已经因为「示例跟实现对不上」被用户投诉过一次，
 *      所以本套顺带把 UI 示例里写死的承诺也纳入断言范围。
 *
 * 锚点来自项目之外：
 *   - **Goessner 的 JSONPath 原始示例数据**（store / book / bicycle），
 *     查询与命中条数按公开教程的语义核对；
 *   - **CSV RFC 4180** 的转义规则（字段含逗号/引号/换行时整体加引号，内部引号翻倍）；
 *   - **YAML 的引号必要性规则**（首字符特殊、含 `: `、与布尔/数字同形时必须加引号）；
 *   - TS 输出是**逐字符比对**的期望文本（不是「包含」）。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import {
  analyzeJson,
  containerPreview,
  formatMatchValue,
  isContainer,
  isPlainObject,
  leafText,
  nodeCopyText,
  parseJsonPath,
  queryJsonPath,
  toCsv,
  toTypeScript,
  toYaml,
  typeLabel,
} from '../../src/modules/toolbox/lib/jsonUtils.ts';

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

/** 逐字符比对（失败时把差异打出来） */
function same(name, actual, expected) {
  ok(name, actual === expected, `\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`);
}

/* ================================================================== *
 * 0) Goessner JSONPath 教程里的经典数据（外部锚点）
 * ================================================================== */

const STORE = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', price: 8.99 },
      { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', price: 22.99 },
    ],
    bicycle: { color: 'red', price: 19.95 },
  },
};

const q = (expression, root = STORE) => queryJsonPath(root, parseJsonPath(expression));
const values = (expression, root = STORE) => q(expression, root).map((m) => m.value);

/* ================================================================== *
 * 1) JSONPath 解析：合法与非法
 * ================================================================== */

same('根节点解析为单个 root 段', JSON.stringify(parseJsonPath('$')), JSON.stringify([{ kind: 'root' }]));
same('点号子键', JSON.stringify(parseJsonPath('$.store')), JSON.stringify([{ kind: 'root' }, { kind: 'child', name: 'store' }]));
same('索引段', JSON.stringify(parseJsonPath('$.a[0]')), JSON.stringify([{ kind: 'root' }, { kind: 'child', name: 'a' }, { kind: 'index', indices: [0] }]));
same(
  '多索引段',
  JSON.stringify(parseJsonPath('$.a[0,2]').at(-1)),
  JSON.stringify({ kind: 'index', indices: [0, 2] }),
);
same(
  '负索引段',
  JSON.stringify(parseJsonPath('$.a[-1]').at(-1)),
  JSON.stringify({ kind: 'index', indices: [-1] }),
);
same('通配段 *', JSON.stringify(parseJsonPath('$.a[*]').at(-1)), JSON.stringify({ kind: 'wildcard' }));
same('点号通配 .*', JSON.stringify(parseJsonPath('$.a.*').at(-1)), JSON.stringify({ kind: 'wildcard' }));
same(
  '引号键',
  JSON.stringify(parseJsonPath("$['a b']").at(-1)),
  JSON.stringify({ kind: 'keys', names: ['a b'] }),
);
same(
  '多键',
  JSON.stringify(parseJsonPath("$['x','y']").at(-1)),
  JSON.stringify({ kind: 'keys', names: ['x', 'y'] }),
);
same('递归下降 ..name', JSON.stringify(parseJsonPath('$..price').at(-1)), JSON.stringify({ kind: 'descendant', name: 'price' }));
same('递归下降 ..*', JSON.stringify(parseJsonPath('$..*').at(-1)), JSON.stringify({ kind: 'descendantWildcard' }));
same('表达式里允许空格', JSON.stringify(parseJsonPath('$.a [0]')), JSON.stringify(parseJsonPath('$.a[0]')));

const parseErrors = [
  ['', '空表达式'],
  ['store.book', '不以 $ 开头'],
  ['$.a[0', '括号未闭合'],
  ['$.', '以点结尾'],
  ['$..', '.. 后缺字段名'],
  ['$a]', '含无法解析的字符 ]'],
  ['$.a[]', '[] 内为空'],
  ['$..book[?(@.price<10)]', '过滤表达式（本子集不支持 → 明确报错）'],
  ['$.book[0:2]', '切片写法（本子集不支持 → 明确报错）'],
];
for (const [expr, label] of parseErrors) {
  let threw = false;
  let message = '';
  try {
    parseJsonPath(expr);
  } catch (error) {
    threw = true;
    message = error instanceof Error ? error.message : String(error);
  }
  ok(`非法表达式抛错：${label}（${expr || '(空)'}）`, threw && /[\u4e00-\u9fa5]/.test(message), message);
}
ok(
  '不支持的过滤表达式给出「只支持基础子集」提示',
  (() => {
    try {
      parseJsonPath('$..book[?(@.price<10)]');
      return false;
    } catch (error) {
      return error.message.includes('基础子集');
    }
  })(),
);
ok(
  '引号内的冒号键仍然合法（不被切片规则误伤）',
  JSON.stringify(parseJsonPath("$['a:b']").at(-1)) === JSON.stringify({ kind: 'keys', names: ['a:b'] }),
);

/* ================================================================== *
 * 2) JSONPath 查询：按教程语义核对命中
 * ================================================================== */

same('$.store.book[0].title = 第一本标题', JSON.stringify(values('$.store.book[0].title')), JSON.stringify(['Sayings of the Century']));
same('$.store.book[2].title = 第三本标题', JSON.stringify(values('$.store.book[2].title')), JSON.stringify(['Moby Dick']));
same('$.store.book[-1].title = 最后一本标题', JSON.stringify(values('$.store.book[-1].title')), JSON.stringify(['The Lord of the Rings']));
same('$.store.book[*].author 命中 4 位作者', values('$.store.book[*].author').length, 4);
same('$..author 递归命中 4 位作者', values('$..author').length, 4);
same('$.store.* 的命中共 2 项', q('$.store.*').length, 2);
same(
  '$.store.* 分别命中 book 与 bicycle（路径与顺序）',
  q('$.store.*').map((m) => m.path).join(','),
  '$.store.book,$.store.bicycle',
);
same('$..price 命中 5 个价格（4 本书 + 自行车）', values('$..price').length, 5);
same('$.store.book[0,1].title 一次取两本', values('$.store.book[0,1].title').length, 2);
same("$['store']['book'][0]['title'] 与点号写法等价", JSON.stringify(values("$['store']['book'][0]['title']")), JSON.stringify(values('$.store.book[0].title')));
same('命中路径字符串正确', q('$.store.book[1].title')[0]?.path, '$.store.book[1].title');
same('非标识符键的路径加方括号', q("$['a b']", { 'a b': 1 })[0]?.path, '$["a b"]');

same('不存在的字段命中 0 条', values('$.store.nothing').length, 0);
same('对非数组用索引命中 0 条', values('$.store.book.title[0]').length, 0);
same('空路径 $ 返回根自身', q('$').length, 1);
same('$ 的命中路径为 $', q('$')[0]?.path, '$');
ok('$..* 递归展开出大量节点', q('$..*').length > 20, String(q('$..*').length));

// 递归下降串起后续段：$..book[0] 应先递归找到 book，再取索引
same('$..book[0].title 递归后继续走段', JSON.stringify(values('$..book[0].title')), JSON.stringify(['Sayings of the Century']));

// 上限：数组通配默认最多 200 条（queryJsonPath 的 limit 参数）；
// 递归下降自身最多收 500 条 —— 把 limit 放宽到 1000 才能看出这个内部上限
const BIG = { items: Array.from({ length: 300 }, (_v, i) => ({ v: i })) };
same('通配查询默认上限 200 条', q('$.items[*]', BIG).length, 200);
same('显式 limit 生效', queryJsonPath(BIG, parseJsonPath('$.items[*]'), 50).length, 50);
const HUGE = { rows: Array.from({ length: 600 }, (_v, i) => ({ deep: i })) };
same('默认 limit 时递归下降被 200 截住', queryJsonPath(HUGE, parseJsonPath('$..deep')).length, 200);
same('放宽 limit 后递归下降止于内部上限 500 条', queryJsonPath(HUGE, parseJsonPath('$..deep'), 1000).length, 500);

/* ================================================================== *
 * 3) 取值预览与基础判定
 * ================================================================== */

same('字符串预览带引号（区分 "1" 与 1）', formatMatchValue('1'), '"1"');
same('数字预览不带引号', formatMatchValue(1), '1');
same('null 预览为 null', formatMatchValue(null), 'null');
same('布尔预览', formatMatchValue(true), 'true');
same('对象预览为压缩 JSON', formatMatchValue({ a: 1 }), '{"a":1}');
same('数组预览为压缩 JSON', formatMatchValue([1, 2]), '[1,2]');
ok(
  '超长字符串预览带省略号（省略号在引号内）',
  formatMatchValue('x'.repeat(200)).includes('…'),
  formatMatchValue('x'.repeat(200)).slice(-6),
);
// 字符串在引号内部截断，预览本身仍是「合法的 JSON 字符串形态」（不会切出 `"ab…` 这种半截引号）
ok(
  '超长字符串预览保持引号闭合',
  /^".*"$/.test(formatMatchValue('x'.repeat(200))),
  formatMatchValue('x'.repeat(200)),
);
ok('自定义截断长度也保持引号闭合', /^".*"$/.test(formatMatchValue('x'.repeat(50), 20)), formatMatchValue('x'.repeat(50), 20));
same('截断长度遵守 maxLength', formatMatchValue('x'.repeat(50), 20).length, 20);
same('不超长时原样输出带引号', formatMatchValue('abc', 20), '"abc"');

ok('isContainer 认对象与数组', isContainer({}) === true && isContainer([]) === true);
ok('isContainer 不认 null 与标量', isContainer(null) === false && isContainer('x') === false);
ok('isPlainObject 排除数组与 null', isPlainObject([]) === false && isPlainObject(null) === false && isPlainObject({}) === true);
same('typeLabel 六类', ['object', 'array', 'string', 'number', 'boolean', 'null'].map((kind) => {
  const sample = { object: {}, array: [], string: 'x', number: 1, boolean: true, null: null }[kind];
  return typeLabel(sample);
}).join(','), 'object,array,string,number,boolean,null');
same('容器预览：对象', containerPreview({ a: 1, b: 2 }), '{2 键}');
same('容器预览：数组', containerPreview([1, 2, 3]), '[3 项]');
same('容器预览：标量为空串', containerPreview(5), '');
same('叶子文本：字符串保留引号', leafText('1'), '"1"');
same('叶子文本：数字', leafText(1), '1');
same('叶子文本：null', leafText(null), 'null');
same('节点复制文本：字符串取原值', nodeCopyText('a\nb'), 'a\nb');
same('节点复制文本：对象美化 JSON', nodeCopyText({ a: 1 }), '{\n  "a": 1\n}');

/* ================================================================== *
 * 4) 统计
 * ================================================================== */

const stats = analyzeJson(JSON.stringify(STORE, null, 2), STORE);
same('对象数（根 + store + bicycle + 4 本书 = 7）', stats.objects, 7);
same('数组数（book 数组本身）', stats.arrays, 1);
same('键总数（3 + 每本书 4×4 + 自行车 2 = 21）', stats.keys, 3 + 4 * 4 + 2);
same('最大嵌套深度', stats.depth, 4);
same('字符数 = 原文长度', stats.chars, JSON.stringify(STORE, null, 2).length);
same('行数按换行计', analyzeJson('a\nb\nc', null).lines, 3);
same('空原文行数为 0', analyzeJson('', null).lines, 0);
same('叶子根深度为 1', analyzeJson('1', 1).depth, 1);
same('空对象统计', JSON.stringify([analyzeJson('{}', {}).objects, analyzeJson('{}', {}).keys, analyzeJson('{}', {}).depth]), JSON.stringify([1, 0, 1]));

/* ================================================================== *
 * 5) CSV 导出（RFC 4180 转义）
 * ================================================================== */

const books = q('$.store.book')[0].value;
same(
  '对象数组 → CSV（嵌套数组整体序列化并转义）',
  toCsv(books).text,
  'category,author,title,price\n' +
    'reference,Nigel Rees,Sayings of the Century,8.95\n' +
    'fiction,Evelyn Waugh,Sword of Honour,12.99\n' +
    'fiction,Herman Melville,Moby Dick,8.99\n' +
    'fiction,J. R. R. Tolkien,The Lord of the Rings,22.99',
);

same('字段取并集，缺失位留空', toCsv([{ a: 1 }, { b: 2 }]).text, 'a,b\n1,\n,2');
same('含逗号的值整体加引号', toCsv([{ a: 'x,y' }]).text, 'a\n"x,y"');
same('含引号的值翻倍并整体加引号', toCsv([{ a: 'say "hi"' }]).text, 'a\n"say ""hi"""');
same('含换行的值整体加引号', toCsv([{ a: 'l1\nl2' }]).text, 'a\n"l1\nl2"');
same('null 与 undefined 输出空单元格', toCsv([{ a: null, b: undefined }]).text, 'a,b\n,');
same('false 与 0 不被当成空', toCsv([{ a: false, b: 0 }]).text, 'a,b\nfalse,0');
same('单个对象根按一行输出', toCsv({ a: 1 }).text, 'a\n1');
same('嵌套对象整体序列化', toCsv([{ a: { b: 1 } }]).text, 'a\n"{""b"":1}"');

const csvErrors = [
  [[1, 2], '数组里全是标量'],
  [[{ a: 1 }, 'x'], '数组中混入标量'],
  [[], '空数组'],
  [123, '根不是对象'],
  [null, '根是 null'],
];
for (const [input, label] of csvErrors) {
  const result = toCsv(input);
  ok(`CSV 拒绝：${label}`, result.ok === false && result.error.length > 0, JSON.stringify(result));
}
ok('CSV 错误信息是中文且说清原因', toCsv([1]).error.includes('非对象'), toCsv([1]).error);

/* ================================================================== *
 * 6) YAML 导出（引号必要性按规范判定）
 * ================================================================== */

same('数字不加引号', toYaml({ a: 1 }), 'a: 1\n');
same('真布尔不加引号', toYaml({ a: true }), 'a: true\n');
same('null 输出 null', toYaml({ a: null }), 'a: null\n');
same('与布尔同形的字符串必须加引号', toYaml({ a: 'true' }), 'a: "true"\n');
same('与 null 同形的字符串必须加引号', toYaml({ a: 'null' }), 'a: "null"\n');
same('与数字同形的字符串必须加引号', toYaml({ a: '1' }), 'a: "1"\n');
same('空字符串加引号', toYaml({ a: '' }), 'a: ""\n');
same('含冒号空格的字符串加引号', toYaml({ a: 'x: y' }), 'a: "x: y"\n');
same('含 # 的字符串加引号', toYaml({ a: 'x #y' }), 'a: "x #y"\n');
same('首尾空格加引号', toYaml({ a: ' x' }), 'a: " x"\n');
same('普通字符串不加引号', toYaml({ a: 'hello' }), 'a: hello\n');
same('含换行的字符串转义为 \\n', toYaml({ a: 'l1\nl2' }), 'a: "l1\\nl2"\n');
// 普通标量里可以出现引号（只要不是首字符），YAML 规范允许，无需加引号
same('中段含引号的字符串不必加引号', toYaml({ a: 'say "hi"' }), 'a: say "hi"\n');
// 以引号开头就必须加引号并转义
same('以引号开头的字符串加引号并转义', toYaml({ a: '"hi"' }), 'a: "\\"hi\\""\n');

same('嵌套对象缩进 2 空格', toYaml({ a: { b: 1 } }), 'a:\n  b: 1\n');
same('数组为块序列', toYaml({ a: [1, 2] }), 'a:\n  - 1\n  - 2\n');
same('空数组写 []', toYaml({ a: [] }), 'a: []\n');
same('空对象写 {}', toYaml({ a: {} }), 'a: {}\n');
same('空数组根', toYaml([]), '[]\n');
same('空对象根', toYaml({}), '{}\n');
same('标量根', toYaml('hi'), 'hi\n');
same('null 根', toYaml(null), 'null\n');
same(
  '对象数组：首行接在 - 之后，后续行对齐',
  toYaml([{ a: 1 }, { b: [1, 2] }]),
  '- a: 1\n- b:\n    - 1\n    - 2\n',
);
// 嵌套序列写成「- - 1」+ 缩进续行：这是合法的 YAML 块序列（内层序列有自己的 dash）
same(
  '数组套数组',
  toYaml([[1, 2], [3]]),
  '- - 1\n  - 2\n- - 3\n',
);
// 带空格的键在 YAML 里是合法的普通标量（"a b: 1" 解析出来的键就是 "a b"），不必加引号
same('键含空格时按普通标量输出', toYaml({ 'a b': 1 }), 'a b: 1\n');
same('键含冒号时必须加引号', toYaml({ 'a:b': 1 }), '"a:b": 1\n');
same('键与布尔同形时加引号', toYaml({ true: 1 }), '"true": 1\n');

/* ================================================================== *
 * 7) TypeScript 类型推断（逐字符比对）
 * ================================================================== */

same('对象根生成 interface Root', toTypeScript({ id: 1, name: 'a' }), 'interface Root {\n  id: number;\n  name: string;\n}\n');
same(
  '自定义根名',
  toTypeScript({ id: 1 }, 'Resp'),
  'interface Resp {\n  id: number;\n}\n',
);
same(
  '根名含分隔符时 PascalCase 化',
  toTypeScript({ id: 1 }, 'api-response'),
  'interface ApiResponse {\n  id: number;\n}\n',
);
same('标量根生成 type 别名', toTypeScript(123), 'type Root = number;\n');
same('字符串根', toTypeScript('x'), 'type Root = string;\n');
same('纯标量数组根', toTypeScript([1, 2]), 'type Root = number[];\n');
same('混合标量数组加括号', toTypeScript([1, 'a']), 'type Root = (number | string)[];\n');
same('空数组根类型退化为 unknown[]', toTypeScript([]), 'type Root = unknown[];\n');
same('空对象根', toTypeScript({}), 'interface Root {\n  [key: string]: unknown;\n}\n');
same('null 值字段为 null 类型', toTypeScript({ a: null }), 'interface Root {\n  a: null;\n}\n');

same(
  '嵌套对象各自成接口，字段名 PascalCase',
  toTypeScript({ owner: { id: 1 } }),
  'interface Root {\n  owner: Owner;\n}\n\ninterface Owner {\n  id: number;\n}\n',
);
same(
  '对象数组：元素对象生成单数接口名 + 数组类型',
  toTypeScript({ books: [{ id: 1 }, { id: 2 }] }),
  'interface Root {\n  books: Book[];\n}\n\ninterface Book {\n  id: number;\n}\n',
);
same(
  '顶层数组：元素对象提升为 Root 接口',
  toTypeScript([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]),
  'interface Root {\n  id: number;\n  name: string;\n}\n',
);
// 中文键加引号是**保守但安全**的做法：TS 允许 `中文: number`，
// 但加引号同样合法，且能顺带盖住 '·' 这类真的不合法的键（UI 示例也是这么承诺的）
same(
  '非法标识符键加引号（含中文键）',
  toTypeScript({ 'user-name': 'a', 中文: 1, 'a b': true }),
  'interface Root {\n  "user-name": string;\n  "中文": number;\n  "a b": boolean;\n}\n',
);
same(
  '合法标识符键不加引号',
  toTypeScript({ userName: 'a', _x: 1, $y: true }),
  'interface Root {\n  userName: string;\n  _x: number;\n  $y: boolean;\n}\n',
);
same(
  '字段缺失时标为可选',
  toTypeScript([{ a: 1 }, { b: 2 }]),
  'interface Root {\n  a?: number;\n  b?: number;\n}\n',
);
same(
  '含 null 的数组字段生成联合数组类型',
  toTypeScript({ a: [null, 'x'] }),
  'interface Root {\n  a: (null | string)[];\n}\n',
);
same(
  '对象数组内同名不同值类型合并为联合',
  toTypeScript({ a: [{ v: 1 }, { v: 'x' }] }),
  'interface Root {\n  a: A[];\n}\n\ninterface A {\n  v: number | string;\n}\n',
);

/* --- 本轮修掉的两处（回归守门） --- */

// 1) 接口名复用不能只看键名：同键不同值类型必须是两个接口（旧版会静默复用错误的 a: number）
same(
  '同键不同值类型 → 生成两个接口（不再静默复用）',
  toTypeScript({ item: { a: 1 }, wrap: { item: { a: 's' } } }),
  'interface Root {\n  item: Item;\n  wrap: Wrap;\n}\n\n' +
    'interface Item {\n  a: number;\n}\n\n' +
    'interface Wrap {\n  item: Item2;\n}\n\n' +
    'interface Item2 {\n  a: string;\n}\n',
);
// 2) 序号不能叠序号（旧版第三次冲突会产出 Item22）
same(
  '三处结构冲突 → 序号连续（X / X2 / X3，不是 X / X2 / X22）',
  toTypeScript({ a: { x: { v: 1 } }, b: { x: { v: 's' } }, c: { x: { v: true } } }),
  'interface Root {\n  a: A;\n  b: B;\n  c: C;\n}\n\n' +
    'interface A {\n  x: X;\n}\n\n' +
    'interface X {\n  v: number;\n}\n\n' +
    'interface B {\n  x: X2;\n}\n\n' +
    'interface X2 {\n  v: string;\n}\n\n' +
    'interface C {\n  x: X3;\n}\n\n' +
    'interface X3 {\n  v: boolean;\n}\n',
);
same(
  '结构相同的同名嵌套仍然复用同一个接口',
  toTypeScript({ left: { node: { v: 1 } }, right: { node: { v: 2 } } }),
  'interface Root {\n  left: Left;\n  right: Right;\n}\n\n' +
    'interface Left {\n  node: Node;\n}\n\n' +
    'interface Node {\n  v: number;\n}\n\n' +
    'interface Right {\n  node: Node;\n}\n',
);

// 输出的 TS 必须是可解析的：花括号配平、每行以 ; 或 { 或 } 结尾
const tsSamples = [
  toTypeScript({ id: 1, tags: ['a'], owner: { name: null } }),
  toTypeScript([{ a: 1 }, { b: 'x' }]),
  toTypeScript({ list: [{ deep: { v: [1, 2] } }] }),
];
for (const code of tsSamples) {
  const opens = (code.match(/\{/g) ?? []).length;
  const closes = (code.match(/\}/g) ?? []).length;
  ok('生成的 TS 花括号配平', opens === closes, `${opens} / ${closes}`);
  ok('生成的 TS 以换行结尾', code.endsWith('\n'));
  const lines = code.split('\n').filter((line) => line.trim().length > 0);
  ok(
    '生成的 TS 每行结构合法',
    lines.every((line) => /[;{}]$/.test(line.trim())),
    lines.find((line) => !/[;{}]$/.test(line.trim())),
  );
}

/* ================================================================== *
 * 8) UI 示例里写死的承诺（V25 教训：示例不能与实现不符）
 * ================================================================== */

// JsonToTs「可空字段」示例：输入的数组里必须有 null 与其它类型共存，才谈得上 T | null
const NULLABLE_SAMPLE = JSON.parse(
  '[{"id":1,"deletedAt":null,"owner":{"name":"a"}},{"id":2,"deletedAt":"2026-09-15","owner":{"name":null}}]',
);
const nullableCode = toTypeScript(NULLABLE_SAMPLE);
ok('「可空字段」示例输出真的出现 null | string 联合', nullableCode.includes('deletedAt: null | string;'), nullableCode);
ok('「可空字段」示例嵌套里的 null 也并入联合', nullableCode.includes('name: null | string;'), nullableCode);

// JsonToTs「重名嵌套」示例：必须真的触发序号追加（否则描述是假的）
const NODE_SAMPLE = JSON.parse('{"left":{"node":{"v":1}},"right":{"node":{"v":"s"}}}');
const nodeCode = toTypeScript(NODE_SAMPLE);
ok('「重名嵌套」示例真的出现 Node2', nodeCode.includes('interface Node2 {'), nodeCode);
ok('「重名嵌套」示例两处类型各自正确', nodeCode.includes('v: number;') && nodeCode.includes('v: string;'), nodeCode);

// JsonFormatter 的示例 JSON 必须能被 JSONPath 示例命中（$.store.book[0].title）
const SAMPLE_JSON = `{
  "store": {
    "name": "Handy 商店",
    "book": [
      { "title": "顺风而行", "price": 39.9, "tags": ["new", "hot"], "stock": true },
      { "title": "桌面效率手册", "price": 58, "tags": ["classic"], "stock": false }
    ],
    "owner": { "id": 1001, "vip": null }
  },
  "code": 0
}`;
const sampleParsed = JSON.parse(SAMPLE_JSON);
const sampleHit = queryJsonPath(sampleParsed, parseJsonPath('$.store.book[0].title'));
same('JSONPath 示例命中第一条书名', JSON.stringify(sampleHit.map((m) => m.value)), JSON.stringify(['顺风而行']));
same('JSONPath 示例的命中路径与表达式一致', sampleHit[0]?.path, '$.store.book[0].title');
const sampleBooks = queryJsonPath(sampleParsed, parseJsonPath('$.store.book'))[0].value;
same(
  '「book 转 CSV」示例的 CSV 表头',
  toCsv(sampleBooks).text.split('\n')[0],
  'title,price,tags,stock',
);
ok('「book 转 CSV」示例嵌套数组被正确转义', toCsv(sampleBooks).text.includes('"[""new"",""hot""]"'), toCsv(sampleBooks).text);

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
