/**
 * detect / contentMatch（内容识别启发式）回归 —— V27。
 *
 * 背景：建议条（SearchSuggest）会把识别结果变成「一键直达」推荐，所以**误报是用户可见的**。
 * V27 之前，`www.example.com`、`1.2.3`、`v1.2.3`、`file.name.txt` 会被判成 JWT 并弹
 * 「解析 JWT 载荷」，`Feedback` / `Password` 这类 8 字母单词会被判成 Base64 ——
 * 全是「不报错、只给错答案」。本套件用**真实常见输入表**把它们钉死。
 *
 * 锚点：
 *  - JWT 结构来自 RFC 7515 §4（受保护头部 = base64url 编码的 JSON 对象）；
 *  - 真实 JWT 用 jwt.io 公开示例令牌；
 *  - Base64 期望值用 node:crypto 现算，不硬编码；
 *  - 命令 id 映射必须指向 `toolboxCommands` 里**真实注册**的命令（防改 id 后建议条静默失效）。
 */
import { Buffer } from 'node:buffer';

const { detectContent, detectFirst } = await import('../../src/lib/detect.ts');
const { isFilePath, classifyClip, matchClipContent, SUGGESTED_COMMAND_NAMES, MATCH_TYPE_LABELS } =
  await import('../../src/lib/contentMatch.ts');
const { toolboxCommands } = await import('../../src/modules/toolbox/commands/index.ts');

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
function kinds(text) {
  return detectContent(text).map((d) => d.kind);
}

// ---------- 1) 常见非 JWT 三段式文本：不得再误报 ----------
const notJwt = [
  '1.2.3',
  'v1.2.3',
  '2.0.1',
  'a.b.c',
  'release-1.2.3',
  'file.name.txt',
  'foo.json.bak',
  'www.example.com',
  '192.168.1.1',
  'node.index.js',
];
for (const text of notJwt) {
  check(`非 JWT「${text}」`, kinds(text).includes('jwt'), false);
}

// ---------- 2) 真 JWT（jwt.io 公开示例令牌）仍必须命中 ----------
const jwtio =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
check('jwt.io 示例令牌 → jwt', kinds(jwtio).includes('jwt'), true);
check(
  'jwt.io 示例令牌 first → jwt-decoder',
  detectFirst(jwtio)?.commandId,
  'jwt-decoder',
);
// 头部解不出 JSON 对象的三段式：即便字符集合法也不是 JWT
check('头部非 JSON 对象 → 不是 JWT', kinds('eyJhIjox.eyJiIjoy.abcdefghij').includes('jwt'), false);
// 签名段允许 base64url 全字符集
check(
  '带 - _ 的签名段仍命中',
  kinds('eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.AbCd-_12EfGh_3-IjKl').includes('jwt'),
  true,
);

// ---------- 3) 8 字母单词不是 Base64（解码结果不是合法 UTF-8） ----------
const notBase64 = ['Feedback', 'Password', 'TestCase', 'abcdefgh', 'DataBase', 'Username', 'qwertyuiop'];
for (const text of notBase64) {
  check(`英文单词「${text}」不是 Base64`, kinds(text).includes('base64'), false);
}
// 真实文本的 Base64 必须命中 —— 期望值用 node:crypto 现算
const realTexts = ['hello world', '你好，世界', 'Handy · 顺手'];
for (const text of realTexts) {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  if (encoded.length < 8) {
    fails.push(`FAIL | 测试文本过短，编码后不足 8 字符：${text}`);
    continue;
  }
  check(`真实 Base64「${encoded}」`, kinds(encoded).includes('base64'), true);
}
// pad 与 + / 字符
check('带 = 与 + 的 Base64', kinds('aGVsbG8+eD0=') .includes('base64'), true);
check('「AB==」太短', kinds('AB=='), []);

// ---------- 4) URL / JSON / 时间戳 ----------
check('URL', kinds('https://example.com/a?b=1'), ['url']);
check('JSON 对象', kinds('{"a":1}'), ['json']);
check('JSON 数组', kinds('[1,2,3]'), ['json']);
check('10 位时间戳', kinds('1737000000'), ['timestamp']);
check('13 位时间戳', kinds('1737000000000'), ['timestamp']);
check('1999 年不在窗口内', kinds('946684800'), []);
check('普通句子不命中', kinds('hello world'), []);
check('日期串不命中', kinds('2024-01-01'), []);

