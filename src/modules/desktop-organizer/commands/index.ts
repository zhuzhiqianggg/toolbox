import type { CommandMeta } from '@/core/types';

/**
 * 桌面整理模块的命令清单（V12；V25 改名避开与模块同名的歧义）。
 * * 「桌面文件归类」：视图式命令（`load`）—— 打开 `OrganizerView`，它只做一件事：
 * 按类型把桌面条目**登记**进桌面格子（`grid_auto_arrange`），文件原地不动。
 *
 * V48 起这里**没有任何移动 / 归档路径**（Rust 侧的 apply / undo 已删除），
 * 所以命令名与描述都只承诺「归拢 + 显示」这一件事。
 *
 * 为什么叫「文件归类」而不是「桌面整理」：模块本身就叫「桌面整理」，两者同名会让用户
 * 在命令面板里搜到两条同名项却不知道该点哪个 —— 名字上直接把动作点出来。
 */
export const desktopOrganizerCommands: CommandMeta[] = [
  {
    id: 'desktop-organizer',
    moduleId: 'desktop-organizer',
    name: '桌面文件归类',
    description: '把桌面文件按类型归拢进格子显示与美化，文件一律留在桌面原位，绝不移动或删除',
    icon: 'FolderOpen',
    aliases: ['organize', 'clean desktop', 'tidy', 'desktop files'],
    keywords: [
      '桌面',
      '整理',
      '归类',
      '文件归类',
      '清理',
      'organize',
      'zl',
      'zhengli',
      'zml',
    ],
    layout: 'full',
    tier: 'free',
    load: () => import('../OrganizerView'),
  },
];
