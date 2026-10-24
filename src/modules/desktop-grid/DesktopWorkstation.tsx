import React from 'react';
import {
  Boxes,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  LayoutDashboard,
  Plus,
  Settings,
  StickyNote,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * 桌面「工作台」浮窗（V60）—— 常驻桌面右侧一列的**一个整体模块**。
 *
 * # 用户要什么
 *
 * 用户 09-21（附腾讯桌面整理截图）：
 *   「日历可以修改为工作台，把快捷入口这些都可以整合到工作台里面，整合成一个整体的模块，
 *     现在还缺少添加便签的按钮 还有整理 关闭整理等，工作台这个可以常驻，
 *     不跟桌面整理一起退出等」
 *
 * 拆成四条约束：
 *   ① **日历不再是格子** —— 它并进这里，成为工作台的第一段；
 *   ② **快捷入口不再是独立格子** —— 与日历合成同一个模块（`children` 就是那一段）；
 *   ③ **操作按钮要在这里** —— 便签 / 格子 / 整理 / 显示·收起格子，常驻底栏；
 *   ④ **常驻** —— 用户点「退出桌面整理」时，格子与竖条都收起，**工作台仍在**。
 *
 * # 为什么是浮窗而不是格子
 *
 * 日历原本是一个 `kind='calendar'` 的盒子（参与布局、可拖动、可缩放）。但工作台要求
 * 「常驻、不跟桌面整理一起退出」—— 而**所有盒子都在 `contentHidden` 时被收起**
 * （那是「退出整理」的定义）。做成浮窗，它的显隐就由自己说了算，不必给盒子系统开特例；
 * 布局引擎那边则把它当**禁区**（`grid.rs::workstation_rect`，工作区右侧一整列）。
 *
 * # 尺寸约束（改这里必须同步改 Rust）
 *
 * | 这一侧 | Rust `grid.rs` | 说明 |
 * |---|---|---|
 * | 宽 `WORKSTATION_W` | `WST_BOX_W`（V62 起 400） | 与引擎禁区同宽，差 1px 就叠上去或留一条缝 |
 * | `right-8` / `top-8` / `bottom-8` | `ARRANGE_MARGIN = 32` | 上下右各留 32，正好是禁区矩形 |
 *
 * 差一个像素就会变成「格子压在工作台上」或「白留一条缝」。
 *
 * # 为什么外壳类名 / 底色要从外面传进来
 *
 * 工作台与收纳格必须是**同一张卡片**（用户 09-20：「将右下角这个快捷入口改造成格子样式」）。
 * 那两样东西（`BOX_SHELL_CLASS` / `cardBackground`）是 `GridOverlay` 里的既有常量，
 * 复制一份到这里就等着两边漂移 —— 所以由调用方传，本组件只负责布局与交互。
 *
 * # 滚动纪律（V59.1 的教训）
 *
 * 唯一的滚动容器是中间那段 `flex-1 min-h-0 overflow-y-auto`。**`min-h-0` 不能少**：
 * flex 子项默认 `min-height: auto`，少了它内容会把容器顶穿，`overflow-y-auto` 形同虚设。
 * 而整个模块是 `fixed` 且在视口之内，所以它**永远不会**把自己的溢出漏给桌面根画布
 * （那条路会让整个桌面能被滚轮推着跑 —— 正是 V59.1 修掉的那个 bug）。
 */
/**
 * 工作台宽度（**必须与 Rust `grid.rs` 的 `WST_BOX_W` 逐字一致**）。
 *
 * 引擎按它把「工作区右侧一整列」当禁区，前端按它画浮窗 —— 差一个像素就会变成
 * 「格子压在工作台上」或「白留一条缝」。
 *
 * **V62：320 → 400。** 320 是当年**日历格子**的自然宽度（一个 `max-w-[288px]` 的月历
 * 就装得下）；而工作台现在要装「日历 + 快捷入口 + 操作按钮」三段。用户 09-21 看着真机
 * 截图说「工作台太小了 日历等都不清晰…最重要的工作台反而太小」—— 加宽的 80px 直接还给
 * 日历网格（`CalendarWidget` 里取消了 `max-w-[288px]` 限宽）与快捷入口的两列胶囊。
 *
 * ⚠️ 加宽会让收纳区可用宽度少 80px。真机宽度下仍在两列区间内（见 Rust `WST_BOX_W` 注释
 * 里的阈值计算），但**再往上加之前必须重算**，否则收纳区会掉到一列。
 */
export const WORKSTATION_W = 400;

export interface DesktopWorkstationProps {
  /**
   * 外壳 DOM —— `GridOverlay` 要按它上报命中区（穿透态下光标进不来）。
   *
   * ⚠️ 这里必须写 `RefObject<HTMLDivElement>` 而**不能**写 `RefObject<HTMLDivElement | null>`：
   * @types/react 18 里 `RefObject<T>` 本身就是 `{ readonly current: T | null }`，
   * 再叠一层 `| null` 得到的类型不满足 `ref` 属性的 `LegacyRef<HTMLDivElement>`
   * （TS2322：`HTMLDivElement | null` 不能赋给 `HTMLDivElement`）。
   */
  shellRef: React.RefObject<HTMLDivElement>;
  /** 卡片外壳类名：与收纳格**一字不差**（由 `GridOverlay` 传，避免两处漂移） */
  shellClassName: string;
  /** 卡片底色（`cardBackground()` 的结果，同样由外面传） */
  background: string;
  /** 拖拽悬停高亮（拖图标 / 条目进来即收藏成快捷方式） */
  hot: boolean;
  /** 整体收起成一条标题栏 */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 日历那一段（主题状态留在 `GridOverlay`，那边还要写 localStorage） */
  calendar: React.ReactNode;
  /** 标题栏右侧的额外动作（例如「换日历主题」的调色板按钮） */
  headerExtra?: React.ReactNode;
  /** 快捷入口那一段（应用入口 / 系统入口 / 我的快捷方式） */
  children: React.ReactNode;
  /** 当前是否处于「已退出桌面整理」态 —— 按钮文案与图标跟着变 */
  hidden: boolean;
  onAddBox: () => void;
  onAddNote: () => void;
  onArrange: () => void;
  onToggleOverlay: () => void;
  onOpenSettings: () => void;
}

/**
 * 底栏的一颗按钮。
 *
 * V61 改成**横向小胶囊**（原先是「图标在上、10px 文字在下」的竖排块）：
 * 用户 09-21「简单的文字按钮就可以 不用那么大的图标占空间，本来空间就不够」。
 * 竖排一格的固定高度约 44px，横排只要约 26px —— 这一条就还给日历 18px。
 * 图标同时从 `h-4` 收到 `h-3`；**不能整个去掉**：四个动作里有「便签 / 格子」这种
 * 只能靠图标区分「是新建什么」的，纯文字要读一遍才知道。
 *
 * # V62：分两种观感 —— 因为底栏里混着两种东西
 *
 * 用户 09-21：「开启整理和整理两个让人懵逼 可以有一个更好的方式体现」。
 * 原来的「整理」（**一次性动作**：把桌面条目按类型归进格子）与「显示 / 收起格子」
 * （**模式开关**：格子显隐 ↔ 原生图标）长着同一张脸，用户分不清点哪个。
 * 现在：
 *   · `action`（默认）—— 填充底，做一件事；
 *   · `toggle` —— 描边不填充，是「现在处于哪一档」的开关（文案也不再含「整理」二字）。
 */
function ActionButton({
  icon: Icon,
  label,
  title,
  onClick,
  variant = 'action',
}: {
  icon: typeof Plus;
  label: string;
  title: string;
  onClick: () => void;
  variant?: 'action' | 'toggle';
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'group flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1 py-1.5 transition',
        variant === 'toggle'
          ? 'ring-1 ring-inset ring-white/15 hover:bg-white/10'
          : 'bg-white/[0.06] hover:bg-white/15',
      )}
    >
      <Icon className="h-3 w-3 shrink-0 opacity-70 transition group-hover:opacity-100" />
      <span className="truncate text-[11px] leading-none text-neutral-300 transition group-hover:text-white">
        {label}
      </span>
    </button>
  );
}

