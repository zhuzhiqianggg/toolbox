import type { ComponentType, ReactNode } from 'react';
import type { Platform } from '@/types/platform';
import type { CommandLayout, ModuleSurface, WindowKind } from '@/types/window';

/**
 * 模块 / 功能（命令）双层注册契约（ARCHITECTURE ADR-6 / §4.1）。
 *
 * - 模块（Module）= 顶层功能域（M1…M11），拥有独立承载形态、生命周期与扩展点贡献；
 * - 功能（Command）= 挂靠模块下的轻量能力，命令面板的搜索/收藏/最近/复制外壳自动生效。
 *
 * 平台/窗口类基础类型复用 V03 已在 `src/types/*` 定义的集合，避免重复定义。
 */
export type { Platform };
export type { CommandLayout, ModuleSurface, WindowKind };

/** 功能分级（授权预留，ADR-10） */
export type Tier = 'free' | 'pro';

/** 主题模式（设置中心） */
export type ThemeMode = 'light' | 'dark' | 'system';

/** 独立窗口 / 面板内页的模块视图入参 */
export interface ModuleProps {
  /** 承载窗口类型 */
  windowKind?: WindowKind;
  /** 上下文（如 `{ noteId: 'xxx' }`） */
  context?: Record<string, string>;
}

/** 命令组件入参（沿用 v1 ToolProps 语义，新增跨模块跳转） */
export interface CommandProps {
  /** 初始输入（如来自剪贴板建议 / 历史） */
  initialInput?: string;
  /** 输入来源 */
  source?: 'clipboard' | 'history' | 'command' | 'manual';
  /** 使用回调（写入最近使用） */
  onUsed?: (id: string) => void;
  /** 跨模块跳转（便签↔剪贴板互转等） */
  onRequestModule?: (moduleId: string, payload?: unknown) => void;
}

/** 设置中心分区（扩展点 `settings.section` 贡献） */
export interface SettingsSection {
  id: string;
  title: string;
  order: number;
  render: () => ReactNode;
}

/** 托盘项（扩展点 `tray.item` 贡献） */
export interface TrayItem {
  id: string;
  label: string;
  onClick: () => void;
}

/** 内容识别器（扩展点 `detect.matcher` 贡献） */
export interface Detector {
  id: string;
  match(text: string): { kind: string; suggestion: string } | null;
}

/**
 * 模块元数据：顶层功能域。
 * 必须通过 `export default { ... } satisfies ModuleMeta` 自注册（`import.meta.glob` 自动发现）。
 */
export interface ModuleMeta {
  /** 模块 id（kebab-case，全局唯一），如 'toolbox' */
  id: string;
  /** 展示名，如 '工具箱' */
  name: string;
  description: string;
  /** lucide 图标名（具名导出），如 'Wrench' */
  icon: string;
  /** 主题色（侧栏/标签），缺省用品牌色 */
  color?: string;
  /** 展示排序（升序） */
  order: number;
  /** 支持的承载形态 */
  surface: ModuleSurface[];
  /**
   * 是否出现在**模块侧栏**里（缺省 `true`）。
   *
   * V42 引入：用户要求「桌面整理和工作台功能全部都做到桌面去了，工具主页面里面就只需要
   * 保留工具箱和密码存储器」。这两个模块的能力没有消失（命令照旧可搜索、视图照旧可打开），
   * 只是**不再占用主面板侧栏的位置** —— 它们的入口搬到了桌面上（挂件层工具栏）。
   *
   * 用「侧栏可见性」而不是「停用模块」，是因为停用会连带把命令从搜索里摘掉，
   * 而用户恰恰要「在桌面上能快速搜索并一键打开工具」。
   */
  sidebar?: boolean;
  /** 免费 / Pro（授权预留） */
  tier: Tier;
  /** 搜索关键词（含拼音） */
  keywords: string[];
  /** 限定平台（缺省 = 全平台） */
  platforms?: Platform[];
  /** 依赖的系统能力位（用于权限引导 / 降级） */
  capabilities?: string[];
  /** 面板内路由标识（panel surface） */
  route?: string;
  /** 独立窗口规格（window surface） */
  windowSpec?: {
    kind: WindowKind;
    multi?: boolean;
    frameless?: boolean;
    alwaysOnTop?: boolean;
  };
  /** 生命周期：激活（注册命令 / 启动监听） */
  activate?: () => Promise<void>;
  /** 生命周期：停用（释放资源） */
  deactivate?: () => Promise<void>;
  /** 扩展点贡献（自动聚合，无需改框架） */
  contributes?: {
    commands?: CommandMeta[];
    settingsSection?: SettingsSection;
    trayItems?: TrayItem[];
    detectors?: Detector[];
  };
  /** 面板内页视图的懒加载（未启用模块不加载其代码） */
  loadView?: () => Promise<{ default: ComponentType<ModuleProps> }>;
}

/**
 * 命令（功能）元数据：可被命令面板搜索到的轻量能力。
 *
 * 必须显式标注类型（`const CMD: CommandMeta = {...}` 或 `satisfies CommandMeta`）。
 * `load`（有 UI）与 `run`（动作式，框架级系统命令）**至少提供一个**。
 */
/**
 * 工具分类 id（V24）。
 *
 * 与 `src/modules/toolbox/commands/categories.ts` 的 `TOOL_CATEGORIES` **一一对应**：
 * 这里加成员 → 那里加元数据，`scripts/audit/tool-audit.mjs` 会校验两边一致。
 */
export type ToolCategory = 'text'
  | 'data'
  | 'encode'
  | 'convert'
  | 'generate'
  | 'dev'
  | 'security'
  | 'utility'
  | 'system';

