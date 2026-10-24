/**
 * 桌面网格挂件类型（与 Rust `commands/grid.rs` serde camelCase 一一对应）。
 *
 * 数据契约三方一致：迁移 SQL（`src-tauri/src/db/migrations.rs` v4 / v6 / v8 / v9）
 * = Rust 结构体（`src-tauri/src/commands/grid.rs`）= 本文件。
 *
 * 核心语义（**V37 起重定**）：格子是桌面的**呈现层**，不拥有任何文件 —— 条目只是
 * 「桌面上某个文件的引用」，拖进 / 移出 / 换格子都**只改登记，文件永不移动**
 * （腾讯桌面整理就是这个行为）。
 *
 * ⚠️ V33–V36 曾经是「真实收纳」：把文件 `fs::rename` 进 `桌面/Handy整理/<格子名>/`。
 * 那个模型已被用户明确否掉 ——「是桌面整理，不是让你把桌面上的东西都给我移动到一个
 * 目录下面去」。别再按它理解这些字段。
 */

/** 格子类型：收纳格 / 便签 / 日历（含今日计划）/ 系统入口 */
export type GridBoxKind = 'folder' | 'note' | 'calendar';

/**
 * 格子配色键。
 *
 * V35（用户反馈「便签应该可以添加多个」）：多个便签并存时必须一眼分清谁是谁。
 * 白名单与 Rust `clean_accent` 保持一致 —— 后端只认这几个，多余的回落默认色。
 */
export type GridAccent = '' | 'amber' | 'rose' | 'sky' | 'emerald' | 'violet' | 'slate';

