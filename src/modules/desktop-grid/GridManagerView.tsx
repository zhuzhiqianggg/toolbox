import React, { useCallback, useEffect, useState } from 'react';
import {
  CalendarDays,
  Eye,
  EyeOff,
  History,
  Info,
  LayoutGrid,
  Loader2,
  MousePointerClick,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  StickyNote,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { reportOperation } from '@/lib/errorSink';
import { confirmAction } from '@/lib/confirmAction';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import { cn } from '@/lib/utils';
import { ACCENT_ORDER } from './DesktopWidgets';
import { LegacyRepairCard } from './LegacyRepairCard';
import type { GridAccent, GridBox, LayoutSnapshotMeta } from '@/types/grid';

/**
 * 桌面格子（原「桌面整理」内页）。
 *
 * # 它到底是什么（V37 定案：只呈现，不动文件）
 *
 * 走过一段弯路，把三个模型都记下来，免得又绕回去：
 *
 *   ① V25–V32「引用型」：格子里只登记桌面文件的路径，文件不动。用户看到桌面一份、
 *      格子里一份，观感像「复制了一份而已」。
 *   ② V33–V36「真实收纳型」：把文件 `fs::rename` 进 `桌面/Handy整理/<格名>/`。
 *      桌面确实不重复了，但用户装机实测后否掉 ——「是桌面整理，不是让你把桌面上的
 *      东西都给我移动到一个目录下面去」。而且它埋了一次事故：收纳容器被自己的规则
 *      误扫，递归复制炸出 704 层嵌套、5 份共约 195 GB 的副本。
 *   ③ **V37 起「呈现层」**（当前）：格子 = 桌面图标的归拢显示。条目只是引用，
 *      拖进 / 移出 / 换格子一律**只改登记**，文件永远待在桌面原处。腾讯桌面整理
 *      就是这个行为。
 *
 * 代价是「桌面原生图标 + 格子」会重复显示，所以接管桌面图标（隐藏原生
 * `SysListView32`）是这个模型的一部分，而不是可选项。
 *
 * # 本视图保留的能力
 *
 *   - **一键整理桌面**：扫描 → 按类型分组 → 只登记引用，不动文件（V66 起按内容重排尺寸）；
 *   - **格子 / 挂件**：收纳格、便签、日历计划三种，日历复用 `todos` 表；
 *   - **诊断与修复**：撤回 / 清理 V33–V36 留下的 `Handy整理` 残留、查看日志；
 *   - **备份 / 还原布局**：把当前摆法存成本机快照，随时切回来；
 *   - **格子重命名 / 删除**、**显示 / 隐藏格子层**（浮在桌面之上、普通窗口之下）。
 */
export interface GridManagerViewProps {
  /**
   * 嵌入控制台时用紧凑工具条替代自带头部。
   *
   * 控制台已经有模块标题（`ModuleView` 的 header）与页签栏，这里再来一个
   * 「桌面整理」大标题就是同一件事的两种排版（V23 删「字段拆解」时定下的判据）。
   */
  embedded?: boolean;
}

export function GridManagerView({ embedded = false }: GridManagerViewProps = {}): React.JSX.Element {
  const [boxes, setBoxes] = useState<GridBox[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [arranging, setArranging] = useState(false);

  /** 布局快照列表 + 是否展开该面板 */
  const [snapshots, setSnapshots] = useState<LayoutSnapshotMeta[]>([]);
  const [showSnapshots, setShowSnapshots] = useState(false);

  /** 行内重命名：正在编辑的格子 id + 草稿 */
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** 挂件前端最近一次故障（白屏/JS 崩溃取证；无记录为 null） */
  const [fault, setFault] = useState<string | null>(null);
  /** V42：语义说明卡默认折叠成一行，需要时再展开（减少首屏信息过载） */
  const [guideOpen, setGuideOpen] = useState(false);
  /**
   * 桌面空白处右键的「打开 Handy 桌面整理」入口是否已装（V45）。
   *
   * 借鉴腾讯桌面整理：桌面右键是用户在桌面上最自然的第一反射，比让用户去托盘里翻
   * 菜单顺手得多。`null` = 还没问出来（浏览器预览 / IPC 失败），此时开关置灰。
   */
  const [desktopMenu, setDesktopMenu] = useState<boolean | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setBoxes(await ipc.gridBoxList());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSnapshots = useCallback(async (): Promise<void> => {
    try {
      setSnapshots(await ipc.gridLayoutList());
    } catch {
      // 快照列表只作辅助展示，读失败不打断主流程
      setSnapshots([]);
    }
  }, []);

  /**
   * 同步挂件层的**真实状态**。
   *
   * V33 修的关键 bug：以前 `overlayVisible` 只是本组件的局部 state（初值 false），
   * 从不与服务端对齐 —— 于是「一键收纳 / 新建格子」会顺手把格子层弹出来（用户没点
   * 显示，格子却自己冒出来 = 「莫名其妙又出来了」），而按钮文案又和真实状态相反
   * （点「隐藏格子」实际在重复显示）。现在以窗口本身为唯一真相来源。
   */
  const syncOverlayStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await ipc.gridOverlayStatus();
      // ⚠️ V44.3：挂件窗始终显示（工具栏常驻），用 `engaged` 表示「格子内容是否接管」，
      // 不能用 `visible`（窗口永远可见，会让「显示/隐藏格子」开关永远停在「隐藏」）。
      setOverlayVisible(status.engaged);
    } catch {
      // 查询失败保持上次状态，不误报
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshSnapshots();
    void syncOverlayStatus();
    void ipc
      .desktopMenuStatus()
      .then(setDesktopMenu)
      .catch(() => setDesktopMenu(null));
    void ipc
      .gridOverlayFaultGet()
      .then(setFault)
      .catch(() => undefined);
    // 状态轮询：格子层可能被挂件自身（收起按钮 / 托盘 / 崩溃自愈）改变，
    // 这里对齐开关，保证按钮文案永远与实际状态一致
    const timer = window.setInterval(() => void syncOverlayStatus(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh, refreshSnapshots, syncOverlayStatus]);

  const toggleOverlay = useCallback((): void => {
    setBusy(true);
    const next = !overlayVisible;
    const action = next ? ipc.gridOverlayShow() : ipc.gridOverlayHide();
    void action
      .then(() => syncOverlayStatus())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  }, [overlayVisible, syncOverlayStatus]);

  /**
   * 装 / 卸桌面空白处右键的「打开 Handy 桌面整理」入口（V45）。
   *
   * 写的是 `HKCU\Software\Classes\DesktopBackground\Shell`，**不需要管理员权限**；
   * 卸载整键删除，不留残留。装好之后：Handy 没在跑 → 冷启动并直接把整理层显示出来；
   * 正在跑 → 把整理层叫回来（而不是弹主窗口）。
   */
  const toggleDesktopMenu = useCallback((): void => {
    const next = desktopMenu !== true;
    setBusy(true);
    const action = next ? ipc.desktopMenuInstall() : ipc.desktopMenuRemove();
    void action
      .then(() => {
        setDesktopMenu(next);
        toast.success(next ? '已加入桌面右键菜单' : '已从桌面右键菜单移除', {
          description: next
            ? '在桌面空白处点右键，即可看到「打开 Handy 桌面整理」'
            : '右键菜单已恢复原样',
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        toast.error('桌面右键菜单设置失败', { description: message });
      })
      .finally(() => setBusy(false));
  }, [desktopMenu]);

  const addBox = useCallback((): void => {
    setBusy(true);
    void ipc
      // 不指定落点 → 由 Rust 按「左起自动流」算（与一键收纳共用同一套排布），
      // 多个新格子依次往左推进，不会叠在同一处
      .gridBoxUpsert({
        name: `新格子 ${boxes.length + 1}`,
        kind: 'folder',
        width: 320,
        height: 244,
      })
      .then(async () => {
        await refresh();
        toast.success('已新建收纳格', {
          description: overlayVisible ? undefined : '格子层当前是收起的，点「显示格子」即可看到',
        });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  }, [refresh, boxes.length, overlayVisible]);

  /**
   * 新建挂件（便签 / 日历 + 今日计划）。
   *
   * V34 曾按用户要求把同类挂件限成一个；**V35 用户改口**：「便签应该可以添加多个」。
   * 于是拆成两条规则（与桌面上浮动工具栏的 `addWidget` 保持一致）：
   *   - **便签可以多个**：按 便签 / 便签 2 / 便签 3… 自动起名，并轮流给一个不同配色
   *     （多个便签长得一模一样，桌面上根本分不清）——桌面上点标题栏调色盘随时可改；
   *   - **日历仍然只有一个**：日历背后是同一份 `todos`，多开只是重复信息。
   */
  const addWidget = useCallback(
    (kind: 'note' | 'calendar'): void => {
      if (kind === 'calendar') {
        const existing = boxes.find((box) => box.kind === 'calendar');
        if (existing) {
          toast.info('日历挂件已经有一个了', {
            description: `直接在桌面上用「${existing.name}」就行；想重来可以先删掉它`,
          });
          return;
        }
      }
      setBusy(true);
      const sameKind = boxes.filter((box) => box.kind === kind).length;
      const preset =
        kind === 'note'
          ? {
              // 第 1 个叫「便签」，之后顺延编号 —— 名字是给人看的，不该出现「便签 1」
              name: sameKind === 0 ? '便签' : `便签 ${sameKind + 1}`,
              width: 260,
              height: 220,
              // 轮着给配色，尽量让相邻两个便签颜色不同
              accent: ACCENT_ORDER[(sameKind % (ACCENT_ORDER.length - 1)) + 1] ?? 'amber',
            }
          : { name: '日历 · 今日计划', width: 320, height: 470, accent: '' as GridAccent };
      void ipc
        .gridBoxUpsert({
          name: preset.name,
          kind,
          accent: kind === 'note' ? (preset.accent as GridAccent) : null,
          // V50：**不指定落点**。以前这里写死 `40 + (n%3)*344` 是想在预览画布上把新格子
          // 岔开摆，但 `grid_box_upsert` 建完就会跑一次排布引擎、把它覆盖掉 —— 写死的坐标
          // 从来就没生效过，只会让人误以为「位置是这里定的」。现在统一由布局引擎安置
          // （便签进便签列、日历进日历列，见 grid.rs 的 place_widget_columns）。
          width: preset.width,
          height: preset.height,
        })
        .then(async () => {
          // V47：新建后立刻重排（只归位、不扫描）。
          //
          // 用户原话：「添加便签后这个位置放在这里也不合适，便签的位置需要自动放在
          // 合理的位置上」。此前这里硬算了一个 `40 + n*344` 的"网格位"，那两个数
          // 跟实际列宽 / 左侧禁区宽度毫无关系 —— 新建的便签会压在「不整理」竖条上。
          // 交给布局流水线归位，才能保证「列对齐 + 挂件区整列保留」那套不变量成立。
          try {
            await ipc.gridRelayout();
          } catch {
            // 归位失败不影响已建好的挂件；下次「一键整理」会纠正。
          }
          await refresh();
          toast.success(kind === 'note' ? `已新建${preset.name}` : '已新建日历挂件', {
            description: overlayVisible
              ? kind === 'note'
                ? '支持 Markdown 边写边渲染；多个便签可用标题栏调色盘换色区分'
                : undefined
              : '格子层当前是收起的，点「显示格子」即可看到',
          });
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusy(false));
    },
    [refresh, boxes, overlayVisible],
  );

  /**
   * **重新重置整理**（V48 新增）：按 Handy 自己的分区规则把整张桌面重排一遍。
   *
   * 与「一键整理桌面」的区别就是**口径**（用户原话：「如果用户自己调整了那么记录用户
   * 自己的改变，除非后面用户重新重置整理，我们又按照我们自己的规律整理」）：
   *   · 一键整理 = 增量补齐：你摆好的格子一律不动，只把散落内容归纳进格子；
   *   · 重置整理 = 全量重排：所有格子回到「便签一列 / 日志一大列 / 收纳两列」的自动布局。
   */
  const resetArrangement = useCallback(async (): Promise<void> => {
    const ok = await confirmAction(
      '重新重置整理？\n\n' +
        '会把桌面上所有格子（含你手动挪过、拉过大小的）**重新排一遍**：\n\n' +
        '· 便签单独一列 · 日历/工作台日志一大列 · 收纳格两列；\n' +
        '· 格子高度按图标数量自动计算，装不下的部分用格子内的滚动条；\n' +
        '· 同样**一个文件都不会移动**。\n\n' +
        '你之前手动调整过的位置会被这次重置覆盖。确定继续？',
    );
    if (!ok) {
      return;
    }
    setArranging(true);
    void ipc
      .gridLayoutReset()
      .then(async () => {
        await refresh();
        toast.success('已按分区规则重置整理', {
          description: '便签一列 · 日志一大列 · 收纳两列；文件一个都没动',
        });
      })
      .catch((error: Error) => toast.error(error.message))
      .finally(() => setArranging(false));
  }, [refresh]);

  /**
   * 一键整理：扫描桌面 → 按类型把文件与文件夹**登记**进对应格子。
   *
   * **一个文件都不会被移动**（V37 引用模型）：登记只让格子知道该把谁画进去，
   * 文件本体留在桌面原处。所以确认框里要把这件事说死，免得再被误会成
   * 「把桌面上的东西搬进某个目录」（V33–V36 就是这么被否掉的）。
   * 只有快捷方式（.lnk）不参与（用户明确要求「原生快捷方式不需要动态整理」）。
   */
  const autoArrange = useCallback(async (): Promise<void> => {
    const ok = await confirmAction(
      '一键整理桌面？\n\n' +
        '会把桌面上的文件和文件夹按类型登记进对应格子（每个类别一个格子）。\n\n' +
        '· 文件不会被移动，一个都不会 —— 格子只是把它们归拢显示；\n' +
        '· 快捷方式（.lnk）整体登记进「快捷方式」格，同样不移动；\n' +
        '· 文件夹整体登记进「文件夹」格；\n' +
        '· 从格子里移出过的条目不会再被塞回来；\n' +
        '· 整理后桌面图标交由格子接管（原生图标收起，桌面上不再有重复的一份），\n' +
        '  收起挂件或点浮层工具栏的图标开关可随时恢复。\n\n' +
        '确定继续？',
    );
    if (!ok) {
      return;
    }
    setArranging(true);
    void ipc
      .gridAutoArrange()
      .then(async (report) => {
        await refresh();
        await syncOverlayStatus();
        if (report.scanned === 0) {
          toast.warning('桌面已经很干净了', { description: '没有扫描到可整理的条目' });
          return;
        }
        // V43：把「放开了几个此前被移出的路径」如实说出来。
        // 这条名单以前只增不减，用户手动挪出去过的目录/文件会**永远**不再被整理，
        // 表现就是「我重新整理了为什么还是没有重新整理」——现在每次整理都会放开它。
        const released = report.released > 0 ? `放开此前移出的 ${report.released} 个 · ` : '';
        const loose =
          report.leftOver > 0 ? `；${report.leftOver} 项（快捷方式 / 系统图标）留在左侧竖条` : '';
        if (report.itemsAdded === 0) {
          toast.info(
            report.released > 0 ? '已重新整理（没有新增需要归类的条目）' : '没有需要归类的条目',
            {
              description: `扫描到 ${report.scanned} 项（含公共桌面）；${released}格子布局已按内容重排${loose}`,
            },
          );
          return;
        }
        const created = report.boxesCreated > 0 ? `新建 ${report.boxesCreated} 个格子、` : '';
        const folders = report.foldersMoved > 0 ? `（含 ${report.foldersMoved} 个文件夹）` : '';
        // V39：整理顺手做完的三件事都报出来 —— 按内容调尺寸 / 挂件归位 / 全量重排
        const tidied = [
          report.boxesLaidOut > 0 ? `重排 ${report.boxesLaidOut} 格` : '',
          report.boxesResized > 0 ? `按内容调尺寸 ${report.boxesResized} 格` : '',
          report.widgetsAnchored > 0 ? `挂件归位 ${report.widgetsAnchored} 个` : '',
        ]
          .filter(Boolean)
          .join('、');
        toast.success(`已整理 ${report.itemsAdded} 个条目${folders}`, {
          description: `${created}${released}文件全部留在桌面原位，没有移动${
            tidied ? `；${tidied}` : ''
          }${loose}`,
        });
        if (report.boxesOverflowed > 0) {
          toast.warning(`桌面空间不够，${report.boxesOverflowed} 个格子没能排开`, {
            description: '建议减少格子数量，或在系统设置里把桌面图标调小一些再整理',
          });
        }
        if (report.failures.length > 0) {
          toast.warning(`${report.failures.length} 个文件没能整理`, {
            description: report.failures.slice(0, 3).join('；'),
          });
        }
      })
      .catch((err: unknown) => {
        reportOperation('一键整理桌面', err);
        toast.error('一键整理失败', {
          description: `${err instanceof Error ? err.message : String(err)}（详情见日志）`,
        });
      })
      .finally(() => setArranging(false));
  }, [refresh, syncOverlayStatus]);

  const saveLayout = useCallback((): void => {
    setBusy(true);
    void ipc
      .gridLayoutSave()
      .then(async (meta) => {
        await refreshSnapshots();
        setShowSnapshots(true);
        toast.success(`已备份布局：${meta.name}`, {
          description: `${meta.boxCount} 个格子 · ${meta.itemCount} 个图标`,
        });
      })
      .catch((err: unknown) => {
        toast.error('备份布局失败', {
          description: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setBusy(false));
  }, [refreshSnapshots]);

  const restoreLayout = useCallback(
    async (snapshot: LayoutSnapshotMeta): Promise<void> => {
      const ok = await confirmAction(
        `还原布局「${snapshot.name}」？\n\n` +
          `当前布局会先自动备份为「还原前自动备份」，因此随时可以再换回来。\n` +
          `文件本体不会被移动或删除。`,
      );
      if (!ok) {
        return;
      }
      setBusy(true);
      void ipc
        .gridLayoutRestore(snapshot.id)
        .then(async (report) => {
          await refresh();
          await refreshSnapshots();
          const extra =
            report.missingFiles > 0 ? `（其中 ${report.missingFiles} 个文件已不在原位置）` : '';
          toast.success(`已还原：${report.boxes} 个格子 · ${report.items} 个图标${extra}`);
        })
        .catch((err: unknown) => {
          toast.error('还原布局失败', {
            description: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => setBusy(false));
    },
    [refresh, refreshSnapshots],
  );

  const deleteSnapshot = useCallback(
    async (snapshot: LayoutSnapshotMeta): Promise<void> => {
      if (!(await confirmAction(`删除备份「${snapshot.name}」？此操作不可撤销。`))) {
        return;
      }
      void ipc
        .gridLayoutDelete(snapshot.id)
        .then(() => refreshSnapshots())
        .catch((err: unknown) => {
          toast.error('删除备份失败', {
            description: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [refreshSnapshots],
  );

  const deleteBox = useCallback(
    async (box: GridBox): Promise<void> => {
      const message = `删除格子「${box.name}」？\n\n将同时移除其中 ${box.itemCount} 个图标引用（不影响任何文件本体）。`;
      if (!(await confirmAction(message))) {
        return;
      }
      setBusy(true);
      void ipc
        .gridBoxDelete(box.id)
        .then(() => refresh())
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setBusy(false));
    },
    [refresh],
  );

  const commitRename = useCallback(
    (box: GridBox): void => {
      const name = renameDraft.trim();
      setRenamingId(null);
      if (name === '' || name === box.name) {
        return;
      }
      void ipc
        .gridBoxUpsert({ boxId: box.id, name })
        .then(() => refresh())
        .catch((err: unknown) => {
          toast.error('重命名失败', {
            description: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [refresh, renameDraft],
  );

  const totalItems = boxes.reduce((sum, box) => sum + box.itemCount, 0);

  /** 工具条按钮（自带头部与嵌入模式共用，避免两处抄一遍） */
  const toolbarActions = (
    <>
      <Button variant="outline" size="sm" onClick={refresh} disabled={loading} title="重新读取格子列表">
        <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        刷新
      </Button>
      <Button variant="outline" size="sm" onClick={addBox} disabled={busy} title="新建一个收纳格">
        <Plus className="h-3.5 w-3.5" />
        新建格子
      </Button>
      <Button variant="secondary" size="sm" onClick={() => addWidget('note')} disabled={busy} title="加一个便签挂件（可多个）">
        <StickyNote className="h-3.5 w-3.5" />
        便签挂件
      </Button>
      <Button variant="secondary" size="sm" onClick={() => addWidget('calendar')} disabled={busy} title="加日历挂件（只有一个）">
        <CalendarDays className="h-3.5 w-3.5" />
        日历挂件
      </Button>
      <Button variant="secondary" size="sm" onClick={toggleOverlay} disabled={busy} title={overlayVisible ? '收起桌面上的格子层' : '把格子层显示到桌面上'}>
        {overlayVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        {overlayVisible ? '隐藏格子' : '显示格子'}
      </Button>
      <Button size="sm" onClick={autoArrange} disabled={arranging} title="扫描桌面并按类型登记进格子（一个文件都不移动；你摆好的格子不会被挪动）">
        {arranging ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        一键整理桌面
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={resetArrangement}
        disabled={arranging}
        title="按「便签一列 / 日志一大列 / 收纳两列」重排整张桌面（会覆盖你手动调整过的位置）"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        重置整理
      </Button>
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {embedded ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            格子是桌面的
            <span className="font-medium text-foreground">呈现层</span>
            ：拖进去只登记归属，文件原地不动；双击打开的还是原文件
          </span>
          <div className="ml-auto flex items-center gap-2">{toolbarActions}</div>
        </div>
      ) : (
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <LayoutGrid className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-foreground">桌面格子</h1>
            <p className="truncate text-xs text-muted-foreground">
              桌面图标归拢显示 · 文件一律原地不动 · 快捷方式留在原位
            </p>
          </div>
          {toolbarActions}
        </header>
      )}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {/* 语义说明卡（V42：默认折叠成一行,锚点词保留） */}
        <div className="mb-5 overflow-hidden rounded-xl border border-border bg-muted/40">
          <button
            type="button"
            onClick={() => setGuideOpen((prev) => !prev)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-muted/20"
            aria-expanded={guideOpen}
          >
            <Info className="h-4 w-4 shrink-0 text-brand" />
            <span className="min-w-0 flex-1 truncate text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">格子是桌面的呈现层</span>
              ：拖进 / 移出 / 换格子都只改登记，文件<span className="font-medium text-foreground">原地不动</span>；
              一键整理按类型登记，快捷方式留在原位
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {guideOpen ? '收起' : '展开'}
            </span>
          </button>
          {guideOpen && (
            <div className="space-y-1 border-t border-border/60 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">格子只做呈现，不动你的文件</span>
                ：拖进格子、拖去别的格子、点 × 移出 —— 都只是改格子的登记，文件一直待在
                桌面原处（腾讯桌面整理就是这个行为）。双击打开的还是原文件。
              </p>
              <p>
                <span className="font-medium text-foreground">一键整理</span>
                ：扫一遍桌面，把文件和文件夹按类型登记进对应的格子。快捷方式（.lnk）
                按你的要求留在原位，一个文件都不会被移动。从格子里移出过的东西不会再被
                自动归类塞回来。
              </p>
              <p>
                格子条目：双击打开、拖到其他格子、右上角 × 从格子移出（文件不动）。
                标题栏随时可拖动移位、双击重命名。
                「备份布局」记下当前摆法，随时能「还原」回来。
              </p>
              <p className="text-foreground">
                桌面挂件：便签支持 Markdown 边写边渲染（自动保存）、日历挂件带农历 · 节气 ·
                节假日与每日计划（与工作台共用同一份待办数据，桌面勾完工作台同步）。
              </p>
              {fault && (
                <p className="rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-600 dark:text-red-400">
                  挂件最近一次故障（已自动恢复过）：{fault}
                </p>
              )}
            </div>
          )}
        </div>

        {/* 诊断与修复（V37）：历史收纳残留撤回/清理 + 日志入口 */}
        <LegacyRepairCard />

        {/* 桌面入口（V45）：借鉴腾讯桌面整理 —— 在「桌面空白处右键」里加一项入口。
            为什么值得做：桌面右键是用户在桌面上最自然的第一反射，比去托盘里翻菜单顺手。 */}
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-border px-4 py-3">
          <MousePointerClick className="h-4 w-4 shrink-0 text-brand" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">桌面右键菜单入口</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              在桌面空白处右键加一项「打开 Handy 桌面整理」（借鉴腾讯桌面整理的做法）。
              写 `HKCU` 注册表，不需要管理员权限；关掉时整键删除，不留残留。
              装好之后，无论 Handy 是否在运行，点它都能把桌面整理叫回来。
            </p>
          </div>
          <Button
            variant={desktopMenu === true ? 'outline' : 'secondary'}
            size="sm"
            onClick={toggleDesktopMenu}
            disabled={busy || desktopMenu === null || !isTauri()}
            title={
              desktopMenu === null
                ? '当前环境读不到注册表状态（浏览器预览不支持）'
                : desktopMenu
                  ? '从桌面右键菜单里移除这一项'
                  : '加入桌面右键菜单'
            }
          >
            {desktopMenu === true ? '已开启 · 点此关闭' : '开启'}
          </Button>
        </div>

        {/* 布局备份区 */}
        <div className="mb-5 rounded-xl border border-border">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-foreground">布局备份</span>
            <span className="text-xs text-muted-foreground">
              {snapshots.length > 0 ? `共 ${snapshots.length} 份` : '还没有备份'}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={saveLayout} disabled={busy}>
                备份当前布局
              </Button>
              <button
                type="button"
                onClick={() => setShowSnapshots((prev) => !prev)}
                className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
              >
                {showSnapshots ? '收起' : '展开'}
              </button>
            </div>
          </div>

          {showSnapshots ? (
            snapshots.length === 0 ? (
              <p className="border-t border-border px-4 py-4 text-xs text-muted-foreground">
                点「备份当前布局」把现在这套摆法存下来；以后调整乱了可以一键还原。
              </p>
            ) : (
              <ul className="divide-y divide-border border-t border-border">
                {snapshots.map((snapshot) => (
                  <li
                    key={snapshot.id}
                    className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs"
                  >
                    <span className="font-medium text-foreground">{snapshot.name}</span>
                    <span className="text-muted-foreground">
                      {snapshot.boxCount} 格 · {snapshot.itemCount} 项
                    </span>
                    <span className="tabular-nums text-muted-foreground/70">{snapshot.savedAt}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => restoreLayout(snapshot)}
                        disabled={busy}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        还原
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => deleteSnapshot(snapshot)}
                        disabled={busy}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>

        {error !== null ? (
          isTauri() ? (
            <p className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : (
            <p className="mb-4 flex items-center gap-2 rounded-lg border border-brand/15 bg-brand-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0 text-brand" />
              浏览器预览模式：桌面格子功能需要在 Handy 桌面版中运行。
            </p>
          )
        ) : null}

        {/* 格子列表 */}
        {loading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">加载中…</p>
        ) : boxes.length === 0 ? (
          <div className="py-14 text-center">
            <p className="text-sm font-medium text-foreground">还没有格子</p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                点「一键整理桌面」扫一遍桌面，按类型登记进各自的格子（快捷方式留在原位，
                文件一个都不会被移动）；也可以点「新建格子」自己摆，或加便签 / 日历挂件
                （便签可以加多个）。显示格子后把文件拖进格子即可。
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button size="sm" onClick={autoArrange} disabled={arranging}>
                  <Sparkles className="h-3.5 w-3.5" />
                  一键整理桌面
                </Button>
              <Button variant="outline" size="sm" onClick={addBox} disabled={busy}>
                <Plus className="h-3.5 w-3.5" />
                手动新建格子
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              共 {boxes.length} 个格子 · {totalItems} 个条目
            </p>
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">格子</th>
                    <th className="px-4 py-2.5 font-medium">内容</th>
                    <th className="px-4 py-2.5 font-medium">位置 / 尺寸</th>
                    <th className="px-4 py-2.5 font-medium">更新时间</th>
                    <th className="px-4 py-2.5 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {boxes.map((box) => (
                    <tr key={box.id} className="border-b border-border/60 last:border-b-0">
                      <td className="px-4 py-2.5">
                        {renamingId === box.id ? (
                          <input
                            // 自动聚焦：进入重命名即可直接打字
                            autoFocus
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onBlur={() => commitRename(box)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                commitRename(box);
                              }
                              if (event.key === 'Escape') {
                                setRenamingId(null);
                              }
                            }}
                            className="h-7 w-full rounded-md border border-brand/50 bg-background px-2 text-sm outline-none"
                            aria-label="格子名称"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setRenamingId(box.id);
                              setRenameDraft(box.name);
                            }}
                            className="rounded px-1 py-0.5 font-medium text-foreground transition hover:bg-accent"
                            title="点击重命名"
                          >
                            {box.name}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {box.kind === 'note'
                          ? '便签挂件'
                          : box.kind === 'calendar'
                            ? '日历挂件'
                            : `${box.itemCount} 个文件`}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        ({box.posX}, {box.posY}) · {box.width}×{box.height}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{box.updatedAt}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            setRenamingId(box.id);
                            setRenameDraft(box.name);
                          }}
                          disabled={busy}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          重命名
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => deleteBox(box)}
                          disabled={busy}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 供模块注册表 `loadView` 动态导入（与其它模块视图的 default 导出约定一致） */
export default GridManagerView;
