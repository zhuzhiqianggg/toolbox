import * as React from 'react';
import {
  ArrowLeft,
  Boxes,
  CalendarDays,
  ChevronDown,
  Keyboard,
  Link2,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { registry } from '@/core/moduleRegistry';
import { SettingsCenter } from '@/components/SettingsCenter';
import { ipc } from '@/lib/ipc';
import { toast } from '@/components/ui/toast';
import { searchCommands } from '@/lib/search';
import { categoryMetaOf, orderedCategories } from '@/core/toolCategories';
import { DOCK_EASY_TO_REACH_IDS } from '@/core/settings';
import { resolveIcon } from '@/lib/icons';
import { ACTION_ICONS } from '@/modules/workstation/QuickActionsRail';
import { loadQuickLinks, type QuickLink } from '@/modules/workstation/quicklinks';
import { useAppStore } from '@/stores/useAppStore';
import type { SysAction } from '@/types/sys';
import { cn } from '@/lib/utils';

/**
 * 桌面右侧统一面板（V45 建立 · V46 实心化）。
 *
 * ## 为什么推倒重来
 *
 * V42–V44 期间桌面上一共有**四个各自为政的浮层**：中部搜索小浮层、偏左的大抽屉式
 * 工具箱（`DesktopToolPanel`，宽 `min(1120px,90vw)` 几乎铺满）、右下快捷浮层
 * （`DesktopQuickActions`）、底部 Dock。用户 09-19 的截图反馈：
 *   · 「工具搜索应该放在右侧，跟工作台差不多 直接搜索获取，而不是打开额外的对话框 很乱」
 *   · 「还是有点混乱」
 * 病根是**同一件事有多个入口、每个入口一个位置一套交互**：想搜个工具得先想「该点搜索
 * 还是工具箱」，然后面对一个铺满桌面的大框，左边一列列表右边一块空白 —— 与「在桌面上
 * 顺手用一下」完全相反。
 *
 * ## 现在的模型：一个面板，两个页签
 *
 * 固定贴在桌面右侧（不铺满、不居中弹），所有「找东西 / 用东西」都在这一个容器里：
 *   · **工具**页签：顶部搜索框 → 结果列表（空查询时按分类分组浏览）→ 点一项，
 *     **面板原地**换成那个工具本体的界面（顶部一条「返回」），全程不弹第二个框；
 *   · **快捷**页签：应用入口（工具箱 / 工作台 / 密码存储器 / 桌面整理 / 设置 / 主窗口）
 *     + 我的快捷方式（与 Dock 同一份 `quicklinks` 数据）+ 系统入口（hosts 编辑 / 服务 /
 *     证书…，走 Rust 白名单 `sys_action_run`，无注入面）。
 *
 * ## V46：桌面上的东西一律**实心**
 *
 * 用户 09-19 的反馈：「工具箱这些工具类**不要透明了**，透明有问题」「现在这个全都是透明
 * 很难清楚的操作。还有大小也不太友好」。
 *
 * 半透明在桌面上是**可用性缺陷**而不是美化：壁纸是一张高对比照片时，面板里的文字、
 * 次级按钮、列表分隔都糊在背景上，读不清也点不准。所以 V46 起：
 *   · 面板外壳 `bg-neutral-900`（不透明），工具本体区 `bg-neutral-950`（不透明）
 *     —— 只保留 1px 的 `ring-white/15` 作边界，不再用 `/93 + backdrop-blur` 那套玻璃；
 *   · 尺寸按「装得下一个真实工具」定（`min(820px, ...)`、上下留白），不再按浮层定；
 *   · 标题栏提供 **「在控制台打开」**：桌面负责顺手用一下，控制台（主窗口）负责完整界面。
 *
 * ## 与其它组件的关系
 *
 * 本组件取代并删除了 `DesktopToolPanel`（大抽屉）与 `DesktopQuickActions`（右下浮层）；
 * Dock 保持原样 —— 它是「用户主动拖进来的快捷方式」，与这里的「找 / 用」不是同一诉求。
 * 工具本体仍走 `CommandMeta.load()` / `ModuleMeta.loadView()`，与主窗口同一条契约，
 * 不存在第二份实现。
 */

/**
 * 面板里能打开的一项：工具（命令）/ 模块页面 / 桌面快捷方式。
 *
 * V48 新增 `'link'`：用户 09-19 原话「桌面直接快捷键打开工具搜索列表，快捷方式可以直接
 * 显示上」—— 面板的列表原先只认注册表里的工具与页面，桌面上的快捷方式（含 `.lnk`）
 * 一个都搜不到，想开一个桌面上的东西还得先关面板去桌面找。现在它们与工具同列同搜。
 */
export interface PanelEntry {
  id: string;
  name: string;
  description: string;
  kind: 'tool' | 'module' | 'link';
  /** 工具分类（仅工具用；列表右侧的灰标签） */
  category?: string;
  /** 图标名（走 `resolveIcon`）；缺省按 kind 兜底 */
  icon?: string;
  /** 工具 / 模块：懒加载它自己的组件（快捷方式没有这一项） */
  load?: () => Promise<{ default: React.ComponentType<Record<string, never>> }>;
  /** 快捷方式：点一下就用系统默认程序打开（不占面板、就地走人） */
  open?: () => Promise<void>;
}

/**
 * 面板页签。
 *
 * V63 加 `settings`：用户 09-21 原话「快捷键设置直接弹出工具箱弹窗」—— 设置从
 * 「主窗口里的一整页」变成**面板里的第三个页签**，桌面之外不再需要第二个界面。
 */
export type SidePanelTab = 'tools' | 'quick' | 'settings';

export interface DesktopSidePanelProps {
  /** 打开时落在哪个页签 */
  initialTab?: SidePanelTab;
  /** 直接进入「使用模式」的那一项（如从工具栏「密码箱」带过来的） */
  initialEntry?: PanelEntry | null;
  /** 是否铺满右侧（`false` = 默认半屏） */
  wide: boolean;
  /** 在「半屏 / 铺满」之间切换 */
  onToggleWidth: () => void;
  /** 关闭面板 */
  onClose: () => void;
  /**
   * 快捷页签里打开一个应用入口（`module:<id>` / 命令 id）。
   *
   * V63：`settings` 不再从这里走 —— 它就在本面板的「设置」页签里，不需要外抛。
   */
  onLaunch: (target: string) => void;
  /** 打开一条用户快捷方式 */
  onOpenLink: (link: QuickLink) => void;
  /** 移除一条用户快捷方式 */
  onRemoveLink: (id: string) => void;
}

/**
 * 面板外壳的定位 / 尺寸类（由 `GridOverlay` 渲染外层容器时套用）。
 *
 * 尺寸按「装得下一个真实工具」定：分栏类工具（JSON 格式化 / 文本对比）左右两栏都要
 * 撑得开，所以半屏档在 1707px 宽的桌面上是 853px（远大于 V45 那版的 620px）。
 *
 * 两种宽度的由来（V49）——用户原话：
 *
 * > 「点工具弹出来的工具框，这里可以把右边宽度全部占全了，默认占一半的桌面空间，
 * >  后面的工具打开后的具体某个工具也有足够的操作功能，更加方便操作」
 *
 *   · `half`（**默认**）—— 占桌面**一半**（`50vw`）。右沿退到 `right-[448px]`
 *     给右下角常驻的「快捷入口」格子让位（V56 起它宽 320 = 日历宽，见下方
 *     [`sidePanelShell`]）；`calc(100vw-380px)` 是窄屏兜底 —— 50vw 有时比
 *     「可用宽度」还大，会把面板顶到屏幕外；
 *   · `full` —— 铺到右边缘（只留 12px 边距），分栏类工具能拉到最宽。
 *
 * 两档的**底边都在 `bottom-[92px]`**（底部居中的 Dock 最宽可到 60vw，横向必然与面板相交，
 * 所以纵向必须让开它）。而工具栏的悬浮球只在最底部 44px 内 —— 铺满时那颗球照样点得到，
 * 不会把自己关死。
 */
export type SidePanelWidth = 'half' | 'full';

/**
 * 面板外壳（V49 建立 · V56 对齐让位距离 · V60 让位对象从「快捷入口格子」换成「工作台」）。
 *
 * `right-*` 是给**右侧常驻的「工作台」浮窗**让位：它是固定宽度的（V62 起 400，
 * 见 `DesktopWorkstation` 的 `WORKSTATION_W`），贴着右边缘 32px，所以半屏档面板的右沿必须
 * 退到 `400 + 32 + 16（留一道缝）= 448px` 之外，否则面板下半截的右边缘会被它盖住 ——
 * 那一块正好是滚动条与最右侧按钮所在的位置，被盖住就是「点不动」。
 *
 * ⚠️ 铺满档是**横向盖住**工作台那一列的（`right-3 w-[calc(100vw-24px)]`），
 * 所以它靠的不是让位而是**层级**：面板 `z-40` > 工作台 `z-[38]`。
 * V60 之前工作台的 z 是随面板开关**动态**切的；现在改成静态阶梯（见 `DesktopWorkstation`
 * 里那段 z 说明），`test-desktop-constants.mjs` 会把「面板 z > 工作台 z」锁住 ——
 * 这条不能只靠「谁在 DOM 后面」，同 z 时正是 DOM 顺序说了算，而工作台排在面板之后。
 *
 * 用户 09-19 对宽度只提过一次要求（「默认占一半的桌面空间，后面的工具打开后的具体某个
 * 工具也有足够的操作功能」），所以半屏档仍以 `50vw` 为准，只是把它夹在「可用宽度」内。
 *
 *   · `half`（**默认**）—— 占桌面一半（`50vw`），右沿让开工作台；
 *   · `full` —— 铺到右边缘（只留 12px 边距），靠层级盖住工作台，面板是完整可用的。
 *
 * 两档的**底边都在 `bottom-[92px]`**（底部居中的 Dock 最宽可到 60vw，横向必然与面板相交，
 * 所以纵向必须让开它）。
 */
export function sidePanelShell(width: SidePanelWidth): string {
  const box = 'absolute top-4 bottom-[92px] z-40';
  return width === 'full'
    ? `${box} right-3 w-[calc(100vw-24px)]`
    : `${box} right-[448px] w-[min(50vw,calc(100vw-460px))]`;
}

/** 把注册表里的命令 / 模块统一成面板能渲染的条目 */
export function collectPanelEntries(): PanelEntry[] {
  const tools: PanelEntry[] = registry
    .commands()
    .filter((command) => typeof command.load === 'function')
    .map((command) => ({
      id: command.id,
      name: command.name,
      description: command.description,
      kind: 'tool' as const,
      ...(command.category !== undefined ? { category: command.category } : {}),
      ...(command.icon !== undefined ? { icon: command.icon } : {}),
      load: command.load as PanelEntry['load'],
    }));

  const modules: PanelEntry[] = registry
    .enabled()
    .filter((mod) => typeof mod.loadView === 'function')
    .map((mod) => ({
      id: `module:${mod.id}`,
      name: mod.name,
      description: mod.description,
      kind: 'module' as const,
      icon: mod.icon,
      load: mod.loadView as PanelEntry['load'],
    }));

  return [...tools, ...modules];
}

/**
 * 桌面上的快捷方式 / 未归类条目 → 面板可搜索可打开的条目（V48）。
 *
 * 数据来自 `grid_loose_list`（左侧「未归类」竖条那一份，Rust 扫真实桌面得出），
 * 取其中的**快捷方式**与**用户文件**，跳过系统入口（此电脑 / 回收站 / 用户的文件
 * —— 那些在「快捷」页签的系统入口里有更合适的入口，塞进搜索列表只会噪声）。
 *
 * 打开走 `grid_open_path`（ShellExecute，与桌面双击同一条路径），不移动、不复制。
 */
export async function loadDesktopShortcuts(): Promise<PanelEntry[]> {
  try {
    const area = await ipc.gridLooseList();
    return area.items
      .filter((entry) => !entry.isSystem)
      .map((entry) => ({
        id: `shortcut:${entry.path}`,
        name: entry.name,
        description: entry.isLnk ? '桌面快捷方式' : entry.isDir ? '桌面文件夹' : '桌面文件',
        kind: 'link' as const,
        open: () => ipc.gridOpenPath(entry.path),
      }));
  } catch {
    // 拿不到（非 Windows / 桌面不可读）就当没有快捷方式，不影响工具搜索本身
    return [];
  }
}

/** 桌面「应用入口」（点一下在面板里打开，不弹窗口） */
const APP_SHORTCUTS: ReadonlyArray<{
  target: string;
  name: string;
  description: string;
  icon: LucideIcon;
}> = [
  { target: 'module:toolbox', name: '工具箱', description: '全部本地小工具', icon: Wrench },
  { target: 'module:notes', name: '工作台', description: '日历 · 计划 · 笔记', icon: CalendarDays },
  { target: 'vault', name: '密码存储器', description: 'AES-256-GCM 本地密码库', icon: ShieldCheck },
  { target: 'module:desktop-organizer', name: '桌面整理', description: '一键整理 · 布局备份', icon: Boxes },
];

export function DesktopSidePanel({
  initialTab = 'tools',
  initialEntry = null,
  wide,
  onToggleWidth,
  onClose,
  onLaunch,
  onOpenLink,
  onRemoveLink,
}: DesktopSidePanelProps): React.JSX.Element {
  const [tab, setTab] = React.useState<SidePanelTab>(initialEntry !== null ? 'tools' : initialTab);
  /** 「设置」页签内要直接定位的项（V63：`'hotkey'` = 一进来就停在快捷键那一行） */
  const [settingsFocus, setSettingsFocus] = React.useState<'hotkey' | null>(null);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState<PanelEntry | null>(initialEntry);
  const [View, setView] = React.useState<React.ComponentType<Record<string, never>> | null>(null);
  const [loading, setLoading] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  /** 桌面快捷方式 / 未归类文件（V48）：与工具同列同搜，点一下直接打开 */
  const [shortcuts, setShortcuts] = React.useState<PanelEntry[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    void loadDesktopShortcuts().then((list) => {
      if (!cancelled) {
        setShortcuts(list);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const all = React.useMemo(() => [...collectPanelEntries(), ...shortcuts], [shortcuts]);

  // 落在「工具」页签且还在列表态时自动聚焦搜索框：打开面板就能直接敲
  React.useEffect(() => {
    if (tab === 'tools' && active === null) {
      inputRef.current?.focus();
    }
  }, [tab, active]);

  /** 搜索：命令走拼音 / 模糊（`searchCommands`），模块按名称 / 描述过滤，两路合并 */
  const results = React.useMemo(() => {
    const keyword = query.trim();
    if (keyword.length === 0) {
      return all;
    }
    const hit = new Set(searchCommands(registry.commands(), keyword, 80).map((command) => command.id));
    const lower = keyword.toLowerCase();
    return all.filter(
      (entry) =>
        hit.has(entry.id) ||
        entry.name.toLowerCase().includes(lower) ||
        entry.description.toLowerCase().includes(lower),
    );
  }, [query, all]);

  /** 空查询时按分类分组（可发现性：不只靠搜，也能顺着一栏栏看过去） */
  const grouped = React.useMemo(() => {
    const buckets = new Map<string, PanelEntry[]>();
    for (const entry of results) {
      const key =
        entry.kind === 'link'
          ? '__shortcuts__'
          : entry.kind === 'module'
            ? '__modules__'
            : (entry.category ?? 'other');
      const list = buckets.get(key);
      if (list) {
        list.push(entry);
      } else {
        buckets.set(key, [entry]);
      }
    }
    const ordered: { key: string; title: string; entries: PanelEntry[] }[] = [];
    for (const meta of orderedCategories()) {
      const list = buckets.get(meta.id);
      if (list && list.length > 0) {
        ordered.push({ key: meta.id, title: meta.name, entries: list });
      }
    }
    for (const [key, list] of buckets) {
      if (categoryMetaOf(key) === undefined && key !== '__modules__' && key !== '__shortcuts__') {
        ordered.push({ key, title: '其他', entries: list });
      }
    }
    const shortcuts = buckets.get('__shortcuts__');
    if (shortcuts && shortcuts.length > 0) {
      ordered.push({ key: '__shortcuts__', title: `桌面快捷方式（${shortcuts.length}）`, entries: shortcuts });
    }
    const modules = buckets.get('__modules__');
    if (modules && modules.length > 0) {
      ordered.push({ key: '__modules__', title: '页面', entries: modules });
    }
    return ordered;
  }, [results]);

  /**
   * 选中一项：
   *   · 快捷方式（`open`）→ 用系统默认程序打开，顺手收面板（用户要的就是「打开它」）；
   *   · 工具 / 页面（`load`）→ 在面板里就地打开它自己的界面。
   */
  const pick = React.useCallback(
    (entry: PanelEntry): void => {
      if (entry.open !== undefined) {
        const run = entry.open;
        onClose();
        void run().catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      setActive(entry);
    },
    [onClose],
  );

  // 选中 → 懒加载它自己的组件（与主窗口同一条 `load` / `loadView` 契约）
  React.useEffect(() => {
    if (active === null || active.load === undefined) {
      setView(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    void active
      .load()
      .then((mod) => {
        if (!cancelled) {
          setView(() => mod.default as React.ComponentType<Record<string, never>>);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setView(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  // Esc：先退回列表，再关面板
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      if (active !== null) {
        setActive(null);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);

  /** 快捷页签里「点了就走」的入口：先收面板，再执行（用户马上就能看到结果） */
  const launchAndClose = (fn: () => Promise<void>): void => {
    onClose();
    void fn().catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    );
  };

  /**
   * 跳到「设置」页签（V63）。
   *
   * `focus` 传 `'hotkey'` 时设置页会把快捷键那一行顶到最前并高亮 —— 用户原话
   * 「快捷键设置直接弹出工具箱弹窗」，他要的是「点一下就到快捷键」，不是「点一下
   * 到设置，然后自己在通用里找」。
   */
  const goSettings = (focus: 'hotkey' | null = null): void => {
    setActive(null);
    setSettingsFocus(focus);
    setTab('settings');
  };

  return (
    <div
      // 面板内部的事件不往桌面画布冒泡（否则会被当成「点空白处收面板」）
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      style={{ pointerEvents: 'auto' }}
      // V46 实心化：`bg-neutral-900`（不透明）+ 1px 边界。半透明玻璃在真实壁纸上
      // 会让正文、次级按钮、分隔线全部糊掉，用户的判断是「很难清楚的操作」——这是
      // 可用性问题，不是审美偏好。阴影保留，用来和壁纸区分层次。
      className="flex h-full w-full flex-col overflow-hidden rounded-2xl bg-neutral-900 text-neutral-100 shadow-2xl ring-1 ring-white/15"
    >
      {/* —— 顶栏：页签 + 控制台 + 关闭 —— */}
      <div className="flex items-center gap-1 border-b border-white/10 px-2.5 py-2">
        <TabButton
          icon={Wrench}
          label="工具"
          tip="搜索并使用任意工具 / 页面（在面板里就地打开）"
          active={tab === 'tools'}
          onClick={() => {
            setTab('tools');
            setActive(null);
          }}
        />
        <TabButton
          icon={Zap}
          label="快捷"
          tip="应用入口 · 我的快捷方式 · 系统入口"
          active={tab === 'quick'}
          onClick={() => {
            setTab('quick');
            setActive(null);
          }}
        />
        {/* V63：设置成为面板的第三个页签（原先要开主窗口）—— 用户「其他功能我们都
            已经在桌面上实现了…没有必要还有一个多一个界面」。 */}
        <TabButton
          icon={Settings}
          label="设置"
          tip="主题 · 快捷键 · 开机启动 · 备份还原"
          active={tab === 'settings'}
          onClick={() => goSettings(null)}
        />
        <button
          type="button"
          onClick={onToggleWidth}
          title={
            wide
              ? '收回到半屏（默认占桌面一半）'
              : '铺满右侧 —— 分栏类工具（文本对比 / JSON）能拉到最宽'
          }
          className="ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium text-neutral-300 transition hover:bg-white/10 hover:text-neutral-100"
        >
          {wide ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          {wide ? '半屏' : '铺满'}
        </button>
        <button
          type="button"
          onClick={onClose}
          title="关闭面板（Esc）"
          className="rounded-md p-1 text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {tab === 'tools' ? (
        <ToolsTab
          active={active}
          View={View}
          loading={loading}
          query={query}
          setQuery={setQuery}
          inputRef={inputRef}
          results={results}
          grouped={grouped}
          firstResult={results[0] ?? null}
          onPick={pick}
          onBack={() => setActive(null)}
        />
      ) : tab === 'settings' ? (
        <SettingsTab focus={settingsFocus} />
      ) : (
        <QuickTab
          onLaunch={onLaunch}
          onOpenLink={onOpenLink}
          onRemoveLink={onRemoveLink}
          onOpenSettings={() => goSettings(null)}
          onOpenHotkey={() => goSettings('hotkey')}
        />
      )}
    </div>
  );
}

/** 页签按钮 */
function TabButton({
  icon: Icon,
  label,
  tip,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  tip: string;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tip}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition',
        active ? 'bg-white/15 text-sky-200' : 'text-neutral-300 hover:bg-white/10',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/**
 * 「设置」页签（V63）：直接内嵌主窗口那一份 `SettingsCenter`，**不存在第二份实现**。
 *
 * 外面那层 `dark` 不是装饰：面板底色是固定的 `bg-neutral-900`，而 `SettingsCenter`
 * 用的是语义色（`text-foreground` / `text-muted-foreground` / `bg-background`）。
 * 系统主题是浅色时，不套这层就是**黑底黑字**，什么都看不见（Tailwind `darkMode:
 * 'class'`，`.dark` 把整组 CSS 变量在子树里换成深色档，见 `src/index.css`）。
 */
function SettingsTab({ focus }: { focus: 'hotkey' | null }): React.JSX.Element {
  return (
    <div className="dark flex min-h-0 flex-1 flex-col overflow-hidden bg-neutral-900">
      <SettingsCenter embedded focus={focus} />
    </div>
  );
}

/** 「工具」页签：搜索 + 列表，或（选中后）工具本体 */
function ToolsTab({
  active,
  View,
  loading,
  query,
  setQuery,
  inputRef,
  results,
  grouped,
  firstResult,
  onPick,
  onBack,
}: {
  active: PanelEntry | null;
  View: React.ComponentType<Record<string, never>> | null;
  loading: boolean;
  query: string;
  setQuery: (value: string) => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
  results: PanelEntry[];
  grouped: { key: string; title: string; entries: PanelEntry[] }[];
  firstResult: PanelEntry | null;
  onPick: (entry: PanelEntry) => void;
  onBack: () => void;
}): React.JSX.Element {
  if (active !== null) {
    const Icon =
      active.kind === 'link'
        ? Link2
        : active.icon !== undefined
          ? resolveIcon(active.icon)
          : active.kind === 'module'
            ? Boxes
            : Wrench;
    return (
      <>
        {/* V50：选中工具后的顶部条重新分区（用户 09-19：「图4 这个工具框样式很乱很奇
            怪」）。原来「返回 / 名称 / 控制台」挤在一行，名称没图标、工具本体又直接从
            `bg-neutral-950` 开始，视觉上没有“这是哪个工具”的锚点。改为：图标徽标 + 名称
            （大）+ 描述（小）占左侧，右侧只有返回；「在控制台打开」沉到工具本体右上角，
            需要更大空间时才显眼地出现。 */}
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
          <button
            type="button"
            onClick={onBack}
            title="返回工具列表（Esc）"
            className="shrink-0 rounded-full border border-white/10 bg-white/5 p-1.5 text-neutral-300 transition hover:border-white/25 hover:bg-white/10 hover:text-neutral-100"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <span className="shrink-0 rounded-lg bg-sky-400/15 p-1.5 text-sky-200">
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold text-neutral-100">
              {active.name}
            </span>
            <span className="block truncate text-[11px] text-neutral-400">
              {active.description}
            </span>
          </span>
          {/* V63 删掉了这里的「打开完整版」按钮：它做的正是用户不要的那件事 ——
              为了同一个工具再弹一个独立窗口。工具本体就在下面这块里，已经完整。 */}
        </div>
        {/* V46：工具本体底**必须不透明** —— 工具自己只画内容，不再叠在半透明玻璃上 */}
        <div className="min-h-0 flex-1 overflow-auto bg-neutral-950">
          {loading || View === null ? (
            <div className="flex h-full items-center justify-center gap-2 text-[12px] text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在打开 {active.name}…
            </div>
          ) : (
            <View />
          )}
        </div>
      </>
    );
  }

  const keyword = query.trim();

  return (
    <>
      <div className="flex items-center gap-2 border-b border-white/10 px-3.5 py-2.5">
        <Search className="h-4 w-4 shrink-0 opacity-60" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && firstResult !== null) {
              onPick(firstResult);
            }
          }}
          placeholder="搜索工具 / 页面 / 桌面快捷方式（名称、拼音首字母都行）…"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-100 outline-none placeholder:text-neutral-500"
        />
        <span className="shrink-0 text-[11px] text-neutral-500">{results.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {results.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-neutral-500">没有匹配项</p>
        )}
        {keyword.length > 0
          ? results.map((entry) => <EntryRow key={entry.id} entry={entry} onPick={onPick} />)
          : grouped.map((group) => (
              <div key={group.key} className="mb-2">
                <p className="px-2.5 pb-1.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  {group.title}
                </p>
                {group.entries.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} onPick={onPick} />
                ))}
              </div>
            ))}
      </div>
      <p className="border-t border-white/10 px-3.5 py-2 text-[11px] text-neutral-500">
        回车打开第一项 · 在这里实心面板里顺手用；要更多空间 / 完整界面，点右上「在控制台打开」
      </p>
    </>
  );
}

/** 列表里的一行 */
function EntryRow({
  entry,
  onPick,
}: {
  entry: PanelEntry;
  onPick: (entry: PanelEntry) => void;
}): React.JSX.Element {
  const Icon =
    entry.kind === 'link'
      ? Link2
      : entry.icon !== undefined
        ? resolveIcon(entry.icon)
        : entry.kind === 'module'
          ? Boxes
          : Wrench;
  const category = entry.kind === 'tool' ? categoryMetaOf(entry.category) : undefined;
  return (
    <button
      type="button"
      onClick={() => onPick(entry)}
      title={entry.description}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-white/10"
    >
      <span className="shrink-0 rounded-md bg-white/10 p-2 text-neutral-200">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{entry.name}</span>
        <span className="block truncate text-[11px] text-neutral-400">{entry.description}</span>
      </span>
      {entry.kind === 'link' ? (
        <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-400">
          打开
        </span>
      ) : category !== undefined ? (
        <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-400">
          {category.name}
        </span>
      ) : null}
    </button>
  );
}

/** 「快捷」页签：应用入口 + 我的快捷方式 + 系统入口 */
function QuickTab({
  onLaunch,
  onOpenLink,
  onRemoveLink,
  onOpenSettings,
  onOpenHotkey,
}: {
  onLaunch: (target: string) => void;
  onOpenLink: (link: QuickLink) => void;
  onRemoveLink: (id: string) => void;
  /** 切到「设置」页签（V63：不再去开主窗口） */
  onOpenSettings: () => void;
  /** 切到「设置」页签并直接停在快捷键那一行 */
  onOpenHotkey: () => void;
}): React.JSX.Element {
  const [actions, setActions] = React.useState<SysAction[]>([]);
  const [links, setLinks] = React.useState<QuickLink[]>(() => loadQuickLinks());
  const [runningId, setRunningId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);

  const pinnedIds = useAppStore((state) => state.settings.quickActionIds);
  const updateSettings = useAppStore((state) => state.updateSettings);

  /** 把一条系统入口固定 / 取消固定到桌面 Dock（共用同一份 `settings.quickActionIds`） */
  const togglePin = (id: string): void => {
    const next = pinnedIds.includes(id)
      ? pinnedIds.filter((item) => item !== id)
      : [...pinnedIds, id];
    // V56：打上「用户亲手改过」的标记 —— 之后口径再升级也不会覆盖他自己这份列表
    // （见 `core/settings.ts` 的 `resolveQuickActionIds`）
    void updateSettings({ quickActionIds: next, quickActionsCustomized: true }).catch(
      (error: unknown) => {
        toast.error(`固定失败：${error instanceof Error ? error.message : String(error)}`);
      },
    );
  };

  React.useEffect(() => {
    void ipc
      .sysActionList()
      .then((list) => {
        setActions(list);
        setNotice(null);
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error));
      });
  }, []);

  // 用户快捷方式可能在 Dock 拖入后变化，这里订阅 localStorage 实时同步
  React.useEffect(() => {
    const sync = (): void => setLinks(loadQuickLinks());
    window.addEventListener('handy:quicklinks', sync as EventListener);
    return () => window.removeEventListener('handy:quicklinks', sync as EventListener);
  }, []);

  const byId = React.useMemo(() => new Map(actions.map((action) => [action.id, action])), [actions]);
  const pinned = React.useMemo(
    () =>
      pinnedIds
        .map((id) => byId.get(id))
        .filter((action): action is SysAction => action !== undefined),
    [pinnedIds, byId],
  );

  const groupedActions = React.useMemo(() => {
    const map = new Map<string, SysAction[]>();
    for (const action of actions) {
      const bucket = map.get(action.group);
      if (bucket) {
        bucket.push(action);
      } else {
        map.set(action.group, [action]);
      }
    }
    return Array.from(map.entries());
  }, [actions]);

  /**
   * 按「**Windows 上好不好找**」把系统入口分成两拨（V56）。
   *
   * 这是本次给桌面快捷入口定的取舍判据的**可视化**：用户 09-20 原话「任务栏右键随时都可以
   * 打开的没必要放在这里，我们这个快捷入口要放一起 window 上操作不方便的入口功能」。
   * 所以面板里把「好找的」单独归一组并说明为什么默认不钉 —— 用户想钉照样能钉，
   * 但至少知道自己在钉什么，而不是面对一坨 40 项不分彼此的列表。
   */
  const easyIds = React.useMemo(() => new Set<string>(DOCK_EASY_TO_REACH_IDS), []);
  const recommended = React.useMemo(
    () => groupedActions
      .map(([group, list]): [string, SysAction[]] => [group, list.filter((a) => !easyIds.has(a.id))])
      .filter(([, list]) => list.length > 0),
    [groupedActions, easyIds],
  );
  const easy = React.useMemo(
    () => groupedActions
      .map(([group, list]): [string, SysAction[]] => [group, list.filter((a) => easyIds.has(a.id))])
      .filter(([, list]) => list.length > 0),
    [groupedActions, easyIds],
  );
  const recommendedCount = React.useMemo(
    () => recommended.reduce((sum, [, list]) => sum + list.length, 0),
    [recommended],
  );

  const run = (action: SysAction): void => {
    setRunningId(action.id);
    void ipc
      .sysActionRun(action.id)
      .then(() => {
        if (action.elevated) {
          toast.success(`已请求管理员权限：${action.name}`, {
            description: '请在系统弹窗中点「是」以继续',
          });
        }
      })
      .catch((error: unknown) => {
        toast.error(`执行失败：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => setRunningId(null));
  };

  const ActionButton = ({ action }: { action: SysAction }): React.JSX.Element => {
    const Icon = ACTION_ICONS[action.id] ?? Wrench;
    const running = runningId === action.id;
    const isPinned = pinnedIds.includes(action.id);
    return (
      <div className="group relative">
        <button
          type="button"
          disabled={running}
          title={`${action.name} — ${action.description}`}
          onClick={() => run(action)}
          className="flex w-full items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 pr-6 text-left transition hover:border-sky-400/40 hover:bg-white/10"
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-100">{action.name}</span>
          {action.elevated ? (
            <span className="shrink-0 rounded bg-amber-400/20 px-1 text-[8px] text-amber-200">管</span>
          ) : null}
          {running ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-300" /> : null}
        </button>
        {/* 图钉开关：钉 = 同时出现在桌面 Dock 上（V44.1 起可在桌面直接钉，不必回工作台） */}
        <button
          type="button"
          onClick={() => togglePin(action.id)}
          title={isPinned ? '取消固定（同时从桌面 Dock 移除）' : '固定到桌面 Dock'}
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 transition',
            isPinned
              ? 'text-sky-300'
              : 'text-neutral-500 opacity-0 hover:text-neutral-200 group-hover:opacity-100',
          )}
        >
          {isPinned ? <ChevronDown className="h-3 w-3 rotate-180" /> : <Plus className="h-3 w-3" />}
        </button>
      </div>
    );
  };

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {/* —— 应用入口 —— */}
      <Section title="应用入口">
        <div className="grid grid-cols-2 gap-1.5">
          {APP_SHORTCUTS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.target}
                type="button"
                onClick={() => onLaunch(item.target)}
                title={item.description}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-left transition hover:border-sky-400/40 hover:bg-white/10"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
                <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-100">{item.name}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={onOpenSettings}
            title="主题 · 开机启动 · 备份还原 · 模块开关（就在本面板的「设置」页签里）"
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-left transition hover:border-sky-400/40 hover:bg-white/10"
          >
            <Settings className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-100">设置</span>
          </button>
          {/* V63：用户「快捷键设置直接弹出工具箱弹窗」—— 点它就是「工具箱弹窗里
              直接停在快捷键那一行」，中间不再经过任何别的界面。 */}
          <button
            type="button"
            onClick={onOpenHotkey}
            title="直接改全局呼出快捷键（Alt+Space 那一组）"
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-left transition hover:border-sky-400/40 hover:bg-white/10"
          >
            <Keyboard className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-neutral-100">快捷键</span>
          </button>
        </div>
      </Section>

      {/* —— 我的快捷方式（与 Dock 同源） —— */}
      <Section title={`我的快捷方式（${links.length}）`}>
        {links.length === 0 ? (
          <p className="px-1 py-1.5 text-[11px] leading-relaxed text-neutral-500">
            把桌面图标 / 文件拖到下方的快捷条（Dock）即可收成一条；这里与 Dock 是同一份数据。
          </p>
        ) : (
          <div className="space-y-1">
            {links.map((link) => (
              <div
                key={link.id}
                className="group flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 transition hover:border-sky-400/40 hover:bg-white/10"
              >
                {link.type === 'url' ? (
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-sky-200" />
                ) : (
                  <Boxes className="h-3.5 w-3.5 shrink-0 text-neutral-200" />
                )}
                <button
                  type="button"
                  onClick={() => onOpenLink(link)}
                  title={`${link.name}\n${link.value}\n单击打开`}
                  className="min-w-0 flex-1 truncate text-left text-[12px] text-neutral-100"
                >
                  {link.name}
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveLink(link.id)}
                  title="从快捷方式移除（不删文件）"
                  className="shrink-0 rounded p-0.5 text-neutral-500 opacity-0 transition hover:bg-white/10 hover:text-red-300 group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* —— 系统快捷（已钉的常用入口） —— */}
      <Section title={`系统快捷（${pinned.length}）`}>
        {pinned.length === 0 ? (
          <p className="px-1 py-1.5 text-[11px] leading-relaxed text-neutral-500">
            还没有固定常用入口。展开下面的「全部系统入口」，鼠标移到任意项上点右侧图钉即可固定到桌面
            Dock。
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {pinned.map((action) => (
              <ActionButton key={action.id} action={action} />
            ))}
          </div>
        )}
      </Section>

      {/* —— 全部系统入口（可折叠） —— */}
      <Section
        title="全部系统入口"
        action={
          <button
            type="button"
            onClick={() => setShowAll((prev) => !prev)}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-sky-300 transition hover:bg-white/10"
          >
            {showAll ? '收起' : '展开'}
            <ChevronDown className={cn('h-3 w-3 transition', showAll ? 'rotate-180' : '')} />
          </button>
        }
      >
        {showAll ? (
          notice !== null ? (
            <p className="px-1 py-1 text-[10px] text-amber-300">{notice}</p>
          ) : (
            <div className="space-y-3">
              <ActionGroups
                title="推荐：Windows 上不好找的"
                hint="系统里没有现成入口（或深藏四五级设置）—— 这些默认已经钉在桌面右下角的「快捷入口」格子里"
                groups={recommended}
                render={(action) => <ActionButton key={action.id} action={action} />}
              />
              <ActionGroups
                title="系统里已有入口"
                hint="任务栏右键 / 任务栏图标 / Win+V / 设置首页都能直达，默认不占桌面快捷入口的格子 —— 想放也点右侧图钉"
                groups={easy}
                render={(action) => <ActionButton key={action.id} action={action} />}
              />
            </div>
          )
        ) : (
          <p className="px-1 py-1.5 text-[11px] leading-relaxed text-neutral-500">
            共 {actions.length} 个系统面板，其中 {recommendedCount} 个是「Windows 上不好找」的
            —— 它们默认已经钉在桌面右下角的「快捷入口」里，展开后点一下即开、点图钉即改。
          </p>
        )}
      </Section>
    </div>
  );
}

/** 小标题 + 可选右侧操作 */
function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{title}</span>
        <span className="h-px flex-1 bg-white/5" />
        {action}
      </div>
      {children}
    </div>
  );
}


/**
 * 「全部系统入口」里的一拨（V56 拆成「不好找的 / 已有入口的」）。
 *
 * 两拨各自的**分组名**（终端 / 网络 / 系统管理）仍照 Rust 白名单表来，只是外面多套一层
 * 取舍说明 —— 让用户一眼看出「为什么这几项默认在这个入口里、那几项不在」。
 */
function ActionGroups({
  title,
  hint,
  groups,
  render,
}: {
  title: string;
  hint: string;
  groups: [string, SysAction[]][];
  render: (action: SysAction) => React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <p className="text-[11px] font-semibold text-neutral-200">{title}</p>
      <p className="mb-1.5 text-[10px] leading-relaxed text-neutral-500">{hint}</p>
      {groups.length === 0 ? (
        <p className="px-1 text-[10px] text-neutral-500">（这一类暂时为空）</p>
      ) : (
        <div className="space-y-2">
          {groups.map(([groupName, list]) => (
            <div key={groupName}>
              <p className="mb-1 text-[10px] font-medium text-neutral-400">{groupName}</p>
              <div className="grid grid-cols-2 gap-1.5">{list.map(render)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