export interface CommandMeta {
  /** 命令 id（kebab-case，全局唯一），如 'timestamp' */
  id: string;
  /** 归属模块 id；框架级系统命令用 'system' */
  moduleId: string;
  name: string;
  description: string;
  icon?: string;
  /** 别名（英文缩写等），如 ['ts', 'timestamp'] */
  aliases: string[];
  /** 关键词（含拼音首字母），如 ['时间戳', 'sjc'] */
  keywords: string[];
  /**
   * 工具分类（V24）：工具箱首页按它分组展示。
   * 工具箱下的命令**必填**（`tool-audit` 会卡）；系统命令可不填。
   */
  category?: ToolCategory;
  layout?: CommandLayout;
  tier: Tier;
  /** 敏感命令：结果默认不写历史 / 剪贴板（密码 / 密钥） */
  sensitive?: boolean;
  /** 是否联网（MVP 全 false） */
  isOnline?: boolean;
  /** 限定平台（缺省 = 全平台） */
  platforms?: Platform[];
  /** 懒加载视图组件（有 UI 的命令） */
  load?: () => Promise<{ default: ComponentType<CommandProps> }>;
  /** 动作式执行（无 UI 的框架级系统命令）；与 `load` 至少提供一个 */
  run?: () => void | Promise<void>;
}

/**
 * 应用级配置（`tauri-plugin-store` → `settings.json` 的 `settings` 键，ADR-7 / §7.1）。
 *
 * 注意：`modules`（模块启停）在桌面端由 Rust `module_set_enabled` / `module_list_state`
 * 命令读写同一 `settings` 对象（保持跨窗口一致）；浏览器调试环境降级为本地存储。
 */
export interface AppSettings {
  /** 呼出快捷键（平台默认见 platform.hotkeyDefault()） */
  hotkey: string;
  theme: ThemeMode;
  autoLaunch: boolean;
  autoUpdate: boolean;
  closeToTray: boolean;
  /** 工具使用历史开关 */
  recordHistory: boolean;
  /** 工具历史上限 */
  maxHistory: number;
  // 已移除 `sensitiveToolIds`：全项目无任何消费点（死字段）。
  // 敏感管控以 `CommandMeta.sensitive` 为唯一事实源（见 core/sensitive.ts）；
  // 若将来需要「用户自定义敏感工具」开关，V13 设置中心再接。
  /** 模块启停（§7.2 settings.modules） */
  modules: Record<string, boolean>;
  /** Pro 标记（授权预留） */
  tier: Tier;
  /** 首次引导完成 */
  onboarded: boolean;
  /**
   * 主窗口是否置顶（默认 `false`）。
   *
   * 置顶是「强需求场景」才开的开关：默认关，避免主窗口盖住浏览器 / 编辑器 /
   * 系统弹框等**窗口外的内容**（用户反馈：弹框被压住，只能先挪走 Toolbox）。
   * `true` 时主窗口始终浮在最上层。实际生效由主窗口在 `main.tsx` 里订阅本字段驱动。
   */
  mainPinned: boolean;
  /**
   * 工作台「快捷入口」展示哪些系统动作（存动作 id 数组，顺序即展示顺序）。
   *
   * 默认值见 `DEFAULT_QUICK_ACTION_IDS`（只放**在 Windows 上不好找**的入口）；用户可在
   * 工作台 / 桌面「快捷」面板里「自定义」增删。服务端动作表若删除了某个 id，前端会自动
   * 忽略不存在的项（不做破坏性清理）。
   *
   * ⚠️ 只有 `quickActionsCustomized` 为 `true` 时本字段才被采信 —— 见那里的说明。
   */
  quickActionIds: string[];
  /**
   * 快捷入口是否**被用户亲手改过**（V56，默认 `false`）。
   *
   * 为什么需要这个标记：默认值本身的**口径**变过一次 —— V56 之前把「任务管理器」这类
   * 随处可得的入口也放在默认里（用户 09-20：「任务栏右键随时都可以打开的没必要放在这里」）。
   * 而真机 `settings.json` 里早就落盘了那一份旧默认，光改 `DEFAULT_QUICK_ACTION_IDS` 对
   * 已经装过的人**一点用都没有**。
   *
   * 与 `settings.modules` 同一套约定：`false` = 跟随当前默认（口径升级时自动跟着变），
   * `true` = 用户自己定过，一个字都不动。用户在任何一处勾选 / 取消勾选即自动置 `true`；
   * 「恢复默认」把它置回 `false`（而不是把当前默认拷贝一份存下来）。
   */
  quickActionsCustomized: boolean;
  /**
   * 用户自定义纪念日（生日 / 结婚纪念日 / 任何值得记一笔的日子）。
   *
   * 只存在本机配置里，不进数据库 —— 它是「个人日历标注」而非业务数据，
   * 跟着 `settings.json` 一起被备份 / 还原即可。
   */
  anniversaries: Anniversary[];
}

/** 纪念日（生日 / 纪念日等自定日期） */
export interface Anniversary {
  /** 稳定 id（前端生成，用于增删） */
  id: string;
  /** 名称，如「妈妈生日」 */
  label: string;
  /** 日期：`YYYY-MM-DD`（含年份，可据此算「第几年」） */
  date: string;
  /**
   * 是否每年重复。`true` = 只按「月-日」匹配（生日 / 纪念日）；
   * `false` = 只在指定那一天命中（一次性事项）。
   */
  yearly: boolean;
  /** 类型（决定日历上的图标与配色） */
  kind: 'birthday' | 'anniversary' | 'other';
}
