/**
 * urlUtils.ts 回归（V26 新增）。
 *
 * # 为什么必须锁
 *
 * URL 编解码是「看一眼觉得对」的重灾区：
 *
 * 1. **`parseUrlParts` 会把「主机:端口」当成协议吞掉**：
 *    `new URL('example.com:8080/path')` 在 WHATWG 规范下**不报错** ——
 *    它把这串读成「协议 `example.com:` + 路径 `8080/path`」，host / port 双双为空。
 *    于是用户粘一个 `localhost:5173` 进去，界面会**安静地**给出一个错误的结构分解。
 *    这类「静默错答案」比抛错危险得多，本套把它钉死。
 * 2. 编码口径是**外部标准**（RFC 3986 / WHATWG URL / x-www-form-urlencoded），
 *    期望值全部手写，不抄实现。
 * 3. 对照表 `URL_REFERENCE_ROWS` 的值是运行时算的，但**说明文字是手写的** ——
 *    两者必须自洽（说明里写了 `%25`，值就必须真是 `%25`）。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import {
  URL_EXAMPLES,
  URL_REFERENCE_ROWS,
  buildUrl,
  computeUrlStats,
  decodeWithMethod,
  emptyParts,
  encodeWithMethod,
  formatQueryPairs,
  parseQueryPairs,
  parseUrlParts,
} from '../../src/modules/toolbox/lib/urlUtils.ts';

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

/* ================================================================== *
 * 1) 三种编码方法：RFC 3986 口径的期望值
 * ================================================================== */

ok('component：空格 → %20', encodeWithMethod('a b', 'component') === 'a%20b', encodeWithMethod('a b', 'component'));
ok(
  'component：& 与 = 都被转义',
  encodeWithMethod('a&b=c', 'component') === 'a%26b%3Dc',
  encodeWithMethod('a&b=c', 'component'),
);
ok(
  'component：保留 ! * \' ( ) - _ . ~（RFC 3986 非保留字符）',
  encodeWithMethod("!*'()-_.~", 'component') === "!*'()-_.~",
  encodeWithMethod("!*'()-_.~", 'component'),
);
ok('component：中文按 UTF-8 逐字节 → %E4%B8%AD', encodeWithMethod('中', 'component') === '%E4%B8%AD', encodeWithMethod('中', 'component'));
ok('form：空格 → +', encodeWithMethod('a b', 'form') === 'a+b', encodeWithMethod('a b', 'form'));
ok('form：+ 自身必须转义（否则会被读成空格）', encodeWithMethod('a+b', 'form') === 'a%2Bb', encodeWithMethod('a+b', 'form'));
ok(
  'uri：保留 : / ? & = # 的层级结构',
  encodeWithMethod('https://a.com/x y?z=1&w=2#f', 'uri') === 'https://a.com/x%20y?z=1&w=2#f',
  encodeWithMethod('https://a.com/x y?z=1&w=2#f', 'uri'),
);

ok('component 解码还原', decodeWithMethod('a%20b', 'component') === 'a b', decodeWithMethod('a%20b', 'component'));
ok('form 解码把 + 还原为空格', decodeWithMethod('a+b', 'form') === 'a b', decodeWithMethod('a+b', 'form'));
ok('uri 解码还原中文', decodeWithMethod('%E4%B8%AD', 'uri') === '中', decodeWithMethod('%E4%B8%AD', 'uri'));

// encodeURI 的产物必须能被 decodeWithMethod('uri') 还原（两端口径一致才敢让用户来回切）
const uriSource = 'https://zh.wikipedia.org/wiki/中文?q="x"&p=1#段';
ok('uri 编解码往返无损', decodeWithMethod(encodeWithMethod(uriSource, 'uri'), 'uri') === uriSource);

let percentThrew = false;
try {
  decodeWithMethod('100%', 'component');
} catch {
  percentThrew = true;
}
ok('孤立 % 解码抛错（不静默丢字符）', percentThrew);

