import type { ModuleMeta } from '@/core/types';
import { notesCommands } from './commands';

/**
 * 工作台（原便签·待办 M3）模块元数据。
 *
 * **注册策略（保留 notes id）**：用户已决定用「桌面工作台」替换便签模块首屏。
 * 本模块元数据沿用 id `notes`（命令、路由、启停状态、备份兼容均无需迁移），
 * 仅重命名为「工作台」并把 `loadView` 重定向到 `../workstation/WorkstationView`：
 *   - 侧栏 / 命令面板 / 设置中心中「便签·待办」位置展示为「工作台」；
 *   - 便签 / 待办能力不删除：`notesCommands`（新建便签 / 便签列表 / 待办清单）
 *     仍可经命令面板与工作台卡片触达；
 *   - 独立便签窗口仍由 Rust `open_note_window` 创建，`windowSpec` 描述保持不变。
 */
const notesModule = {
  id: 'notes',
  name: '工作台',
  description: '日历计划 · 笔记 · 系统快捷入口，一屏聚合',
  icon: 'StickyNote',
  order: 20,
  surface: ['panel', 'window'],
  /**
   * V45：**恢复占主面板侧栏的位置**。
   *
   * V42 曾按「桌面为主」的定位把工作台从侧栏摘掉（`sidebar: false`）。用户 09-19 复盘
   * 时明确改口：「我们的 handy 主窗口还是建议使用吗？既然这样那就工作台和之前桌面整理
   * 控制台也都保留呗，以后我们还可以添加更多有用的模块」—— 主窗口保留为「模块宿主 /
   * 控制台」，侧栏是模块导航的自然位置。桌面上的入口（挂件工具栏 / 右侧面板）照旧，
   * 两边指向同一份数据、同一个视图，不存在重复实现。
   */
  sidebar: true,
  tier: 'free',
  keywords: [
    '工作台',
    '日历',
    '计划',
    '待办',
    '任务',
    '事件',
    '笔记',
    '快捷入口',
    '终端',
    'workstation',
    'dashboard',
    'calendar',
    'gzt',
    'rili',
    'note',
    'todo',
    'bj',
    'db',
  ],
  route: 'notes',
  windowSpec: { kind: 'note', multi: true, frameless: true, alwaysOnTop: true },
  contributes: {
    commands: notesCommands,
  },
  loadView: () => import('../workstation/WorkstationView'),
} satisfies ModuleMeta;

export default notesModule;
