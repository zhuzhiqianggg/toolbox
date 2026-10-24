import { create } from 'zustand';
import { DEFAULT_SETTINGS } from '@/core/settings';
import type { AppSettings, CommandProps, ThemeMode } from '@/core/types';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import { patchSettings, readSettings } from '@/lib/store';

/**
 * 打开视图（主面板内的路由态）。
 * 命令面板为默认视图；选择命令/模块/设置后切换，`Esc`/返回回到面板。
 */
export type MainView =
  | { kind: 'palette' }
  | { kind: 'settings' }
  | { kind: 'module'; moduleId: string }
  | {
      kind: 'command';
      commandId: string;
      /** 初始输入（来自剪贴板建议 / 历史） */
      input?: string;
      /** 输入来源 */
      source?: CommandProps['source'];
    };

interface AppState {
  /** 当前主面板视图 */
  view: MainView;
  /** 应用设置（含模块开关 modules） */
  settings: AppSettings;
  /** 是否已完成启动装配（bootstrap） */
  hydrated: boolean;

  /** 切换视图 */
  setView: (view: MainView) => void;
  /** 回到命令面板 */
  showPalette: () => void;
  /** 设置主题（写入配置） */
  setTheme: (theme: ThemeMode) => Promise<void>;
  /** 局部更新设置（写入配置） */
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  /** 某模块是否启用（缺省 = 启用） */
  isModuleEnabled: (moduleId: string) => boolean;
  /** 启用/停用模块（持久化） */
  setModuleEnabled: (moduleId: string, enabled: boolean) => Promise<void>;
  /** 启动装配：读取设置 + 模块开关 */
  hydrate: () => Promise<void>;
}

export const useAppStore = create<AppState>()((set, get) => ({
  view: { kind: 'palette' },
  settings: DEFAULT_SETTINGS,
  hydrated: false,

  setView: (view) => set({ view }),
  showPalette: () => set({ view: { kind: 'palette' } }),

  setTheme: async (theme) => {
    set({ settings: { ...get().settings, theme } });
    await patchSettings({ theme });
  },

  updateSettings: async (patch) => {
    set({ settings: { ...get().settings, ...patch } });
    await patchSettings(patch);
  },

  isModuleEnabled: (moduleId) => get().settings.modules[moduleId] ?? true,

  setModuleEnabled: async (moduleId, enabled) => {
    const modules = { ...get().settings.modules, [moduleId]: enabled };
    set({ settings: { ...get().settings, modules } });

    // 桌面端：经 Rust 命令写入同一 settings 对象（跨窗口一致，单一写路径）
    if (isTauri()) {
      try {
        await ipc.moduleSetEnabled(moduleId, enabled);
        return;
      } catch {
        // 命令不可用时降级到前端配置写入
      }
    }
    await patchSettings({ modules });
  },

  hydrate: async () => {
    if (get().hydrated) {
      return;
    }
    const settings = await readSettings();
    let modules = settings.modules;
    if (isTauri()) {
      try {
        modules = { ...modules, ...(await ipc.moduleListState()) };
      } catch {
        // 读取失败沿用本地配置
      }
    }
    set({ settings: { ...settings, modules }, hydrated: true });
  },
}));
