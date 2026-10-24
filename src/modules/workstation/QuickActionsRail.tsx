import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  AppWindow,
  BadgeCheck,
  BatteryCharging,
  Bluetooth,
  Cable,
  CalendarClock,
  Check,
  ClipboardList,
  Clock,
  Cpu,
  Database,
  DownloadCloud,
  Eraser,
  FileCode,
  FolderOpen,
  FolderTree,
  Gauge,
  Globe,
  HardDrive,
  HardDriveDownload,
  History,
  Info,
  LayoutGrid,
  LineChart,
  Loader2,
  Monitor,
  MonitorSmartphone,
  Network,
  Package,
  Plug,
  Printer,
  RefreshCw,
  Rocket,
  RotateCcw,
  ScrollText,
  Settings,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Terminal,
  Trash2,
  UserCog,
  Users,
  Variable,
  Volume2,
  Wifi,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import { openSettings, openTarget } from '@/core/navigation';
import { DEFAULT_QUICK_ACTION_IDS } from '@/core/settings';
import { useAppStore } from '@/stores/useAppStore';
import { cn } from '@/lib/utils';
import type { SysAction } from '@/types/sys';

/**
 * 工作台「快捷入口」图标栏。
 *
 * # 用户反馈（V21 第二轮）
 *
 * 「快捷图标 tip 跑到界面外面去了不能显示全了，而且快捷图标多了竖行显示不全都丢失了，
 *   可以自适应或者流布局根据多少自动展开显示还是怎么规划更好。」
 *
 * 两处都改了根因，而不是加个 `overflow: visible` 糊过去：
 *
 * 1. **tip 溢出** —— 原来的气泡是按钮里的 `absolute left-full`，而栏本身会被
 *    窗口/滚动容器裁剪，气泡一长就只剩半截。现在改成 **React Portal 挂到 `body`**
 *    + `position: fixed` 按按钮矩形定位，且默认往**左**弹（栏在最右侧），
 *    左边放不下才翻到右边 —— 无论栏怎么滚动、窗口多窄都完整可见。
 * 2. **图标太多显示不全** —— 竖排一列在 768p 屏上最多放 9 个，第 10 个就被切掉了。
 *    现在图标区**按可用高度自动分列**（1–3 列，列优先排布，顺序仍然是从上往下读），
 *    仍放不下时该区可滚动，底部「设置 / 自定义」两个按钮永远钉在栏底。
 *
 * 安全边界不变：前端只传动作 **id**，可执行目标与参数硬编码在 Rust 白名单表
 * （`src-tauri/src/commands/sys.rs`），不存在命令注入面。
 */

/**
 * 动作 id → 图标（未列出的回退扳手）。
 *
 * V43 起导出：桌面**快捷条 Dock** 也要画同一批系统入口（用户原话「原工作台我们不是
 * 添加了各种快捷入口吗（如 hosts 文件编辑等都没有了呢）」），两处必须用同一套图标，
 * 否则同一个动作在工作台和桌面上长得不一样。
 */
export const ACTION_ICONS: Record<string, LucideIcon> = {
  'powershell-admin': ShieldCheck,
  'cmd-admin': Terminal,
  powershell: SquareTerminal,
  ipconfig: Network,
  ncpa: Cable,
  'dns-flush': RefreshCw,
  'hosts-edit': FileCode,
  'hosts-folder': FolderOpen,
  'network-settings': Wifi,
  'wifi-settings': Wifi,
  'proxy-settings': Globe,
  'shared-folders': FolderTree,
  taskmgr: Activity,
  services: Settings2,
  'device-mgr': Cpu,
  'disk-mgr': HardDrive,
  'event-viewer': ScrollText,
  firewall: Shield,
  registry: Database,
  'system-info': Info,
  perfmon: LineChart,
  'env-vars': Variable,
  'system-props': SlidersHorizontal,
  programs: Package,
  'windows-update': DownloadCloud,
  'startup-apps': Rocket,
  'display-settings': Monitor,
  'storage-settings': HardDrive,
  power: BatteryCharging,
  'date-time': Clock,
  sound: Volume2,
  'control-panel': LayoutGrid,
  'temp-folder': Trash2,
  'task-scheduler': CalendarClock,
  'resource-monitor': Gauge,
  'system-config': Wrench,
  'disk-cleanup': Eraser,
  defrag: HardDriveDownload,
  'user-accounts': UserCog,
  'local-users': Users,
  'cert-manager': BadgeCheck,
  odbc: Plug,
  'system-restore': History,
  'printer-settings': Printer,
  'bluetooth-settings': Bluetooth,
  'default-apps': AppWindow,
  'clipboard-settings': ClipboardList,
  'remote-desktop': MonitorSmartphone,
  defender: ShieldAlert,
};

