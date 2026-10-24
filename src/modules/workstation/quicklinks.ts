/**
 * 快捷入口数据层（桌面工作台卡片专用，本迭代仅 localStorage 持久化）。
 *
 * 设计约定（本期范围）：
 *   - **不新增 Rust 命令、不新增 SQLite 表**：快捷入口是纯前端配置项，
 *     以 `toolbox.workstation.quicklinks.v1` 为键存入 localStorage；
 *   - 打开动作走 `ipc.shellOpen`（tauri-plugin-shell `open`，capabilities 已授予
 *     `shell:allow-open`），失败由调用方提示（默认作用域仅放行 http(s)/mailto/tel）；
 *   - 结构化校验：读取时逐条过滤非法数据，避免脏数据导致渲染崩溃。
 */

/** 快捷入口类型：`url` = 网址（http/https），`path` = 本地文件 / 文件夹路径 */
export type QuickLinkType = 'url' | 'path';

/** 快捷入口条目 */
export interface QuickLink {
  id: string;
  /** 展示名（如「公司邮箱」「项目目录」） */
  name: string;
  /** 类型（决定卡片内的图标与打开语义） */
  type: QuickLinkType;
  /** 网址或路径原文 */
  value: string;
  /** 创建时间（Unix 毫秒，用于稳定排序） */
  createdAt: number;
}

/** localStorage 键（版本化，结构变更时递增） */
export const QUICKLINKS_STORAGE_KEY = 'toolbox.workstation.quicklinks.v1';

/** 依据输入值推断类型：http(s) 前缀视为网址，其余视为本地路径 */
export function detectQuickLinkType(value: string): QuickLinkType {
  return /^https?:\/\//i.test(value.trim()) ? 'url' : 'path';
}

/** 生成快捷入口 id（uuid 优先，降级时间戳+随机） */
export function newQuickLinkId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `ql-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 结构守卫：localStorage 反序列化结果逐条校验 */
function isQuickLink(value: unknown): value is QuickLink {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const item = value as Partial<QuickLink>;
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.name === 'string' &&
    typeof item.value === 'string' &&
    (item.type === 'url' || item.type === 'path')
  );
}

/** 读取全部快捷入口（无数据 / 脏数据 / 存储不可用时返回空数组） */
export function loadQuickLinks(): QuickLink[] {
  try {
    const raw = window.localStorage.getItem(QUICKLINKS_STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isQuickLink).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

/** 覆盖保存全部快捷入口（失败静默，下次启动仍以上一次成功快照为准） */
export function saveQuickLinks(links: QuickLink[]): void {
  try {
    window.localStorage.setItem(QUICKLINKS_STORAGE_KEY, JSON.stringify(links));
  } catch {
    // 存储配额 / 隐私模式等场景：不阻断 UI 流程
  }
}
