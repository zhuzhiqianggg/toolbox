/**
 * cron.ts 回归：段位映射、buildCron 全部模式、以及「33 条预设必须全部可解析」——
 * 预设是用户点一下就填进输入框的，只要有一条填进去是红的，工具就露馅了。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import { analyzeCron, buildCron, fieldLayout, CRON_PRESETS } from '../../src/lib/cron.ts';

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

// —— 1) fieldLayout：5/6/7 段各归位，其它段数为 null ——
const l5 = fieldLayout(5);
const l6 = fieldLayout(6);
const l7 = fieldLayout(7);
ok('fieldLayout(5) 段数=5', l5 !== null && l5.length === 5, JSON.stringify(l5?.map((s) => s.label)));
ok('fieldLayout(5) 首段是「分」', l5?.[0]?.key === 'minute');
ok('fieldLayout(6) 段数=6', l6 !== null && l6.length === 6);
ok('fieldLayout(6) 首段是「秒」', l6?.[0]?.key === 'second');
ok('fieldLayout(7) 段数=7', l7 !== null && l7.length === 7);
ok('fieldLayout(7) 末段是「年」', l7?.[6]?.key === 'year');
ok('fieldLayout(4) = null', fieldLayout(4) === null);
ok('fieldLayout(0) = null', fieldLayout(0) === null);
ok('每段都有 hint', (l6 ?? []).every((s) => typeof s.hint === 'string' && s.hint.length > 0));

// —— 2) buildCron 全部模式 ——
const base = { every: 5, hour: 9, minute: 30, weekday: 1, weekdayTo: 5, day: 1, days: [1, 15] };
const cases = [
  ['seconds', { ...base, mode: 'seconds' }, '0/5 * * * * ?'],
  ['seconds 1 秒', { ...base, mode: 'seconds', every: 1 }, '* * * * * ?'],
  ['minutes', { ...base, mode: 'minutes' }, '*/5 * * * *'],
  ['minutes 1', { ...base, mode: 'minutes', every: 1 }, '* * * * *'],
  ['hours', { ...base, mode: 'hours' }, '0 */5 * * *'],
  ['daily', { ...base, mode: 'daily' }, '30 9 * * *'],
  ['weekly', { ...base, mode: 'weekly' }, '30 9 * * 1'],
  ['weeklyRange', { ...base, mode: 'weeklyRange' }, '30 9 * * 1-5'],
  ['weekdays', { ...base, mode: 'weekdays' }, '30 9 * * 1-5'],
  ['monthly', { ...base, mode: 'monthly' }, '30 9 1 * *'],
  ['dayList 去重排序', { ...base, mode: 'dayList', days: [15, 1, 15] }, '30 9 1,15 * *'],
  ['dayList 空数组兜底', { ...base, mode: 'dayList', days: [], day: 7 }, '30 9 7 * *'],
  ['lastDay', { ...base, mode: 'lastDay' }, '30 9 L * ?'],
];
for (const [name, input, expect] of cases) {
  const got = buildCron(input);
  ok(`buildCron ${name}`, got === expect, `期望 ${expect}，实得 ${got}`);
}

// 生成的表达式本身必须是合法可解析的
for (const [, input] of cases) {
  const expr = buildCron(input);
  const analysis = analyzeCron(expr, Date.UTC(2026, 8, 15, 1, 0, 0));
  ok(`生成结果可解析 ${expr}`, analysis.ok, analysis.error ?? '');
}

// —— 3) 越界参数被夹住，不产生 NaN ——
ok('every 越界夹到 59', buildCron({ ...base, mode: 'minutes', every: 999 }) === '*/59 * * * *');
ok('every 0 夹到 1', buildCron({ ...base, mode: 'hours', every: 0 }) === '0 */1 * * *');
ok('weekday 越界夹到 6', buildCron({ ...base, mode: 'weekly', weekday: 99 }) === '30 9 * * 6');

// —— 4) 全部预设必须合法（用户点一下就填进输入框） ——
const now = Date.UTC(2026, 8, 15, 1, 0, 0);
for (const preset of CRON_PRESETS) {
  const analysis = analyzeCron(preset.expr, now);
  ok(`预设「${preset.label}」= ${preset.expr}`, analysis.ok, analysis.error ?? '');
  ok(`预设「${preset.label}」有中文描述`, analysis.summary.length > 0);
}
ok(
  `预设数量 ≥ 30（实际 ${CRON_PRESETS.length}）`,
  CRON_PRESETS.length >= 30,
  String(CRON_PRESETS.length),
);

