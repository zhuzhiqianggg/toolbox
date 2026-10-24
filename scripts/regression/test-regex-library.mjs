/**
 * regexLibrary.ts 回归（V25 新增）—— 「示例必须配得上正则」的编写期守卫。
 *
 * # 用户反馈
 *
 * 「正则表达式应该有问题，例如邮箱用示例根本无法匹配，还有其他的示例中的正则和
 *   示例文本没有匹配项目，不知道是哪个错误了」
 *
 * 当时的实测结果是 **30 条里 16 条零命中**：`^...$` 这类整串校验不配 `m` 标志，
 * 又被塞了一段 13 行的多行文本，于是无论怎么点都匹配不上。用户无法分辨
 * 「正则写错了」还是「示例不合适」—— 因为库里没有任何东西为这个组合负责。
 *
 * 这个测试就是那份责任。它守住五条：
 *
 *   1. 每条正则用它自己声明的 flags 都能编译（`-1` 那种情况不许出现）；
 *   2. 每条在**自己的示例文本**里至少有 1 处命中 —— 零命中直接失败；
 *   3. 带断言用例的条目，逐条 `expect` 必须与实际一致（该拒的必须拒）；
 *   4. 「整串校验 + 一列候选值」的条目，命中数必须**小于行数** ——
 *      只放合法值的示例证明不了它会拒绝，等于假示例；
 *   5. 带 `^` / `$` 却不开 `m` 的条目**必须自带文本** —— 这条专门堵住
 *      当初那 14 条的复发路径。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import {
  DEFAULT_SAMPLE_TEXT,
  REGEX_GROUPS,
  REGEX_LIBRARY,
  SAMPLE_TEXTS,
  sampleHitCount,
  sampleTextOf,
} from '../../src/lib/regexLibrary.ts';

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

const keyOf = (entry) => `${entry.group}/${entry.label}`;

/* ================================================================== *
 * 1) 元数据完整性
 * ================================================================== */

ok(`库非空（当前 ${REGEX_LIBRARY.length} 条）`, REGEX_LIBRARY.length > 0);

{
  const seen = new Set();
  let dup = '';
  for (const entry of REGEX_LIBRARY) {
    if (seen.has(keyOf(entry))) {
      dup = keyOf(entry);
    }
    seen.add(keyOf(entry));
  }
  ok('条目名称唯一（key = 分类/名称，界面与缓存都靠它）', dup === '', dup);
}

{
  let badMeta = 0;
  const details = [];
  for (const entry of REGEX_LIBRARY) {
    const problems = [];
    if (!entry.pattern || entry.pattern.trim() === '') problems.push('pattern 为空');
    if (!REGEX_GROUPS.includes(entry.group)) problems.push(`分类 "${entry.group}" 不在 REGEX_GROUPS`);
    if (!entry.description || entry.description.length < 12) problems.push('description 过短');
    if (problems.length > 0) {
      badMeta += 1;
      details.push(`${keyOf(entry)}: ${problems.join(' / ')}`);
    }
  }
  ok('每条都有 pattern / 合法分类 / 足够长的说明', badMeta === 0, details.slice(0, 6).join(' | '));
}

{
  let badSample = 0;
  const details = [];
  const seen = new Set();
  for (const sample of SAMPLE_TEXTS) {
    if (!sample.label || !sample.text || sample.text.trim() === '' || !sample.note) {
      badSample += 1;
      details.push(sample.label || '(无名称)');
    }
    if (seen.has(sample.label)) {
      badSample += 1;
      details.push(`重复名称 ${sample.label}`);
    }
    seen.add(sample.label);
  }
  ok('通用样本：名称唯一、note 非空、文本非空', badSample === 0, details.join(' | '));
  ok('通用样本不少于 5 种场景', SAMPLE_TEXTS.length >= 5, String(SAMPLE_TEXTS.length));
}

ok('默认样本非空', DEFAULT_SAMPLE_TEXT.trim() !== '');

/* ================================================================== *
 * 2) 核心不变量：每条在自己的示例文本里都必须有命中
 * ================================================================== */

{
  const zero = [];
  const invalid = [];
  for (const entry of REGEX_LIBRARY) {
    const hits = sampleHitCount(entry);
    if (hits === -1) {
      invalid.push(keyOf(entry));
    } else if (hits === 0) {
      zero.push(
        `${keyOf(entry)} (flags="${entry.flags}" 文本=${entry.text ? '自带' : '默认混合样本'})`,
      );
    }
  }
  ok('没有编译不过的正则', invalid.length === 0, invalid.join(' | '));
  ok(
    `全库 ${REGEX_LIBRARY.length} 条对自己的示例都有命中`,
    zero.length === 0,
    `${zero.length} 条零命中：${zero.join(' | ')}`,
  );
}

/* ================================================================== *
 * 3) 断言用例：期望必须与实际一致
 * ================================================================== */

{
  let checked = 0;
  const mismatched = [];
  for (const entry of REGEX_LIBRARY) {
    for (const item of entry.cases ?? []) {
      let actual = false;
      try {
        // 每条用例独立编译：带 g / y 标志的正则复用对象会因 lastIndex 漂移而误判
        actual = new RegExp(entry.pattern, entry.flags).test(item.input);
      } catch {
        actual = false;
      }
      checked += 1;
      if (actual !== item.expect) {
        mismatched.push(
          `${keyOf(entry)} · ${JSON.stringify(item.input)} 期望${item.expect} 实际${actual}`,
        );
      }
    }
  }
  ok(`断言用例全部通过（共 ${checked} 条）`, mismatched.length === 0, mismatched.join(' | '));
  ok('带用例的条目不少于 8 条（这是「复杂场景可自证」的底子）', REGEX_LIBRARY.filter((e) => e.cases?.length).length >= 8, String(REGEX_LIBRARY.filter((e) => e.cases?.length).length));
}

