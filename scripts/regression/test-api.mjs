/**
 * apiUtils（接口测试底层）回归 —— V28。
 *
 * 锚点：
 *  - cURL 语料来自**真实来源**：Chrome DevTools「Copy as cURL (bash)」的输出格式、
 *    curl 官方文档的选项语义（-d 系列隐含 POST、-u 产生 Basic 认证头、--json 隐含
 *    Content-Type: application/json）、以及终端手写的续行/引号习惯；
 *  - Basic 认证头的期望值用 node 的 Buffer 现算，与 apiUtils 里的 btoa 对拍（两者都是标准 Base64）；
 *  - 其余为逐字符手核的格式化期望值（别凭直觉，V23/V27 两轮 14 条 FAIL 全是自己数错）。
 */
import { Buffer } from 'node:buffer';

const {
  tokenizeCurl,
  parseCurl,
  isSensitiveHeader,
  rowsToRecord,
  rowsForPersist,
  validateTarget,
  statusTone,
  prettyBody,
  formatDuration,
  formatSize,
} = await import('../../src/modules/toolbox/lib/apiUtils.ts');

const NL = String.fromCharCode(10);
let pass = 0;
const fails = [];
function check(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    pass += 1;
  } else {
    fails.push(`FAIL | ${name} | got=${a} want=${b}`);
  }
}

// ---------- 1) tokenizeCurl：续行 / 三种引号 / $'...' ----------
check(
  '续行合并',
  tokenizeCurl(`curl -X GET \\${NL}  https://a.com`),
  ['curl', '-X', 'GET', 'https://a.com'],
);
check('单引号字面量', tokenizeCurl(`-d '{"a":1}'`), ['-d', '{"a":1}']);
check('双引号内转义', tokenizeCurl(`-d "{\\"a\\":\\"b\\"}"`), ['-d', '{"a":"b"}']);
check(`$'...' 转义`, tokenizeCurl(`-d $'{\\"a\\":1}'`), ['-d', '{"a":1}']);

// ---------- 2) parseCurl：DevTools「Copy as cURL (bash)」真实形态 ----------
const devtools = [
  `curl 'https://api.example.com/v1/users?id=7' \\`,
  `  -H 'User-Agent: Mozilla/5.0' \\`,
  `  -H 'Accept: application/json' \\`,
  `  -H 'Authorization: Bearer abc123' \\`,
  `  --data-raw '{"name":"张三","tags":["a","b"]}' \\`,
  `  --compressed`,
].join(NL);
const parsedDevtools = parseCurl(devtools);
check('DevTools 方法（-d 隐含 POST）', parsedDevtools?.method, 'POST');
check('DevTools URL', parsedDevtools?.url, 'https://api.example.com/v1/users?id=7');
check('DevTools 头数量', parsedDevtools?.headers.length, 3);
check('DevTools 头[2]', parsedDevtools?.headers[2], { key: 'Authorization', value: 'Bearer abc123' });
check('DevTools 体', parsedDevtools?.body, '{"name":"张三","tags":["a","b"]}');

// ---------- 3) 其余 cURL 形态 ----------
check('裸 URL 默认 GET', parseCurl('curl https://httpbin.org/get')?.method, 'GET');
check('裸 URL 提取', parseCurl('curl https://httpbin.org/get')?.url, 'https://httpbin.org/get');
check('-X 显式 DELETE', parseCurl(`curl -X DELETE 'https://a.com/1'`)?.method, 'DELETE');
check('curl.exe 也认', parseCurl('curl.exe https://a.com')?.url, 'https://a.com');
check('--url 形式', parseCurl('curl --url https://a.com/x')?.url, 'https://a.com/x');
check('无 URL → null', parseCurl(`curl -X GET -H 'A: b'`), null);
check('空串 → null', parseCurl(''), null);

// --json：隐含 POST + Content-Type
const pj = parseCurl(`curl --json '{"a":1}' https://a.com/api`);
check('--json 方法', pj?.method, 'POST');
check('--json 补 Content-Type', pj?.headers.some((h) => h.key === 'Content-Type' && h.value === 'application/json'), true);
check('--json 体', pj?.body, '{"a":1}');

