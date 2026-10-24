/** 平台枚举（与 Rust `PlatformInfo.os` 对应） */
export type Platform = 'windows' | 'macos' | 'linux' | 'unknown';

/** 常驻形态：Windows 系统托盘 / macOS 菜单栏 */
export type TrayKind = 'tray' | 'menubar';

/** 平台能力清单（用于前端做降级展示 / 授权引导） */
export interface PlatformCapabilities {
  /** 是否可操作桌面「图标」（macOS = false） */
  desktopIcons: boolean;
  /** 是否可做文件归类 */
  desktopFileOrganize: boolean;
  /** 屏幕录制权限（M6，用本字段控制功能显隐） */
  screenRecording: boolean;
  /** 是否可读取系统信息 */
  systemInfo: boolean;
  /** 常驻形态 */
  tray: TrayKind;
}

/** 平台信息，数据来源为 Rust `platform_info` 命令 */
export interface PlatformInfo {
  os: Platform;
  arch: string;
  osVersion: string;
  capabilities: PlatformCapabilities;
  /** 平台默认呼出快捷键文案，如 "Alt+Space" / "Option+Space" */
  hotkeyDefault: string;
}