// ---------- 5) 优先级顺序（json > jwt > url > timestamp > base64） ----------
check('顺序', detectContent(jwtio).map((d) => d.kind)[0], 'jwt');

// ---------- 6) contentMatch：文件路径识别 ----------
const pathCases = [
  ['C:\\Users\\me\\file.txt', true],
  ['c:\\a\\b', true],
  ['D:\\', true],
  ['C:/Users/me', true], // V27：正斜杠盘符路径同样合法
  ['c:/a/b/c.txt', true],
  ['\\\\server\\share\\file', true],
  ['\\\\srv\\a', true],
  ['/usr/local/bin', true],
  ['/a', true],
  ['/a/b/', true],
  ['/', false],
  ['a/b/c', false],
  ['./a/b', false],
  ['../x', false],
  ['/a b', false],
  ['http://x/y', false],
  ['嗯', false],
  ['\\server', false],
  ['', false],
  ['  C:\\a\\b  ', true], // trim 后判定
];
for (const [text, want] of pathCases) {
  check(`isFilePath「${text}」`, isFilePath(text), want);
}

// ---------- 7) classifyClip / matchClipContent ----------
check('classifyClip(image)', classifyClip('x', 'image'), 'image');
check('classifyClip(file)', classifyClip('x', 'file'), 'file-path');
check('classifyClip(路径内容)', classifyClip('C:\\a\\b'), 'file-path');
check('classifyClip(普通文本)', classifyClip('hello'), 'text');

const clipJwt = matchClipContent(jwtio);
check('clip JWT 类型', clipJwt?.type, 'jwt');
check('clip JWT 直达', clipJwt?.suggestedCommandId, 'jwt-decoder');
const clipUrl = matchClipContent('https://example.com/a');
check('clip URL 直达（二维码）', clipUrl?.suggestedCommandId, 'qrcode-generator');
const clipJson = matchClipContent('{"a":1}');
check('clip JSON 直达', clipJson?.suggestedCommandId, 'json-formatter');
const clipTs = matchClipContent('1737000000');
check('clip 时间戳直达', clipTs?.suggestedCommandId, 'timestamp');
const clipPath = matchClipContent('C:\\a\\b.txt');
check('clip 文件路径', clipPath?.type, 'file-path');
check('clip 文件路径无直达', clipPath?.suggestedCommandId, undefined);
check('clip 普通文本无推荐', matchClipContent('hello world'), null);
// V27 修复的直接体现：三段式版本号不再给出任何推荐
check('版本号不再误推荐', matchClipContent('1.2.3'), null);
check('域名不再误推荐', matchClipContent('www.example.com'), null);

// ---------- 8) 建议的命令 id 必须真实注册（防改 id 后静默失效） ----------
const registeredIds = new Set(toolboxCommands.map((c) => c.id));
const suggested = new Set(Object.keys(SUGGESTED_COMMAND_NAMES));
const probeTargets = [
  clipJwt?.suggestedCommandId,
  matchClipContent('https://x.com')?.suggestedCommandId,
  matchClipContent('{"a":1}')?.suggestedCommandId,
  matchClipContent('1737000000')?.suggestedCommandId,
].filter((v) => v !== undefined);
for (const id of [...suggested, ...probeTargets]) {
  check(`建议命令「${id}」已注册`, registeredIds.has(id), true);
}
// 展示名表必须覆盖所有可直达类型
for (const label of Object.values(MATCH_TYPE_LABELS)) {
  if (typeof label !== 'string' || label.length === 0) {
    fails.push(`FAIL | MATCH_TYPE_LABELS 存在空标签`);
  }
}

// ---------- 汇总 ----------
console.log(`PASS ${pass} / FAIL ${fails.length}`);
for (const line of fails) {
  console.log(line);
}
if (fails.length > 0) {
  process.exit(1);
}