// -u：Basic 认证头，期望值用 node Buffer 现算（与 btoa 同为标准 Base64）
const pu = parseCurl(`curl -u alice:s3cret https://a.com`);
check(
  '-u 产生 Basic 头',
  pu?.headers[0],
  { key: 'Authorization', value: `Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}` },
);

// -d 重复：curl 语义用 & 连接
const pd = parseCurl(`curl -d 'a=1' -d 'b=2' https://a.com`);
check('-d 重复用 & 连接', pd?.body, 'a=1&b=2');
check('-d 隐含 POST', pd?.method, 'POST');

// 未知带值开关：宁可少认，不可把它的值错当 URL
const pu2 = parseCurl(`curl --retry 3 https://a.com`);
check('未知开关不吞 URL', pu2?.url, 'https://a.com');

// 双引号体（内含转义引号）
check('双引号体还原', parseCurl(`curl -d "{\\"a\\":1}" https://a.com`)?.body, '{"a":1}');

// ---------- 4) 头部行工具 ----------
check('isSensitiveHeader 命中集', ['Authorization', 'X-Api-Key', 'COOKIE', 'session-token', 'X-Auth-Token'].map(isSensitiveHeader), [
  true, true, true, true, true,
]);
check('isSensitiveHeader 放行', ['Accept', 'Content-Type', 'User-Agent'].map(isSensitiveHeader), [false, false, false]);
check('空键丢弃', Object.keys(rowsToRecord([{ key: '  ', value: 'x' }, { key: 'A', value: '1' }])), ['A']);
check('键大小写不敏感去重（后者胜）', rowsToRecord([{ key: 'accept', value: 'a' }, { key: 'Accept', value: 'b' }]), { Accept: 'b' });
check('敏感值落盘置空', rowsForPersist([{ key: 'Authorization', value: 'Bearer x' }, { key: 'Accept', value: 'json' }]), [
  { key: 'Authorization', value: '' },
  { key: 'Accept', value: 'json' },
]);

// ---------- 5) validateTarget ----------
check('空 URL', validateTarget('   ') !== null, true);
check('缺协议', validateTarget('api.example.com') !== null, true);
check('ftp 协议', validateTarget('ftp://a.com') !== null, true);
check('合法 https', validateTarget('https://a.com/x?y=1'), null);
check('合法 http', validateTarget('http://127.0.0.1:8080/api'), null);

// ---------- 6) statusTone ----------
check('statusTone 分档', [200, 299, 301, 404, 500, 0].map(statusTone), [
  'ok', 'ok', 'info', 'warn', 'error', 'error',
]);

// ---------- 7) prettyBody ----------
check('JSON 美化', prettyBody('{"a":1,"b":[1,2]}'), `{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}`);
check('非 JSON 原样', prettyBody('plain text'), 'plain text');
check('坏 JSON 原样', prettyBody('{"a":}'), '{"a":}');
check('非对象/数组开头原样', prettyBody('"quoted"'), '"quoted"');
check('空串原样', prettyBody(''), '');
check('超 1 MB 不处理', prettyBody(`{${'x'.repeat(1_000_001)}}`), `{${'x'.repeat(1_000_001)}}`);

// ---------- 8) formatDuration / formatSize ----------
check('formatDuration 毫秒', formatDuration(850), '850 ms');
check('formatDuration 秒', formatDuration(1500), '1.50 s');
check('formatDuration 非法', formatDuration(-1), '');
check('formatSize 字节', formatSize(512), '512 B');
check('formatSize KB', formatSize(2048), '2.0 KB');
check('formatSize MB', formatSize(1048576), '1.0 MB');
check('formatSize ≥100 不带小数', formatSize(153600), '150 KB');
check('formatSize GB', formatSize(5 * 1024 ** 3), '5.0 GB');
check('formatSize 非法', formatSize(-5), '');

// ---------- 汇总 ----------
console.log(`PASS ${pass} / FAIL ${fails.length}`);
for (const line of fails) {
  console.log(line);
}
if (fails.length > 0) {
  process.exit(1);
}
