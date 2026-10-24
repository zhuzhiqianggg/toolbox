import { toast } from '@/components/ui/toast';
import { useAppStore } from '@/stores/useAppStore';
import { useFavoritesStore } from '@/stores/useFavoritesStore';
import type { CommandMeta } from './types';

/**
 * 框架级系统命令 —— **唯一允许的「显式注册点」**。
 *
 * 命名说明：本文件名曾为 `registry.ts`，但**它不是注册表**（真正的注册表是
 * `moduleRegistry.ts`），为避免后人误判「此处存在第二个注册表」而改名。
 *
 * ⚠️ 边界（务必遵守，勿滥用）：
 *   - 仅用于**不属于任何业务模块**的框架命令（打开设置 / 关于 …）；
 *   - **业务模块与工具一律走 `import.meta.glob` 自动发现**（见 `moduleRegistry.ts`），
 *     **禁止**在本文件手动登记业务命令 / 工具；
 *   - 新增一条系统命令后，无需改动注册表 / 命令面板，框架初始化时自动并入
 *     （`moduleRegistry.discover()` 会并入本常量）。
 *
 * 这些命令均声明 `moduleId: 'system'`，不进任何模块的开关管辖。
 */
export const SYSTEM_COMMANDS: readonly CommandMeta[] = [
  {
    id: 'open-settings',
    moduleId: 'system',
    name: '打开设置',
    description: '打开设置中心（快捷键 / 主题 / 模块开关）',
    icon: 'Settings',
    aliases: ['settings', 'preferences', 'shezhi'],
    keywords: ['设置', '偏好', '选项', 'sz'],
    tier: 'free',
    run: () => {
      useAppStore.getState().setView({ kind: 'settings' });
    },
  },
  {
    id: 'open-about',
    moduleId: 'system',
    name: '关于 Handy',
    description: '查看版本与项目信息',
    icon: 'Info',
    aliases: ['about', 'version', 'guanyu'],
    keywords: ['关于', '版本', '信息', 'gy'],
    tier: 'free',
    run: () => {
      toast.message('Handy · 顺手', { description: '跨平台桌面效率套件 · v0.1.0' });
    },
  },
  {
    id: 'toggle-favorite',
    moduleId: 'system',
    name: '切换当前命令收藏',
    description: '收藏 / 取消收藏当前打开的命令',
    icon: 'Star',
    aliases: ['favorite', 'shoucang'],
    keywords: ['收藏', '星标', 'sc'],
    tier: 'free',
    run: () => {
      const view = useAppStore.getState().view;
      if (view.kind !== 'command') {
        toast.message('收藏', { description: '请先打开一个命令再收藏。' });
        return;
      }
      useFavoritesStore.getState().toggle(view.commandId);
    },
  },
];
