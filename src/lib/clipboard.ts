import {
  readText as tauriReadText,
  writeText as tauriWriteText,
} from '@tauri-apps/plugin-clipboard-manager';
import { isTauri } from '@/platform/detect';

/**
 * 写入剪贴板文本。
 *
 * 优先使用 `@tauri-apps/plugin-clipboard-manager`；在非 Tauri 环境（纯浏览器 dev）
 * 自动降级到 `navigator.clipboard`，再兜底到 `execCommand('copy')`，
 * 保证浏览器里也能点得动「复制」。
 */
export async function copyText(text: string): Promise<boolean> {
  if (isTauri()) {
    try {
      await tauriWriteText(text);
      return true;
    } catch {
      // 插件不可用时继续降级
    }
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续兜底
  }

  return fallbackCopy(text);
}

/** 读取剪贴板文本（失败返回空串） */
export async function readClipboardText(): Promise<string> {
  if (isTauri()) {
    try {
      return await tauriReadText();
    } catch {
      // 降级
    }
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      return await navigator.clipboard.readText();
    }
  } catch {
    // 无权限或不可用
  }
  return '';
}

/** 兜底复制：临时 textarea + execCommand */
function fallbackCopy(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
