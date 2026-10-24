import { create } from 'zustand';
import { RECENT_KEY, RECENT_LIMIT } from '@/core/settings';
import { excludeSensitiveIds, isSensitiveCommandId } from '@/core/sensitive';
import { readStringArray, writeKey } from '@/lib/store';

/**
 * 命令最近使用（配置态，存 `recent` 键，上限 {@link RECENT_LIMIT}）。
 * 命令面板首屏「最近使用」区数据来源；按使用先后倒序。
 *
 * 隐私：敏感命令（`CommandMeta.sensitive`）**不记录、不展示**，详见 `core/sensitive.ts`。
 */
interface RecentState {
  ids: string[];
  /** 记录一次使用（去重置顶，超出上限裁剪）；敏感命令直接忽略 */
  push: (id: string) => void;
  clear: () => void;
  hydrate: () => Promise<void>;
}

export const useRecentStore = create<RecentState>()((set, get) => ({
  ids: [],

  push: (id) => {
    // 敏感命令不自动留痕（双保险：CommandView 已在写入前守卫，此处再兜一层，
    // 防止未来新增的其他写入路径绕过 → 隐私管控唯一事实源 CommandMeta.sensitive）
    if (isSensitiveCommandId(id)) {
      return;
    }
    const ids = [id, ...get().ids.filter((item) => item !== id)].slice(0, RECENT_LIMIT);
    set({ ids });
    void writeKey(RECENT_KEY, ids);
  },

  clear: () => {
    set({ ids: [] });
    void writeKey(RECENT_KEY, []);
  },

  hydrate: async () => {
    const stored = await readStringArray(RECENT_KEY);
    // 加载时一次性清洗：剔除历史遗留的敏感命令 id（幂等，重复执行无害）
    const ids = excludeSensitiveIds(stored).slice(0, RECENT_LIMIT);
    set({ ids });
    // 仅在确有敏感 id 被剔除时回写，避免无谓写入
    if (ids.length !== stored.length) {
      void writeKey(RECENT_KEY, ids);
    }
  },
}));
