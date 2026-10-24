import type {
  CommandMeta,
  Detector,
  SettingsSection,
  TrayItem,
} from './types';

/**
 * 扩展点定义与契约（ARCHITECTURE ADR-6 / ADR-10）。
 *
 * 任何模块通过 `ModuleMeta.contributes` 声明贡献，注册表 `collect(point)` 聚合；
 * L2/L3（官方扩展包 / 第三方插件）后续以「可动态加载、向同名扩展点 contribute 的打包产物」
 * 接入，本期仅固化接口与加载边界，不实现下载/校验。
 */
export type ExtensionPointId =
  | 'command' // 命令 / 工具（M1 及各模块）
  | 'settings.section' // 设置中心分区
  | 'tray.item' // 托盘 / 菜单栏项
  | 'detect.matcher' // 内容识别器（JSON / JWT / 时间戳 / URL…）
  | 'palette.provider' // 命令面板结果提供者（工具 / 最近 / 收藏，未来接入应用 / 文件）
  | 'module.activation'; // 模块激活

/** 命令面板结果项（`palette.provider` 贡献） */
export interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  run: () => void | Promise<void>;
}

/** 命令面板结果提供者（如未来的「应用搜索 / 文件搜索」） */
export interface PaletteProvider {
  id: string;
  search: (query: string) => PaletteItem[] | Promise<PaletteItem[]>;
}

/** 模块激活状态变更事件（`module.activation`） */
export interface ModuleActivation {
  moduleId: string;
  active: boolean;
}

/** 扩展点 → 贡献项类型映射 */
export interface ExtensionMap {
  command: CommandMeta;
  'settings.section': SettingsSection;
  'tray.item': TrayItem;
  'detect.matcher': Detector;
  'palette.provider': PaletteProvider;
  'module.activation': ModuleActivation;
}

/** 取某扩展点的贡献项类型 */
export type ExtensionItem<P extends ExtensionPointId> = ExtensionMap[P];

/** 全部扩展点（用于遍历 / 调试） */
export const EXTENSION_POINTS: readonly ExtensionPointId[] = [
  'command',
  'settings.section',
  'tray.item',
  'detect.matcher',
  'palette.provider',
  'module.activation',
];