/**
 * 应用内跳转（走模块视图 / 命令视图，跨窗口状态由 store 驱动）。
 *
 * V45：`target` 统一为「导航目标字符串」（`module:<id>` 或命令 id）——
 * vault 已从模块降级为工具箱工具，所以它这里是命令 id `vault` 而不是 `module:vault`。
 */
const APP_SHORTCUTS: ReadonlyArray<{ target: string; name: string; description: string; icon: LucideIcon }> = [
  { target: 'module:notes', name: '工作台', description: '日历 · 任务 · 便签 · 快捷入口', icon: LayoutGrid },
  { target: 'module:toolbox', name: '工具箱', description: '25 个本地小工具（对比 / Cron / 正则 / 编码…）', icon: Wrench },
  { target: 'vault', name: '密码存储器', description: 'AES-256-GCM 加密的本地密码库', icon: ShieldCheck },
];

/** 栏内单个图标按钮的固定边长（与 `h-11 w-11` 一致） */
const RAIL_ITEM = 44;
/** 栏内间距（与 `gap-1.5` 一致） */
const RAIL_GAP = 6;
/** 最多分几列（再多就把内容区挤没了） */
const RAIL_MAX_COLS = 3;

/** 悬停气泡的内容与锚点 */
interface TipState {
  name: string;
  description: string;
  elevated: boolean;
  /** 触发按钮的视口矩形（`getBoundingClientRect`） */
  rect: DOMRect;
}

/**
 * 悬停说明气泡 —— 用 Portal 挂到 body，彻底摆脱父级 `overflow` 裁剪。
 *
 * 定位策略：优先弹在按钮**左侧**（栏贴着窗口右边），左边空间不足时翻到右侧；
 * 垂直方向以按钮中线对齐，并夹在视口内（8px 边距），确保长文案也完整可读。
 */
function TipPortal({ tip }: { tip: TipState | null }): React.JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted || tip === null || typeof document === 'undefined') {
    return null;
  }

  const WIDTH = 240;
  const MARGIN = 8;
  const gap = 10;
  // 左侧优先；放不下翻右侧；两侧都放不下就贴到视口内最靠左的位置
  const preferLeft = tip.rect.left - gap - WIDTH >= MARGIN;
  const left = preferLeft
    ? tip.rect.left - gap - WIDTH
    : Math.min(tip.rect.right + gap, window.innerWidth - WIDTH - MARGIN);
  const rawTop = tip.rect.top + tip.rect.height / 2;
  // 估算高度上限（两行文案 + 标题），用于把气泡夹在视口内
  const top = Math.min(Math.max(rawTop, 56), window.innerHeight - 56);

  return createPortal(
    <div
      role="tooltip"
      style={{ left, top, width: WIDTH }}
      className="pointer-events-none fixed z-[9999] -translate-y-1/2 rounded-lg bg-neutral-900/95 px-2.5 py-1.5 text-left shadow-xl ring-1 ring-white/10"
    >
      <span className="flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-neutral-50">{tip.name}</span>
        {tip.elevated ? (
          <span className="rounded bg-amber-400/20 px-1 text-[9px] text-amber-200">管理员</span>
        ) : null}
      </span>
      <span className="mt-0.5 block text-[10px] leading-snug text-neutral-300">{tip.description}</span>
    </div>,
    document.body,
  );
}

