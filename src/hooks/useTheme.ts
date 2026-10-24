import { useEffect } from 'react';
import { useAppStore } from '@/stores/useAppStore';
import type { ThemeMode } from '@/core/types';

/** 将主题应用到 `<html>`（`dark` 类切换，见 tailwind.config.ts `darkMode: 'class'`）。 */
function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') {
    return;
  }
  const prefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = mode === 'dark' || (mode === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);
}

/**
 * 主题跟随设置生效（`light` / `dark` / `system`）。
 *
 * MVP 保证浅色；`system` 时监听系统偏好变化实时切换。
 * 在应用根（`App`）调用一次即可。
 */
export function useTheme(): void {
  const theme = useAppStore((state) => state.settings.theme);

  useEffect(() => {
    applyTheme(theme);

    if (theme !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (): void => applyTheme('system');
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [theme]);
}
