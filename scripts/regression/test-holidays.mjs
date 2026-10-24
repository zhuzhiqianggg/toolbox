/**
 * holidays.ts 回归：数据表是纯手工录入的行政安排，一个字符打错就是日历上一个错徽标。
 * 这里用「全年逐日统计」把区间总天数钉死，能一次性兜住「区间写反 / 少写一天 / 调休漏配」。
 *
 * 直接 import 源码 `.ts`（Node ≥ 22.18 原生类型剥离，无需打包）。
 */
import { holidayOf, HOLIDAY_YEARS, HOLIDAY_LATEST_YEAR, upcomingHolidays } from '../../src/lib/holidays.ts';

const lines = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  lines.push(`${ok ? 'PASS' : 'FAIL'} | ${label} | got=${actual} | want=${expected}`);
};

/** 逐年统计：放假 / 调休 / 周末 / 工作日 */
const stat = (year) => {
  const acc = { holiday: 0, makeup: 0, weekend: 0, workday: 0 };
  for (let month = 1; month <= 12; month += 1) {
    const last = new Date(year, month, 0).getDate();
    for (let day = 1; day <= last; day += 1) {
      acc[holidayOf(year, month, day).kind] += 1;
    }
  }
  return acc;
};

check('覆盖年份', HOLIDAY_YEARS.join(','), '2024,2025,2026');
check('最新年份', HOLIDAY_LATEST_YEAR, 2026);

// 全年逐日统计（官方口径：2024 = 1+8+3+5+3+3+7 = 30；2025 = 1+8+3+5+3+8 = 28；
// 2026 = 3+9+3+5+3+3+7 = 33）
check('2024 放假天数', stat(2024).holiday, 30);
check('2025 放假天数', stat(2025).holiday, 28);
check('2026 放假天数', stat(2026).holiday, 33);
check('2024 调休天数', stat(2024).makeup, 8);
check('2025 调休天数', stat(2025).makeup, 5);
check('2026 调休天数', stat(2026).makeup, 6);

// 三种 kind 互斥且齐全：全年天数 = 四类之和
for (const year of HOLIDAY_YEARS) {
  const s = stat(year);
  const total = s.holiday + s.makeup + s.weekend + s.workday;
  const daysInYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  check(`${year} 四类之和 = 全年天数`, total, daysInYear);
}

// 边界：区间首日 / 末日都算放假，前后一天不算
check('2026 春节首日', holidayOf(2026, 2, 15).name, '春节');
check('2026 春节末日', holidayOf(2026, 2, 23).name, '春节');
check('2026 春节后一天不是春节', holidayOf(2026, 2, 24).name, 'null');
check('2026 春节 9 天', upcomingHolidays(new Date(2026, 0, 5).getTime(), 1)[0].days, 9);
check('2025 国庆中秋 8 天', upcomingHolidays(new Date(2025, 8, 1).getTime(), 1)[0].name, '国庆节·中秋节');
check('2025 国庆中秋天数', upcomingHolidays(new Date(2025, 8, 1).getTime(), 1)[0].days, 8);

// 调休优先于周末：2026-10-10（周六）应判为「上班」
check('2026-10-10 是调休', holidayOf(2026, 10, 10).kind, 'makeup');
check('2026-10-10 不休息', holidayOf(2026, 10, 10).off, false);
// 2026-02-14（周六）春节调休
check('2026-02-14 是调休', holidayOf(2026, 2, 14).kind, 'makeup');
// 普通周末
check('2026-03-07 是周末', holidayOf(2026, 3, 7).kind, 'weekend');
check('2026-03-07 休息', holidayOf(2026, 3, 7).off, true);
// 普通工作日
check('2026-03-09 是工作日', holidayOf(2026, 3, 9).kind, 'workday');
check('2026-03-09 不休息', holidayOf(2026, 3, 9).off, false);

// 未收录年份：known=false，且不假装是工作日之外的判断（周末仍按周末算）
check('2023 未收录', holidayOf(2023, 10, 1).known, false);
check('2026 已收录', holidayOf(2026, 10, 1).known, true);

// 「下一个假期」：基准日正好落在假期里 → inDays = 0
const during = upcomingHolidays(new Date(2026, 9, 3).getTime(), 1);
check('假期中 inDays', during[0].inDays, 0);
check('假期中名称', during[0].name, '国庆节');
check('limit 生效', upcomingHolidays(new Date(2026, 0, 5).getTime(), 3).length, 3);
// 已过去的假期不再返回
check('年底只剩已过假期 → 空', upcomingHolidays(new Date(2026, 11, 31).getTime(), 3).length, 0);

lines.push('');
const failed = lines.filter((l) => l.startsWith('FAIL')).length;
lines.push(`FAILED=${failed}`);
console.log(lines.join('\n'));
process.exit(failed === 0 ? 0 : 1);