/* ================================================================== *
 * 4) 校验类示例必须能「区分」合法与非法
 * ================================================================== */

{
  const suspects = REGEX_LIBRARY.filter((entry) => entry.sampleKind === 'list');
  ok('存在「整串校验 + 候选清单」形态的条目', suspects.length >= 10, String(suspects.length));

  const notDiscriminating = [];
  for (const entry of suspects) {
    const lines = sampleTextOf(entry)
      .split('\n')
      .filter((line) => line.trim() !== '').length;
    const hits = sampleHitCount(entry);
    if (hits >= lines) {
      notDiscriminating.push(`${keyOf(entry)}：${hits} 处命中 / ${lines} 行，示例里没有非法值`);
    }
  }
  ok(
    '候选清单同时含合法与非法值（命中数 < 行数）',
    notDiscriminating.length === 0,
    notDiscriminating.join(' | '),
  );

  // 反向：标成 list 的必须真的开了 m，否则逐行校验不成立
  const missingM = suspects.filter((entry) => !entry.flags.includes('m'));
  ok('标为候选清单的条目都开了 m', missingM.length === 0, missingM.map(keyOf).join(' | '));
}

/* ================================================================== *
 * 5) 堵住复发路径：用了锚点却不开 m 的条目必须自带文本
 *
 * 注意判据是「锚点位置」而不是「模式里出现过 ^ / $」——
 * 正向环视那条 \$(?=\d) 里的 $ 是**转义后的字面量**，不是锚点，不能算。
 * ================================================================== */

{
  const anchored = (pattern) => pattern.startsWith('^') || pattern.endsWith('$');
  const offenders = REGEX_LIBRARY.filter(
    (entry) => anchored(entry.pattern) && !entry.flags.includes('m') && entry.text === undefined,
  );
  ok(
    '带 ^ / $ 锚点但不开 m 的条目都自带文本（否则会退回多行默认样本 → 零命中）',
    offenders.length === 0,
    offenders.map(keyOf).join(' | '),
  );

  // 反向：带锚点又开了 m 的，必须有自带文本才有意义（在默认多行样本上按行校验）
  const mWithoutText = REGEX_LIBRARY.filter(
    (entry) => anchored(entry.pattern) && entry.flags.includes('m') && entry.text === undefined,
  );
  ok(
    '开了 m 的锚点条目也都自带文本',
    mWithoutText.length === 0,
    mWithoutText.map(keyOf).join(' | '),
  );
}

/* ================================================================== *
 * 6) 抽样对照：把几条关键组合钉死，防止将来被「顺手改回去」
 * ================================================================== */

{
  const byKey = new Map(REGEX_LIBRARY.map((entry) => [keyOf(entry), entry]));

  const email = byKey.get('常见校验/邮箱（宽松）');
  ok('邮箱条目存在', email !== undefined);
  if (email) {
    ok('邮箱条目开了 m（否则整串锚点在多行文本里永不命中）', email.flags.includes('m'), email.flags);
    ok('邮箱条目自带候选清单', email.text !== undefined);
    ok('邮箱示例里 zhangsan@example.com 命中', new RegExp(email.pattern, email.flags).test('zhangsan@example.com'));
    ok('邮箱示例里 admin@localhost 被拒', !new RegExp(email.pattern, email.flags).test('admin@localhost'));
    ok(
      '邮箱示例文本确实含这两行',
      sampleTextOf(email).includes('zhangsan@example.com') && sampleTextOf(email).includes('admin@localhost'),
    );
  }

  const phone = byKey.get('常见校验/中国大陆手机号');
  if (phone) {
    ok('手机号示例含带国际区号的非法写法', sampleTextOf(phone).includes('+8613812345678'));
    ok('带国际区号的写法确实被拒', !new RegExp(phone.pattern, phone.flags).test('+8613812345678'));
  }

  const dup = byKey.get('文本处理/重复词检测');
  if (dup) {
    ok('重复词条目指向英文样本（中文 \\b 抓不到，示例要能自证）', /is is/.test(sampleTextOf(dup)));
    ok('重复词示例确实有命中', sampleHitCount(dup) > 0);
  }

  const html = byKey.get('文本处理/剥离 HTML 标签');
  if (html) {
    ok('HTML 条目指向 HTML 样本', /<\w+/.test(sampleTextOf(html)));
    ok('HTML 示例确实有命中', sampleHitCount(html) > 0);
  }

  const redo = byKey.get('进阶与陷阱/⚠ 灾难性回溯（反面教材）');
  if (redo) {
    ok('回溯样本刻意写短（每行 a 不超过 4 个，否则工具自己先卡住）', !/a{5,}/.test(sampleTextOf(redo)), sampleTextOf(redo));
  }

  const ipPort = byKey.get('网络与运维/IP:端口 批量提取');
  if (ipPort) {
    ok('ip:port 条目指向含 ip:port 的样本', /\d+\.\d+\.\d+\.\d+:\d+/.test(sampleTextOf(ipPort)));
  }

  const docker = byKey.get('日志分析/Docker 容器 ID（短/长）');
  if (docker) {
    ok('Docker ID 条目指向含 12 位十六进制的样本', sampleHitCount(docker) > 0);
  }
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
