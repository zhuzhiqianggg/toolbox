/**
 * 智能桌面整理 · 纯函数引擎（前端种子，反馈 REFACTOR 方案 §4）。
 *
 * 定位：把「每次整理都排出最佳布局」的决策抽成**可单测、与平台无关**的纯函数。
 * 它镜像 Rust `grid.rs` 的 `arrange_group_of` / `arrange_group_rank` / `layout_all_boxes`
 * 语义，最终以 Rust 为准（桌面层几何只来自 Rust，不变量 V46）。本文件承担两件事：
 *   ① 归组：按语义放进收纳盒（文件夹 / 图片 / 文档 / 压缩包 / 安装包 / 媒体 / 其他）；
 *      `.lnk` 与系统入口不进铺子、归入「左侧竖条」。
 *   ② 盒内排序：用户排列位（`sort`，升序即更靠前）→ 修改时间新在前 → 名称（稳定兜底）。
 *
 * 不移动任何文件、不写库 —— 只负责「算」，谁用谁自行落库 / 呈现。
 */

/**
 * 桌面条目（与 Rust `ArrangeItemInput` / `GridItem` 的关联字段结构一致）。
 *
 * 刻意**不引 `@/types/*`**：本模块要保持 node 类型剥离可测（回归测试直接 import 源码，
 * 不解析 `@/` 别名），且只用这几个字段；结构对齐即可，无需绑具体类型文件。
 */
export interface ArrangeItemInput {
  name: string;
  isDir: boolean;
  isLnk: boolean;
  ext: string;
  /** 扫描已给类别（文件夹 / 图片 / 文档 / 压缩包 / 安装包 / 其他…） */
  category?: string;
  mtime?: number;
  /** 置顶 / 排位：升序即更靠前（可选） */
  sort?: number;
}

/** 一个收纳盒：标签 + 已排序的条目 */
export interface SmartBox {
  label: string;
  items: ArrangeItemInput[];
}

/** 归组结果 */
export interface ArrangePlan {
  /** 进收纳盒的分组（按 BOX_ORDER 稳定排序） */
  boxes: SmartBox[];
  /** 不进盒子的条目（.lnk / 系统入口），应排在左侧「未归类」竖条 */
  loose: ArrangeItemInput[];
}

/** 音视频扩展名 →「媒体」盒（其余扩展名落回 category / 其他） */
const MEDIA_EXT = new Set([
  '.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma',
  '.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm', '.ts', '.m4v',
]);

/** 语义别名：把扫描给到的 category / 扩展名归一到统一的收纳盒口径 */
function canonicalGroup(category: string | undefined, ext: string): string {
  const cat = (category ?? '').trim();
  if (cat !== '') {
    // 扫描已给出类别（Rust 为准）；额外把音视频类归进「媒体」，与扩展名兜底一致
    if (/媒体|音视频|视频|音频/.test(cat)) return '媒体';
    if (/其它|其他|misc|other/i.test(cat)) return '其他';
    return cat; // 文件夹 / 图片 / 文档 / 压缩包 / 安装包 等原样保留
  }
  if (MEDIA_EXT.has(ext.toLowerCase())) return '媒体';
  return '其他';
}

/** 归组键：.lnk 与系统入口返回 `''`（表示不进盒子，进左侧竖条） */
export function groupKeyOf(item: ArrangeItemInput): string {
  if (item.isLnk) return '';
  if (item.isDir) return '文件夹';
  return canonicalGroup(item.category, item.ext);
}

/** 收纳盒的展示顺序：文件夹最前，「其他」最后 */
const BOX_ORDER: Record<string, number> = {
  文件夹: 0,
  图片: 1,
  文档: 2,
  压缩包: 3,
  安装包: 4,
  媒体: 5,
  其他: 9,
};

function boxRank(label: string): number {
  return BOX_ORDER[label] ?? 6;
}

/** 时间戳兜底：`mtime` 可能是秒 / 毫秒或字符串；统一成可比较数字 */
function toTs(mtime: number | string | undefined): number {
  const n = typeof mtime === 'string' ? Number(mtime) : mtime ?? 0;
  return n > 0 ? n : 0;
}

