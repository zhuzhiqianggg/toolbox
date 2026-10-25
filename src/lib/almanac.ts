/**
 * 万年历（黄历）数据引擎 —— 纯函数、零依赖、可预测。
 *
 * # 为什么要自己算
 *
 * 用户要「点到某一天能看到阳历 / 农历 / 宜忌 / 冲煞」这类万年历信息。
 * 引入第三方黄历库会带来几十 KB 的表数据和不确定的维护状态，而这里需要的东西
 * 都是**确定性规则**，可以自己算：
 *
 * 1. **日干支**：六十甲子循环，只要一个可靠锚点就能反推任意一天
 *    （锚点：1900-01-01 为甲戌日，序号 10）；
 * 2. **建除十二神**：日支相对「月建」的偏移 —— 与月建同支为「建日」，顺推
 *    除 / 满 / 平 / 定 / 执 / 破 / 危 / 成 / 收 / 开 / 闭；
 * 3. **宜忌**：按十二神查传统宜忌表（这是黄历的通行口径，不是随机编造）；
 * 4. **冲煞**：日支六冲定「冲某生肖」，三合局定「煞某方」。
 *
 * 因此本文件只输出这套规则算得的结果，不涉及任何联网或随机数。
 * 命理内容属于传统民俗，界面上的定位是「参考」，不作决策依据。
 */

import { dayInfo, ganZhi, solarTermDay } from './lunar';

/** 天干（10） */
const STEMS: readonly string[] = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
/** 地支（12） */
const BRANCHES: readonly string[] = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
/** 生肖（与地支一一对应） */
const ZODIAC: readonly string[] = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

/** 建除十二神（沿用传统次序，索引 0..11） */
const JIAN_CHU: readonly string[] = ['建', '除', '满', '平', '定', '执', '破', '危', '成', '收', '开', '闭'];

/** 十二神 → 宜（传统口径，取常用条目，避免界面被长列表淹没） */
const YI: readonly string[][] = [
  ['出行', '祈福', '上任', '会友'],
  ['扫舍', '疗病', '出行', '除服'],
  ['祭祀', '开市', '交易', '置业'],
  ['修造', '平治道涂', '整理', '沐浴'],
  ['嫁娶', '立约', '开市', '祭祀'],
  ['纳财', '修造', '捕捉', '定策'],
  ['求医', '破旧', '坏垣', '解厄'],
  ['祭祀', '安床', '修造', '静养'],
  ['嫁娶', '入学', '开市', '签约'],
  ['纳财', '收账', '入仓', '嫁娶'],
  ['开市', '出行', '入学', '祈福'],
  ['补垣', '筑堤', '安葬', '复盘'],
];

/** 十二神 → 忌（与 `YI` 同序） */
const JI: readonly string[][] = [
  ['动土', '开仓', '安葬', '搬迁'],
  ['求财', '开市', '上任', '宴请'],
  ['上任', '安葬', '求医', '远行'],
  ['祈福', '开光', '求嗣', '签约'],
  ['出行', '诉讼', '安葬', '远游'],
  ['嫁娶', '开市', '出行', '搬迁'],
  ['嫁娶', '开市', '签约', '出行'],
  ['出行', '登高', '嫁娶', '冒险'],
  ['诉讼', '破土', '借贷', '争执'],
  ['开市', '出行', '安葬', '动土'],
  ['安葬', '破土', '收割', '闭门'],
  ['开市', '出行', '求医', '嫁娶'],
];

/**
 * 三合局 → 煞方：申子辰煞南、寅午戌煞北、亥卯未煞西、巳酉丑煞东。
 * 索引即地支序号。
 */
const SHA: readonly string[] = [
  '南', '东', '北', '西', '南', '东', '北', '西', '南', '东', '北', '西',
];

export interface Almanac {
  /** 日干支，如「甲子日」 */
  dayGanZhi: string;
  /** 建除十二神，如「成」 */
  jianChu: string;
  /** 今日宜做（3~4 条） */
  yi: readonly string[];
  /** 今日忌做（3~4 条） */
  ji: readonly string[];
  /** 冲煞，如「冲马 · 煞南」 */
  chongSha: string;
  /** 干支年（如「丙午年 属马」），供详情区展示 */
  yearGanZhi: string;
}

/** UTC 天序号（跨时区 / DST 都稳定，只用来做日期差） */
function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * 日干支序号（0 = 甲子）。
 *
 * 锚点：`1900-01-01` 为**甲戌日**（序号 10，甲=0 天干、戌=10 地支）。
 * 以它为基准按天数取模即可 —— 六十甲子严格每 60 天循环一次，
 * 用「甲戌」而非「甲子」做锚点是因为这一天是公历 1900 年的起点，便于核对。
 */