/**
 * 段头（V61）：`小标题 —— 一条延伸到右端的极淡横线 —— 可选动作`。
 *
 * 「快捷入口」「我的快捷方式」共用同一个段头，是让工作台**看起来是一张设计过的卡片**
 * 而不是「几块板子拼起来」的关键：段与段之间不再画整条分隔线（那是「两块东西拼在一起」
 * 的视觉语言），改用「标题 + 淡线」把分组信息贴在内容自身的第一行上。
 */
function SectionLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-1 flex items-center gap-1.5 px-0.5">
      <span className="shrink-0 text-[10px] font-medium tracking-wide text-neutral-400/80">
        {children}
      </span>
      <span className="h-px min-w-0 flex-1 bg-white/[0.07]" />
      {action}
    </div>
  );
}

/** 工作台里的快捷入口胶囊（供 `GridOverlay` 的 children 复用同一套段头） */
export { SectionLabel as WorkstationSectionLabel };

export function DesktopWorkstation({
  shellRef,
  shellClassName,
  background,
  hot,
  collapsed,
  onToggleCollapsed,
  calendar,
  headerExtra,
  children,
  hidden,
  onAddBox,
  onAddNote,
  onArrange,
  onToggleOverlay,
  onOpenSettings,
}: DesktopWorkstationProps): React.JSX.Element {
  return (
    <div
      ref={shellRef}
      style={{ pointerEvents: 'auto', background, width: WORKSTATION_W }}
      title="工作台：日历 · 快捷入口 · 常用操作；拖图标到这里即收藏成快捷方式"
      className={cn(
        'fixed bottom-8 right-8 top-8 flex flex-col overflow-hidden rounded-2xl text-neutral-100',
        shellClassName,
        // 层级阶梯（桌面层这套 z 是有序的，改之前先看清自己在哪一级）：
        //
        //   盒子 / 竖条（无 z，DOM 顺序）< 对齐参考线 35 < **工作台 38** < 右侧面板 40 < 菜单 50 < 拖拽预览 95
        //
        // ⚠️ 工作台**必须低于面板（40）**：铺满档面板是 `right-3 w-[calc(100vw-24px)]`，
        // 横向盖住工作台所在那一列；两边同为 z-40 时谁在上只由 DOM 顺序决定，
        // 而工作台在 `GridOverlay` 里排在面板**之后** —— 结果就是面板右侧（滚动条、
        // 关闭按钮所在）被工作台压住。给 38 而不是 36/37 只是留出余量，别往下调。
        // 也别调到面板之上：面板里就有同一批快捷入口，它必须能盖住工作台。
        'z-[38]',
        hot ? 'ring-2 ring-sky-300/80' : null,
      )}
    >
      {/* 标题栏：与收纳格同一套（h-9 + 顶部渐变 + 下边框 + 11px 大写名称） */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-white/[0.06] bg-gradient-to-b from-white/[0.04] to-transparent px-3">
        <LayoutDashboard className="h-3.5 w-3.5 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider opacity-80 [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
          工作台
        </span>
        {headerExtra}
        <button
          type="button"
          onClick={onOpenSettings}
          title="设置 / Handy 主窗口"
          className="shrink-0 rounded p-1 opacity-60 transition hover:bg-white/15 hover:opacity-100"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? '展开工作台' : '收起工作台（只留标题栏）'}
          className="shrink-0 rounded p-1 opacity-60 transition hover:bg-white/15 hover:opacity-100"
        >
          {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
      </div>

      {collapsed ? null : (
        <>
          {/* 唯一的滚动容器：日历 + 快捷入口装不下时在这里滚，绝不外溢。

              V61 起**不再用整条分隔线**分段（原先是 `border-t` + `pt-1.5`）：
              用户 09-21「样式不够自然，一看那个快捷模块就是拼接上去的 要融为几个整体」——
              一条横线把卡片切成上下两块，正是「拼接」最直白的视觉语言。改由
              「段头（小标题 + 延伸淡线）+ 稍大的间距」来分组，读起来是一张卡片里的三组内容。 */}
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2 grid-scroll">
            <section aria-label="日历">{calendar}</section>
            <section aria-label="快捷入口">{children}</section>
          </div>

          {/* 操作按钮条：常驻底栏，不参与滚动（用户「现在还缺少添加便签的按钮 还有整理
              关闭整理等」——它们必须是随时点得到的那一排，不该藏在滚动区里）。
              这条分隔线留着（比别处更淡）：「常驻」与「可滚」是两个不同的区域，
              完全不留痕会让用户以为底部那排也会跟着滚走。 */}
          <div className="shrink-0 border-t border-white/[0.04] p-1.5">
            <div className="flex items-center gap-1">
              {/* 组 A：**新建**类动作（点一次多一样东西） */}
              <ActionButton
                icon={StickyNote}
                label="便签"
                title="新建一张便签（落在便签列里，可拖动 / 改色）"
                onClick={onAddNote}
              />
              <ActionButton
                icon={Plus}
                label="格子"
                title="新建一个收纳格（新建后自动解锁，可立即改名 / 拖放）"
                onClick={onAddBox}
              />
              {/* V62：一条细分隔线，把「新建」与「桌面级动作 / 模式开关」分开
                  —— 用户「开启整理和整理两个让人懵逼」，一半的锅是四颗按钮
                  等距排开、看不出哪几个是一类。 */}
              <span aria-hidden className="h-3.5 w-px shrink-0 bg-white/10" />
              {/* 组 B：**桌面级**。前一颗是一次性动作，后一颗是模式开关（描边外观）。 */}
              <ActionButton
                icon={Boxes}
                label="整理"
                title="整理桌面：按类型把桌面文件收进格子，再按内容大小重排所有格子"
                onClick={onArrange}
              />
              <ActionButton
                icon={hidden ? Eye : EyeOff}
                label={hidden ? '显示格子' : '收起格子'}
                title={
                  hidden
                    ? '显示格子：收纳格与「未归类」竖条回到桌面（系统桌面图标随之隐藏）'
                    : '收起格子：恢复系统桌面图标（工作台照旧常驻）'
                }
                onClick={onToggleOverlay}
                variant="toggle"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
