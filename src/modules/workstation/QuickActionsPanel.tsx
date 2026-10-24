/**
 * 快捷入口（历史入口，V20 起改为**竖排图标栏**）。
 *
 * 旧实现是工作台底部一整块卡片（用户反馈：「要拉到最下面才能点击，这样不叫快捷」），
 * V20 改成贴在右侧的竖排大图标栏 —— 见 `./QuickActionsRail`。
 *
 * 本文件保留为转发壳：老的引用（如果有）仍能 import，行为与新版一致。
 */
export { QuickActionsRail as QuickActionsPanel, QuickActionsRail } from './QuickActionsRail';
export { QuickActionsRail as default } from './QuickActionsRail';
