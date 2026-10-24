import { useCallback, useMemo } from 'react';
import { useAppStore } from '@/stores/useAppStore';
import { useFavoritesStore } from '@/stores/useFavoritesStore';
import { isSensitiveCommandId } from '@/core/sensitive';

/**
 * 命令外壳（`CommandShell`）所需的共享行为。
 *
 * 命令组件各自持有 id，经本 hook 取到「返回面板 / 收藏态 / 切换收藏 / 是否禁用收藏」，
 * 从而让 `CommandProps` 契约保持精简（不注入框架态），并保证行为一致。
 *
 * 「最近使用」的写入在打开命令时集中记录（见 `CommandView`），命令组件无需关心。
 * 敏感命令（`CommandMeta.sensitive`）**不提供收藏入口**：`favoriteDisabled = true`，
 * 由 `CommandShell` 据此隐藏星标；真正的写保护在 `useFavoritesStore.toggle`（唯一执行点）。
 */
export interface CommandShellContext {
  /** 返回命令面板 */
  onBack: () => void;
  /** 是否已收藏 */
  favorite: boolean;
  /** 切换收藏 */
  onToggleFavorite: () => void;
  /**
   * 收藏是否不可用（敏感命令 = true）。
   * 为真时外壳不渲染收藏星标——敏感命令不加入收藏，避免「收藏了却看不见」的哑巴亏。
   */
  favoriteDisabled: boolean;
}

export function useCommandShell(commandId: string): CommandShellContext {
  const showPalette = useAppStore((state) => state.showPalette);
  // 订阅 ids 数组引用，收藏变化即重渲染
  const favoriteIds = useFavoritesStore((state) => state.ids);
  const toggleFavorite = useFavoritesStore((state) => state.toggle);

  const favorite = useMemo(() => favoriteIds.includes(commandId), [favoriteIds, commandId]);
  const favoriteDisabled = useMemo(() => isSensitiveCommandId(commandId), [commandId]);

  const onToggleFavorite = useCallback(() => {
    toggleFavorite(commandId);
  }, [toggleFavorite, commandId]);

  return { onBack: showPalette, favorite, onToggleFavorite, favoriteDisabled };
}