/** 栏内单个图标按钮 */
function RailButton({
  icon: Icon,
  name,
  description,
  elevated,
  running,
  active,
  onClick,
  onTip,
  onTipEnd,
}: {
  icon: LucideIcon;
  name: string;
  description: string;
  elevated?: boolean;
  running?: boolean;
  active?: boolean;
  onClick: () => void;
  onTip: (tip: TipState) => void;
  onTipEnd: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement | null>(null);

  const show = (): void => {
    const node = ref.current;
    if (node === null) {
      return;
    }
    onTip({ name, description, elevated: elevated === true, rect: node.getBoundingClientRect() });
  };

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={running}
      title={`${name} — ${description}`}
      onMouseEnter={show}
      onFocus={show}
      onMouseLeave={onTipEnd}
      onBlur={onTipEnd}
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition',
        active
          ? 'border-brand/50 bg-brand-muted text-brand'
          : 'border-transparent text-muted-foreground hover:border-brand/40 hover:bg-brand-muted/60 hover:text-brand',
        running && 'opacity-60',
      )}
    >
      {running === true ? <Loader2 className="h-5 w-5 animate-spin" /> : <Icon className="h-5 w-5" />}
      {elevated === true ? (
        <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-400" />
      ) : null}
    </button>
  );
}

