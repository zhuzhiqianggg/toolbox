import type { ToolCategory } from './types';

/**
 * 工具分类常量表（V24）。
 *
 * 为什么需要它：工具箱已经 24 个，后续还会继续加。**平铺网格在 20+ 个工具时必然失控**
 * —— 用户找不到、新工具被埋掉。分类让首页能按场景分组，也让新工具在注册时就必须
 * 回答「你属于哪一类」，这是「易扩展」的第一道约束。
 *
 * 放在 `core/` 而不是 `modules/toolbox/` 是为了层次干净：首页组件（`components/ToolGrid`）
 * 也要读它，共享组件不该反向依赖某个模块目录。
 *
 * 新增分类 = 在本表加一条 + 在 `core/types.ts` 的 `ToolCategory` 联合类型里加同名成员
 * （两边必须一致，`scripts/audit/tool-audit.mjs` 会校验）。
 * 新增**工具**则只需取一个已有分类 id 填进 `CommandMeta.category`。
 */
export interface ToolCategoryMeta {
  id: ToolCategory;
  /** 页签 / 分组标题 */
  name: string;
  /** 一句话说明（悬停与分组副标题用） */
  hint: string;
  /** 图标名（走 `lib/icons.ts` 的 `resolveIcon`，**必须已登记**） */
  icon: string;
  /** 图标底色的 Tailwind 类（浅底 + 深字，static 写法保证被 JIT 扫描到） */
  chip: string;
  /** 排序权重（小的在前） */
  order: number;
}

export const TOOL_CATEGORIES: readonly ToolCategoryMeta[] = [
  {
    id: 'text',
    name: '文本处理',
    hint: '清洗、对比、去重、命名转换',
    icon: 'Type',
    chip: 'bg-sky-50 text-sky-600',
    order: 10,
  },
  {
    id: 'data',
    name: '数据格式',
    hint: 'JSON / SQL / CSV 的排版与互转',
    icon: 'Database',
    chip: 'bg-violet-50 text-violet-600',
    order: 20,
  },
  {
    id: 'encode',
    name: '编码解码',
    hint: 'Base64 / URL / JWT / 摘要 / 图片',
    icon: 'Binary',
    chip: 'bg-emerald-50 text-emerald-600',
    order: 30,
  },
  {
    id: 'convert',
    name: '换算转换',
    hint: '时间戳、相对时间、单位与体积',
    icon: 'ArrowLeftRight',
    chip: 'bg-amber-50 text-amber-600',
    order: 40,
  },
  {
    id: 'security',
    name: '安全存储',
    hint: '密码生成、凭据与密钥保管',
    icon: 'ShieldCheck',
    chip: 'bg-teal-50 text-teal-600',
    order: 45,
  },
  {
    id: 'generate',
    name: '生成器',
    hint: '密码、UUID、二维码',
    icon: 'Sparkles',
    chip: 'bg-rose-50 text-rose-600',
    order: 50,
  },
  {
    id: 'dev',
    name: '开发辅助',
    hint: '正则、Cron、类型定义、码表',
    icon: 'Code2',
    chip: 'bg-indigo-50 text-indigo-600',
    order: 60,
  },
  {
    id: 'utility',
    name: '日常工具',
    hint: '计算、取色、端口、剪贴板历史',
    icon: 'Calculator',
    chip: 'bg-orange-50 text-orange-600',
    order: 12,
  },
];

const CATEGORY_MAP: ReadonlyMap<string, ToolCategoryMeta> = new Map(
  TOOL_CATEGORIES.map((item) => [item.id, item]),
);

/** 按分类 id 取元数据；取不到返回 `undefined`（调用方需自行兜底）。 */
export function categoryMetaOf(id: string | undefined): ToolCategoryMeta | undefined {
  return id ? CATEGORY_MAP.get(id) : undefined;
}

/** 分类 id 是否合法（`tool-audit` 与首页分组共用同一判据）。 */
export function isToolCategory(value: string): value is ToolCategory {
  return CATEGORY_MAP.has(value);
}

/** 按 order 升序的稳定分类序列（首页页签顺序）。 */
export function orderedCategories(): readonly ToolCategoryMeta[] {
  return [...TOOL_CATEGORIES].sort((a, b) => a.order - b.order);
}
