/**
 * cron.ts「平台判定」回归（V23 新增）。
 *
 * # 为什么这个必须有回归
 *
 * 用户的原话是「请说明 Quartz 语法究竟是什么、在什么场景下会被实际使用，
 * 如果不属于常用语法，请判断是否应当从当前内容中移除以免造成误解」。
 *
 * 我们给出的结论是「保留，但必须标清适用平台」—— 这个结论**落成了代码**
 * （`platformOf`），于是它就有了一个不容含糊的契约：
 *
 *   1. 6 / 7 段、5 段混进 `L` / `W` / `#` / `?`，都**必须**被标成有坑（`risky = true`），
 *      否则「以免造成误解」这句承诺就是空话；
 *   2. **不能误报**：月份别名 `JUL` 含字母 L、星期别名 `WED` 含字母 W，
 *      如果用 `/[LW#]/` 粗筛，最普通的 `0 9 * * WED` 会被打成「Quartz 专用」——
 *      这种假警报比不报警更糟，用户会开始无视提示。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import { analyzeCron, expandMacro, platformOf } from '../../src/lib/cron.ts';

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

/** 一行拿到某表达式的平台判定 */
const info = (expr) => platformOf(analyzeCron(expr));

/* ================================================================== *
 * 1) 标准 5 段：最常用的形态，不该有任何警报
 * ================================================================== */

const standard = info('0 9 * * 1-5');
ok('标准 5 段判定为 unix 平台', standard.platform === 'unix', standard.platform);
ok('标准 5 段无兼容性警告', standard.warnings.length === 0, JSON.stringify(standard.warnings));
ok('标准 5 段不触发警示色', standard.risky === false);
ok('标准 5 段说明里点明 crontab 与 K8s', /crontab/.test(standard.summary) && /CronJob|Kubernetes/.test(standard.summary), standard.summary);
ok('标准 5 段说明里点明「没有秒这一格」', /秒/.test(standard.summary), standard.summary);

/* ================================================================== *
 * 2) Quartz 6 / 7 段：必须明确报警，并点出真实使用场景
 * ================================================================== */

const quartz6 = info('0/30 * * * * ?');
ok('6 段判定为 quartz 平台', quartz6.platform === 'quartz', quartz6.platform);
ok('6 段触发警示色', quartz6.risky === true);
ok('6 段给出「贴进 crontab 会报错」的警告', quartz6.warnings.some((w) => /crontab/.test(w)), JSON.stringify(quartz6.warnings));
ok('6 段警告点明 K8s CronJob 同样只吃 5 段', quartz6.warnings.some((w) => /CronJob/.test(w)));
ok(
  '6 段说明点出真实使用方（Quartz / Spring / XXL-JOB / ElasticJob）',
  ['Quartz Scheduler', 'Spring', 'XXL-JOB', 'ElasticJob'].every((name) => quartz6.summary.includes(name)),
  quartz6.summary,
);

const quartz7 = info('0 0 12 ? * MON-FRI 2026');
ok('7 段判定为 quartz 平台', quartz7.platform === 'quartz', quartz7.platform);
ok('7 段也触发警示色', quartz7.risky === true);

/* ================================================================== *
 * 3) 5 段里混进 Quartz 专用符号：最阴的坑（段数对、但 crontab 不认）
 * ================================================================== */

const lastDay = info('59 23 L * *');
ok('5 段里的 L 被标记为 Quartz 专用', lastDay.risky === true);
ok('5 段里的 L 给出针对性警告', lastDay.warnings.some((w) => w.includes('L')), JSON.stringify(lastDay.warnings));
ok('5 段里的 L 不被误判成 quartz 平台（段数仍是 5）', lastDay.platform === 'unix', lastDay.platform);

const nearest = info('0 0 15W * *');
ok('5 段里的 15W 被标记', nearest.risky === true);

const nth = info('0 10 * * 1#2');
ok('5 段里的 1#2 被标记', nth.risky === true);

const question = info('0 9 ? * 1');
ok('5 段里的 ? 被标记', question.risky === true);
ok('5 段里的 ? 警告建议改成 *', question.warnings.some((w) => w.includes('*')), JSON.stringify(question.warnings));

/* ================================================================== *
 * 4) 假警报守卫：别名里的 L / W 不是 Quartz 语法
 * ================================================================== */

// ⚠️ 'JUL' 含 L、'WED' 含 W —— 粗筛 /[LW#]/ 会在这里炸出一堆假警报
const wednesday = info('0 9 * * WED');
ok('星期别名 WED 不被误报为 Quartz', wednesday.risky === false, JSON.stringify(wednesday.warnings));
ok('WED 保持标准 5 段判定', wednesday.platform === 'unix');

const july = info('0 0 1 JUL *');
ok('月份别名 JUL 不被误报为 Quartz', july.risky === false, JSON.stringify(july.warnings));

const satL = info('0 9 * * SAT');
ok('SAT 不含 L/W，不受影响', satL.risky === false);

const manyAliases = info('0 0 1 JAN,MAR,JUL *');
ok('别名列表里混 JUL 也不误报', manyAliases.risky === false, JSON.stringify(manyAliases.warnings));

/* ================================================================== *
 * 5) 宏写法
 * ================================================================== */

const daily = info('@daily');
ok('宏判定为 unix 平台', daily.platform === 'unix');
ok('宏的形态标签是「宏写法」', daily.title === '宏写法', daily.title);
ok('宏说明点明谁支持（cronie / Vixie）', /cronie|Vixie/.test(daily.summary), daily.summary);
ok('宏无警告（合法写法）', daily.risky === false && daily.warnings.length === 0);

const reboot = info('@reboot');
ok('@reboot 合法且 ok', reboot.risky === false);

const badMacro = info('@everyday');
ok('未知宏触发警告', badMacro.risky === true, JSON.stringify(badMacro.warnings));

/* ================================================================== *
 * 6) 宏展开（界面上「展开成 5 段继续编辑」按钮的依据）
 * ================================================================== */

ok('@daily 展开', expandMacro('@daily') === '0 0 * * *', String(expandMacro('@daily')));
ok('@hourly 展开', expandMacro('@hourly') === '0 * * * *');
ok('@weekly 展开', expandMacro('@weekly') === '0 0 * * 0');
ok('@monthly 展开', expandMacro('@monthly') === '0 0 1 * *');
ok('@yearly 与 @annually 同义', expandMacro('@yearly') === expandMacro('@annually'));
ok('宏展开大小写不敏感', expandMacro('@DAILY') === '0 0 * * *', String(expandMacro('@DAILY')));
ok('前后空白不影响宏展开', expandMacro('  @daily  ') === '0 0 * * *');
ok('非宏返回 null', expandMacro('0 9 * * *') === null);
ok('@reboot 没有等价 5 段（返回 null，界面不显示按钮）', expandMacro('@reboot') === null);
ok('展开后的表达式本身可解析', analyzeCron(expandMacro('@daily')).ok === true);

/* ================================================================== *
 * 7) 展开后的表达式落到标准 5 段（界面按钮填进去后不会自己变成 Quartz）
 * ================================================================== */

for (const macro of ['@daily', '@hourly', '@weekly', '@monthly', '@yearly']) {
  const expanded = expandMacro(macro);
  const platform = platformOf(analyzeCron(expanded));
  ok(`${macro} 展开后仍是标准 5 段且无警告`, platform.platform === 'unix' && platform.risky === false, `${expanded} → ${JSON.stringify(platform.warnings)}`);
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