/* ================================================================== *
 * 2) parseUrlParts：结构分解
 * ================================================================== */

const full = parseUrlParts('https://example.com/docs/getting-started?ref=handy#section-2');
ok('完整 URL 解析成功', full.ok === true);
ok('完整 URL 不需要修复', full.repaired === false);
ok('协议 = https:', full.parts?.protocol === 'https:', String(full.parts?.protocol));
ok('主机 = example.com', full.parts?.hostname === 'example.com', String(full.parts?.hostname));
ok('路径 = /docs/getting-started', full.parts?.pathname === '/docs/getting-started', String(full.parts?.pathname));
ok('查询 = ?ref=handy', full.parts?.search === '?ref=handy', String(full.parts?.search));
ok('片段 = #section-2', full.parts?.hash === '#section-2', String(full.parts?.hash));
ok('带端口的 URL 端口正确', parseUrlParts('https://a.com:8443/x').parts?.port === '8443', String(parseUrlParts('https://a.com:8443/x').parts?.port));

// 缺协议 → 补 http:// 并标记 repaired
const repaired = parseUrlParts('example.com/path');
ok('缺协议时 repaired = true', repaired.repaired === true);
ok('缺协议时仍解析出主机', repaired.parts?.hostname === 'example.com', String(repaired.parts?.hostname));
ok('缺协议时路径正确', repaired.parts?.pathname === '/path', String(repaired.parts?.pathname));

/* --- 本套重点：主机:端口 不能被当成协议 --- */

const localhost = parseUrlParts('localhost:5173');
ok('localhost:5173 → 主机 localhost', localhost.parts?.hostname === 'localhost', String(localhost.parts?.hostname));
ok('localhost:5173 → 端口 5173', localhost.parts?.port === '5173', String(localhost.parts?.port));
ok('localhost:5173 → 协议是补出来的 http:', localhost.parts?.protocol === 'http:', String(localhost.parts?.protocol));
ok('localhost:5173 → 标记为 repaired', localhost.repaired === true);
ok('localhost:5173 → 路径为 /', localhost.parts?.pathname === '/', String(localhost.parts?.pathname));

const hostPort = parseUrlParts('example.com:8080/path');
ok('example.com:8080/path → 主机 example.com', hostPort.parts?.hostname === 'example.com', String(hostPort.parts?.hostname));
ok('example.com:8080/path → 端口 8080', hostPort.parts?.port === '8080', String(hostPort.parts?.port));
ok('example.com:8080/path → 路径 /path', hostPort.parts?.pathname === '/path', String(hostPort.parts?.pathname));
ok('example.com:8080/path → 协议不是 example.com:', hostPort.parts?.protocol === 'http:', String(hostPort.parts?.protocol));

const weird = parseUrlParts('weird:8080');
ok('weird:8080 → 主机 weird + 端口 8080', weird.parts?.hostname === 'weird' && weird.parts?.port === '8080', String(weird.parts?.hostname) + ':' + String(weird.parts?.port));

// 协议相对写法（//host/path）不能被拼成 http:////host/path（会得到空主机）
const protocolRelative = parseUrlParts('//cdn.example.com/lib.js');
ok('//host/path → 主机 cdn.example.com', protocolRelative.parts?.hostname === 'cdn.example.com', String(protocolRelative.parts?.hostname));
ok('//host/path → 路径 /lib.js', protocolRelative.parts?.pathname === '/lib.js', String(protocolRelative.parts?.pathname));

// 无 // 的合法协议（mailto / tel / data）不能被误判成主机:端口
const mailto = parseUrlParts('mailto:someone@example.com');
ok('mailto: 保持为协议', mailto.parts?.protocol === 'mailto:', String(mailto.parts?.protocol));
ok('mailto: 不需要 repaired', mailto.repaired === false);
ok('tel: 保持为协议', parseUrlParts('tel:+8613800138000').parts?.protocol === 'tel:');
ok('data: 保持为协议', parseUrlParts('data:text/plain,hi').parts?.protocol === 'data:');

