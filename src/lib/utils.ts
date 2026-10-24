import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并 className：clsx 处理条件，tailwind-merge 解决 Tailwind 类冲突 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * 人类可读的文件体积。
 * @param bytes 字节数
 * @param decimals 小数位（默认 1）
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  const unit = units[index] ?? 'B';
  return `${value.toFixed(index === 0 ? 0 : decimals)} ${unit}`;
}

/** 延迟指定毫秒（Promise 版） */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