// —— 5) 关键语义：*/5 就是每 5 分钟 ——
const every5 = analyzeCron('*/5 * * * *', now);
ok('*/5 可解析', every5.ok, every5.error ?? '');
ok('*/5 分段落值 = 0,5,...,55', JSON.stringify(every5.fields[0]?.values) === JSON.stringify([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]));
ok('*/5 次数 = 12/小时', every5.fields[0]?.values?.length === 12);
const nextList = every5.next;
let stepOk = nextList.length >= 3;
for (let i = 1; i < nextList.length; i += 1) {
  if (nextList[i] - nextList[i - 1] !== 300000) {
    stepOk = false;
  }
}
ok('*/5 相邻执行间隔正好 5 分钟', stepOk, JSON.stringify(nextList.slice(0, 3)));

// —— 6) 秒级（Quartz 6 段）最小粒度 1 秒；`0/10` = 从 0 起每 10 秒（Quartz 语义） ——
const every10s = analyzeCron('0/10 * * * * ?', now);
ok('0/10 秒可解析', every10s.ok, every10s.error ?? '');
ok('0/10 秒 form=quartz', every10s.form === 'quartz');
ok('0/10 秒 8 次执行在 2 分钟内', every10s.next.length === 8 && every10s.next[7] - every10s.next[0] === 70000);

// —— 7) 逐段编辑会用到的：段数与 fields 一一对应 ——
const six = analyzeCron('0 30 9 * * ?', now);
ok('6 段 fields 长度 = 6', six.fields.length === 6, String(six.fields.length));
ok('6 段 fields 顺序 = 秒分时日月周', six.fields.map((f) => f.key).join(',') === 'second,minute,hour,dayOfMonth,month,dayOfWeek');

// —— 8) 中文文案（2026-09-16 用户反馈：日段灰字只有裸数字、星期写成「1 至 5星期」、
// summary 拼出「每月3」「第 每 5 分」病句，且黄条把 Quartz 的 ? 说成能表达「且」）——
// 以下期望串全部经探针逐字符核对；summary 锁死措辞，防止文案再悄悄劣化。
const d = (expr) => analyzeCron(expr, now);
ok('文案 日段单值带单位', d('*/5 * 3 5 1-5').fields[2]?.text === '3日');
ok('文案 星期区间用中文名', d('*/5 * 3 5 1-5').fields[4]?.text === '周一 至 周五');
ok('文案 月份单值', d('*/5 * 3 5 1-5').fields[3]?.text === '5月');
ok('文案 日/周取或点破「或」字', d('*/5 * 3 5 1-5').summary === '5月的每月3日 或 每周一至周五（满足其一） 每 5 分钟 执行', d('*/5 * 3 5 1-5').summary);
ok('文案 每5分钟自成一句', d('*/5 * * * *').summary === '每天 每 5 分钟 执行', d('*/5 * * * *').summary);
ok('文案 工作日 9 点', d('0 9 * * 1-5').summary === '每周一至周五 09:00 执行', d('0 9 * * 1-5').summary);
ok('文案 小时步长+分钟单值带单位', d('0 */2 * * *').summary === '每天 每 2 时，第 0 分 执行', d('0 */2 * * *').summary);
ok('文案 仅限月份=「5月的每天」', d('0 0 * 5 *').summary === '5月的每天 00:00 执行', d('0 0 * 5 *').summary);
ok('文案 多日列表', d('0 0 1,15 * *').summary === '每月1日、15日 00:00 执行', d('0 0 1,15 * *').summary);
ok('文案 单个星期', d('0 1 * * 1').summary === '每周一 01:00 执行');
ok('文案 星期步长列出中文名', d('*/2 * * * 0').fields[4]?.text === '周日' && d('*/5 * * * 2').fields[4]?.text === '周二');
ok('文案 月份步长列出中文名', d('0 0 * */2 *').fields[3]?.text === '1月、3月、5月、7月、9月、11月', d('0 0 * */2 *').fields[3]?.text);
ok('文案 月份步长进 summary 当前提', d('0 0 * */2 *').summary === '1月、3月、5月、7月、9月、11月的每天 00:00 执行', d('0 0 * */2 *').summary);
ok('文案 dom 步长超 12 个退回紧凑写法', d('0 0 */2 * *').fields[2]?.text === '1-31 每 2 日', d('0 0 */2 * *').fields[2]?.text);
ok('文案 L 最后一天', d('0 0 L * ?').summary === '每月最后一天 00:00 执行', d('0 0 L * ?').summary);
ok('文案 第 n 个周一挂「每月」', d('0 10 ? * 1#2').summary === '每月第 2 个周一 10:00 执行', d('0 10 ? * 1#2').summary);
ok('文案 月份+日=前提式', d('0 0 1 1 *').summary === '1月的每月1日 00:00 执行', d('0 0 1 1 *').summary);

console.log([`PASS ${pass}`, `FAIL ${fail}`, ...bad.map((item) => `  ✗ ${item}`)].join('\n'));
process.exit(fail === 0 ? 0 : 1);
