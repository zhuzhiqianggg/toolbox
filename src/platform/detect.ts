import { ipc } from '@/lib/ipc';
import type { PlatformInfo } from '@/types/platform';

/**
 * 是否运行在 Tauri 宿主内（纯浏览器 dev 时为 false）。
 * 注意：这里只探测「运行时宿主」，不做 OS 判定——OS 判定一律经 `platform_info` 命令。
 */
export function isTauri(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const host = window as unknown as Record<string, unknown>;
  return '__TAURI_INTERNALS__' in host || '__TAURI__' in host;
}

/** 非 Tauri 环境（浏览器调试）的兜底平台信息 */
export function fallbackPlatformInfo(): PlatformInfo {
  return {
    os: 'unknown',
    arch: 'unknown',
    osVersion: '',
    capabilities: {
      desktopIcons: false,
      desktopFileOrganize: false,
      screenRecording: false,
      systemInfo: false,
      tray: 'tray',
    },
    hotkeyDefault: 'Alt+Q',
  };
}

/**
 * 从后端 `platform_info` 命令探测平台信息。
 * 非 Tauri 环境或调用失败时返回兜底信息，保证纯浏览器 `npm run dev` 不崩溃。
 */
export async function detectPlatformInfo(): Promise<PlatformInfo> {
  if (!isTauri()) {
    return fallbackPlatformInfo();
  }
  try {
    return await ipc.platformInfo();
  } catch {
    return fallbackPlatformInfo();
  }
}