// 失败路径
const empty = parseUrlParts('   ');
ok('空输入 ok = false', empty.ok === false);
ok('空输入不报错文案（UI 显示空态）', empty.error === null, String(empty.error));

const broken = parseUrlParts('http://');
ok('无法解析时 ok = false', broken.ok === false);
ok('无法解析时给中文可读提示', typeof broken.error === 'string' && /[\u4e00-\u9fa5]/.test(broken.error), String(broken.error));

/* ================================================================== *
 * 3) buildUrl：六个片段拼回整串
 * ================================================================== */

ok('空 parts 拼出空串', buildUrl(emptyParts()) === '', JSON.stringify(buildUrl(emptyParts())));
ok(
  'search / hash 自动补前导符号',
  buildUrl({ protocol: 'https:', hostname: 'a.com', port: '', pathname: '/p', search: 'q=1', hash: 'h' }) ===
    'https://a.com/p?q=1#h',
  buildUrl({ protocol: 'https:', hostname: 'a.com', port: '', pathname: '/p', search: 'q=1', hash: 'h' }),
);
ok(
  '协议尾冒号重复时归一化',
  buildUrl({ protocol: 'https://', hostname: 'a.com', port: '', pathname: '', search: '', hash: '' }) === 'https://a.com',
  buildUrl({ protocol: 'https://', hostname: 'a.com', port: '', pathname: '', search: '', hash: '' }),
);
ok(
  '端口带前导冒号时归一化',
  buildUrl({ protocol: 'http:', hostname: 'a.com', port: ':8080', pathname: '', search: '', hash: '' }) ===
    'http://a.com:8080',
  buildUrl({ protocol: 'http:', hostname: 'a.com', port: ':8080', pathname: '', search: '', hash: '' }),
);
ok(
  '路径缺前导斜杠时补上',
  buildUrl({ protocol: 'https:', hostname: 'a.com', port: '', pathname: 'p', search: '', hash: '' }) === 'https://a.com/p',
  buildUrl({ protocol: 'https:', hostname: 'a.com', port: '', pathname: 'p', search: '', hash: '' }),
);

// 解析 → 重建 的往返（这是工具「改一段再拼回去」的核心用法）
const RT_CASES = [
  'https://example.com/docs/getting-started?ref=handy#section-2',
  'https://a.com:8443/api/v1?x=1',
  'http://localhost:5173/',
];
for (const url of RT_CASES) {
  const parsed = parseUrlParts(url);
  const rebuilt = buildUrl(parsed.parts ?? emptyParts());
  ok(`解析→重建往返：${url}`, rebuilt === url, rebuilt);
}

/* ================================================================== *
 * 4) 查询参数
 * ================================================================== */

const pairs = parseQueryPairs('https://api.example.com/v1/items?page=1&size=20');
ok('从完整 URL 抽出 2 个参数', pairs.length === 2, String(pairs.length));
ok('第一个参数 key/value', pairs[0]?.key === 'page' && pairs[0]?.value === '1', JSON.stringify(pairs[0]));

const cnPairs = parseQueryPairs('q=%E4%B8%AD%E6%96%87');
ok('百分号编码自动解码', cnPairs[0]?.value === '中文', JSON.stringify(cnPairs[0]));

const plusPairs = parseQueryPairs('q=a+b');
ok('表单语义：+ 解成空格', plusPairs[0]?.value === 'a b', JSON.stringify(plusPairs[0]));

const barePairs = parseQueryPairs('a.com?flag');
ok('无值参数得到空串值', barePairs[0]?.key === 'flag' && barePairs[0]?.value === '', JSON.stringify(barePairs[0]));

const hashPairs = parseQueryPairs('a.com?x=1#frag');
ok('片段不混进查询串', hashPairs.length === 1 && hashPairs[0]?.value === '1', JSON.stringify(hashPairs));

const dupPairs = parseQueryPairs('a=1&a=2');
ok('重复键全部保留（不合并丢值）', dupPairs.length === 2, String(dupPairs.length));

