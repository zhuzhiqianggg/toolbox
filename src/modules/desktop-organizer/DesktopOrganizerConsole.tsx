import { useState } from 'react';
import { FolderTree, LayoutGrid } from 'lucide-react';
import OrganizerView from './OrganizerView';
import GridManagerView from '../desktop-grid/GridManagerView';
import { cn } from '@/lib/utils';

/**
 * 桌面整理控制台（V25 新增，模块首屏）。
 *
 * # 为什么要加这一层
 *
 * 用户反馈：「桌面整理还是在自己的框里面玩，没有正式操作系统桌面，
 * 我们的架构是不是没有做到操作系统桌面整理呢？不行就把这个功能砍掉，
 * 否则就完善好」。
 *
 * 查证后的结论是**能力有、入口错**：
 *
 * 而 V19 之后模块首屏一直指向后者 —— 于是「桌面整理」这个名字下面，
 * 用户看到的是一个只在自己框里摆积木东西的页面，「没有真正操作系统桌面」
 * 这句评价完全成立。
 *
 * # 模型摇摆史（别再绕回去）
 *
 * | 版本 | 归类文件 | 桌面格子 |
 * | --- | --- | --- |
 * | V25–V32 | 真移动到「桌面/Handy整理/类别/」，可撤销 | 只登记引用，文件留在桌面 → 用户评「复制了一份而已」 |
 * | V33–V36 | 同上 | 改成**真移动**（格子 = 桌面/Handy整理/格子名/ 的真实目录） |
 * | **V37（当前）** | **默认只归拢、不动文件**；真移动降级为显式可选项 | **回到登记引用**，但这次是「呈现层」而不是「复制」——格子就是桌面图标的另一种排布 |
 *
 * V33–V36 的「真移动」是一次**被用户否掉的过度设计**：他把文件搬进一个目录这件事定性为
 * 「这个完全是错误的」。所以 V37 的方向不是「再改一版移动策略」，而是**这一层不该搬文件**。
 * 两处都保留了「真的想归档」的出口，但都要求用户显式选择，并且按钮上直说「移动」。
 *
 * # 这一层做的事
 *
 * 一个页签栏，**首屏就是「归类文件」**（默认 tab）；「桌面格子」是常驻桌面的
 * 整理层（收纳格 + 便签 + 日历挂件）。两边各自的语义在页签旁一句话说清 ——
 * 尤其是**动不动文件**，必须一眼可见。
 */
type ConsoleTab = 'files' | 'grid';

/** 页签定义：图标 + 名称 + 一句话说清「动不动文件」 */
const TABS: ReadonlyArray<{
  id: ConsoleTab;
  label: string;
  hint: string;
  icon: typeof FolderTree;
}> = [
  {
    id: 'files',
    label: '归类文件',
    hint: '只归拢不动文件：按类型把桌面条目登记进桌面格子，文件本体留在桌面原位（打开桌面目录一看便知）',
    icon: FolderTree,
  },
  {
    id: 'grid',
    label: '桌面格子',
    hint: '常驻桌面：格子只是桌面图标的另一种排布，拖来拖去都只改显示，文件永远留在桌面原位',
    icon: LayoutGrid,
  },
];

export function DesktopOrganizerConsole(): React.JSX.Element {
  const [tab, setTab] = useState<ConsoleTab>('files');
  const current = TABS.find((item) => item.id === tab) ?? TABS[0];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 页签栏：顺便把「哪个动文件、哪个不动」写在标签旁边 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-4 py-1.5">
        {TABS.map((item) => {
          const Icon = item.icon;
          const active = item.id === tab;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs transition',
                active
                  ? 'bg-brand-muted font-medium text-brand'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </button>
          );
        })}
        <span className="ml-2 min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {current?.hint}
        </span>
      </div>

      {/* 视图区：两个视图各自管理内部滚动（都声明了 h-full + overflow） */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'files' ? <OrganizerView /> : <GridManagerView embedded />}
      </div>
    </div>
  );
}

/** 供模块注册表 `loadView` 动态导入 */
export default DesktopOrganizerConsole;
