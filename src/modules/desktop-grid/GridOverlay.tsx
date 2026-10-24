import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  File,
  FolderClosed,
  LayoutGrid,
  Link2,
  List,
  Lock,
  LockOpen,
  Monitor,
  Palette,
  Plus,
  StickyNote,
  Trash2,
  Wrench,
} from 'lucide-react';
import { registry } from '@/core/moduleRegistry';
import {
  detectQuickLinkType,
  loadQuickLinks,
  newQuickLinkId,
  saveQuickLinks,
  type QuickLink,
} from '@/modules/workstation/quicklinks';
// 系统快捷入口（管理员终端 / 编辑 hosts / 任务管理器…）——与工作台共用同一份图标表，
// 见 `ACTION_ICONS` 的注释：用户抱怨「那些快捷入口都没有了呢」。
import { ACTION_ICONS } from '@/modules/workstation/QuickActionsRail';
import { useAppStore } from '@/stores/useAppStore';
import type { SysAction } from '@/types/sys';
import { ipc } from '@/lib/ipc';
import { reportOperation } from '@/lib/errorSink';
import { isTauri } from '@/platform/detect';
import { cn } from '@/lib/utils';
import type {
  GridAccent,
  GridBox,
  GridItem,
  GridRegion,
  LooseArea,
  LooseEntry,
  TakeoverState,
} from '@/types/grid';
import {
  ACCENT_ORDER,
  CALENDAR_THEMES,
  CalendarWidget,
  noteAccent,
  NOTE_ACCENTS,
  NoteWidget,
} from './DesktopWidgets';
import {
  DesktopSidePanel,
  sidePanelShell,
  type PanelEntry,
  type SidePanelTab,
} from './DesktopSidePanel';
// 工作台（V60）：日历 + 快捷入口 + 操作按钮整合成的常驻浮窗，固定在右侧。
// 它独立于盒子系统，所以「退出整理」只收盒子与竖条，工作台仍在。
import { DesktopWorkstation, WorkstationSectionLabel, WORKSTATION_W } from './DesktopWorkstation';

/**
 * 桌面网格挂件 · 透明覆盖窗（`grid-overlay`）。
 *
 * 窗口形态：Rust 侧无边框透明窗（见 `commands/grid.rs`），占满主显示器工作区；
 * 本组件承担：
 *   - **盒子画布**：绝对定位的盒子（标题栏 + 条目网格），编辑模式可拖拽移动
 *     （标题栏）、右下角拖拽缩放、双击标题重命名；落库经 `gridBoxUpsert`；
 *   - **文件拖放**：`getCurrentWebview().onDragDropEvent`，drop 落点命中哪个盒子
 *     就把拖入的文件**登记**给该盒子（`gridItemAdd` → 只写 `grid_items` 一行）。
 *     ⚠️ **磁盘上什么都不发生**（V37 呈现层）：V33–V36 这里走的是 `fs::rename` 真搬文件，
 *     被用户否掉后已改回引用模型。拖到别的盒子 = 改一下登记归属而已；
 *   - **点击穿透协同**：透明区域默认穿透（Rust 侧 `set_ignore_cursor_events`），
 *     本组件把盒子 / 工具栏矩形按 `scaleFactor` 换算为物理像素上报
 *     （`gridOverlayUpdateRegions`），Rust 光标轮询命中后才开放交互；拖拽期间
 *     经 `gridSetInteractive(true)` 显式申请保持可交互，避免拖快了被切回穿透；
 *   - **窗口几何**：**不在前端管**（V83）。以前这里做「moved / resized 停稳 500ms
 *     → 写库」的持久化，接双屏后会用过期 `scaleFactor` 写进错值并永久锁死窗口尺寸。
 *     现在几何由 Rust 实时决定（= 当前主显示器工作区），前端只监听
 *     `grid:bounds-changed` 后重排。详见下方同名的注释块；
 *   - **右侧常驻「工作台」**（V60，见下方 §V60）：日历 + 快捷入口 + 操作按钮（便签 /
 *     格子 / 整理 / 退出整理）合成的**一个整体模块**，组件见 `DesktopWorkstation`。
 *     V44.3 那颗「浮动工具栏」的职能（整理桌面、隐藏挂件）现已并入它。
 *
 * 交互约定（V41）：格子右键菜单**只挂在标题栏上**（图标 / 条目上的右键还给条目自己的
 * 菜单：打开 / 打开文件位置 / 移出格子）；条目**拖出格子**即移入左侧「未归类」竖条
 * （不再用悬停 × —— 用户原话「感觉 x 了关闭了什么东西一样」）。
 *
 * # V42 三件新东西（对应「功能全下沉到桌面」）
 *
 * 1. **左侧「未归类」竖条**（不是格子）：系统入口 + 快捷方式 + 落单条目按类型顺序
 *    自上而下排开，纯图标、无卡片外框 —— 用户原话「不整理的和快捷方式别整理到格子了，
 *    他们就是自动在桌面左上角从上往下排开即可，不需要放到格子里面，没有必要」。
 *    分类格改从**右侧**起流布（Rust `FlowPlacer` 的镜像模式），两边互不打扰。
 * 2. **桌面快捷条 Dock**（底部居中）→ **V56 改成右下角格子样式的固定小块** →
 *    **V60 并入工作台**（用户：「把快捷入口这些都可以整合到工作台里面」）。
 *    它与工作台共用同一份快捷入口数据（`quicklinks.ts`，localStorage 同源），
 *    把桌面图标 / 格子条目拖上去即可加进去、点一下就打开 ——
 *    用户 V42 原话「工作台里面的快捷方式可以放在桌面上的例如 mac 电脑的快捷条一样
 *    方便快速打开……把桌面图标拖进来归纳到里面」。
 *    ⚠️ **本文件里 `dock*` 那一批命名（`dockRef`/`dockLinks`/`hitDock`/`menuDock`…）
 *    现在指的就是「工作台里的快捷入口那一段」**，不是底部工具栏 —— 别再被名字误导。
 * 3. **桌面右侧统一面板**（V45；V42 的中部搜索浮层 + V43 的偏左大抽屉 + V44 的右下快捷
 *    浮层三合一）：顶部搜索框 + 分类列表 + **面板原地打开工具本体**，另一个页签放
 *    应用入口 / 我的快捷方式 / 系统入口。用户 09-19：「工具搜索应该放在右侧，跟工作台
 *    差不多 直接搜索获取，而不是打开额外的对话框 很乱」—— 病根就是同一件事有多个入口。
 *    组件见 `DesktopSidePanel`，工具仍复用各工具自己的组件，不另开窗口。
 * 4. **条目右键 = 系统原生菜单**（V43）：接管桌面后原生图标被隐藏，右键落到了我们窗口上，
 *    所以必须替 Shell 把它的菜单原样弹出来（`ipc.shellContextMenu` → `IContextMenu`），
 *    打开 / 打开方式 / 复制 / 删除 / 重命名 / 属性 + 第三方扩展项全都在。
 *    按住 Shift 才弹我们自己的精简菜单（含 Shell 给不了的「移出格子」）。
 *
 * # V60：工作台（日历 + 快捷入口 + 操作按钮 = 一个整体模块）
 *
 * 用户 09-21（附腾讯桌面整理截图）：「日历可以修改为工作台，把快捷入口这些都可以整合到
 * 工作台里面，整合成一个整体的模块，现在还缺少添加便签的按钮 还有整理 关闭整理等，
 * 工作台这个可以常驻，不跟桌面整理一起退出等」。
 *
 * 三条要点：
 *   1. **日历不再是盒子** —— `kind='calendar'` 的渲染分支已删（存量数据由迁移 v11 清掉，
 *      见 `db/migrations.rs::V11_GRID_DROP_CALENDAR`）。它并进 `DesktopWorkstation` 的
 *      第一段，主题切换仍在这里（要写 localStorage，见 `WST_THEME_KEY`）。
 *   2. **工作台是浮窗，不是格子** —— 「常驻、不跟整理一起退出」与「盒子在 `contentHidden`
 *      时被收起」直接冲突，而浮窗由自己决定显隐，不必给盒子系统开特例。
 *      Rust 侧 `grid.rs::workstation_rect` 把工作区右侧一整列当**禁区**，
 *      宽度 `WORKSTATION_W == WST_BOX_W == 320`（由 `test-desktop-constants.mjs` 锁住）。
 *   3. **操作按钮在工作台底栏**（便签 / 格子 / 整理 / 显示·收起格子），不参与滚动。
 *
 * 另外两条与本文件有关的：
 *   · **桌面背景右键菜单的动作从这里落地** —— Rust 侧入队 `PENDING_ACTION` 并唤醒本窗
 *     （`handy://desktop-action`），本组件在**挂载时**与**收到唤醒时**各取一次队列
 *     （`runDesktopAction` / `takeDesktopAction`）。冷启动时事件必丢，队列才是兜底。
 *   · **层级阶梯**：盒子(auto) < 参考线 35 < 工作台 38 < 面板 40 < 菜单 50 < 拖拽预览 95。
 *
 * # V38 两条硬规矩（都是用户实测反馈推出来的）
 *
 * 1. **格子永不自己消失**。V34 曾让「没有条目的格子」不在桌面占位，理由是「空框挡视线」；
 *    但 v9 迁移把登记清空后，用户桌面上的格子**集体蒸发**，而管理页里它们都还在 ——
 *    用户原话「动不动就不见了，我找不到不见的规律到底是什么」。现在就一句话：
 *    注册了就在，空着也在（空着显示引导文案）。
 * 2. **新建的格子必须立刻能操作**。用户点「+」新建收纳格，落在锁定态里既拖不动也改不了名，
 *    成了「我新加的就是要操作的，你直接锁定了还怎么操作」。现在新建 → 自动解锁并高亮它。
 */

/** 盒子最小尺寸（与 Rust 侧 grid_box_upsert 的下限一致） */
const MIN_BOX_W = 160;
const MIN_BOX_H = 120;
/**
 * 桌面右侧常驻「工作台」的宽度 —— 直接引用组件那一份，避免两处各写一个数。
 *
 * ⚠️ 它同时是 Rust `grid.rs::WST_BOX_W` 的镜像：引擎按那个数把**工作区右侧一整列**
 * 当禁区（见 `workstation_rect`），前端按这个数画浮窗 —— 差一个像素就会变成
 * 「格子压在工作台上」或「白留一条缝」。
 */
const WST_W = WORKSTATION_W;
/**
 * 工作区边距 / 相邻格子间隙 —— **与 Rust `grid.rs` 的同名常量逐字一致**
 * （`ARRANGE_MARGIN = 32` / `ARRANGE_GAP_X = ARRANGE_GAP_Y = 24`）。
 *
 * V63 前端也要用它们了（`contentZoneRight`：收纳区右沿 = 挂件带左沿 − 一道缝），
 * 所以在这里显式镜像一份；改 Rust 那边必须回来同步。
 */
const ARRANGE_MARGIN = 32;
const ARRANGE_GAP_X = 24;
/**
 * 工作台折叠状态（收起成一条标题栏）的本地存储键。
 *
 * V56 时它管的是「右下角快捷入口格子」的收起；V60 快捷入口并进工作台，这个键**沿用**
 * （不换名）—— 换名等于把用户已有的折叠偏好清掉一次，没必要。
 */
const WST_COLLAPSED_KEY = 'handy:grid.dock-collapsed';
/**
 * 工作台里**日历主题**的本地存储键。
 *
 * 主题是「调过一次就一直用」的偏好，必须落盘 —— 纯内存态会让用户重启后以为设置没保存
 * （V59 修 `boxViewModes` 时踩过同一条）。
 */
const WST_THEME_KEY = 'handy:grid.workstation-theme';
/**
 * 各收纳格的**视图模式**（图标网格 / 列表）的本地存储键（V59）。
 *
 * 这个状态从 V51 起就是纯内存的 `useState` —— 于是用户切到列表视图，**重启就悄悄变回网格**，
 * 而格子高度又是按「当前视图」渲染的，看起来就像「设置没保存」。
 * 顺手落到 localStorage（与折叠态同一套做法，不占 `settings.json` 的字段）。
 */
const BOX_VIEW_MODES_KEY = 'handy:grid.box-view-modes';

/**
 * 各收纳格的**排序方式**的本地存储键（V87）。
 *
 * 与视图模式同样的理由：这是「调过一次就一直用」的偏好，纯内存态重启即丢，用户会以为
 * 设置没保存。落 localStorage，不占 `settings.json` 的字段。
 */
const BOX_SORT_MODES_KEY = 'handy:grid.box-sort-modes';

/**
 * 排序方式：`manual` = 登记顺序（用户自己拖出来的先后，默认）；
 * `name` = 按名称；`type` = 按类型（扩展名）再按名称。
 *
 * **暂不提供「按大小 / 按修改日期」**：那两项要读每个文件的元数据，
 * 而 `grid_item_list` 目前只返回路径与显示名 —— 为此给每个条目加一次 `stat`
 * （桌面动辄几十上百个条目）不值当，等真需要时再按同样的键位加。
 */
type BoxSortMode = 'manual' | 'name' | 'type';

const BOX_SORT_MODES: BoxSortMode[] = ['manual', 'name', 'type'];

const BOX_SORT_LABELS: Record<BoxSortMode, string> = {
  manual: '自定义顺序',
  name: '按名称',
  type: '按类型',
};

/**
 * 按排序方式排列条目。**不改后端顺序** —— 只影响这一格怎么画。
 *
 * 这是刻意的：`grid_items.sort` 记的是用户拖出来的先后（「自定义顺序」），
 * 排序只是显示偏好，写回库会把用户辛苦排的顺序冲掉。
 */
function sortBoxItems<T extends { filePath: string; displayName: string }>(
  list: T[],
  mode: BoxSortMode,
): T[] {
  if (mode === 'manual') {
    return list;
  }
  const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const extOf = (name: string): string => {
    const match = /\.([^.]+)$/.exec(name.replace(/\.lnk$/i, ''));
    return match?.[1]?.toLowerCase() ?? '';
  };
  return [...list].sort((a, b) => {
    if (mode === 'type') {
      const byExt = collator.compare(extOf(a.displayName), extOf(b.displayName));
      if (byExt !== 0) {
        return byExt;
      }
    }
    return collator.compare(a.displayName, b.displayName);
  });
}

/**
 * **格子外壳**（非编辑态）—— 收纳格与右下角快捷入口共用同一套观感。
 *
 * 抽成常量是因为「快捷入口就是一个格子」是用户 09-20 的明确要求
 * （「将右下角这个快捷入口改造成格子样式」）：两处的边框 / 阴影 / 磨砂必须**一字不差**，
 * 否则又会退化成「一颗飘在桌角的小面板」。
 * 底色不在这里 —— 它跟着 `accent` 走，由 [`cardBackground`] 给内联渐变。
 */
const BOX_SHELL_CLASS =
  'border border-white/15 bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-[0_20px_60px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.05),inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-2xl backdrop-saturate-[180%]';
/** 提示条显示时长 */
const HINT_DURATION_MS = 2600;
/**
 * 「内容变了 → 重排桌面」的防抖窗口（V66，见 `relayoutSoon`）。
 *
 * 连续拖几个文件、连点几次「+ 格子」时只重排一次；拖拽本身是逐帧的，不防抖会把
 * 布局请求打成一片。120ms 比一次拖放动作的间隔略长，用户感知不到延迟。
 */
const RELAYOUT_DEBOUNCE_MS = 120;
/**
 * 盒子标题栏**实际占掉的高度**（= `h-9` 的 36px **＋ 标题栏那道 `border-b` 的 1px**）。
 * **必须与 JSX 里的标题栏结构和 Rust `grid.rs` 的 `BOX_HEADER_H` 一致**。
 *
 * ⚠️ V56 修过一次：这里当时写 32（对应更早的 `h-8`），标题栏已经改成 `h-9`（36）、Rust 也跟着
 * 改成了 36 —— 前端这一份漏改，于是「按内容自然高度撑开」的挂件盒子永远矮 4px，
 * 底部那 4px 被格子裁掉（便签靠内部滚动掩盖了，日历会白出滚动条）。
 *
 * ⚠️ **V70 又修了一次，这次是 1px**：36 只算了 `h-9`，**漏了标题栏那道 1px 的下边框** ⇒
 * 每个格子都恰好差 1px 装不下 ⇒ 条目网格冒出滚动条 ⇒ 滚动条吃掉 4px 宽 ⇒ 每行少排一列
 * ⇒ 需要的行数变多（正反馈）。真机：`文档`（18 项）引擎按 5 列 × 4 行算，实际渲染成
 * 4 列 × 4 行 = 16 格，藏了 2 个图标。**1px 的账错会被滚动条放大成一整列。**
 */
const BOX_HEADER_H = 37;
/** 盒子边框高度（上 + 下，border-box 下高度含边框） */
const BOX_BORDER_H = 2;

/**
 * 「未归类」竖条单元格的内边距 —— **必须与 Rust `grid.rs` 的 `CELL_EXTRA_W/H` 一致**。
 *
 * 单元格里除了图标，还要放得下 padding、间距和一行 11px 的标签。Rust 用同一组常量
 * 算出竖条整体宽高（`loose_cell_size`），这里若对不上，前端画的图标就会与后端预留的
 * 占位错位 —— 差一列就会盖住旁边的分类格。
 *
 * ⚠️ V56 修：这里写着 36（配 `gap-1`），而 Rust 从 V51 起是 `CELL_EXTRA_W = 32` 配
 * `GRID_GAP = 6`；两处叠加下来，前端每列比后端预留宽 4px、每个行距窄 2px —— 4 列时
 * 竖条实际画出来比预留的宽 10px（吃掉 min_x 里那道 24px 间隙的一部分）。
 * 前端一律向后端看齐（预留区由后端定，前端只能画在预留里）。
 */
const STRIP_CELL_EXTRA_W = 32;
const STRIP_CELL_EXTRA_H = 30;

/**
 * 系统入口的 CLSID → 图标（与 Rust `SYSTEM_ENTRIES` 一一对应）。
 *
 * 历史决定：不用 `FileIcon`，理由是「`SHGetFileInfo` 对 `::{CLSID}` 这类 shell 命名空间
 * 路径不可靠」。
 *
 * ⚠️ **V47 待办（用户已明确提出）**：这个前提**没有被验证过**，而用户明确要求
 * 「我原我的电脑 回收站这几个系统本身的图标怎么变成这样了」——他要的是 Windows 真实图标。
 * `SHGetFileInfoW` 传 `::{CLSID}` 路径 + `SHGFI_SYSICONINDEX` 取系统图像列表，
 * 是 shell 命名空间项**标准**的取图标方式（回收站还能正确反映空/满状态）。
 * 下一步：先用一个独立探针（`ctypes` 或 `zdiag.py` 式脚本）实测这三种 CLSID 的返回，
 * 实测能拿到就删掉本表、让系统入口也走 `FileIcon`；确实不可靠再回来记录判据。
 */
const SYSTEM_ENTRY_ICONS: Readonly<Record<string, typeof Monitor>> = {
  '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}': Monitor,
  '::{645FF040-5081-101B-9F08-00AA002F954E}': Trash2,
  '::{59031A47-3F72-44A7-89C5-5595FE6B30EE}': FolderClosed,
};

/**
 * 缩放手柄方向。
 *
 * V35（用户反馈「右边和下边都可以，现在只有右下角才可以拉」）：补齐**四边 + 四角**
 * 共 8 个手柄。字母含义按罗盘：`n` 上、`s` 下、`w` 左、`e` 右。
 */
type ResizeEdge = 'n' | 's' | 'w' | 'e' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * 8 个缩放手柄的定位与光标（类名写成字面量，Tailwind 才扫得到）。
 *
 * 四边只占一条 6px 命中带，且**两端各留 12px 让给角手柄**（`left-3 right-3` 等），
 * 否则角上会同时命中「边」和「角」两个元素，拉起来方向会跳。
 */
const RESIZE_HANDLES: ReadonlyArray<{ edge: ResizeEdge; className: string; cursor: string }> = [
  { edge: 'n', className: 'left-3 right-3 top-0 h-1.5', cursor: 'cursor-ns-resize' },
  { edge: 's', className: 'bottom-0 left-3 right-3 h-1.5', cursor: 'cursor-ns-resize' },
  { edge: 'w', className: 'bottom-3 left-0 top-3 w-1.5', cursor: 'cursor-ew-resize' },
  { edge: 'e', className: 'bottom-3 right-0 top-3 w-1.5', cursor: 'cursor-ew-resize' },
  { edge: 'nw', className: 'left-0 top-0 h-3 w-3', cursor: 'cursor-nwse-resize' },
  { edge: 'ne', className: 'right-0 top-0 h-3 w-3', cursor: 'cursor-nesw-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 h-3 w-3', cursor: 'cursor-nesw-resize' },
  { edge: 'se', className: 'bottom-0 right-0 h-3 w-3', cursor: 'cursor-nwse-resize' },
];

/** 右键菜单行（V41：格子 / 条目 / 未归类竖条菜单共用同一条样式）——V55 精致化 */
const menuItemRowClass =
  'group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-all duration-150 hover:bg-white/12 hover:text-white';

/** 右键菜单外壳（统一 4 处：格子 / 条目 / 竖条 / 快捷条）——V55 精致化。
 *
 * ⚠️ 必须是 `fixed`，不能是 `absolute`（V59 追加）。
 *
 * 这四处菜单的坐标全部直接取自 `event.clientX / clientY` —— 那是**视口**坐标，
 * 语义上本来就该锚在视口上（V53 的桌面菜单一直是 `fixed`，两边原本就不一致）。
 *
 * 更实际的原因：桌面根画布带 `overflow-hidden`（见它的说明），`absolute` 子元素会被
 * 它裁剪 —— 在屏幕靠下 / 靠右的位置右键，菜单会被切掉半截。`fixed` 的包含块是视口，
 * 不受祖先 `overflow` 裁剪（根画布没有 transform / filter，不会把 fixed 收回来）。 */
const menuShellClass =
  'fixed z-50 w-48 overflow-hidden rounded-2xl border border-white/15 bg-gradient-to-b from-neutral-900/95 to-neutral-950/98 py-1.5 text-[13px] text-neutral-100 shadow-[0_20px_60px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.05),inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur-2xl';

/** 取路径的最后一段（快捷条上用文件名当显示名） */
function baseNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 一次布局交互（移动 / 缩放）的会话状态 */
interface Interaction {
  kind: 'move' | 'resize';
  boxId: number;
  /** `kind='resize'` 时表示拉的是哪条边/哪个角 */
  edge: ResizeEdge | null;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
}

/** 一次「条目跨格子拖拽」的会话状态（仅挂件内部；V59 起由指针拖拽驱动） */
interface ItemDrag {
  item: GridItem;
  itemId: number;
  fromBoxId: number;
}

/**
 * 一次**指针拖拽**（V59）的完整会话：从 `mousedown` 到 `mouseup`。
 *
 * 与 [`ItemDrag`] 的区别：`ItemDrag` 描述「拖的是谁」，本类型描述「这次拖拽走到哪一步了」。
 * 两者拆开是因为 `itemDragRef` 还被别处（命中判定、原生拖放事件让路）当作「有没有拖拽在进行」
 * 的标记读，语义别搅在一起。
 */
interface DragSession {
  /** 按下时的指针位置（CSS px；挂件窗里它和盒子坐标是同一套） */
  startX: number;
  startY: number;
  /** 指针位置（每帧更新，松手时按它定落点） */
  x: number;
  y: number;
  /**
   * 有没有越过 [`DRAG_THRESHOLD`] 变成**真正的拖拽**。
   *
   * 没过阈值就松手 = 普通单击，**什么也不做**。这一条必须留着：
   * 条目上还挂着双击打开文件，若按下即进入拖拽态，双击会被拖拽抢掉。
   */
  active: boolean;
  /** 按过 Esc = 取消本次拖拽（松手时光标在哪都不落） */
  cancelled: boolean;
  /** 拖的是格子里的条目（与 `loose` 互斥） */
  item: GridItem | null;
  /** 拖的是左侧「未归类」竖条里的条目 */
  loose: LooseEntry | null;
  /** V86：按下时的修饰键 —— 没越过阈值就松手时，按它把这一下解释成「选择点击」 */
  mods: { ctrl: boolean; shift: boolean };
  /** V86：拖拽载荷的路径集合（越过阈值那一刻算出；多选拖拽时 > 1） */
  batch: string[];
}

/** 按扩展名粗判是否目录（无扩展名 → 视为文件夹；仅影响展示图标，不影响打开） */
function isDirectoryPath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? '';
  return !/\.[^./\\]+$/.test(name);
}

/**
 * 卡片磨砂底色（内联渐变，跟着 `accent` 走）。
 *
 * 取「同色系深底 + 中等透明度」：透明度太高（V34 的 0.045 白）会让前景文字和壁纸
 * 混在一起、看着发虚，用户反馈的「有点模糊」正是这个；太低又变成一块黑砖、失去
 * 「融入桌面」的感觉。0.62 → 0.46 的竖向渐变兼顾两头：上半部更实（标题读得清），
 * 下半部略透（露出壁纸走向），配合顶部 1px 高光就有了「玻璃」的厚度感。
 */