export function QuickActionsRail(): React.JSX.Element {
  const [actions, setActions] = useState<SysAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [tip, setTip] = useState<TipState | null>(null);
  /** 图标区每列能放几个（0 = 还没量到，按 1 列渲染） */
  const [perCol, setPerCol] = useState(0);

  const selectedIds = useAppStore((state) => state.settings.quickActionIds);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const view = useAppStore((state) => state.view);

  const load = useCallback((): void => {
    if (!isTauri()) {
      setLoading(false);
      setNotice('系统快捷入口需在 Toolbox 桌面应用内运行');
      return;
    }
    setLoading(true);
    void ipc
      .sysActionList()
      .then((list) => {
        setActions(list);
        setNotice(null);
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
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

  const pinned = useMemo(() => {
    const byId = new Map(actions.map((action) => [action.id, action]));
    return selectedIds
      .map((id) => byId.get(id))
      .filter((action): action is SysAction => action !== undefined);
  }, [actions, selectedIds]);

  /**
   * 图标区自适应分列。
   *
   * 用 ResizeObserver 盯住图标区的可用高度，算出「每列能放几个」，再据此把图标
   * **列优先**切块（从上往下读，读完一列再读下一列）。列数上限 [`RAIL_MAX_COLS`]，
   * 还放不下时靠该区自身滚动兜底 —— 总之不会有图标「消失」。
   */
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = listRef.current;
    if (node === null) {
      return undefined;
    }
    const compute = (): void => {
      const height = node.clientHeight;
      if (height <= 0) {
        return;
      }
      const count = Math.max(1, Math.floor((height + RAIL_GAP) / (RAIL_ITEM + RAIL_GAP)));
      setPerCol((prev) => (prev === count ? prev : count));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, pinned.length]);

  const toggle = (id: string): void => {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((item) => item !== id)
      : [...selectedIds, id];
    // V56：勾选即视为「用户亲手改过」—— 之后默认口径再升级也不覆盖他这份列表
    // （见 `core/settings.ts` 的 `resolveQuickActionIds`）
    void updateSettings({ quickActionIds: next, quickActionsCustomized: true }).catch(
      (error: unknown) => {
        toast.error('保存快捷入口设置失败', {
          description: error instanceof Error ? error.message : String(error),
        });
      },
    );
  };

  const run = (action: SysAction): void => {
    setRunningId(action.id);
    void ipc
      .sysActionRun(action.id)
      .then(() => {
        toast.success(action.elevated ? `已请求管理员权限：${action.name}` : `已打开：${action.name}`, {
          description: action.elevated ? '请在系统弹窗中点「是」以继续' : undefined,
        });
      })
      .catch((error: unknown) => {
        toast.error(`执行失败：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => setRunningId(null));
  };

  /** 该导航目标当前是否就是正在展示的视图（模块看 moduleId，命令看 commandId） */
  const isTargetActive = (target: string): boolean => {
    if (target.startsWith('module:')) {
      return view.kind === 'module' && view.moduleId === target.slice('module:'.length);
    }
    return view.kind === 'command' && view.commandId === target;
  };

  /** 待排布的按钮节点（应用内跳转在前，系统动作在后，顺序即用户的自定义顺序） */
  const items = useMemo<React.JSX.Element[]>(() => {
    const nodes: React.JSX.Element[] = APP_SHORTCUTS.map((item) => (
      <RailButton
        key={`app-${item.target}`}
        icon={item.icon}
        name={item.name}
        description={item.description}
        active={isTargetActive(item.target)}
        onClick={() => openTarget(item.target)}
        onTip={setTip}
        onTipEnd={() => setTip(null)}
      />
    ));

    if (loading) {
      nodes.push(
        <span key="loading" className="flex h-11 w-11 items-center justify-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </span>,
      );
    } else {
      for (const action of pinned) {
        nodes.push(
          <RailButton
            key={`act-${action.id}`}
            icon={ACTION_ICONS[action.id] ?? Wrench}
            name={action.name}
            description={action.description}
            elevated={action.elevated}
            running={runningId === action.id}
            onClick={() => run(action)}
            onTip={setTip}
            onTipEnd={() => setTip(null)}
          />,
        );
      }
    }

    if (pinned.length === 0 && !loading) {
      nodes.push(
        <RailButton
          key="empty"
          icon={Wrench}
          name="还没有快捷入口"
          description="点这里从 50+ 个系统面板里挑常用的（终端 / 网络 / 服务 / 证书…）"
          onClick={() => setCustomizing(true)}
          onTip={setTip}
          onTipEnd={() => setTip(null)}
        />,
      );
    }

    if (notice !== null) {
      nodes.push(
        <button
          key="notice"
          type="button"
          title={notice}
          onClick={load}
          className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-100 text-[9px] leading-tight text-amber-800"
        >
          需桌面版
        </button>,
      );
    }
    return nodes;
    // isModuleActive 依赖 view，run/toggle 每次渲染重建；这里只关心列表内容变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned, loading, runningId, notice, view, load]);

  /** 列优先切块：读的时候从上往下，读完一列再读下一列 */
  const columns = useMemo<React.JSX.Element[][]>(() => {
    const size = Math.max(1, perCol);
    const out: React.JSX.Element[][] = [];
    for (let i = 0; i < items.length; i += size) {
      out.push(items.slice(i, i + size));
    }
    return out;
  }, [items, perCol]);

  const overflow = perCol > 0 && columns.length > RAIL_MAX_COLS;

  return (
    // `relative` 是自定义面板 `absolute right-full` 的定位上下文 —— 少了它，面板会
    // 以视口为参照滑到屏幕左侧外面去（整块看不见）。
    <aside className="relative flex h-full shrink-0 flex-col items-center gap-1.5 self-stretch rounded-2xl border border-border bg-card py-3 shadow-panel">
      {/* —— 图标区：自适应分列 + 溢出滚动 —— */}
      <div
        ref={listRef}
        className={cn(
          'flex min-h-0 flex-1 items-start gap-1.5 overflow-y-auto px-1.5',
          overflow ? 'scrollbar-thin' : 'overflow-x-hidden',
        )}
      >
        {columns.slice(0, overflow ? RAIL_MAX_COLS : columns.length).map((column, index) => (
          <div key={index} className="flex flex-col gap-1.5">
            {column}
          </div>
        ))}
        {overflow ? (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setCustomizing(true)}
              title={`还有 ${items.length - RAIL_MAX_COLS * perCol} 个快捷入口没显示，点这里精简或调整`}
              onMouseEnter={(event) =>
                setTip({
                  name: '还有更多快捷入口',
                  description: `栏内放不下全部 ${items.length} 个，点这里打开自定义面板精简；也可以把窗口拉高。`,
                  elevated: false,
                  rect: event.currentTarget.getBoundingClientRect(),
                })
              }
              onMouseLeave={() => setTip(null)}
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-dashed border-border text-[10px] text-muted-foreground transition hover:border-brand/40 hover:text-brand"
            >
              +{items.length - RAIL_MAX_COLS * perCol}
            </button>
          </div>
        ) : null}
      </div>

      <span className="h-px w-8 shrink-0 bg-border" />

      {/* —— 常驻底部：设置 / 自定义（永远钉在栏底，不随滚动藏起来）—— */}
      <div className="flex shrink-0 flex-col gap-1.5 px-1.5">
        <RailButton
          icon={Settings}
          name="设置中心"
          description="快捷键 · 主题 · 开机启动 · 备份还原"
          active={view.kind === 'settings'}
          onClick={() => openSettings()}
          onTip={setTip}
          onTipEnd={() => setTip(null)}
        />
        <button
          type="button"
          onClick={() => setCustomizing((prev) => !prev)}
          title="自定义快捷入口"
          onMouseEnter={(event) =>
            setTip({
              name: '自定义快捷入口',
              description: '从全量系统面板里勾选常用项，选择立即保存',
              elevated: false,
              rect: event.currentTarget.getBoundingClientRect(),
            })
          }
          onMouseLeave={() => setTip(null)}
          className={cn(
            'flex h-11 w-11 items-center justify-center rounded-xl border transition',
            customizing
              ? 'border-brand/50 bg-brand-muted text-brand'
              : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Settings2 className="h-5 w-5" />
        </button>
      </div>

      {/* —— 自定义面板（往左滑出；不再被栏宽裁剪）—— */}
      {customizing ? (
        <div className="absolute right-full top-0 z-40 mr-2 w-[min(420px,calc(100vw-120px))] overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-medium text-foreground">自定义快捷入口</span>
            <span className="text-[11px] text-muted-foreground">已选 {pinned.length} 项 · 勾选即保存</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  // V56：「恢复默认」= 交回默认口径（清掉标记），而不是把当前默认**拷贝**一份
                  // 存下来 —— 后者会让下一次口径升级又对这位用户失效。
                  void updateSettings({
                    quickActionIds: [...DEFAULT_QUICK_ACTION_IDS],
                    quickActionsCustomized: false,
                  })
                    .then(() => toast.success('已恢复默认快捷入口'))
                    .catch(() => undefined);
                }}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" />
                恢复默认
              </button>
              <button
                type="button"
                onClick={() => setCustomizing(false)}
                className="rounded-md bg-brand px-2 py-0.5 text-[11px] text-white transition hover:opacity-90"
              >
                完成
              </button>
            </div>
          </div>
          <div className="scrollbar-thin max-h-[440px] space-y-3 overflow-y-auto p-3">
            {grouped.map(([groupName, list]) => (
              <div key={groupName}>
                <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{groupName}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {list.map((action) => {
                    const on = selectedIds.includes(action.id);
                    const Icon = ACTION_ICONS[action.id] ?? Wrench;
                    return (
                      <button
                        key={action.id}
                        type="button"
                        onClick={() => toggle(action.id)}
                        title={action.description}
                        className={cn(
                          'flex min-w-0 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left transition',
                          on
                            ? 'border-brand/50 bg-brand-muted/60'
                            : 'border-border hover:border-brand/30 hover:bg-accent/50',
                        )}
                      >
                        <span
                          className={cn(
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition',
                            on ? 'border-brand bg-brand text-white' : 'border-muted-foreground/40',
                          )}
                        >
                          {on ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                          {action.name}
                        </span>
                        {action.elevated ? (
                          <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] text-amber-800">
                            管理员
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 悬停气泡：Portal 到 body，不受栏的 overflow 裁剪 */}
      <TipPortal tip={tip} />
    </aside>
  );
}

export default QuickActionsRail;