function ganZhiIndex(ms: number): number {
  const d = new Date(ms);
  const ANCHOR_INDEX = 10;
  const diff = dayNumber(d.getFullYear(), d.getMonth() + 1, d.getDate()) - dayNumber(1900, 1, 1);
  return ((ANCHOR_INDEX + (diff % 60)) + 60) % 60;
}

/**
 * 「节」的 24 节气索引（只用奇数位的中气之外的 12 个节，节气表见 `SOLAR_TERMS`）。
 * 月建随节切换，而不是随农历月初一 —— 立春建寅、惊蛰建卯 … 小寒建丑。
 */
const JIE_TERM_INDEX: readonly number[] = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 0];
/** 与 `JIE_TERM_INDEX` 一一对应的月建地支序号（寅 = 2 … 子 = 0、丑 = 1） */
const JIE_MONTH_BUILD: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1];

/**
 * 某天所属的月建（地支序号）。
 *
 * 取「最近一个已经过去的节」：遍历今年 + 去年的 12 个节，找日期 ≤ 今天且最晚的那个。
 * 例如 1 月 3 日（小寒前）仍属去年大雪所建的子月，1 月 6 日之后转丑月。
 */
function monthBuildOf(year: number, month: number, day: number): number {
  const today = dayNumber(year, month, day);
  let bestDay = Number.NEGATIVE_INFINITY;
  let bestBuild = 2;
  for (let i = 0; i < JIE_TERM_INDEX.length; i += 1) {
    for (const y of [year - 1, year]) {
      const hit = solarTermDay(y, JIE_TERM_INDEX[i]!);
      if (hit === null) {
        continue;
      }
      const termDay = dayNumber(y, hit.month, hit.day);
      if (termDay <= today && termDay > bestDay) {
        bestDay = termDay;
        bestBuild = JIE_MONTH_BUILD[i] ?? 2;
      }
    }
  }
  return bestBuild;
}

/**
 * 某一天的黄历信息。
 *
 * 月建口径：随「节」切换（立春建寅 … 小寒建丑），建除序号 = 日支相对月建的偏移。
 * 这是建除十二神的通行算法。
 */
export function almanacOf(ms: number): Almanac {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();

  const index = ganZhiIndex(ms);
  const stem = STEMS[index % 10] ?? '';
  const branchIndex = index % 12;
  const branch = BRANCHES[branchIndex] ?? '';

  const monthBuild = monthBuildOf(year, month, day);
  const jianChuIndex = ((branchIndex - monthBuild) + 12) % 12;

  const chongBranch = (branchIndex + 6) % 12;
  const gz = ganZhi(year);

  return {
    dayGanZhi: `${stem}${branch}日`,
    jianChu: JIAN_CHU[jianChuIndex] ?? '建',
    yi: YI[jianChuIndex] ?? [],
    ji: JI[jianChuIndex] ?? [],
    chongSha: `冲${ZODIAC[chongBranch] ?? ''} · 煞${SHA[branchIndex] ?? ''}`,
    yearGanZhi: `${gz.ganZhi}年 属${gz.zodiac}`,
  };
}

/** 星期中文（周日在前为 0） */
const WEEKDAYS: readonly string[] = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 选中日的完整描述：详情区直接渲染这一个个字段 */
export interface DayDetail {
  /** 2026年10月25日 */
  solarFull: string;
  /** 星期日 */
  weekday: string;
  /** 农历九月十六（闰月标「闰」） */
  lunarFull: string;
  /** 节气 / 节日名（没有则为 null） */
  special: string | null;
  /** 黄历信息 */
  almanac: Almanac;
}

/** 汇总某天的「阳历 + 农历 + 节气节日 + 宜忌」，给日历详情区用 */
export function dayDetailOf(ms: number): DayDetail {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const info = dayInfo(year, month, day);

  const lunar = info.lunar;
  const lunarFull =
    lunar === null ? '农历未知' : `农历${lunar.monthName}${lunar.dayName}`;

  /** 节日优先于节气：节日是「人」的日子，节气是「天」的刻度 */
  const special =
    info.solarFestival ?? info.lunarFestival ?? info.term ?? null;

  return {
    solarFull: `${year}年${month}月${day}日`,
    weekday: WEEKDAYS[d.getDay()] ?? '',
    lunarFull,
    special,
    almanac: almanacOf(ms),
  };
}