/** 格子（`itemCount` 来自 grid_box_list 的条目计数子查询） */
export interface GridBox {
  id: number;
  name: string;
  /** 格子类型；非 folder 类型不绑目录，内容存在 content 里 */
  kind: GridBoxKind;
  /** 挂件自有数据（便签正文 / 日历配置 JSON）；收纳格为空串 */
  content: string;
  /** 配色键；`''` = 默认色（跟随格子类型） */
  accent: GridAccent;
  /**
   * 归类类别（`''` = 纯手动，不参与自动归类）。
   *
   * V37 引入：自动归类要认出「哪个格子收文档、哪个收图片」。之前靠格子名隐式匹配，
   * 用户一改名就失联；显式记字段后改名也不影响。
   */
  category: string;
  /** 几何均为逻辑像素（相对挂件窗客户区左上角） */
  posX: number;
  posY: number;
  width: number;
  height: number;
  sort: number;
  /**
   * **用户手工摆过**（V50）：用户拖过 / 拉过这个格子 ⇒ `true`。
   *
   * 布局引擎据此分两种归属：`false`（引擎摆的）每次整理都按当前列网格重新对齐；
   * `true` 原地不动（只要不重叠、不越界、不跨进挂件带）。「重新重置整理」会把它清回 false。
   */
  manual: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 格子条目：桌面上某个**真实文件**的引用（文件就住在 `filePath`，从未被搬走） */
export interface GridItem {
  id: number;
  boxId: number;
  /** 被引用文件的绝对路径（就在桌面根目录里） */
  filePath: string;
  displayName: string;
  sort: number;
  createdAt: string;
}

/**
 * 左侧「未归类」竖条里的一个条目（V42）：没被任何格子登记，身份就是磁盘路径。
 *
 * 三类来源：系统入口（`isSystem`，路径是 `::{CLSID}`）、快捷方式（`isLnk`）、
 * 以及普通落单文件 / 文件夹。
 */
export interface LooseEntry {
  path: string;
  name: string;
  isDir: boolean;
  isLnk: boolean;
  /** 系统入口（此电脑 / 回收站 / 用户的文件）：前端画专用图标 */
  isSystem: boolean;
}

/**
 * 左侧「未归类」竖条的完整状态（`grid_loose_list`）。
 *
 * 几何由 Rust 用**与收纳格同一套度量**算出（[`loose_cell_size`]），前端按
 * `columns` 列等宽网格渲染 —— 两边必须严格一致，差一列就会盖住分类格。
 * `width === 0` 表示没有未归类条目，前端不渲染。
 */
export interface LooseArea {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 分几列（V42）：竖条条目多到一列放不下时往右铺开 */
  columns: number;
  iconSize: number;
  items: LooseEntry[];
}

/** 格子创建 / 更新入参（缺省字段由 Rust 侧补默认值；更新仅写传入字段） */
export interface GridBoxInput {
  /** 缺省 = 创建新格子 */
  boxId?: number | null;
  name?: string | null;
  kind?: GridBoxKind | null;
  content?: string | null;
  /** 配色键；缺省不动（更新时）/ 用默认色（创建时） */
  accent?: GridAccent | null;
  posX?: number | null;
  posY?: number | null;
  width?: number | null;
  height?: number | null;
  sort?: number | null;
  /**
   * **用户手工摆过**（V50）：只有「用户自己拖动 / 缩放的落库」才传 `true`。
   *
   * 缺省 `null` = 不动这个标记（自动高度、改名、配色、抬层都不该把它标成手工）。
   */
  manual?: boolean | null;
}

/** 挂件层真实状态（管理页据此对齐「显示 / 隐藏格子」开关） */
export interface OverlayStatus {
  /** 挂件窗当前是否真的显示着 */
  visible: boolean;
  /** 挂件窗是否已创建（区分「没建过」与「建了但收起了」） */
  exists: boolean;
  /** 当前基准层：desktop（贴桌面）/ bottom（普通窗口） */
  attachMode: string;
  /** 系统桌面图标是否处于隐藏态 */
  iconsHidden: boolean;
  /** 桌面整理内容是否处于「接管呈现」态（true=格子在桌面；false=仅常驻工具栏，原生图标恢复） */
  engaged: boolean;
}

/**
 * 光标命中区域（挂件窗客户区内**物理像素**，前端按 scaleFactor 换算后上报）。
 * Rust 光标轮询线程据此决定挂件窗何时从点击穿透切回可交互。
 */
export interface GridRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 桌面背景右键菜单里我们注入的「新建」项被点中后，Rust 带回的新建结果（V89）。
 *
 * 取代 V88 的 `grid:item-created` 事件：命令直接把结果返回前端，前端据此决定
 * 「增量认领 + 原地改名」还是「全量对账」，桌面永不翻白、新建不再整层刷新。
 */
export interface CreatedItem {
  /** 新建项完整路径（桌面用户目录 + 显示名） */
  path: string;
  /** 显示名（含扩展名，如 `新建文件夹`、`新建文本文档.txt`） */
  name: string;
}

// —— 一键整理 / 布局备份与还原（V19）——

/** 一键整理结果摘要 */
/** Shell 真实图标数据（`grid_file_icon` 返回；RGBA 像素 base64） */
export interface FileIconData {
  width: number;
  height: number;
  rgbaBase64: string;
}

/** 桌面同步报告（`grid_desktop_sync` 返回）：**只清理失效登记**，不收录 */
export interface DesktopSyncReport {
  /** 参与对账的格子数 */
  boxes: number;
  /** 新登记的条目数（恒为 0：自动归类只由用户显式触发） */
  itemsAdded: number;
  /** 清理掉的失效登记数（引用的文件已被删 / 改名） */
  pruned: number;
}

/** 一键归类结果摘要（`grid_auto_arrange` 返回）：**只登记引用，不动任何文件** */
export interface AutoArrangeReport {
  /** 桌面根目录扫描到的可见条目数（含快捷方式 / 文件夹） */
  scanned: number;
  /** 本次登记进格子的条目数（文件 + 文件夹；文件全部原地未动） */
  itemsAdded: number;
  /** 其中文件夹占的数量 */
  foldersMoved: number;
  /** 其中快捷方式占的数量 —— **V42 起恒为 0**（快捷方式不再进格子） */
  lnkAdded: number;
  /** V42：本次扫描里没进格子、留在左侧「未归类」竖条的条目数 */
  leftOver: number;
  /**
   * V43：本次**放开**了多少个此前被「移出」拦下的路径。
   *
   * 非 0 = 用户以前手动挪出去过一些东西，这次点整理把它们重新收回来了 ——
   * 必须如实提示，否则用户会以为「怎么又自己跑回来了」。
   */
  released: number;
  /** V42：本次解散掉的历史「系统」/「快捷方式」格数量 */
  dissolvedBoxes: number;
  /** V42：本次从各格子里摘掉的快捷方式 / 系统入口登记条数（只删登记，文件不动） */
  dissolvedItems: number;
  /** 本次新建的格子数 */
  boxesCreated: number;
  /** 复用了同名已有格子的次数 */
  boxesReused: number;
  /** 按设计跳过的条目数（自己的历史收纳容器 `Handy整理*` / `Handy收纳*`） */
  skipped: number;
  /** 本次被重新排布的格子数（V38 起整理 = **全量重排**，不只摆新格子） */
  boxesLaidOut: number;
  /**
   * 按内容量调整过尺寸的格子数（V39）。
   *
   * 用户原话：「应该根据每个格子里面内容多少自动调整大小」。装了 21 个快捷方式的格子和
   * 装着 2 个文档的格子不该一样大 —— 尺寸按「单元格（图标尺寸 + 文字）→ 尽量方形」反推。
   */
  boxesResized: number;
  /**
   * 被归位到锚点的挂件数（V39）：日历 → 右上角，便签 → 左下角，其余挂件同样有固定角落。
   *
   * 以后新增挂件只要在 Rust 侧 `widget_corner` 表里加一行即可，前端无需改动。
   */
  widgetsAnchored: number;
  /** 桌面空间不足、只能压在别人身上的格子数（正常恒为 0；非 0 时界面要如实提示） */
  boxesOverflowed: number;
  /**
   * 整理后系统桌面图标是否已由格子层接管（true = 原生图标已隐藏）。
   *
   * false 通常意味着本机不支持自动隐藏（例如第三方桌面工具占着图标视图），
   * 此时桌面会同时显示格子与原图标 —— 前端要如实告诉用户。
   */
  iconsHidden: boolean;
  /** 单条目失败原因（不中断整批） */
  failures: string[];
}

/**
 * 桌面接管状态（`grid_takeover_get` / `grid_takeover_set` 返回）。
 *
 * V38：所谓「桌面整理」= **由格子层接管桌面的呈现方式**。格子里的条目是
 * 桌面文件的引用，原生图标与之区别的第二份内容就是重复 —— 所以一旦选择接管，
 * 系统桌面图标要藏起来，桌面上只留格子一份。
 */
export interface TakeoverState {
  /** 用户偏好：接管 = 隐藏原生桌面图标；关掉 = 图标与格子共存 */
  enabled: boolean;
  /** 此刻系统桌面图标是否可见（隐藏失败 / 已被收起时会与 enabled 不一致） */
  iconsVisible: boolean;
}

/** 布局快照里的单条引用 */
export interface LayoutItem {
  filePath: string;
  displayName: string;
  sort: number;
}

/** 布局快照里的单个格子 */
export interface LayoutBox {
  name: string;
  posX: number;
  posY: number;
  width: number;
  height: number;
  sort: number;
  items: LayoutItem[];
}

/**
 * 桌面布局快照（备份文件内容）。
 *
 * 语义：**只记录格子几何与文件引用**，不含文件内容 —— 还原布局不会回迁任何文件，
 * 因为整理本身从未移动过文件。
 */
export interface GridLayout {
  version: number;
  exportedAt: string;
  boxes: LayoutBox[];
}

/** 布局还原结果摘要 */
export interface LayoutImportReport {
  boxes: number;
  items: number;
  /** 快照指向的文件当前已不存在（引用照常恢复，打开时才提示） */
  missingFiles: number;
}

/** 布局快照摘要（「备份布局」列表用，不含完整布局体） */
export interface LayoutSnapshotMeta {
  id: string;
  name: string;
  savedAt: string;
  boxCount: number;
  itemCount: number;
}

// —— V37：历史收纳残留的还原 / 清理，以及桌面图标度量 ——

/**
 * 遗留收纳根目录概况（`grid_legacy_scan`，只读）。
 *
 * V33–V36 的「真实收纳」在桌面留下过 `Handy整理` / `Handy整理 (2)` … 这类目录，
 * 里面放着**被搬走的用户文件**（V36 事故还额外炸出过 4 个副本与 704 层嵌套）。
 * 还原前先把规模摆给用户看，再动手。
 */
export interface LegacyRootInfo {
  name: string;
  path: string;
  /** 将被上提回桌面的条目数（第一层容器的直接子项）；只数两层，不受上限影响 */
  entries: number;
  /** 目录内条目总数（含嵌套垃圾） */
  totalEntries: number;
  /** 其中「自己套自己」的嵌套垃圾条目数 */
  nestedEntries: number;
  bytes: number;
  /**
   * 是否因条目上限被截断。
   *
   * 事故现场实测 129,714 条 / 296 GB，而这个扫描是**打开页面就自动跑**的 ——
   * 全量遍历会让界面看起来卡死，所以 Rust 侧封顶 10,000 条/棵。
   * 为真时 `totalEntries` / `nestedEntries` / `bytes` 都应显示成「≥ N」。
   */
  truncated: boolean;
}

/** 还原结果（`grid_legacy_reclaim`）：文件**只移动，绝不删除** */
export interface ReclaimReport {
  moved: number;
  /** 桌面已有同名而跳过（副本内容与主目录重复） */
  skipped: number;
  failures: string[];
  roots: number;
  /** true = 只是预演，没动任何文件 */
  dryRun: boolean;
}

/** 清理结果（`grid_legacy_cleanup`）：删除遗留目录，含超长路径的嵌套垃圾 */
export interface CleanupReport {
  removed: number;
  freedBytes: number;
  /** 因「还有条目没撤回桌面」而被安全闸拒绝删除的目录 */
  skipped: string[];
  failures: string[];
  dryRun: boolean;
}

/** 桌面图标度量（`desktop_icon_metrics`）：让格子内图标与原生桌面一样大 */
export interface IconMetrics {
  /** 图标边长（逻辑像素） */
  iconSize: number;
  /** 图标横向间距（0 = 未读到） */
  spacing: number;
  /** 来源：registry / control-panel / default */
  source: string;
}

/** 日志文件概况（`log_info`） */
export interface LogInfo {
  dir: string;
  path: string;
  size: number;
  rotated: number;
}