ok('空输入得空数组', parseQueryPairs('   ').length === 0);
ok('只有 ? 时得空数组', parseQueryPairs('a.com?').length === 0);
ok(
  'formatQueryPairs 每行一条',
  formatQueryPairs([
    { key: 'a', value: '1' },
    { key: 'b', value: '2' },
  ]) === 'a = 1\nb = 2',
  formatQueryPairs([
    { key: 'a', value: '1' },
    { key: 'b', value: '2' },
  ]),
);

/* ================================================================== *
 * 5) 统计：按码点计数，字节按 UTF-8
 * ================================================================== */

const emojiStats = computeUrlStats('😀');
ok('emoji 按码点算 1 个字符', emojiStats.chars === 1, String(emojiStats.chars));
ok('emoji 按 UTF-8 算 4 字节', emojiStats.bytes === 4, String(emojiStats.bytes));

const cnStats = computeUrlStats('中文');
ok('中文 2 字符 6 字节', cnStats.chars === 2 && cnStats.bytes === 6, `${cnStats.chars}/${cnStats.bytes}`);
ok('中文触发 hasCjk', cnStats.hasCjk === true);
ok('纯 ASCII 不触发 hasCjk', computeUrlStats('hello').hasCjk === false);
ok('纯 ASCII 无特殊字符', computeUrlStats('hello').hasSpecial === false);
ok('空格算特殊字符', computeUrlStats('a b').hasSpecial === true);
ok('空串统计全零且无特殊字符', computeUrlStats('').chars === 0 && computeUrlStats('').hasSpecial === false);

/* ================================================================== *
 * 6) 对照表与示例的自洽性（写死的说明不能与算出来的值打架）
 * ================================================================== */

ok('对照表有 22 行', URL_REFERENCE_ROWS.length === 22, String(URL_REFERENCE_ROWS.length));

for (const row of URL_REFERENCE_ROWS) {
  ok(`对照表 ${JSON.stringify(row.char)} 的值 = 真实编码`, row.component === encodeURIComponent(row.char), row.component);
  ok(
    `对照表 ${JSON.stringify(row.char)} 表单列 = 标准编码换 +`,
    row.form === encodeURIComponent(row.char).replace(/%20/g, '+'),
    row.form,
  );
  // 说明文字里若引用了具体编码值，必须与算出来的值一致
  const quoted = row.note.match(/%[0-9A-F]{2}/g) ?? [];
  for (const token of quoted) {
    ok(`对照表 ${JSON.stringify(row.char)} 说明里的 ${token} 与值一致`, row.component.includes(token), row.component);
  }
}

ok(
  '空格一行：说明里的 %20 与 form 列的 +',
  URL_REFERENCE_ROWS[0]?.component === '%20' && URL_REFERENCE_ROWS[0]?.form === '+',
  `${URL_REFERENCE_ROWS[0]?.component} / ${URL_REFERENCE_ROWS[0]?.form}`,
);

const alreadyEncoded = URL_EXAMPLES.find((item) => item.label === '已编码 URL');
ok('示例含「已编码 URL」一条', Boolean(alreadyEncoded));
ok(
  '「已编码 URL」解一次得到可读 URL',
  decodeWithMethod(alreadyEncoded.value, 'component') === 'https://example.com/search?q=hello%20world&lang=zh',
  decodeWithMethod(alreadyEncoded.value, 'component'),
);
// 每条示例至少要有一条路走得通：要么本身是 URL，要么「解一次码」之后是 URL
// （「已编码 URL」那条本就是给解码页用的，不该要求它直接能解析成 URL）
for (const example of URL_EXAMPLES) {
  const direct = parseUrlParts(example.value).ok === true;
  const afterDecode = parseUrlParts(decodeWithMethod(example.value, 'component')).ok === true;
  ok(`示例「${example.label}」在工具里至少有一条路走得通`, direct || afterDecode, example.value);
}

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