/**
 * 盒内排序：用户排列位（`sort`，升序即更靠前 → 改动定义的最近排布）→ 修改时间新在前
 * → 名称（zh 数字感知）兜底。纯函数，返回新数组，不改入参。
 */
export function sortGridItems<T extends { name: string; mtime?: number; sort?: number }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => {
    // 用户置顶（放到 .sort 很小 / 显式置顶位）—— 本项目以 sort 升序即"更靠前"来表示
    const pa = typeof a.sort === 'number' ? a.sort : 0;
    const pb = typeof b.sort === 'number' ? b.sort : 0;
    if (pa !== pb) return pa - pb;
    const ma = toTs(a.mtime);
    const mb = toTs(b.mtime);
    if (ma !== mb) return mb - ma;
    return a.name.localeCompare(b.name, 'zh', { numeric: true, sensitivity: 'base' });
  });
}

/** 核心语义盒：即使只有 1 项也保留（用户一眼能认出的收纳盒） */
const CORE_LABELS = new Set(['文件夹', '图片', '文档', '压缩包', '安装包', '媒体']);

/**
 * 单条目盒子是否合并进「其他」：只吞**非常规类别**的单盒（如临时分类 `HTML`），
 * 核心语义盒（图片 / 文档…）就算只收一个文件也保留 —— 否则「最佳布局」会把
 * 有意义的命名盒切成碎片。
 */
function shouldCollapse(label: string, count: number): boolean {
  if (count !== 1 || label === '其他') return false;
  return !CORE_LABELS.has(label);
}

/**
 * 归组 + 盒内排序的主入口。
 *
 * 行为（与 Rust 引擎对齐的"最佳布局"）：
 *   · `.lnk` / 系统入口 → `loose`（左侧竖条）；
 *   · 文件夹自成「文件夹」盒；
 *   · 其余按分类进对应盒，盒内按 `sortGridItems` 排序；
 *   · 只有一个条目的非文件夹盒并入「其他」，桌面不至于一收一堆空盒；
 *   · 盒子按 `BOX_ORDER` 稳定排序。
 */
export function arrangePlan(items: readonly ArrangeItemInput[]): ArrangePlan {
  const buckets = new Map<string, ArrangeItemInput[]>();
  const loose: ArrangeItemInput[] = [];

  for (const item of items) {
    const key = groupKeyOf(item);
    if (key === '') {
      loose.push(item);
      continue;
    }
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }

  const rawBoxes: SmartBox[] = [];
  for (const [label, list] of buckets) {
    if (shouldCollapse(label, list.length)) {
      const other = buckets.get('其他') ?? [];
      other.push(...list);
      buckets.set('其他', other);
      continue;
    }
    rawBoxes.push({ label, items: sortGridItems(list) });
  }
  // 单独处理被并入「其他」后的最终集合
  const seen = new Set(rawBoxes.map((b) => b.label));
  const otherList = buckets.get('其他') ?? [];
  if (otherList.length > 0 && !seen.has('其他')) {
    rawBoxes.push({ label: '其他', items: sortGridItems(otherList) });
  } else if (otherList.length > 0) {
    const t = rawBoxes.find((b) => b.label === '其他');
    if (t) t.items = sortGridItems(otherList);
  }

  rawBoxes.sort((a, b) => boxRank(a.label) - boxRank(b.label) || a.label.localeCompare(b.label, 'zh'));
  return { boxes: rawBoxes, loose };
}

/** 供统计：某条桌面快照下，整理后"sorted"应得到的盒数量与已排序条目数（测试 / 展示用） */
export function planStats(items: readonly ArrangeItemInput[]): { boxes: number; boxed: number; loose: number } {
  const plan = arrangePlan(items);
  return {
    boxes: plan.boxes.length,
    boxed: plan.boxes.reduce((acc, b) => acc + b.items.length, 0),
    loose: plan.loose.length,
  };
}