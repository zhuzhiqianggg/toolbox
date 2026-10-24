import { detectPlatformInfo, isTauri } from './detect';
import type { Platform, PlatformCapabilities } from '@/types/platform';

/**
 * 平台抽象（业务代码唯一平台判定入口，禁止散落 `navigator.userAgent`）。
 *
 * 数据来源：Rust `platform_info` 命令。首次调用 `initPlatform()` 注入，之后同步读取。
 */

const UNKNOWN_CAPABILITIES: PlatformCapabilities = {
  desktopIcons: false,
  desktopFileOrganize: false,
  screenRecording: false,
  systemInfo: false,
  tray: 'tray',
};

let currentPlatform: Platform = 'unknown';
let currentCapabilities: PlatformCapabilities = UNKNOWN_CAPABILITIES;
let currentHotkey = 'Alt+Q';
let injected = false;
let inflight: Promise<void> | null = null;

/**
 * 初始化/刷新平台信息。幂等：并发调用共享同一 Promise。
 * 建议在应用启动装配阶段（bootstrap）调用一次。
 */
export function initPlatform(): Promise<void> {
  if (injected) {
    return Promise.resolve();
  }
  if (inflight === null) {
    inflight = detectPlatformInfo().then((info) => {
      currentPlatform = info.os;
      currentCapabilities = info.capabilities;
      currentHotkey = info.hotkeyDefault;
      injected = true;
      inflight = null;
    });
  }
  return inflight;
}

/** 当前平台标识 */
export function getPlatform(): Platform {
  return currentPlatform;
}

/** 是否 Windows */
export function isWindows(): boolean {
  return currentPlatform === 'windows';
}

/** 是否 macOS */
export function isMac(): boolean {
  return currentPlatform === 'macos';
}

/** 当前平台能力位 */
export function getCapabilities(): PlatformCapabilities {
  return currentCapabilities;
}

/** 平台默认呼出快捷键文案 */
export function hotkeyDefault(): string {
  return currentHotkey;
}

export { isTauri };
export type { Platform, PlatformCapabilities };
