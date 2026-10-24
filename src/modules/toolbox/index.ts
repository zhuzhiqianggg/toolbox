import type { ModuleMeta } from '@/core/types';
import { toolboxCommands } from './commands';

/**
 * 工具箱（M1）模块元数据。
 *
 * 经 `import.meta.glob`（匹配各模块目录下的 index.ts）自动发现，无需在任何注册表登记。
 * 子工具在 `./commands` 声明，命令面板 / 收藏 / 最近 / 复制外壳自动生效。
 */
const toolboxModule = {
  id: 'toolbox',
  name: '工具箱',
  description: '时间戳、JSON、Base64、URL、JWT 等常用工具',
  icon: 'Wrench',
  color: 'brand',
  order: 10,
  surface: ['panel'],
  tier: 'free',
  keywords: ['工具箱', '工具', 'toolbox', 'gongjuxiang', 'gjx'],
  route: 'toolbox',
  contributes: {
    commands: toolboxCommands,
  },
  loadView: () => import('./ToolboxView'),
} satisfies ModuleMeta;

export default toolboxModule;
