import type { ModuleMeta } from '@/core/types';
import { desktopOrganizerCommands } from './commands';

/**
 * 桌面整理模块元数据。
 *
 * **注册策略（原地改名重定向，同 notes → 工作台）**：沿用模块 id `desktop-organizer`，
 * 命令、路由、启停状态、备份兼容均无需迁移。
 *
 * # V25：首屏换成 `DesktopOrganizerConsole`（两页签）
 *
 * 用户反馈「桌面整理还是在自己的框里面玩，没有正式操作系统桌面」。
 * 查证结论是**能力有、入口错**，于是加了这一层页签控制台。
 *
 * # V48：两个页签都不动文件（「移动到整理目录」已彻底删除）
 *
 * V33–V36 那一版把两个页签都做成「真移动」，被用户装机实测直接否掉；V37 把它降级成
 * 一个显式可选的处理方式，但用户 09-19 又指出这个选项本身就是垃圾：
 * 「不负责直接 mv 文件到新的目录下，桌面整理就是单纯的桌面整理美化收纳，
 *  打开桌面的目录文件夹后布局没有任何变化的那种」。
 * 于是 V48 把这条路径**连 Rust 实现一起删掉**（`organizer_preview_plan` /
 * `organizer_apply` / `organizer_undo` / `organizer_list_plans`，以及目标目录
 * `桌面/Handy整理/` 这个概念）。现在：
 *
 *   - **归类文件**（`OrganizerView` + Rust `organizer.rs` / `grid.rs`）：只读扫描桌面，
 *     按类型把条目**登记**进桌面格子，文件原地不动，也没有任何归档选项；
 *   - **桌面格子**（`GridManagerView` + Rust `grid.rs`）：定位是**呈现层** ——
 *     格子就是桌面图标的另一种排布，拖进 / 移出 / 换格只改显示。
 *
 * 应用里**不再存在任何把用户文件搬出桌面的代码路径**。用户随时可以点「打开桌面」
 * 用资源管理器核对：布局不会有任何变化。
 */
const desktopOrganizerModule = {
  id: 'desktop-organizer',
  name: '桌面整理',
  description: '把桌面图标按类型归拢进格子显示与美化，文件一律留在原位，绝不移动或删除',
  icon: 'LayoutGrid',
  order: 40,
  surface: ['panel'],
  /**
   * V45：**恢复占主面板侧栏的位置**（同工作台）。
   *
   * V42 曾把桌面整理从侧栏摘掉，理由是「主战场在桌面本身」。用户 09-19 复盘改口
   * 要保留这个控制台：「工作台和之前桌面整理控制台也都保留呗，以后我们还可以添加
   * 更多有用的模块」。桌面上的入口（挂件工具栏）照旧，两边打开的是同一个视图。
   */
  sidebar: true,
  tier: 'free',
  keywords: [
    '桌面整理',
    '桌面归类',
    '文件归类',
    '一键整理',
    '自动整理',
    '桌面挂件',
    '格子',
    '收纳格',
    '网格',
    '挂件',
    '便签',
    '日历',
    '计划',
    '备份布局',
    '还原布局',
    '图标',
    '快捷',
    'organize',
    'widget',
    'grid',
    'desktop',
    'zmzl',
    'gj',
  ],
  platforms: ['windows', 'macos'],
  capabilities: ['desktopFileOrganize'],
  route: 'desktop-organizer',
  contributes: {
    commands: desktopOrganizerCommands,
  },
  loadView: () => import('./DesktopOrganizerConsole'),
} satisfies ModuleMeta;

export default desktopOrganizerModule;