/**
 * 拖拽真正开始的位移阈值（px）。小于它一律当普通单击。
 *
 * 为什么需要：条目上同时挂着「双击打开文件」与「拖拽」。若 `mousedown` 就进入拖拽态，
 * 双击会被拖拽吃掉（第二次点击落到拖拽逻辑里）—— 用户就会变成「点不开了」。
 */
const DRAG_THRESHOLD = 5;

/**
 * **内部拖拽 = 指针拖拽，不再用 HTML5 拖放**（V59）。
 *
 * # 为什么把 V43–V58 那一整套 `dataTransfer` 方案整体推翻
 *
 * V43 到 V58 一直在修同一个用户反馈：「拖动图标就显示禁用符号、放不下去」。每一版都加了
 * 一层猜测——`effectAllowed = 'all'`（"Dock 那边 dropEffect='copy' 不兼容"）、
 * `dataTransfer.types` 兜底、`itemDragRef` 兜底、「无论谁的拖拽都先 `preventDefault`」……
 * 全都无效。因为**根因根本不在 JS 里**：
 *
 * Tauri 在 Windows 上会给挂件窗注册一个原生 `IDropTarget`（配置项 `dragDropEnabled`，
 * 默认 `true`），而 wry 的实现（`wry-0.55.1/src/webview2/drag_drop.rs`）是这样的：
 *
 * ```text
 * fn DragEnter(pDataObj, ..., pdwEffect) {
 *     let hdrop = iterate_filenames(pDataObj, ...);   // 只认 CF_HDROP（真实文件）
 *     if hdrop.is_none() { return Ok(()); }           // ← 直接返回，**一个字都不写 *pdwEffect**
 * }
 * fn DragOver(..., pdwEffect) { *pdwEffect = *self.cursor_effect.get(); }  // 初值 = DROPEFFECT_NONE
 * ```
 *
 * 我们的图标是 DOM 元素，拖它**没有 `CF_HDROP`** ⇒ `enter_is_valid == false` ⇒
 * `DragOver` 在每个像素上都把 `*pdwEffect` 写成 `DROPEFFECT_NONE` ⇒ **操作系统**判定
 * 这次拖拽「不可放置」：光标画成禁止符号，`drop` 永远不派发。
 *
 * 结论：**只要用 HTML5 拖放去拖 DOM 元素，在这个窗口里就永远放不下**，
 * 跟 JS 侧怎么写没有半点关系。用户从 V43 到 V58 反复反馈的那件事，真正的原因在
 * wry 的 Rust↔COM 边界上，前端再怎么打补丁也修不好。
 *
 * # 现在的做法
 *
 * 指针拖拽：`mousedown` 记起点 → `mousemove` 越过 [`DRAG_THRESHOLD`] 才真正开始（自己算落点、
 * 自己画一个跟随光标的预览）→ `mouseup` 执行落点动作。整条链路**不进入系统的拖放循环**，
 * 那个 `IDropTarget` 根本没机会插手，`DROPEFFECT_NONE` 这回事也就不存在了。
 *
 * # 顺带保住的能力
 *
 * 「从资源管理器把文件拖进格子」走的是**另一条路**：那是真实文件、有 `CF_HDROP`，
 * Tauri 的 `onDragDropEvent` 照旧正常工作。两套拖拽天然互不干扰 ——
 * 这正是「关掉 `dragDropEnabled` 换 HTML5 拖放」那种改法做不到的（关了它，真实文件
 * 就再也拿不到路径了）。见 CONVENTIONS §32。
 */

/**
 * 工作台「快捷入口」里的**一键**（V61 由 `DockCell` 磁贴改来）。
 *
 * 用户 09-21（附截图）：「感觉工作台这块样式不够自然，一看那个快捷模块就是拼接上去的
 * 要融为几个整体，简单的文字按钮就可以 不用那么大的图标占空间，本来空间就不够」。
 *
 * V56–V60 它是「32px 图标块 + 一行 10px 标签居中」的磁贴（3 列方阵）：9 个系统入口
 * 要吃掉约 170px 高度，而且方阵本身非常抢眼 —— 看上去就是「另一块面板贴在工作台上」。
 * 改成「12px 图标 + 11px 文字」的胶囊后，同一批入口只要约 110px，一行并两个，
 * 形状语言也与日历那边的圆角小格一致了。
 *
 * 图标有两种给法：`icon`（lucide 组件，系统入口 / 工具箱走这条）与 `iconNode`
 * （现成的节点 —— 「我的快捷方式」要显示真实文件图标，拿不到 lucide 组件）。
 */
function DockChip({
  icon: Icon,
  iconNode,
  label,
  title,
  onClick,
  onContextMenu,
}: {
  icon?: typeof Plus;
  iconNode?: React.ReactNode;
  label: string;
  title: string;
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      {...(onContextMenu !== undefined ? { onContextMenu } : {})}
      className="group flex min-w-0 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2 py-1.5 text-left transition hover:bg-white/[0.14]"
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center opacity-75 transition group-hover:opacity-100">
        {iconNode ?? (Icon !== undefined ? <Icon className="h-3.5 w-3.5" /> : null)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] leading-none text-neutral-300 transition group-hover:text-white">
        {label}
      </span>
    </button>
  );
}

function cardBackground(accent: GridAccent): string {
  /** 各配色的底色 RGB（深色，保证白色文字对比度 ≥ 7:1） */
  const tint: Record<GridAccent, string> = {
    '': '14,18,30',
    amber: '28,20,10',
    rose: '32,14,22',
    sky: '10,20,34',
    emerald: '9,26,20',
    violet: '22,14,32',
    slate: '18,20,26',
  };
  const rgb = tint[accent] ?? tint[''];
  // V54：更精致的毛玻璃卡片底 —— 顶部高光 + 主体渐变 + 底部微亮，
  // 做出「贴在壁纸上的玻璃卡」质感，不是纯黑一坨。
  return `linear-gradient(180deg, 
    rgba(${rgb},0.72) 0%, 
    rgba(${rgb},0.58) 40%, 
    rgba(${rgb},0.50) 100%)`;
}

/** 编辑态描边：用配色染一下，一眼看出这格是哪个颜色 */
function accentRing(accent: GridAccent): string {
  const ring: Record<GridAccent, string> = {
    '': 'ring-1 ring-sky-300/45',
    amber: 'ring-1 ring-amber-300/60',
    rose: 'ring-1 ring-rose-300/60',
    sky: 'ring-1 ring-sky-300/60',
    emerald: 'ring-1 ring-emerald-300/60',
    violet: 'ring-1 ring-violet-300/60',
    slate: 'ring-1 ring-slate-200/55',
  };
  return ring[accent] ?? ring[''];
}

// —— 系统真实图标（接管桌面的观感关键：和资源管理器一致，一眼认出「这是我的文件」） ——

/** 一条图标缓存：dataURL + 原始像素尺寸（尺寸跟着系统图标走，不在前端硬编码缩放） */
interface IconEntry {
  url: string;
  size: number;
}

/** 图标缓存（路径 → 图标）：挂件窗独立 JS 环境，模块级即可 */
const iconCache = new Map<string, IconEntry>();
const iconPending = new Map<string, Promise<IconEntry | null>>();

/**
 * 取系统真实图标并转成 dataURL。
 *
 * V34（用户反馈「整理到格子里面的图标样式都变了」）：Rust 侧改为取**带快捷方式
 * 箭头叠层**的 48px 大图标（`SHGetImageList` 的 `SHIL_EXTRALARGE`）—— 之前取的是
 * 无箭头的 32px 基础图标，于是 `.lnk` 在格子里「长得不像快捷方式」，
 * 和桌面/资源管理器里的样子对不上。这里也不再写死 `h-8 w-8`，按真实尺寸渲染。
 */
async function loadIcon(path: string): Promise<IconEntry | null> {
  try {
    const data = await ipc.gridFileIcon(path);
    if (!data || data.width <= 0 || data.height <= 0) {
      return null;
    }
    const bytes = Uint8Array.from(atob(data.rgbaBase64), (char) => char.charCodeAt(0));
    const canvas = document.createElement('canvas');
    canvas.width = data.width;
    canvas.height = data.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength), data.width, data.height),
      0,
      0,
    );
    return { url: canvas.toDataURL('image/png'), size: data.width };
  } catch {
    return null;
  }
}

/**
 * 系统桌面图标尺寸（逻辑像素）。
 *
 * 用户 V37 反馈：「格子里面的图标大小应该跟正常桌面大小保持一致」。这个尺寸存在
 * 注册表里（用户按 `Ctrl + 滚轮` 调的就是它），由 Rust 的 `desktop_icon_metrics` 读出。
 * 读不到时先用 48（Windows 桌面默认值），不必让界面等它。
 */
