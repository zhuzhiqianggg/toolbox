/** 窗口类型（与 Rust `WindowKind` / `?window=` 参数对应） */
export type WindowKind =
  | 'main'
  | 'settings'
  | 'note'
  | 'clip-quick'
  | 'organizer'
  | 'grid-overlay';

/** 主面板可承载的界面形态 */
export type ModuleSurface = 'panel' | 'window' | 'overlay' | 'tray';

/** 命令/工具的主要布局 */
export type CommandLayout = 'split' | 'tab' | 'form' | 'preview' | 'full';
