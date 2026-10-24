import { create } from 'zustand';
import { FAVORITES_KEY } from '@/core/settings';
import { excludeSensitiveIds, isSensitiveCommandId } from '@/core/sensitive';
import { readStringArray, writeKey } from '@/lib/store';

/**
 * 命令收藏（配置态，存 `favorites` 键）。
 * 命令面板首屏「收藏」区数据来源。
 *
 * 隐私：**敏感命令不提供收藏入口**（`CommandMeta.sensitive` 为唯一事实源，见 `core/sensitive.ts`）：
 *   - `toggle` 对敏感 id 直接忽略（不改状态、不写库）；
 *   - `hydrate` 清洗历史遗留的敏感 id 并回写（幂等）。
 * 口径与「最近使用」（`useRecentStore`）保持同构——敏感命令一律不进首屏榜单。
 *
 * 说明：本文件导入 `core/sensitive` → `core/moduleRegistry`；`moduleRegistry` 又（经
 * `systemCommands`）导入本文件，构成模块环。该环是安全的：两侧都只在**函数体内**
 * 读取对方绑定，模块求值阶段无顶层读取，故不触发 TDZ。
 */
interface FavoritesState {
  ids: string[];
  has: (id: string) => boolean;
  /** 切换收藏（写入配置）；敏感命令直接忽略 */
  toggle: (id: string) => void;
  hydrate: () => Promise<void>;
}

export const useFavoritesStore = create<FavoritesState>()((set, get) => ({
  ids: [],

  has: (id) => get().ids.includes(id),

  toggle: (id) => {
    // 敏感命令不给收藏入口（双保险：CommandShell 已隐藏星标，此处再兜一层，
    // 防止未来新增的其他入口绕过 → 唯一事实源 CommandMeta.sensitive）
    if (isSensitiveCommandId(id)) {
      return;
    }
    const current = get().ids;
    const ids = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    set({ ids });
    void writeKey(FAVORITES_KEY, ids);
  },

  hydrate: async () => {
    const stored = await readStringArray(FAVORITES_KEY);
    // 加载时一次性清洗：剔除历史遗留的敏感命令 id（幂等，重复执行无害）
    const ids = excludeSensitiveIds(stored);
    set({ ids });
    // 仅在确有敏感 id 被剔除时回写，避免无谓写入
    if (ids.length !== stored.length) {
      void writeKey(FAVORITES_KEY, ids);
    }
  },
}));