function useDesktopIconSize(): number {
  const [size, setSize] = useState(48);
  useEffect(() => {
    let cancelled = false;
    void ipc
      .desktopIconMetrics()
      .then((metrics) => {
        if (cancelled) {
          return;
        }
        // 留痕：用户报「格子图标跟桌面不一样大」时，日志里能直接看到实际取到的数字
        void ipc
          .logFrontend(
            'info',
            `格子图标尺寸：${metrics.iconSize}px（来源 ${metrics.source}，间距 ${metrics.spacing}）`,
          )
          .catch(() => undefined);
        if (metrics.iconSize > 0) {
          setSize(metrics.iconSize);
        }
      })
      .catch((error: unknown) => {
        // 读不到就用默认值，不打扰用户 —— 但要在日志里留个痕
        void ipc
          .logFrontend('warn', '读取桌面图标尺寸失败，回退 48px', String(error))
          .catch(() => undefined);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return size;
}

/**
 * 条目图标：优先系统真实图标，加载失败回退通用线条图标。
 *
 * `size` 由调用方传入（来自 [`useDesktopIconSize`]）—— 显示尺寸不再写死，跟着用户的
 * 桌面图标设置走。`IconEntry.size` 只代表**位图分辨率**，不当显示尺寸用。
 */
function FileIcon({ path, size }: { path: string; size: number }): React.JSX.Element {
  const [icon, setIcon] = useState<IconEntry | null>(() => iconCache.get(path) ?? null);
  useEffect(() => {
    if (icon !== null) {
      return;
    }
    let cancelled = false;
    const pending = iconPending.get(path) ?? loadIcon(path);
    iconPending.set(path, pending);
    void pending
      .then((data) => {
        if (data !== null) {
          iconCache.set(path, data);
        }
        if (!cancelled && data !== null) {
          setIcon(data);
        }
      })
      .finally(() => {
        iconPending.delete(path);
      });
    return () => {
      cancelled = true;
    };
  }, [path, icon]);
  if (icon !== null) {
    return (
      <img
        src={icon.url}
        alt=""
        draggable={false}
        style={{ width: size, height: size }}
        className="shrink-0 object-contain [filter:drop-shadow(0_1px_2px_rgba(0,0,0,0.55))]"
      />
    );
  }
  // 真图标还没取到时先用线条图标占位，按桌面尺寸的 0.8 画（线条图标视觉偏大）
  const fallback = Math.round(size * 0.8);
  return isDirectoryPath(path) ? (
    <FolderClosed style={{ width: fallback, height: fallback }} className="text-amber-300" />
  ) : (
    <File style={{ width: fallback, height: fallback }} className="text-sky-300" />
  );
}

/**
 * 「未归类」竖条里的单个图标（V42）。
 *
 * 系统入口（此电脑 / 回收站 / 用户的文件）目前走内置线条图标 —— 见下方 V47 注释。
 *
 * # V47：去掉深色圆角底片
 *
 * 用户原话：「我原我的电脑 回收站这几个系统本身的图标怎么变成这样了」。
 * V42 给这三个入口套了一层 `bg-white/10 + ring` 的圆角方块，于是它们在桌面上一眼看
 * 就不是"桌面图标"，而像三个按钮 —— 与整条竖条里其它裸图标（Chrome、微信…）风格断裂。
 * 现在统一成裸图标。
 *
 * ⚠️ **仍未解决的部分**：这三个图标是内置线条图标，**不是** Windows 真实图标
 * （真实的是蓝色显示器 / 蓝色回收站）。原因见 [`SYSTEM_ENTRY_ICONS`] 处注释。
 */
function LooseIcon({ entry, size }: { entry: LooseEntry; size: number }): React.JSX.Element {
  // V51：系统入口（此电脑/回收站/用户的文件）也走 FileIcon，不再用内置线条图标。
  // 用户明确要求恢复 Windows 原生图标。后端 grid_file_icon 对 CLSID 路径调用
  // SHGetFileInfoW，能拿到真实系统图标（含回收站空/满状态）。如果后端拿不到，
  // FileIcon 有 fallback 到线条图标，不会空白。
  return <FileIcon path={entry.path} size={size} />;
}

export function GridOverlay(): React.JSX.Element {
  // —— 数据态 ——
  const [boxes, setBoxes] = useState<GridBox[]>([]);
  const [items, setItems] = useState<Record<number, GridItem[]>>({});
  const [hint, setHint] = useState<string | null>(null);

  // —— V52：每格子独立锁定/解锁 ——
  // 用户 09-19：「锁定解锁应该针对每个格子上，不要全局锁定」。
  // `unlockedBoxes` 记录当前解锁的格子 id。`editMode` 改为计算属性：
  // 只要有任意格子解锁，全局就处于「编辑态」（显示添加按钮等）。
  const [unlockedBoxes, setUnlockedBoxes] = useState<ReadonlySet<number>>(() => new Set());
  const editMode = unlockedBoxes.size > 0;
  const toggleBoxLock = useCallback((boxId: number): void => {
    setUnlockedBoxes((prev) => {
      const next = new Set(prev);
      if (next.has(boxId)) {
        next.delete(boxId);
      } else {
        next.add(boxId);
      }
      return next;
    });
  }, []);
  /**
   * 桌面工具栏是否展开（V48）。
   *
   * 用户 09-19 原话：「这个（工具条）可以做成工具条做成悬浮球样式」——
   * 收起态只是一个 44px 的圆球，点一下才摊开成完整工具栏。桌面是用户自己的工作区，
   * 常驻一长条按钮在审美上就是「多出来一块 UI」，而悬浮球既保留了「随时能用」，
   * 又把默认占位压到最小（收起时只占球那么点，命中区也跟着缩小）。
   */
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /**
   * 正在改名的**条目**（V87）：存**文件路径**，不是 id。
   *
   * 因为「未归类」竖条里的桌面文件**没有** `grid_items` 登记行（拿不到 id），
   * 但用户同样要能给它改名 —— 用路径，格子里的条目与竖条里的文件能共用一套。
   */
  const [renamingItemPath, setRenamingItemPath] = useState<string | null>(null);
  const [itemRenameDraft, setItemRenameDraft] = useState('');
  /** Explorer 的「单击两次改名」：记上一次单击落在哪个条目、什么时候 */
  const lastClickRef = useRef<{ path: string; at: number }>({ path: '', at: 0 });
  /** 正在用「填路径」方式添加条目的盒子 id（拖放之外的第二条入口） */
  const [addingBoxId, setAddingBoxId] = useState<number | null>(null);
  const [addPathDraft, setAddPathDraft] = useState('');
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
  const [scaleFactor, setScaleFactor] = useState(1);
  /** 正在挑选配色的格子 id（V35：多个便签并存时用来区分） */
  const [accentBoxId, setAccentBoxId] = useState<number | null>(null);
  /**
   * 格子右键菜单（V35 借鉴腾讯桌面整理的操作面板）。
   *
   * 为什么要有：格子的能力已经不少（重命名 / 配色 / 解散 / 新建同款），但**入口都是
   * 「先解锁布局、再找标题栏上的小按钮」** —— 用户原话是「我都搞不懂」。右键就直接
   * 列出来，不用先切模式，这是桌面上最本能的一个动作。
   */
  const [menuBox, setMenuBox] = useState<{ id: number; x: number; y: number } | null>(null);
  /**
   * 条目右键菜单（V41）：右键落在**条目**上时弹它自己的操作，而不是格子菜单。
   *
   * 用户原话：「你把工具右键改到格子里面，那么我桌面上的图标右键功能怎么办，
   * 还有文件目录我自带右键功能怎么办」。原生 shell 菜单在接管模式下给不了，
   * 这里先补最高频的三件事：打开 / 打开文件位置 / 移出格子。
   */
  const [menuItem, setMenuItem] = useState<{ item: GridItem; x: number; y: number } | null>(null);
  /** 未归类竖条条目的右键菜单（V41）：打开 / 打开文件位置（还没有「移出格子」可言） */
  const [menuLoose, setMenuLoose] = useState<{ entry: LooseEntry; x: number; y: number } | null>(
    null,
  );
  /** 未归类竖条状态（V42）：几何 + 分几列 + 条目；width=0 / 接管关闭时不渲染 */
  const [loose, setLoose] = useState<LooseArea | null>(null);

  // —— V86：条目多选（对齐原生桌面：Ctrl 点选 / Shift 范围 / 单击单选 / 空白清除） ——
  //
  // 用户 09-30 原话：「格子里面我想 shift 或者 ctrl 都选中几个文件都没法选中了，
  // 我们只是把桌面上的图标整理移动到整齐的位置上，你现在是直接把桌面完全改掉了呢？」
  // —— 交互尽量回到原生的样子，选中这件事是原生桌面的基本功。
  /** 选中的路径集合（格子里按 `filePath`、竖条按 `path`，两处统一按路径记） */
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  /** Shift 范围选择的锚点（哪个容器的第几项；竖条用 `boxId = -1`） */
  const selectionAnchorRef = useRef<{ boxId: number; index: number } | null>(null);
  /** `selectedPaths` 的镜像：全局 mouseup 监听（effect 只挂一次）里要读最新值 */
  const selectedPathsRef = useRef<Set<string>>(selectedPaths);
  /** `items` / `loose` 的镜像：拖拽主循环里要按路径反查条目（setState 是异步的） */
  const itemsRef = useRef(items);
  const looseStateRef = useRef(loose);
  useEffect(() => {
    selectedPathsRef.current = selectedPaths;
    itemsRef.current = items;
    looseStateRef.current = loose;
  }, [items, loose, selectedPaths]);

  /** 第 `index` 个选中容器的条目路径（`containerId = -1` 表示未归类竖条） */
  const containerItemPath = useCallback((containerId: number, index: number): string | null => {
    if (containerId < 0) {
      return looseStateRef.current?.items[index]?.path ?? null;
    }
    return itemsRef.current[containerId]?.[index]?.filePath ?? null;
  }, []);

  /** 把「这一次选择点击」落到选中集合上（Ctrl 切换 / Shift 同容器范围 / 普通单选） */
  const applySelectionClick = useCallback(
    (containerId: number, index: number, path: string, mods: { ctrl: boolean; shift: boolean }): void => {
      const cur = selectedPathsRef.current;
      let next: Set<string>;
      if (mods.ctrl) {
        next = new Set(cur);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        selectionAnchorRef.current = { boxId: containerId, index };
      } else if (mods.shift && selectionAnchorRef.current?.boxId === containerId) {
        next = new Set(cur);
        const anchor = selectionAnchorRef.current.index;
        const [from, to] = anchor <= index ? [anchor, index] : [index, anchor];
        for (let i = from; i <= to; i += 1) {
          const p = containerItemPath(containerId, i);
          if (p !== null) {
            next.add(p);
          }
        }
      } else {
        next = new Set([path]);
        selectionAnchorRef.current = { boxId: containerId, index };
      }
      // 先同步镜像再 setState：mouseup 之后紧跟着的拖拽 / 事件读的是镜像
      selectedPathsRef.current = next;
      setSelectedPaths(next);
    },
    [containerItemPath],
  );
  /**
   * 桌面快捷条（V42）的条目 —— 与工作台共用同一份数据（`quicklinks.ts`，localStorage
   * 与主窗口同源），所以这里加一条，工作台的「快捷入口」面板里立刻也有。
   *
   * 用户原话：「工作台里面的快捷方式可以放在桌面上的例如 mac 电脑的快捷条一样方便
   * 快速打开……当然这个还可以自己手动定义，把桌面图标拖进来归纳到里面」。
   */
  const [dockLinks, setDockLinks] = useState<QuickLink[]>(() => loadQuickLinks());
  /** 光标正停在快捷条上（拖拽经过时的视觉反馈） */
  const [dockHot, setDockHot] = useState(false);
  /** 快捷条条目的右键菜单（V42/V43）：打开 / 从快捷条移除（自定义链接或系统入口） */
  const [menuDock, setMenuDock] = useState<
    { kind: 'link'; link: QuickLink; x: number; y: number } | { kind: 'action'; action: SysAction; x: number; y: number } | null
  >(null);
  /**
   * 系统快捷入口（V43）—— Dock 的左半部分。
   *
   * 用户原话：「原工作台我们不是添加了各种快捷入口吗（如 hosts 文件编辑等都没有了呢）」
   * 「快捷入口的快捷方式我说了直接在桌面上做成快捷入口像快捷导航入口那样」。
   * 这些是**系统动作**（Rust 白名单表里的 `sys_action_list`），和工作台的快捷入口栏
   * 是同一批 id、同一份选中状态（`settings.quickActionIds`），只是换到桌面上来点。
   */
  const [dockActions, setDockActions] = useState<SysAction[]>([]);
  /**
   * 桌面「工作台」是否折叠（收起成一条标题栏）。
   *
   * V56 时它管的是「右下角快捷入口格子」；V60 快捷入口并进工作台，这个开关跟着升格为
   * **整个工作台**的收起（工作台占着右侧一整列，桌面右侧有时正是用户要放东西的地方 ——
   * 留一个「收起成一条标题栏」的口子）。状态存 localStorage，与快捷方式同一套做法。
   */
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WST_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleDockCollapsed = useCallback((): void => {
    setDockCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(WST_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // 隐私模式 / 存储被禁：本次会话内照样生效，只是记不住
      }
      return next;
    });
  }, []);
  /**
   * 工作台里日历的**主题**（V60 从日历格子搬过来的状态）。
   *
   * 落在 localStorage：主题是「用户调过一次就一直用」的偏好，丢一次他会觉得「设置没保存」
   * —— 与 V59 修 `boxViewModes` 是同一个理由。
   */
  const [calendarTheme, setCalendarThemeState] = useState<GridAccent>(() => {
    try {
      const raw = localStorage.getItem(WST_THEME_KEY);
      // 只认白名单里的键：脏数据（手改过 localStorage / 老版本遗留）不能让日历整块渲不出来
      return raw !== null && raw in CALENDAR_THEMES ? (raw as GridAccent) : '';
    } catch {
      return '';
    }
  });
  const setCalendarTheme = useCallback((accent: GridAccent): void => {
    setCalendarThemeState(accent);
    try {
      localStorage.setItem(WST_THEME_KEY, accent);
    } catch {
      // 同上：记不住也不影响本次会话
    }
  }, []);
  /** 主题调色板是否展开（纯界面态，不落盘） */
  const [showThemePicker, setShowThemePicker] = useState(false);
  const quickActionIds = useAppStore((state) => state.settings.quickActionIds);
  const updateSettings = useAppStore((state) => state.updateSettings);
  /**
   * 桌面右侧**统一面板**（V45）：取代 V42–V44 的「中部搜索浮层 + 偏左大抽屉 + 右下快捷浮层」
   * 三件套（用户 09-19：「工具搜索应该放在右侧，跟工作台差不多 直接搜索获取，而不是打开
   * 额外的对话框 很乱」「还是有点混乱」）。
   *
   * 桌面上现在只有这一个容器：`tab` 决定落在「工具」还是「快捷」页签，`entry` 非空时
   * 直接进「使用模式」（面板原地换成那个工具的界面）。`null` = 面板关着。
   */
  const [sidePanel, setSidePanel] = useState<{ tab: SidePanelTab; entry: PanelEntry | null } | null>(
    null,
  );
  /**
   * 面板是否铺满右侧（V49）——用户：「默认占一半的桌面空间…后面的工具打开后的具体某个
   * 工具也有足够的操作功能」。默认半屏，用户在面板顶栏随时切到铺满。
   *
   * 刻意**提到 GridOverlay 里**（而不是面板内部 state）：宽度类挂在外层容器上，而外层
   * 容器正是报给 Rust 的**命中区矩形**，宽度必须由同一个组件算，否则命中区会与视觉错位。
   */
  const [panelWide, setPanelWide] = useState(false);
  /**
   * 桌面整理内容是否收起（V44.3）。
   *
   * true = 只留常驻「便携工具箱」工具栏，原生桌面图标恢复显示；格子 / 未归类竖条 /
   * Dock / 搜索面板都不渲染。false = 完整桌面整理态。
   *
   * 根因：之前「隐藏挂件」把整个挂件窗 `hide` 了，工具栏跟着消失，桌面再无任何入口
   * 能重新打开整理（用户实测死路）。现在挂件窗始终显示，只有「内容」收起，工具栏恒在。
   * 两个更新来源：挂载时查 `grid_overlay_status().engaged`，以及后端广播的
   * `grid:visibility`（V79 起 **所有** 改 `overlay_visible` 的路径都会发，不再只有托盘）。
   *
   * ⚠️ V79：初值从 `false` 改成 **`true`（fail-closed）**。
   * 用户 09-25 截图实测「每次新打开 handy 后格子都摊在桌面上」：挂件窗在 `ensure_overlay_window`
   * 里 `show()` 之后 React 立刻按初值 `false` 画了一屏格子，而此刻 `grid_overlay_status()`
   * 还没回来 —— 后端明明已经决定「只留工具栏」（`show_launcher_only`），界面却先把格子画上了；
   * 该请求若失败（`.catch` 吞掉）就**永远**停在摊开态。
   * 改成从「收起」起步：**没问清楚之前绝不画格子**。真该展开时最多晚一帧（一次 IPC 往返），
   * 而误展开的代价是用户面对一屏不该出现的格子。
   */
  const [contentHidden, setContentHidden] = useState(true);
  /** 桌面「快捷操作」浮层（V44）已并入右侧统一面板（V45），见 `sidePanel` */

  // V53：便签不再有折叠/展开——根据内容自动撑开高度。
  // 用户 09-19：「便签不要折叠展开操作，默认根据里面的内容自动撑开即可」。
  // V53：桌面右键菜单状态
  const [menuDesktop, setMenuDesktop] = useState<{ x: number; y: number } | null>(null);
  /** 是否正处于「条目被拖着走」的状态（拖出格子 = 移出，落在根画布上要接住 drop） */
  const [itemDragging, setItemDragging] = useState(false);

  // V51：格子视图模式——'grid'（图标网格）或 'list'（列表）。每格子可独立切换，
  // 未设的默认 'grid'。用户 09-19：「格子里面显示方式可以切换图标和列表两种方式」
  const [boxViewModes, setBoxViewModes] = useState<Record<number, 'grid' | 'list'>>(() => {
    // V59：从 localStorage 恢复（此前是纯内存态，重启即丢）。解析失败一律退回空表 =
    // 全部按默认的「图标网格」，不会因为一条脏数据让格子渲染不出来。
    try {
      const raw = localStorage.getItem(BOX_VIEW_MODES_KEY);
      if (raw === null) {
        return {};
      }
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<number, 'grid' | 'list'>)
        : {};
    } catch {
      return {};
    }
  });
  // V87：各格子的**排序方式**（默认「自定义顺序」= 用户自己拖出来的先后）
  const [boxSortModes, setBoxSortModes] = useState<Record<number, BoxSortMode>>(() => {
    try {
      const raw = localStorage.getItem(BOX_SORT_MODES_KEY);
      if (raw === null) {
        return {};
      }
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) {
        return {};
      }
      // 只认白名单里的值：脏数据不能让格子渲染不出来（与视图模式同一条纪律）
      const clean: Record<number, BoxSortMode> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const id = Number(key);
        if (Number.isFinite(id) && BOX_SORT_MODES.includes(value as BoxSortMode)) {
          clean[id] = value as BoxSortMode;
        }
      }
      return clean;
    } catch {
      return {};
    }
  });

  /** 切换排序方式：自定义顺序 → 按名称 → 按类型 → 回到自定义顺序 */
  const cycleBoxSortMode = useCallback((boxId: number): void => {
    setBoxSortModes((prev) => {
      const current = prev[boxId] ?? 'manual';
      const next: BoxSortMode =
        BOX_SORT_MODES[(BOX_SORT_MODES.indexOf(current) + 1) % BOX_SORT_MODES.length] ??
        'manual';
      const merged: Record<number, BoxSortMode> = { ...prev, [boxId]: next };
      try {
        localStorage.setItem(BOX_SORT_MODES_KEY, JSON.stringify(merged));
      } catch {
        // 存不下不影响本次显示，只是重启后回到默认
      }
      return merged;
    });
  }, []);

  const toggleBoxViewMode = useCallback((boxId: number): void => {
    setBoxViewModes((prev) => {
      const next: Record<number, 'grid' | 'list'> = {
        ...prev,
        [boxId]: prev[boxId] === 'list' ? 'grid' : 'list',
      };
      try {
        localStorage.setItem(BOX_VIEW_MODES_KEY, JSON.stringify(next));
      } catch {
        /* 隐私模式 / 配额满：退化成「本次会话有效」，不影响视图本身 */
      }
      return next;
    });
  }, []);
  const getBoxViewMode = (boxId: number): 'grid' | 'list' =>
    boxViewModes[boxId] ?? 'grid';
  /**
   * 刚新建的格子 id —— 一段**高亮**期（2.4 秒）。
   *
   * V38 用户原话：「新加的格子默认直接不显示操作，很不方便……我新加的就是要操作的」。
   * 新建之后光解锁还不够：桌面上可能已经有五六个格子，用户得先找到它。高亮就是回答
   * 「你要操作的那个在这」。
   */
  const [focusBoxId, setFocusBoxId] = useState<number | null>(null);

  /** V55：拖动格子时的对齐参考线 —— 显示其他格子边缘位置辅助对齐 */
  const [snapGuides, setSnapGuides] = useState<{
    vertical: number[];
    horizontal: number[];
  }>({ vertical: [], horizontal: [] });
  /**
   * 桌面接管态（V38）：`enabled` = 用户选择由格子层呈现桌面（原生图标藏起来）。
   *
   * 必须同时看 `iconsVisible` 才能讲实话 —— 隐藏动作可能失败（第三方桌面工具占着
   * 图标视图），那时桌上是「格子 + 原图标」两份内容，正是用户投诉的那件事，不能装作
   * 已经藏好了。
   */
  const [takeover, setTakeover] = useState<TakeoverState | null>(null);

  /**
   * 系统桌面图标尺寸（V37）。
   *
   * 格子里图标与桌面图标必须是同一个视觉尺度，否则「整理到格子里」看着就像换了一套
   * 图标。尺寸不写死，跟着系统设置走（用户可能按 `Ctrl + 滚轮` 调过）。
   */
  const iconSize = useDesktopIconSize();

  /** 渲染无关的可变状态（事件回调内读取，避免闭包过期） */
  const boxesRef = useRef<GridBox[]>([]);
  const scaleRef = useRef(1);
  const interactionRef = useRef<Interaction | null>(null);
  /** 进行中的条目内部拖拽（null = 没有正在拖的条目） */
  const itemDragRef = useRef<ItemDrag | null>(null);
  const hintTimerRef = useRef<number | undefined>(undefined);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemMenuRef = useRef<HTMLDivElement | null>(null);
  const looseMenuRef = useRef<HTMLDivElement | null>(null);
  const dockMenuRef = useRef<HTMLDivElement | null>(null);
  /** 未归类竖条的 DOM 引用：它也要纳入命中区域（V41 起） */
  const looseRef = useRef<HTMLDivElement | null>(null);
  /** 桌面快捷条的 DOM 引用（V42）：纳入命中区域 + 原生拖放的落点判定 */
  const dockRef = useRef<HTMLDivElement | null>(null);
  /** 桌面右侧统一面板的外框（V45）：纳入命中区域，面板开着时桌面其余部分照样能点 */
  const sidePanelRef = useRef<HTMLDivElement | null>(null);
  /** 正在拖拽的未归类竖条条目（拖进格子 = 登记进去） */
  const looseDragRef = useRef<LooseEntry | null>(null);
  /** 空态卡片的 DOM 引用：它也要纳入命中区域，否则「创建第一个盒子」按钮点不到 */
  const emptyRef = useRef<HTMLDivElement | null>(null);
  /** 各挂件最近一次上报的「内容自然高度」：用户手动拉过之后据此判断内容有没有变 */
  const lastNaturalRef = useRef<Map<number, number>>(new Map());
  /**
   * 收纳区滚动容器（V63）。
   *
   * 收纳格全部住在这层 `overflow-y-auto` 里，便签（挂件）用 `fixed` 挂在外面 ——
   * 于是「网格放不下」时只有收纳区滚动。**不做溢出时 `scrollTop` 恒为 0**，一切照旧。
   *
   * ⚠️ 只要有滚动位移，坐标换算就要带上它：盒子是「容器内坐标 = 桌面坐标」，
   * 可视位置 = 桌面坐标 − `scrollTop`。所以命中判定（`hitBoxId`）必须把位移**加回去**，
   * 否则滚动之后拖放会认错格子（见那里的说明）。
   */
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * 「用户手动定过高度」的挂件：`boxId → 当时的内容自然高度`。
   *
   * 自动撑高和手动缩放会互相打架 —— 用户把日历拉矮，撑高逻辑立刻又把它顶回去。
   * 规则：手动拉过之后**先听用户的**；等这份内容真的变了（自然高度变了），
   * 自动撑高才重新接管。这样两边都合理。
   */
  const autoHeightBlockedRef = useRef<Map<number, number>>(new Map());
  /** 挂件高度落库防抖定时器（自动撑高会连续调几次，别每次都写库） */
  const heightSaveTimerRef = useRef<number | undefined>(undefined);

  // boxesRef 镜像：拖放命中测试 / mouseup 落库时读取最新布局
  useEffect(() => {
    boxesRef.current = boxes;
  }, [boxes]);

  /** 短暂提示（挂件窗没有 toast 体系，用顶部悬浮文字） */
  const showHint = useCallback((message: string): void => {
    setHint(message);
    if (hintTimerRef.current !== undefined) {
      window.clearTimeout(hintTimerRef.current);
    }
    // V70：按字数放宽显示时长 —— 「桌面已满，先删一个格子」这类提示带着行动指引，
    // 固定 2.6 秒还没读完就没了（上限 9 秒，别让它赖着不走）。
    const hold = Math.min(9000, Math.max(HINT_DURATION_MS, message.length * 110));
    hintTimerRef.current = window.setTimeout(() => setHint(null), hold);
  }, []);

  // —— 首次装配 ——

  /** 拉取盒子与条目（挂件窗独立 JS 环境，不与主窗口共享 store） */
  const refresh = useCallback(async (): Promise<void> => {
    const list = await ipc.gridBoxList();
    setBoxes(list);
    const entries = await Promise.all(
      list.map(async (box) => [box.id, await ipc.gridItemList(box.id)] as const),
    );
    setItems(Object.fromEntries(entries));
  }, []);

  /**
   * **内容一变就让引擎重算整张桌面**（V66）。
   *
   * 用户 09-22：「你要动态整理，例如我添加了新的格子你要重新计算每个格子的大小等，
   * 合理的计算分布」。V66 的引擎是「尺寸看自己的条目数、位置按列式填满」——
   * 所以**任何**会改变「格子数 / 每格条目数」的动作都必须重排一次，否则：
   *   · 新建格子停在哨兵坐标上（不重排就没落位）；
   *   · 拖进来一个文件后格子还是旧尺寸（内容装不下 → 盒内滚动条）。
   *
   * 防抖 120ms：连续拖几个文件 / 连点新建时，一次重排就够（`grid_relayout` 是幂等的，
   * 重复调用不会让摆好的格子抖动）。
   */
  const relayoutTimer = useRef<number | null>(null);
  const relayoutSoon = useCallback((): void => {
    if (!isTauri()) {
      return;
    }
    if (relayoutTimer.current !== null) {
      window.clearTimeout(relayoutTimer.current);
    }
    relayoutTimer.current = window.setTimeout(() => {
      relayoutTimer.current = null;
      void ipc
        .gridRelayout()
        .then(() => refresh())
        .catch(() => undefined);
    }, RELAYOUT_DEBOUNCE_MS);
  }, [refresh]);

  /** 上一次「未归类」竖条快照：路径序 + 矩形宽（对账时 diff 出新文件 / 宽度变化） */
  const looseSnapRef = useRef<{ paths: string[]; width: number }>({ paths: [], width: 0 });

  /**
   * 拉取「未归类」竖条并对账（V84，`announce = true` 时顺带播报新文件）。
   *
   * # 为什么要在这条路上重排（09-29 截图 ①「快捷方式积压变形跑到格子下面」）
   *
   * 收纳格的可用区是**按上次竖条宽度**算的（竖条右缘 + 缝 = 格子左界）。桌面上一有
   * 新文件，`grid_loose_list` 返回的竖条矩形是**实时**的 —— 条目多到一列放不下就往右
   * 多铺一列、整体变宽；而格子落位还停在上次重排的老地方 ⇒ 竖条新的那一列直接压到
   * 「文件」格左半边上。旧代码这里只 `setLoose`、从不重排，用户点一次「整理」才恢复
   * —— 病根和 V66「内容变了要让引擎重算」是同一条，只是当时只顾了格子内容。
   *
   * # 为什么要播报（09-29 反馈 ①「新建了半天不出结果」）
   *
   * 接管态下原生视图是隐藏的：右键新建的文件不会出现在原生桌面上，只能进未归类竖条
   * —— 而竖条条目多、又按目录序排，新文件多半落在内部滚动区的视野之外。不主动指路，
   * 用户只会认为「建了没生效」。所以有新文件时：顶部提示 + 把新条目滚进视野。
   */
  const fetchLoose = useCallback(
    async (announce: boolean): Promise<void> => {
      const area = await ipc.gridLooseList();
      const prev = looseSnapRef.current;
      const paths = area.items.map((entry) => entry.path);
      looseSnapRef.current = { paths, width: area.width };
      setLoose(area.width > 0 ? area : null);
      if (!announce) {
        return;
      }
      // 竖条变宽 / 变窄（列数变了）⇒ 让引擎按新宽度重排一次格子（幂等，摆好的格子不动）
      if (area.width !== prev.width && prev.paths.length > 0) {
        relayoutSoon();
      }
      const added = area.items.filter((entry) => !prev.paths.includes(entry.path));
      const first = added[0];
      if (first === undefined || prev.paths.length === 0) {
        return; // 没有新条目；或本次是启动后第一次拉取（不播报历史存量）
      }
      // 没接管 / 内容收起时不播报：原生图标或格子层都还看不见，指路没有意义
      if (contentHidden || takeover?.enabled !== true) {
        return;
      }
      const clean = (name: string): string => name.replace(/\.lnk$/i, '');
      const label =
        added.length === 1 ? `「${clean(first.name)}」` : `「${clean(first.name)}」等 ${added.length} 项`;
      showHint(`新文件 ${label} 已进入未归类竖条`);
      // 新条目多半在竖条内部滚动区的视野之外 —— 主动滚过去指给用户看
      window.setTimeout(() => {
        looseRef.current
          ?.querySelector(`[data-path="${CSS.escape(first.path)}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      }, 60);
    },
    [contentHidden, relayoutSoon, showHint, takeover],
  );

  /** 拉「未归类」竖条状态（V42）：条目增删 / 移出之后都要刷新（不做新文件播报） */
  const refreshLoose = useCallback((): void => {
    if (!isTauri()) {
      return;
    }
    void fetchLoose(false).catch(() => undefined);
  }, [fetchLoose]);

  // —— V87：条目改名（对齐 Explorer 的「重命名 / F2 / 单击两次」）——

  /**
   * Explorer 改名的习惯：**只改主文件名，扩展名留着不被选中**。
   *
   * 用户给「笔记.md」改名时打「笔记2」，Explorer 得到的是「笔记2.md」—— 顺手改掉
   * 扩展名会让文件双击打不开。要改扩展名就自己打全，那是显式意图，我们照办。
   */
  const keepExtension = useCallback((original: string, typed: string): string => {
    // 用户自己打了扩展名 = 明确要连扩展名一起改，别拦
    if (/^(.+)(\.[^.]+)$/.test(typed)) {
      return typed;
    }
    const originExt = /^(.+)(\.[^.]+)$/.exec(original);
    if (originExt === null) {
      return typed; // 原名本来就没有扩展名（文件夹 / 无后缀文件）
    }
    const ext = originExt[2] ?? '';
    // 快捷方式的 `.lnk` 只是 Shell 的显示尾巴，用户没看见过，别自作主张补回去
    if (/^\.lnk$/i.test(ext)) {
      return typed;
    }
    return typed + ext;
  }, []);

  const beginItemRename = useCallback((path: string, displayName: string): void => {
    setRenamingItemPath(path);
    // 快捷方式的显示名里带 `.lnk`，那是 Shell 加的、用户没看见，改名时也不该看到
    setItemRenameDraft(displayName.replace(/\.lnk$/i, ''));
  }, []);

  const commitItemRename = useCallback((): void => {
    const path = renamingItemPath;
    if (path === null) {
      return;
    }
    const typed = itemRenameDraft.trim();
    setRenamingItemPath(null);
    setItemRenameDraft('');
    if (typed.length === 0) {
      return;
    }
    const original = path.split(/[\\/]/).pop() ?? path;
    const final = keepExtension(original, typed);
    if (final === original) {
      return; // 没改，别白跑一次后端
    }
    // 同目录下的新路径。后端只做同目录改名（含 `\` 一律拒绝），所以这里直接换末段。
    const newPath = path.replace(/[^\\/]+$/, final);
    void ipc
      .gridItemRename(path, final)
      .then(() => {
        // **本地先改**（V88，用户 10-08：「输入了新名称确定后还是老名字」）。
        //
        // 后端返回 Ok 就意味着磁盘已经改完了（`fs::rename` 成功），所以这不是
        // 乐观猜测、是**事实**。之所以不能只靠 `refresh()`：它是异步的，而且
        // 里面 `Promise.all` 只要有一次 `gridItemList` 抛错，整批 `items` 就**一次都不更新**
        // ——`catch(() => undefined)` 还会把错误吞掉，用户看到的就是「改了名但名字没变」。
        setItems((prev) => {
          let touched = false;
          const next: Record<number, GridItem[]> = {};
          for (const [key, list] of Object.entries(prev)) {
            const idx = list.findIndex((entry) => entry.filePath === path);
            if (idx < 0) {
              next[Number(key)] = list;
              continue;
            }
            const copy = list.slice();
            const hit = copy[idx];
            if (hit !== undefined) {
              copy[idx] = { ...hit, filePath: newPath, displayName: final };
            }
            next[Number(key)] = copy;
            touched = true;
          }
          return touched ? next : prev;
        });
        setLoose((prev) => {
          if (prev === null) {
            return prev;
          }
          const idx = prev.items.findIndex((entry) => entry.path === path);
          if (idx < 0) {
            return prev;
          }
          const entries = prev.items.slice();
          const hit = entries[idx];
          if (hit !== undefined) {
            entries[idx] = { ...hit, path: newPath, name: final };
          }
          return { ...prev, items: entries };
        });
        setSelectedPaths((prev) => {
          if (!prev.has(path)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(path);
          next.add(newPath);
          return next;
        });
        // 再跟后端对齐：布局要按新名字重算（长度变化可能换列）
        void refresh().catch(() => undefined);
        refreshLoose();
      })
      .catch((error: Error) => showHint(error.message));
  }, [
    renamingItemPath,
    itemRenameDraft,
    keepExtension,
    refresh,
    refreshLoose,
    showHint,
  ]);

  /**
   * **桌面 / 格子空白处右键 = 我们自己把原生背景菜单弹出来**（V87）。
   *
   * # 为什么不再「借出桌面」
   *
   * V81–V86 的做法是：右键时把被我们藏起来的原生图标视图显示回来，让 Explorer 自己弹
   * 菜单、自己建文件，我们再收回。那是**补丁** —— 要赌 `#32768` 的类名语义（Win11
   * 25H2 的新式菜单根本不叫这个名字）、要等「安静 1.5s」、要 120s 超时兜底，而用户
   * 看到的仍然是「卡一下 / 要刷新 / 只有第一次成功」。
   *
   * 现在把自己当 Explorer：`IShellFolder::CreateViewObject` 拿桌面的**背景菜单**并自己
   * 弹。实测它 16 项，含「新建」「下一个桌面背景」「显示设置」「个性化」、我们注入的
   * 「Handy 桌面整理」子菜单，以及全部第三方扩展（见 `examples/bg_menu_dump.rs`）。
   * 菜单里每一项都由 Shell 自己执行完，我们不插手。
   *
   * # 为什么菜单收起后要「认领新文件」
   *
   * Explorer 新建完一个文件夹，会立刻让那一项进入**原位改名**。我们没有原生列表视图，
   * 所以：重扫桌面 → 只多出一个就让它进入自绘改名框。用户点完「新建文件夹」可以直接
   * 打字，不用再去找它、再右键重命名。
   */
  const openDesktopBackgroundMenu = useCallback(
    (extended: boolean): void => {
      // V90：接管态的桌面空白右键**转发给 Explorer 自己的桌面视图**，弹出它的
      // **完整原生菜单**（查看 / 排序方式 / 刷新 / 撤销 / 完整的 ShellNew「新建」14 项）。
      //
      // 用户 10-08 23:01 拿两张图质问「这是你搞得右键菜单，你到底能不能实现原始功能」
      // —— 对比的就是「退出接管后的原生菜单（图1，齐全）」vs「接管态我们复刻的菜单
      // （图2，只有新建两项，连查看/排序/刷新都没有）」。那两块钱**不经过 IContextMenu**，
      // 复刻永远追不平，所以改成转发（详见 `shell_menu::show_desktop_view_context_menu`）。
      //
      // 命令在菜单**收起后**才 resolve：
      //   · 原生路径（首选）→ 回 `null`：用户点了什么我们不知道，做**增量对账** ——
      //     只把新增项送进竖条 + 原地改名，**只有出现删除 / 改名才重排格子**
      //     （单纯新建绝不整层 refresh，那才是用户抱怨的「卡 + 整体刷新」）；
      //   · 复刻菜单回退路径 → 回 `CreatedItem`：直接知道建了什么，省掉对账。
      void (async () => {
        // 先记快照：菜单期间可能有轮询先把新文件收进快照，靠「前 / 后 diff」才不会漏判。
        const before = new Set(looseSnapRef.current.paths);
        let created: { path: string; name: string } | null = null;
        try {
          created = await ipc.shellDesktopBackgroundMenu(extended);
        } catch (error) {
          showHint((error as Error).message);
          return;
        }
        await fetchLoose(false).catch(() => undefined);
        if (created !== null) {
          // 回退路径（复刻菜单）：命令直接告诉我们建了什么，不用 diff。
          beginItemRename(created.path, created.name);
          return;
        }
        const after = looseSnapRef.current.paths;
        const added = after.filter((p) => !before.has(p));
        const removed = [...before].filter((p) => !after.includes(p));
        // 有删除 / 改名才需要重建格子；单纯新建只进竖条 —— 不触发整层重排。
        if (removed.length > 0) {
          await refresh().catch(() => undefined);
        }
        const only = added.length === 1 ? added[0] : undefined;
        if (only !== undefined) {
          beginItemRename(only, only.split(/[\\/]/).pop() ?? only);
        }
      })();
    },
    [beginItemRename, fetchLoose, refresh, showHint],
  );

  /** F2 改名当前选中的条目（Explorer 的键盘习惯） */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F2') {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input,[contenteditable="true"]')) {
        return; // 正在打字，F2 归输入框
      }
      const first = selectedPathsRef.current.values().next().value as string | undefined;
      if (first === undefined) {
        return;
      }
      event.preventDefault();
      beginItemRename(first, first.split(/[\\/]/).pop() ?? first);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [beginItemRename]);

  useEffect(() => {
    void refresh().catch((error: Error) => showHint(error.message));
    refreshLoose();
  }, [refresh, refreshLoose, showHint]);


  /**
   * **V50：每次显示格子先「自愈」一次布局**（一次挂载只跑一次）。
   *
   * 用户 09-19：「你自己看图片继续重构结构并优化吧」＋「程序需要先计算，务必保证所有的
   * 内容不能重叠」。布局引擎的增量口径是**幂等**的（摆对了就一个都不动 —— 见 `grid.rs`
   * 里那条「加便签不许挪动任何收纳格」的单测），所以每次挂载跑一次是安全的：它只会把
   * 「上一版算法留下的死坐标」收拾干净，**用户自己拖过的格子（`manual`）原地不动**。
   *
   * 不加这一步的话，用户升级之后得自己去点一次「一键整理桌面」才能看到新布局。
   */
  const healedRef = useRef(false);
  useEffect(() => {
    if (!isTauri() || healedRef.current) {
      return;
    }
    healedRef.current = true;
    void ipc
      .gridRelayout()
      .then(() => refresh())
      .catch(() => undefined);
  }, [refresh]);

  // —— 登记对账（V37：只校验存在性） ——
  //
  // 格子内容是「登记过的桌面文件」：用户在资源管理器里把文件改名 / 删掉后，
  // 这里对账（`grid_desktop_sync` → `list_live_items`）会把失效登记清掉，
  // 免得格子里留一个点不动的幽灵图标。
  // **不自动把新文件收进格子** —— 收录只发生在用户点「一键整理」或手动拖入时。

  /** 对账一次并按需刷新（有变化才重渲染，避免无谓的 DOM 抖动） */
  const syncDesktop = useCallback(async (): Promise<void> => {
    const report = await ipc.gridDesktopSync();
    if (report.itemsAdded > 0 || report.pruned > 0) {
      await refresh();
    }
    // 「未归类」竖条跟着桌面根目录走（很便宜，一次扫描）；
    // 新文件要播报 + 让竖条新占的宽把格子挤开（V84，见 fetchLoose 的注释）
    await fetchLoose(true);
  }, [fetchLoose, refresh]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const tick = (): void => {
      // 窗口隐藏（挂件收起）时 webview 仍在运行，别白白扫盘
      if (document.visibilityState !== 'visible') {
        return;
      }
      void syncDesktop().catch(() => undefined);
    };
    // V33：15 秒一次（原 5 秒过于频繁，且对账后新增条目会让格子内容频繁跳动）
    const timer = window.setInterval(tick, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [syncDesktop]);

  // 挂件窗隐藏后再显示不会重新挂载，这里只在窗口创建时读一次桌面接管态。
  //
  // V38 起「整理桌面 = 接管呈现」：整理会一次性把原生桌面图标交给格子层代管，
  // 否则桌面与格子各显示一份，就是用户说的「相当于桌面又两个相同的内容」。
  // 旧的 `gridDesktopIconsGet` 只能报「现在可见吗」，分不出「用户选了接管」还是
  // 「想接管但没藏成」—— 后者必须如实告知，所以改用 `gridTakeoverGet`。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    // V40：这个状态必须**说实话**，所以不再只在挂载时读一次 —— 接管态随时会被系统 /
    // 第三方桌面工具改掉（后端的自愈会在 3 秒内纠正，而界面上那句「已隐藏」如果不复查
    // 就会一直骗人）。提示只在第一次读到时给，免得每 30 秒刷一句。
    let announced = false;
    const sync = (): void => {
      void ipc
        .gridTakeoverGet()
        .then((state) => {
          setTakeover(state);
          if (announced) {
            return;
          }
          announced = true;
          if (state.enabled && state.iconsVisible) {
            showHint('桌面图标没能自动隐藏（多由第三方桌面工具引起），格子与原图标会同时显示');
          } else if (state.enabled) {
            showHint('桌面已由格子接管：原生图标已隐藏，收起挂件即恢复');
          }
        })
        .catch(() => undefined);
    };
    sync();
    const timer = window.setInterval(sync, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [showHint]);

  // —— 桌面整理内容收起态（V44.3）：挂载时按后端 `engaged` 初始化，并监听托盘切换 ——
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    // ⚠️ V79 顺序很重要：**先注册监听，再查一次状态**。
    // 反过来的话，「查询在途时后端刚好广播了一次」就会丢 —— 于是界面停在初值上，
    // 而初值是「收起」，用户就会看到一个收起不了的（或打不开的）桌面。
    // 先监听后查询 + 后端每条路都广播 = 两个来源互为兜底，任何时序都能收敛。
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        unlisten = await getCurrentWindow().listen('grid:visibility', (event) => {
          setContentHidden(!(event.payload as boolean));
        });
      } catch {
        /* 事件监听失败不影响工具栏使用 */
      }
      // 启动期已接管（overlay_visible=1）→ 内容展开；否则只常驻工具栏。
      // 查询放在监听之后，且以这一份为准（它是唯一真源 `overlay_visible` 的快照）。
      if (cancelled) {
        return;
      }
      try {
        const status = await ipc.gridOverlayStatus();
        setContentHidden(!status.engaged);
      } catch {
        /* 查不到就保持「收起」—— 用户仍可从工具栏点「开启桌面整理」 */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // —— 健康监控（V32）：心跳 + 故障自捕获 ——

  // 心跳：每 10s 向 Rust 报一次「JS 还活着」。
  //
  // V33 修正：心跳**只作诊断记录**，不再触发窗口重建。旧策略是「90 秒没心跳就销毁
  // 重建」，但 WebView2 对贴桌面层的窗口会做后台定时器节流，心跳间隔很容易被拉到
  // 90 秒以上 → 被误判成白屏 → 周期性销毁重建，用户看到的就是「闪一下没了 / 又出来了」。
  // 现在只有「显示后一次心跳都没有」（真正的冷启动白屏）才会重建，见 Rust 轮询线程。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const beat = (): void => {
      void ipc.gridOverlayHeartbeat().catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, 10_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  // 故障自捕获：白屏的根因（JS 异常把 React 树整棵卸掉）此前无据可查。
  // 这里把未捕获错误/Promise 拒绝上报落库，管理页展示、用户截图即可反馈。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const report = (kind: string, detail: unknown): void => {
      const message =
        detail instanceof Error
          ? `${detail.name}: ${detail.message}`
          : typeof detail === 'string'
            ? detail
            : String(detail);
      void ipc.gridOverlayFault(`[${kind}] ${message}`).catch(() => undefined);
    };
    const onError = (event: ErrorEvent): void => {
      report('error', event.error ?? event.message);
    };
    const onRejection = (event: PromiseRejectionEvent): void => {
      report('unhandled-rejection', event.reason);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // 透明窗：html/body/**#root** 的白底都会破坏透明（index.css 的 bg-background /
  // index.html 内联 #root{background:#fff} —— V30.1 前格子层白底盖壁纸的真凶）
  useEffect(() => {
    const nodes: HTMLElement[] = [document.documentElement, document.body];
    const root = document.getElementById('root');
    if (root) {
      nodes.push(root);
    }
    const prev = nodes.map((node) => node.style.background);
    for (const node of nodes) {
      node.style.background = 'transparent';
    }
    return () => {
      nodes.forEach((node, index) => {
        node.style.background = prev[index] ?? '';
      });
    };
  }, []);

  // 缩放系数（逻辑 ↔ 物理换算基准）
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().scaleFactor())
      .then((sf) => {
        if (!cancelled && sf > 0) {
          scaleRef.current = sf;
          setScaleFactor(sf);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // —— 系统快捷入口加载（V43）：Dock 的左半部分 ——
  //
  // 可执行目标全部在 Rust 白名单表里（`sys_action_list`），前端只拿 id / 名称 / 图标，
  // 不硬编码任何命令；勾选状态与工作台的快捷入口栏**共用** `settings.quickActionIds`，
  // 在一处增删另一处立刻同步。
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let cancelled = false;
    void ipc
      .sysActionList()
      .then((list) => {
        if (!cancelled) {
          setDockActions(list);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /** Dock 上要画的系统入口（按用户勾选顺序） */
  const dockActionList = React.useMemo(
    () =>
      quickActionIds
        .map((id) => dockActions.find((action) => action.id === id))
        .filter((action): action is SysAction => action !== undefined),
    [quickActionIds, dockActions],
  );

  // —— 命中区域上报：Rust 光标轮询据此切换「穿透 ↔ 可交互」 ——

  /**
   * 桌面上真正要画的格子。
   *
   * V38：**所有格子一律常驻显示，空的也显示**。
   *
   * V34–V37 这里会滤掉「没有条目的收纳格」（当时的理由：空框浮在壁纸上挡视线）。
   * 代价是用户根本找不到规律：v9 迁移把登记清空后，桌面上的格子集体消失，而管理页里
   * 它们还在 —— 用户原话「动不动就不见了 我找不到不见的规律到底是什么」。
   * 空格子现在是**可发现性**的一部分：它就在那儿，里面写着「把桌面文件拖进来」。
   */
  const visibleBoxes = boxes;

  /**
   * 收纳区滚动容器的宽度 —— 收纳区右沿 = 工作台左沿 − 一道缝（`ARRANGE_GAP_X = 24`）。
   *
   * 与 Rust `layout_all_boxes_with` 里的 `right_edge` 同一个定义。
   *
   * ★ **V68 起它不再看便签摆在哪儿**（以前取的是「挂件带左沿 − 一道缝」）。原因：引擎现在会把
   * 挂件**下方**那条带也用起来（用户 09-22：「便签下面还有大量的空间，我们也可以把格子跑过去的」），
   * 那些格子的 `x` **就落在便签列这一条竖带里**，可能一直顶到工作台左沿。容器若还只铺到便签列
   * 左沿，带下空间里的格子会被 `overflow-x-hidden` 直接**裁掉看不见**。
   *
   * 取整屏曾经的问题是「滚动条被右侧常驻工作台盖住」（工作台 z-38 > 这层）—— 现在取的是
   * `工作台左沿 − 一道缝`（不是整屏），滚动条正好落在那道缝里，不会被盖住。
   */
  const contentZoneRight = Math.max(
    MIN_BOX_W,
    window.innerWidth - ARRANGE_MARGIN - WORKSTATION_W - ARRANGE_GAP_X,
  );
  /** 同上，给**事件回调**读（移动处理器要用来夹住拖动的横坐标；用 ref 免得重挂监听） */
  const contentZoneRightRef = useRef(contentZoneRight);
  contentZoneRightRef.current = contentZoneRight;


  /**
   * 区域键（几何或缩放变化才重新上报，避免 mousemove 高频 invoke）。
   *
   * 未归类竖条出现 / 消失、快捷条条目数变化、搜索面板开关 —— 都会改变命中区域，
   * 必须一并进键，否则「光标已经在竖条上」但后端还按旧区域判定穿透，点不动。
   */
  const regionsKey = `${visibleBoxes
    .map((b) => `${b.id}:${b.posX},${b.posY},${b.width},${b.height}`)
    .join('|')}|sf=${scaleFactor}|loose=${
    loose ? `${loose.x},${loose.y},${loose.width},${loose.height}` : ''
  }|dock=${dockLinks.length + dockActionList.length}:${dockCollapsed ? 'c' : 'o'}|panel=${
    sidePanel === null ? '' : `${sidePanel.tab}:${sidePanel.entry?.id ?? ''}`
  }|pw=${panelWide ? 'full' : 'half'}|menu=${[menuBox, menuItem, menuLoose, menuDock]
    .map((m) => (m === null ? '0' : '1'))
    .join('')}|tb=${toolbarOpen ? '1' : '0'}`;

  /**
   * 是否有右键菜单开着。
   *
   * V47 新增：这决定两件事 —— ① 菜单矩形必须进命中区（否则菜单落在格子外的那半边
   * 是穿透的，点不动）；② 菜单开着期间强制整窗可交互。
   */
  const anyMenuOpen =
    menuBox !== null || menuItem !== null || menuLoose !== null || menuDock !== null || menuDesktop !== null;

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    // 内容收起（V44.3）时只报工具栏命中区，其余区域交还原生桌面（点击穿透）。
    const regions: GridRegion[] = contentHidden
      ? []
      : visibleBoxes.map((box) => ({
          x: box.posX * scaleFactor,
          y: box.posY * scaleFactor,
          width: box.width * scaleFactor,
          height: box.height * scaleFactor,
        }));
    // 工具栏与空态卡片常驻可交互（锁定态也要能点「隐藏挂件 / 解锁」，空态要能直接建盒子）；
    // 未归类竖条（V41）/ 快捷条 / 右侧统一面板（V45）渲染出来时同样要可交互
    //
    // V47 补上四个右键菜单 —— 这是「菜单刚弹出来点不动、鼠标离开再回去才行」的根因：
    // 菜单锚在右键落点上，常常有一半探出格子矩形之外，那半边就落在「未上报」的区域里，
    // Rust 判定光标没命中任何交互区 → 把整窗切回穿透 → 点上去直接漏到桌面。
    // 菜单矩形的尺寸只能在渲染后量，所以靠 ref 现取；`regionsKey` 里的 `menu=` 段
    // 保证「菜单开/关」会触发这次重报；`pw=` 同理 —— 面板「半屏 / 铺满」切换后
    // 命中区必须跟着变，否则铺满时右半边点不动、收回半屏后右侧留一块吃点击的死区。
    for (const node of [
      toolbarRef.current,
      emptyRef.current,
      looseRef.current,
      dockRef.current,
      sidePanelRef.current,
      menuRef.current,
      itemMenuRef.current,
      looseMenuRef.current,
      dockMenuRef.current,
    ]) {
      if (!node) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      regions.push({
        x: rect.left * scaleFactor,
        y: rect.top * scaleFactor,
        width: rect.width * scaleFactor,
        height: rect.height * scaleFactor,
      });
    }
    // V89：接管桌面后，桌面空白区右键必须归 Handy 的菜单（不再穿透给 Explorer 触发借出 / 翻白）。
    // 上报「整窗」命中区，让 Rust 的命中轮询认为光标始终命中 → 窗口始终可交互 → 右键落到根画布
    // 的 onContextMenu，由我们弹原生背景菜单。仅在接管且内容可见时开启；其它情况保持穿透。
    if (takeover?.enabled === true && !contentHidden) {
      regions.push({
        x: 0,
        y: 0,
        width: window.innerWidth * scaleFactor,
        height: window.innerHeight * scaleFactor,
      });
    }
    void ipc.gridOverlayUpdateRegions(regions).catch(() => undefined);
    // regionsKey 已覆盖 boxes / 菜单几何变化；contentHidden / takeover 翻转时要重算命中区
    // （contentHidden=false + 接管态 → 整窗命中区开启，桌面空白右键归 Handy 菜单）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionsKey, scaleFactor, contentHidden, takeover]);

  /**
   * 右键菜单开着期间**强制整窗可交互**（V47）。
   *
   * 上面那条命中区上报走的是 Rust 的 25ms 轮询，天然有一拍延迟；菜单是「点了就要能用」
   * 的东西，不能把可用性押在轮询上。所以这里再显式按住 `gridSetInteractive`，
   * 菜单全部关掉后交还命中轮询（编辑态除外 —— 那是用户自己按下的持续交互意图）。
   */
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    void ipc.gridSetInteractive(anyMenuOpen || editMode).catch(() => undefined);
  }, [anyMenuOpen, editMode]);

  // —— 布局交互（mousemove 全局监听 + mouseup 落库） ——

  const persistBoxGeometry = useCallback(
    (boxId: number): void => {
      const box = boxesRef.current.find((b) => b.id === boxId);
      if (!box) {
        return;
      }
      // V49：格子**不许叠在别人身上**（用户 09-19：「务必保证所有的内容不能重叠，
      // 可以有滚动条 但是不能图标重叠」）。手工把格子拖到别人身上时，落库后立刻跑一次
      // 「增量补齐」布局 —— 布局只安置「没落位」的格子（重叠 / 越界 / 侵入左侧竖条），
      // 所以它只会把**这一格**挪到最近的合法列位，用户摆得合法的那次拖动完全不受影响。
      const clash = boxesRef.current.some((other) => {
        if (other.id === box.id) {
          return false;
        }
        return (
          box.posX < other.posX + other.width &&
          other.posX < box.posX + box.width &&
          box.posY < other.posY + other.height &&
          other.posY < box.posY + box.height
        );
      });
      void ipc
        .gridBoxUpsert({
          boxId: box.id,
          posX: box.posX,
          posY: box.posY,
          width: box.width,
          height: box.height,
          // V50：这是**用户自己拖 / 拉**的结果 —— 打上「手工摆过」标记，此后普通整理
          // 不再把它对齐回列网格（引擎摆过的一律重新对齐，见 grid.rs 的 layout_all_boxes）。
          manual: true,
        })
        .then(() => {
          if (!clash) {
            return;
          }
          return ipc
            .gridRelayout()
            .then(() => refresh())
            .catch(() => undefined);
        })
        .catch((error: Error) => showHint(error.message));
    },
    [refresh, showHint],
  );

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }
      const dx = event.clientX - interaction.startX;
      const dy = event.clientY - interaction.startY;
      setBoxes((prev) =>
        prev.map((box) => {
          if (box.id !== interaction.boxId) {
            return box;
          }
          if (interaction.kind === 'move') {
            let nextX = Math.max(interaction.origX + dx, 0);
            let nextY = Math.max(interaction.origY + dy, 0);
            // V55：吸附对齐 —— 拖动格子时，边缘接近其他格子边缘自动吸附
            const SNAP_THRESHOLD = 8;
            const guides = { vertical: [] as number[], horizontal: [] as number[] };
            const boxW = box.width;
            const boxH = box.height;
            for (const other of prev) {
              if (other.id === box.id) continue;
              const otherLeft = other.posX;
              const otherRight = other.posX + other.width;
              const otherTop = other.posY;
              const otherBottom = other.posY + other.height;
              const otherCenterX = other.posX + other.width / 2;
              const otherCenterY = other.posY + other.height / 2;
              const myLeft = nextX;
              const myRight = nextX + boxW;
              const myTop = nextY;
              const myBottom = nextY + boxH;
              const myCenterX = nextX + boxW / 2;
              const myCenterY = nextY + boxH / 2;

              // 垂直参考线：左边对齐、右边对齐、居中对齐
              if (Math.abs(myLeft - otherLeft) < SNAP_THRESHOLD) {
                nextX = otherLeft;
                guides.vertical.push(otherLeft);
              } else if (Math.abs(myLeft - otherRight) < SNAP_THRESHOLD) {
                nextX = otherRight;
                guides.vertical.push(otherRight);
              } else if (Math.abs(myRight - otherRight) < SNAP_THRESHOLD) {
                nextX = otherRight - boxW;
                guides.vertical.push(otherRight);
              } else if (Math.abs(myRight - otherLeft) < SNAP_THRESHOLD) {
                nextX = otherLeft - boxW;
                guides.vertical.push(otherLeft);
              } else if (Math.abs(myCenterX - otherCenterX) < SNAP_THRESHOLD) {
                nextX = otherCenterX - boxW / 2;
                guides.vertical.push(otherCenterX);
              }

              // 水平参考线：上边对齐、下边对齐、居中对齐
              if (Math.abs(myTop - otherTop) < SNAP_THRESHOLD) {
                nextY = otherTop;
                guides.horizontal.push(otherTop);
              } else if (Math.abs(myTop - otherBottom) < SNAP_THRESHOLD) {
                nextY = otherBottom;
                guides.horizontal.push(otherBottom);
              } else if (Math.abs(myBottom - otherBottom) < SNAP_THRESHOLD) {
                nextY = otherBottom - boxH;
                guides.horizontal.push(otherBottom);
              } else if (Math.abs(myBottom - otherTop) < SNAP_THRESHOLD) {
                nextY = otherTop - boxH;
                guides.horizontal.push(otherTop);
              } else if (Math.abs(myCenterY - otherCenterY) < SNAP_THRESHOLD) {
                nextY = otherCenterY - boxH / 2;
                guides.horizontal.push(otherCenterY);
              }
            }
            // V63：收纳格**不许被拖出收纳区** —— 那一块在滚动容器之外，会被裁掉看不见
            // （Rust 侧 `needs_placement` 判据⑤ 早就不许格子跨进挂件带，这里让拖动与引擎
            // 同口径，免得「拖过去看着没事、一整理才弹回来」）。便签不受限：它本来就住在
            // 容器外面、自己那一列里。
            if (box.kind !== 'note') {
              const maxX = Math.max(0, contentZoneRightRef.current - boxW);
              nextX = Math.min(Math.max(nextX, 0), maxX);
            }
            setSnapGuides(guides);
            return {
              ...box,
              posX: nextX,
              posY: nextY,
            };
          }
          // 缩放：按手柄方向决定动哪几条边。
          // 拉左边 / 上边时，**原点要跟着走**（盒子是「往左长」而不是「往右缩」），
          // 且先把宽高夹到下限、再反推原点，否则拖到最小尺寸后原点会持续滑动。
          const edge = interaction.edge ?? 'se';
          let nextX = interaction.origX;
          let nextY = interaction.origY;
          let nextW = interaction.origW;
          let nextH = interaction.origH;
          if (edge.includes('e')) {
            nextW = Math.max(interaction.origW + dx, MIN_BOX_W);
          }
          if (edge.includes('s')) {
            nextH = Math.max(interaction.origH + dy, MIN_BOX_H);
          }
          if (edge.includes('w')) {
            nextW = Math.max(interaction.origW - dx, MIN_BOX_W);
            nextX = interaction.origX + (interaction.origW - nextW);
          }
          if (edge.includes('n')) {
            nextH = Math.max(interaction.origH - dy, MIN_BOX_H);
            nextY = interaction.origY + (interaction.origH - nextH);
          }
          return {
            ...box,
            posX: Math.max(nextX, 0),
            posY: Math.max(nextY, 0),
            width: nextW,
            height: nextH,
          };
        }),
      );
    };
    const onUp = (): void => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }
      interactionRef.current = null;
      setSnapGuides({ vertical: [], horizontal: [] });
      // 交还穿透控制（光标若仍在盒子内，轮询线程会立即恢复可交互）
      void ipc.gridSetInteractive(false).catch(() => undefined);
      // V56：**没真的动过就不要落库**。
      //
      // 拖动现在从「格子任意位置」都能起手（见下面 section 的 onMouseDown），于是
      // 「单击一下格子空白处」也会走完 onUp。若无条件 `persistBoxGeometry`，
      // 一次单击就会把这一格标成 `manual`（用户手工摆过）—— 此后引擎再也不自动对齐它。
      // 桌面上随手点几下，全桌格子就都成了 manual，整理等于失效。
      const target = boxesRef.current.find((box) => box.id === interaction.boxId);
      const movedOrResized =
        target !== undefined &&
        (target.posX !== interaction.origX ||
          target.posY !== interaction.origY ||
          target.width !== interaction.origW ||
          target.height !== interaction.origH);
      if (!movedOrResized) {
        return;
      }
      // 手动缩放过挂件 → 记录「此时的内容自然高度」，自动撑高先让位（见 autoHeightBlockedRef）
      if (interaction.kind === 'resize') {
        if (target && target.kind === 'note') {
          const natural = lastNaturalRef.current.get(target.id);
          if (natural !== undefined) {
            autoHeightBlockedRef.current.set(target.id, natural);
          }
        }
      }
      persistBoxGeometry(interaction.boxId);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [persistBoxGeometry]);

  /**
   * 把被操作的格子提到最上层。
   *
   * 格子是绝对定位、可以互相叠的（左起流布局 + 手动拖动），叠起来之后**下面那个
   * 就点不到了** —— 所以每次开始拖 / 拉之前先把它抬起来（`sort` 取全表最大值 + 1）。
   * 只在「交互开始」时抬，不做成「点一下就抬」：后者会让每次单击都写一次数据库。
   */
  const raiseBox = useCallback((box: GridBox): void => {
    const list = boxesRef.current;
    const maxSort = list.reduce((acc, item) => Math.max(acc, item.sort), 0);
    if (box.sort >= maxSort) {
      return; // 已经在最上层
    }
    const nextSort = maxSort + 1;
    setBoxes((prev) =>
      prev.map((item) => (item.id === box.id ? { ...item, sort: nextSort } : item)),
    );
    void ipc.gridBoxUpsert({ boxId: box.id, sort: nextSort }).catch(() => undefined);
  }, []);

  const startMove = useCallback(
    (event: React.MouseEvent, box: GridBox): void => {
      event.preventDefault();
      // V56：标题栏与「格子空白处」两个 handler 都会走到这里（事件冒泡），
      // stopPropagation 保证一次按下只起一次拖动 —— 否则 raiseBox / 起拖会各跑两遍。
      event.stopPropagation();
      raiseBox(box);
      interactionRef.current = {
        kind: 'move',
        boxId: box.id,
        edge: null,
        startX: event.clientX,
        startY: event.clientY,
        origX: box.posX,
        origY: box.posY,
        origW: box.width,
        origH: box.height,
      };
      // 拖拽期显式保持可交互（光标甩出盒子也不被切回穿透）
      void ipc.gridSetInteractive(true).catch(() => undefined);
    },
    [raiseBox],
  );

  const startResize = useCallback(
    (event: React.MouseEvent, box: GridBox, edge: ResizeEdge): void => {
      if (!editMode) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      raiseBox(box);
      interactionRef.current = {
        kind: 'resize',
        boxId: box.id,
        edge,
        startX: event.clientX,
        startY: event.clientY,
        origX: box.posX,
        origY: box.posY,
        origW: box.width,
        origH: box.height,
      };
      void ipc.gridSetInteractive(true).catch(() => undefined);
    },
    [editMode, raiseBox],
  );

  // —— 重命名（双击标题，编辑态） ——

  const beginRename = useCallback(
    (box: GridBox): void => {
      setRenamingId(box.id);
      setRenameDraft(box.name);
    },
    [],
  );

  const commitRename = useCallback((): void => {
    const id = renamingId;
    const name = renameDraft.trim();
    setRenamingId(null);
    if (id === null || name === '') {
      return;
    }
    void ipc
      .gridBoxUpsert({ boxId: id, name })
      .then((updated) => {
        setBoxes((prev) =>
          prev.map((box) => (box.id === updated.id ? { ...box, name: updated.name } : box)),
        );
      })
      .catch((error: Error) => showHint(error.message));
  }, [renamingId, renameDraft, showHint]);

  // —— 条目：打开（原文件）与移除（仅引用） ——

  const openItem = useCallback(
    (item: GridItem): void => {
      void ipc.gridOpenPath(item.filePath).catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  /** 在资源管理器中定位条目（V41 条目右键「打开文件位置」——原生右键里最高频的一项） */
  const revealItem = useCallback(
    (path: string): void => {
      void ipc.gridRevealPath(path).catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  /**
   * 把条目移出格子：**只删登记**（文件不动），它随即回到左侧「未归类」竖条。
   *
   * V41 用户原话：「图标和文件等移除格子后并没有回到桌面上呢？」—— 根因是移出后
   * 条目处于「没登记、原生图标又被接管隐藏」的真空态。现在移出 = 回到未归类竖条，
   * 看得见、点得开，再想要格子还可以拖回去。
   */
  const removeItem = useCallback(
    (item: GridItem): void => {
      void ipc
        .gridItemDelete(item.id)
        .then(() => {
          setItems((prev) => ({
            ...prev,
            [item.boxId]: (prev[item.boxId] ?? []).filter((i) => i.id !== item.id),
          }));
          refreshLoose();
          // V66：条目少了 → 该格子该变矮，重排一次
          relayoutSoon();
          showHint(`已移出格子：${item.displayName}（回到左侧「未归类」竖条）`);
        })
        .catch((error: Error) => showHint(error.message));
    },
    [refreshLoose, relayoutSoon, showHint],
  );

  const addItem = useCallback(
    (boxId: number, filePath: string): void => {
      void ipc
        .gridItemAdd(boxId, filePath)
        .then((item) => {
          setItems((prev) => ({ ...prev, [boxId]: [...(prev[boxId] ?? []), item] }));
          refreshLoose();
          // V66：条目多了 → 该格子该长高，重排一次（否则新条目挤在旧尺寸里出滚动条）
          relayoutSoon();
          showHint(`已加入格子：${item.displayName}（文件仍在桌面原位）`);
        })
        .catch((error: Error) => showHint(error.message));
    },
    [refreshLoose, relayoutSoon, showHint],
  );

  // —— 桌面快捷条（V42） ——

  /**
   * 往快捷条里加一条（幂等：同一个值只留一条）。
   *
   * 数据落在**工作台那份** quicklinks（`localStorage`，两个窗口同 origin 共用），
   * 所以「拖进快捷条」与「在工作台里加快捷入口」是同一件事的两种入口。
   */
  const addDockLink = useCallback(
    (name: string, value: string): void => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return;
      }
      setDockLinks((prev) => {
        if (prev.some((link) => link.value === trimmed)) {
          showHint(`快捷条里已经有「${name}」了`);
          return prev;
        }
        const next: QuickLink[] = [
          ...prev,
          {
            id: newQuickLinkId(),
            name,
            type: detectQuickLinkType(trimmed),
            value: trimmed,
            createdAt: Date.now(),
          },
        ];
        saveQuickLinks(next);
        showHint(`已加入快捷条：${name}（点一下即可打开）`);
        return next;
      });
    },
    [showHint],
  );

  /** 从快捷条移除一条（只删快捷方式，不碰文件） */
    const removeDockLink = useCallback((id: string): void => {
    setDockLinks((prev) => {
      const next = prev.filter((link) => link.id !== id);
      saveQuickLinks(next);
      window.dispatchEvent(new Event('handy:quicklinks'));
      return next;
    });
  }, []);

  /** 打开快捷条上的条目：网址走系统默认浏览器，本地路径走默认程序 */
  const openDockLink = useCallback(
    (link: QuickLink): void => {
      const task = link.type === 'url' ? ipc.shellOpen(link.value) : ipc.gridOpenPath(link.value);
      void task.catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  /** 快捷条矩形是否命中（逻辑像素）—— 原生文件拖放的落点判定要用 */
  const hitDock = useCallback((logicalX: number, logicalY: number): boolean => {
    const node = dockRef.current;
    if (node === null) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return (
      logicalX >= rect.left && logicalX <= rect.right && logicalY >= rect.top && logicalY <= rect.bottom
    );
  }, []);

  // —— 桌面右侧统一面板（V45） ——

  /** 打开面板（指定页签，可顺带直接打开一项）；已经开着时按需切页签 / 换项 */
  const openPanel = useCallback((tab: SidePanelTab, entry: PanelEntry | null = null): void => {
    setSidePanel({ tab, entry });
  }, []);

  const closePanel = useCallback((): void => {
    setSidePanel(null);
  }, []);

  /**
   * 按「导航目标」在面板里打开一项（`module:<id>` / 命令 id）。
   *
   * 视图状态是每窗口一份的（挂件窗改不了主窗口的 store）。有界面的目标一律**在桌面面板
   * 里就地打开**（用户：「我在桌面上就能完成所有的操作，不需要调出一个窗口去找工具」）；
   * 只有面板开不了的（动作式命令，没有界面）才退回 Rust `desktop_open_view` 那条老路
   * （show 主窗 + `handy:navigate`）。
   */
  const openTarget = useCallback(
    (target: string): void => {
      const moduleId = target.startsWith('module:') ? target.slice('module:'.length) : null;
      if (moduleId !== null) {
        const mod = registry.enabled().find((item) => item.id === moduleId);
        if (mod?.loadView !== undefined) {
          openPanel('tools', {
            id: target,
            name: mod.name,
            description: mod.description,
            kind: 'module',
            icon: mod.icon,
            load: mod.loadView as PanelEntry['load'],
          });
          return;
        }
      } else {
        const command = registry.findCommand(target);
        if (command?.load !== undefined) {
          openPanel('tools', {
            id: command.id,
            name: command.name,
            description: command.description,
            kind: 'tool',
            ...(command.category !== undefined ? { category: command.category } : {}),
            ...(command.icon !== undefined ? { icon: command.icon } : {}),
            load: command.load as PanelEntry['load'],
          });
          return;
        }
      }
      void ipc.desktopOpenView(target).catch((error: Error) => showHint(error.message));
    },
    [openPanel, showHint],
  );

  /**
   * 用输入框填写的路径添加条目（拖放之外的第二条入口）。
   * 便于键盘操作、沙箱环境，以及从资源管理器复制路径的场景。
   */
  const commitAddPath = useCallback(
    (boxId: number, rawPath: string): void => {
      // 兼容从资源管理器复制的带引号路径
      const path = rawPath.trim().replace(/^"(.*)"$/, '$1');
      setAddingBoxId(null);
      setAddPathDraft('');
      if (path.length === 0) {
        return;
      }
      addItem(boxId, path);
    },
    [addItem],
  );

  /** 打开「填路径」输入框 */
  const beginAddPath = useCallback((boxId: number): void => {
    setAddingBoxId(boxId);
  }, []);

  // —— 条目跨格子拖拽（对标腾讯桌面整理：图标拖着走，只改引用归属） ——

  /** 条目拖进目标格子：改引用归属，本地两格列表同步增删 */
  const moveItem = useCallback(
    (drag: ItemDrag, targetBoxId: number): void => {
      if (drag.fromBoxId === targetBoxId) {
        return; // 同格拖放 = 无操作
      }
      void ipc
        .gridItemMove(drag.itemId, targetBoxId)
        .then(() => {
          setItems((prev) => {
            const source = (prev[drag.fromBoxId] ?? []).filter((i) => i.id !== drag.itemId);
            const dragged = (prev[drag.fromBoxId] ?? []).find((i) => i.id === drag.itemId);
            if (!dragged) {
              return prev;
            }
            const target = [...(prev[targetBoxId] ?? []), { ...dragged, boxId: targetBoxId }];
            return { ...prev, [drag.fromBoxId]: source, [targetBoxId]: target };
          });
          // V66：两个格子的条目数都变了（一个少一个多）→ 重算尺寸
          relayoutSoon();
        })
        .catch((error: Error) => showHint(error.message));
    },
    [relayoutSoon, showHint],
  );

  // —— 内部拖拽（V59）：指针拖拽 —— 根因见文件头 `DRAG_THRESHOLD` 上方的说明 ——

  /** 进行中的指针拖拽会话（`null` = 没有按下 / 已经结束） */
  const dragSessionRef = useRef<DragSession | null>(null);
  /** 跟随光标的拖拽预览节点（位置用直接改 `style` 的方式更新，不走 React 重渲染） */
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  /** 拖拽预览的内容；`null` = 不显示 */
  const [dragGhost, setDragGhost] = useState<{ label: string; path: string } | null>(null);

  /**
   * 记下一个「可能成为拖拽」的会话。
   *
   * ⚠️ 这里**只是按下**，还没有进入拖拽态：条目的 `onMouseDown` 上同时挂着双击打开文件，
   * 若按下即拖拽，双击会被抢掉。真正的拖拽在指针越过 [`DRAG_THRESHOLD`] 时才由
   * 主循环启动（见下面的 `mousemove`）。
   */
  const beginDragSession = useCallback(
    (seed: { item: GridItem | null; loose: LooseEntry | null }, event: React.MouseEvent): void => {
      if (event.button !== 0) {
        return;
      }
      dragSessionRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        cancelled: false,
        item: seed.item,
        loose: seed.loose,
        // V86：修饰键在按下那一刻定格（松手时按它解释「选择点击」）；
        // batch 在越过阈值那一刻才算（要用最新的选中集合）。
        mods: { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey },
        batch: [],
      };
      // ⚠️ 按下就显式保持可交互，**不能等越过阈值再做**：挂件窗平时是 `ignore_cursor_events`
      // 穿透态，靠 Rust 的光标轮询在「指针进入盒子矩形」时临时开放。若指针在阈值内就滑出了
      // 所有命中区，轮询会把窗口切回穿透 —— 那一刻之后 `mousemove` 全部落到下层桌面，
      // 我们再也收不到，这次拖拽就**卡死在原地**。
      // （盒子拖动 `startMove` 用的是同一句话，已被用户验证。）
      void ipc.gridSetInteractive(true).catch(() => undefined);
    },
    [],
  );

  /** 格子里的条目按下：可能是单击 / 双击 / 拖拽，先记会话 */
  const beginItemDrag = useCallback(
    (item: GridItem, event: React.MouseEvent): void => {
      beginDragSession({ item, loose: null }, event);
    },
    [beginDragSession],
  );

  /** 左侧「未归类」竖条的条目按下：拖进哪个格子就登记进哪个格子 */
  const beginLooseDrag = useCallback(
    (entry: LooseEntry, event: React.MouseEvent): void => {
      beginDragSession({ item: null, loose: entry }, event);
    },
    [beginDragSession],
  );

  /** 收干净全部拖拽态（高亮 / 预览 / 可交互标记）—— 落点执行前、或中途作废时调 */
  const resetDragVisuals = useCallback((): void => {
    itemDragRef.current = null;
    looseDragRef.current = null;
    setItemDragging(false);
    setDropTargetId(null);
    setDockHot(false);
    setDragGhost(null);
    // 交还命中轮询控制（光标若仍在盒子内会立即恢复可交互）
    void ipc.gridSetInteractive(false).catch(() => undefined);
  }, []);

  // —— 文件拖放（来自资源管理器）：drop 落点命中哪个盒子，就把文件登记为该盒子的引用 ——
  //
  // 注意这条路**和上面那套指针拖拽是两回事**：拖的是真实文件，有 `CF_HDROP`，
  // 由 Tauri 的 `onDragDropEvent` 送进来 —— 见 `DRAG_THRESHOLD` 上方的说明。

  /** 逻辑坐标 → 命中的盒子 id（后渲染的盒子优先，即数组尾部在上层） */
  const hitBoxId = useCallback((logicalX: number, logicalY: number): number | null => {
    // V63：收纳区那层滚动容器有位移时，盒子在屏幕上的实际位置 = 桌面坐标 − `scrollTop`
    // （容器左沿为 0，所以 x 不受影响）。传进来的是 `clientY`（屏幕坐标），换算回
    // 「盒子自己的坐标」就要把位移加回去 —— 少了这一句，滚动之后拖放会认错格子。
    const scrollTop = contentScrollRef.current?.scrollTop ?? 0;
    const logicalYInCanvas = logicalY + scrollTop;
    const list = boxesRef.current;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const box = list[i];
      if (!box) {
        continue;
      }
      if (
        logicalX >= box.posX &&
        logicalX <= box.posX + box.width &&
        logicalYInCanvas >= box.posY &&
        logicalYInCanvas <= box.posY + box.height
      ) {
        return box.id;
      }
    }
    return null;
  }, []);

  /**
   * **指针拖拽主循环**（V59）：`mousemove` 算落点、`mouseup` 执行动作。
   *
   * 监听挂在 `window` 上而不是挂在被拖的元素上：指针会频繁跨出那个条目、跨出格子、
   * 甚至掠过别的盒子 —— 挂元素上必然中途丢事件。盒子拖动（`startMove`）用的是同一套办法，
   * 已被用户验证过可用。
   *
   * 常驻挂监听（而不是拖着才挂）：拖拽起点是「某个条目的 `mousedown`」，那是个普通事件
   * 回调，没法从那里安全地挂全局监听。代价只是每个 `mousemove` 一次 `null` 判断。
   */
  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const session = dragSessionRef.current;
      if (session === null) {
        return;
      }
      session.x = event.clientX;
      session.y = event.clientY;
      if (!session.active) {
        const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
        if (moved < DRAG_THRESHOLD) {
          return;
        }
        // 越过阈值 —— 到这一刻才是真的在拖：
        // 进入拖拽态（根画布转可交互，由 `beginDragSession` 按下时就已置位）+ 出预览
        session.active = true;
        // V86：多选拖拽 —— 拖的若是**已选中**的一项，整个选中集合一起走
        const sel = selectedPathsRef.current;
        if (session.item !== null) {
          session.batch =
            sel.has(session.item.filePath) && sel.size > 1
              ? [...sel]
              : [session.item.filePath];
        } else if (session.loose !== null) {
          const loosePaths = new Set((looseStateRef.current?.items ?? []).map((e) => e.path));
          session.batch =
            sel.has(session.loose.path) && sel.size > 1
              ? [...sel].filter((p) => loosePaths.has(p))
              : [session.loose.path];
        } else {
          session.batch = [];
        }
        itemDragRef.current =
          session.item === null
            ? null
            : { item: session.item, itemId: session.item.id, fromBoxId: session.item.boxId };
        looseDragRef.current = session.loose;
        setItemDragging(true);
        const ghostPath = session.item?.filePath ?? session.loose?.path ?? '';
        const ghostLabel =
          session.batch.length > 1
            ? `${session.batch.length} 个项目`
            : (session.item?.displayName ?? session.loose?.name ?? '');
        setDragGhost(ghostPath !== '' ? { label: ghostLabel.replace(/\.lnk$/i, ''), path: ghostPath } : null);
      }
      // 预览位置直接改 `style`：每帧都 setState 会把整个挂件层重渲染一遍
      const ghost = dragGhostRef.current;
      if (ghost !== null) {
        ghost.style.transform = `translate3d(${event.clientX + 14}px, ${event.clientY + 14}px, 0)`;
      }
      // 落点判定顺序与原生文件拖放那一套保持一致：快捷入口优先
      const onDock = hitDock(event.clientX, event.clientY);
      setDockHot(onDock);
      setDropTargetId(onDock ? null : hitBoxId(event.clientX, event.clientY));
    };

    const onUp = (event: MouseEvent): void => {
      const session = dragSessionRef.current;
      if (session === null) {
        return;
      }
      dragSessionRef.current = null;
      session.x = event.clientX;
      session.y = event.clientY;
      const { active, cancelled, item, loose: looseEntry, mods, batch } = session;
      resetDragVisuals();
      // 没越过阈值 = 一次点击；按过 Esc = 取消。
      // V86：没取消的点击是一次「选择点击」（对齐原生桌面：Ctrl 点选 / Shift 范围 / 单选）。
      if (!active || cancelled) {
        if (!cancelled && item !== null) {
          const list = itemsRef.current[item.boxId] ?? [];
          const index = list.findIndex((i) => i.id === item.id);
          if (index >= 0) {
            applySelectionClick(item.boxId, index, item.filePath, mods);
          }
        } else if (!cancelled && looseEntry !== null) {
          const list = looseStateRef.current?.items ?? [];
          const index = list.findIndex((e) => e.path === looseEntry.path);
          if (index >= 0) {
            applySelectionClick(-1, index, looseEntry.path, mods);
          }
        }
        return;
      }
      // V86：多选批量操作的路径 → 显示名（快捷入口要展示名字）
      const nameOf = (path: string): string => {
        for (const list of Object.values(itemsRef.current)) {
          const hit = list.find((i) => i.filePath === path);
          if (hit !== undefined) {
            return hit.displayName;
          }
        }
        const looseHit = looseStateRef.current?.items.find((e) => e.path === path);
        return looseHit?.name ?? (path.split(/[\\/]/).pop() ?? path);
      };
      // V86：把 batch 里每条路径换回它的条目对象（批量移动 / 移出用）
      const itemByPath = (path: string): GridItem | null => {
        for (const list of Object.values(itemsRef.current)) {
          const hit = list.find((i) => i.filePath === path);
          if (hit !== undefined) {
            return hit;
          }
        }
        return null;
      };
      if (hitDock(event.clientX, event.clientY)) {
        // 拖到右下角「快捷入口」= 收藏成快捷方式（文件本身不动）；多选 = 整批收藏
        for (const path of batch) {
          addDockLink(nameOf(path), path);
        }
        return;
      }
      const boxId = hitBoxId(event.clientX, event.clientY);
      if (item !== null) {
        // 落在任何格子之外 = 移出格子 → 自动回到左侧「未归类」竖条
        // （用户 V41 原话：「用户直接从格子里面移除自动规划到不整理的部分即可」）
        if (boxId === null) {
          for (const path of batch) {
            const it = itemByPath(path);
            if (it !== null) {
              removeItem(it);
            }
          }
        } else {
          for (const path of batch) {
            const it = itemByPath(path) ?? item;
            moveItem({ item: it, itemId: it.id, fromBoxId: it.boxId }, boxId);
          }
        }
        // 移动 / 移出之后选中集合已过时，清掉（对齐原生：拖走就不再保持选中）
        selectedPathsRef.current = new Set();
        setSelectedPaths(selectedPathsRef.current);
      } else if (looseEntry !== null && boxId !== null) {
        for (const path of batch) {
          addItem(boxId, path);
        }
        selectedPathsRef.current = new Set();
        setSelectedPaths(selectedPathsRef.current);
      }
      // 竖条条目落在空白处 = 它本来就在竖条里，什么都不用做
    };

    /**
     * 指针移出窗口时 `mouseup` 收不到 —— 会话必须作废，否则挂件层会永久卡在
     * 「可交互 + 拖拽中」的状态（那正是 V48 注释里担心的脏状态）。
     */
    const onAbort = (): void => {
      if (dragSessionRef.current === null) {
        return;
      }
      dragSessionRef.current = null;
      resetDragVisuals();
    };

    /** 拖拽中按 Esc = 取消本次拖拽；没在拖拽时按 Esc = 清除选中（对齐原生桌面） */
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (dragSessionRef.current !== null) {
          dragSessionRef.current.cancelled = true;
        } else if (selectedPathsRef.current.size > 0) {
          selectedPathsRef.current = new Set();
          setSelectedPaths(selectedPathsRef.current);
        }
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    document.documentElement.addEventListener('mouseleave', onAbort);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
      document.documentElement.removeEventListener('mouseleave', onAbort);
    };
  }, [addDockLink, addItem, applySelectionClick, hitBoxId, hitDock, moveItem, removeItem, resetDragVisuals]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const fn = await getCurrentWebview().onDragDropEvent((event) => {
          // 挂件内部正在拖条目（指针拖拽）：让路，避免系统拖放事件把状态搅乱
          if (itemDragRef.current !== null || looseDragRef.current !== null) {
            return;
          }
          const payload = event.payload;
          const sf = scaleRef.current || 1;
          // 'leave' 不带坐标，先处理掉（否则下面取 position 会被类型收窄拦住）
          if (payload.type === 'leave') {
            setDockHot(false);
            setDropTargetId(null);
            return;
          }
          // 物理像素（相对窗口）→ 逻辑像素后命中测试
          const lx = payload.position.x / sf;
          const ly = payload.position.y / sf;
          // 快捷条优先判定（V42）：它是「收进快捷方式」的落点 ——
          // 用户原话「把桌面图标拖进来归纳到里面」
          const onDock = hitDock(lx, ly);
          if (payload.type === 'over') {
            setDockHot(onDock);
            setDropTargetId(onDock ? null : hitBoxId(lx, ly));
          } else {
            setDockHot(false);
            setDropTargetId(null);
            if (onDock) {
              for (const path of payload.paths) {
                addDockLink(baseNameOf(path), path);
              }
              return;
            }
            const boxId = hitBoxId(lx, ly);
            if (boxId === null) {
              showHint('请把文件拖到挂件盒子上（或拖到快捷条收成快捷方式）');
              return;
            }
            for (const path of payload.paths) {
              addItem(boxId, path);
            }
          }
        });
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      } catch {
        /* 非 Tauri 环境（浏览器调试）：静默忽略 */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [hitBoxId, addItem, addDockLink, hitDock, showHint]);

  // —— 窗口几何：**不在这里管**（V83）——
  //
  // 这里曾经有一段「moved / resized 停稳 500ms → `gridGeometrySet` 写库」的持久化。
  // 它有个致命前提：`scaleFactor` 是**挂载时取一次**的。接上第二块屏 / 改系统缩放后，
  // 系统会移动或改掉我们的窗口尺寸（触发 `resized`），那次换算却还在用过期的 DPI
  // —— 于是把**错值**写进 `grid_meta.overlay_geometry`，而后端开窗是「DB 优先」：
  // 窗口尺寸从此**永久锁死**。用户 09-28 的双屏截图就是这么来的
  // （内容全挤在 1138×608 的角落里，屏幕右侧近 800px、下方 400 多 px 全空）。
  //
  // 现在几何完全由 Rust 侧实时决定（`commands::grid::sync_overlay_bounds`：
  // 严格等于**当前主显示器工作区**，开窗时对齐 + 轮询线程每 1 秒复核），前端只负责
  // 收到 `grid:bounds-changed` 后重排一次。
  //
  // ⚠️ **不要再把几何写回数据库**：窗口是 `resizable(false)` + `decorations(false)`，
  // 用户没有任何调整它的途径 —— 持久化它只有害处。（Rust 侧连那条历史脏数据都清了：
  // `drop_legacy_geometry`。）

  // V83：显示器配置变了 —— Rust 把窗口贴回新的主显示器工作区后广播这条，这里重排一次
  // 让格子立刻铺满新的可用区。没有它的话，用户插上/拔掉外接屏后得自己去点「整理」。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        unlisten = await getCurrentWindow().listen('grid:bounds-changed', () => {
          relayoutSoon();
        });
      } catch {
        /* 监听失败不影响其余功能：下次点「整理」照样按新几何排 */
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [relayoutSoon]);

  // —— 工具栏动作 ——

  /**
   * 解锁**全部**格子 / 全部锁上。
   *
   * ⚠️ V56 修一个由 V52 引入的「静默空操作」：V52 把全局编辑态改成每格独立时留下了一个
   * 兼容壳 `setEditMode(visible)` —— 它传 `true` 时只 `return new Set(prev)`，**什么都没解锁**。
   * 而「新建格子」这条路径正是调它（`focusNewBox`），于是：
   *   · 新加的格子其实**一直是锁着的**，提示却写着「已解锁，可以直接拖动 / 拉大小 / 改名」；
   *   · 下面 `toggleEditMode` 的解锁分支也同样是 `new Set()` —— **只能锁、永远解不开**。
   * 两处叠加，就是用户 09-20 反馈的「桌面上的是不能自己拖动调整的，
   * 只能通过整理自动整理…后面用户不能自己新建格子然后手动拖动整理」。
   *
   * 现在把它拆成两个**名副其实**的接口，谁也不再假装。注意这两个必须定义在 `boxesRef`
   * 之后（解锁全部要读当前格子表）。
   */
  const unlockAllBoxes = useCallback((): void => {
    setUnlockedBoxes(new Set(boxesRef.current.map((box) => box.id)));
    void ipc.gridSetInteractive(true).catch(() => undefined);
  }, []);
  const lockAllBoxes = useCallback((): void => {
    setUnlockedBoxes(new Set());
    void ipc.gridSetInteractive(false).catch(() => undefined);
  }, []);
  /** 只解锁某一个格子（新建 / 「我要摆它」这类明确意图用这个） */
  const unlockBox = useCallback((boxId: number): void => {
    setUnlockedBoxes((prev) => {
      if (prev.has(boxId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(boxId);
      return next;
    });
    void ipc.gridSetInteractive(true).catch(() => undefined);
  }, []);

  const toggleEditMode = useCallback((): void => {
    // V52：编辑态已从「全局」改成「每格独立」，所以这里读的是当前解锁集合：
    // 只要有任意一格是解锁的，就把它们全部锁上；否则解锁全部。
    if (unlockedBoxes.size > 0) {
      lockAllBoxes();
    } else {
      unlockAllBoxes();
    }
  }, [lockAllBoxes, unlockAllBoxes, unlockedBoxes.size]);

  /**
   * 把刚新建的格子「交给用户」：**自动解锁 + 高亮 2.4 秒**。
   *
   * V38 用户原话：「新加的格子默认直接不显示操作，很不方便，应该是新加的自动给我锁定了，
   * 这不合理，我新加的就是要操作的，你直接锁定了还怎么操作」。
   * 新建是明确的「我要摆它」意图，此时还让他去找锁图标解锁，纯属添堵。
   *
   * ⚠️ V56：这里原本调的是 V52 那个空操作兼容壳 ⇒ **新格子其实没解锁**，
   * 所以用户「新建格子然后手动拖动」的第二步永远失败。改调 [`unlockBox`]。
   */
  const focusNewBox = useCallback(
    (boxId: number): void => {
      unlockBox(boxId);
      setFocusBoxId(boxId);
      window.setTimeout(() => {
        setFocusBoxId((prev) => (prev === boxId ? null : prev));
      }, 2400);
    },
    [unlockBox],
  );

  /**
   * 一键整理桌面（V38）：把桌面条目按类型登记进格子，**再用同一套流布局全部重排**。
   *
   * 用户原话：「点击整理桌面后格子是自动创建了，但是很乱，没有计算桌面合理的规划
   * 格子位置 流布局结构，而且桌面原来的图标还在原地没有消失，相当于桌面又两个相同的
   * 内容了」。所以这一版整理做三件事：
   *   1. **按类型分组登记** —— 文件夹 / 快捷方式 / 各类文档各自一格；`.lnk` 必须
   *      参与（V34 曾跳过它，那是因为当时原生图标还在；现在接管了呈现，跳过的话
   *      用户桌上的程序快捷方式会当场没有入口可点）；
   *   2. **全量重排** —— 不只摆新建的格子，`boxesLaidOut` 是所有参与排布的格子，
   *      排序规则是「左起、自上而下、**列宽统一**、碰到便签 / 日历就让开」的流布局；
   *   3. **接管桌面呈现** —— 隐藏原生桌面图标，桌面上只留格子这一份。
   *      ⚠️ V40：以前只有「本次真的登记了新条目」才接管，而桌面早就被登记满时
   *      点整理拿到的是「登记 0 项」⇒ **压根没隐藏图标** —— 用户反馈的
   *      「桌面原图标还存在呢？」就出在这里。现在点整理一律按接管偏好执行；
   *   4. **两个桌面根都扫**（V40）—— 用户桌面 + 公共桌面（`%PUBLIC%\Desktop`，
   *      那批「所有用户」快捷方式以前从来没进过格子）。
   *
   * 全程 **不移动任何文件**（V37 呈现层定下的规矩）。
   */
  const arrangeDesktop = useCallback((): void => {
    showHint('正在整理桌面…');
    void ipc
      .gridAutoArrange()
      .then((report) => refresh().then(() => report))
      .then((report) => {
        // 整理会改登记（快捷方式 / 系统留在左侧竖条，其余进分类格）→ 竖条跟着变
        refreshLoose();
        setTakeover({ enabled: true, iconsVisible: !report.iconsHidden });
        const parts = [
          `扫描 ${report.scanned} 项`,
          `登记 ${report.itemsAdded} 项`,
          `新建 ${report.boxesCreated} 格`,
          `重排 ${report.boxesLaidOut} 格`,
        ];
        if (report.lnkAdded > 0) {
          parts.push(`快捷方式 ${report.lnkAdded} 个`);
        }
        // V43：说清「放开了几个此前被移出的条目」—— 否则用户会以为整理没生效
        if (report.released > 0) {
          parts.push(`放开此前移出 ${report.released} 项`);
        }
        // V39：让用户看得出「按内容调过大小」和「挂件归位」这两件事真的发生了
        if (report.boxesResized > 0) {
          parts.push(`按内容调尺寸 ${report.boxesResized} 格`);
        }
        if (report.widgetsAnchored > 0) {
          parts.push(`挂件归位 ${report.widgetsAnchored} 个`);
        }
        if (report.boxesOverflowed > 0) {
          showHint(
            `桌面空间不够，有 ${report.boxesOverflowed} 个格子没排开（建议减少格子或调小桌面图标）`,
          );
          return;
        }
        showHint(
          report.iconsHidden
            ? `整理完成：${parts.join('、')}；桌面图标已交由格子接管`
            : `整理完成：${parts.join('、')}；本机不支持自动隐藏图标，建议手动切换为接管`,
        );
      })
      .catch((error: Error) => {
        reportOperation('整理桌面', error);
        showHint(error.message);
      });
  }, [refresh, refreshLoose, showHint]);

  const addBox = useCallback((): void => {
    const count = boxesRef.current.length;
    void ipc
      .gridBoxUpsert({
        name: `新格子 ${count + 1}`,
        kind: 'folder',
        // 不指定落点 → 由 Rust 的布局引擎落位（V66：按内容定尺寸 + 列式填满，
        // 不与任何已有格子重叠、也不会跑出桌面外）
        width: 320,
        height: 220,
      })
      .then((created) => {
        setBoxes((prev) => [...prev, created]);
        setItems((prev) => ({ ...prev, [created.id]: [] }));
        focusNewBox(created.id);
        // V66：新建 = 桌面内容变了 → 立刻重算整张布局
        //（用户：「我添加了新的格子你要重新计算每个格子的大小等」）
        relayoutSoon();
        showHint(`已新建收纳格：${created.name} —— 已解锁，可以直接拖动 / 拉大小 / 改名`);
      })
      .catch((error: Error) => {
        reportOperation('新建收纳格', error);
        showHint(error.message);
      });
  }, [focusNewBox, relayoutSoon, showHint]);

  /**
   * 新建挂件（便签 / 日历）—— 桌面上直接可用的轻量小组件。
   *
   * V34 曾按用户要求把同类挂件限成一个；**V35 用户改口**：「便签应该可以添加多个」。
   * 于是这里拆成两条规则：
   *   - **便签可以多个**：按 便签 / 便签 2 / 便签 3… 自动起名，并给一个**不同的默认配色**
   *     （多个便签如果长得一模一样，桌面上根本分不清）——点标题栏的调色盘可随时改；
   *   - **日历仍然只有一个**：日历背后是同一份 `todos`，多开纯粹是重复信息。
   */
  const addNote = useCallback((): void => {
    const sameKind = boxesRef.current.filter((box) => box.kind === 'note').length;
    // 第 1 个叫「便签」，之后顺延编号 —— 名字是给人看的，不该出现「便签 1」
    const name = sameKind === 0 ? '便签' : `便签 ${sameKind + 1}`;
    void ipc
      .gridBoxUpsert({
        name,
        kind: 'note',
        // 轮着给配色，保证相邻两个便签颜色不同
        accent: ACCENT_ORDER[(sameKind % (ACCENT_ORDER.length - 1)) + 1] ?? 'amber',
        width: 260,
        height: 220,
      })
        .then(async (created) => {
          setBoxes((prev) => [...prev, created]);
          setItems((prev) => ({ ...prev, [created.id]: [] }));
          // —— V47：新建后**立刻重排一次**（只归位、不扫描）——
          //
          // 用户原话：「添加便签后这个位置放在这里也不合适，便签的位置需要自动放在
          // 合理的位置上」。根因不是"放得不好"，而是**放的位置从来没被布局碰过**：
          // `gridBoxUpsert` 不给坐标时落默认值 (32,32)，而布局只在一键整理时才跑。
          // 于是新便签正好压在左侧「不整理」竖条那条禁区上。
          try {
            await ipc.gridRelayout();
            await refresh();
          } catch {
            // 重排失败不影响「便签已经建出来」这个事实：留在默认坐标也能用，
            // 用户下次点「一键整理」同样会归位。这里刻意不打扰用户。
          }
          // V56：新建的挂件也要**立刻可调**（与收纳格同一口径）。
          // 之前只有 `addBox` 走 `focusNewBox`，新便签建出来是锁着的 —— 用户 09-20
          // 「新建格子然后手动拖动整理」这条链在第 2 步就断了。
          focusNewBox(created.id);
          showHint(`已新建${created.name}（支持 Markdown，边写边渲染）`);
        })
        .catch((error: Error) => showHint(error.message));
    },
    [focusNewBox, refresh, showHint],
  );

  /** 改格子配色（便签尤其需要：多个便签并存时要一眼分清） */
  const setAccent = useCallback(
    (boxId: number, accent: GridAccent): void => {
      setAccentBoxId(null);
      setBoxes((prev) => prev.map((box) => (box.id === boxId ? { ...box, accent } : box)));
      void ipc.gridBoxUpsert({ boxId, accent }).catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  /**
   * 挂件上报「内容自然高度」→ 把盒子高度调到刚好装下（V35 用户要求：
   * 「日历下面的计划部分可以根据计划条数多少动态扩展高度」）。
   *
   * 三条护栏，缺一不可：
   *   ① 正在拖 / 拉这个格子 → 让位给人；
   *   ② 用户手动定过高度、且内容没变 → 让位给人（见 `autoHeightBlockedRef`）；
   *   ③ 变化小于 8px → 不动（防亚像素抖动来回写库）。
   * 上限取屏幕高度的 70%，免得计划特别多时把格子撑到屏幕外。
   */
  const applyWidgetHeight = useCallback((boxId: number, natural: number): void => {
    lastNaturalRef.current.set(boxId, natural);
    if (interactionRef.current?.boxId === boxId) {
      return;
    }
    const blocked = autoHeightBlockedRef.current.get(boxId);
    if (blocked !== undefined && Math.abs(blocked - natural) < 8) {
      return;
    }
    const box = boxesRef.current.find((item) => item.id === boxId);
    if (!box) {
      return;
    }
    const maxH = Math.max(Math.round(window.innerHeight * 0.7), MIN_BOX_H);
    const target = Math.min(
      Math.max(Math.round(natural + BOX_HEADER_H + BOX_BORDER_H), MIN_BOX_H),
      maxH,
    );
    // V60：日历进工作台之后盒子里只剩便签，**宽度一律不回收** —— 便签可以被用户拉宽
    // （正文跟着换行，那是合理的手工布局）。V49 那条「把日历的宽度收回自然宽度」
    // 随日历盒子一起退场。
    const targetW = box.width;
    const widthChanged = targetW !== box.width;
    if (!widthChanged && Math.abs(target - box.height) < 8) {
      return;
    }
    autoHeightBlockedRef.current.delete(boxId);
    setBoxes((prev) =>
      prev.map((item) =>
        item.id === boxId ? { ...item, height: target, width: targetW } : item,
      ),
    );
    if (heightSaveTimerRef.current !== undefined) {
      window.clearTimeout(heightSaveTimerRef.current);
    }
    heightSaveTimerRef.current = window.setTimeout(() => {
      heightSaveTimerRef.current = undefined;
      void ipc.gridBoxUpsert({ boxId, height: target, width: targetW }).catch(() => undefined);
    }, 400);
  }, []);

  /** 保存挂件数据（便签正文 / 日历配置），失败不弹提示以免打断输入 */
  const saveBoxContent = useCallback((boxId: number, content: string): void => {
    setBoxes((prev) => prev.map((box) => (box.id === boxId ? { ...box, content } : box)));
    void ipc.gridBoxSetContent(boxId, content).catch(() => undefined);
  }, []);

  /** 删除格子（只删格子与它的登记；文件本身从来没被移动过，所以什么都不用恢复） */
  const deleteBox = useCallback(
    (boxId: number): void => {
      void ipc
        .gridBoxDelete(boxId)
        .then(() => {
          setBoxes((prev) => prev.filter((box) => box.id !== boxId));
          setItems((prev) => {
            const next = { ...prev };
            delete next[boxId];
            return next;
          });
          // 该格子的登记全没了 → 条目集体回到左侧「未归类」竖条
          refreshLoose();
          // V66：少了一个格子 → 剩下的重新分布（用户：「添加了新的格子你要重新计算每个格子的大小」）
          relayoutSoon();
        })
        .catch((error: Error) => showHint(error.message));
    },
    [refreshLoose, relayoutSoon, showHint],
  );

  /**
   * 桌面整理内容的「显示 / 隐藏」切换（V44.3）。
   *
   * 隐藏：收起格子 / 未归类 / Dock，恢复原生桌面图标，并顺手关掉右侧统一面板与右键菜单，
   * 避免它们脱离格子孤零零飘在原生桌面上。挂件窗与工具栏**保持显示**。
   * 显示：重新接管桌面呈现（按偏好隐藏原生图标），格子内容回到桌面。
   */
  const toggleOverlay = useCallback((): void => {
    if (contentHidden) {
      void ipc
        .gridOverlayShow()
        .then(() => setContentHidden(false))
        .catch(() => undefined);
    } else {
      setSidePanel(null);
      setMenuBox(null);
      setMenuItem(null);
      setMenuLoose(null);
      setMenuDock(null);
      setMenuDesktop(null);
      void ipc
        .gridOverlayHide()
        .then(() => setContentHidden(true))
        .catch(() => undefined);
    }
  }, [contentHidden]);

  /**
   * 执行一条**桌面背景右键菜单**动作（V60，见 `platform/desktop_menu.rs` 的 [`SUB_ITEMS`]）。
   *
   * 只有三个动作需要前端做（其余四项 Rust 侧就地完成：显示 / 收起整理层、备份 / 还原布局、
   * 打开设置中心）。这三个都复用工作台底栏那排按钮的**同一批函数** —— 菜单不是第二条实现，
   * 只是另一只按在同一批按钮上的手。
   */
  const runDesktopAction = useCallback(
    (action: string): void => {
      // —— 桌面面板动作（V63）——
      // 托盘「打开工具箱」/「设置」、全局快捷键、顶部贴条的工具搜索，全都派到这里，
      // 不再去开独立主窗口（用户：「工具线弹出框就够了吧…没有必要还有一个多一个界面」）。
      // 常量在 Rust `commands/grid.rs`：`PANEL_ACTION_*` / `PANEL_OPEN_PREFIX`。
      if (action === 'panel:toggle-tools') {
        setSidePanel((prev) => {
          if (prev === null) {
            // 显示工具箱 → 抬到当前屏幕最前（V72）
            void ipc.panelRaiseFront();
            return { tab: 'tools', entry: null };
          }
          // 收起工具箱 → 复位成不挡工作的桌面挂件（V72）
          void ipc.panelSettleDesktop();
          return null;
        });
        return;
      }
      if (action === 'panel:tools') {
        openPanel('tools', null);
        // 工具箱快捷调出后应立即可见、可操作（V72）
        void ipc.panelRaiseFront();
        return;
      }
      if (action === 'panel:settings') {
        openPanel('settings', null);
        // 从托盘/快捷键打开设置面板同样应置前（V72）
        void ipc.panelRaiseFront();
        return;
      }
      if (action.startsWith('panel:open:')) {
        openTarget(action.slice('panel:open:'.length));
        // 在面板里直接打开某条目/工具 → 置前（V72）
        void ipc.panelRaiseFront();
        return;
      }

      switch (action) {
        case 'new-box':
          addBox();
          break;
        case 'new-note':
          addNote();
          break;
        case 'arrange':
          arrangeDesktop();
          break;
        default:
          // 菜单项与这里的取值都对不上 → 一定是有一边改了没同步另一边。
          // 不静默吞掉（静默吞掉的表现就是「点了没反应」，最难查）。
          showHint(`未处理的桌面右键动作：${action}`);
      }
    },
    [addBox, addNote, arrangeDesktop, openPanel, openTarget, showHint],
  );

  /**
   * 取一次待办动作并执行。
   *
   * 「取」是 Rust 侧的 `take()` 语义（`grid_take_pending_action`），所以下面两处都调它
   * 也不会重复执行 —— 拿到的第二个 `null` 天然什么都不做：
   *   · **挂载时**：兜住冷启动。`handy.exe --new-box` 时 Rust 在 `setup` 里就发事件了，
   *     那一刻 WebView 还没加载完、监听还没注册，事件**必然丢**，只能靠队列。
   *   · **收到唤醒事件时**：热路径（Handy 已在运行）的即时响应，用户点完马上见效。
   */
  const takeDesktopAction = useCallback((): void => {
    if (!isTauri()) {
      return;
    }
    void ipc
      .gridTakePendingAction()
      .then((action) => {
        if (action !== null) {
          runDesktopAction(action);
        }
      })
      .catch(() => undefined);
  }, [runDesktopAction]);

  // 桌面右键菜单的唤醒事件。用 `getCurrentWindow().listen`（与 `grid:visibility` 同一套），
  // 而不是全局 `listen`：前者在「Rust 用 `emit`（无目标过滤）」和「Rust 改成
  // `emit_to(GRID_LABEL)`」两种写法下都收得到，后者只在头一种下稳妥。
  useEffect(() => {
    takeDesktopAction();
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        unlisten = await getCurrentWindow().listen('handy://desktop-action', () => {
          takeDesktopAction();
        });
      } catch {
        /* 监听失败不影响其余功能：挂载那次取待办仍然有效 */
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [takeDesktopAction]);

  // V81：桌面右键弹的是**系统原生菜单**，Rust 在菜单期间会把桌面暂时还给系统
  // （否则「新建文件夹」建好了也看不见、改名编辑框在隐藏的视图里点不到）。
  // 菜单收起、Rust 收回桌面后广播 `grid:desktop-changed` —— 这里立刻重扫一次：
  // 新建出来的文件必须马上出现在「未归类」竖条里，否则用户只会认为「建了没生效」。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        unlisten = await getCurrentWindow().listen('grid:desktop-changed', () => {
          void syncDesktop();
        });
      } catch {
        /* 监听失败不影响其余功能：周期对账照旧会跑 */
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [syncDesktop]);

  /** 手动对账一次（清掉文件已不存在的失效登记，顺带刷新未归类竖条） */
  const syncNow = useCallback((): void => {
    void ipc
      .gridDesktopSync()
      .then(async (report) => {
        await refresh();
        refreshLoose();
        showHint(
          `已对账 ${report.boxes} 个格子：新增 ${report.itemsAdded} · 清理失效 ${report.pruned}`,
        );
      })
      .catch((error: Error) => showHint(error.message));
  }, [refresh, refreshLoose, showHint]);

  // —— 渲染 ——

  /**
   * 密码存储器（vault）的面板入口（V45）。
   *
   * V45 起 vault 不再是模块，而是**工具箱里的一个工具**（用户：「密码存储建议也作为
   * 工具箱的其中一个工具吧 不要一个独立的工具箱模块」），所以这里按**命令**取；
   * 拿到的仍是同一个 `VaultView`，不存在第二份实现。
   */
  const vaultEntry = useMemo<PanelEntry | null>(() => {
    const command = registry.findCommand('vault');
    if (command === undefined || typeof command.load !== 'function') {
      return null;
    }
    return {
      id: command.id,
      name: command.name,
      description: command.description,
      kind: 'tool',
      ...(command.category !== undefined ? { category: command.category } : {}),
      ...(command.icon !== undefined ? { icon: command.icon } : {}),
      load: command.load as PanelEntry['load'],
    };
  }, []);

  /** 新建一个与模板同款（同尺寸、同配色）的收纳格。 */
  const duplicateBox = useCallback(
    (template: GridBox): void => {
      void ipc
        .gridBoxUpsert({
          name: `${template.name} 副本`,
          kind: 'folder',
          accent: template.accent,
          width: template.width,
          height: template.height,
        })
        .then((created) => {
          setBoxes((prev) => [...prev, created]);
          setItems((prev) => ({ ...prev, [created.id]: [] }));
          showHint(`已新建收纳格：${created.name}`);
        })
        .catch((error: Error) => showHint(error.message));
    },
    [showHint],
  );

  /**
   * 菜单「鼠标离开即消失」（V47）。
   *
   * 用户原话：「按理说这种右键菜单 我鼠标离开菜单区域这个菜单就应消失的，
   * 改了这么多版本这种基本问题都还有」。此前只在「点别处」或 Esc 时才关，
   * 菜单可以一直赖在桌面上。
   *
   * 给 300ms 宽限而不是立刻关：菜单有时贴着格子边缘，鼠标划过一行会短暂离开再回来，
   * 零宽限会显得「手一抖就没了」。
   */
  const menuLeaveTimer = useRef<number | null>(null);
  const cancelMenuLeave = useCallback((): void => {
    if (menuLeaveTimer.current !== null) {
      window.clearTimeout(menuLeaveTimer.current);
      menuLeaveTimer.current = null;
    }
  }, []);
  const scheduleMenuLeave = useCallback(
    (close: () => void): void => {
      cancelMenuLeave();
      menuLeaveTimer.current = window.setTimeout(() => {
        menuLeaveTimer.current = null;
        close();
      }, 300);
    },
    [cancelMenuLeave],
  );
  // 卸载时清掉挂起的关闭定时器，避免对已卸载组件 setState
  useEffect(() => cancelMenuLeave, [cancelMenuLeave]);

  /**
   * 右键菜单的关闭时机（V41：格子菜单 / 条目菜单 / 未归类竖条菜单 / 快捷条菜单共用一套规则）。
   *
   * 注意**不能**只靠「在菜单上 stopPropagation 就完事」：菜单是 React 节点，
   * 而这里挂的是 window 上的原生监听，原生事件照样会冒泡到 window。
   * 所以用 ref 判一下点击是不是落在菜单内部。
   */
  useEffect(() => {
    if (menuBox === null && menuItem === null && menuLoose === null && menuDock === null) {
      return undefined;
    }
    const closeAll = (): void => {
      setMenuBox(null);
      setMenuItem(null);
      setMenuLoose(null);
      setMenuDock(null);
      setMenuDesktop(null);
    };
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      for (const ref of [menuRef, itemMenuRef, looseMenuRef, dockMenuRef]) {
        if (ref.current?.contains(target) === true) {
          return;
        }
      }
      closeAll();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeAll();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuBox, menuItem, menuLoose, menuDock]);

  // 右侧统一面板的 Esc 由 `DesktopSidePanel` 自己处理（先退回列表，再关面板），
  // 这里不再重复挂监听（V45 之前是搜索浮层专属的一段）。

  return (
    <div
      /* ⚠️ 这里**必须**是 `overflow-hidden`，永远不要改成 `overflow-y-auto`（V59 踩过）。
       *
       * 用户 09-21：「桌面可以滚轮上下移动了……只有鼠标移动到图标或者格子上才可以移动，
       * 在桌面空白的地方不能移动」。
       *
       * 根画布是 `fixed inset-0`（高度 = 窗口高度），格子 / 竖条都是它的**绝对定位子元素**
       * —— 绝对定位元素会把自己的溢出算进包含块的**可滚动溢出区**。于是只要有任何一处
       * 子元素比视口高出哪怕十几像素，这一层就变成了**可滚动容器**：
       *   · 空白处 `pointerEvents: 'none'` → 事件穿透到桌面，滚不动（所以那一块正常）；
       *   · 图标 / 格子上恢复了指针事件 → 滚轮冒泡到根画布 → **整个桌面跟着滚**。
       * 这正是用户看到的「只有光标在图标或格子上时整层会动一点」。
       *
       * 盒内滚动是**内容区**的事（`flex-1 min-h-0 overflow-y-auto`），竖条过满是竖条自己的事
       * （见下方竖条的 `overflow-y-auto`）。桌面层本身只负责「把东西画在屏幕上」，
       * 它一旦能滚，用户就永远对不齐自己的桌面。 */
      className="fixed inset-0 select-none overflow-hidden"
      style={{
        // V89：接管桌面后，桌面空白区的右键必须归 Handy 的菜单（不再穿透给 Explorer
        // 触发借出 / 桌面翻白）。接管且内容可见时让整窗可交互；拖拽期间本来就要可交互；
        // 其它情况（没接管 / 内容收起）保持穿透，原生图标与桌面照常可交互。
        pointerEvents:
          itemDragging || (takeover?.enabled === true && !contentHidden)
            ? 'auto'
            : 'none',
      }}
      onContextMenu={(event) => {
        // V87：**桌面 / 格子空白处右键 = 我们自己弹出原生背景菜单**。
        //
        // 之前（V81–V86）这里只是兜底：接管态下右键会**穿透**到被隐藏的原生图标视图，
        // 由 Explorer 自己弹菜单，我们旁听并在菜单期间「把桌面借出去」。那套补丁要赌
        // `#32768` 的类名语义（你这台 Win11 25H2 的新式菜单根本不叫这个名字）、要等
        // 「安静 1.5s」、要 120s 超时兜底 —— 用户看到的仍然是「卡一下 / 要刷新 /
        // 只有第一次成功」。
        //
        // 现在换成 `IShellFolder::CreateViewObject` 给的**背景菜单**：新建 / 粘贴 /
        // 下一个桌面背景 / 显示设置 / 个性化 + 我们注入的 Handy 子菜单 + 全部第三方
        // 扩展，由我们弹、由 Shell 执行。见 `openDesktopBackgroundMenu`。
        //
        // **格子空白处同样走这里** —— 条目与标题栏各自 `stopPropagation`，格子其余
        // 位置的右键会冒泡上来。这正是腾讯的行为：**在格子里右键空白也能新建**。
        event.preventDefault();
        if (event.ctrlKey) {
          // Ctrl + 右键 = Handy 自己的菜单（对齐条目那条约定：Ctrl+右键在 Explorer
          // 里没有任何含义，抢它不改变任何原生行为）
          setMenuDesktop({ x: event.clientX, y: event.clientY });
          return;
        }
        openDesktopBackgroundMenu(event.shiftKey);
      }}
    >
      {/* 拖拽预览（V59）：整个内部拖拽已改成指针拖拽，系统的拖拽预览（那个跟着光标跑的
          半透明图标）在挂件窗里根本不会出现 —— 没有它，拖动全程没有任何反馈。
          位置由主循环直接改 `style.transform`（每帧 setState 会把整层重渲染一遍）。 */}
      {dragGhost !== null && (
        <div
          ref={(node) => {
            dragGhostRef.current = node;
            if (node !== null) {
              const session = dragSessionRef.current;
              if (session !== null) {
                node.style.transform = `translate3d(${session.x + 14}px, ${session.y + 14}px, 0)`;
              }
            }
          }}
          className="pointer-events-none fixed left-0 top-0 z-[95] flex max-w-[220px] items-center gap-2 rounded-lg border border-white/15 bg-neutral-900/90 px-2 py-1.5 shadow-[0_12px_30px_rgba(0,0,0,0.55)] backdrop-blur-md"
        >
          <FileIcon path={dragGhost.path} size={18} />
          <span className="truncate text-[11px] font-medium text-neutral-100">
            {dragGhost.label.replace(/\.lnk$/i, '')}
          </span>
        </div>
      )}
      {/* V55：拖动格子时的对齐参考线 */}
      {!contentHidden && (snapGuides.vertical.length > 0 || snapGuides.horizontal.length > 0) && (
        <svg className="pointer-events-none absolute inset-0 z-[35]" width="100%" height="100%">
          {snapGuides.vertical.map((x, i) => (
            <line key={`v-${i}`} x1={x} y1={0} x2={x} y2={window.innerHeight}
              stroke="rgba(91,140,255,0.5)" strokeWidth="1" strokeDasharray="4 4" />
          ))}
          {snapGuides.horizontal.map((y, i) => (
            <line key={`h-${i}`} x1={0} y1={y} x2={window.innerWidth} y2={y}
              stroke="rgba(91,140,255,0.5)" strokeWidth="1" strokeDasharray="4 4" />
          ))}
        </svg>
      )}
      {/* 盒子画布：每个盒子自身恢复指针事件（外层穿透不继承）。
          V63：收纳格住在一层**可滚动**容器里，挂件（便签）用 `fixed` 挂在容器之外 ——
          于是「格子放不下」时只有收纳区滚动，便签列与左侧竖条纹丝不动。
          容器宽度 = 收纳区右沿（`contentZoneRight`），滚动条正好落在收纳区与便签列之间
          那道缝里，不会压住便签。
          ⚠️ 容器**不带** `pointer-events`（继承根画布的 `none`）：滚轮事件靠盒子的冒泡
          到达它，而空白处照旧穿透到桌面。没有溢出时 `scrollTop` 恒为 0 —— 一切与以前一致。 */}
      {!contentHidden && (
        <div
          ref={contentScrollRef}
          className="absolute left-0 top-0 bottom-0 overflow-y-auto overflow-x-hidden"
          style={{ width: contentZoneRight }}
        >
          {visibleBoxes.map((box) => {
        const boxItems = sortBoxItems(items[box.id] ?? [], boxSortModes[box.id] ?? 'manual');
        const isDropTarget = dropTargetId === box.id;
        const isWidget = box.kind === 'note';
        // V52：每格子独立锁定——shadow 外层 editMode 为本格子是否解锁
        const editMode = unlockedBoxes.has(box.id);
        return (
          <section
            key={box.id}
            style={{
              left: box.posX,
              top: box.posY,
              // V63：**便签（挂件）用 `fixed` 挂出滚动层外**。
              //
              // 盒子整体住在一层 `overflow-y-auto` 容器里（收纳区放不下时滚它）；而便签是
              // 「常驻的一列」，绝不能跟着收纳区一起滚走 —— 所以它在视口上定位（`fixed`
              // 相对视口，而那一层正好铺在视口里，`left/top` 一个像素都不用改）。
              //
              // 固定的不只是视觉效果：`fixed` 元素不参与容器的可滚动溢出区计算，
              // 所以「便签比屏幕高」也不会让收纳区平白多出一截可滚高度。
              position: isWidget ? 'fixed' : undefined,
              // ★ **一律用后端布局引擎算出的高度，任何格子都不例外**（V59 修）。
              //
              // 这里原本是 `height: isWidget ? box.height : undefined` —— 于是**收纳格**
              // 的高度是 auto（由内容决定），而引擎是按「条目数 ÷ 每行列数」估算的。
              // 两者只要不一致就出事，而且是最难看的那种事：
              //   · 前端渲染得比引擎高 → 盒子长出去，**压住下面那个格子**（用户 09-21：
              //     「你看图片中红圈的位置高度方向还是有点重叠」）；
              //   · 同时因为盒子自己长高了，内容区的 `overflow-y-auto` 永远不触发 ——
              //     它跟内容一样高，没有可滚的余量（用户：「我列表展开格子装不下了
              //     应该自动出滚动条哇」）。
              // 切成列表视图时最容易撞上：引擎按图标网格估高（8 个条目 = 2 行），
              // 列表视图是一行一个（8 行），差出一倍还多。
              //
              // 绑定之后：**渲染几何 == 引擎几何**，盒子之间不可能重叠；内容超出时
              // 由内容区滚（见下面的 `flex-1 min-h-0 overflow-y-auto`）。
              width: box.width,
              height: box.height,
              // ⚠️ 这里**不再加 `max-height`**。曾经给挂件加过 `80vh` 的上限，那是在
              // 高度还没绑死、允许 auto 的时候防「一个便签顶穿整个桌面」的。
              // 现在高度就是引擎给的值，而引擎本来就会把格子夹进工作区
              // （`box_height_at` 的 `max_h` + `fit_column_heights` 的列内压缩）——
              // 再压一层上限只会让渲染高度小于引擎高度，又变回「盒子压住下面那个格子」。
              pointerEvents: 'auto',
              // 非编辑态：给卡片铺一层**深色磨砂底**。为什么用内联 style 而不是
              // Tailwind 类：底色要跟着 `accent` 走（7 种组合），内联渐变最直白，
              // 也不必担心 JIT 扫不到动态拼出来的类名。
              //
              // V48：日历格**保留**这层底。日历自己那套主题只画在挂件画布上
              // （见 `CALENDAR_THEMES`），而卡片顶部还有一条标题栏（格子名 / 调色盘 /
              // 删除）—— 浅色主题下标题栏若也变成浅色，白字就看不见了。
              // 深色卡片底 + 浅色日历画布 = 标题栏永远可读，视觉上也是「带标题的卡片」。
              background: editMode ? undefined : cardBackground(box.accent),
            }}
            /* 观感目标（用户原话）：「桌面就是一个大容器，格子就是大容器里面的小容器，
               自然嵌入在桌面上」「像在壁纸上画了一张图」。
               V35 用户又说「背景透明后有点模糊，增加对比度」—— 于是这一版把
               「几乎看不见的浅雾」换成**深色磨砂**：底色确有厚度（前景文字对比度够高），
               但仍透出壁纸；**没有硬边框**，靠「顶部一道极淡的高光 + 大范围柔和外阴影」
               把边缘融进桌面 —— 像贴在壁纸上的一张毛玻璃卡，而不是浮起来的白面板。 */
            className={`absolute flex flex-col overflow-hidden rounded-2xl text-neutral-100 ${
              editMode
                ? 'border border-dashed bg-neutral-900/55 backdrop-blur-md'
                : BOX_SHELL_CLASS
            } ${
              // V38：新建的格子先给一圈高亮（新的不一定在视线的位置上），胜过暗示用户去找
              focusBoxId === box.id
                ? 'ring-2 ring-amber-300/90'
                : isDropTarget
                  ? 'ring-2 ring-sky-300/85'
                  : editMode
                    ? accentRing(box.accent)
                    : ''
            }`}
            /* V59：这里原本挂着 onDragOver / onDragLeave / onDrop 三个 HTML5 拖放处理器，
               全部删掉 —— 内部拖拽已改成指针拖拽（落点由主循环的 mouseup 算），
               留着它们只会：① 永远不触发（见 `DRAG_THRESHOLD` 上方的根因）；② 让下一个
               读代码的人以为「拖放是 HTML5 在管」。落点高亮仍然靠 `dropTargetId`。 */
            onMouseDown={(event) => {
              // **从格子任意空白处都能拖动**（不只是 36px 高的标题栏）。
              //
              // ⚠️ V56：这里原本有一道 `if (!editMode) return;` —— 于是「锁着的格子只能拖标题栏」，
              // 而用户的本能动作是抓格子空白处 / 卡片边缘。配合上一处「新建格子其实没解锁」的
              // bug，结果就是「格子完全拖不动，只能点整理」。用户 09-20 原话：
              // 「现在桌面上的是不能自己拖动调整的，只能通过整理自动整理」。
              //
              // 现在的口径：**移动是桌面上的第一等交互，任何时候都可用**；
              // 锁只用来收/放「编辑类」能力（改名 / 配色 / 删除 / 拉大小），不再拦移动。
              // 条目元素带 data-grid-item，交给它们自己的拖拽 / 双击逻辑；
              // 按钮与输入框各自 stopPropagation。
              const target = event.target as HTMLElement | null;
              if (target?.closest('[data-grid-item="1"]')) {
                return;
              }
              if (target?.closest('button,input,[contenteditable="true"]')) {
                return;
              }
              // V86：空白处按下 = 清除选中（对齐原生桌面「点空白取消选择」）
              if (event.button === 0 && selectedPathsRef.current.size > 0) {
                selectedPathsRef.current = new Set();
                setSelectedPaths(selectedPathsRef.current);
              }
              startMove(event, box);
            }}
            /* V41：右键菜单从「整个格子」收回到**标题栏** —— 用户原话：「右键功能可以在
               header 部分右键是格子的菜单或者在 header 部分添加操作按钮」。条目与
               格子空白处的右键还给条目自己的菜单（见条目上的 onContextMenu）。 */
          >
            {/* 标题栏：拖拽移动（随时可用）+ 双击重命名 + 右键格子菜单（V41 只挂这里） */}
            <header
              onMouseDown={(event) => startMove(event, box)}
              onDoubleClick={() => beginRename(box)}
              onContextMenu={(event) => {
                // 格子操作面板的唯一入口（用户 V41：header 右键 = 格子的菜单）。
                // 用 clientX/clientY —— 根容器是 fixed inset-0，和视口是同一套坐标。
                event.preventDefault();
                event.stopPropagation();
                setMenuItem(null);
                setMenuLoose(null);
                setAccentBoxId(null);
                setMenuBox({ id: box.id, x: event.clientX, y: event.clientY });
              }}
              className="flex h-9 shrink-0 cursor-move items-center gap-1.5 px-3 active:cursor-grabbing bg-gradient-to-b from-white/[0.04] to-transparent border-b border-white/[0.06]"
              title="拖拽移动 · 双击重命名标题"
            >
              {renamingId === box.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitRename();
                    } else if (event.key === 'Escape') {
                      setRenamingId(null);
                    }
                  }}
                  className="w-full rounded-lg bg-neutral-800/90 px-2 py-1 text-xs text-white outline-none ring-1 ring-sky-400/60 shadow-inner"
                />
              ) : (
                <span
                  className={`min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider [text-shadow:0_1px_2px_rgba(0,0,0,0.8)] ${
                    editMode ? 'opacity-95 text-white' : 'opacity-80 text-neutral-200'
                  }`}
                >
                  {box.name}
                </span>
              )}
              {/* V52：每格子独立锁定/解锁按钮 */}
              <button
                type="button"
                title={editMode ? '锁定此格子' : '解锁此格子（可编辑）'}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => toggleBoxLock(box.id)}
                className={`shrink-0 rounded p-0.5 transition hover:bg-white/20 ${
                  editMode ? 'text-sky-300 opacity-100' : 'opacity-50 hover:opacity-100'
                }`}
              >
                {editMode ? <LockOpen className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
              </button>
              {/* 配色（便签最爱用：多个便签靠颜色区分） */}
              {editMode ? (
                <button
                  type="button"
                  title="换个配色"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => setAccentBoxId((prev) => (prev === box.id ? null : box.id))}
                  className="shrink-0 rounded p-0.5 opacity-80 transition hover:bg-white/20 hover:opacity-100"
                >
                  <Palette className="h-3 w-3" />
                </button>
              ) : null}
              {editMode && !isWidget ? (
                <button
                  type="button"
                  title="按路径把这个文件归拢进当前格子（只登记显示，不动文件）"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => beginAddPath(box.id)}
                  className="shrink-0 rounded p-0.5 opacity-80 transition hover:bg-white/20 hover:opacity-100"
                >
                  <Plus className="h-3 w-3" />
                </button>
              ) : null}
              {editMode ? (
                <button
                  type="button"
                  title="删除格子（只删格子和它的登记，你的文件一直留在桌面原位）"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => deleteBox(box.id)}
                  className="shrink-0 rounded p-0.5 opacity-80 transition hover:bg-red-500/80 hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              ) : null}
              {isWidget ? (
                <StickyNote
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: NOTE_ACCENTS[box.accent]?.hex ?? NOTE_ACCENTS[''].hex }}
                />
              ) : null}
              {/* V51：格子视图切换——图标网格 ⇄ 列表。只在普通收纳格显示（便签不切换）。
                  参考 Windows 右键菜单「查看 → 大图标/列表」。 */}
              {box.kind !== 'note' ? (
                <button
                  type="button"
                  title={getBoxViewMode(box.id) === 'grid' ? '切换为列表视图' : '切换为图标视图'}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => toggleBoxViewMode(box.id)}
                  className="shrink-0 rounded p-0.5 opacity-60 transition hover:bg-white/15 hover:opacity-100"
                >
                  {getBoxViewMode(box.id) === 'grid' ? (
                    <List className="h-3.5 w-3.5" />
                  ) : (
                    <LayoutGrid className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : null}
            </header>

            {/* 配色选择器（编辑态点调色盘展开）。
                V60：日历并进工作台后，盒子里只剩便签，这里**只给便签配色**了 ——
                原来那套「日历换整套主题」的图例跟着 `CalendarWidget` 搬进了工作台
                （主题状态仍在 `GridOverlay`，见 `calendarTheme`）。 */}
            {editMode && accentBoxId === box.id ? (
              <div
                className="flex shrink-0 items-center gap-1 border-b border-white/15 px-2 py-1"
                onMouseDown={(event) => event.stopPropagation()}
              >
                {ACCENT_ORDER.map((key) => (
                  <button
                    key={key || 'default'}
                    type="button"
                    title={NOTE_ACCENTS[key].label}
                    onClick={() => setAccent(box.id, key)}
                    style={{ background: NOTE_ACCENTS[key].hex }}
                    className={cn(
                      'h-4 w-4 rounded-full transition hover:scale-110',
                      box.accent === key ? 'ring-2 ring-sky-300' : 'ring-1 ring-white/30',
                    )}
                  />
                ))}
                <span className="ml-1 text-[10px] opacity-75">
                  {NOTE_ACCENTS[box.accent].label}
                </span>
              </div>
            ) : null}

            {/* V55：便签内容区可滚动，超出格子高度时内部滚动，不覆盖下一个格子 */}
            {box.kind === 'note' ? (
              <div className="min-h-0 flex-1 overflow-y-auto grid-scroll" data-grid-item="1">
                <NoteWidget
                  boxId={box.id}
                  content={box.content}
                  accent={box.accent}
                  onSave={saveBoxContent}
                />
              </div>
            ) : (
              /* 收纳格条目网格：双击打开原文件；悬停把文件从格子移出（文件不动）。
                 列宽跟着**系统桌面图标尺寸**走（V37）：图标多大，格子就留多宽 ——
                 这样格子里和桌面上看起来才是同一套图标。

                 V59：必须是 `flex-1 min-h-0`。盒子高度现在**严格等于引擎给的 `box.height`**
                 （见上面 section 的 height），内容装不下时靠这里滚。少了 `min-h-0`，
                 flex 子项默认 `min-height: auto`（不小于内容高），它就会顶着父容器长出去，
                 `overflow-y-auto` 形同虚设 —— 用户看到的「装不下了却没有滚动条」就是它。
                 同时去掉了原来的 `max-h-[60vh]`：高度上限已由盒子本身决定，再压一层
                 只会在高盒子里留出一截空白。 */
              <div
                className={getBoxViewMode(box.id) === 'list'
                  ? "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1.5 grid-scroll"
                  : "grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto px-2.5 py-2 grid-scroll"}
                style={getBoxViewMode(box.id) === 'grid'
                  ? {
                      gridTemplateColumns: `repeat(auto-fill, minmax(${iconSize + 32}px, 1fr))`,
                      gridAutoRows: `${iconSize + 36}px`,
                    }
                  : undefined}
              >
              {addingBoxId === box.id ? (
                <div className="col-span-full flex items-center gap-1">
                  <input
                    autoFocus
                    value={addPathDraft}
                    onChange={(event) => setAddPathDraft(event.target.value)}
                    onMouseDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        commitAddPath(box.id, addPathDraft);
                      } else if (event.key === 'Escape') {
                        setAddingBoxId(null);
                        setAddPathDraft('');
                      }
                    }}
                    placeholder="粘贴文件/文件夹完整路径后回车"
                    className="min-w-0 flex-1 rounded bg-neutral-800 px-1.5 py-1 text-[11px] text-neutral-100 outline-none ring-1 ring-sky-400/60"
                  />
                </div>
              ) : null}
              {boxItems.map((item) => {
                const isListView = getBoxViewMode(box.id) === 'list';
                return (
                <div
                  key={item.id}
                  data-grid-item="1"
                  title={`${item.displayName}\n${item.filePath}\n双击打开 · 拖到其他格子 · 拖出格子移入左侧「未归类」竖条 · Ctrl/Shift 多选 · F2 或单击两次改名 · Ctrl+右键更多操作`}
                  onMouseDown={(event) => {
                    // 不许冒泡：否则会同时触发「拖动整个格子」（V56 起格子任意空白处可拖）
                    event.stopPropagation();
                    // V59：改成指针拖拽 —— 这里只记起点，越过阈值才算拖拽，
                    // 单击 / 双击照旧。见 `DRAG_THRESHOLD` 上方的根因说明。
                    beginItemDrag(item, event);
                  }}
                  onClick={() => {
                    // V87：Explorer 的「**单击两次**改名」—— 两次单击落在同一个条目上，
                    // 间隔要比双击慢（Windows 双击阈值 500ms）又不至于算两次独立点击。
                    const now = Date.now();
                    const last = lastClickRef.current;
                    if (
                      last.path === item.filePath &&
                      now - last.at > 350 &&
                      now - last.at < 1500
                    ) {
                      lastClickRef.current = { path: '', at: 0 };
                      beginItemRename(item.filePath, item.displayName);
                      return;
                    }
                    lastClickRef.current = { path: item.filePath, at: now };
                  }}
                  onDoubleClick={() => openItem(item)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenuBox(null);
                    setMenuLoose(null);
                    // V58：**Shift 是系统的语义**（Explorer 的扩展菜单），我们不抢 ——
                    // 按了 Shift 就把 CMF_EXTENDEDVERBS 传给 Shell，让它多出
                    // 「在此处打开 PowerShell 窗口」那几项。Handy 自己的条目菜单
                    // （打开文件位置 / 移出格子）**改用 Ctrl + 右键**：Ctrl + 右键
                    // 在 Explorer 里没有任何含义，抢它不改变任何原生行为。
                    if (!event.ctrlKey) {
                      setMenuItem(null);
                      void ipc
                        .shellContextMenu(item.filePath, event.shiftKey)
                        .catch((error: Error) => showHint(error.message));
                      return;
                    }
                    setMenuItem({ item, x: event.clientX, y: event.clientY });
                  }}
                  className={((isListView
                    ? "group relative flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 transition-all duration-200 hover:bg-white/10 hover:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
                    : "group relative flex cursor-pointer flex-col items-center justify-center gap-1 overflow-hidden rounded-xl p-1.5 transition-all duration-300 hover:bg-white/10 hover:shadow-[0_6px_18px_rgba(91,140,255,0.2),0_0_0_1px_rgba(255,255,255,0.1),inset_0_1px_0_rgba(255,255,255,0.08)] hover:scale-[1.02]")
                    + (selectedPaths.has(item.filePath)
                      // V86：多选高亮 —— 与系统选中语义对齐（蓝色内描边 + 淡蓝底）
                      ? " bg-sky-500/20 !shadow-none ring-2 ring-inset ring-sky-400/80"
                      : ""))}
                  style={isListView ? undefined : { aspectRatio: '1 / 1', minHeight: iconSize + 32 }}
                >
                  <FileIcon path={item.filePath} size={isListView ? Math.round(iconSize * 0.5) : iconSize} />
                  {renamingItemPath === item.filePath ? (
                    <input
                      autoFocus
                      value={itemRenameDraft}
                      onChange={(event) => setItemRenameDraft(event.target.value)}
                      onBlur={commitItemRename}
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          commitItemRename();
                        } else if (event.key === 'Escape') {
                          setRenamingItemPath(null);
                          setItemRenameDraft('');
                        }
                      }}
                      className={
                        isListView
                          ? 'min-w-0 flex-1 rounded bg-neutral-900/95 px-1 text-left text-[12px] text-white outline-none ring-1 ring-sky-400/70'
                          : 'w-full rounded bg-neutral-900/95 px-1 text-center text-[10px] leading-tight text-white outline-none ring-1 ring-sky-400/70'
                      }
                    />
                  ) : (
                    <span className={isListView
                      ? "min-w-0 flex-1 truncate text-left text-[12px] font-medium text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.95)]"
                      : "w-full truncate text-center text-[10px] font-medium leading-tight text-neutral-200 [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]"
                    }>
                      {item.displayName.replace(/\.lnk$/i, '')}
                    </span>
                  )}
                </div>
                );
              })}
              {boxItems.length === 0 && (
                <p className="col-span-full py-4 text-center text-[11px] leading-relaxed text-neutral-400/60">
                  拖文件到这里
                </p>
              )}
              </div>
            )}

            {/* 缩放手柄（仅编辑态）：**四边 + 四角**，不再只有右下角一个。
                V35 用户原话：「格子拉升缩放大小，右边和下边都可以，现在只有右下角才可以拉」。
                四边的命中带避开四个角（角上各有自己的手柄），免得互相抢。 */}
            {editMode
              ? RESIZE_HANDLES.map(({ edge, className, cursor }) => (
                  <div
                    key={edge}
                    onMouseDown={(event) => startResize(event, box, edge)}
                    title="拖拽调整大小"
                    className={`absolute z-10 ${className} ${cursor}`}
                  />
                ))
              : null}
            {/* 角上手柄画一个小折角，给个「这里能拉」的视觉提示 */}
            {editMode ? (
              <svg
                viewBox="0 0 16 16"
                aria-hidden
                className="pointer-events-none absolute bottom-0 right-0 z-10 h-4 w-4 text-white/60"
              >
                <path d="M14 14L7 14M14 14L14 7" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
            ) : null}
          </section>
        );
      })}
        </div>
      )}

      {/* 左侧「未归类」竖条（V42）：系统入口 + 快捷方式 + 落单条目都排在这里。
          用户原话「不整理的和快捷方式别整理到格子了，他们就是自动在桌面左上角从上往下
          排开即可，不需要放到格子里面，没有必要」——
          所以这里**不是格子**：没有卡片外框、没有标题栏、没有条目计数，就是纯粹的一列
          桌面图标（和系统桌面自己排的那排长得一样）。

          列数 / 几何全部由 Rust 算好（与收纳格条目同一套度量），这里只按 `columns` 列
          等宽网格「先自上而下、再往右一列」铺开 —— 前后端差一列就会盖住分类格。

          只在接管模式下渲染：接管关着时桌面本来就看得见这些图标，再画一份就是两份。 */}
      {!contentHidden && takeover?.enabled === true && loose !== null && loose.columns > 0 && (
        <div
          ref={looseRef}
          style={{
            left: loose.x,
            top: loose.y,
            width: loose.width,
            height: loose.height,
            pointerEvents: 'auto',
            gridAutoFlow: 'column',
            gridTemplateColumns: `repeat(${loose.columns}, ${loose.iconSize + STRIP_CELL_EXTRA_W}px)`,
            gridTemplateRows: `repeat(${Math.ceil(
              loose.items.length / Math.max(1, loose.columns),
            )}, ${loose.iconSize + STRIP_CELL_EXTRA_H}px)`,
          }}
          title="未归类：系统入口 · 快捷方式 · 没进格子的文件；拖进任意格子即可收纳"
          /* V59：竖条的 onDragOver / onDrop 也一并删掉 —— 拖到竖条 = 移出格子，
             这条现在由指针拖拽主循环在 mouseup 里处理（落点在所有格子之外即移出），
             不需要竖条自己再接一层。落点高亮仍然靠 `dropTargetId`。 */

          /* ⚠️ `overflow-y-auto` 不是装饰，是**必须**的（V59 追加；V86 起是兜底）。
           *
           * Rust `loose_strip_rect` 的行数是这么定的：先按「一列放得下几行」(`rows_per_col`)
           * 反推需要几列，再把列数夹在「**竖条最多占工作区一半宽**」内（V86 起不再拍死 4 列
           * —— 那会把多出的条目全藏进内部滚动区，用户 09-30 抱怨的「下面空了」正是它）。
           * 正常条目数下 `rows = ceil(n / columns) ≤ rows_per_col`，**没有滚动**、每列满高；
           * 列数撞到宽度上限时（极端条目数），`rect.h` 封顶到 `avail_h`，前端渲染的行数
           * 仍然按 `ceil(n / columns)` —— 内容天然比区域高，由这个 `overflow-y-auto`
           * 在竖条内部滚（与收纳格「装不下就内部出滚动条」同一口径），**不许**溢出到
           * 桌面根画布（V59 的回归就是这么来的）。 */
          className="absolute grid content-start gap-1.5 overflow-y-auto grid-scroll"
        >
          {loose.items.map((entry) => (
            <div
              key={entry.path}
              data-grid-item="1"
              data-path={entry.path}
              title={`${entry.name}\n${entry.path}\n双击打开 · 拖进格子收纳 · Ctrl/Shift 多选 · Ctrl+右键更多操作`}
              onMouseDown={(event) => {
                event.stopPropagation();
                beginLooseDrag(entry, event);
              }}
              onDoubleClick={() =>
                void ipc.gridOpenPath(entry.path).catch((error: Error) => showHint(error.message))
              }
              onContextMenu={(event) => {
                // V43：左条条目同样「普通右键 = 系统原生菜单」（同格子里的条目）
                event.preventDefault();
                event.stopPropagation();
                setMenuBox(null);
                setMenuItem(null);
                // V58：Shift 让回系统的扩展菜单（CMF_EXTENDEDVERBS），Handy 自己的
                // 菜单改用 Ctrl + 右键。
                //
                // V82：**系统图标（此电脑 / 回收站）也交回原生**。
                //
                // 这里原来写着「系统图标没有文件路径，Shell 给不了菜单，只能走我们自己的」
                // —— 那句话是**错的**。用户 09-27 贴图报「我的电脑都变成这样了」，正是
                // 右键「此电脑」弹出的是我们复刻的菜单（只有 打开 / 打开文件位置）。
                // 系统入口的 `path` 就是 shell CLSID（`::{20D04FE0-…}` 等），
                // `SHCreateItemFromParsingName` 认得它：`cargo run --example menu_dump --`
                // `"::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"` 实测拿到 **14 项**完整原生菜单
                // （打开 / 管理 / 映射网络驱动器 / 创建快捷方式 / 删除 / 重命名 / 属性…）。
                if (!event.ctrlKey) {
                  setMenuLoose(null);
                  void ipc
                    .shellContextMenu(entry.path, event.shiftKey)
                    .catch(() => {
                      // 极少数命名空间对象 Shell 确实给不出菜单 —— 这时才回落到
                      // 我们自己的菜单（原来是无条件回落，现在降级成兜底）。
                      setMenuLoose({ entry, x: event.clientX, y: event.clientY });
                    });
                  return;
                }
                setMenuLoose({ entry, x: event.clientX, y: event.clientY });
              }}
              onClick={() => {
                // V87：与格子条目同一套「单击两次改名」
                const now = Date.now();
                const last = lastClickRef.current;
                if (last.path === entry.path && now - last.at > 350 && now - last.at < 1500) {
                  lastClickRef.current = { path: '', at: 0 };
                  beginItemRename(entry.path, entry.name);
                  return;
                }
                lastClickRef.current = { path: entry.path, at: now };
              }}
              className={"group flex cursor-pointer flex-col items-center gap-1 rounded-xl p-1.5 transition-all duration-200 hover:bg-white/10 hover:shadow-[0_4px_16px_rgba(0,0,0,0.3),0_0_0_1px_rgba(255,255,255,0.08)]"
                + (selectedPaths.has(entry.path)
                  // V86：多选高亮（与格子条目同一套）
                  ? " bg-sky-500/20 !shadow-none ring-2 ring-inset ring-sky-400/80"
                  : "")}
            >
              <LooseIcon entry={entry} size={loose.iconSize} />
              {renamingItemPath === entry.path ? (
                <input
                  autoFocus
                  value={itemRenameDraft}
                  onChange={(event) => setItemRenameDraft(event.target.value)}
                  onBlur={commitItemRename}
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitItemRename();
                    } else if (event.key === 'Escape') {
                      setRenamingItemPath(null);
                      setItemRenameDraft('');
                    }
                  }}
                  className="w-full rounded bg-neutral-900/95 px-1 text-center text-[11px] leading-tight text-white outline-none ring-1 ring-sky-400/70"
                />
              ) : (
                <span className="w-full truncate text-center text-[11px] font-medium leading-tight text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.95)]">
                  {entry.name.replace(/\.lnk$/i, '')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 一个格子都没有时给引导（卡片自身可交互，已纳入命中区域） */}
      {!contentHidden && boxes.length === 0 && (
        <div
          ref={emptyRef}
          style={{ pointerEvents: 'auto' }}
          className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-4 rounded-2xl border border-white/15 bg-gradient-to-b from-neutral-900/85 to-neutral-950/90 px-8 py-7 text-center shadow-[0_30px_80px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.05),inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-2xl"
        >
          <p className="text-sm font-medium text-neutral-100">桌面上还没有格子</p>
          <p className="max-w-sm text-xs leading-relaxed text-neutral-300">
            收纳格是桌面上的分区：把文件拖进去，它就
            <span className="text-neutral-100">归拢显示在格子里，文件本身留在桌面原位，不会被移动或删除</span>；
            双击图标用默认程序打开；把图标拖出格子（或右键选「移出格子」）它就回到左侧
            「未归类」竖条——不是删除文件。
            <br />
            也可以直接加一个便签，桌面随手记；日历在右侧常驻的「工作台」里。
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addBox}
              className="rounded-lg bg-sky-500/90 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-400"
            >
              ＋ 新建收纳格
            </button>
            <button
              type="button"
              onClick={addNote}
              className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium text-neutral-100 transition hover:bg-white/25"
            >
              便签
            </button>
          </div>
        </div>
      )}

      {/* 格子右键菜单（V35）。借鉴腾讯桌面整理：所有格子操作都在这里，不必先解锁布局。 */}
      {menuBox !== null &&
        (() => {
          const box = boxes.find((item) => item.id === menuBox.id);
          if (box === undefined) {
            return null;
          }
          const isFolder = box.kind === 'folder';
          const rowClass = menuItemRowClass;
          return (
            <div
              key="grid-box-menu"
              ref={menuRef}
              style={{ left: menuBox.x, top: menuBox.y, pointerEvents: 'auto' }}
              onMouseEnter={cancelMenuLeave}
              onMouseLeave={() => scheduleMenuLeave(() => setMenuBox(null))}
              /* V59：`fixed` 而不是 `absolute` —— 坐标是 `clientX/clientY`（视口坐标），
                 而且根画布带 `overflow-hidden`，`absolute` 会被它裁掉半截。 */
              className="fixed z-50 w-48 overflow-hidden rounded-xl bg-neutral-900/95 py-1 text-[13px] text-neutral-100 shadow-2xl ring-1 ring-white/15 backdrop-blur-xl"
            >
              <div className="truncate px-2.5 pb-1 pt-0.5 text-[10px] text-neutral-400">
                {box.name}
              </div>
              <button
                type="button"
                className={rowClass}
                onClick={() => {
                  const target = box;
                  setMenuBox(null);
                  beginRename(target);
                }}
              >
                重命名格子
              </button>
              {/* V87：排序方式（对齐 Explorer「排序方式」）—— 只改这一格**怎么画**，
                  不写回库里的 `sort`，用户的自定义顺序随时能切回来。 */}
              {isFolder ? (
                <button
                  type="button"
                  className={rowClass}
                  title="点击切换：自定义顺序 → 按名称 → 按类型"
                  onClick={() => {
                    const target = box;
                    setMenuBox(null);
                    cycleBoxSortMode(target.id);
                  }}
                >
                  排序方式：{BOX_SORT_LABELS[boxSortModes[box.id] ?? 'manual']}
                </button>
              ) : null}
              {isFolder ? (
                <button
                  type="button"
                  className={rowClass}
                  onClick={() => {
                    const target = box;
                    setMenuBox(null);
                    duplicateBox(target);
                  }}
                >
                  新建同款格子
                </button>
              ) : (
                <button
                  type="button"
                  className={rowClass}
                  onClick={() => {
                    setMenuBox(null);
                    addNote();
                  }}
                >
                  再加一个便签
                </button>
              )}
              {/* V56：**全局解锁入口** —— `toggleEditMode` 从 V52 起就定义了却**从未接到任何
                  UI 上**（grep 全仓只有定义处），于是「解锁」只剩标题栏那个 50% 透明度的小锁，
                  用户根本发现不了。09-20 反馈「桌面上的是不能自己拖动调整的」正是这条链路的终点。
                  格子右键菜单是用户 V41 指定的「格子操作面板唯一入口」，开关放这里最顺手。 */}
              <button
                type="button"
                className={rowClass}
                onClick={() => {
                  setMenuBox(null);
                  toggleEditMode();
                }}
              >
                {unlockedBoxes.size > 0
                  ? '锁定全部格子（收起操作按钮）'
                  : '自由摆放（解锁全部格子）'}
              </button>
              <div className="px-2.5 pb-0.5 pt-1.5 text-[10px] text-neutral-400">配色</div>
              <div className="flex flex-wrap gap-1 px-2.5 pb-1.5">
                {ACCENT_ORDER.map((key) => (
                  <button
                    key={key || 'default'}
                    type="button"
                    title={NOTE_ACCENTS[key].label}
                    aria-label={`配色 ${NOTE_ACCENTS[key].label}`}
                    onClick={() => {
                      setAccent(box.id, key);
                    }}
                    style={{ background: NOTE_ACCENTS[key].hex }}
                    className={cn(
                      'h-4 w-4 rounded-full ring-1 ring-white/25 transition hover:scale-110',
                      box.accent === key ? 'ring-2 ring-sky-300' : '',
                    )}
                  />
                ))}
              </div>
              <div className="my-1 h-px bg-white/10" />
              <button
                type="button"
                className={`${rowClass} text-rose-300`}
                onClick={() => {
                  const target = box.id;
                  setMenuBox(null);
                  deleteBox(target);
                }}
              >
                解散该格子
              </button>
              <p className="px-2.5 pb-1 pt-0.5 text-[10px] leading-relaxed text-neutral-500">
                解散只删格子与它的登记，你的文件一直留在桌面原位
              </p>
            </div>
          );
        })()}

      {/* 条目右键菜单（V41；V58 起挂在 **Ctrl + 右键** 上）：接管模式下普通右键已经
          弹系统原生 shell 菜单（V43），Shift + 右键让给系统的扩展菜单（V58），
          这里只补原生菜单里给不了的 Handy 自己的两件事。 */}
      {menuItem !== null && !contentHidden && (
        <div
          key="grid-item-menu"
          ref={itemMenuRef}
          style={{ left: menuItem.x, top: menuItem.y, pointerEvents: 'auto' }}
          onMouseEnter={cancelMenuLeave}
          onMouseLeave={() => scheduleMenuLeave(() => setMenuItem(null))}
          className={menuShellClass}
        >
          <div className="truncate px-2.5 pb-1 pt-0.5 text-[10px] text-neutral-400">
            {menuItem.item.displayName}
          </div>
          <button
            type="button"
            className={menuItemRowClass}
            onClick={() => {
              const target = menuItem.item;
              setMenuItem(null);
              openItem(target);
            }}
          >
            打开
          </button>
          <button
            type="button"
            className={menuItemRowClass}
            onClick={() => {
              const path = menuItem.item.filePath;
              setMenuItem(null);
              revealItem(path);
            }}
          >
            打开文件位置
          </button>
          <div className="my-1 h-px bg-white/10" />
          <button
            type="button"
            className={`${menuItemRowClass} text-amber-200`}
            onClick={() => {
              const target = menuItem.item;
              setMenuItem(null);
              removeItem(target);
            }}
          >
            移出格子
          </button>
          <p className="px-2.5 pb-1 pt-0.5 text-[10px] leading-relaxed text-neutral-500">
            只删登记不删文件；它会在左侧「未归类」竖条
          </p>
        </div>
      )}

      {/* 未归类竖条条目右键菜单（V41） */}
      {menuLoose !== null && !contentHidden && (
        <div
          key="grid-loose-menu"
          ref={looseMenuRef}
          style={{ left: menuLoose.x, top: menuLoose.y, pointerEvents: 'auto' }}
          onMouseEnter={cancelMenuLeave}
          onMouseLeave={() => scheduleMenuLeave(() => setMenuLoose(null))}
          className={menuShellClass}
        >
          <div className="truncate px-2.5 pb-1 pt-0.5 text-[10px] text-neutral-400">
            {menuLoose.entry.name}
          </div>
          <button
            type="button"
            className={menuItemRowClass}
            onClick={() => {
              const path = menuLoose.entry.path;
              setMenuLoose(null);
              void ipc.gridOpenPath(path).catch((error: Error) => showHint(error.message));
            }}
          >
            打开
          </button>
          <button
            type="button"
            className={menuItemRowClass}
            onClick={() => {
              const path = menuLoose.entry.path;
              setMenuLoose(null);
              revealItem(path);
            }}
          >
            打开文件位置
          </button>
          <p className="px-2.5 pb-1 pt-0.5 text-[10px] leading-relaxed text-neutral-500">
            拖进任意格子即可收纳
          </p>
        </div>
      )}

      {/* 提示条（非交互文本） */}
      {hint && (
        <div
          className="absolute left-1/2 top-5 max-w-[560px] -translate-x-1/2 rounded-2xl border border-white/15 bg-gradient-to-b from-neutral-900/90 to-neutral-950/95 px-5 py-2 text-center text-[13px] font-medium leading-snug text-neutral-100 shadow-[0_10px_40px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06),inset_0_1px_0_rgba(255,255,255,0.12)] backdrop-blur-xl animate-[fadeIn_0.2s_ease-out]"
        >
          {hint}
        </div>
      )}

      {/* 桌面右侧统一面板（V45）：工具搜索 / 工具箱 / 快捷入口三合一。
          用户 09-19：「工具搜索应该放在右侧，跟工作台差不多 直接搜索获取，而不是打开
          额外的对话框 很乱」—— 于是桌面上只保留这一个容器，V42–V44 那三个分散的浮层
          （中部搜索、偏左大抽屉、右下快捷）合并到这里。
          外框用 pointerEvents:none（只把面板那块矩形报成命中区），
          这样面板开着的时候，桌面其余部分照样能点、能拖。
          `key` 让「换页签 / 换目标」时重新挂载，面板内部状态（搜索词 / 当前工具）随之重置。 */}
      {sidePanel !== null && (
        <div
          ref={sidePanelRef}
          style={{ pointerEvents: 'none' }}
          className={sidePanelShell(panelWide ? 'full' : 'half')}
        >
          <DesktopSidePanel
            key={`${sidePanel.tab}:${sidePanel.entry?.id ?? ''}`}
            initialTab={sidePanel.tab}
            initialEntry={sidePanel.entry}
            wide={panelWide}
            onToggleWidth={() => setPanelWide((prev) => !prev)}
            onClose={closePanel}
            onLaunch={openTarget}
            onOpenLink={(link) => openDockLink(link)}
            onRemoveLink={(id) => removeDockLink(id)}
          />
        </div>
      )}

      {/* —— 桌面右侧常驻「工作台」（V60）——
          用户 09-21（附腾讯桌面整理截图）：「日历可以修改为工作台，把快捷入口这些都可以
          整合到工作台里面，整合成一个整体的模块，现在还缺少添加便签的按钮 还有整理
          关闭整理等，工作台这个可以常驻，不跟桌面整理一起退出等」。

          于是「右下角快捷入口格子」（V56）+「日历盒子」合并成**这一个模块**：
            · 日历（含整套主题切换）
            · 快捷入口（应用入口 / 系统入口 / 我的快捷方式）
            · 操作按钮条（便签 / 格子 / 整理 / 显示·收起格子）

          ⚠️ 它在 `contentHidden` 时**照样渲染** —— 这正是「常驻，不跟桌面整理一起退出」，
          也是它必须是浮窗而不是格子的原因（所有盒子都会在退出整理时被一起收起）。
          Rust 侧 `workstation_rect()` 把工作区右侧一整列当禁区。

          外壳 / 标题栏 / 条目网格仍与收纳格共用同一套类名（`BOX_SHELL_CLASS` +
          `cardBackground`）—— 用户 09-20「将右下角这个快捷入口改造成格子样式」的要求不变。

          拖动仍然有效：把桌面图标 / 格子条目拖进来即收藏成「我的快捷方式」
          （由指针拖拽主循环在 mouseup 里判定，入口优先于格子）。 */}
      <DesktopWorkstation
        shellRef={dockRef}
        shellClassName={BOX_SHELL_CLASS}
        background={cardBackground('')}
        hot={dockHot}
        collapsed={dockCollapsed}
        onToggleCollapsed={toggleDockCollapsed}
        hidden={contentHidden}
        onAddBox={addBox}
        onAddNote={addNote}
        onArrange={arrangeDesktop}
        onToggleOverlay={toggleOverlay}
        onOpenSettings={() => openPanel('settings', null)}
        headerExtra={
          /* 换日历主题（V48 起日历是**整套换色**：底 / 字 / 今天 / 选中 / 节日 / 输入框，
             一眼可辨）。主题键与展开态都落 localStorage，与折叠态同一套做法。 */
          <button
            type="button"
            onClick={() => setShowThemePicker((prev) => !prev)}
            title="换个日历主题"
            className="shrink-0 rounded p-1 opacity-60 transition hover:bg-white/15 hover:opacity-100"
          >
            <Palette className="h-3.5 w-3.5" />
          </button>
        }
        calendar={
          <div className="flex flex-col gap-1.5">
            {showThemePicker ? (
              <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-black/25 px-2 py-1.5">
                {ACCENT_ORDER.map((key) => (
                  <button
                    key={key || 'default'}
                    type="button"
                    title={CALENDAR_THEMES[key].label}
                    onClick={() => setCalendarTheme(key)}
                    className={cn(
                      'h-4 w-4 rounded-full transition hover:scale-110',
                      CALENDAR_THEMES[key].swatch,
                      calendarTheme === key ? 'ring-2 ring-sky-300' : 'ring-1 ring-white/30',
                    )}
                  />
                ))}
              </div>
            ) : null}
            <CalendarWidget accent={calendarTheme} />
          </div>
        }
      >
            {/* V61：整段改用「段头 + 胶囊网格」的统一语言 —— 段头与工作台的
                「我的快捷方式」共用 `WorkstationSectionLabel`，两段读起来是一套东西。
                段内**不再有分隔线**（原先「应用入口 / 系统入口 / 我的快捷方式」之间
                各有一条 `border-t`，三段板子摞在一起正是用户说的「拼接」）。

                应用入口那排同时瘦身：原来并排的「工具箱 / 整理 / 设置」里，
                「整理」与底栏那颗、《设置》与标题栏那颗**都是同一件事**，
                摆两遍只会让人犹豫点哪个。这里只留「工具箱」（工作台唯一的对外主入口）。 */}
            <div className="flex flex-col gap-2.5">
              <div>
                <WorkstationSectionLabel
                  action={
                    <button
                      type="button"
                      onClick={() => openPanel('quick')}
                      title="增删入口：在右侧「快捷」面板展开「全部系统入口」，点右侧图钉即固定到这里"
                      className="shrink-0 rounded p-0.5 opacity-50 transition hover:bg-white/15 hover:opacity-100"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  }
                >
                  快捷入口
                </WorkstationSectionLabel>
                <div className="grid grid-cols-2 gap-1">
                  <DockChip
                    icon={Wrench}
                    label="工具箱"
                    title="工具箱：搜索并使用全部本地小工具（在右侧面板里就地打开）"
                    onClick={() => {
                      if (sidePanel !== null && sidePanel.tab === 'tools') {
                        closePanel();
                      } else {
                        openPanel('tools');
                      }
                    }}
                  />
                  {dockActionList.map((action) => (
                    <DockChip
                      key={`act-${action.id}`}
                      icon={ACTION_ICONS[action.id] ?? Wrench}
                      label={action.name}
                      title={`${action.name}\n${action.description}${action.elevated ? '\n（需要管理员权限）' : ''}\n单击打开 · 右键从快捷入口移除`}
                      onClick={() => {
                        void ipc
                          .sysActionRun(action.id)
                          .catch((error: Error) => showHint(`执行失败：${error.message}`));
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setMenuBox(null);
                        setMenuItem(null);
                        setMenuLoose(null);
                        setMenuDock({ kind: 'action', action, x: event.clientX, y: event.clientY });
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* —— 我的快捷方式：拖进来的桌面图标 / 工作台加的链接 —— */}
              {dockLinks.length > 0 ? (
                <div>
                  <WorkstationSectionLabel>我的快捷方式</WorkstationSectionLabel>
                  <div className="grid grid-cols-2 gap-1">
                    {dockLinks.map((link) => (
                      <DockChip
                        key={link.id}
                        iconNode={
                          link.type === 'url' ? (
                            <Link2 className="h-3.5 w-3.5" />
                          ) : (
                            <FileIcon path={link.value} size={14} />
                          )
                        }
                        label={link.name}
                        title={`${link.name}\n${link.value}\n单击打开 · 右键从快捷入口移除`}
                        onClick={() => openDockLink(link)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setMenuBox(null);
                          setMenuItem(null);
                          setMenuLoose(null);
                          setMenuDock({ kind: 'link', link, x: event.clientX, y: event.clientY });
                        }}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
      </DesktopWorkstation>

      {/* V45：中部搜索浮层已并入右侧统一面板（见上方 `sidePanel` 那段渲染），
          这里不再有独立的搜索框与结果列表。 */}

      {/* 快捷入口条目右键菜单（V42）：打开 / 从快捷入口移除 */}
      {menuDock !== null && (
        <div
          key="grid-dock-menu"
          ref={dockMenuRef}
          style={{ left: menuDock.x, top: menuDock.y, pointerEvents: 'auto' }}
          onMouseEnter={cancelMenuLeave}
          onMouseLeave={() => scheduleMenuLeave(() => setMenuDock(null))}
          className={menuShellClass}
        >
          <div className="truncate px-2.5 pb-1 pt-0.5 text-[10px] text-neutral-400">
            {menuDock.kind === 'link' ? menuDock.link.name : menuDock.action.name}
          </div>
          <button
            type="button"
            className={menuItemRowClass}
            onClick={() => {
              if (menuDock.kind === 'link') {
                const link = menuDock.link;
                setMenuDock(null);
                openDockLink(link);
              } else {
                const action = menuDock.action;
                setMenuDock(null);
                void ipc
                  .sysActionRun(action.id)
                  .catch((error: Error) => showHint(`执行失败：${error.message}`));
              }
            }}
          >
            打开
          </button>
          <button
            type="button"
            className={`${menuItemRowClass} text-amber-200`}
            onClick={() => {
              if (menuDock.kind === 'link') {
                const id = menuDock.link.id;
                setMenuDock(null);
                removeDockLink(id);
                showHint('已从快捷入口移除（只是快捷方式，文件还在原处）');
              } else {
                // 系统入口的「移除」= 取消勾选：改的是 settings.quickActionIds，
                // 工作台的快捷入口栏同步少一个（同一份数据，永远不会两边不一致）
                //
                // V56：同时打上「用户亲手改过」的标记 —— 否则下一次读设置又会按默认口径
                // 算回去（默认里就含这几项），用户会发现「删了又回来」。见
                // `core/settings.ts` 的 `resolveQuickActionIds`。
                const id = menuDock.action.id;
                setMenuDock(null);
                void updateSettings({
                  quickActionIds: quickActionIds.filter((item) => item !== id),
                  quickActionsCustomized: true,
                }).catch((error: Error) => showHint(error.message));
                showHint('已从快捷入口移除（可在桌面「快捷」面板里重新固定）');
              }
            }}
          >
            从快捷入口移除
          </button>
          <p className="px-2.5 pb-1 pt-0.5 text-[10px] leading-relaxed text-neutral-500">
            与桌面「快捷」面板共享同一份数据
          </p>
        </div>
      )}

      {/* V53：右键菜单——仅在桌面整理隐藏时显示，只一个开关按钮。
          用户 09-19：「右键菜单只有开启桌面整理，如果我开启了那么右键就应该
          变成退出桌面整理」。显示时右键弹原生 Windows 菜单，不弹这个。 */}
      {menuDesktop ? (
        <div
          className="fixed z-50 min-w-[140px] rounded-xl border border-white/15 bg-neutral-900/95 p-1 shadow-2xl backdrop-blur-xl"
          style={{ left: menuDesktop.x, top: menuDesktop.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => { toggleOverlay(); setMenuDesktop(null); }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[12px] font-medium text-neutral-200 transition hover:bg-white/10"
          >
            {contentHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            {contentHidden ? '开启桌面整理' : '退出桌面整理'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
