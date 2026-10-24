/**
 * lunar.ts 回归：农历换算、闰月、节气、干支生肖、徽标优先级，
 * 外加「连续 3 年逐日不崩、无重复、日序合法」——闰月位表最容易在这里翻车。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import { solarToLunar, solarTermOf, ganZhi, dayInfo } from '../../src/lib/lunar.ts';

const lines = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  lines.push(`${ok ? 'PASS' : 'FAIL'} | ${label} | got=${actual} | want=${expected}`);
};

/** 春节（农历正月初一）既知日期 */
const springDates = [
  [1990, 1, 27],
  [2000, 2, 5],
  [2024, 2, 10],
  [2025, 1, 29],
  [2026, 2, 17],
  [2027, 2, 6],
];
for (const [y, m, d] of springDates) {
  const c = solarToLunar(y, m, d);
  check(`${y} 春节`, c ? `${c.year}/${c.month}/${c.day}/${c.leap}` : 'null', `${y}/1/1/false`);
}

/** 中秋（八月十五） */
for (const [y, m, d] of [[2024, 9, 17], [2025, 10, 6], [2026, 9, 25]]) {
  const c = solarToLunar(y, m, d);
  check(`${y} 中秋`, c ? `${c.month}/${c.day}` : 'null', '8/15');
}

/** 端午（五月初五） */
for (const [y, m, d] of [[2024, 6, 10], [2025, 5, 31], [2026, 6, 19]]) {
  const c = solarToLunar(y, m, d);
  check(`${y} 端午`, c ? `${c.month}/${c.day}` : 'null', '5/5');
}

/** 闰月 */
const leap1 = solarToLunar(2023, 3, 22);
check('2023-03-22', leap1 ? `${leap1.leap}/${leap1.monthName}/${leap1.dayName}` : 'null', 'true/闰二月/初一');
const leap2 = solarToLunar(2025, 7, 25);
check('2025-07-25', leap2 ? `${leap2.leap}/${leap2.monthName}` : 'null', 'true/闰六月');

/** 除夕与腊月 */
check('2025 除夕', dayInfo(2025, 1, 28).lunarFestival, '除夕');
check('2026 除夕', dayInfo(2026, 2, 16).lunarFestival, '除夕');
const cnyEve = solarToLunar(2026, 2, 15);
check('2026-02-15', cnyEve ? `${cnyEve.monthName}${cnyEve.dayName}` : 'null', '腊月廿八');

/** 节气 */
for (const [label, y, m, d, want] of [
  ['2026 立春', 2026, 2, 4, '立春'],
  ['2025 立春', 2025, 2, 3, '立春'],
  ['2024 春分', 2024, 3, 20, '春分'],
  ['2026 清明', 2026, 4, 5, '清明'],
  ['2026 冬至', 2026, 12, 21, '冬至'],
  ['2025 冬至', 2025, 12, 21, '冬至'],
]) {
  const got = solarTermOf(y, m, d) ?? solarTermOf(y, m, d + 1) ?? solarTermOf(y, m, d - 1);
  check(label, got, want);
}

/** 干支 / 生肖 */
check('2026 干支', `${ganZhi(2026).ganZhi}${ganZhi(2026).zodiac}`, '丙午马');
check('2025 干支', `${ganZhi(2025).ganZhi}${ganZhi(2025).zodiac}`, '乙巳蛇');
check('1984 干支', `${ganZhi(1984).ganZhi}${ganZhi(1984).zodiac}`, '甲子鼠');

/** 范围外 */
check('1899 超范围', solarToLunar(1899, 12, 31), 'null');
check('2101 超范围', solarToLunar(2101, 1, 1), 'null');

/** 日历徽标优先级 */
check('2026-01-01 徽标', dayInfo(2026, 1, 1).badge, '元旦');
check('2026-02-17 徽标', dayInfo(2026, 2, 17).badge, '春节');
check('2026-10-01 徽标', dayInfo(2026, 10, 1).badge, '国庆节');

/** 连续 3 年逐日：不崩、无重复、日序合法 */
let seqOk = true;
let reason = '';
let prevKey = '';
let count = 0;
const start = Date.UTC(2025, 0, 1);
for (let i = 0; i < 1096; i += 1) {
  const d = new Date(start + i * 86400000);
  const cur = solarToLunar(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  if (!cur) {
    seqOk = false;
    reason = `day ${i} null`;
    break;
  }
  count += 1;
  const key = `${cur.year}-${cur.leap ? 'L' : ''}${cur.month}-${cur.day}`;
  if (key === prevKey) {
    seqOk = false;
    reason = `duplicate ${key}`;
    break;
  }
  prevKey = key;
  if (cur.day < 1 || cur.day > 30) {
    seqOk = false;
    reason = `bad day ${cur.day}`;
    break;
  }
}
check(`连续 ${count} 天可解析且无重复`, seqOk ? 'true' : reason, 'true');

lines.push('');
const failed = lines.filter((l) => l.startsWith('FAIL')).length;
lines.push(`FAILED=${failed}`);
console.log(lines.join('\n'));
process.exit(failed === 0 ? 0 : 1);
