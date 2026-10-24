//! 桌面网格挂件（desktop grid widget）——**呈现层**桌面整理（V37 起重定，V38 补完）。
//!
//! ## 模型：格子是桌面的另一种呈现方式，不拥有任何文件
//!
//! 这条结论走过两轮弯路，别再按中间任何一版推理：
//!
//! | 版本 | 模型 | 结局 |
//! | --- | --- | --- |
//! | V25–V32 | 引用登记，但**不接管桌面呈现** | 桌面与格子各显示一份，用户：「并不是整理收纳，而是复制了一份而已」 |
//! | V33–V36 | 真实收纳：`fs::rename` 进 `桌面/Handy整理/<格名>/` | 用户明确否决：「是桌面整理，不是让你把桌面上的东西都给我移动到一个目录下面去，这个完全是错误的」 |
//! | **V37 起** | **呈现层**：只登记引用 + 由格子接管桌面呈现 | 现行方案 |
//!
//! 现行三条硬规矩：
//!   1. **一个字节都不挪**：拖入 / 移出 / 换格子 / 一键整理，全部只改 `grid_items`
//!      的一行登记，文件永远留在桌面原位（对标腾讯桌面整理）；
//!   2. **桌面图标交给格子代管**（V38）：既然格子里的条目就是桌面文件的引用，
//!      原生图标与之并存就是「桌面又两个相同的内容」（用户原话）。所以「接管」
//!      = 隐藏 `SysListView32`，桌面上只留格子一份；偏好记在
//!      [`META_KEY_TAKEOVER`]，收起挂件 / 退出应用立刻把图标还给系统；
//!   3. **格子建了就在**（V38）：空格子也常驻显示。曾经按「空不占位」滤掉过，
//!      用户反馈是「动不动就不见了，我找不到不见的规律到底是什么」。
//!
//! 格子同时是**挂件容器**：`kind` 区分 `folder`（收纳格）/ `note`（便签）/
//! `calendar`（日历 + 今日计划）。非 folder 类型的格子不参与条目登记，内容存在
//! `content` 列里，位置由用户自己摆 —— **自动排布会绕开它们**（见 [`FlowPlacer`]）。
//!
//! ## 桌面层挂件窗
//!
//! `grid-overlay` 无边框透明窗，用 `SetWindowPos(hwnd, 桌面宿主)` 贴在桌面窗口
//! **正上方**（V20 修复：旧实现用 `HWND_BOTTOM` 把它压到了壁纸之下，用户看到的
//! 是「格子建了但桌面上什么都没有」）。
//!
//! ## 点击穿透
//!
//! 窗口创建后即 `set_ignore_cursor_events(true)`；Rust 侧轻量轮询线程每
//! [`POLL_INTERVAL_MS`] 毫秒取全局光标位置，与前端上报的盒子区域
//! （[`grid_overlay_update_regions`]，挂件窗内**物理像素**）做命中测试，命中
//! （或前端拖拽期显式申请，见 [`grid_set_interactive`]）才切回可交互。这样透明
//! 区域始终把点击让给桌面，而盒子区域可交互、可接收文件拖放。
//!
//! ## 稳定性（V33 修复用户实测的「闪一下就没了」）
//!
//! 1. **心跳自愈只在冷启动失败时生效**：旧策略是「90 秒没心跳就销毁重建」，
//!    而 WebView2 对贴桌面层的窗口会做后台定时器节流，心跳间隔很容易被拉到 90 秒
//!    以上 → 误判成白屏 → **周期性销毁重建** → 用户看到「闪一下没了 / 又出来了」。
//!    现在只认「本次显示后从未收到过心跳」（真正的冷启动白屏），且带冷却与次数上限；
//! 2. **Z 序校验去抖**：间隔放宽到 [`REASSERT_TICKS`] 个周期，且要求连续两次
//!    判定不一致才重排 —— 避免第三方桌面工具插队时每 2 秒 `SetWindowPos` 一次；
//! 3. **生命周期日志**：`%LOCALAPPDATA%/Handy/grid-debug.log` 记录显示 / 收起 /
//!    重建 / Z 序重排，出问题可直接看文件，不靠猜。
//!
//! 数据契约：`db/migrations.rs` v4（建表）+ v6（`kind` / `content`）。
//! 三方向一致：迁移 SQL = 本文件结构体 = `src/types/grid.ts`。
//!
//! 全部命令均为 `async fn`（项目 P0 约定：同步命令会楔死 WebView2 COM STA），
//! 错误一律中文可读，SQL 一律参数化绑定。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::db;

/// 挂件窗 label（与 capabilities `windows` / `main.tsx` 的 `?window=grid-overlay` 对应）。
pub const GRID_LABEL: &str = "grid-overlay";

/// 挂件窗加载 URL（窗口分派见 `src/main.tsx` → `App.tsx`）。
const GRID_URL: &str = "index.html?window=grid-overlay";

/// `grid_meta` 中挂件窗几何的键名。
///
/// ⚠️ **V83 起已废弃**（只在 [`drop_legacy_geometry`] 里出现一次，用于清理历史脏数据）。
/// 窗口几何不再持久化：见 [`primary_work_area`] 的文件级说明。
const META_KEY_GEOMETRY: &str = "overlay_geometry";

/// 挂件窗几何被对齐到新显示器配置时广播给前端（前端收到后重排一次）。
const EVENT_BOUNDS_CHANGED: &str = "grid:bounds-changed";

/// 显示器配置复核周期（tick 数；`POLL_INTERVAL_MS` × 40 = 1 秒）。
///
/// V83：接/拔第二块屏、改分辨率或缩放、把主屏换到另一台显示器 —— 这些都会让
/// 「主显示器工作区」变掉，而用户**不一定会去点「整理」**。低频复核一次足够
/// （一次 `EnumDisplayMonitors` 级别的调用，可忽略），但必须存在：插上外接屏那一刻
/// 没人为窗口重新算几何，是用户 09-28 那张截图的第二个成因。
const BOUNDS_CHECK_TICKS: u64 = 40;

/// 判定「挂件窗已对齐主显示器工作区」的容差（物理像素）。
///
/// 非整数缩放（125% / 150% / 175%）下 `SetWindowPos` 与 `GetWindowRect` 来回换算
/// 会差 1–2px。用严格相等判断就成了**每 1 秒"纠正"一次、却永远纠正不动**的死循环：
/// 窗口每秒闪一下、前端每秒重排一次。留 2px 容差，桌面上没人看得出来。
const BOUNDS_TOLERANCE: i32 = 2;

/// 连续纠正次数上限，超了就退避（与 [`reassert_takeover`] 同一套思路）。
const BOUNDS_MAX_FIXES: u32 = 5;

/// 纠正退避时长（秒）。
const BOUNDS_BACKOFF_SECS: u64 = 300;

/// 光标轮询间隔（毫秒）。
///
/// V35：60ms → **25ms**。原因是一条实测反馈：「鼠标移上去有时候识别不到，光标没变成拖动」。
/// 根因是**先有鸡还是先有蛋** —— 挂件窗默认 `ignore_cursor_events(true)`（整窗穿透），
/// 要收到任何鼠标事件，必须先由本线程用全局光标位置判定「进区域了」再把穿透关掉。
/// 这个判定越慢，用户就越常遇到「鼠标已经在格子上、但按钮/光标样式还是桌面那套」；
/// 压着鼠标快速扫过去时甚至可能在按下的一瞬间还没切过来，于是**拖拽压根不启动**。
/// 25ms ≈ 40 次/秒，仍只是一次 `GetCursorPos` + 一次 `outer_position`，开销可忽略。
const POLL_INTERVAL_MS: u64 = 25;

/// 命中区域外扩（物理像素）。
///
/// V35：与上面的提速配套。鼠标是**连续移动**的，而判定是**离散采样**的：真实进入
/// 盒子的那一刻与前一次采样之间总会差一小段。外扩一圈（4px）让窗口提前一点变成
/// 可交互，把「扫过去来不及」的时间窗补掉。4px 小于桌面图标间距，不会明显影响
/// 贴着格子边缘点击桌面文件。
const HIT_PADDING: f64 = 4.0;

/// 「显示态却不可见」的宽限 tick 数（= 1 秒，随 [`POLL_INTERVAL_MS`] 走）。
///
/// V46：显示态（`overlay_visible = 1`）下挂件窗不可见，就直接把它 `show()` 回来 ——
/// 用户的诉求是「不管什么情况，只要是桌面都无条件显示整理」。
/// 宽限 1 秒是为了避开 show/hide 切换、Explorer 重建这类**瞬态**，
/// 又不至于长到用户察觉「桌面少了一层」。
const VISIBLE_RECOVER_TICKS: u64 = 1000 / POLL_INTERVAL_MS;

/// Z 序 / 接管自检的**时间**间隔（毫秒）。
///
/// # 为什么是「时间」而不是「多少个轮询周期」（V35 修的坑）
///
/// V34 这里是 `REASSERT_TICKS = 40`，含义随 `POLL_INTERVAL_MS` 走：当时 60ms × 40 ≈ 2.4 秒。
/// V35 为了拖拽手感把轮询提到 **25ms**，同一个 40 就悄悄变成 **1 秒** ——
/// 自检频率翻了 2.4 倍，而这一点在两边代码里都看不出来。
/// **轮询周期是「手感参数」，不该顺手改掉自愈的节奏**，所以这里改用时间。
///
/// # V46 → V48：3 秒 → 1 秒 → 250 毫秒
///
/// 用户 09-19 的原话分两次说清了同一件事：
///   · V46 之前：「点一下桌面空白处，整理好的桌面整个不见了，得去托盘折腾一会儿
///     才回来」——**被挪走之后的恢复延迟就等于用户看到的故障时长**；
///   · V48：「我 win+d 后展示桌面每次都要 1-2 秒才能显示桌面图标格子等，这个正确吗？
///     我们正常的桌面显示直接就能看到桌面内容的」。
///
/// 1 秒的自检间隔就是那个「1-2 秒」：Win+D 之后要么是原生图标被系统放回来、
/// 要么是 Z 序被桌面窗口压过去，两者都得等下一次自检才纠正。
/// 判据本身很便宜（一次 `GetWindow` 走链 / 一次 `IsWindowVisible`），窗口层级正确时
/// 一次窗口 API 都不会调，所以把间隔压到 **250ms** 不会带来重绘开销，
/// 只会把「桌面是空的 / 桌面变成两份」压缩到用户察觉不到的量级。
/// 更快的两条路径见轮询循环里 `restore_if_minimized` 命中后的**当场**重贴，
/// 以及 [`ICONS_WERE_VISIBLE`] 的状态翻转触发。
const REASSERT_INTERVAL_MS: u64 = 250;

/// 判定「我还在不在桌面上方」时，最多往下走多少个窗口。
///
/// 见 [`z_verdict`]：桌面正上方那一格是**公共地段**，中间夹几层很正常，
/// 所以判据是「往下走一小段能不能碰到桌面」，而不是「正下方必须正好是桌面」。
/// 走满这么多层还没碰到桌面，就认为「被压得很高」（同样需要纠正）。
const REASSERT_SCAN_STEPS: usize = 24;

/// 连续纠正失败多少次后，退到 [`REASSERT_GIVEUP_BACKOFF_SECS`] 的长间隔。
///
/// **这条是「永不停止地闪」的保险丝**：只要判据和现实有一点对不上，
/// 无限重试就会变成无限重排 —— 用户看到的就是「一直闪、偶尔又出来」。
/// 宁可少纠正几次，也绝不允许进入无限循环。
const REASSERT_MAX_FIXES: u32 = 5;

/// 触发保险丝后的冷却（秒）：期间只计数不再动手，过后再试一小轮。
///
/// V46：300 → **5**。旧值是把「判据和现实对不上」当成永久故障来处理的，
/// 但实测（09-19 用户机 `handy.log`：单次会话 265 条 `Z 序不对（TooHigh）`、
/// 连续 5 次后退避 300 秒）里，真正的问题是**纠正间隔太长**而不是纠正有害：
/// 5 分钟的窗口期里用户面对的正是「桌面空着」。
/// 宁可多纠正几次也不要把窗口期拉长 —— `place_above_desktop` 现在是幂等的
/// 单步 `HWND_BOTTOM`（见该函数），反复调用只会落在同一个位置，不会闪。
const REASSERT_GIVEUP_BACKOFF_SECS: u64 = 5;

/// 收纳根目录名（桌面下的一级目录；与「归类文件」共用，避免两个相似目录）。
const STORAGE_ROOT_NAME: &str = "Handy整理";

/// 收纳根目录名（历史沿用的另一个名字，作为兜底：若只存在它则继续沿用）。
const LEGACY_STORAGE_ROOT_NAME: &str = "Handy收纳";

/// 冷启动白屏宽限期（秒）：本次显示后这么久还没收到过一次心跳，才判定前端没起来。
const HEARTBEAT_COLD_START_SECS: u64 = 45;

/// 两次自动重建之间的最小间隔（秒）：冷却，避免重建风暴。
const HEARTBEAT_REBUILD_COOLDOWN_SECS: u64 = 300;

/// 单次进程内自动重建的次数上限（超过只记日志，交给用户手动「显示格子」）。
const HEARTBEAT_REBUILD_MAX: u32 = 3;


/// 前端上报的盒子命中区域（挂件窗客户区内**物理像素**）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 盒子实体（与 `grid_boxes` 表对应；`item_count` 为条目计数子查询）。
///
/// `kind`：`folder`（收纳格，绑定真实目录）/ `note`（便签）/ `calendar`（日历 +
/// 今日计划）/ `system`（此电脑 · 回收站入口）。非 `folder` 的格子不绑目录。
/// `content`：挂件自有数据（便签正文 / 日历配置 JSON），收纳格恒为空串。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridBox {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub content: String,
    /// 配色键（`''` = 默认色）。V35 引入：多个便签并存时需要一眼分清谁是谁。
    pub accent: String,
    /// 归类类别（`''` = 纯手动，不参与自动归类）。V37 引入：自动归类要认出
    /// 「哪个格子收文档、哪个收图片」，靠格子名匹配的话用户一改名就失联。
    pub category: String,
    pub pos_x: i64,
    pub pos_y: i64,
    pub width: i64,
    pub height: i64,
    pub sort: i64,
    /// **用户手工摆过**（拖过 / 拉过）—— V50 引入，见 `db::migrations::V10_GRID_MANUAL`。
    ///
    /// 布局引擎据此分两种归属：`false`（引擎摆的）每次整理都按当前列网格重新对齐；
    /// `true` 原地不动（只要不重叠、不越界、不侵入挂件带）。「重新重置整理」会把它清回 false。
    pub manual: bool,
    pub item_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 挂件条目（与 `grid_items` 表对应）。
///
/// V33 起 `file_path` 指向**收纳目录里的真实文件**（不再是指向桌面文件的引用），
/// 表本身降级为登记缓存 —— 真相在磁盘目录，每次列举时按目录对账。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridItem {
    pub id: i64,
    pub box_id: i64,
    pub file_path: String,
    pub display_name: String,
    pub sort: i64,
    pub created_at: String,
}

// —— 进程内共享状态（仅本模块使用；均为极小状态，无需托管进 Tauri State） ——

/// 前端上报的命中区域（物理像素）。空 = 视为全程穿透。
static REGIONS: Mutex<Vec<GridRegion>> = Mutex::new(Vec::new());

/// 前端交互期（拖拽/缩放/重命名）显式申请的「保持可交互」标志。
static FORCED_INTERACTIVE: AtomicBool = AtomicBool::new(false);

/// 上次**实际**施加给挂件窗的 `ignore_cursor_events`（`0` = 可交互，`1` = 穿透，
/// [`IGNORE_UNKNOWN`] = 尚未施加 / 缓存已失效）。
///
/// # 为什么它必须是共享原子，而不能是轮询线程的局部变量（V61 修的真 bug）
///
/// [`grid_set_interactive`]（前端按下 / 抬起条目时调）也会改这个状态。局部缓存看不见
/// 那次改动 —— 于是出现这种时序：轮询刚把窗口设成「可交互」并记下 `Some(false)`；
/// 前端抬起鼠标调 `grid_set_interactive(false)` 直接把窗口设成**穿透**（缓存没变，仍是
/// `Some(false)`）；轮询下一拍算出「光标压在条目上 → 该可交互」，`!want == false` 与
/// 缓存**相等** ⇒ **判定为「不用改」，跳过 `set`** ⇒ 窗口永久停在穿透态。
///
/// 症状就是用户 09-21 反馈的：「双击打开我的电脑 / 打开某个文件夹现在都做不到了，
/// 双击没反应」（第一次点击的 `mouseup` 之后就穿透了，第二次点击落到下层桌面，
/// 浏览器永远凑不齐 `dblclick`）。而**右键不受影响** —— 右键走 `onContextMenu`，
/// 不经过 `beginDragSession`，窗口状态没被改过。
///
/// 放成共享原子后两边同源：谁改谁记账，轮询与命令路径再也不会各说各话。
static POLLER_IGNORE: AtomicU8 = AtomicU8::new(IGNORE_UNKNOWN);

/// [`POLLER_IGNORE`] 的「未知 / 缓存失效」哨兵值。
const IGNORE_UNKNOWN: u8 = 255;

/// 光标轮询线程是否在运行（保证 show 多次只起一个线程；窗口销毁后线程自退出）。
static POLLER_RUNNING: AtomicBool = AtomicBool::new(false);

// —— DB 辅助 ——

/// 打开独立短连接（每次命令新建；WAL + 外键约束，与 sql 插件同文件，同 notes 约定）。
fn connect(app: &AppHandle) -> Result<Connection, String> {
    let path = db::db_path(app)?;
    db::open(&path)
}

/// 当前本地时间（ISO 片段 `YYYY-MM-DD HH:MM:SS`，与 vault 等表的时间语义一致）。
fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 盒子列前缀（别名 `b`）。
const BOX_COLUMNS: &str = "b.id, b.name, b.kind, b.content, b.accent, b.category, b.pos_x, b.pos_y, \
                           b.width, b.height, b.sort, b.manual, b.created_at, b.updated_at";

/// 行 → 盒子实体（SQL 必须附带 `item_count` 计数列）。
fn row_to_box_with_count(row: &Row) -> rusqlite::Result<GridBox> {
    Ok(GridBox {
        id: row.get("id")?,
        name: row.get("name")?,
        kind: row.get("kind")?,
        content: row.get("content")?,
        accent: row.get("accent")?,
        category: row.get("category")?,
        pos_x: row.get("pos_x")?,
        pos_y: row.get("pos_y")?,
        width: row.get("width")?,
        height: row.get("height")?,
        sort: row.get("sort")?,
        item_count: row.get("item_count")?,
        manual: row.get::<_, i64>("manual")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 行 → 条目实体。
fn row_to_item(row: &Row) -> rusqlite::Result<GridItem> {
    Ok(GridItem {
        id: row.get("id")?,
        box_id: row.get("box_id")?,
        file_path: row.get("file_path")?,
        display_name: row.get("display_name")?,
        sort: row.get("sort")?,
        created_at: row.get("created_at")?,
    })
}

/// 按 id 读取单个盒子（不存在返回中文错误）。
fn load_box(app: &AppHandle, box_id: i64) -> Result<GridBox, String> {
    let conn = connect(app)?;
    let sql = format!(
        "SELECT {BOX_COLUMNS}, \
         (SELECT COUNT(*) FROM grid_items i WHERE i.box_id = b.id) AS item_count \
         FROM grid_boxes b WHERE b.id = ?1"
    );
    match conn.query_row(&sql, params![box_id], row_to_box_with_count) {
        Ok(entity) => Ok(entity),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(format!("盒子不存在或已被删除（id={box_id}）"))
        }
        Err(err) => Err(format!("查询盒子失败：{err}")),
    }
}

/// 名称清洗：去首尾空白，空则用缺省名。
fn clean_name(name: Option<String>) -> String {
    match name {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                "新盒子".to_string()
            } else {
                trimmed.to_string()
            }
        }
        None => "新盒子".to_string(),
    }
}

// —— 收纳目录：V33–V36 的「真实收纳」层已随 V37 的呈现层模型作废 ——
//
// 曾经这里有一整套 `storage_root()` / `box_dir()` / `ensure_dir()` / `list_dir_items()`：
// 格子 = `桌面/Handy整理/<格子名>/` 的真实目录，拖入即 `fs::rename`。
// V37 用户明确否掉后，这些函数全部成了无人调用的死代码（`grid_box_delete` 还在
// 偷偷删空目录，V38 也一并拔掉了）。
//
// 保留 `STORAGE_ROOT_NAME` / `LEGACY_STORAGE_ROOT_NAME` 两个常量 —— 它们不再是
// 「我们要写的目录」，而是「**永远不许进格子 / 永远不许参与归类**的目录名前缀」
// （见 [`is_storage_entry`]），以及「诊断与修复」卡片的扫描目标。
//
// 桌面上那批历史遗留目录请走 [`grid_legacy_reclaim`] / [`grid_legacy_cleanup`]：
// 先干跑预览、只移动不删除、桌面已有同名就跳过。

/// 桌面根目录。
fn desktop_root() -> Result<PathBuf, String> {
    dirs::desktop_dir().ok_or_else(|| "无法定位桌面目录".to_string())
}

/// **公共桌面**（`%PUBLIC%\Desktop`）。
///
/// 这里放的是「所有用户」的快捷方式（微信 / QQ / Chrome / PyCharm / ToDesk / 钉钉 …），
/// Windows 会把它们和用户自己的桌面**合并显示** —— 用户看得见，所以整理时必须算上。
/// 取不到（非 Windows / 精简系统 / 目录不存在）就返回 `None`，不是错误。
fn public_desktop_root() -> Option<PathBuf> {
    let base = std::env::var_os("PUBLIC")?;
    let dir = PathBuf::from(base).join("Desktop");
    dir.is_dir().then_some(dir)
}

/// 一键整理要扫的**全部桌面根**：用户桌面 + 公共桌面（V40）。
///
/// 为什么必须两个都扫：只扫用户桌面时，公共桌面那批快捷方式**永远不会进格子**，
/// 而它们就在桌面上显示着 —— 用户的原话是「你看桌面上面那么多文件文件夹都没有整理好呢」。
/// （Windows 桌面本来就是把两个目录合并显示的，只整理一半，看着就永远是「没整完」。）
fn desktop_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(dir) = desktop_root() {
        roots.push(dir);
    }
    if let Some(public) = public_desktop_root() {
        if !roots.contains(&public) {
            roots.push(public);
        }
    }
    roots
}

/// 冲突安全移动：目标同名时自动追加 ` (2)`、` (3)` …，**绝不覆盖**。
///
/// ⚠️ 函数体开头有一道「目标不在源之内」的闸 —— 见 [`is_storage_entry`] 里记的那次
/// 事故：漏掉这道闸，一次误操作就能在磁盘上炸出几百层嵌套、上百 GB 的副本。
fn move_with_conflict_rename(src: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    // —— 血案防线（V37 立）——
    // 把目录移进它自己的子目录时，`fs::rename` 必然失败，随后会走到「递归复制 + 删源」
    // 的兜底路径：`copy_dir_recursive` 先 `create_dir_all(dest)` 再遍历源，而 dest 就在源
    // 内部 ⇒ 遍历会看见刚建出的目标并继续递归，一次调用就无限自我复制（磁盘取证：
    // `桌面\Handy整理\新格子 1\Handy整理\新格子 1\…` 重复约 1000 次、路径 7082 字符、
    // 5 份副本共 296 GB）。必须在**任何**磁盘操作之前拦下。
    if src.is_dir() {
        let src_norm = normalize_path(src);
        let dest_norm = normalize_path(dest_dir);
        if dest_norm == src_norm || dest_norm.starts_with(&src_norm) {
            return Err(format!(
                "拒绝把目录移动到它自己里面（{} → {}）",
                src.display(),
                dest_dir.display()
            ));
        }
    }
    let file_name = src
        .file_name()
        .ok_or_else(|| format!("无法从路径取文件名：{}", src.display()))?
        .to_string_lossy()
        .to_string();
    let file_path = Path::new(&file_name);
    let stem = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.clone());
    let ext = file_path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();

    let mut target = dest_dir.join(&file_name);
    let mut index = 2;
    while target.exists() {
        if index > 999 {
            return Err(format!("目标目录同名文件过多，无法移动：{file_name}"));
        }
        target = dest_dir.join(format!("{stem} ({index}){ext}"));
        index += 1;
    }

    match std::fs::rename(src, &target) {
        Ok(()) => Ok(target),
        Err(err) => {
            // 跨卷移动（`fs::rename` 不支持）→ 退化成「复制 + 删除源」。
            //
            // ⚠️ 目录必须走递归复制：`std::fs::copy` 只能复制单个文件，对目录会直接
            // 报错。V34 把文件夹纳入收纳之后，这条路径才真正会被踩到（桌面被重定向
            // 到另一个盘时，`fs::rename` 必然失败）。
            if src.is_dir() {
                copy_dir_recursive(src, &target).map_err(|copy_err| {
                    format!("移动失败（{err}）；目录复制兜底也失败：{copy_err}")
                })?;
                std::fs::remove_dir_all(src)
                    .map_err(|remove_err| format!("目录复制成功但删除原目录失败：{remove_err}"))?;
                return Ok(target);
            }
            std::fs::copy(src, &target)
                .map_err(|copy_err| format!("移动失败（{err}）；复制兜底也失败：{copy_err}"))?;
            std::fs::remove_file(src)
                .map_err(|remove_err| format!("复制成功但删除原文件失败：{remove_err}"))?;
            Ok(target)
        }
    }
}

/// 递归复制目录（跨卷移动文件夹时的兜底）。
///
/// 标准库只提供「复制单个文件」，目录得自己走下去。失败一律原样上抛 ——
/// 调用方会把它拼进中文错误里，不做静默吞错。
fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 某盒子的登记条目（按 sort 升序、id 升序稳定排序）。
fn list_registry_items(conn: &Connection, box_id: i64) -> Result<Vec<GridItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, box_id, file_path, display_name, sort, created_at \
             FROM grid_items WHERE box_id = ?1 ORDER BY sort ASC, id ASC",
        )
        .map_err(|err| format!("查询挂件条目失败：{err}"))?;
    let items = stmt
        .query_map(params![box_id], row_to_item)
        .map_err(|err| format!("查询挂件条目失败：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取挂件条目失败：{err}"))?;
    Ok(items)
}

/// 某格子的条目列表（引用模型：**登记是真相，磁盘只做存在性校验**）。
///
/// V37 起不再「按磁盘目录对账」—— 格子不再拥有目录，条目就是桌面上某个文件的引用。
/// 文件被用户在资源管理器里删掉 / 改名后登记会失效，这里直接过滤并清行，
/// 免得格子里留一个点不动的幽灵图标。
fn list_live_items(conn: &Connection, box_id: i64) -> Result<Vec<GridItem>, String> {
    let registered = list_registry_items(conn, box_id)?;
    let mut live = Vec::with_capacity(registered.len());
    let mut pruned: Vec<i64> = Vec::new();
    for item in registered {
        // 虚拟条目（`::{CLSID}`，如「此电脑 / 回收站」）在磁盘上本就不存在 ——
        // 用 `exists()` 判会当场把它当成失效登记清掉，表现为「系统格子一刷新就空」。
        // V38 起显式豁免（`grid_open_path` 早已支持打开这类路径）。
        if item.file_path.starts_with("::") || Path::new(&item.file_path).exists() {
            live.push(item);
        } else {
            pruned.push(item.id);
        }
    }
    for id in pruned {
        conn.execute("DELETE FROM grid_items WHERE id = ?1", params![id])
            .map_err(|err| format!("清理失效条目失败：{err}"))?;
    }
    Ok(live)
}

/// 把某个**已存在**的路径登记进某格子（幂等）。**不移动任何文件** —— 这是 V37 引用模型
/// 唯一的写入通道，自动归类与手动拖入都走它。
///
/// 返回 `Ok(true)` = 新增了一条登记；`Ok(false)` = 按规则跳过（已有 / 用户说过不要 /
/// 已归属别的格子）。跳过不是错误，所以不进 `failures`。
fn register_item(
    conn: &Connection,
    box_id: i64,
    path: &Path,
    display: &str,
) -> Result<bool, String> {
    let stored = path.to_string_lossy().to_string();
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM grid_items WHERE box_id = ?1 AND file_path = ?2",
            params![box_id, stored],
            |row| row.get(0),
        )
        .map_err(|err| format!("检查登记失败：{err}"))?;
    if exists > 0 {
        return Ok(false);
    }
    // 用户明确说过「不要它」→ 尊重用户，自动归类不再加回来
    // （他重新拖进格子时会走 `clear_dismissed` 解禁）
    if read_dismissed(conn)?.contains(&stored) {
        return Ok(false);
    }
    // 归属唯一：已经在别的格子里的，不重复登记（用户想换位置应该拖动它）
    let elsewhere: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM grid_items WHERE file_path = ?1",
            params![stored],
            |row| row.get(0),
        )
        .map_err(|err| format!("检查归属失败：{err}"))?;
    if elsewhere > 0 {
        return Ok(false);
    }
    let sort = next_sort(
        conn,
        "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_items WHERE box_id = ?1",
        Some(box_id),
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO grid_items (box_id, file_path, display_name, sort, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![box_id, stored, display, sort, now_iso()],
    )
    .map_err(|err| format!("登记条目失败：{err}"))?;
    Ok(true)
}

/// 格子类型白名单：未知值一律回落成收纳格（`folder`），不制造半残数据。
fn clean_kind(kind: Option<String>) -> String {
    match kind.as_deref() {
        Some("note") => "note".to_string(),
        Some("calendar") => "calendar".to_string(),
        // V34 起「系统格」已取消（用户要求：原生快捷方式不动态整理）；v7 迁移把历史
        // 系统格删掉了。这里不再接受 system，免得哪天有调用方又把它造回来。
        _ => "folder".to_string(),
    }
}

/// 配色键清洗：只认**一眼分辨率高、色相区分大**的固定几个键，其余一律回落默认。
///
/// 白名单而不是「随便存字符串」的原因：颜色最终要映射到 Tailwind 类名/内联色值，
/// 让任意字符串流进样式是没必要的风险面；而用户也确实只需要「这几个能分清」。
fn clean_accent(accent: Option<String>) -> String {
    match accent.as_deref() {
        Some("amber") | Some("rose") | Some("sky") | Some("emerald") | Some("violet")
        | Some("slate") => accent.unwrap_or_default(),
        _ => String::new(),
    }
}

/// 读取「下一个排序值」。
///
/// `bind = Some(id)` 用于**带 `?1` 占位符**的 SQL（盒子内条目求最大值）；
/// `bind = None` 用于**完全不带占位符**的 SQL（全表求最大值）。
///
/// 二者必须显式区分：对无占位符的 SQL 传入参数会触发 rusqlite
/// `Wrong number of parameters passed to query. Got 1, needed 0`，
/// 这正是此前「添加盒子 / 添加挂件条目一律失败」的根因。
fn next_sort(conn: &Connection, sql: &str, bind: Option<i64>) -> Result<i64, String> {
    let outcome = match bind {
        Some(value) => conn.query_row(sql, params![value], |row| row.get(0)),
        None => conn.query_row(sql, [], |row| row.get(0)),
    };
    outcome.map_err(|err| format!("读取排序值失败：{err}"))
}

// —— 盒子 CRUD ——

/// 盒子列表（含条目计数；按 sort 升序、id 升序稳定排序）。
#[tauri::command]
pub async fn grid_box_list(app: AppHandle) -> Result<Vec<GridBox>, String> {
    let conn = connect(&app)?;
    let sql = format!(
        "SELECT {BOX_COLUMNS}, \
         (SELECT COUNT(*) FROM grid_items i WHERE i.box_id = b.id) AS item_count \
         FROM grid_boxes b ORDER BY b.sort ASC, b.id ASC"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("查询盒子列表失败：{err}"))?;
    let boxes = stmt
        .query_map([], row_to_box_with_count)
        .map_err(|err| format!("查询盒子列表失败：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取盒子列表失败：{err}"))?;
    Ok(boxes)
}

/// 创建盒子的 INSERT —— 抽成常量是为了让「试探会不会排不下」（[`probe_room_for_another_box`]）
/// 与真正的插入**用的是同一条语句**：两边只要有一点不一样，试探就等于没试。
const INSERT_BOX_SQL: &str = "INSERT INTO grid_boxes \
     (name, kind, content, accent, pos_x, pos_y, width, height, sort, created_at, updated_at) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)";

/// **桌面还装得下下一个格子吗**（V70）—— 装不下就返回一句给用户看的理由。
///
/// 用户 09-23：「格子太多后还是出现了滚动条，我建议如果放不下了就提醒用户不能因为空间有限
/// 不能创建更多格子，不然逻辑没法实现了」。以前的实现是「照建不误，排不下就出滚动条」，
/// 于是用户点一次「+ 格子」换来一屏滚动条 + 十几个被压扁的格子（真机：21 个格子占高
/// 979 > 可用 848）。
///
/// 判据不自己猜，而是**让引擎自己回答**：在立刻回滚的 `SAVEPOINT` 里把这条新格子真的插进去、
/// 真的排一遍，看有没有格子越过下边界（`LayoutOutcome::overflowed`）。
/// 布局只吃 `&Connection`、不碰窗口也不发事件 ⇒ 这一趟**对外零副作用**：用户库里的格子
/// 一个都没动过，`ROLLBACK TO` 之后连 `last_insert_rowid` 都退回去。
///
/// ⚠️ 试探本身出错（SAVEPOINT 建不起来 / 插入失败 / 布局报错）一律**当成还装得下**：
/// 宁可让用户建出来，也不能因为「量尺子」失败就把人挡在门外。
///
/// `loose_count`（落单条目数）由调用方给：与 [`layout_all_boxes_with`] 同一个口径 ——
/// 单测注入固定值，不依赖跑测试那台机器的桌面长什么样。
fn probe_room_for_another_box(
    conn: &Connection,
    work_w: i64,
    work_h: i64,
    icon: i64,
    loose_count: usize,
    insert: impl FnOnce(&Connection) -> rusqlite::Result<()>,
) -> Option<String> {
    /// 试探用的保存点（必须与任何真实事务区分开）
    const SP: &str = "handy_room_probe";

    if conn.execute_batch(&format!("SAVEPOINT {SP}")).is_err() {
        return None;
    }
    let outcome = match insert(conn) {
        Ok(()) => layout_all_boxes_with(conn, work_w, work_h, icon, loose_count, LayoutMode::Fill),
        Err(_) => Err("试探插入失败".to_string()),
    };
    let _ = conn.execute_batch(&format!("ROLLBACK TO {SP}; RELEASE {SP};"));

    match outcome {
        Ok(o) if o.overflowed == 0 => None,
        Ok(_) => Some(
            "桌面已经排满了：再来一个格子就会超出屏幕（那正是滚动条的来源），所以这次没有新建。\
             先删掉一个格子、或把某个格子里的图标清掉一些，再试一次。"
                .to_string(),
        ),
        Err(_) => None,
    }
}

/// 创建（`boxId` 缺省）或更新盒子（几何 / 名称 / 排序），返回落库后的完整实体。
///
/// 更新只写传入的字段（`None` 跳过）；创建时缺省值：名称「新盒子」、位置按毫秒
/// 散列级联摆放（避免新盒子完全重叠）、320×220、排序追加到末尾。
#[tauri::command]
pub async fn grid_box_upsert(
    app: AppHandle,
    box_id: Option<i64>,
    name: Option<String>,
    kind: Option<String>,
    content: Option<String>,
    accent: Option<String>,
    pos_x: Option<i64>,
    pos_y: Option<i64>,
    width: Option<i64>,
    height: Option<i64>,
    sort: Option<i64>,
    // **用户手工摆过**（V50）：前端只在自己拖 / 拉格子落库时带 `true`；
    // 「重新重置整理」由布局引擎把全表清回 `false`。缺省 = 不动这个标记。
    manual: Option<bool>,
) -> Result<GridBox, String> {
    // 尺寸下限（与前端 MIN_BOX_W/H 一致），防止把盒子拖没
    const MIN_W: i64 = 160;
    const MIN_H: i64 = 120;

    match box_id {
        None => {
            let now = now_iso();
            let conn = connect(&app)?;
            let (work_w, work_h) = layout_work_size(&app);
            // 宽度的缺省值跟随**现有格子的统一列宽**（V40）—— 新格子若自成一个宽度，
            // 桌面立刻又参差不齐，而用户点「+」时最不想看到的就是「刚加一个就乱了」。
            let final_width = width
                .unwrap_or_else(|| existing_standard_width(&conn, work_w))
                .max(MIN_W);
            let final_height = height.unwrap_or(220).max(MIN_H);

            // 全表求最大值 → 该 SQL 无占位符，必须传 None
            let final_sort = match sort {
                Some(s) => s,
                None => next_sort(&conn, "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_boxes", None)?,
            };
            // 缺省落点：先落**未落位哨兵** `(0, 0)`，紧接着由布局引擎安置（见下面
            // 那次 `layout_all_boxes(Fill)`）。
            //
            // V48 及以前这里走 `free_slot_for`（用 `FlowPlacer` 找一块空位），那是 V38 的
            // 「左起流布」算法，与 V48 的分区模型**不是同一套规则**：桌面一满它就退回
            // `(32, 32)`（正好压在左侧「未归类」竖条上），而且它不认得「便签列 / 收纳列」，
            // 新格子永远落在「见缝插针」的位置上（用户 09-19：「新加格子和便签后都要重新
            // 计算更美观合理的展示」）。
            let (auto_x, auto_y) = (0_i64, 0_i64);

            // 清洗一遍就定下来：试探插入与真正插入**必须落完全一样的值**（否则试探等于没试）
            let box_name = clean_name(name);
            let box_kind = clean_kind(kind);
            let box_content = content.unwrap_or_default();
            let box_accent = clean_accent(accent);

            // —— V70：**放不下就别再建**（用户 09-23）——
            //
            // 原话：「格子太多后还是出现了滚动条，我建议**如果放不下了就提醒用户不能因为
            // 空间有限不能创建更多格子**，不然逻辑没法实现了」。
            //
            // 之前的做法是「照建不误，排不下就让前端那层出滚动条」—— 于是用户点一次「+ 格子」，
            // 得到的是一屏滚动条 + 被压扁的十几个格子（真机：21 个格子占高 979 > 可用 848）。
            //
            // 判据不是「数格子」而是**让引擎自己回答**：在立刻回滚的 `SAVEPOINT` 里把这条
            // 新格子真的插进去、真的排一遍，看它会不会越过下边界。布局只吃 `&Connection`、
            // 不碰窗口也不发事件 ⇒ 这一趟**对外零副作用**，`ROLLBACK TO` 之后连
            // `last_insert_rowid` 都退回去，紧接着的正常插入与以前一模一样。
            //
            // ⚠️ 只挡**收纳格**（挂件有自己那条带，容量由 `place_widget_columns` 决定，
            // 不由这里管）；显式给了落点的（用户自己摆）也不挡 —— 那是「我就放这儿」。
            if pos_x.is_none() && pos_y.is_none() && is_content_kind(&box_kind) {
                // 落单条目数与随后那次真布局同口径（`layout_all_boxes` 内部也是这么取的）
                let loose_count = match loose_desktop_items(&conn) {
                    Ok(items) => items.len(),
                    Err(err) => {
                        grid_log(&format!("统计落单条目失败（试探按 0 算）：{err}"));
                        0
                    }
                };
                if let Some(reason) = probe_room_for_another_box(
                    &conn,
                    work_w,
                    work_h,
                    layout_icon_size(),
                    loose_count,
                    |probe| {
                        probe.execute(
                            INSERT_BOX_SQL,
                            params![
                                &box_name,
                                &box_kind,
                                &box_content,
                                &box_accent,
                                auto_x,
                                auto_y,
                                final_width,
                                final_height,
                                final_sort,
                                &now,
                                &now,
                            ],
                        )?;
                        Ok(())
                    },
                ) {
                    grid_log(&format!("新建格子被拒（桌面已满，未落库）：{reason}"));
                    return Err(reason);
                }
            }

            conn.execute(
                INSERT_BOX_SQL,
                params![
                    box_name,
                    box_kind,
                    box_content,
                    box_accent,
                    pos_x.unwrap_or(auto_x),
                    pos_y.unwrap_or(auto_y),
                    final_width,
                    final_height,
                    final_sort,
                    now,
                    now,
                ],
            )
            .map_err(|err| format!("创建盒子失败：{err}"))?;
            let created = conn.last_insert_rowid();
            // 建完立刻跑一次「增量补齐」布局：新建的格子（含便签 / 日历）由分区模型安置到
            // 它该在的列里，而用户已经摆好的格子原地不动。
            if let Err(err) =
                layout_all_boxes(&conn, work_w, work_h, layout_icon_size(), LayoutMode::Fill)
            {
                grid_log(&format!(
                    "新建格子后自动落位失败（格子仍在默认位，下次整理会归位）：{err}"
                ));
            }
            load_box(&app, created)
        }
        Some(id) => {
            // V37：格子不再绑定磁盘目录，改名就只是改个名字 —— 早期这里会连带
            // `fs::rename` 收纳目录，那属于「动用户文件」的一部分，随收纳模型一并移除。
            //
            // 动态 SET：只更新显式传入的字段
            let mut sets: Vec<&'static str> = Vec::new();
            let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            if let Some(v) = name {
                sets.push("name = ?");
                values.push(Box::new(clean_name(Some(v))));
            }
            if let Some(v) = kind {
                sets.push("kind = ?");
                values.push(Box::new(clean_kind(Some(v))));
            }
            if let Some(v) = content {
                sets.push("content = ?");
                values.push(Box::new(v));
            }
            if let Some(v) = accent {
                sets.push("accent = ?");
                values.push(Box::new(clean_accent(Some(v))));
            }
            if let Some(v) = pos_x {
                sets.push("pos_x = ?");
                values.push(Box::new(v));
            }
            if let Some(v) = pos_y {
                sets.push("pos_y = ?");
                values.push(Box::new(v));
            }
            if let Some(v) = width {
                sets.push("width = ?");
                values.push(Box::new(v.max(MIN_W)));
            }
            if let Some(v) = height {
                sets.push("height = ?");
                values.push(Box::new(v.max(MIN_H)));
            }
            if let Some(v) = sort {
                sets.push("sort = ?");
                values.push(Box::new(v));
            }
            if let Some(v) = manual {
                sets.push("manual = ?");
                values.push(Box::new(if v { 1_i64 } else { 0_i64 }));
            }

            let conn = connect(&app)?;
            if !sets.is_empty() {
                let sql = format!(
                    "UPDATE grid_boxes SET {}, updated_at = ? WHERE id = ?",
                    sets.join(", ")
                );
                let now = now_iso();
                let mut bind: Vec<&dyn rusqlite::ToSql> =
                    values.iter().map(|b| b.as_ref()).collect();
                bind.push(&now);
                bind.push(&id);
                let affected = conn
                    .execute(sql.as_str(), bind.as_slice())
                    .map_err(|err| format!("更新盒子失败：{err}"))?;
                if affected == 0 {
                    return Err(format!("盒子不存在或已被删除（id={id}）"));
                }
            }
            load_box(&app, id)
        }
    }
}

/// 删除格子。**只删格子与它的登记，绝不碰磁盘**（V38）。
///
/// V33–V36 在这里还会顺手删掉「已经空了的收纳目录」—— 那是「格子 = 真实目录」模型
/// 的遗留。V37 换回呈现层后，格子与磁盘再无任何关系，用户桌面上的任何目录
/// （包括历史遗留的 `Handy整理/`）都只由「诊断与修复」卡片经用户确认后处理。
#[tauri::command]
pub async fn grid_box_delete(app: AppHandle, box_id: i64) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute("DELETE FROM grid_boxes WHERE id = ?1", params![box_id])
        .map_err(|err| format!("删除盒子失败：{err}"))?;
    if affected == 0 {
        return Err(format!("盒子不存在或已被删除（id={box_id}）"));
    }
    // grid_items 由外键 ON DELETE CASCADE 自动清理（db::open 已启用 foreign_keys）
    Ok(())
}

/// 写挂件数据（便签正文 / 日历配置 JSON 等）。收纳格一般不使用。
#[tauri::command]
pub async fn grid_box_set_content(
    app: AppHandle,
    box_id: i64,
    content: String,
) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute(
            "UPDATE grid_boxes SET content = ?1, updated_at = ?2 WHERE id = ?3",
            params![content, now_iso(), box_id],
        )
        .map_err(|err| format!("保存挂件数据失败：{err}"))?;
    if affected == 0 {
        return Err(format!("盒子不存在或已被删除（id={box_id}）"));
    }
    Ok(())
}

// —— 条目 CRUD（V37 呈现层：只是「哪个文件显示在哪个格子里」的登记，
//    三个写入口都不会对磁盘做任何增删改） ——

/// 把文件登记进某个收纳格 —— **只登记，文件一个字节都不动**（V37 起）。
///
/// V33–V36 走的是「真实收纳」：把文件 `fs::rename` 进 `桌面/Handy整理/<格子名>/`。
/// 用户装机实测后明确否掉了这个模型 ——「是桌面整理，不是让你把桌面上的东西都给我移动
/// 到一个目录下面去」。于是回到真正桌面工具的语义：**文件永远留在原处，格子只是桌面上
/// 这批图标的呈现层**（腾讯桌面整理就是这个行为）。
///
/// - 同一文件已在别的格子 → 视作「把它挪到这儿」，只改归属，不新增登记；
/// - `Handy整理*` 目录本身永远不许进格子（V36 事故的入口之一）；
/// - 登记前清掉该路径在「不要它」名单里的记录（用户重新拖进来就是改主意了）。
#[tauri::command]
pub async fn grid_item_add(
    app: AppHandle,
    box_id: i64,
    file_path: String,
    display_name: Option<String>,
) -> Result<GridItem, String> {
    let raw = file_path.trim().to_string();
    if raw.is_empty() {
        return Err("文件路径为空".to_string());
    }
    let source = PathBuf::from(&raw);
    if !source.exists() {
        return Err(format!("文件不存在：{raw}"));
    }
    if let Some(name) = source.file_name().and_then(|value| value.to_str()) {
        if is_storage_entry(name) {
            return Err("这是 Handy 自己的收纳目录，不能放进格子".to_string());
        }
    }
    let entity = load_box(&app, box_id)?;
    if entity.kind != "folder" {
        return Err("该格子不是收纳格，不能放文件".to_string());
    }
    let stored = source.to_string_lossy().to_string();
    let conn = connect(&app)?;
    let display = match display_name {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| stored.clone()),
    };
    clear_dismissed(&conn, &stored)?;

    // 已在某个格子里（含本格）→ 只改归属，不新增登记
    if let Some((item_id, current_box)) = conn
        .query_row(
            "SELECT id, box_id FROM grid_items WHERE file_path = ?1",
            params![stored],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .ok()
    {
        if current_box != box_id {
            // 目标格若已有同路径的陈旧登记，先清掉，避免同一文件在目标格出现两行
            conn.execute(
                "DELETE FROM grid_items WHERE box_id = ?1 AND file_path = ?2",
                params![box_id, stored],
            )
            .map_err(|err| format!("更新条目归属失败：{err}"))?;
            let sort = next_sort(
                &conn,
                "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_items WHERE box_id = ?1",
                Some(box_id),
            )?;
            conn.execute(
                "UPDATE grid_items SET box_id = ?1, sort = ?2, display_name = ?3 WHERE id = ?4",
                params![box_id, sort, display, item_id],
            )
            .map_err(|err| format!("更新条目归属失败：{err}"))?;
            grid_log(&format!(
                "条目「{display}」改归属到格子「{}」（文件未移动）",
                entity.name
            ));
        }
        return conn
            .query_row(
                "SELECT id, box_id, file_path, display_name, sort, created_at \
                 FROM grid_items WHERE id = ?1",
                params![item_id],
                row_to_item,
            )
            .map_err(|err| format!("读取条目失败：{err}"));
    }

    let sort = next_sort(
        &conn,
        "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_items WHERE box_id = ?1",
        Some(box_id),
    )?;
    let created = now_iso();
    conn.execute(
        "INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![box_id, stored, display, sort, created],
    )
    .map_err(|err| format!("登记收纳条目失败：{err}"))?;
    grid_log(&format!(
        "登记「{display}」到格子「{}」（文件留在 {stored}，未移动）",
        entity.name
    ));

    Ok(GridItem {
        id: conn.last_insert_rowid(),
        box_id,
        file_path: stored,
        display_name: display,
        sort,
        created_at: created,
    })
}

/// 把条目移出格子 —— **只删登记，文件原位不动、更不删除**（V37 起）。
///
/// 同时把路径记入「不要它」名单：否则下一次自动归类又会把它塞回同一个格子，
/// 用户看到的是「点了 × 却怎么都去不掉」。
///
/// `dismiss` 是旧版前端参数（曾经表示「不再自动收录」），保留形参以免旧调用报错。
#[tauri::command]
pub async fn grid_item_delete(
    app: AppHandle,
    item_id: i64,
    dismiss: Option<bool>,
) -> Result<(), String> {
    let _ = dismiss;
    let conn = connect(&app)?;
    let (path, box_id): (String, i64) = conn
        .query_row(
            "SELECT file_path, box_id FROM grid_items WHERE id = ?1",
            params![item_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "挂件条目不存在或已被删除".to_string())?;
    let entity = load_box(&app, box_id)?;

    let mut set = read_dismissed(&conn)?;
    set.insert(path.clone());
    let _ = write_dismissed(&conn, &set);

    let affected = conn
        .execute("DELETE FROM grid_items WHERE id = ?1", params![item_id])
        .map_err(|err| format!("删除挂件条目失败：{err}"))?;
    if affected == 0 {
        return Err("挂件条目不存在或已被删除".to_string());
    }
    let short = Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    grid_log(&format!(
        "从格子「{}」移出「{short}」（文件未删除，仍在 {path}）",
        entity.name
    ));
    Ok(())
}

/// 把一个条目挪到另一个格子 —— **只改归属，文件原位不动**（V37 起）。
#[tauri::command]
pub async fn grid_item_move(
    app: AppHandle,
    item_id: i64,
    target_box_id: i64,
) -> Result<(), String> {
    let conn = connect(&app)?;
    let path: String = conn
        .query_row(
            "SELECT file_path FROM grid_items WHERE id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .map_err(|_| "挂件条目不存在或已被删除".to_string())?;
    let target = load_box(&app, target_box_id)?;
    if target.kind != "folder" {
        return Err("目标不是收纳格，不能放文件".to_string());
    }
    // 目标格若已有同路径的陈旧登记 → 先删掉，避免同一文件在目标格出现两行
    conn.execute(
        "DELETE FROM grid_items WHERE box_id = ?1 AND file_path = ?2 AND id <> ?3",
        params![target_box_id, path, item_id],
    )
    .map_err(|err| format!("整理目标格子失败：{err}"))?;
    let sort = next_sort(
        &conn,
        "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_items WHERE box_id = ?1",
        Some(target_box_id),
    )?;
    conn.execute(
        "UPDATE grid_items SET box_id = ?1, sort = ?2 WHERE id = ?3",
        params![target_box_id, sort, item_id],
    )
    .map_err(|err| format!("更新收纳条目失败：{err}"))?;
    let short = Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    grid_log(&format!(
        "条目「{short}」改归属到格子「{}」（文件未移动）",
        target.name
    ));
    Ok(())
}

/// 给一个条目改名 —— **同目录改名，文件绝不搬家**（V87）。
///
/// # 为什么现在又允许 `fs::rename`（V37 起一直刻意回避它）
///
/// V33–V36 曾经「把文件 `fs::rename` 进 `桌面/Handy整理/<格名>/`」，那是在**搬动文件**：
/// 快捷方式失效、用户找不到东西，所以 V37 起改成纯呈现层（格子只改呈现，不动文件）。
///
/// **改名不一样**：它是 Explorer 本来就有的原生能力（右键→重命名 / F2 / 单击两次），
/// 用户点它就是要改磁盘上的名字，腾讯桌面整理也照做。我们不做，反而是在「改掉原生行为」
/// —— 正是用户 10-08 质疑的那件事。
///
/// # 硬约束：只许**同一个目录内**改名
///
/// - 名字里出现 `\ / :` 一律拒绝，其余 Windows 非法字符（`* ? " < > |`）也拒绝 ——
///   出现它们意味着「想改成别处的路径」，那又回到 V36 搬文件的老路；
/// - 目标名已存在直接拒绝，**不自动加后缀**（Explorer 会弹确认框，我们不替用户猜）；
/// - 只允许基于 `Path::parent()` 拼目标路径，绝不拼接用户给的目录。
#[tauri::command]
pub async fn grid_item_rename(
    app: AppHandle,
    path: String,
    new_name: String,
) -> Result<(), String> {
    let trimmed = new_name.trim().to_string();
    if trimmed.is_empty() {
        return Err("名字不能为空".to_string());
    }
    // Windows 文件名非法字符（`\` `/` 在前：它们会把「改名」变成「搬走」）
    const ILLEGAL: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    if let Some(bad) = ILLEGAL.iter().find(|c| trimmed.contains(**c)) {
        return Err(format!("名字里不能包含「{bad}」"));
    }
    // Explorer 也这么处理：纯点号 / 末尾带点的名字在 Windows 上不成立
    let trimmed = trimmed.trim_end_matches('.').to_string();
    if trimmed.is_empty() {
        return Err("名字不能为空".to_string());
    }

    if path.trim().is_empty() {
        return Err("没有可改名的路径".to_string());
    }
    let conn = connect(&app)?;
    let source = Path::new(&path);
    if !source.exists() {
        return Err("文件已不在原位置了".to_string());
    }
    let Some(parent) = source.parent() else {
        return Err("取不到所在目录".to_string());
    };
    let target = parent.join(&trimmed);
    if target != source && target.exists() {
        return Err(format!("已经有一个「{trimmed}」了"));
    }

    if let Err(err) = std::fs::rename(source, &target) {
        return Err(format!("改名失败：{err}"));
    }

    // 库里的登记必须跟着改：`grid_items.file_path` 是条目的身份，不改就会出现
    // 「磁盘上叫新名字、格子里还按旧路径找」的幽灵条目。
    let new_path = target.to_string_lossy().to_string();
    // 按**旧路径**定位登记行：同一个文件可能登记在某个格子里（1 行），也可能
    // 还没进任何格子、只是「未归类」竖条里的一个桌面文件（0 行）—— 两种都要能改名。
    conn.execute(
        "UPDATE grid_items SET file_path = ?1, display_name = ?2 WHERE file_path = ?3",
        params![new_path, trimmed, path],
    )
    .map_err(|err| format!("更新条目登记失败：{err}"))?;

    grid_log(&format!("条目改名：{trimmed}（文件未移动，仍在原目录）"));
    Ok(())
}

/// 某格子的条目列表（引用模型：登记为真相，磁盘只做存在性校验）。
#[tauri::command]
pub async fn grid_item_list(app: AppHandle, box_id: i64) -> Result<Vec<GridItem>, String> {
    let conn = connect(&app)?;
    let entity = load_box(&app, box_id)?;
    list_live_items(&conn, entity.id)
}

// —— 挂件窗几何（V83：多显示器下的唯一真源）——
//
// # 为什么几何**不再持久化**
//
// V83 之前这套是这样的：前端挂载时读一次 `scaleFactor`，之后窗口 `moved` / `resized`
// 停稳 500ms 就调 `grid_geometry_set` 把尺寸写进 `grid_meta.overlay_geometry`；
// 开窗时**DB 优先**。单屏 + 不动缩放的机器上一直看不出问题，但**接上第二块屏**就炸：
//
//   · 显示器配置变化时，Windows/tao 会移动甚至改我们的窗口尺寸（DPI 变了要重排），
//     于是 `resized` 触发；
//   · 前端那次换算用的是**挂载时取过的旧 `scaleFactor`** —— 用过期 DPI 把物理尺寸
//     换成逻辑尺寸存库，存进去的就是个错值；
//   · 从此开窗一律按这个错值 ⇒ **永久锁死**。
//
// 用户 09-28 的截图（双屏）就是这么来的：内容全挤在 `1138×608` 的角落里，
// 屏幕右侧近 800px、下方 400 多 px 全空。而窗口是 `resizable(false)` +
// `decorations(false)`，**用户根本没有调整它的途径** —— 持久化它只有害处，没有收益。
//
// 现在：几何**实时问系统**，显示器怎么变窗口就怎么跟（见 [`sync_overlay_bounds`]）。
//
// # 策略：只算主显示器
//
// 挂件窗**严格等于主显示器工作区**，绝不跨屏。理由：
//
//   1. **系统层面做不到「主屏接管、副屏保留原生图标」**：桌面图标视图
//      （`SHELLDLL_DefView` / `SysListView32`）是**一张横跨整个虚拟桌面的单一视图**，
//      只能整体显示/隐藏。要么全接管，要么全不接管。
//   2. 便签 / 工作台 / 未归类竖条都是**单实例**语义，双屏各铺一份马上产生
//      「同一份内容到底在哪块屏」的歧义。
//   3. 双屏各铺需要**每屏一个窗口**（WebView2 窗口跨不同缩放的屏会渲染模糊、
//      尺寸跳变），是一个独立特性，不该混在修 bug 里做。
//
// 副产品是**副屏完全原生**：那里没有我们的任何窗口，右键 / 新建 / 拖拽都不经过我们
// —— 正好就是用户一直要的「别改我桌面的默认行为」。

/// 当前**主显示器工作区**（物理像素 `(x, y, width, height)`）。
///
/// 这是挂件窗几何的唯一真源。取不到（极罕见：显示器正在重排）返回 `None`，
/// 调用方一律**保持窗口现状**而不是猜一个值。
fn primary_work_area(app: &AppHandle) -> Option<(i32, i32, u32, u32)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let area = monitor.work_area();
    if area.size.width == 0 || area.size.height == 0 {
        return None;
    }
    Some((
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
    ))
}

/// 判定窗口当前矩形相对目标工作区**是否需要纠正**，返回 `(位置要动, 尺寸要动)`。
///
/// 抽成纯函数只为一件事：**「容差」这条不变量能被单测钉住**。静态守卫只能看出
/// `.abs() > BOUNDS_TOLERANCE` 写没写，看不出「差 1px 到底算不算错位」——
/// 而那正是「每秒纠正一次、却永远纠正不动」这个死循环的开关。
///
/// 位置与尺寸分开判：只错一样就只动一样（`set_size` 会触发 webview 重排，
/// 位置对了就没必要让它白重排一次）。
fn bounds_need_fix(
    cur_pos: (i32, i32),
    cur_size: (u32, u32),
    target: (i32, i32, u32, u32),
) -> (bool, bool) {
    let (cx, cy) = cur_pos;
    let (cw, ch) = cur_size;
    let (tx, ty, tw, th) = target;
    let off_pos = (cx - tx).abs() > BOUNDS_TOLERANCE || (cy - ty).abs() > BOUNDS_TOLERANCE;
    let off_size = (i64::from(cw) - i64::from(tw)).abs() > i64::from(BOUNDS_TOLERANCE)
        || (i64::from(ch) - i64::from(th)).abs() > i64::from(BOUNDS_TOLERANCE);
    (off_pos, off_size)
}

/// 把挂件窗对齐到当前主显示器工作区（**物理像素**，幂等）。
///
/// 返回「这次是否真的动过窗口」—— 几何一变内容排布就得跟着重排，调用方据此决定
/// 要不要广播 [`EVENT_BOUNDS_CHANGED`]。
///
/// ⚠️ 用物理像素设位置和尺寸，不要走逻辑像素：逻辑坐标要经过「按哪块屏的缩放换算」
/// 这一步，而窗口本来就是被摆到那块屏上的 —— 拿它自己的 DPI 去算自己的位置是循环论证，
/// 跨屏 / 缩放变动时必然错位。
///
/// ⚠️ 桌面借给系统期间（[`handoff_active`]，用户正在用原生右键菜单）**不动窗口**：
/// 那一刻窗口是收起状态，几何没有意义，而动窗口可能干扰收回时的复核。
fn sync_overlay_bounds(app: &AppHandle) -> bool {
    if handoff_active() {
        return false;
    }
    let Some(win) = app.get_webview_window(GRID_LABEL) else {
        return false;
    };
    let Some((x, y, w, h)) = primary_work_area(app) else {
        return false;
    };

    // 位置与尺寸分开判：只错一样就只动一样（`set_size` 会触发 webview 重排，
    // 位置对了就没必要让它白重排一次）。
    //
    // ⚠️ 一律用**容差**比较，不要 `!=`：非整数缩放下 `SetWindowPos` 与 `GetWindowRect`
    // 来回换算会差 1–2px，严格相等就成了「每 1 秒纠正一次、却永远纠正不动」的死循环。
    // （判定逻辑在 [`bounds_need_fix`]，那里有单测钉住容差边界。）
    // 当前矩形取不到（窗口刚建、还没上屏）⇒ 当成「要纠」，走一次 `set` 没有副作用。
    let (off_pos, off_size) = match (win.outer_position(), win.inner_size()) {
        (Ok(pos), Ok(size)) => {
            bounds_need_fix((pos.x, pos.y), (size.width, size.height), (x, y, w, h))
        }
        _ => (true, true),
    };
    if !off_pos && !off_size {
        // 已经对齐 ⇒ 把纠正计数清零，下一次真有变化时又能立刻动手
        BOUNDS_FIXES.store(0, Ordering::Relaxed);
        return false;
    }

    // 退避中：多半是这台机器上「我们要的尺寸」跟「系统给我们的尺寸」根本不可能相等
    // （第三方窗口管理 / 特殊的 DPI 虚拟化）。继续每秒硬掰只会让窗口一直闪。
    let now = unix_secs();
    if BOUNDS_RETRY_AT.load(Ordering::Relaxed) > now {
        return false;
    }

    if off_pos {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    if off_size {
        let _ = win.set_size(PhysicalSize::new(w, h));
    }
    let fixes = BOUNDS_FIXES.fetch_add(1, Ordering::Relaxed) + 1;
    if fixes >= BOUNDS_MAX_FIXES {
        BOUNDS_FIXES.store(0, Ordering::Relaxed);
        BOUNDS_RETRY_AT.store(now + BOUNDS_BACKOFF_SECS, Ordering::Relaxed);
        grid_log("连续多次无法把挂件窗对齐主显示器工作区（多半被第三方工具改尺寸），暂停自动对齐 5 分钟");
    }
    grid_log(&format!(
        "挂件窗几何已按主显示器对齐：位置 {x},{y} 尺寸 {w}×{h}"
    ));
    true
}

/// V83 一次性清理：删掉历史遗留的窗口几何缓存（见上方「为什么几何不再持久化」）。
///
/// 幂等（删不存在的行也是成功），失败无所谓 —— 反正已经没有任何代码读它了。
fn drop_legacy_geometry(app: &AppHandle) {
    if let Ok(conn) = connect(app) {
        let _ = conn.execute(
            "DELETE FROM grid_meta WHERE key = ?1",
            params![META_KEY_GEOMETRY],
        );
    }
}

// —— 挂件窗生命周期 ——

/// 开窗几何：主显示器工作区（物理 → 逻辑像素换算；读取失败兜底 1280×800）。
///
/// V83：这只是 `WebviewWindowBuilder` 需要的**逻辑像素初值**，不是持久化来源 ——
/// 建完窗口立刻由 [`sync_overlay_bounds`] 按物理像素贴一次，把取整误差清零。
fn default_geometry(app: &AppHandle) -> (f64, f64, f64, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let area = monitor.work_area();
        let sf = monitor.scale_factor();
        if sf > 0.0 {
            return (
                f64::from(area.position.x) / sf,
                f64::from(area.position.y) / sf,
                f64::from(area.size.width) / sf,
                f64::from(area.size.height) / sf,
            );
        }
    }
    (0.0, 0.0, 1280.0, 800.0)
}

// ————————————————————————————————————————————————————————————————
// 桌面层挂载（V21 重做 —— 三次踩坑的最终答案）
//
// # 走过的两条错路
//
// 1. **V19 = `SetWindowPos(HWND_BOTTOM)`**：`HWND_BOTTOM` 是「整个 Z 序的最底」，
//    **包括桌面窗口（Progman）之下** —— 窗口被塞到壁纸后面，用户看到的是
//    「格子建了、数据也建了，但桌面上什么都没有」。
// 2. **V20 = `SetParent(Progman)`**：把挂件窗变成桌面的**子窗口**。位置对了，
//    但踩了三个新坑：
//      - 子窗口不参与 DWM 的 per-pixel alpha 合成 → **透明失效**，整块灰底；
//      - `SetParent` 会触发窗口重建 → **点一下闪一下**；
//      - 父子关系随 Explorer 重启失效 → 「看运气才能看到」。
//
// # 最终做法：顶层窗口 + 「插到桌面窗口正上方」
//
// `SetWindowPos(hwnd, host, SWP_NOACTIVATE)` 的第二个参数语义是
// 「把 hwnd 放到 host **之上**」，host 取 Progman（或持有 `SHELLDLL_DefView`
// 的 WorkerW）。于是 Z 序变成：
//
// ```text
//   …… 其它应用窗口 ……
//   ┌──────────────┐
//   │ grid-overlay │   ← 我们（透明区域穿透，桌面图标仍可见可点）
//   ├──────────────┤
//   │   Progman    │   ← 桌面 + 系统图标
//   └──────────────┘
// ```
//
// 三个好处：
//   - 窗口仍是**顶层窗口** → 透明 / 模糊 / 圆角全部正常；
//   - 不重建窗口 → 不再闪烁；Explorer 重启后由轮询线程重新定位；
//   - 应用窗口天然盖住它 → 不会打扰正常工作，回到桌面又立刻看到挂件。
//
// 另外给窗口加 `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`：点击挂件时**不抢焦点**，
// 也不会因为被激活而浮到别的窗口上面去。
//
// 兜底：找不到桌面宿主 → 退到 [`AttachMode::Normal`]（不做任何 Z 序调整，
// 窗口照旧可见可用），并把原因原样报给前端，不做静默吞错。
// ————————————————————————————————————————————————————————————————

/// 挂件窗与桌面的相对关系。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachMode {
    /// 贴到桌面（默认）：Z 序上紧贴在桌面窗口之上、其它应用窗口之下。
    Desktop,
    /// 普通窗口：不调整 Z 序（排查 / 兼容用，序列化仍写作 `"bottom"`）。
    Normal,
}

impl AttachMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Normal => "bottom",
        }
    }

    fn parse(value: &str) -> Self {
        if value == "bottom" {
            Self::Normal
        } else {
            Self::Desktop
        }
    }

    fn from_u8(value: u8) -> Self {
        if value == 1 {
            Self::Normal
        } else {
            Self::Desktop
        }
    }

    /// 当前进程内生效的基准层（供后续扩展读取；`ATTACH_MODE` 为唯一写入点）。
    #[allow(dead_code)]
    fn current() -> Self {
        Self::from_u8(ATTACH_MODE.load(Ordering::Relaxed))
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::Desktop => 0,
            Self::Normal => 1,
        }
    }
}

/// `grid_meta` 中「挂件基准层」的键名。
const META_KEY_ATTACH: &str = "attach_mode";

/// `grid_meta` 中「系统桌面图标是否被隐藏」的键名（崩溃后启动时据此恢复）。
///
/// ⚠️ 这是**瞬时状态**（此刻图标是不是被我们藏着），不是偏好 —— 与
/// [`META_KEY_TAKEOVER`] 分开记：收起挂件 / 退出应用会立刻恢复图标，但用户的
/// 「由格子接管桌面」偏好要留着，下次显示格子时依它重新隐藏。
const META_KEY_ICONS_HIDDEN: &str = "desktop_icons_hidden";

/// `grid_meta` 中「是否由格子层接管桌面呈现」的键名（V38）。
///
/// 值 = `"1"`：整理桌面后隐藏系统桌面图标，桌面只由格子画 —— 用户 V38 原话
/// 「不是整理了图标都收纳到格子里面 但是桌面原来的图标还在原地 没有消失
/// 相当于桌面又两个相同的内容了」。`"0"` / 缺失 = 原生图标与格子共存。
const META_KEY_TAKEOVER: &str = "desktop_takeover";

/// `grid_meta` 中「不再自动收录」名单的键名（JSON 字符串数组）。
///
/// 桌面同步会把桌面上还没进格子的文件按类型自动收纳；用户点条目上的 × 移除后，
/// 若不同步记住这个意愿，下一轮同步就会把它原样收回来 —— 名单就是那块记忆。
/// 手动把同一文件拖进格子会自动解除（用户用行动推翻了之前的决定）。
const META_KEY_DISMISSED: &str = "sync_dismissed";

/// `grid_meta` 中「挂件层是否应处于显示状态」的键名。
///
/// 「桌面整理永久生效」的根基：应用任何原因退出 / 重启（手动关闭、升级覆盖安装、
/// 崩溃被拉起）后，启动时只要这里记着「显示中」，就自动把格子层摆回桌面并接管 ——
/// 用户不需要每次开机后重新去点「显示格子」。
const META_KEY_OVERLAY_VISIBLE: &str = "overlay_visible";

/// 当前生效的基准层（轮询线程读它做周期复位，避免每 tick 查库）。
static ATTACH_MODE: AtomicU8 = AtomicU8::new(0);

/// 宽字符字面量（Win32 API 需要 NUL 结尾的 UTF-16）。
#[cfg(target_os = "windows")]
fn wide(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 找「桌面宿主窗口」：优先 Progman，其次挂有 `SHELLDLL_DefView` 的 WorkerW。
///
/// 说明：Win10/11 通常由 `Progman` 承载 `SHELLDLL_DefView`（桌面图标视图）；
/// 装了壁纸软件 / 多显示器动态壁纸时，`SHELLDLL_DefView` 会被挪到某个 `WorkerW`
/// 下，故两种都试。
#[cfg(target_os = "windows")]
fn null_hwnd() -> HWND {
    HWND(std::ptr::null_mut())
}

#[cfg(target_os = "windows")]
fn desktop_host() -> Option<HWND> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, FindWindowW};

    let progman_class = wide("Progman");
    let def_view_class = wide("SHELLDLL_DefView");
    let worker_class = wide("WorkerW");

    // 注：windows 0.58 把 `FindWindowW` / `FindWindowExW` 包成了 `Result<HWND>`
    // （找不到 = `Err`），所以统一 `unwrap_or_else` 退化成空句柄判断。
    unsafe {
        let progman = FindWindowW(PCWSTR(progman_class.as_ptr()), PCWSTR::null())
            .unwrap_or_else(|_| null_hwnd());
        if !progman.0.is_null() {
            let def_view = FindWindowExW(
                progman,
                null_hwnd(),
                PCWSTR(def_view_class.as_ptr()),
                PCWSTR::null(),
            )
            .unwrap_or_else(|_| null_hwnd());
            if !def_view.0.is_null() {
                return Some(progman);
            }
        }

        // 遍历顶层 WorkerW：哪个直接挂着 SHELLDLL_DefView 就是壁纸层
        let mut current = null_hwnd();
        for _ in 0..32 {
            let worker = match FindWindowExW(
                null_hwnd(),
                current,
                PCWSTR(worker_class.as_ptr()),
                PCWSTR::null(),
            ) {
                Ok(handle) => handle,
                Err(_) => break,
            };
            if worker.0.is_null() {
                break;
            }
            let def_view = FindWindowExW(
                worker,
                null_hwnd(),
                PCWSTR(def_view_class.as_ptr()),
                PCWSTR::null(),
            )
            .unwrap_or_else(|_| null_hwnd());
            if !def_view.0.is_null() {
                return Some(worker);
            }
            current = worker;
        }
        None
    }
}

/// 桌面图标视图（`SHELLDLL_DefView` → `SysListView32`）。
///
/// V81 起对外可见：`platform::desktop_handoff` 要在系统菜单期间操作它。
#[cfg(target_os = "windows")]
pub(crate) fn desktop_icon_view() -> Option<HWND> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowExW;

    let host = desktop_host()?;
    let def_view_class = wide("SHELLDLL_DefView");
    let list_class = wide("SysListView32");
    unsafe {
        let def_view = FindWindowExW(
            host,
            null_hwnd(),
            PCWSTR(def_view_class.as_ptr()),
            PCWSTR::null(),
        )
        .unwrap_or_else(|_| null_hwnd());
        if def_view.0.is_null() {
            return None;
        }
        let list = FindWindowExW(
            def_view,
            null_hwnd(),
            PCWSTR(list_class.as_ptr()),
            PCWSTR::null(),
        )
        .unwrap_or_else(|_| null_hwnd());
        if list.0.is_null() {
            None
        } else {
            Some(list)
        }
    }
}

/// 隐藏 / 恢复桌面系统图标（仅切换 `SysListView32` 的可见性，**不动任何文件**）。
///
/// 语义：这是「桌面整理」的关键一步 —— 格子接管呈现后，原来的图标不该再重复显示。
/// 返回 `Ok(false)` 表示没找到图标视图窗口（例如 Explorer 未运行 / 已被第三方接管），
/// 调用方据此提示「本机不支持自动隐藏」而不是报错。
#[cfg(target_os = "windows")]
fn desktop_icons_apply(hidden: bool) -> Result<bool, String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOW};
    let Some(view) = desktop_icon_view() else {
        return Ok(false);
    };
    // SAFETY: view 为系统桌面图标 ListView 的有效 HWND；ShowWindow 仅切可见性。
    unsafe {
        let _ = ShowWindow(view, if hidden { SW_HIDE } else { SW_SHOW });
    }
    Ok(true)
}

#[cfg(not(target_os = "windows"))]
fn desktop_icons_apply(_hidden: bool) -> Result<bool, String> {
    Ok(false)
}

/// 桌面图标当前是否可见（非 Windows / 找不到视图时返回 `true` = 视为可见）。
#[cfg(target_os = "windows")]
fn desktop_icons_visible() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    match desktop_icon_view() {
        Some(view) => unsafe { IsWindowVisible(view).as_bool() },
        None => true,
    }
}

#[cfg(not(target_os = "windows"))]
fn desktop_icons_visible() -> bool {
    true
}

/// 取挂件窗自身的 Win32 句柄。
#[cfg(target_os = "windows")]
fn overlay_hwnd(win: &WebviewWindow) -> Result<HWND, String> {
    win.hwnd()
        .map(|raw| HWND(raw.0 as _))
        .map_err(|err| format!("获取挂件窗句柄失败：{err}"))
}

/// 让挂件窗「不抢焦点、不进 Alt+Tab」。
///
/// 贴着桌面的顶层窗口如果可激活，用户一点它就会被提到其它应用窗口之上，
/// 挂件随即变成「挡住工作」的干扰项。`WS_EX_NOACTIVATE` 从根上避免这件事。
#[cfg(target_os = "windows")]
fn make_unfocusable(hwnd: HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };
    // SAFETY: 有效 HWND；只读改写本窗口的扩展样式位。
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = current
            | (WS_EX_NOACTIVATE.0 as isize)
            | (WS_EX_TOOLWINDOW.0 as isize);
        if next != current {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        }
    }
}

/// 把挂件窗插到「桌面窗口正上方」。
///
/// # V46 重写：一步 `HWND_BOTTOM`（旧的两步法方向是错的）
///
/// 旧实现是「先 `HWND_BOTTOM` 沉底，再 `SetWindowPos(hwnd, host)` 贴到宿主之上」。
/// 但 `SetWindowPos` 的 `hWndInsertAfter` 语义是「**排在 hwnd 前面（更靠上）**的那个窗口」，
/// 即把 hwnd 放到它**下面** —— 与函数名和注释里的「贴到 host 之上」正好相反。
///
/// 之所以在用户机上看不出问题：这台机器 `desktop_host()` 返回的是 `Progman`（桌面最底），
/// 「普通窗口不可能低于桌面」被系统钳制，第二步实际落回同一个位置，侥幸成立。
/// 一旦 `desktop_host()` 走的是「顶层 WorkerW」那条分支（图标所在的层），
/// 第二步就会把挂件层推到**原生图标背后** —— 用户看到的就是「整理好的桌面整个不见了」
/// （09-19 截图：只有壁纸 + 回收站）。
///
/// 实测依据（`scripts/audit/zorder-probe.py`，用一个自建顶层窗复刻两步法）：
///   · `SetWindowPos(w, HWND_BOTTOM)` → `GetWindow(w, GW_HWNDNEXT)` 立刻就是桌面宿主；
///   · `SetWindowPos(w, a)` → w 落在 a 的**下面**。
///
/// 所以这里只保留**单步、幂等**的 `HWND_BOTTOM`：Windows 不允许普通窗口低于桌面，
/// 于是它稳定地落在「所有普通窗口之下、桌面之上」—— 正是我们要的位置。
#[cfg(target_os = "windows")]
fn place_above_desktop(hwnd: HWND) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindow, SetWindowPos, GW_HWNDPREV, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    // 找不到桌面宿主时不盲目沉底：调用方据此退回「普通窗口」并如实告警，
    // 而不是让用户面对一个「看不见的窗」。
    let Some(host) = desktop_host() else {
        return Err("未找到桌面窗口（Progman / WorkerW）".to_string());
    };

    // —— V47：改成「锚定在桌面宿主正上方」——
    //
    // V46 用的是单步 `SetWindowPos(hwnd, HWND_BOTTOM)`，前提是「桌面宿主永远待在 Z 序最底」。
    // 这个前提**不成立**：用户按 Win+D / 点「显示桌面」，Shell 会把 Progman 抬到普通窗口带的
    // **最顶上**（它就是靠这一手让所有窗口"消失"的）。这时再沉底只是把挂件层压到 Progman
    // **下面** —— 桌面看起来干干净净，正是用户报的「win+d 之后桌面什么都没有了」。
    // 判据还判不出来：`z_verdict` 往下走找得到 Progman（它在下面），于是报 `InDesktopBand`，
    // 自愈一次都不触发。
    //
    // 所以要表达的不是「沉到底」，而是**不变量本身**：挂件层紧贴桌面宿主正上方。
    // `SetWindowPos(hwnd, X)` 的语义是「把 hwnd 排到 X 的下面」，于是：
    //   anchor = 宿主正上方那一层（`GW_HWNDPREV`，同 band 内取，不会跨到 topmost）
    //   → 把挂件窗插到 anchor 下面 = 正好落在宿主正上方。
    // 宿主被抬到哪儿都成立，且同样幂等。anchor 为空（宿主已在本 band 顶端）时退回沉底。
    let anchor = unsafe { GetWindow(host, GW_HWNDPREV) }.unwrap_or_else(|_| null_hwnd());
    let insert_after = if anchor.0.is_null() {
        HWND_BOTTOM
    } else {
        anchor
    };
    // SAFETY: hwnd 为本进程窗口的有效句柄；SetWindowPos 只改 Z 序，不改几何。
    unsafe {
        SetWindowPos(
            hwnd,
            insert_after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(|err| format!("把挂件窗贴回桌面正上方失败：{err}"))
    }
}

/// 把挂件窗抬到**当前屏幕最前**（工具箱快捷调出，V72）。
///
/// 挂件窗默认带 `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` 并锚定桌面层（见
/// [`make_unfocusable`] / [`place_above_desktop`]），于是它**永远在普通窗口之下**，
/// 在别的程序里按快捷键也看不见。用户原话：「工具箱快捷调出后应该在当前屏幕最前面」。
///
/// 这里临时清掉 `WS_EX_NOACTIVATE`（保留 `WS_EX_TOOLWINDOW`，仍不进 Alt+Tab / 任务栏），
/// 并用 `SetWindowPos(HWND_TOP)` + `set_focus()` 把它顶到当前屏幕最前、可收键盘焦点
/// （工具箱里要打字 / 搜索）。不改动「桌面常驻」基准层 —— 用户切回桌面它依旧在，
/// 点别的程序它自然落到后面（标准顶层窗口行为）。
#[tauri::command]
pub fn panel_raise_front(app: AppHandle) -> Result<(), String> {
    raise_panel_front(&app)
}

/// 把挂件窗复位成「不抢焦点、锚定桌面层」的常驻态（与 [`panel_raise_front`] 配对，V72）。
///
/// 工具箱用完（切换 / 收起）后调用，让面板回到「不挡工作」的桌面挂件行为，
/// 避免它因为被清掉了 `WS_EX_NOACTIVATE` 而一直浮在别的应用上面。
#[tauri::command]
pub fn panel_settle_desktop(app: AppHandle) -> Result<(), String> {
    settle_panel_desktop(&app)
}

#[cfg(target_os = "windows")]
fn raise_panel_front(app: &AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window(GRID_LABEL) else {
        return Err("挂件窗不存在，无法置前".to_string());
    };
    let _ = win.show();
    let hwnd = overlay_hwnd(&win)?;
    // 清掉 NOACTIVATE：让窗口可激活、可收键盘焦点（工具箱输入需要）。
    // 保留 TOOLWINDOW：仍不进 Alt+Tab / 任务栏（skip_taskbar 已保证不进任务栏）。
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };
    // SAFETY: 有效 HWND；只改写本窗口扩展样式位。
    unsafe {
        let cur = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let cleared = cur & !(WS_EX_NOACTIVATE.0 as isize);
        if cleared != cur {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, cleared);
        }
    }
    // 顶到 Z 序最前（不动几何）。HWND_TOP 不带 SWP_NOACTIVATE ⇒ 同时激活置前。
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOP, SWP_NOMOVE, SWP_NOSIZE};
    // SAFETY: 有效 HWND；SetWindowPos 只改 Z 序，不改几何。
    unsafe {
        let _ = SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
    }
    win.set_focus()
        .map_err(|err| format!("聚焦挂件窗失败：{err}"))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn raise_panel_front(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn settle_panel_desktop(app: &AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window(GRID_LABEL) else {
        return Ok(());
    };
    let Ok(hwnd) = overlay_hwnd(&win) else {
        return Ok(());
    };
    // 复位成「不抢焦点、锚定桌面层」的常驻态（与初始创建时一致）。
    make_unfocusable(hwnd);
    let _ = place_above_desktop(hwnd);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn settle_panel_desktop(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

/// 按基准层把挂件窗放到位。
///
/// - `Desktop`：插到桌面窗口正上方；找不到桌面宿主**退回 `Normal`** 并把原因返回
///   （前端据此提示用户，而不是让用户面对一个「看不见的窗」）；
/// - `Normal`：不做任何 Z 序调整（普通顶层窗口）。
fn apply_attach(win: &WebviewWindow, mode: AttachMode) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = overlay_hwnd(win)?;
        // 无论哪种模式，挂件都不该抢焦点
        make_unfocusable(hwnd);

        if mode == AttachMode::Desktop {
            return match place_above_desktop(hwnd) {
                Ok(()) => {
                    ATTACH_MODE.store(AttachMode::Desktop.as_u8(), Ordering::Relaxed);
                    Ok(())
                }
                Err(err) => {
                    ATTACH_MODE.store(AttachMode::Normal.as_u8(), Ordering::Relaxed);
                    Err(format!("{err}，挂件已按普通窗口显示"))
                }
            };
        }

        ATTACH_MODE.store(AttachMode::Normal.as_u8(), Ordering::Relaxed);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (win, mode);
        Ok(())
    }
}

/// 挂件窗相对桌面的纵深位置。
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ZVerdict {
    /// 就在桌面「那一带」：往下走一段能碰到桌面 ⇒ 层级正确，什么都不用做。
    InDesktopBand,
    /// 一路走到底都没碰到桌面 ⇒ 被压在桌面**下面**（用户看到的是「格子不见了」）。
    BelowDesktop,
    /// 走了 [`REASSERT_SCAN_STEPS`] 层还没碰到桌面 ⇒ 被顶得**很高**（会盖住别的窗口）。
    TooHigh,
}

/// 从「自己往下走看到的窗口链」判定纵深。
///
/// 抽成纯函数是为了能测 —— 这条判据历史上错过两次，不能再靠肉眼审。
///
/// - `chain`：从自己**正下方那一个**开始，依次往下的窗口（最多 [`REASSERT_SCAN_STEPS`] 个）
/// - `hit_bottom`：还没走满 [`REASSERT_SCAN_STEPS`] 就走到底了（Z 序末端）
#[cfg(target_os = "windows")]
fn classify_chain(chain: &[HWND], host: HWND, hit_bottom: bool) -> ZVerdict {
    if chain.contains(&host) {
        // 往下走一段能碰到桌面 ⇒ 我们在它上面。**中间夹着谁都不算问题**：
        // 输入法助手窗、本应用主窗常年就停在这一带。
        return ZVerdict::InDesktopBand;
    }
    if hit_bottom {
        ZVerdict::BelowDesktop
    } else {
        ZVerdict::TooHigh
    }
}

/// 判定挂件窗相对桌面宿主的纵深（走链部分，见 [`classify_chain`]）。
#[cfg(target_os = "windows")]
fn z_verdict(hwnd: HWND) -> Option<ZVerdict> {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindow, GW_HWNDNEXT};
    let host = desktop_host()?;
    if host == hwnd {
        return Some(ZVerdict::InDesktopBand);
    }
    let mut chain: Vec<HWND> = Vec::with_capacity(REASSERT_SCAN_STEPS);
    let mut hit_bottom = false;
    let mut cursor = hwnd;
    for _ in 0..REASSERT_SCAN_STEPS {
        // SAFETY: 有效 HWND，仅查询 Z 序。
        let next = unsafe { GetWindow(cursor, GW_HWNDNEXT) }.unwrap_or_else(|_| null_hwnd());
        if next.0.is_null() {
            hit_bottom = true;
            break;
        }
        chain.push(next);
        if next == host {
            break;
        }
        cursor = next;
    }
    Some(classify_chain(&chain, host, hit_bottom))
}

/// 把「挂件窗往下走的前几个窗口」压成一行，供日志取证。
///
/// 为什么必须有：`TooHigh` / `BelowDesktop` 只说明「链条没碰到桌面」，
/// 真正要回答的是「**夹在中间的是谁**」。V40 排查同类问题时只能靠事后
/// 用 `window-probe.py zlist` 猜，且要用户重现；把类名写进日志，一条就够。
/// 类名重复出现时折叠计数（例：`Sogou_TSF_UI×3`），避免一行里全是输入法助手窗。
#[cfg(target_os = "windows")]
fn z_chain_brief(hwnd: HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetWindow, GW_HWNDNEXT};
    let mut parts: Vec<String> = Vec::new();
    let mut cursor = hwnd;
    for _ in 0..4 {
        // SAFETY: 有效 HWND，仅查询 Z 序与类名。
        let next = unsafe { GetWindow(cursor, GW_HWNDNEXT) }.unwrap_or_else(|_| null_hwnd());
        if next.0.is_null() {
            parts.push("(Z 序末端)".to_string());
            break;
        }
        let mut buf = [0u16; 64];
        // SAFETY: buf 为本进程栈上的定长缓冲；GetClassNameW 最多写 64 个 u16。
        let len = unsafe { GetClassNameW(next, &mut buf) };
        let name = if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            "(无类名)".to_string()
        };
        parts.push(name);
        cursor = next;
    }
    // 折叠连续同名（输入法助手窗经常一次挂好几个）
    let mut folded: Vec<(String, usize)> = Vec::new();
    for part in parts {
        match folded.last_mut() {
            Some(last) if last.0 == part => last.1 += 1,
            _ => folded.push((part, 1)),
        }
    }
    folded
        .into_iter()
        .map(|(name, count)| {
            if count > 1 {
                format!("{name}×{count}")
            } else {
                name
            }
        })
        .collect::<Vec<_>>()
        .join(" > ")
}

/// 周期复位：**只在 Z 序真的不对时**才重排。
///
/// 每次都无脑 `SetWindowPos` 会让窗口反复重绘 —— 那正是「闪一下」的观感来源。
/// 判据见 [`z_verdict`]（V35 前是「正下方必须正好是桌面」，那条在真实桌面上
/// 几乎永远不成立，是本轮修掉的核心缺陷）。
///
/// 三重保险，确保**永远不会变成无限重排**：
///   1. 判据宽容（`InDesktopBand` 就算对）⇒ 稳态下一次都不会触发；
///   2. 自检有**时间**间隔（[`REASSERT_INTERVAL_MS`]）⇒ 不会跟着轮询提速而变密；
///   3. 连续纠正失败到 [`REASSERT_MAX_FIXES`] 次就退避 [`REASSERT_GIVEUP_BACKOFF_SECS`] 秒
///      ⇒ 就算判据和现实仍对不上，也只会偶发纠正，不会连续闪。
///
/// # V46：去掉去抖，改为「判到就纠」
///
/// 旧实现要求**连续两次**判定不对才动手（`REASSERT_MISMATCH + 1 < 2`）。
/// 配合 3 秒的检测间隔，最坏情况是「发现 → 6 秒后才纠正」，而这 6 秒里
/// 用户看到的就是「桌面空着」。用户的诉求是「不管什么情况，只要是桌面就无条件显示整理」，
/// 所以 V46 起**判定不对立刻纠正**：纠正动作已是幂等的单步 `HWND_BOTTOM`，
/// 代价是一次 `SetWindowPos`，而且判据正确时一次窗口 API 都不会调。
///
/// 日志仍然限流（[`Z_LOG_INTERVAL_SECS`]）：稳态不刷屏，但**每轮突发必留第一条**，
/// 并带上「往下走的前几个窗口」——那是唯一能在事后定位夹层的信息。
fn reassert_attach(win: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        if AttachMode::current() != AttachMode::Desktop {
            return;
        }
        let Ok(hwnd) = overlay_hwnd(win) else {
            return;
        };

        // 保险丝：上次触发后退避期内直接不动手（每轮只判断时间，不碰窗口）。
        let now = unix_secs();
        let retry_at = REASSERT_RETRY_AT.load(Ordering::Relaxed);
        if retry_at > now {
            return;
        }

        match z_verdict(hwnd) {
            Some(ZVerdict::InDesktopBand) => {
                // 层级正确：清零计数。走到这里说明判据和现实一致，可以重新信任自愈。
                REASSERT_MISMATCH.store(0, Ordering::Relaxed);
                REASSERT_FIXES.store(0, Ordering::Relaxed);
                REASSERT_GAVE_UP.store(false, Ordering::Relaxed);
                return;
            }
            None => return, // 拿不到桌面宿主：判不了就别乱动
            Some(verdict) => {
                let fixes = REASSERT_FIXES.fetch_add(1, Ordering::Relaxed) + 1;
                if fixes > REASSERT_MAX_FIXES {
                    REASSERT_FIXES.store(0, Ordering::Relaxed);
                    REASSERT_RETRY_AT.store(now + REASSERT_GIVEUP_BACKOFF_SECS, Ordering::Relaxed);
                    if !REASSERT_GAVE_UP.swap(true, Ordering::Relaxed) {
                        grid_log(&format!(
                            "Z 序连续 {REASSERT_MAX_FIXES} 次纠正后仍不对，暂停 \
                             {REASSERT_GIVEUP_BACKOFF_SECS} 秒再试（判据：{verdict:?}；\
                             夹层={}）。",
                            z_chain_brief(hwnd)
                        ));
                    }
                    return;
                }
                // 日志限流：每轮突发只留第一条（`fixes == 1`），且与上一条至少隔
                // [`Z_LOG_INTERVAL_SECS`] 秒 —— 稳态不刷屏，突发必留证。
                let first_of_burst = fixes == 1;
                let quiet = now.saturating_sub(LAST_Z_LOG_AT.load(Ordering::Relaxed))
                    < Z_LOG_INTERVAL_SECS;
                if first_of_burst && !quiet {
                    LAST_Z_LOG_AT.store(now, Ordering::Relaxed);
                    grid_log(&format!(
                        "Z 序不对（{verdict:?}），已摆回桌面层（overlay={:?} 夹层={}）",
                        hwnd.0,
                        z_chain_brief(hwnd)
                    ));
                }
                if let Err(err) = place_above_desktop(hwnd) {
                    grid_log(&format!("摆回桌面层失败（overlay={:?}）：{err}", hwnd.0));
                } else if let Some(after) = z_verdict(hwnd) {
                    // —— V47：纠正后**当场复验** ——
                    //
                    // V46 只在纠正前判一次，`已摆回桌面层` 这句其实只说明「调用没报错」，
                    // 不说明真的摆对了。用户看到「桌面还是空的」而日志上写着"已摆回"，
                    // 排查时无法从日志分辨。复验把「摆完到底对不对」写进日志 ——
                    // 这条也是 `REASSERT_MAX_FIXES` 退避计数的依据（下一轮才算数）。
                    if after != ZVerdict::InDesktopBand {
                        grid_log(&format!(
                            "摆回桌面层后复验**仍不对**（{after:?}，夹层={}）—— 判据或环境需重查",
                            z_chain_brief(hwnd)
                        ));
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = win;
    }
}

/// 用户主动「隐藏再显示格子」时复位 Z 序自愈的状态（保险丝重新上膛）。
fn reset_reassert_state() {
    REASSERT_MISMATCH.store(0, Ordering::Relaxed);
    REASSERT_FIXES.store(0, Ordering::Relaxed);
    REASSERT_RETRY_AT.store(0, Ordering::Relaxed);
    REASSERT_GAVE_UP.store(false, Ordering::Relaxed);
}

/// 「显示桌面」（Win+D）/ 最小化之后把挂件层捞回来。
///
/// # 为什么需要这个
///
/// 用户原话：「wind+d 显示桌面后桌面的格子又全都丢失了……按理这个是桌面的一部分，
/// 就算显示桌面它也是显示的」。
///
/// Win+D 的实现就是**给所有顶层窗口发一条最小化** —— 我们的挂件窗虽然被
/// [`place_above_desktop`] 插在桌面窗口的正上方，但它**并不是桌面的子窗口**，
/// 所以在 Win+D 的世界里它就是一个普通顶层窗，一样被最小化掉。
///
/// 真要让 Win+D 碰不到它，得 `SetParent` 成桌面的子窗口 —— 那会让坐标体系变成
/// 相对父窗、且 Explorer 重建 WorkerW 时会连带我们，得不偿失。
/// 所以选**「被最小化就立刻捞回来」**：轮询里判 [`IsIconic`]，命中就用
/// `SW_SHOWNOACTIVATE` 还原（不抢焦点），再重新贴回桌面层。
/// 25ms 的轮询周期意味着用户基本看不到这一下。
///
/// 返回 `true` = 本次真的做了还原（供调用方决定是否继续走后续判定）。
fn restore_if_minimized(win: &WebviewWindow) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            IsIconic, ShowWindow, SW_SHOWNOACTIVATE,
        };
        let Ok(hwnd) = overlay_hwnd(win) else {
            return false;
        };
        // SAFETY: hwnd 为本进程窗口的有效句柄；两个 API 都只作用于该窗口。
        let minimized = unsafe { IsIconic(hwnd).as_bool() };
        if !minimized {
            return false;
        }
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        // 还原会把窗口抛回顶层 → 贴桌模式下必须立刻按基准层插回去；
        // 普通窗口模式（用户手动切过）不做 Z 序调整，免得凭空改变他的预期。
        if AttachMode::current() == AttachMode::Desktop {
            let _ = place_above_desktop(hwnd);
        }
        mark_overlay_shown();
        grid_log("挂件层被最小化（多半是 Win+D / 显示桌面），已还原并重新贴回桌面层");
        true
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = win;
        false
    }
}

/// 读基准层（无记录 = 默认「贴到桌面」）。
fn read_attach_mode(app: &AppHandle) -> AttachMode {
    let Ok(conn) = connect(app) else {
        return AttachMode::Desktop;
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_ATTACH],
            |row| row.get(0),
        )
        .ok();
    raw.map(|value| AttachMode::parse(&value))
        .unwrap_or(AttachMode::Desktop)
}

/// 写基准层。
fn write_attach_mode(app: &AppHandle, mode: AttachMode) -> Result<(), String> {
    let conn = connect(app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY_ATTACH, mode.as_str()],
    )
    .map_err(|err| format!("保存挂件基准层失败：{err}"))?;
    Ok(())
}

/// grid_meta 键：用户主动**关闭**过桌面右键菜单入口 → 启动时不再自动注册。
const META_KEY_DESKTOP_MENU_OPTOUT: &str = "desktop_menu_optout";

/// 读「用户是否主动关过桌面右键菜单入口」。
fn read_desktop_menu_optout(app: &AppHandle) -> bool {
    let Ok(conn) = connect(app) else {
        return false;
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_DESKTOP_MENU_OPTOUT],
            |row| row.get(0),
        )
        .ok();
    raw.as_deref() == Some("1")
}

/// 记「用户主动关过 / 重新打开」桌面右键菜单入口。
pub fn set_desktop_menu_optout(app: &AppHandle, optout: bool) -> Result<(), String> {
    let conn = connect(app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            META_KEY_DESKTOP_MENU_OPTOUT,
            if optout { "1" } else { "0" }
        ],
    )
    .map_err(|err| format!("保存桌面右键菜单偏好失败：{err}"))?;
    Ok(())
}

/// V47：**装机即注册**桌面空白处右键菜单里的「打开 Handy 桌面整理」。
///
/// 用户原话：「把 handy 这个桌面整理功能能自动安装的时候加入到系统桌面的鼠标右键菜单里面吗」。
/// V45 只做了「桌面整理」页里的手动开关，用户不知道要去点，等于没有入口。
///
/// 但**必须尊重用户的关闭动作**：他一旦在设置页关掉，就写
/// [`META_KEY_DESKTOP_MENU_OPTOUT`]，之后启动不再往回加 —— 否则那个开关形同虚设。
/// 注册本身幂等（`reg add /f` 覆盖同名键），已注册就直接跳过，不做无谓的进程调用。
pub fn ensure_desktop_menu(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        if read_desktop_menu_optout(app) {
            return;
        }
        match crate::platform::desktop_menu::status() {
            Ok(true) => return, // 已在菜单里，不折腾
            Ok(false) => {}
            Err(err) => grid_log(&format!("查询桌面右键菜单注册状态失败（仍尝试注册）：{err}")),
        }
        match crate::platform::desktop_menu::install() {
            Ok(()) => grid_log("已把「打开 Handy 桌面整理」注册进桌面空白处右键菜单"),
            Err(err) => grid_log(&format!("注册桌面右键菜单失败（用户可手动重试）：{err}")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

/// 读「系统桌面图标是否被隐藏」的持久化标记。
fn read_icons_hidden(app: &AppHandle) -> bool {
    let Ok(conn) = connect(app) else {
        return false;
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_ICONS_HIDDEN],
            |row| row.get(0),
        )
        .ok();
    raw.as_deref() == Some("1")
}

/// 写「系统桌面图标是否被隐藏」的持久化标记。
fn write_icons_hidden(app: &AppHandle, hidden: bool) -> Result<(), String> {
    let conn = connect(app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY_ICONS_HIDDEN, if hidden { "1" } else { "0" }],
    )
    .map_err(|err| format!("保存桌面图标状态失败：{err}"))?;
    Ok(())
}

/// 读「整理由格子层接管桌面呈现」偏好（V38）。
fn read_takeover(app: &AppHandle) -> bool {
    let Ok(conn) = connect(app) else {
        return false;
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_TAKEOVER],
            |row| row.get(0),
        )
        .ok();
    raw.as_deref() == Some("1")
}

/// 写「整理由格子层接管桌面呈现」偏好（V38）。
fn write_takeover(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let conn = connect(app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY_TAKEOVER, if enabled { "1" } else { "0" }],
    )
    .map_err(|err| format!("保存桌面接管偏好失败：{err}"))?;
    Ok(())
}

/// 读「不再自动收录」名单（JSON 数组；损坏 / 缺失视为空集，不让坏数据废掉同步）。
fn read_dismissed(conn: &Connection) -> Result<std::collections::HashSet<String>, String> {

    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_DISMISSED],
            |row| row.get(0),
        )
        .ok();
    let list = raw
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default();
    Ok(list.into_iter().collect())
}

/// 写「不再自动收录」名单（排序后落库，保证字节稳定）。
fn write_dismissed(
    conn: &Connection,
    set: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let mut list: Vec<String> = set.iter().cloned().collect();
    list.sort();
    let json = serde_json::to_string(&list).map_err(|err| format!("序列化名单失败：{err}"))?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY_DISMISSED, json],
    )
    .map_err(|err| format!("保存名单失败：{err}"))?;
    Ok(())
}

/// 清空「不要它」名单，返回放开的条数（V43）。
///
/// 只在**一键整理**时调用 —— 语义见 [`auto_arrange_inner`] 里的长注释：
/// 用户显式点「整理桌面」= 要求按桌面**现状**重新算一遍，此时历史的手动移出不该再拦。
/// 名单本身仍然保留给后台对账用（用户刚拖出去的东西不会立刻被塞回来）。
fn release_dismissed(conn: &Connection) -> Result<usize, String> {
    let set = read_dismissed(conn)?;
    if set.is_empty() {
        return Ok(0);
    }
    let count = set.len();
    write_dismissed(conn, &std::collections::HashSet::new())?;
    Ok(count)
}

/// 把某个路径从「不要它」名单里去掉。
///
/// 用户把它重新拖进格子 = 改主意了；不清掉这一条，下次自动归类又会绕开它，
/// 表现为「我明明放进去了，一刷新又没了」。
fn clear_dismissed(conn: &Connection, path: &str) -> Result<(), String> {
    let mut set = read_dismissed(conn)?;
    if set.remove(path) {
        write_dismissed(conn, &set)?;
    }
    Ok(())
}

/// 退出 / 启动时无条件恢复桌面系统图标（避免「图标被藏住但应用没了」的尴尬）。
///
/// 必须在应用还活着的时候调用（见 `lib.rs` 的 `ExitRequested` 分支）：进程一旦进入
/// 真正退出的拆解阶段，窗口句柄可能被收回、调用时机不可靠。
///
/// 顺手把「我们代管了图标」的标记（`icons_hidden` + `ICONS_TAKEN`）一并清零 —— 否则
/// 下次启动 `heal_desktop_icons` 还会看到旧标记、先恢复再被 `restore_overlay_if_visible`
/// 按接管偏好重新藏起，等于白闪一次；清掉后启动直接进入「接管态」，不再多余还原。
pub fn restore_desktop_icons(app: &AppHandle) {
    let _ = desktop_icons_apply(false);
    let _ = write_icons_hidden(app, false);
    ICONS_TAKEN.store(false, Ordering::Relaxed);
    grid_log("应用退出 / 收起：已把系统桌面图标还给系统");
}

/// 启动时自愈：上次是被强杀 / 崩溃（图标还藏着），这里恢复并清标记。
/// V55：双重检查 —— 标记为 hidden **或** 图标实际不可见时都恢复。
/// taskkill /F 不会触发 ExitRequested，标记可能来不及清，但图标确实被隐藏了。
/// 所以还要检查图标实际可见性，只要不可见就恢复。
pub fn heal_desktop_icons(app: &AppHandle) {
    let marked_hidden = read_icons_hidden(app);
    let actually_visible = desktop_icons_visible();
    if !marked_hidden && actually_visible {
        return;
    }
    // 标记为隐藏 或 图标实际不可见 → 恢复
    match desktop_icons_apply(false) {
        Ok(_) => {
            let _ = write_icons_hidden(app, false);
            if marked_hidden {
                println!("[Handy] 检测到上次退出时隐藏了桌面图标，已自动恢复");
            } else if !actually_visible {
                println!("[Handy] 检测到桌面图标不可见（可能上次被强杀），已自动恢复");
            }
        }
        Err(err) => eprintln!("[Handy] 恢复桌面图标失败：{err}"),
    }
}

/// 读取挂件窗基准层（`desktop` | `bottom`）。
#[tauri::command]
pub async fn grid_attach_get(app: AppHandle) -> Result<String, String> {
    Ok(read_attach_mode(&app).as_str().to_string())
}

/// 设置挂件窗基准层并立即生效（窗口不存在时只落库，下次开窗生效）。
#[tauri::command]
pub async fn grid_attach_set(app: AppHandle, mode: String) -> Result<(), String> {
    let parsed = AttachMode::parse(&mode);
    write_attach_mode(&app, parsed)?;
    if let Some(win) = app.get_webview_window(GRID_LABEL) {
        apply_attach(&win, parsed)?;
    }
    Ok(())
}

/// 隐藏 / 恢复桌面系统图标。返回「本机是否支持」（false = 没找到桌面图标视图）。
#[tauri::command]
pub async fn grid_desktop_icons_set(app: AppHandle, hidden: bool) -> Result<bool, String> {
    let supported = desktop_icons_apply(hidden)?;
    if supported {
        write_icons_hidden(&app, hidden)?;
    }
    Ok(supported)
}

/// 查询桌面系统图标当前是否可见。
#[tauri::command]
pub async fn grid_desktop_icons_get() -> Result<bool, String> {
    Ok(desktop_icons_visible())
}

/// 切换「由格子接管桌面呈现」（V38）：`true` = 隐藏原生桌面图标，`false` = 共存。
///
/// 与 `grid_desktop_icons_set` 的区别：那条是**一次性**动作（开关一下就走），
/// 这条会**记住**用户的选择，此后每次显示格子都按它执行（收起挂件 / 退出应用
/// 依然立刻把图标还给系统，见 `grid_overlay_hide` / `restore_desktop_icons`）。
///
/// 返回「此刻图标是否确实处于隐藏态」—— 隐藏失败（例如被第三方桌面工具接管了
/// 图标视图）时返回 false，前端据此提示用户「本机不支持自动隐藏，桌子会同时显示
/// 格子与原图标」。
#[tauri::command]
pub async fn grid_takeover_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    write_takeover(&app, enabled)?;
    let applied = takeover_icons(&app, enabled);
    // V40：用户手动开关也落盘 —— 上一轮排查时，图表都指向「偏好被谁改了」，而
    // handy.log 里连一条记录都没有（grid_takeover_set 完全不写日志），全靠猜。
    grid_log(&format!(
        "用户切换桌面接管：{}（图标实际隐藏 = {}）",
        if enabled { "开" } else { "关" },
        applied
    ));
    Ok(applied)
}

/// 读「是否由格子接管桌面呈现」偏好 + 此刻图标的真实可见性。
#[tauri::command]
pub async fn grid_takeover_get(app: AppHandle) -> Result<TakeoverState, String> {
    Ok(TakeoverState {
        enabled: read_takeover(&app),
        icons_visible: desktop_icons_visible(),
    })
}

/// 桌面接管状态（前端工具栏据此显示「原生图标：已隐藏 / 已显示」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverState {
    /// 用户的偏好：整理后是否由格子接管桌面呈现
    pub enabled: bool,
    /// 此刻系统桌面图标是否可见（隐藏失败 / 已被收起时会与 enabled 不一致）
    pub icons_visible: bool,
}


/// Windows 光标命中测试：全局光标（物理像素）→ 挂件窗内坐标 → 区域判定。
#[cfg(target_os = "windows")]
fn cursor_hit_windows(win: &WebviewWindow, regions: &[GridRegion]) -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let Ok(origin) = win.outer_position() else {
        return false;
    };
    let mut point = POINT::default();
    unsafe {
        if GetCursorPos(&mut point).is_err() {
            return false;
        }
    }
    let rel_x = f64::from(point.x - origin.x);
    let rel_y = f64::from(point.y - origin.y);
    // 外扩一圈：见 HIT_PADDING 的说明（补掉「离散采样 vs 连续移动」的时间窗）
    regions.iter().any(|r| {
        rel_x >= r.x - HIT_PADDING
            && rel_y >= r.y - HIT_PADDING
            && rel_x <= r.x + r.width + HIT_PADDING
            && rel_y <= r.y + r.height + HIT_PADDING
    })
}

/// 命中测试入口（非 Windows 平台暂返回 `false`，即保持默认穿透）。
fn cursor_hit(win: &WebviewWindow) -> bool {
    let regions = REGIONS
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    if regions.is_empty() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        cursor_hit_windows(win, &regions)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = win;
        false
    }
}

/// 施加穿透态：**只在状态真的变化时**调窗口 API（轮询每 25ms 跑一次，不能每次都打系统调用）。
///
/// 判据取自共享的 [`POLLER_IGNORE`]，所以**任何**改过这个状态的地方都会被它看见
/// （见该静态量的说明：这正是 V61 双击失效的根因）。
fn apply_ignore(win: &WebviewWindow, ignore: bool) {
    let want = if ignore { 1 } else { 0 };
    if POLLER_IGNORE.swap(want, Ordering::SeqCst) != want {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

/// 强制重设穿透态并让缓存失效 —— 用于「窗口刚重建 / 刚显示 / 刚被外部改过」这类
/// 实际状态已经不可知的场景。
fn force_ignore(win: &WebviewWindow, ignore: bool) {
    POLLER_IGNORE.store(IGNORE_UNKNOWN, Ordering::SeqCst);
    apply_ignore(win, ignore);
}

/// 挂件窗「意外消失」后的重建冷却（秒）。
///
/// 与白屏自愈的冷却分开记：那条是「窗口在、前端没起来」，这条是「窗口整个没了」。
const RESURRECT_COOLDOWN_SECS: u64 = 30;

/// 上次自动重建「消失的挂件窗」的时刻（unix 秒；用于 [`RESURRECT_COOLDOWN_SECS`]）。
static LAST_RESURRECT_AT: AtomicU64 = AtomicU64::new(0);

/// 启动（或确认已在运行的）光标轮询线程。
///
/// 生命周期：窗口被销毁后不再无条件退出 —— 见下面窗口丢失分支的说明，只有当
/// 「用户要的是收起态」时才退出并复位 `POLLER_RUNNING`。
fn ensure_poller(app: AppHandle) {
    if POLLER_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return; // 已有轮询线程在跑
    }
    let spawned = std::thread::Builder::new()
        .name("grid-overlay-poller".into())
        .spawn(move || {
            // 穿透态的「上次施加值」记在共享原子 [`POLLER_IGNORE`] 里（**不是**局部变量：
            // `grid_set_interactive` 也会改它，局部缓存看不见 —— 见该静态量的说明）。
            // Z 序自检按**时间**触发（V35：以前按轮询周期数算，轮询一提速就跟着变密，
            // 把自检从 2.4 秒一次变成 1 秒一次，用户看到的就是「一直闪」）。
            let mut last_reassert = std::time::Instant::now();
            // 窗口连续"不在"的轮询次数：把「该不该重建」的判定降到约 30 秒一次，
            // 否则每 60ms 就要查一次库。
            let mut missing_ticks: u64 = 0;
            // 窗口「该可见却不可见」的连续轮询次数（V46：用于按 tick 计数后再查库，
            // 见下面「显示态却不可见 → 无条件捞回」那段）。
            let mut hidden_ticks: u64 = 0;
            // 「原生图标是否又露出来了」的观察节奏（V48）：每 4 拍（≈100ms）看一次。
            let mut icon_watch_ticks: u64 = 0;
            // 「显示器配置变了没」的复核节奏（V83）：每 40 拍（≈1 秒）看一次。
            let mut bounds_ticks: u64 = 0;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));
                // V82：系统菜单期间把桌面还给系统 —— 事件旁听的**轮询兜底**。
                // 放在最前面：菜单可能在任何一刻弹出，而它弹出后用户马上就会去点
                // 「新建文件夹」，能否在菜单还开着的时候就借出，直接决定那一条菜单项
                // 生效不生效（详见 `platform::desktop_handoff` 的文件头）。
                crate::platform::desktop_handoff::poll_menu();
                let Some(win) = app.get_webview_window(GRID_LABEL) else {
                    // 窗口已销毁 → 图标若仍在代管必须先还回去
                    release_icons_if_taken(&app);
                    // V34：**格子层不该"没了就没了"**。用户对桌面整理的预期是
                    // 「它就是桌面的一部分，除非 Handy 主程序退出」。所以这里区分两种
                    // 情况，而不是一律退出线程：
                    //   - 用户要的是显示态（overlay_visible = 1）→ 重建挂件层；
                    //   - 用户主动收起了 → 线程退出，不做无谓重建。
                    missing_ticks += 1;
                    if missing_ticks % 500 == 1 {
                        if !read_overlay_visible(&app) {
                            break;
                        }
                        let now = unix_secs();
                        if now.saturating_sub(LAST_RESURRECT_AT.load(Ordering::Relaxed))
                            >= RESURRECT_COOLDOWN_SECS
                        {
                            LAST_RESURRECT_AT.store(now, Ordering::Relaxed);
                            grid_log("挂件窗已不在，但状态是「显示中」，自动重建挂件层");
                            if let Err(err) = show_overlay(&app) {
                                grid_log(&format!("重建挂件窗失败：{err}"));
                            }
                        }
                    }
                    continue;
                };
                missing_ticks = 0;
                // V83：**显示器配置随时可能变** —— 插上/拔掉外接屏、改分辨率或缩放、
                // 把「主显示器」换到另一台。变了就三件事：把窗口贴回新的工作区、
                // 告诉前端重排（格子立刻铺满新的可用区），用户不必去点「整理」。
                //
                // 为什么必须在轮询线程里做：`ensure_overlay_window` 只在**开窗那一次**
                // 对齐，而窗口是常驻的 —— 用户插上外接屏的那一刻，没有任何人会再叫它一次。
                // 1 秒一次足够（人插线到看清桌面远不止 1 秒），开销也只是一次
                // `app.primary_monitor()`。
                //
                // ⚠️ `sync_overlay_bounds` 内部遇到「桌面正借给系统」会直接返回 false，
                // 这里不需要再判一次 `handoff_active()`。
                bounds_ticks += 1;
                if bounds_ticks % BOUNDS_CHECK_TICKS == 0 && sync_overlay_bounds(&app) {
                    let _ = app.emit_to(GRID_LABEL, EVENT_BOUNDS_CHANGED, ());
                }
                // V35：Win+D /「显示桌面」会给所有顶层窗发最小化 —— 挂件窗虽然贴在桌面
                // 正上方，但并不是桌面的子窗口，一样会被最小化掉。这里每轮检查一次，
                // 被最小化就立刻还原（用户看到的是「格子一直都在」）。
                if restore_if_minimized(&win) {
                    // 刚还原：这一轮先不判穿透/心跳，下一轮（25ms 后）再照常走
                    //
                    // V48：**当场**把「接管」也补上。Win+D 会给所有顶层窗发最小化，
                    // 系统在还原之后通常也会把原生桌面图标放回来 —— 而重新藏图标
                    // 原先只挂在周期自检上（V47 及以前 1 秒一次），用户看到的就是
                    // 「Win+D 之后桌面一两秒才恢复原样」。这里不等周期：
                    // 还原即复核，把这段等待压到 0。
                    reassert_takeover(&app);
                    last_reassert = std::time::Instant::now();
                    // 窗口刚被系统动过（最小化→还原），实际穿透态不可知 ⇒ 让缓存失效
                    POLLER_IGNORE.store(IGNORE_UNKNOWN, Ordering::SeqCst);
                    continue;
                }
                if !win.is_visible().unwrap_or(false) {
                    // 窗口不可见 = 光标永远不可能落在它上面（`cursor_hit` 也就无从谈起）：
                    // 一律穿透，别让「强制可交互」把不可见的窗口变成事件黑洞。
                    apply_ignore(&win, true);
                    // —— V46：显示态却不可见 = 违反不变量 I2，无条件捞回来 ——
                    //
                    // 用户原话：「按理说应该不管什么情况，只要是桌面都无条件显示整理
                    // （除非是桌面整理关闭状态）」。此前这里只做「图标归还」的兜底，
                    // **没有任何路径把窗口重新显示出来** —— 一旦它被外部隐藏（最小化以外的
                    // 隐藏路径 / 显示桌面 / 第三方桌面工具），桌面就永久少了一层，
                    // 只能靠用户去托盘「显示/隐藏」瞎点。
                    // 1 秒宽限避开 show/hide 切换与 Explorer 重建的瞬态；
                    // 每 25ms 一次不可能每轮查库，所以按 tick 计数后再查。
                    // V81：系统菜单期间挂件窗是**我们自己**临时收起的
                    // （`platform::desktop_handoff` 把桌面借给系统）。这时它「不可见」是
                    // 预期状态，绝不能被当成「被外部隐藏」自愈回来 —— 那层一旦糊回来，
                    // 刚还回去的原生桌面又被盖住，用户新建的文件夹照样看不见。
                    if handoff_active() {
                        continue;
                    }
                    hidden_ticks += 1;
                    if hidden_ticks % VISIBLE_RECOVER_TICKS == 0 {
                        if read_overlay_visible(&app) {
                            grid_log("挂件层处于显示态却不可见，自动恢复显示并摆回桌面层");
                            let _ = win.show();
                            let _ = apply_attach(&win, AttachMode::current());
                            mark_overlay_shown();
                            POLLER_IGNORE.store(IGNORE_UNKNOWN, Ordering::SeqCst);
                            hidden_ticks = 0;
                            continue;
                        }
                        // 用户要的就是收起态（overlay_visible = false）：这就是正常态，
                        // 但**显示态标记**落盘为 false 才算真的「桌面整理关闭」，
                        // 避免下轮又白查一次库。
                    }
                    // 挂件不可见却还代管着图标 = 泄漏（非 grid_overlay_hide 路径的隐藏）。
                    // V40：**不再一不可见就归还** —— 先记下起点，只有连续不可见超过
                    // OVERLAY_AWAY_GRACE_SECS 才真归还（理由见该常量）。
                    let now = unix_secs().max(1);
                    let since = OVERLAY_AWAY_SINCE.load(Ordering::Relaxed);
                    if since == 0 {
                        OVERLAY_AWAY_SINCE.store(now, Ordering::Relaxed);
                    } else if now.saturating_sub(since) >= OVERLAY_AWAY_GRACE_SECS {
                        if ICONS_TAKEN.load(Ordering::Relaxed) {
                            grid_log(&format!(
                                "挂件层已连续 {OVERLAY_AWAY_GRACE_SECS} 秒不可见，把系统桌面图标还回去"
                            ));
                        }
                        release_icons_if_taken(&app);
                    }
                    continue;
                }
                hidden_ticks = 0;
                if OVERLAY_AWAY_SINCE.swap(0, Ordering::Relaxed) != 0 {
                    // 刚从「不可见」回来：立刻确认接管态，不等下一次周期自检（那最多差 3 秒，
                    // 而用户在这 3 秒里看到的正是「格子 + 原图标」）
                    reassert_takeover(&app);
                }
                // —— V48：原生图标「被系统放回来」的快速纠正（对齐 Win+D 体感） ——
                //
                // 用户原话：「我 win+d 后展示桌面每次都要 1-2 秒才能显示桌面图标格子等，
                // 这个正确吗？我们正常的桌面显示直接就能看到桌面内容的」。
                // Win+D 之后 Explorer 会把 `SysListView32` 重新显示出来，桌面就变成
                // 「格子 + 原生图标」两份内容 —— 必须尽快重新藏起来。
                // 观察每 4 拍（≈100ms）一次，只在**藏→露**翻转时动手（稳态零读库）；
                // 真正纠正时 `reassert_takeover` 还会复核接管偏好与显示态（不变量 I1）。
                icon_watch_ticks += 1;
                if icon_watch_ticks % 4 == 0 && ICONS_TAKEN.load(Ordering::Relaxed) {
                    let visible = desktop_icons_visible();
                    if visible && !ICONS_WERE_VISIBLE.swap(true, Ordering::Relaxed) {
                        reassert_takeover(&app);
                    } else if !visible {
                        ICONS_WERE_VISIBLE.store(false, Ordering::Relaxed);
                    }
                }
                // 周期性校验层级（层级不对才重排）：Explorer 重启 / 别的窗口插队后自愈。
                // 按**时间**触发，与轮询周期解耦（见 REASSERT_INTERVAL_MS 的说明）。
                if last_reassert.elapsed() >= std::time::Duration::from_millis(REASSERT_INTERVAL_MS) {
                    last_reassert = std::time::Instant::now();
                    reassert_attach(&win);
                    // V39：接管也要自检 —— 图标被系统恢复（Win+D / 显示桌面 / Explorer 重建）
                    // 之后必须重新藏起来，否则桌面就永久变成「格子 + 原图标」两份内容。
                    reassert_takeover(&app);
                }
                // 白屏自愈（V33 收窄）：**只在冷启动后从未收到过心跳**时才判定前端没起来。
                // 稳态心跳可能被 WebView2 后台节流拉长到几分钟，绝不能据此销毁重建 ——
                // 那正是用户看到的「闪一下就没了 / 莫名又出来了」。
                {
                    let shown_at = OVERLAY_SHOWN_AT.load(Ordering::Relaxed);
                    let now = unix_secs();
                    // 「显示之后一次心跳都没有」才是前端没起来；稳态心跳被节流不影响判定
                    let no_beat_since_show = HEARTBEAT_SEQ.load(Ordering::Relaxed)
                        == SHOWN_HEARTBEAT_SEQ.load(Ordering::Relaxed);
                    let cold_failed = shown_at > 0
                        && no_beat_since_show
                        && now.saturating_sub(shown_at) > HEARTBEAT_COLD_START_SECS;
                    if cold_failed {
                        let attempts = REBUILD_ATTEMPTS.load(Ordering::Relaxed);
                        let cooldown_ok =
                            now.saturating_sub(LAST_REBUILD_AT.load(Ordering::Relaxed))
                                > HEARTBEAT_REBUILD_COOLDOWN_SECS;
                        if attempts < HEARTBEAT_REBUILD_MAX && cooldown_ok {
                            REBUILD_ATTEMPTS.store(attempts + 1, Ordering::Relaxed);
                            LAST_REBUILD_AT.store(now, Ordering::Relaxed);
                            grid_log(&format!(
                                "前端冷启动无心跳（显示后超过 {HEARTBEAT_COLD_START_SECS} 秒仍无心跳，第 {} 次重建）",
                                attempts + 1
                            ));
                            let _ = win.close();
                            std::thread::sleep(std::time::Duration::from_secs(2));
                            if let Err(err) = show_overlay(&app) {
                                grid_log(&format!("挂件窗重建失败：{err}"));
                            }
                            continue;
                        }
                        if attempts >= HEARTBEAT_REBUILD_MAX
                            && !REBUILD_GAVE_UP.swap(true, Ordering::Relaxed)
                        {
                            grid_log("挂件前端多次冷启动失败，已放弃自动重建（请手动收起再显示格子）");
                        }
                    }
                }
                let want_interactive =
                    cursor_hit(&win) || FORCED_INTERACTIVE.load(Ordering::Relaxed);
                apply_ignore(&win, !want_interactive);
            }
            POLLER_RUNNING.store(false, Ordering::SeqCst);
        });
    if let Err(err) = spawned {
        POLLER_RUNNING.store(false, Ordering::SeqCst);
        eprintln!("[Handy] 启动挂件光标轮询失败：{err}");
    }
}

/// 图标当前是否由挂件层代管（true = 已被我们藏起、必须负责恢复）。
/// 挂件窗任何**非正常收起**路径（窗口被销毁、被外部隐藏）由轮询线程据此兜底恢复 ——
/// V30.1 用户实测踩坑：最小化 Handy 后原生桌面回来了、图标却还是空的。
static ICONS_TAKEN: AtomicBool = AtomicBool::new(false);

/// 当前是否处于接管态（原生桌面图标被我们藏着）。
///
/// V81：给 `platform::desktop_handoff` 用 —— 它在**收回桌面的那一刻**要重新问一次，
/// 因为菜单里就有我们注入的「退出桌面整理」，用户点了之后图标必须留着。
pub fn icons_taken() -> bool {
    ICONS_TAKEN.load(Ordering::Relaxed)
}

/// 桌面此刻是否被我们**主动**借给了系统（见 `platform::desktop_handoff`）。
///
/// 借出期间「原生图标露着」和「挂件窗不可见」都是我们自己造成的，所有接管自愈
/// （[`reassert_takeover`] / 窗口不可见恢复 / 连续不可见归还）都必须让路，
/// 否则「还回去的桌面」会在 100ms 内被抢回来 —— 那与没修是一样的。
fn handoff_active() -> bool {
    #[cfg(target_os = "windows")]
    {
        crate::platform::desktop_handoff::is_active()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 上一次观察到的「原生桌面图标是否露着」（V48）。
///
/// # 为什么需要一个记忆位
///
/// Win+D /「显示桌面」除了给顶层窗发最小化，还会把原生桌面图标放回来。
/// 判定「图标露出来了」很便宜（一次 `IsWindowVisible`），但**纠正**要读库确认接管偏好
/// （两次 SQLite 连接），不能每 25ms 都做。所以轮询循环里每约 100ms 观察一次，
/// 只在**状态翻转**（藏 → 露）时调一次 [`reassert_takeover`]：
/// 稳态零次读库，而 Win+D 之后最坏 100ms 内就把图标重新收起。
static ICONS_WERE_VISIBLE: AtomicBool = AtomicBool::new(false);

/// 挂件层「连续不可见」的起点（unix 秒；0 = 此刻可见）。
///
/// 存在的理由见 [`OVERLAY_AWAY_GRACE_SECS`]。
static OVERLAY_AWAY_SINCE: AtomicU64 = AtomicU64::new(0);

/// 显示器几何的连续纠正次数（超过 [`BOUNDS_MAX_FIXES`] 就退避）。
static BOUNDS_FIXES: AtomicU32 = AtomicU32::new(0);

/// 显示器几何纠正的退避截止时间（unix 秒）。
static BOUNDS_RETRY_AT: AtomicU64 = AtomicU64::new(0);

/// 挂件层连续不可见多久才把图标还给系统（V40）。
///
/// V30.1 的教训是「挂件层真没了，图标却还藏着」；V38/V39 就按那条教训做了
/// 「一不可见立刻归还」。但 Win+D / 「显示桌面」/ 第三方工具都会让挂件层**瞬态**不可见，
/// 于是图标被还回去、下一次自检才收回来 —— 用户看到的就是桌面闪出两份内容，
/// 而若那次自检没跑到（或用户就在这时截图），就成了「源图标还在」。
/// 30 秒足够区分「瞬态」与「真的收起了」：真收起/退出走 [`grid_overlay_hide`] 的立即归还。
const OVERLAY_AWAY_GRACE_SECS: u64 = 30;

/// 桌面接管开关（对称）：格子层贴上桌面时隐藏系统图标，收起时恢复。
///
/// 仅在贴桌模式有意义（普通窗口模式下系统图标本来就看得见，无需也不该去动）。
/// 隐藏失败不阻断显示（例如桌面图标视图已被第三方桌面工具接管时找不到句柄），
/// 只留日志 —— 格子层照样可用，只是出现「格子 + 原图标」双层。
///
/// 返回「此刻图标是否确实被我们藏起来了」（V38 起把结果透给调用方，让 UI 能说实话）。
fn takeover_icons(app: &AppHandle, hidden: bool) -> bool {
    let applied = matches!(desktop_icons_apply(hidden), Ok(true));
    match (hidden, applied) {
        (true, true) => {
            let _ = write_icons_hidden(app, true);
        }
        (true, false) => {
            grid_log("未找到系统桌面图标视图，跳过隐藏（可能已被第三方桌面工具接管）");
        }
        (false, false) => {}
        (false, true) => {
            let _ = write_icons_hidden(app, false);
        }
    }
    // 只有真正把图标藏起来才标记代管；恢复或失败一律解除
    let taken = applied && hidden;
    let was = ICONS_TAKEN.swap(taken, Ordering::Relaxed);
    // V40：**状态真变化才落盘一行**（含句柄，便于下次拿它跟探针输出对照）。
    // 以前这里只在失败时写日志，「图标什么时候被谁还回去的」在 handy.log 里查不到，
    // 用户反馈「源图标还在」时只能靠猜 —— 这是 V38/V39 两轮都没查出根因的直接原因。
    if was != taken {
        match (taken, applied) {
            (true, _) => grid_log(&format!(
                "接管桌面图标：已隐藏系统桌面图标视图（view={:?}）",
                desktop_icon_view()
            )),
            (false, true) => grid_log("交还系统桌面图标：原生图标已恢复显示"),
            (false, false) => {}
        }
    }
    taken
}

/// 兜底恢复：挂件层已不可见但图标仍在代管 → 立即还给系统（轮询线程调用）。
fn release_icons_if_taken(app: &AppHandle) {
    if ICONS_TAKEN.swap(false, Ordering::Relaxed) {
        let _ = desktop_icons_apply(false);
        let _ = write_icons_hidden(app, false);
        // ⚠️ V39 起走 grid_log 落盘：V38 这里是 println!，**只进控制台、不写 handy.log**，
        // 于是「图标被谁还回去了」在复盘时完全看不见 —— 用户反馈「源图标还在」时，
        // 这个盲区让排查多绕了一大圈。
        grid_log("挂件层已不可见，把系统桌面图标还给系统");
    }
}

/// **接管自检**（V39）：偏好要求接管、图标却露出来了 → 重新隐藏。
///
/// # 为什么必须有这一步（用户反馈「源图标还在」的真根因）
///
/// 轮询线程里有一条兜底：挂件窗一旦不可见就 [`release_icons_if_taken`]（把图标还给系统）。
/// 这是 V30.1 的教训（最小化 Handy 后桌面空着没人管），本身没错 —— **错在还回去之后
/// 没有任何路径再收回来**：用户按一次 Win+D（或点「显示桌面」、Explorer 重建、Z 序纠正
/// 的瞬间），挂件窗短暂不可见 → 图标归还 → 此后永远是「格子 + 原图标」两份内容，
/// 正是用户截图里那句「源图标还在」。
///
/// 所以这里补上对称的另一半：只要偏好还是「接管」，就周期性确认图标确实被藏住了，
/// 没藏住就重新藏。与 Z 序自检同节奏（[`REASSERT_INTERVAL_MS`]）、同样带保险丝。
fn reassert_takeover(app: &AppHandle) {
    // V81：桌面被借给系统期间（菜单开着），「原生图标露着」是我们主动造成的，
    // 不是被系统恢复 —— 这里若照常纠正，就会把菜单期间新建的文件再一次藏进暗处。
    if handoff_active() {
        return;
    }
    if !read_takeover(app) {
        // 用户没选接管：清零计数，下次开启接管时从干净状态开始
        TAKEOVER_FIXES.store(0, Ordering::Relaxed);
        return;
    }
    // —— 不变量 I1（见 docs/02-architecture/DESKTOP-LAYER.md §2.3）：`Off` 态绝不藏图标 ——
    //
    // V45 装机实测踩到的空桌面：用户点工具栏「隐藏」→ `grid_overlay_hide` 交还图标，
    // 但**接管偏好**（`META_KEY_TAKEOVER`）仍然是「开」，于是 3 秒后这里又把图标藏回去。
    // 用户面对的是「格子内容已收起 + 原生图标也被藏」= 一个什么都没有的桌面
    // （用户原话：「桌面全都消失了」）。所以这里必须先读唯一真源 `overlay_visible`。
    if !read_overlay_visible(app) {
        TAKEOVER_FIXES.store(0, Ordering::Relaxed);
        // 万一有路径漏了交还，这里兜底还给系统 —— `Off` 态的原生图标必须在。
        release_icons_if_taken(app);
        return;
    }
    if ICONS_TAKEN.load(Ordering::Relaxed) && !desktop_icons_visible() {
        // 已经藏好了：正常态
        TAKEOVER_FIXES.store(0, Ordering::Relaxed);
        return;
    }
    // 保险丝：连续失败到顶了 → 退避期内不再尝试（避免与第三方桌面工具互相打架）
    let now = unix_secs();
    if TAKEOVER_RETRY_AT.load(Ordering::Relaxed) > now {
        return;
    }
    if takeover_icons(app, true) {
        TAKEOVER_FIXES.store(0, Ordering::Relaxed);
        // 限流写日志：正常态不刷屏，但保留「确实被系统恢复过」这条证据
        if now.saturating_sub(LAST_TAKEOVER_LOG_AT.load(Ordering::Relaxed))
            >= TAKEOVER_LOG_INTERVAL_SECS
        {
            LAST_TAKEOVER_LOG_AT.store(now, Ordering::Relaxed);
            grid_log("桌面图标曾被系统恢复（多为 Win+D / 显示桌面 / Explorer 重建），已重新接管");
        }
        return;
    }
    let fixes = TAKEOVER_FIXES.fetch_add(1, Ordering::Relaxed) + 1;
    if fixes >= TAKEOVER_MAX_FIXES {
        TAKEOVER_RETRY_AT.store(now + TAKEOVER_BACKOFF_SECS, Ordering::Relaxed);
        TAKEOVER_FIXES.store(0, Ordering::Relaxed);
        grid_log("连续多次无法隐藏系统桌面图标（多半被第三方桌面工具接管），暂停自动接管 5 分钟");
    }
}

/// 创建（幂等复用）并显示挂件窗。
///
/// 系统桌面图标的隐藏**不在这里决定**（V38）：由用户的「接管桌面」偏好
/// （[`META_KEY_TAKEOVER`]，一键整理时置位）决定，见 [`apply_takeover_pref`]。
/// V32 曾为了「原桌面 + 多一些格子」的共存形态彻底关掉自动隐藏 —— 那时格子只是
/// 额外一层；V37 起格子变成桌面的**呈现层**（文件不再移动），两份图标并存就成了
/// 用户眼里的「桌面有两个相同的内容」，所以又需要它回来，但必须是**用户可切换的偏好**
/// 而不是每次启动都擅自决定的动作。
/// 确保挂件窗存在并可见、已贴到基准层（不改动接管态 / 命中区域状态）。
///
/// 新建与复用两条路径共用，避免 `show_overlay` / `show_launcher_only` 各写一遍建窗逻辑。
fn ensure_overlay_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let mode = read_attach_mode(app);
    // V83：清掉历史遗留的几何缓存（见 [`primary_work_area`] 上方的说明）。
    // 放在最前面：无论新建还是复用，这条脏数据都不该再有任何机会被读到。
    drop_legacy_geometry(app);
    // 已存在 → **先按当前显示器对齐**，再 show 再归位。
    //
    // ⚠️ 顺序不能反（V34 修的关键 bug）：`show()` 会把窗口提到 Z 序**顶层**，
    // 若先 `apply_attach` 贴到桌面层、再 `show`，刚贴好的层级立刻被顶掉 ——
    // 用户看到的就是「格子跑到我其他窗口上面了」。正确顺序：先显示，再贴回桌面层。
    //
    // V83 把「对齐」插在这一串的最前面：复用分支才是**绝大多数情况**（应用每次启动、
    // 每次「显示格子」都走这里），而窗口可能是在**另一套显示器配置**下建的 ——
    // 接/拔第二块屏、改分辨率或缩放之后，不重新对齐就一直是错的尺寸
    // （用户 09-28 截图：内容挤在 1138×608 的角落里）。放在 `show()` 之前是必要的：
    // 先摆对位置再显示，否则用户会看到它「先在错位置出现、再跳一下」。
    if let Some(existing) = app.get_webview_window(GRID_LABEL) {
        sync_overlay_bounds(app);
        let _ = existing.show();
        let _ = apply_attach(&existing, mode);
        return Ok(existing);
    }

    // 几何：**实时**取主显示器工作区（V83：不再读 `grid_meta.overlay_geometry` ——
    // 那份缓存会在换显示器 / 改缩放后变成错值，而窗口 `resizable(false)`，用户
    // 根本没有调整它的途径，持久化它只有害处）。
    let (x, y, width, height) = default_geometry(app);

    let win = WebviewWindowBuilder::new(app, GRID_LABEL, WebviewUrl::App(GRID_URL.into()))
        .title("桌面挂件 · Handy")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(false)
        .skip_taskbar(true)
        // ⚠️ **不要给这个窗口设 `drag_drop_enabled(false)`**（V59 踩过并查清）。
        //
        // 它的默认值是 `true`（见 `tauri-utils::config::WindowConfig::drag_drop_enabled`），
        // 于是 Tauri 会给挂件窗装一个原生 `IDropTarget` —— **从资源管理器把文件拖进格子**
        // 这条路就靠它送 `CF_HDROP` 里的真实路径（前端 `onDragDropEvent`）。
        //
        // 代价是 wry 的实现（`wry-0.55.1/src/webview2/drag_drop.rs`）在拖拽载荷里
        // **没有 `CF_HDROP` 时会把 `*pdwEffect` 写成 `DROPEFFECT_NONE`** ——
        // 也就是说：**开着它，HTML5 拖放一概不可用**（`DragEnter` 直接 return 不写
        // effect，`DragOver` 又回填初始化值 NONE）。这正是 V43–V58 里「拖动图标显示
        // 禁止符号、drop 不触发」的真正根因，跟前端怎么写无关。
        //
        // 所以内部拖拽（图标在格子之间拖）改成**指针拖拽**（见前端 `DRAG_THRESHOLD`
        // 处的说明），这一项就保持默认的 `true` —— 两套拖拽各走各的路，互不干扰。
        .visible(false)
        .inner_size(width, height)
        .position(x, y)
        .build()
        .map_err(|err| format!("创建桌面挂件窗口失败：{err}"))?;

    // 默认点击穿透；光标命中盒子区域后由轮询线程开放交互
    force_ignore(&win, true);
    // V83：上面 `inner_size` / `position` 走的是**逻辑像素**，主屏缩放不是整数时
    // （125% / 150% / 175% 都是）必然带取整误差 ⇒ 再按物理像素贴一次，让窗口严丝合缝
    // 对齐主显示器工作区。必须在 `show()` 之前 —— 先摆对再显示，不让用户看到跳动。
    sync_overlay_bounds(app);
    // 先 show 再归位：顺序理由同上（`show()` 会把窗口顶到 Z 序顶层）
    let _ = win.show();
    let _ = apply_attach(&win, mode);
    Ok(win)
}

/// 创建（幂等复用）并显示挂件窗，并接管桌面呈现（隐藏原生图标）。
///
/// 系统桌面图标的隐藏**不在这里决定**（V38）：由用户的「接管桌面」偏好
/// （[`META_KEY_TAKEOVER`]，一键整理时置位）决定，见 [`apply_takeover_pref`]。
fn show_overlay(app: &AppHandle) -> Result<(), String> {
    let _ = ensure_overlay_window(app)?;
    let _ = write_overlay_visible(app, true);
    // V79：广播给已经挂载好的前端（冷启动时前端还没起来，那次广播必然丢 ——
    // 前端挂载时会用 `grid_overlay_status` 补上，两条路互为兜底）。
    emit_visibility(app, true);
    // 冷启动基线：给 webview 启动 + React 挂载留出宽限（判定见轮询线程）
    mark_overlay_shown();
    // 新窗从零开始，自愈状态一并复位
    reset_reassert_state();
    apply_takeover_pref(app);
    grid_log("显示挂件层（复用/新建窗口）");
    ensure_poller(app.clone());
    // V81：接管之后才有「系统菜单期间把桌面还回去」这回事（没接管时原生视图本来就在）。
    // 幂等，进程内只起一次旁听线程。
    crate::platform::desktop_handoff::ensure_watcher(app);
    Ok(())
}

/// 仅显示「便携工具箱」工具栏（V44.3）：挂件窗常驻桌面，但**不接管桌面呈现** ——
/// 原生桌面图标恢复显示，格子内容不渲染。
///
/// 两种触发：① 用户点「隐藏挂件」（[`grid_overlay_hide`] 把 `overlay_visible` 置 false 后，
/// 这条让工具栏独自留在桌面上）；② 启动期 `overlay_visible` 为 false（首次安装 / 关掉桌面整理）
/// —— 桌面优先，工具栏也应常驻，否则「隐藏后 / 未接管时桌面没有任何入口」是死路。
fn show_launcher_only(app: &AppHandle) -> Result<(), String> {
    let _ = ensure_overlay_window(app)?;
    // 桌面恢复原生图标（与 `grid_overlay_hide` 对称）；`overlay_visible` 保持原值（false）
    let _ = takeover_icons(app, false);
    // V79：这条路的语义就是「内容收起」，必须告诉前端 —— 启动期前端还没挂载，
    // 广播会丢，但那时前端本来就以「收起」为初值（见 `contentHidden` 的 useState）。
    emit_visibility(app, false);
    mark_overlay_shown();
    reset_reassert_state();
    grid_log("显示桌面工具栏（格子内容收起，原生图标恢复）");
    ensure_poller(app.clone());
    Ok(())
}

/// 按用户的「接管桌面」偏好决定此刻要不要隐藏系统桌面图标（V38）。
///
/// 三条路径都会调它：新建挂件窗、复用已有窗、应用启动恢复格子层 —— 于是
/// 「整理过 → 图标藏起来」这个状态在收起再显示、重启之后都保持一致。
fn apply_takeover_pref(app: &AppHandle) {
    if read_takeover(app) {
        let taken = takeover_icons(app, true);
        if !taken {
            grid_log("接管偏好为开，但本机隐藏桌面图标失败（格子与原图标将同时显示）");
        }
    }
}

/// 读「挂件层是否应处于显示状态」（pub：供 `lib.rs` 启动期判断「桌面是否即主界面」）。
pub fn read_overlay_visible(app: &AppHandle) -> bool {
    let Ok(conn) = connect(app) else {
        return false;
    };
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_OVERLAY_VISIBLE],
            |row| row.get(0),
        )
        .ok();
    raw.as_deref() == Some("1")
}

/// 通知常驻挂件窗「整理层现在是显示还是收起」（V79）。
///
/// # 为什么必须补这一步（用户 09-25 实测：「整理没有退出」）
///
/// 前端的 `contentHidden` 是**它自己的 state**，只有两个更新来源：
/// 挂载时查一次 `grid_overlay_status`，以及收到本事件。
/// 而 V48–V78 期间，`grid:visibility` **只有托盘那条路会发**（`tray.rs`）——
/// 于是所有「不由前端发起」的显隐变化都只改了库、没改界面：
///
///   · 桌面右键菜单「退出桌面整理」→ `--hide-grid` → [`hide_overlay_now`]
///   · 桌面右键菜单「打开 Handy 桌面整理」→ `--show-grid` → [`show_overlay_now`]
///   · 轮询线程发现窗口不见了、按偏好自动重建（[`show_overlay`]）
///
/// 症状就是用户截图里那句：日志照打「收起挂件层」，桌面上的格子却一直在 ——
/// 用户连点四次「退出」都没反应（`handy.log` 11:19–11:20 四条 `收起挂件层`）。
///
/// ★ 这条与 V61「一个跨线程可变状态只许一个记账人」是同一条纪律：
/// `overlay_visible` 是唯一真源，**任何改它的地方都要把结果广播出去**，
/// 不许只在某一条路上广播。
fn emit_visibility(app: &AppHandle, visible: bool) {
    let _ = app.emit_to(GRID_LABEL, "grid:visibility", visible);
}

/// 写「挂件层是否应处于显示状态」。
fn write_overlay_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    let conn = connect(app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY_OVERLAY_VISIBLE, if visible { "1" } else { "0" }],
    )
    .map_err(|err| format!("保存挂件显示状态失败：{err}"))?;
    Ok(())
}

/// 应用启动时恢复「上次显示中」的格子层（桌面整理永久生效的关键一步）。
///
/// 由 `lib.rs` setup 在 `db::init` 之后调用；失败只留日志 —— 格子层没恢复
/// 不该拦住整个应用启动。
pub fn restore_overlay_if_visible(app: &AppHandle) {
    if read_overlay_visible(app) {
        if let Err(err) = show_overlay(app) {
            eprintln!("[Handy] 启动恢复桌面格子层失败：{err}");
        }
    } else {
        // 桌面优先（V44.3）：即便没接管，也把「便携工具箱」工具栏常驻桌面，
        // 避免「隐藏后 / 未接管时桌面没有任何入口」的死路。
        if let Err(err) = show_launcher_only(app) {
            eprintln!("[Handy] 启动显示桌面工具栏失败：{err}");
        }
    }
}

/// 显示（幂等）桌面挂件窗。
#[tauri::command]
pub async fn grid_overlay_show(app: AppHandle) -> Result<(), String> {
    show_overlay(&app)
}

/// 命令行 / 桌面右键菜单唤起（V45）：把桌面整理**完整显示**出来（内容 + 工具栏）。
///
/// 用在两条路上（见 `platform::desktop_menu`）：
///   - `handy.exe --show-grid` 冷启动 → `lib.rs` setup 里直接调；
///   - Handy 已在运行时，从桌面右键点「打开 Handy 桌面整理」→ 单实例回调里调。
///
/// 与 `restore_overlay_if_visible` 的区别：那个尊重「上次是否收起」的偏好，
/// 这个把偏好写成「显示」并立刻显示 —— 用户点菜单就是想看见它。
pub fn show_overlay_now(app: &AppHandle) {
    if let Err(err) = show_overlay(app) {
        grid_log(&format!("命令行显示挂件层失败：{err}"));
    }
}

/// 隐藏桌面挂件窗（不销毁，盒子配置保留；再次 show 复用同一窗口）。
///
/// ⚠️ V44.3：**隐藏 = 收起「格子内容」，不隐藏挂件窗**——工具栏要常驻桌面，
/// 否则隐藏后没有任何桌面入口能再打开整理（用户实测死路）。窗保持透明 + 点击穿透，
/// 仅工具栏命中区可交互；原生桌面图标恢复显示。
#[tauri::command]
pub async fn grid_overlay_hide(app: AppHandle) -> Result<(), String> {
    hide_overlay_now(&app);
    Ok(())
}

/// 收起整理层（**同步版**）—— 与 [`grid_overlay_hide`] 是同一套动作。
///
/// 抽出来是给**桌面右键菜单**那条路用的（V60 的 `--hide-grid`）：那条路从 `lib.rs` 的
/// 单实例回调 / 冷启动进来，手上只有 `AppHandle`，没有前端的 `invoke` 通道，
/// 不该为了「参数已经拿全」再绕一层 async command。
pub fn hide_overlay_now(app: &AppHandle) {
    FORCED_INTERACTIVE.store(false, Ordering::Relaxed);
    // 保持窗可见（工作台常驻），只把空白区域交还点击穿透；前端会据此收起格子内容。
    //
    // ⚠️ 这里「空白区域」是字面意思：穿透态下光标若落在**工作台上**，轮询下一拍
    // （25ms 内）就会把它重新开放 —— 所以用户点「退出整理」之后，工作台那颗
    // 「开启整理」按钮照旧点得到。别把这行改成「永久穿透」。
    if let Some(win) = app.get_webview_window(GRID_LABEL) {
        force_ignore(&win, true);
    }
    // 收起格子层即交还桌面：系统图标恢复显示（与 show 时隐藏对称）
    takeover_icons(app, false);
    let _ = write_overlay_visible(app, false);
    // V79：**这里以前漏了广播** —— 桌面右键菜单「退出桌面整理」（`--hide-grid`）走的就是
    // 这条路，没有前端的参与，于是库改了、界面不知道，桌面上的格子一直在。
    emit_visibility(app, false);
    // 收起时把 Z 序自愈的计数清零：下次显示是干净的一轮
    reset_reassert_state();
    grid_log("收起挂件层");
}

// —— 桌面右键菜单的动作中转（V60）——

/// 桌面右键菜单点下的动作，等着挂件窗来取。
///
/// # 为什么要「排队」和「唤醒」两件事都做
///
/// `lib.rs::handle_cli_args` 有两条入口，行为不一样：
///
/// | 路径 | 触发 | 只发事件会怎样 |
/// | --- | --- | --- |
/// | **热** | Handy 已在运行，单实例回调里拿到 argv | 正常 —— 挂件窗的 JS 早就注册好监听了 |
/// | **冷** | Handy 没运行，`handy.exe --new-box` 冷启动 | **必然丢** —— 事件是在 `setup` 里发的，那时 WebView 还在加载，前端一个监听都没有 |
///
/// 只发事件，冷路径就静默失效（用户点了菜单什么都没发生）；只排队，热路径要等下一次
/// 挂载才生效（当下点了没反应）。所以两者都做，并且**以排队的那一份为准**：
/// 前端收到唤醒事件时不采信事件载荷，而是回调 [`grid_take_pending_action`] 取走并清空。
/// 「取」只可能发生一次，因此哪怕两条路都走通了也**绝不会重复新建两个格子**。
static PENDING_ACTION: Mutex<Option<String>> = Mutex::new(None);

/// 桌面面板动作：打开「工具」页签（工具箱）。
///
/// V63：托盘 / 全局快捷键的「打开 Handy」从唤主窗口改成唤**桌面右侧面板** ——
/// 用户原话：「我们主程序窗口还有必要的，我觉得工具线弹出框就够了吧」。
pub const PANEL_ACTION_TOOLS: &str = "panel:tools";
/// 桌面面板动作：打开「设置」页签。
pub const PANEL_ACTION_SETTINGS: &str = "panel:settings";
/// 桌面面板动作：面板开着就关、关着就开「工具」页签（托盘左键 / 全局快捷键）。
pub const PANEL_ACTION_TOGGLE_TOOLS: &str = "panel:toggle-tools";
/// 桌面面板动作前缀：`panel:open:<target>` —— 在面板里直接打开一个目标
/// （`module:<id>` / 工具命令 id，语义同 `desktop_open_view`）。
pub const PANEL_OPEN_PREFIX: &str = "panel:open:";

/// 动作入队 + 叫醒挂件窗（[`PENDING_ACTION`]），`reveal` 决定要不要顺带展开整理层。
fn dispatch_action_inner(app: &AppHandle, action: &str, reveal: bool) {
    if reveal {
        show_overlay_now(app);
    } else if app.get_webview_window(GRID_LABEL).is_none() {
        // 面板动作要有地方落：挂件窗平时是常驻的，但被关掉 / 还没建过时这里就是 `None`，
        // 光入队会变成「点了托盘没反应」。补一次「只显示工具栏」—— 它建窗但**不接管
        // 桌面图标**，正好是开个设置面板该有的分寸。
        if let Err(err) = show_launcher_only(app) {
            grid_log(&format!("面板动作 {action}：建挂件窗失败 {err}"));
        }
    }
    match PENDING_ACTION.lock() {
        Ok(mut slot) => *slot = Some(action.to_string()),
        Err(err) => grid_log(&format!("桌面动作入队失败：{err}")),
    }
    match app.get_webview_window(GRID_LABEL) {
        Some(win) => {
            if let Err(err) = win.emit("handy://desktop-action", action) {
                grid_log(&format!("桌面动作 {action} 唤醒失败：{err}"));
            }
        }
        // 窗不在也不要紧：排队的那一份会随挂件窗下次挂载被取走
        None => grid_log(&format!("桌面动作 {action}：挂件窗不在，已入队待取")),
    }
}

/// 桌面右键菜单 → 动作入队，并把常驻挂件窗叫醒去做（见 [`PENDING_ACTION`]）。
///
/// 会先把整理层露出来：用户刚点了「新建格子」，总得看得见它落在哪儿。
pub fn dispatch_desktop_action(app: &AppHandle, action: &str) {
    dispatch_action_inner(app, action, true);
}

/// 打开**桌面右侧面板**的某一页（V63）—— 与 [`dispatch_desktop_action`] 唯一的差别是
/// **不调 `show_overlay_now`**。
///
/// 开工具箱 / 改个设置不该顺手把桌面接管了：接管会藏掉系统图标，而用户只是想改个
/// 快捷键。挂件窗是**常驻**的（`grid_overlay_hide` 只收格子内容、不关窗），所以也
/// 不需要先把它唤起来。
pub fn dispatch_panel_action(app: &AppHandle, action: &str) {
    dispatch_action_inner(app, action, false);
}

/// 取走（并清空）待办的桌面右键动作。前端在**挂载时**与**收到唤醒事件时**各调一次。
///
/// 返回值是 `Option<String>`：没待办时是 `None` —— 冷路径下前端挂载时通常拿得到，
/// 热路径下事件先到、这里 `take()` 掉，挂载那次自然就是 `None`。
#[tauri::command]
pub async fn grid_take_pending_action() -> Result<Option<String>, String> {
    match PENDING_ACTION.lock() {
        Ok(mut slot) => Ok(slot.take()),
        Err(err) => Err(format!("读取桌面右键动作失败：{err}")),
    }
}

// —— 交互 / 命中 / 打开 ——

/// 交互期显式申请：`interactive = true` 保持可交互（拖拽/缩放/重命名期间，防止
/// 光标短暂甩出盒子区域时被轮询线程切回穿透打断）；`false` 交还轮询线程控制。
#[tauri::command]
pub async fn grid_set_interactive(app: AppHandle, interactive: bool) -> Result<(), String> {
    FORCED_INTERACTIVE.store(interactive, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window(GRID_LABEL) {
        // ⚠️ 这里**不能**写成 `set_ignore_cursor_events(!interactive)`。
        //
        // 抬起鼠标那一刻（`interactive = false`）光标还压在条目上，`cursor_hit` 为真；
        // 无脑按 `!interactive` 设穿透，紧接着的第二次点击就落到下层桌面，浏览器
        // 永远凑不齐 `dblclick` —— 用户 09-21 反馈的「双击打开我的电脑 / 打开某个文件夹
        // 现在都做不到了，双击没反应」就是它。（右键不受影响：`onContextMenu` 不经过
        // `beginDragSession`，压根没改过窗口状态。）
        //
        // 所以改成按「强制标志 + 当前光标命中」重新求值一次：拖拽结束交还控制权，
        // 但光标还在命中区时**保持可交互**，穿透与否仍由「光标在哪」说了算。
        let want = interactive || cursor_hit(&win);
        win.set_ignore_cursor_events(!want)
            .map_err(|err| format!("切换挂件交互状态失败：{err}"))?;
        // 记账（`apply_ignore` 的判据是同源原子，直接写窗口没记账就会让它判错）
        POLLER_IGNORE.store(if want { 0 } else { 1 }, Ordering::SeqCst);
    }
    Ok(())
}

/// 前端上报命中区域（挂件窗客户区内**物理像素**；全量替换）。
#[tauri::command]
pub async fn grid_overlay_update_regions(regions: Vec<GridRegion>) -> Result<(), String> {
    match REGIONS.lock() {
        Ok(mut guard) => *guard = regions,
        Err(_) => return Err("更新挂件命中区域失败（内部状态异常）".to_string()),
    }
    Ok(())
}

// —— 挂件健康监控（V32）：心跳 + 故障上报 + 白屏自愈 ——

/// 挂件前端最近一次心跳的 UNIX 秒时间戳（0 = 尚未心跳过）。
static LAST_HEARTBEAT: AtomicU64 = AtomicU64::new(0);

/// 本次显示挂件窗的时刻（unix 秒，0 = 未显示）。
///
/// V33：自愈判据从「最后心跳距今多久」改成「显示后至今有没有收到过心跳」——
/// WebView2 对贴桌面层的窗口会做后台定时器节流，心跳间隔很容易被拉到 90 秒以上，
/// 旧判据会把它误判成白屏并**周期性销毁重建**（用户看到的「闪一下没了 / 又出来了」）。
static OVERLAY_SHOWN_AT: AtomicU64 = AtomicU64::new(0);

/// 心跳序号：每收到一次心跳 +1。只增不减，用于判断「显示之后有没有心跳过」。
static HEARTBEAT_SEQ: AtomicU64 = AtomicU64::new(0);

/// 本次显示挂件窗时的心跳序号基线（与当前序号相等 = 显示后一次心跳都没有）。
static SHOWN_HEARTBEAT_SEQ: AtomicU64 = AtomicU64::new(0);

/// 本进程内已自动重建挂件窗的次数（上限 [`HEARTBEAT_REBUILD_MAX`]，防重建风暴）。
static REBUILD_ATTEMPTS: AtomicU32 = AtomicU32::new(0);

/// 自动重建是否已放弃（多次失败后只记一次日志，不再刷屏）。
static REBUILD_GAVE_UP: AtomicBool = AtomicBool::new(false);

/// Z 序连续不匹配的次数（去抖用）。
static REASSERT_MISMATCH: AtomicU32 = AtomicU32::new(0);

/// 本轮已连续纠正失败的次数（到 [`REASSERT_MAX_FIXES`] 就退避）。
static REASSERT_FIXES: AtomicU32 = AtomicU32::new(0);

/// 退避期内不再纠正的截止时刻（unix 秒，0 = 不在退避）。
static REASSERT_RETRY_AT: AtomicU64 = AtomicU64::new(0);

/// 是否已触发过保险丝（只记一次日志，不刷屏）。
static REASSERT_GAVE_UP: AtomicBool = AtomicBool::new(false);

/// 上一条 Z 序纠正日志的时刻（unix 秒）：日志限流用（见 [`Z_LOG_INTERVAL_SECS`]）。
static LAST_Z_LOG_AT: AtomicU64 = AtomicU64::new(0);

/// Z 序纠正日志之间的最小间隔（秒）。
///
/// 稳态下判据正确 → 一条都不写；真正出问题时**每轮突发只留第一条**，
/// 且与上一条至少隔这么久 —— 既保住「第一次故障一定有据可查」，
/// 又不会像 V45 那样单次会话刷出 265 行把日志淹掉。
const Z_LOG_INTERVAL_SECS: u64 = 60;

/// 上次自动重建的时刻（unix 秒；用于冷却 [`HEARTBEAT_REBUILD_COOLDOWN_SECS`]）。
static LAST_REBUILD_AT: AtomicU64 = AtomicU64::new(0);

// —— V39：接管自检（桌面图标被系统恢复后自动重新隐藏）——

/// 接管自检连续失败次数（到 [`TAKEOVER_MAX_FIXES`] 就退避，防与第三方桌面工具互相打架）。
static TAKEOVER_FIXES: AtomicU32 = AtomicU32::new(0);

/// 接管自检退避截止时刻（unix 秒，0 = 不在退避）。
static TAKEOVER_RETRY_AT: AtomicU64 = AtomicU64::new(0);

/// 上次「重新接管」写日志的时刻（unix 秒）—— 限流用，免得反复 Win+D 把日志刷爆。
static LAST_TAKEOVER_LOG_AT: AtomicU64 = AtomicU64::new(0);

/// 接管自检失败几次后退避（够覆盖「第三方工具抢着管」的持续失败，又不至于一两次抖动就放弃）。
const TAKEOVER_MAX_FIXES: u32 = 5;
/// 接管自检失败后的退避时长（秒）。
const TAKEOVER_BACKOFF_SECS: u64 = 300;
/// 「重新接管」日志的最小间隔（秒）。
const TAKEOVER_LOG_INTERVAL_SECS: u64 = 60;

/// `grid_meta` 中「挂件最近一次前端故障」的键名（管理页展示，供用户截图反馈）。
const META_KEY_OVERLAY_FAULT: &str = "overlay_last_fault";

/// 当前 unix 秒（失败返回 0）。
fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 挂件生命周期日志（追加到 `%LOCALAPPDATA%/Handy/grid-debug.log`）。
///
/// 现场排查只能靠文件：贴桌面层的窗口行为受第三方桌面工具影响很大，用户说
/// 「闪一下没了」时，只有日志能区分是「Z 序反复重排」「自动重建」还是「前端白屏」。
/// 挂件层日志 —— 统一转发到 [`crate::logging`]（`%LOCALAPPDATA%\Handy\handy.log`）。
///
/// V37 之前日志写 `grid-debug.log`，且**只记窗口问题、写操作一行都不留** ——
/// V36 那次「桌面文件被复制成 5 份」因此只能靠事后翻磁盘才查清。现在统一一处，
/// 且每个会碰磁盘的命令都必须留痕（见各 `grid_item_*` / `grid_legacy_*`）。
fn grid_log(message: &str) {
    crate::logging::write_line("grid", message);
}

/// 这个文件名是不是 Handy 自己的收纳容器？
///
/// V36 血案：`桌面/Handy整理` 被当成普通文件夹参与了一次收纳 —— `fs::rename` 想把它
/// 移进自己的子目录，必然失败；随后退化成「递归复制 + 删除源」，在磁盘上炸出
/// **704 层嵌套、5 份共约 195 GB** 的副本。
///
/// 判据用「名字前缀」而不是「路径相等」：V33 写的是 `item.path == storage_key`，
/// 而归一化路径在 Windows 上受短名（`ADMINI~1`）、大小写、`\\?\` 前缀影响，
/// 字符串比较太容易漏 —— 一漏就是上面那种量级的破坏。
fn is_storage_entry(name: &str) -> bool {
    name.starts_with(STORAGE_ROOT_NAME) || name.starts_with(LEGACY_STORAGE_ROOT_NAME)
}

/// 尽力把路径规范化成可比较的形式（绝对路径 + 解析短名 / 大小写 / 软链）。
///
/// 用于「目标是不是落在源目录里面」这类安全判断 —— 目标目录**可能还不存在**
/// （正是要创建它），此时 `canonicalize` 会失败，于是退化成「规范化父目录 + 拼文件名」，
/// 逐级向上直到某个确实存在的祖先。
fn normalize_path(path: &Path) -> PathBuf {
    if let Ok(done) = std::fs::canonicalize(path) {
        return done;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) if !parent.as_os_str().is_empty() => {
            let mut base = normalize_path(parent);
            base.push(name);
            base
        }
        _ => path.to_path_buf(),
    }
}

/// 记录当前时间为中心跳基线。
fn store_heartbeat_now() {
    LAST_HEARTBEAT.store(unix_secs(), Ordering::Relaxed);
    HEARTBEAT_SEQ.fetch_add(1, Ordering::Relaxed);
}

/// 标记「挂件窗刚被显示」：重置冷启动判定基线。
fn mark_overlay_shown() {
    OVERLAY_SHOWN_AT.store(unix_secs(), Ordering::Relaxed);
    SHOWN_HEARTBEAT_SEQ.store(HEARTBEAT_SEQ.load(Ordering::Relaxed), Ordering::Relaxed);
    REBUILD_GAVE_UP.store(false, Ordering::Relaxed);
}

/// 挂件前端心跳（每 10 秒一次；JS 存活即有心跳）。仅作诊断信息记录，不再触发重建。
#[tauri::command]
pub async fn grid_overlay_heartbeat() -> Result<(), String> {
    store_heartbeat_now();
    Ok(())
}

/// 挂件层的真实状态（管理页据此对齐开关，避免「按钮与实际状态相反」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStatus {
    /// 挂件窗当前是否真的显示着
    pub visible: bool,
    /// 挂件窗是否已创建（区分「没建过」与「建了但收起了」）
    pub exists: bool,
    /// 当前基准层：`desktop`（贴桌面）或 `normal`
    pub attach_mode: String,
    /// 系统桌面图标是否处于隐藏态
    pub icons_hidden: bool,
    /// 桌面整理内容是否处于「接管呈现」态（true = 格子/未归类/Dock 在桌面上；
    /// false = 仅常驻工具栏，桌面恢复原生图标）。**注意**：挂件窗本身始终显示
    /// （工具栏常驻），此字段只描述「格子内容」是否接管，不要和 `visible` 混淆。
    pub engaged: bool,
}

/// 查询挂件层真实状态（**唯一真相来源**：窗口本身，而不是前端局部 state）。
#[tauri::command]
pub async fn grid_overlay_status(app: AppHandle) -> Result<OverlayStatus, String> {
    let visible = app
        .get_webview_window(GRID_LABEL)
        .map(|win| win.is_visible().unwrap_or(false))
        .unwrap_or(false);
    let exists = app.get_webview_window(GRID_LABEL).is_some();
    Ok(OverlayStatus {
        visible,
        exists,
        attach_mode: read_attach_mode(&app).as_str().to_string(),
        icons_hidden: read_icons_hidden(&app),
        engaged: read_overlay_visible(&app),
    })
}

/// 挂件前端故障上报（window.onerror / unhandledrejection 捕获）。
///
/// 写日志 + 落库（管理页展示）——白屏这类「看不见的故障」从此有据可查。
#[tauri::command]
pub async fn grid_overlay_fault(app: AppHandle, message: String) -> Result<(), String> {
    eprintln!("[Handy][挂件故障] {message}");
    let conn = connect(&app)?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![
            META_KEY_OVERLAY_FAULT,
            format!(
                "{} {}",
                chrono::Local::now().format("%m-%d %H:%M"),
                message.chars().take(300).collect::<String>()
            )
        ],
    )
    .map_err(|err| format!("记录挂件故障失败：{err}"))?;
    Ok(())
}

/// 读取挂件最近一次故障（无记录返回 null）。
#[tauri::command]
pub async fn grid_overlay_fault_get(app: AppHandle) -> Result<Option<String>, String> {
    let conn = connect(&app)?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![META_KEY_OVERLAY_FAULT],
            |row| row.get(0),
        )
        .ok();
    Ok(raw)
}

/// 弹出**系统原生右键菜单**（V43）。
///
/// 用户原话：「你的格子把我图标原始的右键功能全部覆盖了，这个科学吗」——
/// 接管桌面之后原生图标被隐藏，右键事件落在我们的挂件窗上，所以**我们必须替它把
/// 原生菜单弹出来**（对标腾讯桌面整理：格子里的图标右键就是系统菜单）。
/// 实现见 [`crate::platform::shell_menu`]。
///
/// 坐标不传：菜单该出现在光标处，`GetCursorPos` 是最不会算错的做法。
/// 菜单里点什么都由 Shell 自己执行完（删除 / 复制 / 属性面板），我们不回收结果。
///
/// `run_on_main_thread` 是必须的：`TrackPopupMenuEx` 自己跑模态消息循环，
/// 在异步命令的执行线程上弹菜单会一闪就没。
///
/// `extended`（V58）：true = 补 `CMF_EXTENDEDVERBS`，即 Explorer 里 **Shift + 右键** 的
/// 扩展菜单。前端在 `event.shiftKey` 时传 true —— **Shift 是系统的语义，我们不该抢**；
/// Handy 自己的条目菜单改挂 Ctrl + 右键（见 `GridOverlay.tsx`）。
#[tauri::command]
pub async fn shell_context_menu(
    app: AppHandle,
    path: String,
    extended: Option<bool>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.clone();
        let target = path.clone();
        let want_extended = extended.unwrap_or(false);
        app.run_on_main_thread(move || {
            // 菜单挂在自己的挂件窗上（它就是盖在桌面上的那层）；窗口没了才退回主窗
            let win = handle
                .get_webview_window(GRID_LABEL)
                .or_else(|| handle.get_webview_window("main"));
            let hwnd = win
                .and_then(|w| w.hwnd().ok())
                .map(|h| HWND(h.0 as *mut std::ffi::c_void))
                .unwrap_or_default();
            if let Err(err) =
                crate::platform::shell_menu::show_context_menu(hwnd, &target, want_extended)
            {
                grid_log(&format!("原生右键菜单失败（{target}）：{err}"));
            }
        })
        .map_err(|err| format!("投递右键菜单失败：{err}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, path, extended);
        Err("当前平台暂未适配原生右键菜单".to_string())
    }
}

/// 弹出「桌面**背景**」的原生右键菜单，并把用户「新建」出来的项**作为返回值**带回（V87/V89）。
///
/// 用户 10-08 原话：「我们只是把桌面上的图标整理移动到整齐的位置上，你现在是直接把桌面
/// 完全改掉了呢？新建文件夹 / 新建文本文档等右键功能都不是原生的，问题很多」。
///
/// V81–V86 那一整套「菜单期间把桌面借给系统、收工时再收回」的补丁，到此让位给
/// **我们自己把那张菜单弹出来** —— 不再赌 `#32768` 的类名语义（Win11 25H2 的新式菜单
/// 根本不是它），不再需要「安静 1.5s」与 120s 超时，也不再有「只有第一次新建成功」。
///
/// # V89：命令直接返回「新建结果」而非事件
///
/// 菜单必须在有消息循环的主线程上弹（`run_on_main_thread`）。V88 那套「弹完广播
/// `grid:item-created` 事件 + 前端 30ms 竞速认领」会在**菜单还没弹出来时**就被竞速判成
/// 「没新建」而触发整层刷新——这正是「卡 + 整体刷新」的残留根因。V89 改用 `std::sync::mpsc`
/// 通道：主线程把菜单弹完、把「新建」产出的 [`crate::platform::shell_menu::CreatedItem`]
/// 发回命令线程，命令直接 `return` 这个值。前端据此决定「增量认领 + 原地改名」还是
/// 「全量对账」，桌面**永不翻白**、新建**不再整层刷新**。
///
/// 实现见 [`crate::platform::shell_menu::show_background_context_menu`]。
#[tauri::command]
pub async fn shell_desktop_background_menu(
    app: AppHandle,
    extended: Option<bool>,
) -> Result<Option<crate::platform::shell_menu::CreatedItem>, String> {
    #[cfg(target_os = "windows")]
    {
        let handle = app.clone();
        let want_extended = extended.unwrap_or(false);
        // 菜单在主线程弹；用通道把「新建结果」带回命令线程（它不是 `Send` 友好类型，但
        // `CreatedItem` 是 `Clone + Serialize`，跨线程发一份没问题）。
        let (tx, rx) =
            std::sync::mpsc::channel::<Option<crate::platform::shell_menu::CreatedItem>>();
        app.run_on_main_thread(move || {
            use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
            let win = handle
                .get_webview_window(GRID_LABEL)
                .or_else(|| handle.get_webview_window("main"));
            let hwnd = win
                .and_then(|w| w.hwnd().ok())
                .map(|h| HWND(h.0 as *mut std::ffi::c_void))
                .unwrap_or_default();
            let hwnd_raw = hwnd.0 as isize;

            // V90：原生菜单的宿主是**隐藏的** `SHELLDLL_DefView`。先把前台给一个**可见**窗口
            // （就是我们自己这层挂件窗），否则 Explorer 弹出的菜单会「点外面不消失」（Win32 经典坑）。
            unsafe {
                let _ = SetForegroundWindow(hwnd);
            }

            // —— 首选：转发给 Explorer 的桌面视图，让它弹**它自己的完整原生菜单**（V90）——
            // 那条链上有「查看 / 排序方式 / 刷新」和完整的 ShellNew「新建」14 项 —— 这两块
            // 都不经过 IContextMenu，复刻拿不到（用户 10-08 23:01 的对比图就是在说这个）。
            //
            // V91：转发**立刻返回**（XAML 宿主在别的线程弹出），所以「等菜单出现 / 等收起」
            // 必须挪到后台线程 —— 在这条 UI 线程上 sleep 会把整个前端冻住。
            let state = match crate::platform::shell_menu::forward_desktop_view_menu() {
                Ok(state) => state,
                Err(err) => {
                    grid_log(&format!("桌面右键转发失败：{err}"));
                    let _ = tx.send(None);
                    return;
                }
            };

            let fallback_handle = handle.clone();
            std::thread::spawn(move || {
                if crate::platform::shell_menu::await_desktop_view_menu(&state) {
                    // 原生完整菜单走完了。用户点了什么我们不知道（新建 / 粘贴 / 删除 / 排序…）
                    // ⇒ 交给前端做增量对账：新增进竖条并进改名、有删除才重排。
                    let _ = tx.send(None);
                    return;
                }
                // —— 回退：V89 的复刻菜单（这台机器不吃转发时的保底）——
                // `TrackPopupMenuEx` 要求宿主窗口所在线程有消息泵 ⇒ 必须回 UI 线程弹。
                let tx2 = tx.clone();
                let posted = fallback_handle.run_on_main_thread(move || {
                    let h = HWND(hwnd_raw as *mut std::ffi::c_void);
                    let result = crate::platform::shell_menu::show_background_context_menu(
                        h,
                        want_extended,
                    );
                    // 菜单已收起（含「新建」落地 / 取消），把结果发回；失败按「没新建」处理。
                    let _ = tx2.send(result.unwrap_or(None));
                });
                if posted.is_err() {
                    let _ = tx.send(None);
                }
            });
        })
        .map_err(|err| format!("投递桌面背景菜单失败：{err}"))?;
        // 阻塞等结果。注意：UI 线程只做了「转发」就撒手了（不睡眠），真正在等菜单的是上面
        // 那个后台线程 —— 所以前端不会冻。Tauri 主线程自身跑着消息循环，也不会死锁。
        rx.recv()
            .map_err(|err| format!("读取新建结果失败：{err}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, extended);
        Err("当前平台暂未适配桌面背景菜单".to_string())
    }
}

/// 从**桌面层**（格子挂件窗 / 快捷条）唤出主窗口并跳到指定视图（V42）。
///
/// 用户原话：「我们这个工具本来就是为了方便顺手使用，其他都可以直接在桌面上实现功能，
/// 不需要一个独立的窗口打开才操作，在桌面上我能快速搜索并一键打开工具、一键打开密码存储箱」。
///
/// 视图状态是**每个窗口各持一份**的（ARCHITECTURE ADR-8）：挂件窗改不了主窗口的 store，
/// 所以走「显示主窗口 + 发 `handy:navigate` 事件」，与 `bar_open_command` /
/// `bar_open_workstation` 完全同一套机制（主窗口的 `main.tsx` 在监听）。
///
/// `target` 的语义与那个监听一致：
///   - `module:<id>` → 打开模块视图（如 `module:vault` 打开密码存储器）；
///   - `settings` → **不开主窗口**，直接在桌面面板的「设置」页签里打开（V63）；
///   - 其余非空字符串 → 当作**工具 / 命令 id** 打开（如 `timestamp`、`json-format`）。
#[tauri::command]
pub async fn desktop_open_view(app: AppHandle, target: String) -> Result<(), String> {
    let target = target.trim().to_string();
    if target.is_empty() {
        return Err("导航目标为空".to_string());
    }
    // V63：设置不再经过主窗口 —— 用户「其他功能我们都已经在桌面上实现了…没有必要还有
    // 一个多一个界面，快捷键设置直接弹出工具箱弹窗」。走面板动作而非 `show_main_palette`。
    if target == "settings" {
        dispatch_panel_action(&app, PANEL_ACTION_SETTINGS);
        return Ok(());
    }
    crate::window::show_main_palette(&app)?;
    if let Some(win) = app.get_webview_window(crate::window::MAIN_LABEL) {
        win.emit("handy:navigate", target)
            .map_err(|err| format!("通知主窗口失败：{err}"))?;
    }
    Ok(())
}

/// 打开条目原文件（经 shell 插件 Rust API 唤起系统默认程序）。
///
/// 说明：本地路径打开走 Rust 侧 `shell().open`，不经前端 `shell:allow-open` 的
/// URL 作用域校验（该作用域默认仅放行 http/mailto/tel），保证「打开原文件」
/// 这一核心能力不被作用域误伤；同时 capabilities 仍按任务要求扩展了 open 作用域，
/// 供前端 `ipc.shellOpen` 等既有调用使用。
#[tauri::command]
pub async fn grid_open_path(app: AppHandle, path: String) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("文件路径为空".to_string());
    }
    // 「系统」格子的虚拟条目（::{CLSID}，如此电脑 / 回收站）：不走 shell 插件，
    // 直接 ShellExecuteW 打开 shell 命名空间 —— 插件对非文件系统路径的校验
    // 不可控，这里显式处理并检查返回值（≤32 = 失败码）。
    #[cfg(target_os = "windows")]
    if path.starts_with("::") {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let verb = wide("open");
        let target = wide(&path);
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(target.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if (result.0 as isize) <= 32 {
            return Err(format!(
                "打开系统位置失败（ShellExecute 返回 {}）",
                result.0 as isize
            ));
        }
        return Ok(());
    }
    use tauri_plugin_shell::ShellExt;
    // shell::open 自 2.1 起标记 deprecated（官方建议迁移 tauri-plugin-opener）；
    // 本项目继续沿用已集成的 shell 插件，暂不引入新依赖，显式压掉弃用告警。
    #[allow(deprecated)]
    app.shell()
        .open(path, None)
        .map_err(|err| format!("打开文件失败：{err}"))
}

/// 在资源管理器中定位条目（条目右键的「打开文件位置」，V41）。
///
/// 右键菜单收编进格子之后，用户最怀念的原生能力就是「右键 → 打开文件位置」。
/// 走 `explorer /select,<path>`：让 Explorer 自己弹出并选中该条目，比「打开所在
/// 目录」更贴近原生右键的预期。系统命名空间入口（`::{CLSID}`，如此电脑 / 回收站）
/// 没有文件位置可言，退化为直接打开它本身。
#[tauri::command]
pub async fn grid_reveal_path(path: String) -> Result<(), String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("文件路径为空".to_string());
    }
    if path.starts_with("::") {
        // 虚拟入口（此电脑 / 回收站）：没有「所在位置」，直接打开
        #[cfg(target_os = "windows")]
        {
            use windows::core::PCWSTR;
            use windows::Win32::UI::Shell::ShellExecuteW;
            use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

            let verb = wide("open");
            let target = wide(&path);
            let result = unsafe {
                ShellExecuteW(
                    None,
                    PCWSTR(verb.as_ptr()),
                    PCWSTR(target.as_ptr()),
                    None,
                    None,
                    SW_SHOWNORMAL,
                )
            };
            if (result.0 as isize) <= 32 {
                return Err(format!(
                    "打开系统位置失败（ShellExecute 返回 {}）",
                    result.0 as isize
                ));
            }
        }
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // explorer /select 的定位路径要用反斜杠（正斜杠在部分系统版本上不选中）
        let selected = path.replace('/', "\\");
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{selected}"))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|err| format!("打开资源管理器失败：{err}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("打开文件位置仅支持 Windows".to_string())
    }
}

// ————————————————————————————————————————————————————————————————
// 一键整理 / 布局备份与还原（V19）
//
// 对标「桌面整理工具」的核心体验：**一键把满屏图标归置成几个格子**、
// **布局可备份可还原**。与 V12「建目录 + 移动文件」的根本区别仍然是
// **零磁盘副作用**：整理的是「桌面图标的呈现方式」，文件本体一个字节都不动。
// 因此「还原布局」只是丢弃 / 重建格子，不涉及任何文件回迁，天然安全。
// ————————————————————————————————————————————————————————————————

/// 一键整理的格子排布：**左起自动流**（详见 [`FlowPlacer`]）。
const ARRANGE_MARGIN: i64 = 32;
/// 相邻两列的间距（列宽统一由 [`standard_box_width`] 给出）
const ARRANGE_GAP_X: i64 = 24;
/// 同一列内相邻两个格子的纵向间隙
const ARRANGE_GAP_Y: i64 = 24;
/// 格子最小尺寸（与前端 `MIN_BOX_W/H` 一致，布局时不得再小）
const MIN_BOX_W: i64 = 160;
const MIN_BOX_H: i64 = 120;
/// 单列最多放几个格子（防病态数据把一列排到无穷）
const ARRANGE_COLUMN_CAP: i64 = 40;

/// —— 内容驱动尺寸：格子内条目网格的度量（**必须与前端 `GridOverlay.tsx` 严格对齐**）——
///
/// 前端那一处（收纳格条目网格）是：
///   `grid gap-1.5 px-2.5 py-2` +
///   `gridTemplateColumns: repeat(auto-fill, minmax(iconSize + 32px, 1fr))` +
///   `gridAutoRows: iconSize + 36px`，
///   单元格里是图标 `iconSize` + 一行文字，最外层卡片还有 1px 边框（`BOX_SHELL_CLASS`）。
/// **改前端任何一个类名都要回来改这里**，否则算出来的尺寸会与实际渲染错位。
const CELL_EXTRA_W: i64 = 32;
/// 收纳格条目网格的**行距增量** —— 对应前端 `gridAutoRows: iconSize + 36px`。
///
/// ⚠️ V65 修：V65 之前 `box_height_at` 用的是竖条那份 [`CELL_EXTRA_H`]（30），于是**每个
/// 条目行矮 6px** —— 5 行的格子矮 30px，真机上就是「条目多的格子最后一行被裁掉 / 白出滚动条」。
/// 两者是**两套度量**，别再混用：
///   · **收纳格**（卡片网格 + 图标 + 一行文字）用本常量；
///   · **左侧未归类竖条**（无卡片无标题栏，更矮）用 [`CELL_EXTRA_H`]。
const BOX_CELL_EXTRA_H: i64 = 36;
/// 竖条单元格的高度增量 —— 对应前端 `STRIP_CELL_EXTRA_H`
const CELL_EXTRA_H: i64 = 30;
/// 网格 gap-1.5 / px-2.5 py-2
const GRID_GAP: i64 = 6;
const GRID_PAD_X: i64 = 10;
const GRID_PAD_Y: i64 = 8;
/// 格子标题栏占的**总高**：`h-9`（36px）**＋ 标题栏那道 1px 的下边框**（`border-b`）。
///
/// ⚠️ **V70 唯一改动的那个数就是这个 1（用户 09-23 两张截图）**。V65–V69 一直写 36，
/// 而前端标题栏是 `h-9` + `border-b border-white/[0.06]` = **37px**。于是引擎算出来的格子
/// **每个都恰好差 1px 装不下**：
///
///   1px 溢出 ⇒ 条目网格出现内部滚动条 ⇒ 滚动条**吃掉 4px 宽** ⇒ 每行**少排一列**
///   ⇒ 需要的行数变多 ⇒ 溢出更多（正反馈）。
///
/// 真机实证（`clipboard-2026-09-23T03-53-39-538Z` 逐像素量）：`文档` 18 项按引擎是
/// 5 列 × 4 行（正好 20 格），实际渲染成 **4 列 × 4 行 = 16 格**（藏了 2 个）；`其他` 8 项
/// 应 3 列 × 3 行，实际 **2 列 × 4 行**。两个盒子都差了**正好一列** —— 1px 的账错，被滚动条
/// 放大成了一整列。用户原话：「尽可能让所有图标都直接展示出来，没有滚动条」。
///
/// ⇒ 教训：**引擎与前端之间的几何必须留余量，账算到 0 余量就是等着一像素误差翻车。**
/// 见 [`BOX_FIT_SLACK`] 与 [`GRID_SCROLLBAR_W`]。
const BOX_HEADER_H: i64 = 37;
const BOX_BORDER_H: i64 = 2;
/// 条目网格的**滚动槽宽度**（V70）。
///
/// 前端 `.grid-scroll::-webkit-scrollbar { width: 4px }` 是**经典滚动条**（占位的那种，
/// 不是 overlay）—— 它一出现就从内容宽里挖走 4px。V69 之前引擎没算这 4px，于是
/// 「本来正好排 5 列」的盒子一旦滚起来就只剩 4 列。
///
/// V70 的做法是**把它当成恒定占位**：前端 `.grid-scroll` 加 `scrollbar-gutter: stable`
/// （不管滚不滚都留着这条槽），引擎算列数时也固定减掉它。两边同时认账 ⇒
/// **有没有滚动条都不再改变一行排几列**，正反馈被掐断。
const GRID_SCROLLBAR_W: i64 = 4;
/// 尺寸**余量**（V70）：宽度与高度各多留 2px。
///
/// 为什么要有它：引擎算的是整数逻辑像素，前端还要过一遍 `1fr` 均分、设备像素比
/// （真机 1707 逻辑宽 → 1920 物理，DPR 1.125）、字体行高等，**不可能永远严丝合缝**。
/// 上面那个 1px 的教训说明：只要有一处对不上，代价不是「差 1px」，而是**少一整列 / 多一整屏滚动**。
/// 2px 的观感代价可以忽略，换来的是「1px 误差不再能翻车」。
const BOX_FIT_SLACK: i64 = 2;
/// 自动尺寸时格子「想要的列数」上限（V65 由 4 提到 5）。
///
/// 那个 4 是 V39「全批统一列宽」时代的产物。V64 起宽度已经按内容给，它只剩一个副作用：
/// 把「方形最优就是 5 列」的盒子压成 4 列 × 更多行（17 个条目：5 列 = 366×344，
/// 4 列 = 296×418）—— 面积一模一样，高度多出一大截、还更容易越过一屏。
///
/// ⚠️ 它只影响「格子想要多宽」，**不再参与「前端实际排几列」**（见 [`item_columns_at`]）。
const AUTO_MAX_COLS: i64 = 5;
/// 自动尺寸的宽度上限
const AUTO_MAX_W: i64 = 520;

/// 新建格子 / 兜底排布时的默认尺寸（内容为空时的观感尺寸）。
const ARRANGE_BOX_W: i64 = 320;
const ARRANGE_BOX_H: i64 = 244;

/// 单个收纳格（排 `cols` 列条目）需要的**外框宽度**（含边框与内边距）。
///
/// ⚠️ V65 修：宽度必须**带上前端那 1px 边框**（[`BOX_BORDER_H`]），而且必须真能让前端的
/// `repeat(auto-fill, minmax(icon + 32, 1fr))` 排出 `cols` 列。V65 之前两处都没保证 ——
/// 前端每行比引擎少排一列，引擎却按多出来的那一列估高，于是**高度虚高一整行**
/// （真机上「条目多的格子显示不全 / 下半截空着」两个症状，其实是同一个根因）。
fn box_width_for_columns(cols: i64, icon: i64) -> i64 {
    let cell_w = icon.clamp(16, 256) + CELL_EXTRA_W;
    let cols = cols.max(1);
    // `cols` 个单元格 + `cols - 1` 道缝（**内容本身**要占的宽）
    let content: i64 = cols * cell_w + (cols - 1) * GRID_GAP;
    // 再把「非内容」的四样加上：左右内边距、卡片边框、**滚动槽**、余量
    //   —— 少算任何一样，前端就会少排一列（V70：滚动槽与余量正是漏掉的那两样）
    content + 2 * GRID_PAD_X + BOX_BORDER_H + GRID_SCROLLBAR_W + BOX_FIT_SLACK
}

/// 按**条目数量**算一个收纳格「想要」多宽（用户 V39 原话：「应该根据每个格子里面内容多少
/// 自动调整大小」）。
///
/// 规则：单元格按图标尺寸定死 → 用「尽量接近正方形」的方式挑列数（上限 [`AUTO_MAX_COLS`]）→
/// 反推外框宽度。
///
/// **这是 V65 唯一的宽度来源** —— 不再有「整批统一列宽」那一层：条目多的格子宽、条目少的
/// 格子窄，这就是用户那句「根据内容多少协调空间」。
fn desired_box_width(items: usize, icon: i64) -> i64 {
    let icon = icon.clamp(16, 256);
    let cell_w = icon + CELL_EXTRA_W;
    let cell_h = icon + BOX_CELL_EXTRA_H;
    let n = items.max(1) as i64;
    let cols = (((n as f64) * (cell_h as f64) / (cell_w as f64)).sqrt().ceil() as i64)
        .clamp(1, AUTO_MAX_COLS)
        // 一个条目不需要两列 —— 平方根在 n = 1 处正好压着 1.0，`ceil` 会给出 2
        .min(n);
    box_width_for_columns(cols, icon).clamp(MIN_BOX_W, AUTO_MAX_W)
}

/// **整批统一的标准列宽**（V40）—— 现在只用于**新建格子的默认宽度 / 单格兜底**。
///
/// ⚠️ V65 起**布局主路径不再用它**：收纳格一律用「自己内容算出来的宽度」
/// （[`desired_box_width`] / [`box_own_size`]）。留在这里是因为「新建一个空格子」还需要一个
/// 看起来正常的尺寸（取本批最宽的需求，再夹到不超出工作区）。
fn standard_box_width(desired: impl Iterator<Item = i64>, work_w: i64) -> i64 {
    let needed = desired.max().unwrap_or(ARRANGE_BOX_W);
    let usable = (work_w - 2 * ARRANGE_MARGIN).max(MIN_BOX_W);
    needed.clamp(MIN_BOX_W, usable.min(AUTO_MAX_W))
}

/// 在宽度 `w` 的格子里，前端的条目网格**实际**会排出几列。
///
/// 前端是 `repeat(auto-fill, minmax(icon + 32, 1fr))` + `gap: 6px` + `padding: 0 10px`
/// + `border: 1px`：能排几列 = 外框宽减掉**左右边框与内边距**之后，还能放下几个「单元格 + 缝」。
///
/// ⚠️ V65 修两处：
///   ① **要减边框**（[`BOX_BORDER_H`]）。V65 之前没减 ⇒ 引擎按 4 列估高、前端只排 3 列，
///      条目多的格子永远矮一行；
///   ② **不再夹到 [`AUTO_MAX_COLS`]**。那个上限属于「宽度统一」时代（保证每个格子内部列数
///      一致）；现在宽度本来就按内容给，宽盒子前端真能排 7 列，夹住只会让高度虚高
///      （引擎按 4 列算行数 ⇒ 盒子下半截全是空的）。
///
/// ⚠️ V70：还要减掉**滚动槽**（[`GRID_SCROLLBAR_W`]）。前端 `.grid-scroll` 用了
/// `scrollbar-gutter: stable`，那条 4px 的槽**恒占位**；不减它，引擎就会按「多 4px」估列数，
/// 前端少排一列 ⇒ 又回到「藏图标 + 滚动条」。
fn item_columns_at(w: i64, icon: i64) -> i64 {
    let cell_w = icon.clamp(16, 256) + CELL_EXTRA_W;
    let avail: i64 = w - BOX_BORDER_H - 2 * GRID_PAD_X - GRID_SCROLLBAR_W;
    ((avail + GRID_GAP) / (cell_w + GRID_GAP)).max(1)
}

/// 宽度已定时，按条目数算高度 —— 即用户那句「高度根据图标多少自动撑开」。
///
/// 行高必须用 [`BOX_CELL_EXTRA_H`]（前端 `gridAutoRows`），**不是**竖条那份
/// [`CELL_EXTRA_H`]（V65 修：混用会让每个条目行矮 6px）。
///
/// 高度上限交由调用方给（`max_h`）：一个装了 60 个条目的格子如果照实高到 1200px，
/// 它会顶穿整个桌面；超过上限时**宁可让它内部滚动**（前端条目网格本来就是 `overflow-y-auto`），
/// 也不能让一个格子把桌面占满。
///
/// ⚠️ V70：调用方现在传的是**本带可用高**（[`content_plan_in`] 的 `zone_h`），不再是固定的
/// 460 —— 用户 09-23：「删除了很多格子后空间多了，应该重新计算大小，尽可能让所有图标都
/// 直接展示出来，没有滚动条，**除非是格子太多图标太多放不下了**」。于是「空间富余 ⇒ 长高到
/// 全见」，「真挤不下 ⇒ 交给压缩 / 内部滚」。上限仍然存在（就是桌面本身有多高），
/// 只是不再用一个与可用空间无关的常数把它锁死。
fn box_height_at(items: usize, w: i64, icon: i64, max_h: i64) -> i64 {
    let cell_h = icon.clamp(16, 256) + BOX_CELL_EXTRA_H;
    let cols = item_columns_at(w, icon);
    let n = items.max(1) as i64;
    let rows = (n + cols - 1) / cols;
    let h = BOX_HEADER_H
        + BOX_BORDER_H
        + rows * cell_h
        + (rows - 1) * GRID_GAP
        + 2 * GRID_PAD_Y
        + BOX_FIT_SLACK;
    h.clamp(MIN_BOX_H, max_h.max(MIN_BOX_H))
}

/// 单个格子的尺寸（宽度按内容、高度按该宽度）—— 给「新建格子」等**还没有整批**的场合用。
///
/// 布局主路径请走 [`box_own_size`]（它再把宽度夹进收纳区可用宽度）。本函数作为
/// 「单格规则」的**唯一表述**被单测引用，免得测试各自复制一份公式、改了生产忘了测试。
#[allow(dead_code)]
fn auto_box_size(items: usize, icon: i64, max_h: i64) -> (i64, i64) {
    let w = desired_box_width(items, icon);
    (w, box_height_at(items, w, icon, max_h))
}

/// 一个矩形（逻辑像素）—— 排布时的占位 / 禁区。
#[derive(Debug, Clone, Copy)]
struct SlotRect {
    x: i64,
    y: i64,
    w: i64,
    h: i64,
}

impl SlotRect {
    /// 两个矩形是否相交（边缘相接不算相交，允许紧贴）。
    fn intersects(&self, other: &SlotRect) -> bool {
        self.x < other.x + other.w
            && other.x < self.x + self.w
            && self.y < other.y + other.h
            && other.y < self.y + self.h
    }
}

/// **流式排布器**（V38 抽出、V39 换首次适配、V40 改**左起** + 统一列宽）。
///
/// 规则（对应用户三句话：「没有计算桌面合理的规划格子位置、流布局结构」、
/// 「格子自动流式布局，防止位置（重叠）」、「让格子对齐整齐、宽度对齐、流布局、
/// 高度根据图标多少自动撑开」）：
///   1. 从工作区**左上角**开始，一列之内自上而下摆，装不下再往右推一列；
///   2. 列宽统一（[`standard_box_width`]，全批一个宽度）—— 列若宽窄不一，
///      左右边缘就参差，用户看到的还是乱；
///   3. 每个格子用**自己的高度**（按内容量算，见 [`box_height_at`]）算占位；
///   4. **首次适配**：每列都从顶部开始找第一个放得下的空洞（V38 是「游标只增不减」，
///      被大格子切出来的空隙再也用不上，格子高低一不统一就浪费大片空间）；
///   5. `blocked` 里的矩形是禁区 —— 挂件锚点位置 + 已摆下的格子，撞上就往下让开。
///
/// 为什么从左上角起：桌面图标本来就是从左上角排起的，格子沿用同一起点最符合直觉；
/// 而右上角留给日历（挂件锚点）、左下角留给便签 —— 于是三块区域各就各位，互不打架。
/// （V38–V39 是「靠右」：日历那块大禁区正好卡在右上角，格子被迫一路往左让，
/// 最后堆在屏幕中间，两侧空空 —— 用户看到的「很乱」有一半来自这个。）
#[allow(dead_code)]
struct FlowPlacer {
    margin: i64,
    work_w: i64,
    work_h: i64,
    /// 列宽（本批格子里最宽的；决定相邻两列右边界之间的距离）
    col_w: i64,
    /// 最多摆几列（由工作区宽度与列宽推导，不再写死 8）
    max_columns: i64,
    /// **镜像流布**（V42）：`true` = 第 0 列在**最右**，列号越大越往左。
    ///
    /// 用户 V42 原话：「右边是从挂件到其他整理，从右上角依次顺序排开」——
    /// 左侧那条「未归类（快捷方式 + 系统 + 落单文件）」竖条占住左边之后，
    /// 分类格该从右边起算才符合用户描述的方位。
    mirror: bool,
    /// 允许摆放的**左边界**（V42）：留给左侧那条竖条，格子不得越过去。
    /// 普通（非镜像）流布下等于 `margin`。
    min_x: i64,
    /// 已占用的矩形（禁区 + 已摆下的格子）
    blocked: Vec<SlotRect>,
}

#[allow(dead_code)]
impl FlowPlacer {
    fn new(work_w: i64, work_h: i64, col_w: i64, blocked: Vec<SlotRect>) -> Self {
        Self::with_bounds(work_w, work_h, col_w, blocked, false, ARRANGE_MARGIN)
    }

    /// 带方向与左边界的构造（V42）。`mirror = true` 时列从右往左数，
    /// `min_x` 是左侧竖条右沿（格子越过它就会盖住用户的快捷方式）。
    fn with_bounds(
        work_w: i64,
        work_h: i64,
        col_w: i64,
        blocked: Vec<SlotRect>,
        mirror: bool,
        min_x: i64,
    ) -> Self {
        // 工作区尺寸拿不到时退回 1280×720，宁可摆得挤一点也不能算出负坐标
        let work_w = if work_w > 0 { work_w } else { 1280 };
        let work_h = if work_h > 0 { work_h } else { 720 };
        let col_w = col_w.clamp(MIN_BOX_W, AUTO_MAX_W);
        let min_x = min_x.clamp(ARRANGE_MARGIN, (work_w - ARRANGE_MARGIN).max(ARRANGE_MARGIN));
        let usable = (work_w - min_x - ARRANGE_MARGIN + ARRANGE_GAP_X).max(col_w);
        let max_columns = (usable / (col_w + ARRANGE_GAP_X)).clamp(1, ARRANGE_COLUMN_CAP);
        Self {
            margin: ARRANGE_MARGIN,
            work_w,
            work_h,
            col_w,
            max_columns,
            mirror,
            min_x,
            blocked,
        }
    }

    /// 第 `k` 列的左边界。**同一列的左边界永远相同** —— 格子宽度统一
    /// （[`standard_box_width`]）之后，这一列里所有格子的左右边缘都对齐。
    ///
    /// `mirror = true` 时 `k = 0` 是**最右**那一列（V42：分类格从右上角起排）。
    fn col_left(&self, k: i64) -> i64 {
        if self.mirror {
            self.work_w - self.margin - self.col_w - k * (self.col_w + ARRANGE_GAP_X)
        } else {
            self.margin + k * (self.col_w + ARRANGE_GAP_X)
        }
    }

    /// 这一列是否落在可用横向区间内（镜像时看左沿，普通时看右沿）。
    fn column_fits(&self, x: i64, w: i64) -> bool {
        if self.mirror {
            x >= self.min_x
        } else {
            x + w <= self.work_w - self.margin
        }
    }

    /// 给一个 `w×h` 的格子找下一个落点。`None` = 桌面已经排不下了。
    fn next(&mut self, w: i64, h: i64) -> Option<(i64, i64)> {
        self.next_from(0, w, h)
    }

    /// 同 [`FlowPlacer::next`]，但**从第 `from_col` 列开始**找（V41）。
    ///
    /// `from_col` 会被夹进制合法列区间 —— 工作区只放得下一列时，这里自然退回第 0 列，
    /// 于是所有格子在同一列里**从上往下顺次排开**，而不是把格子甩到屏幕外
    /// （那正是 V38「4 个没地方放（保持原位）」的老毛病）。
    fn next_from(&mut self, from_col: i64, w: i64, h: i64) -> Option<(i64, i64)> {
        let h = h.max(MIN_BOX_H);
        let from = from_col.clamp(0, self.max_columns - 1);
        for k in from..self.max_columns {
            let x = self.col_left(k);
            if !self.column_fits(x, w) {
                // 镜像时列号越大越靠左：越界说明后面只会更越界
                break;
            }
            if let Some(y) = self.find_row(x, w, h) {
                self.blocked.push(SlotRect { x, y, w, h });
                return Some((x, y));
            }
        }
        None
    }

    /// 在列内（x 固定）**首次适配**：返回第一个「不与任何已占矩形相交、且不越出下边界」的 y。
    ///
    /// 候选 y 只有两类：顶部 margin，以及每个「横向与我们重叠」的已占矩形的下沿 + 间隙 ——
    /// 最优解必在这两类点上，所以逐个升序试即可，不用按像素扫描。
    fn find_row(&self, x: i64, w: i64, h: i64) -> Option<i64> {
        let mut candidates: Vec<i64> = vec![self.margin];
        for r in &self.blocked {
            if r.x < x + w && x < r.x + r.w {
                candidates.push(r.y + r.h + ARRANGE_GAP_Y);
            }
        }
        candidates.sort_unstable();
        candidates.dedup();
        for y in candidates {
            if y < self.margin {
                continue;
            }
            if y + h > self.work_h - self.margin {
                // 候选是升序的：这个都越界了，后面的更越界
                return None;
            }
            let rect = SlotRect { x, y, w, h };
            if !self.blocked.iter().any(|other| rect.intersects(other)) {
                return Some(y);
            }
        }
        None
    }

    /// 最后手段：桌面真的排不下时，**至少不要留在旧坐标上**（那正是用户看到「乱七八糟」的根因）。
    ///
    /// 做法：放到最左一列，位置取「所有横向相交的已占矩形下沿之下」，忽略下边界 ——
    /// 它可能压在别的格子上，但仍在同一个格子区域里、顺序也还在。调用方会把它计入
    /// `overflowed` 并在界面上如实告诉用户「桌面空间不足」。
    fn place_loose(&mut self, w: i64, h: i64) -> (i64, i64) {
        self.place_loose_at(self.max_columns - 1, w, h)
    }

    /// 同 [`FlowPlacer::place_loose`]，但落在**指定列**（兜底：最后一列还放不下时用）。
    fn place_loose_at(&mut self, col: i64, w: i64, h: i64) -> (i64, i64) {
        let k = col.clamp(0, self.max_columns - 1);
        let right_limit = (self.work_w - self.margin - w).max(self.margin);
        let x = if self.mirror {
            self.col_left(k).max(self.min_x).min(right_limit)
        } else {
            self.col_left(k).min(right_limit)
        };
        let mut y = self.margin;
        for r in &self.blocked {
            if r.x < x + w && x < r.x + r.w {
                y = y.max(r.y + r.h + ARRANGE_GAP_Y);
            }
        }
        self.blocked.push(SlotRect { x, y, w, h });
        (x, y)
    }
}

/// 读出全部格子的几何（含挂件），按 `sort, id` 顺序。
///
/// 一并带出 `kind` 与**条目数**：V39 起「按内容量自动定尺寸」和「挂件归位到锚点」
/// 都要在排布阶段用到它们，没必要再为每个格子单独发一条 COUNT 查询。
fn load_box_rects(conn: &Connection) -> Result<Vec<GridBoxRect>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.name, b.kind, b.pos_x, b.pos_y, b.width, b.height, b.manual, \
                    (SELECT COUNT(*) FROM grid_items i WHERE i.box_id = b.id) \
             FROM grid_boxes b ORDER BY b.sort ASC, b.id ASC",
        )
        .map_err(|err| format!("读取格子几何失败：{err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(GridBoxRect {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                x: row.get(3)?,
                y: row.get(4)?,
                w: row.get::<_, i64>(5)?.max(MIN_BOX_W),
                h: row.get::<_, i64>(6)?.max(MIN_BOX_H),
                manual: row.get::<_, i64>(7)? != 0,
                items: row.get::<_, i64>(8)?.max(0) as usize,
            })
        })
        .map_err(|err| format!("读取格子几何失败：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取格子几何失败：{err}"))?;
    Ok(rows)
}

/// 排布用的格子几何（`kind` 决定它是**收纳格**还是**挂件**）。
#[derive(Clone)]
struct GridBoxRect {
    id: i64,
    /// 格子名（报错信息里用来指认是哪个格子摆不进去）
    name: String,
    kind: String,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
    /// **用户手工摆过**（V50）：`true` = 普通整理不许重排它的位置与尺寸。
    manual: bool,
    /// 已登记条目数（V39：按内容量自动定尺寸）
    items: usize,
}

impl GridBoxRect {
    fn rect(&self) -> SlotRect {
        SlotRect {
            x: self.x,
            y: self.y,
            w: self.w,
            h: self.h,
        }
    }

    /// 挂件（便签 / 日历 / 以后新增的）：位置由锚点表决定，不参与格子流布。
    fn is_widget(&self) -> bool {
        !is_content_kind(&self.kind)
    }

    // V42 删掉了 V41 的 `is_left_pinned()`：那时是「把『系统』『快捷方式』两个**格子**
    // 钉在左上角固定列」，用户随即否掉了这个思路 ——
    // 「不整理的和快捷方式别整理到格子了，他们就是自动在桌面左上角从上往下排开即可，
    // 不需要放到格子里面，没有必要」。
    // 现在左上角归 [`loose_strip_rect`] 那条**纯图标竖条**（快捷方式 + 系统入口 +
    // 落单文件），分类格一律从右侧起流布 —— 见 [`layout_all_boxes_with`]。
}

/// 这个 kind 是不是**收纳格**（参与自动排布、宽度统一、高度按内容）。
///
/// V40 把 `system` 从挂件改成收纳格：它是「此电脑 / 回收站 / 用户文件夹」的入口格，
/// 本质就是个内容格。以前按挂件走锚点，于是它自成一个宽度（320），
/// 和其它格子对不齐 —— 正是用户说的「宽度对齐」问题的一部分。
///
/// 约定（与挂件分区表 [`widget_zone`] 对称）：**表里没有的 kind 一律按收纳格处理**，
/// 这样以后新增收纳类格子不需要改这里；新增挂件则必须显式登记到锚点表。
fn is_content_kind(kind: &str) -> bool {
    matches!(kind, "folder" | "system")
}

/// 挂件锚点：**声明式**的默认归属角落。
///
/// 用户 V39 原话：「日历默认放在右上角等，当然以后我们可能还会增加更多小挂件都可以固定位置」。
/// 所以这里不做特判散落在各处，而是一张表 —— **新增挂件只要加一行**。
///
/// 约定：`folder` 之外的 kind 都算挂件，位置由本表决定，且**不参与格子流布**（它们本身
/// 在流布局里是禁区，格子会绕开）。
/// 挂件落在哪条**竖列**（V48：不再是「角落」，而是「列」）。
///
/// 用户原话：「便签自己占一列 · 工作台日志占一大列 · 剩下的占两列」——
/// 挂件不再是「贴着某个角往下摞」，而是各自拥有一条**从顶到底的列**：
///   · `Calendar`：日历 / 工作台日志（最右一列，列宽按它自己的宽度）；
///   · `Note`：便签（紧挨日历左侧，多个便签在同一列里自上而下摞）；
///   · `Other`：以后新增的挂件，继续往左开列。
///
/// 表驱动：新增挂件在 [`widget_zone`] 里加一行即可。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WidgetZone {
    Calendar,
    Note,
    Other,
}

/// 挂件 kind → 竖列。表里没有的一律进 `Other`（继续往左开新列，不会没地方去）。
fn widget_zone(kind: &str) -> WidgetZone {
    match kind {
        "calendar" => WidgetZone::Calendar,
        "note" => WidgetZone::Note,
        _ => WidgetZone::Other,
    }
}

/// 挂件的**自然宽度**：内容宽度固定的挂件不该被盒子撑出大片留白。
///
/// 用户 09-19 原话：「日历这里总宽度没有收回来」—— 真机库里日历盒子是 `460×638`，
/// 而日历本体（`grid-cols-7` 正方形日期格 + `max-w-[288px]`）只要 320 就够，
/// 多出来的 140px 全是空白，用户看到的就是「日历格子左右不均衡」。
///
/// `None` = 宽度由用户决定（便签可以被拉宽，正文会跟着换行）。
const CALENDAR_BOX_W: i64 = 320;

/// 桌面右侧**常驻「工作台」浮窗**的宽度（V60）。
///
/// 它**不在 `grid_boxes` 里** —— 不参与整理、不能被拖走、永远贴在工作区右侧一列，由前端
/// `DesktopWorkstation` 直接画。对用户它就是**一个整体模块**：日历 + 快捷入口 + 操作按钮
/// （用户 09-21：「日历可以修改为工作台，把快捷入口这些都可以整合到工作台里面，整合成一个
/// 整体的模块」「工作台这个可以常驻，不跟桌面整理一起退出」）。
///
/// **V62 起宽度 400**（不再是 [`CALENDAR_BOX_W`] 的 320）。
///
/// 用户 09-21（附真机截图）：「工作台太小了 日历等都不清晰…最重要的工作台反而太小」——
/// 320 是当年**日历格子**的自然宽度（一个 `max-w-[288px]` 的月历网格就走得下）；而工作台
/// 现在要装**日历 + 快捷入口 + 操作按钮**三段，320 逼得日历字号只能压到 9–12px，用户看到
/// 的就是「不清晰」。放宽到 400，日历网格随之自适应变宽，日期格才谈得上「看得清」。
///
/// **加宽的代价只在收纳区可用宽度**：`right_edge = wst.x − ARRANGE_GAP_X` 左移 80px，
/// `zone_w` 跟着少 80。V65 起收纳区的尺寸**完全由内容决定**（见 [`content_plan`]），
/// 宽度少 80 只是每行少放一个格子、多起一行，不会再出现「少一列就排不下」那种断崖。
/// （改得更宽之前仍应重算一遍真机档位。）
///
/// ⚠️ **前端 `WST_W` 必须与这里逐字一致**（同 [`CALENDAR_BOX_W`] 那套约定）：引擎按它
/// 把整列当禁区，前端按它画浮窗 —— 差一个像素就会变成「格子压在工作台上」或「白留一条缝」。
///
/// # 为什么引擎必须知道它
///
/// 前端画的那块矩形对引擎原本是「不存在的东西」，于是真机上两种情形会直接叠上去：
///   · **挂件带从最右侧起排**（`place_widget_columns` 的 `cursor_right`）—— 不收窄右界，
///     便签列会正好落在工作台那一列上；
///   · **一个挂件都没有时**，收纳区铺满整幅工作区，最右那一列同样落在它身上。
///
/// 所以它得作为**禁区**参与排布：横向相交的列，下沿被压到它上沿（见 [`column_bottom`]）；
/// 而**挂件带与收纳区的右界**另行收到它左沿（见 [`workstation_rect`] 的调用点）。
///
/// # V60：从「右下角一块」改成「右侧整列」
///
/// V56 只管右下角 `320×320` 一块（那是「快捷入口格子」的尺寸）。工作台上线后，日历与
/// 快捷入口合成了一个**占满右侧整列**的浮窗，禁区必须跟着变成整列 —— 否则上半截仍会被
/// 挂件带与收纳区铺上来。
const WST_BOX_W: i64 = 400;

/// 工作台占的那块矩形：**工作区右侧一列，从顶到底**（上下各留 [`ARRANGE_MARGIN`]）。
///
/// 高度直接用「工作区高 − 上下边距」，而不是让前端报内容高度：前端各段自己内部滚动
/// （与收纳格 / 竖条同一套口径），禁区因此是个**常量几何**，布局引擎不必等渲染回调
/// —— 这与「引擎不依赖跑测试那台机器的桌面」是同一条纪律。
fn workstation_rect(work_w: i64, work_h: i64) -> SlotRect {
    SlotRect {
        x: work_w - ARRANGE_MARGIN - WST_BOX_W,
        y: ARRANGE_MARGIN,
        w: WST_BOX_W,
        h: (work_h - 2 * ARRANGE_MARGIN).max(0),
    }
}

/// 这一条列（横向区间 `[x, x + w)`）是否压在某个禁区上；压上了就把**这一列的底部**
/// 收到禁区上沿之上（留一个 [`ARRANGE_GAP_Y`] 的缝），否则就是工作区下沿。
///
/// 只看横向交集 —— 与 [`needs_placement`] 判据⑤ 同一套口径：竖向上错开并不代表不重叠，
/// 用户看到的「挤在一起」就是横向区间叠了。
fn column_bottom(x: i64, w: i64, work_h: i64, reserved: &[SlotRect]) -> i64 {
    let mut bottom = work_h - ARRANGE_MARGIN;
    for r in reserved {
        if r.x < x + w && x < r.x + r.w {
            bottom = bottom.min(r.y - ARRANGE_GAP_Y);
        }
    }
    bottom
}

/// 收纳区的**右沿**（V68）。
///
/// `right_edge` 是已经让开工作台之后的硬右界；有挂件时还要在挂件带左沿前再留一道
/// [`ARRANGE_GAP_X`] 的缝（V50「收纳格不跨进挂件带」）。
///
/// ⚠️ **一个挂件都没有时，右沿就是 `right_edge` 本身** —— 不能先取兜底值 `right_edge`
/// 再减一道缝。用户 09-22 的原话：「没有便签的时候便签列可以作为格子列使用」——
/// 那一列要**整条**归收纳区。差 24px 看着不多，但它正好可能让 `column_capacity`
/// 少算出一列 ⇒ 格子一路往下摞 ⇒ 整层出滚动条（而旁边明明空着）。
fn content_zone_right(widget_rects: &[SlotRect], right_edge: i64) -> i64 {
    match widget_rects.iter().map(|r| r.x).min() {
        Some(left) => left - ARRANGE_GAP_X,
        None => right_edge,
    }
}

fn widget_natural_width(kind: &str) -> Option<i64> {
    match kind {
        "calendar" => Some(CALENDAR_BOX_W),
        _ => None,
    }
}


/// 竖列内的**首次适配叠放**：返回这条列里第一个放得下高度 `h` 的 y；放不下返回 `None`。
///
/// V48 修的是 V41–V47 `anchor_widget` 的兜底：那里列满之后会把 y **夹回**可用区间，
/// 于是同一列的多个便签全被夹到同一个 y 上 —— 真机数据三个便签一律 `(1415, 692)`，
/// 用户看到的就是「三个便签全都重叠在这一个位置」。
/// 现在的约定是「**放不下就再开一条列**」，任何情况下都不重叠。
///
/// `bottom` 是**绝对的下沿（不含）**，不是高度：常规情况是 `work_h - ARRANGE_MARGIN`，
/// 而右下角有快捷入口格子的那条列由 [`column_bottom`] 收窄到它上沿（V56）。
fn stack_in_column(taken: &[SlotRect], x: i64, w: i64, h: i64, bottom: i64) -> Option<i64> {
    let mut y = ARRANGE_MARGIN;
    loop {
        if y + h > bottom {
            return None;
        }
        let probe = SlotRect { x, y, w, h };
        match taken.iter().find(|r| r.intersects(&probe)) {
            None => return Some(y),
            Some(hit) => y = hit.y + hit.h + ARRANGE_GAP_Y,
        }
    }
}

/// 这一类挂件是否**只占一条列**（V50）。
///
/// 日历（含工作台日志）与便签各自只有一条列。便签是「多实例」挂件，若允许它往左多开列，
/// 「再加一个便签」就会改变挂件带宽度、进而重排全部收纳格 —— 用户看到的正是「便签跟格子
/// 挤在一起」。放不下时改为**列内压高度**（见 [`fit_column_heights`]，便签正文本来就能滚），
/// 桌面结构因此稳定：加便签不影响任何收纳格。
///
/// 只有 `Other`（以后新增的挂件）保留「往左多开列」的能力。
fn zone_single_column(zone: WidgetZone) -> bool {
    matches!(zone, WidgetZone::Calendar | WidgetZone::Note)
}

/// 挂件按**列**自右向左落位（V48 分区 / V49 加硬边界与列内压缩 / V50 改「每类只占一条列」），
/// 返回 `(格子 id, 目标矩形)`。
///
/// 顺序固定为「日历列 → 便签列 → 其他挂件列」（用户：「工作台日志占一大列，便签自己占一列」），
/// 每列宽度取本组挂件里最宽的那个（日历取 [`widget_natural_width`] 的自然宽度）——
/// 同列挂件左右边缘因此对齐。
///
/// **V50 的结构性改动**（用户 09-19：「便签一个独立的列，因为他的宽度不一样，不要跟格子挤在
/// 一起影响整理美观」）：
///
/// V48/V49 的「这一列放不下就再往左开一条」在便签这种多实例挂件上必然发生 —— 真机 6 个便签
/// 时便签带从 1071 一路铺到 787（吃掉 888px），收纳区只剩 1 列还装不下 6 个格子（日志
/// 「空间不足 2 个」，两个格子被顶到 y>912 的屏幕外）。现在**日历列与便签列各自恒定只有
/// 一条**（[`zone_single_column`]），放不下就在列内压高度。
///
/// **V49 补的三条硬保证**仍然有效：
///   ① **右界**：第一列贴住 [`right_edge`]（V60 起 = 工作台禁区左沿 − 一道缝，不再等于
///      工作区右沿 —— 工作台常驻占着右侧一列）；
///   ② **左界**：任何一列的 x 都 ≥ `min_x`（左侧「未归类」竖条的右沿）；
///   ③ **给收纳区留活路**：再开一列就会吃掉 `content_reserve` 宽的收纳区时**不再开列**，
///      把剩下的挂件塞进当前列并**按列压缩高度** —— 宁可便签内部滚动，也不许把收纳格
///      挤出屏幕，更不许挂件带把收纳区宽度算成 0 / 负数。
///
/// **V56 补第四条**：`reserved` 里的矩形是**禁区**，与某条列横向相交时，那条列的底部收到
/// 禁区上沿之上 —— 于是挂件再多，也只会把这一列压矮（内部滚动），不会盖到工作台上。
/// V60 起禁区是「工作台」的**右侧整列**（[`workstation_rect`]），与它横向相交的列可用高度
/// 会是 0 以下、于是根本排不进去 —— 这正是想要的：右界已由 `right_edge` 让开它。
fn place_widget_columns(
    widgets: &[&GridBoxRect],
    work_h: i64,
    min_x: i64,
    content_reserve: i64,
    reserved: &[SlotRect],
    right_edge: i64,
) -> Vec<(i64, SlotRect)> {
    let avail_h = (work_h - 2 * ARRANGE_MARGIN).max(MIN_BOX_H);
    let mut out: Vec<(i64, SlotRect)> = Vec::new();
    // V60：挂件带的右界**不是**工作区右沿，而是 [`right_edge`]（= 工作台禁区左沿 − 一道缝）。
    // 工作台常驻占着右侧一列，挂件带若还从 `work_w - ARRANGE_MARGIN` 起排，第一个便签列
    // 就会正好落在工作台底下 —— 而 `column_bottom` 会把它的可用高度压到 0 以下。
    let mut cursor_right = right_edge;
    for zone in [WidgetZone::Calendar, WidgetZone::Note, WidgetZone::Other] {
        let mut pending: Vec<&GridBoxRect> = widgets
            .iter()
            .copied()
            .filter(|w| widget_zone(&w.kind) == zone)
            .collect();
        if pending.is_empty() {
            continue;
        }
        // 既有上下顺序决定谁在上：先放的便签仍在上方
        pending.sort_by_key(|w| (w.y, w.id));
        // 这一组的列宽：日历用自然宽度（收回多余留白），其余取组内最宽
        let col_w = pending
            .iter()
            .map(|w| widget_natural_width(&w.kind).unwrap_or(w.w))
            .max()
            .unwrap_or(MIN_BOX_W)
            .clamp(MIN_BOX_W, AUTO_MAX_W);
        // 挂件带最多占到这儿：再往左就吃掉收纳区的保底宽度
        let hard_left = (min_x + content_reserve + ARRANGE_GAP_X)
            .min((right_edge - col_w).max(min_x));
        if zone_single_column(zone) {
            // —— 单列：整组自上而下摞，放不下就在列内压高度（绝不再往左开列）——
            let x = (cursor_right - col_w).max(hard_left);
            // 这一列的可用高度：右下角快捷入口格子压在横向区间上时，底部收到它上沿（V56）
            let avail = (column_bottom(x, col_w, work_h, reserved) - ARRANGE_MARGIN)
                .max(MIN_BOX_H);
            let naturals: Vec<i64> = pending
                .iter()
                .map(|w| w.h.clamp(MIN_BOX_H, avail))
                .collect();
            let heights = fit_column_heights(&naturals, avail);
            let bottom_limit = column_bottom(x, col_w, work_h, reserved);
            let mut y = ARRANGE_MARGIN;
            let mut placed: Vec<SlotRect> = Vec::new();
            for (w, h) in pending.iter().zip(heights) {
                // V56：**手工摆过的挂件保留自己的纵向位置**（列与宽度仍由规则决定）。
                //
                // 用户 09-20：「现在桌面上的是不能自己拖动调整的，只能通过整理自动整理」。
                // V50 写的是「挂件一律由列规则安置，**不看 `manual`**、也不看它现在在哪」，
                // 于是「拖动便签」永远会在下一次布局（挂载自愈 / 一键整理 / 增量补齐）被弹回
                // 列里的固定位置 —— 一列多张便签的用户完全无法调整顺序和留白。
                //
                // 现在给**纵向自由**：落点合法（在界内 + 不与同列已确定的挂件相交）就照它摆，
                // 否则退回规则位。`pending` 已按 `(y, id)` 排序，所以自上而下逐个判定即可。
                // ⚠️ 横向仍归列规则 —— 这是用户自己 V50 要的「便签一个独立的列」，
                // 打破它就会回到「便签悬在收纳格正上方」那版截图。想要恢复默认纵向顺序，
                // 点「重新重置整理」（`Full` 会先把 `manual` 清零，于是这条分支自然不生效）。
                let mut target_y = y;
                if w.manual && w.y >= ARRANGE_MARGIN && w.y + h <= bottom_limit {
                    let probe = SlotRect { x, y: w.y, w: col_w, h };
                    if !placed.iter().any(|r| r.intersects(&probe)) {
                        target_y = w.y;
                    }
                }
                let rect = SlotRect { x, y: target_y, w: col_w, h };
                placed.push(rect);
                out.push((w.id, rect));
                y = target_y + h + ARRANGE_GAP_Y;
            }
            cursor_right = x - ARRANGE_GAP_X;
            continue;
        }
        while !pending.is_empty() {
            let wanted_left = cursor_right - col_w;
            let x = wanted_left.max(hard_left);
            // 已经顶到硬左界：这一列必须装完（不能再往左开列了）
            let last_column = wanted_left < hard_left;
            // 同单列：这一列的下沿要让开右下角的快捷入口格子
            let bottom = column_bottom(x, col_w, work_h, reserved);
            let before = pending.len();
            let mut here: Vec<SlotRect> = Vec::new();
            let mut rest: Vec<&GridBoxRect> = Vec::new();
            for w in pending.into_iter() {
                let h = w.h.clamp(MIN_BOX_H, avail_h);
                match stack_in_column(&here, x, col_w, h, bottom) {
                    Some(y) => {
                        let rect = SlotRect { x, y, w: col_w, h };
                        here.push(rect);
                        out.push((w.id, rect));
                    }
                    None => rest.push(w),
                }
            }
            if rest.is_empty() {
                // 整列都摆下了 —— 游标左移一条列宽（**必须移**：下一组挂件/下一条列
                // 要靠它接着往左排；V49 第一版在这里直接 break，游标没动，于是便签列
                // 落回日历那一列、直接压在一起）
                cursor_right = x - ARRANGE_GAP_X;
                break;
            }
            if last_column {
                // 兜底：整列一个都放不下 / 还剩一些装不进 —— 全塞进这一列并压高度
                out.extend(pack_overflow(&rest, x, col_w, &here, bottom));
                break;
            }
            if rest.len() == before {
                // 工作区极矮：连一个都放不下，保留原样别再原地打转
                break;
            }
            cursor_right = x - ARRANGE_GAP_X;
            pending = rest;
        }
    }
    out
}

/// 把 `rest` 里放不下的挂件塞进**同一列的剩余空间**（高度按比例压缩，下限 [`MIN_BOX_H`]）。
///
/// 这是 [`place_widget_columns`] 的兜底分支：只有当「再开一列就会吃掉收纳区」时才走到。
/// 用户 09-19 第 4 条：「务必保证所有的内容不能重叠，可以有滚动条，但是不能图标重叠」——
/// 所以宁可让这一列的挂件矮一点（便签内部本来就能滚），也不能算到屏幕外去。
///
/// `bottom` 与 [`stack_in_column`] 同义：绝对下沿（右下角有快捷入口格子时会更浅）。
fn pack_overflow(
    rest: &[&GridBoxRect],
    x: i64,
    col_w: i64,
    taken: &[SlotRect],
    bottom: i64,
) -> Vec<(i64, SlotRect)> {
    let bottom_limit = bottom.max(MIN_BOX_H);
    let mut start = ARRANGE_MARGIN;
    for r in taken {
        start = start.max(r.y + r.h + ARRANGE_GAP_Y);
    }
    let n = rest.len() as i64;
    if n == 0 {
        return Vec::new();
    }
    // 剩余空间（不够就按「每件至少 MIN_BOX_H」算，代价是最后几件略微越界，如实上报）
    let space = (bottom_limit - start - (n - 1) * ARRANGE_GAP_Y).max(MIN_BOX_H * n);
    let total: i64 = rest.iter().map(|w| w.h.max(MIN_BOX_H)).sum();
    let scale = if total > space {
        space as f64 / total as f64
    } else {
        1.0
    };
    let mut out: Vec<(i64, SlotRect)> = Vec::new();
    let mut y = start;
    for w in rest {
        let room = (bottom_limit - y).max(MIN_BOX_H);
        let h = (((w.h.max(MIN_BOX_H) as f64) * scale).round() as i64).clamp(MIN_BOX_H, room);
        let rect = SlotRect { x, y, w: col_w, h };
        out.push((w.id, rect));
        y += h + ARRANGE_GAP_Y;
    }
    out
}

/// 把一列的高度**压缩**到可用高度以内（V49）。
///
/// 用户 09-19 第 4 条：「务必保证所有的内容不能重叠，可以有滚动条，但是不能图标重叠」——
/// 高度放不下时**让格子内部滚动**，而不是把后面的格子顶出屏幕（V48 会把它们摆到
/// `y > work_h` 的位置，用户看到的是「格子不见了」）。下限 [`MIN_BOX_H`]；
/// 实在压不下去才允许越界，由调用方计入 `overflowed` 如实上报。
fn fit_column_heights(natural: &[i64], available: i64) -> Vec<i64> {
    let n = natural.len() as i64;
    if n == 0 {
        return Vec::new();
    }
    let gaps = (n - 1) * ARRANGE_GAP_Y;
    let total: i64 = natural.iter().copied().map(|h| h.max(MIN_BOX_H)).sum();
    if total + gaps <= available {
        return natural.iter().copied().map(|h| h.max(MIN_BOX_H)).collect();
    }
    let space = ((available - gaps).max(MIN_BOX_H * n)).max(MIN_BOX_H);
    // ⚠️ V68 修：V66 是「按 `space / total` 缩一次，再把每个值夹到 `MIN_BOX_H` 以上」——
    // 而**夹回下限的那些格子会把总和又顶出去**。真机上就差这 14px：
    // 便签下沿那条带里 3 格自然高 [457, 122, 342]、可用 848（扣缝 800），按比例缩完
    // 122 会被夹回 120（本该 106），于是整列 862 > 848 ⇒ **照样越界、照样出滚动条**。
    //
    // 现在改成**二分找「最大的、夹完仍装得下的缩放比」**：单调（缩放越大总和越大），
    // 于是结果一定满足 `Σ ≤ space` ⇒ 列高 ≤ 可用高。缩不动时才真的越界（那时是内容太多）。
    let fits = |scale: f64| -> i64 {
        natural
            .iter()
            .map(|h| (((*h as f64) * scale).floor() as i64).max(MIN_BOX_H))
            .sum()
    };
    let mut lo = 0.0f64;
    let mut hi = 1.0f64;
    for _ in 0..48 {
        let mid = (lo + hi) / 2.0;
        if fits(mid) <= space {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    natural
        .iter()
        .copied()
        // 用 floor 而不是 round：四舍五入会让「刚好填满」多出 1px，整列又超回去
        .map(|h| (((h as f64) * lo).floor() as i64).clamp(MIN_BOX_H, space))
        .collect()
}


/// 这个格子是不是**还没落位**、需要本次排布重新安置（V48 立，V49 补判据，V50 换硬边界）。
///
/// 命中任意一条即「需要安置」：
///   ① **还在默认位** —— `grid_box_upsert` 新建时不写坐标，先落 (0,0) 哨兵；
///   ② **侵入了左侧「未归类」竖条**（`x < min_x`）—— 真机事故：新建便签落在
///      `(32, 40)`，只差一点就绕过了下面那几条判据，用户看到的是「便签糊在快捷方式上」，
///      而且它把挂件带左界拉到 32，收纳区宽度当场算成负数；
///   ③ **越出工作区**（改过分辨率 / 被拖到屏幕外 / 算错落到负坐标）；
///   ④ **与别的格子重叠** —— 真机事故「三个便签都是 (1415, 692)」就是靠这一条救回来的；
///   ⑤ **跨进了挂件带**（`x + w > band_left - ARRANGE_GAP_X`）—— **V50 新增，这是用户
///      09-19「便签不要跟格子挤在一起」的直接落点**：真机库里「安装包 / 图片」停在
///      `x=1031`，而便签列摆在 `x=1071` —— 两者横向区间重叠，便签就悬在那两个格子正上方，
///      看起来正是「便签跟格子挤在同一列里」。V49 的判据只查「与挂件矩形**重叠**」，
///      而它们在纵向上是错开的（便签 30..250 / 安装包 366..486），所以整条漏了过去。
///
/// ⚠️ **V68 给 ⑤ 开了一个例外**：格子整个落在挂件带**下沿之下**（`y ≥ band_bottom`）时，
/// 它进挂件带那一列是**合法**的 —— 那正是「带下空间」（用户 09-22：「便签下面还有大量的空间，
/// 我们也可以把格子跑过去的」）。例外只放行「纵向完全错开」这一种，横向重叠但纵向咬合的
/// 仍然判「没落位」，所以 ⑤ 的原意（便签不要悬在格子正上方）一点没松。
///
/// 反过来说：**不满足这些 = 这一格没毛病**。
///
/// ⚠️ V63 起生产路径不再调它 —— 收纳区一律重排（V65：尺寸按内容、位置按流式行，见
/// [`content_plan`]），没有「原地不动」这一档了。但它是**布局质量的
/// 判据**，单测仍用它断言「排完之后一个需要重排的格子都没有」
/// （`overlapping_or_out_of_area_boxes_need_placement_but_tidy_ones_do_not`、
/// `a_content_box_crossing_into_the_widget_band_needs_placement` 等），所以留着。
#[allow(dead_code)]
fn needs_placement(
    r: &GridBoxRect,
    all: &[GridBoxRect],
    band_left: i64,
    band_bottom: i64,
    min_x: i64,
    work_w: i64,
    work_h: i64,
) -> bool {
    if r.x <= ARRANGE_MARGIN && r.y <= ARRANGE_MARGIN {
        return true;
    }
    if r.x < min_x {
        return true;
    }
    // ⑤ V50：收纳格一律不许跨过挂件带左沿（用户：「便签不要跟格子挤在一起」）。
    // V68 例外：整个落在挂件带**下沿之下**的格子是「带下空间」的正常落位。
    // `band_bottom` 传 `i64::MAX` 就等于不开口子（没有带下空间时）。
    if r.x + r.w > band_left - ARRANGE_GAP_X && r.y < band_bottom {
        return true;
    }
    if r.x + r.w > work_w || r.y + r.h > work_h || r.y < ARRANGE_MARGIN {
        return true;
    }
    let own = r.rect();
    all.iter().any(|o| o.id != r.id && own.intersects(&o.rect()))
}

/// —— 收纳区：**按内容定尺寸 + 大格子先占位、小格子填空隙**（V69）——
///
/// 四代算法各被否掉一次，一句话一代：
///   · V63「统一网格」：格子一样大 —— 用户否（「我图片只有一个，你搞那么大的空间做什么」）；
///   · V64「行带分摊」：尺寸与内容**反相关**（面积与条目数对不上）；
///   · V65「流式行」：**尺寸终于对了**（面积 ∝ 条目数），但「一行一行铺」留下两个新毛病 ——
///     ① 同一行里矮格子下方空一截、行尾再空一截，整块看着**中间是空的**；
///     ② 总高很容易越过一屏 ⇒ 收纳区整层出现滚动条（用户 09-22：「整个桌面整体怎么还变成
///        有滚动条的了…… 你这个中间空着，下面给我搞个滚动条」）；
///   · V66–V68「列式填满 + 保序切段」：位置对了、带下空间也回收了，但**谁先占好位置**仍然由
///     **登记顺序**决定（`balanced_partition` 只把序列保序切成 `k` 段）—— 于是用户 09-23 看到
///     的还是：「**你应该先把大格子算了布局好，然后把小格子找空隙插入，按照格子内容多少大小
///     一次计算合理的位置放置**」。真机现场就是最刺眼的证据：两个**空的**「新格子」坐在第一列
///     顶端，而 11 个条目的「文档」被顶到它们下面。
///
/// V69 **只换「谁排前面 / 谁进哪一列」这一半**，尺寸那一半（[`box_own_size`]）与列式落位原样保留：
///
///   ① 尺寸：`w = desired_box_width(条目数)`、`h = box_height_at(条目数, w)` —— 只看自己的
///      内容，跟旁边是谁、自己排第几**一个像素都不相干**（V65 的成果，不能回滚）；
///   ② 摆放序：[`placement_order`] 按 `(面积, 内容量, 高, 宽)` **降序**（大的先占位；
///      面积会被 `box_own_size` 的分档吃掉差别 —— **内容量**这个分量是必须的，见
///      [`size_rank`]）；
///   ③ 分列：[`pack_columns`] 依次把每个格子放进「**当前最矮的那一列**」（并列取最左）——
///      这就是字面意义的「小格子找空隙插入」（空隙 = 那一列还没用掉的高度）；
///   ④ 列数：从宽度容量往下试，取**第一个「宽高都装得下」的 k**（最大可行 k ⇒ 尽量占满宽度，
///      同时列最少 ⇒ 最高的那一列最矮）；全都不装得下高度时，取「宽度装得下且最矮」的那个，
///      再把列高压到 [`MIN_BOX_H`]（格子内部滚）；
///   ⑤ 落位：列从左到右依次排开（列宽 = 该列里最宽那一格的自然宽度），列内自上而下
///      **紧挨着**摞（只有一道 [`ARRANGE_GAP_Y`] 的缝，没有行式留白）；
///   ⑥ 兜底：**绝不把溢出甩给整层画布** —— 那正是 V66 要修的症状。
///
/// 于是用户那几句话同时成立：**面积与内容成正比**（①）、**大格子先占好位置**（②③）、
/// **不再一片空洞**（④⑤）、**不再整层滚动**（⑥）。
///
/// ⚠️ **顺序依赖被彻底删掉了**：摆放序只由「内容 + 登记顺序（同尺寸时）」决定，与
/// [`LayoutMode`]、与格子现在停在哪**都无关**。这正是幂等的来源 —— 排完再排，尺寸没变 ⇒
/// 顺序没变 ⇒ 落位一字不差（不必再靠 V66 那套「读序必须等于落位序」的几何约束去兜）。
///
/// 明确的取舍：各列高度不会恰好一样，所以**列的底部**仍可能留白。这是「不拉伸、不造空盒子」
/// 的代价 —— 用户要的是「图标少的格子别占那么大空间」，所以宁可底部留白，也不把格子撑大。
///
/// ⚠️ 被取代的旧模型（别按它们推理）：
///   · V50–V62「两条等宽列 + LPT 分列」→ 列宽与内容脱钩（**V69 的短列优先不是它**：列宽仍是
///     「该列里最宽那一格」，只把「谁进哪一列」改回按大小派）；
///   · V63「统一网格」→ 同宽同高，1 个条目和 20 个条目一样大；
///   · V64「行带 + 份额分摊 + 同行同高」→ 尺寸与内容错配；
///   · V65「流式行」→ 尺寸对了，但行内 / 行尾留白 + 越过一屏出滚动条；
///   · V66–V68「保序切段（`balanced_partition`）」→ 位置对，但「先来后到」压过了「大小」。
///
/// 一句话记住现在这条：**尺寸看自己，大格子先占位，小格子补最短的那一列**。

/// 单个收纳格的高度上限（V70 起）＝ **本带可用高** —— 那个固定的 `CONTENT_MAX_H = 460`
/// 已经删掉了，理由见 [`box_height_at`]。

/// 一个收纳格**自己的尺寸**（V65）：宽度按条目数、高度按该宽度下要排几行。
///
/// 这是 V65 **唯一的尺寸来源** —— 与同行有谁、总共有几个格子、谁先谁后全部无关。
///
/// ⚠️ V70：高度上限从「固定 460」变成**本带可用高**（`zone_h`）—— 见 [`box_height_at`]
/// 上面那段。宽度上限仍是 [`AUTO_MAX_W`]（宽度一旦不设上限，一个格子就会横向吃掉整条带）。
fn box_own_size(items: usize, zone_w: i64, zone_h: i64, icon: i64) -> (i64, i64) {
    let max_w = zone_w.max(MIN_BOX_W);
    let w = desired_box_width(items, icon)
        .min(AUTO_MAX_W)
        .min(max_w)
        .max(MIN_BOX_W);
    (w, box_height_at(items, w, icon, zone_h))
}

/// 收纳区整张落位表（V66）：**一段一列，列内自上而下紧挨着摞**。
#[derive(Debug, Clone)]
struct ContentPlan {
    slots: Vec<SlotRect>,
    /// 这次排布有没有**动用兜底压缩**（列高被压 / 宽度被夹）。
    squeezed: bool,
    /// 排完之后最高的一条列**是不是越过了可用带的下沿**（= 前端那层滚动容器会出滚动条）。
    ///
    /// V68 新增，专门给调用方（[`layout_all_boxes_with`]）做「位置序 vs 登记序」的取舍用：
    /// **压缩不算事**（压的是格子内部滚动，用户看到的是「内容多的格子自己滚」），
    /// **越界才算事** —— 那才意味着「按这个顺序排就装不下了，换个顺序可能刚刚好」。
    /// V66 用的是 `squeezed`，于是「有带下空间时便签下方那一列被压」也会触发回退，
    /// 把用户拖出来的先后顺序白白丢掉。
    overflowed: bool,
}

impl ContentPlan {
    /// 这批格子里**最低的那个下沿**（没有格子时返回 0）。
    ///
    /// V68 的带下空间取舍就是拿它做代价函数（越小越紧凑），所以它比 [`Self::total_height`]
    /// 更基础 —— 后者是「相对工作区上边距」的写法，只在单带场景下够用。
    fn bottom(&self) -> i64 {
        self.slots.iter().map(|s| s.y + s.h).max().unwrap_or(0)
    }

    /// 这批格子占掉的总高度（自 [`ARRANGE_MARGIN`] 起算）—— 日志与测试用它判「要不要滚」。
    fn total_height(&self) -> i64 {
        let bottom: i64 = self.slots.iter().map(|s| s.y + s.h).max().unwrap_or(0);
        (bottom - ARRANGE_MARGIN).max(0)
    }

    /// 并排了几列（去重后的 `x` 个数）—— 日志与测试用它看「填满」的程度。
    fn column_count(&self) -> usize {
        let mut xs: Vec<i64> = self.slots.iter().map(|s| s.x).collect();
        xs.sort_unstable();
        xs.dedup();
        xs.len()
    }
}

/// 收纳区在给定可用宽度下**最多能并排几列**（每列至少放得下一个 [`MIN_BOX_W`]）。
fn column_capacity(zone_w: i64) -> usize {
    (((zone_w + ARRANGE_GAP_X) / (MIN_BOX_W + ARRANGE_GAP_X)).max(1)) as usize
}

/// 一个收纳格在这张落位表里的**摆放序**（V69）：大的先占位。
///
/// 排序键 = `(面积, 内容量, 高, 宽)` 降序，四个分量一起比：
///   · **面积**是「看起来多大」（用户说的「大小」）；
///   · **内容量**接在面积后面是必须的 —— 面积会被**分档**吃掉差别：18 项与 16 项的自然宽度
///     都是 366（`sqrt` 取整后落进同一档）、高度也同档 ⇒ 面积相同，只按面积比就退化成
///     「谁先登记谁在上面」，用户看到的还是「小格子压在大格子上面」（单测真跑出来的）。
///     即：**面积相同 ⇒ 内容多的优先**。
///   · 高 / 宽兜到最后，是为了让键**没有并列歧义** —— 真正同宽同高的两个格子几何上可互换，
///     谁先谁后都不改变落位结果，那时才轮到「稳定排序」按登记顺序兜底。
///
/// ⚠️ 判据里**不许**掺「格子现在停在哪」：那是上一次排布的结果，拿它当输入就成了自我引用的
/// 反馈环（V66.1 的哨兵、V64 的「吸附到离它最近的坑」都是这么翻车的）。
fn size_rank(items: usize, s: (i64, i64)) -> (i64, usize, i64, i64) {
    (s.0 * s.1, items, s.1, s.0)
}

/// 把一批格子排成**摆放序**（V69）：按 [`size_rank`] 降序；完全并列时保持传入顺序
/// （调用方给的是登记顺序 `sort, id`，而 `sort_by` 是稳定排序，正好替我们保住它）。
fn placement_order(items: &[usize], sizes: &[(i64, i64)]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..sizes.len()).collect();
    idx.sort_by(|&a, &b| size_rank(items[b], sizes[b]).cmp(&size_rank(items[a], sizes[a])));
    idx
}

/// 分列（V69）：按摆放序，每个格子放进「**当前最矮的那一列**」（并列取最左）。
///
/// 这就是用户那句「先把大格子算了布局好，然后把小格子找空隙插入」：空隙 = 那一列还没用掉的
/// 高度，最矮的那一列就是当前最大的那个空隙。这也是经典的 LPT 调度 ——「最高的那一列」不超过
/// 最优解的 4 / 3。
///
/// 为什么不再是 V66 的「保序切段」：`balanced_partition` 只在**连续区间**上切，于是「谁排前面」
/// 由登记顺序说了算 —— 空的「新格子」先登记就先占住第一列顶端，大格子反被挤到它们下面
/// （用户 09-23 的截图）。顺序一旦改由大小决定，这个问题从根上消失。
///
/// 返回的下标是「摆放序里的位置」（`heights` / `widths` 的下标），不是格子 id。
fn pack_columns(heights: &[i64], k: usize) -> Vec<Vec<usize>> {
    let mut cols: Vec<Vec<usize>> = vec![Vec::new(); k.max(1)];
    let mut load = vec![0_i64; cols.len()];
    for (i, h) in heights.iter().copied().enumerate() {
        // 最矮的那一列；并列取最左（用 `<` 而不是 `<=`）—— 与列序无关地稳定
        let mut best = 0usize;
        for c in 1..cols.len() {
            if load[c] < load[best] {
                best = c;
            }
        }
        if !cols[best].is_empty() {
            load[best] += ARRANGE_GAP_Y;
        }
        load[best] += h;
        cols[best].push(i);
    }
    cols
}

/// 一条列摞起来有多高（含列内行距）。
fn col_stack_h(col: &[usize], heights: &[i64]) -> i64 {
    col.iter().map(|&i| heights[i]).sum::<i64>() + (col.len() as i64 - 1).max(0) * ARRANGE_GAP_Y
}

/// 这几列并排要占掉的总宽（列宽 = 该列里最宽那一格；**空列不占宽** —— V66.1 的约定）。
fn packed_total_width(cols: &[Vec<usize>], widths: &[i64]) -> i64 {
    let w: Vec<i64> = cols
        .iter()
        .filter(|c| !c.is_empty())
        .map(|c| c.iter().map(|&i| widths[i]).max().unwrap_or(MIN_BOX_W))
        .collect();
    w.iter().sum::<i64>() + (w.len() as i64 - 1).max(0) * ARRANGE_GAP_X
}

/// 这批格子**各自的自然尺寸**（只看自己的内容 —— V65 的成果，不许回滚）。
///
/// ⚠️ V70：高度上限 = **这条带的可用高**（`band_h`）—— 于是「空间多 ⇒ 长到全见」，
/// 「空间紧 ⇒ 由压缩兜住」。
fn own_sizes(items: &[usize], band_w: i64, band_h: i64, icon: i64) -> Vec<(i64, i64)> {
    let zone_w = band_w.max(MIN_BOX_W);
    items
        .iter()
        .map(|n| box_own_size(*n, zone_w, band_h.max(MIN_BOX_H), icon))
        .collect()
}

/// 把「按摆放序排出来的 slots」摊回**调用方给的下标序**。
///
/// V69 起排布内部会重排，所以这层是必须的：调用方是拿 `boxes.iter().zip(slots)` 回写的，
/// 一旦顺序错了，格子名与坑位就会错配。
fn scatter_back(order: &[usize], inner: ContentPlan, total: usize) -> ContentPlan {
    let mut slots = vec![SlotRect { x: 0, y: 0, w: 0, h: 0 }; total];
    for (p, &orig) in order.iter().enumerate() {
        slots[orig] = inner.slots[p];
    }
    ContentPlan {
        slots,
        squeezed: inner.squeezed,
        overflowed: inner.overflowed,
    }
}

/// 把一组收纳格的条目数变成落位表：**按内容定尺寸 + 大格子先占位、小格子填空隙**（V69）。
///
/// `items` 是这批格子的条目数（调用方给的顺序 = 登记顺序）；返回的 `slots` **按同一下标对齐**，
/// 调用方拿到就能直接 zip 回格子。
///
/// ⚠️ 这是**单带**入口，只有测试直接用它（线上永远走 [`content_plan_with_lower_band`]，
/// 因为「便签下方那条带」不是可选项）。留 `#[cfg(test)]` 是为了让「不许死代码」这条自检
/// 在有问题的东西上真的响 —— 而不是把它标成 `allow(dead_code)` 糊过去。
#[cfg(test)]
fn content_plan(items: &[usize], zone_w: i64, zone_h: i64, icon: i64, min_x: i64) -> ContentPlan {
    content_plan_batch(
        items,
        SlotRect {
            x: min_x,
            y: ARRANGE_MARGIN,
            w: zone_w,
            h: zone_h,
        },
        icon,
    )
}

/// [`content_plan`] 与 [`content_plan_with_lower_band`] 共用的前半段：
/// 算尺寸 → 定摆放序 → 排进 `band` → **摊回调用方给的输入序**。
#[cfg(test)]
fn content_plan_batch(items: &[usize], band: SlotRect, icon: i64) -> ContentPlan {
    let sizes = own_sizes(items, band.w, band.h, icon);
    let order = placement_order(items, &sizes);
    let inner = content_plan_in(&order, items, band, icon);
    scatter_back(&order, inner, items.len())
}

/// 一套候选解：`(分列, 各格高, 各格宽, 这套尺寸有没有被夹窄过)`。
type ColumnPick = (Vec<Vec<usize>>, Vec<i64>, Vec<i64>, bool);

/// 挑列数与尺寸（V84 定稿）：在 `k = 1..=capacity`、每个 k「先自然宽度、再夹到
/// `zone_w / k`」的所有候选里，取 **`min(横向填充率, 纵向填充率)` 最大**的那个解。
///
/// 返回 `(命中解, 兜底解)`：
///   · 命中解 = 宽高都装得下、两轴填充率较小者最大的解；
///   · 兜底解 = 宽度装得下、但高度越界里**最矮**的那个（随后交给 [`fit_column_heights`] 压列高）。
///
/// # 这条判据是两代用户反馈合成的
///
/// · **09-23（V71）**：「文档」独占一列、下方空掉 501px，两个小格挤在另一列 ——
///   用户骂「怎么还是补补丁一样的」 ⇒ **不能只顾少列**：一列空半截、另一列摞满的解，
///   纵向填充率被拉低，`min` 直接淘汰。
/// · **09-29（V84）**：「搞成那么多列，却空了大量的空白，格子宽度反而压缩到文件名
///   都看不清了」「这部分完全可以合并到一列里面」 ⇒ **也不能铺满列数**：真机 6 个格子
///   920×968 排成 5 列、占高只有 717，每列 ~176px。列一多，竖向大片空白，
///   `min` 同样把它拉低。
///
/// 也就是说 `min(横, 纵)` 同时否掉两个方向的畸形：**横向铺满、纵向空一半（列太多）**，
/// 和**纵向摞满、横向空一半（列太少 / 补丁洞）**。平局时先到先得 —— `k` 从小到大、
/// 同一个 k 里自然尺寸在前 —— 于是「能少一列就少一列、能不夹宽就不夹宽」。
///
/// `capped_at(k)` 给出「这一套尺寸夹到 `zone_w / k` 之后」的 `(各格高, 各格宽)`；
/// 与自然尺寸完全相同时会跳过，不做重复劳动。
fn pick_columns(
    natural_h: &[i64],
    natural_w: &[i64],
    capacity: usize,
    zone_w: i64,
    zone_h: i64,
    capped_at: impl Fn(usize) -> (Vec<i64>, Vec<i64>),
) -> (Option<ColumnPick>, Option<(i64, ColumnPick)>) {
    let mut best: Option<(i64, ColumnPick)> = None;
    let mut fallback: Option<(i64, ColumnPick)> = None;
    for k in 1..=capacity {
        let mut trials: Vec<(Vec<i64>, Vec<i64>, bool)> =
            vec![(natural_h.to_vec(), natural_w.to_vec(), false)];
        let (ch, cw) = capped_at(k);
        if cw != natural_w {
            trials.push((ch, cw, true));
        }
        for (hs, ws, capped) in trials {
            let cols = pack_columns(&hs, k);
            let used_w = packed_total_width(&cols, &ws);
            // 宽度装不下直接淘汰 —— 这是「不许压到挂件带 / 工作台上」的硬约束
            if used_w > zone_w {
                continue;
            }
            let tallest = cols.iter().map(|c| col_stack_h(c, &hs)).max().unwrap_or(0);
            if tallest > zone_h {
                // 高度越界 ⇒ 只进兜底（全都不装时取「最矮」的，交给 fit_column_heights 压）
                if fallback.as_ref().map_or(true, |(t, _)| tallest < *t) {
                    fallback = Some((tallest, (cols, hs, ws, capped)));
                }
                continue;
            }
            // 两轴填充率的较小者（交叉乘积通分比较，避免浮点）：
            //   横向 = used_w/zone_w，纵向 = tallest/zone_h。
            // 严格更优才替换 ⇒ 平局保持先到者：k 更小、自然尺寸优先。
            let score = (used_w * zone_h).min(tallest * zone_w);
            if best.as_ref().map_or(true, |(s, _)| score > *s) {
                best = Some((score, (cols, hs, ws, capped)));
            }
        }
    }
    (best.map(|(_, pick)| pick), fallback)
}

/// 把 `order` 里这些格子（条目数查 `items`）排进 `band`。
///
/// 返回的 `slots` **与 `order` 按位对齐**（`slots[p]` 属于 `order[p]`）—— 两条带拼接
/// （[`content_plan_with_lower_band`]）与 [`scatter_back`] 都靠这个约定。
///
/// 三个阶段：**选尺寸与列数** → **分列**（[`pack_columns`]）→ **落位**。
///
/// 选尺寸这一层有两趟（V69）：
///   ① **自然尺寸**（[`box_own_size`]，只看自己的内容）：能排下就直接用它 —— 这是常态；
///   ② 排不下时**按 k 均分可用宽度**（每格夹到 `zone_w / k`）再试一遍。宽度是瓶颈时这一步是
///      决定性的：真机收纳区 921 宽，而「18 个条目」的自然宽度就是 366 —— 5 列自然宽度要
///      1926px。夹到 165 之后 5 列正好 921（也正好把 4 行 × 194 收进 848 里）。
///      ⚠️ 夹宽度必须**同时按新宽度重算高度**（`box_height_at`）—— 前端就是按这个宽度渲染的，
///      宽度变了行数就变；几何不自洽的话「后端算得下、前端还是滚」。
fn content_plan_in(order: &[usize], items: &[usize], band: SlotRect, icon: i64) -> ContentPlan {
    if order.is_empty() {
        return ContentPlan {
            slots: Vec::new(),
            squeezed: false,
            overflowed: false,
        };
    }
    let zone_w = band.w.max(MIN_BOX_W);
    let zone_h = band.h.max(MIN_BOX_H);
    let base = own_sizes(items, band.w, band.h, icon);
    let capacity = column_capacity(zone_w).clamp(1, order.len());

    // 自然尺寸（按摆放序取）
    let natural_h: Vec<i64> = order.iter().map(|&i| base[i].1).collect();
    let natural_w: Vec<i64> = order.iter().map(|&i| base[i].0).collect();

    // 「夹到 `zone_w / k`」的那套尺寸（按摆放序取）：只夹**比 cap 宽**的格子。
    //
    // ⚠️ 夹宽度必须**同时按新宽度重算高度**（`box_height_at`）—— 前端就是按这个宽度渲染的，
    // 宽度变了行数就变；几何不自洽的话「后端算得下、前端还是滚」。
    let capped_at = |k: usize| -> (Vec<i64>, Vec<i64>) {
        let cap = ((zone_w - (k as i64 - 1) * ARRANGE_GAP_X) / k as i64)
            .clamp(MIN_BOX_W, AUTO_MAX_W);
        let mut hs = Vec::with_capacity(order.len());
        let mut ws = Vec::with_capacity(order.len());
        for &i in order {
            let (bw, bh) = base[i];
            if bw > cap {
                ws.push(cap);
                // V70：上限是**这条带的可用高**（不再是与空间无关的固定 460）
                hs.push(box_height_at(items[i], cap, icon, zone_h));
            } else {
                ws.push(bw);
                hs.push(bh);
            }
        }
        (hs, ws)
    };

    // ①② 挑列数与尺寸：每个 `k` 先试自然宽度、再试夹宽，在全部装得下的候选里取
    // **两轴填充率较小者最大**的解（V84 —— 见 [`pick_columns`] 的注释）。
    let (pick, over) = pick_columns(&natural_h, &natural_w, capacity, zone_w, zone_h, capped_at);

    // ③ 落定：命中解优先；否则用「最矮」的兜底（随后压列高，格子内部滚而不是整层滚）
    let (cols, heights, widths, mut squeezed) = match pick {
        Some((cols, hs, ws, capped)) => (cols, hs, ws, capped),
        None => match over {
            Some((_, (cols, hs, ws, _))) => (cols, hs, ws, true),
            None => unreachable!(
                "k = 1 一定装得下宽度：尺寸在 own_sizes / capped_at 里已被夹到 zone_w 之内"
            ),
        },
    };

    // ④ 落位（V85 重写）：
    //   · **列从右往左排**（右锚定）—— 第一列贴着便签 / 工作台一侧，排完后剩下的空间留在
    //     左边给「未归类」竖条 / 快捷方式。用户 09-29 晚原话：「格子应该从右往左开始排，
    //     而不是从左到右排，不是说了排完后剩余空间给快捷方式等不整理的图标部分吗」。
    //     右锚定仍是**内容的纯函数**（总宽由内容算出）⇒ 幂等不受影响；也不碰带下空间的
    //     「`band_b` 的 x 严格大于 `band_a`」纪律 —— `band_a` 最右一列的右沿就是 zone 右沿，
    //     仍在 `band_b` 左沿之左（见 [`content_plan_with_lower_band`] ①）。
    //   · **列内撑满列宽**：一列的宽度 = 该列最宽那格；比它窄的格子**撑到列宽**、按新宽度
    //     重算高度（宽了行数就少 ⇒ 只会更矮，不可能因此越界）。用户：「上面是宽的 下面放在
    //     一个小的小格子 宽度没有占满……合理利用空间才好看吧」。⚠️ 这只**撑宽**、不**夹窄**
    //     —— V71「不许比自然宽度更窄」的底线原样保留。
    let mut slots = vec![SlotRect { x: band.x, y: band.y, w: 0, h: 0 }; order.len()];
    let col_ws: Vec<i64> = cols
        .iter()
        .filter(|c| !c.is_empty())
        .map(|c| c.iter().map(|&i| widths[i]).max().unwrap_or(MIN_BOX_W))
        .collect();
    // 右沿从 band 右沿起、每摆完一列向左退一道缝：第一列（最大的格子）贴便签一侧，
    // 后面的列依次向左排。⚠️ 别写成「x = 右沿 − 总宽」再往左摆 —— 那是块**左**端的位置，
    // 整块会向左溢出 band（真机测出 x = −57 就是这么来的）。
    let mut right = band.x + zone_w;
    for (ci, col) in cols.iter().filter(|c| !c.is_empty()).enumerate() {
        let col_w = col_ws[ci];
        let x = (right - col_w).max(band.x);
        let group: Vec<i64> = col
            .iter()
            .map(|&i| {
                if widths[i] < col_w {
                    // 撑满列宽：高度按新宽度重算（`order[i]` 才是条目数的下标 ——
                    // `heights` / `widths` / `slots` 都按摆放序的位置编号）
                    box_height_at(items[order[i]], col_w, icon, zone_h)
                } else {
                    heights[i]
                }
            })
            .collect();
        let natural = group.iter().copied().sum::<i64>() + (group.len() as i64 - 1).max(0) * ARRANGE_GAP_Y;
        let fitted = if natural > zone_h {
            squeezed = true;
            fit_column_heights(&group, zone_h)
        } else {
            group
        };
        let mut y = band.y;
        for (j, &i) in col.iter().enumerate() {
            slots[i] = SlotRect {
                x,
                y,
                w: col_w,
                h: fitted[j],
            };
            y += fitted[j] + ARRANGE_GAP_Y;
        }
        right = x - ARRANGE_GAP_X;
    }
    let limit = band.y + band.h;
    let overflowed = slots.iter().any(|s| s.y + s.h > limit);
    ContentPlan {
        slots,
        squeezed,
        overflowed,
    }
}

/// **带下空间**（V68）：把一片内容排进「上面一条带 + 挂件带下方那条带」。
///
/// # 用户原话（09-22，附真机截图）
///
/// 「没有便签的时候便签列可以作为格子列使用，如果便签页没有满的时候比如只有1个，下面还有
/// 大量的空间 我们也可以把格子跑过去的，不然页面还有空位置，结果搞出滚动条了，这是桌面哇，
/// 哪里来的滚动条哇，如果放不下那么久应该滚动条」。
///
/// 真机现场（`handy.log` 23:32）：工作区 1707×912，便签列 260 宽、只有 303 高（`y` 32..335），
/// 它下方 335..880 那一整条是**空的**；而收纳区可用宽只有 637 ⇒ 最多并 3 列，
/// 17 个格子摞出来的最高列 984 > 848 ⇒ 越过下沿 ⇒ **前端那层 `overflow-y-auto` 出滚动条**。
/// 「有空位置」与「出滚动条」就这么同时成立了。
///
/// # 做法
///
/// 把 `band_a`（挂件带左侧那条，整幅高度）与 `band_b`（挂件带**下方**那条，起点在挂件下沿）
/// 交给同一个 [`content_plan_in`]，对每个**切分点** `m` 各排一次，取代价最小的那个：
///
/// ```text
/// 代价 = max(band_a 里最低的下沿, band_b 里最低的下沿)      ← 越小越紧凑、越不容易滚
/// ```
///
/// 于是「把空间占满」与「不出滚动条」变成同一个目标函数的两面。
///
/// # 三条必须守住的纪律
///
///   ① **`band_b` 的每个格子 `x` 都严格大于 `band_a` 的** —— 这是「读序 = 落位序」在 V68
///      仍然成立的前提：`(x, y)` 依旧是**严格全序** ⇒ 增量整理仍然幂等
///      （见 [`content_plan`] 长注释）。实现上就是让带下那条的左沿**跟着 `band_a` 实际用到
///      的右沿走**（`used_right + ARRANGE_GAP_X`，封顶在挂件带左沿）：
///      `band_a` 没把宽度用满时两条带之间**不留空档**，用满了就正好接在它右边。
///      ⚠️ 千万别把带下那条摆回 `min_x`（「便签下方再从左排起」）—— 那样它的第一列会插进
///      `band_a` 第一列中间，幂等当场失效。
///   ② **持平不回退**：只有严格更低才换用带下空间。所以「便签旁边本来就排得下」的情形
///      一个像素都不会动（`m = items.len()` 就是今天的行为）。
///   ③ **压缩不算越界**：带下那条比上面那条矮是常态，它被压到 `MIN_BOX_H` 是**设计内**的
///      （格子内部滚），只有排完仍越过下沿才叫 `overflowed`。
fn content_plan_with_lower_band(
    items: &[usize],
    band_a: SlotRect,
    band_b: Option<SlotRect>,
    icon: i64,
) -> ContentPlan {
    let sizes = own_sizes(items, band_a.w, band_a.h, icon);
    // 摆放序 = 大格子在前（V69）。**两条带的切分也按这个序切** —— 于是「落在带下的永远是
    // 最小的那几个格子」，正是用户那句「大格子先布局好、小格子找空隙插入」在带下的落法。
    let order = placement_order(items, &sizes);
    let whole = content_plan_in(&order, items, band_a, icon);
    if items.is_empty() {
        return scatter_back(&order, whole, items.len());
    }
    let Some(band_b) = band_b else {
        return scatter_back(&order, whole, items.len());
    };
    // 带下那条的**硬右沿**（= 收纳区右沿）：左沿随 `band_a` 的实际用量浮动，
    // 右沿永远钉在这儿。
    let hard_right = band_b.x + band_b.w;
    // 打底 = 「全部塞进 band_a」（= 没有带下空间时的行为），`m` 从 n-1 往下试、只有严格更低
    // 才替换，于是并列时永远选「band_a 装得更多」的那个（带下那条起点更低，多用它一格都不划算）。
    let mut best = (whole.bottom(), whole);
    for m in (0..order.len()).rev() {
        let pa = content_plan_in(&order[..m], items, band_a, icon);
        // 左沿：`band_a` 用到的右沿 + 一道缝（`band_a` 空着时就从收纳区左沿起）
        let used_right = pa.slots.iter().map(|s| s.x + s.w).max();
        let x0 = match used_right {
            Some(r) => (r + ARRANGE_GAP_X).min(band_b.x).max(band_a.x),
            None => band_a.x,
        };
        let lower = SlotRect {
            x: x0,
            y: band_b.y,
            w: (hard_right - x0).max(0),
            h: band_b.h,
        };
        if lower.w < MIN_BOX_W {
            continue;
        }
        let pb = content_plan_in(&order[m..], items, lower, icon);
        let cost = pa.bottom().max(pb.bottom());
        if cost < best.0 {
            // ⚠️ 拼接顺序必须与 `order` 对齐（`pa` 覆盖 `order[..m]`、`pb` 覆盖 `order[m..]`）——
            // 一旦反了，格子名与坑位就会错配（`scatter_back` 是按位摊回去的）。
            let mut slots = pa.slots;
            slots.extend(pb.slots);
            best = (
                cost,
                ContentPlan {
                    overflowed: pa.overflowed || pb.overflowed,
                    slots,
                    squeezed: pa.squeezed || pb.squeezed,
                },
            );
        }
    }
    scatter_back(&order, best.1, items.len())
}


/// 左侧那条「未归类」竖条（V42）。
///
/// 装的是**不进格子**的三类东西：系统入口（此电脑 / 回收站 / 用户的文件）、快捷方式
/// （`.lnk`）、以及没被任何格子登记的落单条目。用户 V42 原话：
/// 「不整理的和快捷方式别整理到格子了，他们就是自动在桌面左上角从上往下排开即可，
/// 不需要放到格子里面，没有必要」「左边部分是不需要分类的快捷方式依次展示」。
///
/// 与 V41「不整理」区的三个区别：
///   ① 位置从**左下角**搬到**左上角**（用户点名的方位）；
///   ② 不再是一整块「格子」—— 前端按**纯图标**画（无卡片外框、无标题栏），
///      看起来就跟系统桌面自己那排图标一样；
///   ③ 单元格度量与收纳格条目**同一套**（[`loose_cell_size`]），所以它和格子里的
///      图标大小、间距一致，不是「另一种风格的东西」。
///
/// `count == 0` 时返回 `None`：没有未归类条目就什么都不占（也不会在布局里当禁区）。
#[derive(Debug, Clone, Copy)]
struct LooseStrip {
    rect: SlotRect,
    /// 竖条分几列 —— 前端按它渲染等宽网格，差一列就会盖住旁边的分类格
    columns: i64,
}

/// 竖条里一个格位的 `(宽, 高)`：与收纳格的条目单元格同一套度量
/// （图标 + [`CELL_EXTRA_W`] / 图标 + [`CELL_EXTRA_H`]），改这里要同步改前端。
fn loose_cell_size(icon: i64) -> (i64, i64) {
    let icon = icon.clamp(16, 256);
    (icon + CELL_EXTRA_W, icon + CELL_EXTRA_H)
}

/// 竖条宽度的**占比上限**（V86）：竖条最多占「工作区宽度的一半 − 一道边距」。
///
/// # 为什么不再拍一个固定列数（V86）
///
/// 原来夹死 `LOOSE_MAX_COLUMNS = 4`：真机 42 个条目、每列 8 行 ⇒ 需要 6 列却被夹回
/// 4 列，多出的 10 个条目全滚进竖条内部的隐藏滚动区 —— 用户 09-30 原话：
/// 「快捷方式这里应该从左到右依次往下排列，满了就换第二列，现在怎么成了**下面空了**，
/// 正常应该是**右边空**」。列数放开后：每列都满高、不满的只是**最右一列**的下部；
/// 极端条目数撞到宽度上限时，仍由竖条内部滚动兜底（契约见下方测试）。
const LOOSE_MAX_WIDTH_NUM: i64 = 1;
const LOOSE_MAX_WIDTH_DEN: i64 = 2;

/// 「未归类」竖条的矩形与列数（V42；V59 追加了「列数撞上限」的契约；V86 改按宽度封顶）。
///
/// # 列数被夹住时，`rect.h` 会小于前端需要的高度 —— 这是**有意**的
///
/// 行数先按「一列放得下几行」（`rows_per_col`）反推需要几列，再把列数夹在
/// 「竖条最多占工作区一半宽」内（[`LOOSE_MAX_WIDTH_DEN`]）。列数一旦被夹住，`rows`
/// 就**可能大于** `rows_per_col`；此时这里把高度封顶到 `avail_h`（竖条绝不许越出
/// 工作区下边界），而**前端渲染的行数仍然是 `ceil(n / columns)`** —— 于是**内容天然比
/// `rect.h` 高**。
///
/// 那几行不会溢出去：前端竖条自己带 `overflow-y-auto`，**在容器内部滚**
/// （与收纳格「装不下就内部出滚动条」同一口径，用户 09-21 第 ③ 条）。
/// **千万别**为了让数值「看起来自洽」而把 `h` 放开不封顶 —— 那会让竖条压到任务栏上，
/// 或者更糟：把溢出交给桌面根画布，整层变成可滚的（V59 的回归就是这么来的）。
///
/// 小屏上 `avail_h` 更小、`rows_per_col` 更少，更容易撞到这条。
fn loose_strip_rect(work_w: i64, work_h: i64, count: usize, icon: i64) -> Option<LooseStrip> {
    if count == 0 {
        return None;
    }
    let work_w = if work_w > 0 { work_w } else { 1280 };
    let work_h = if work_h > 0 { work_h } else { 720 };
    let (cell_w, cell_h) = loose_cell_size(icon);
    // 纵向一格的完整占位（含行距）—— 用「能放下几行」反推需要几列
    let pitch_y = cell_h + GRID_GAP;
    let pitch_x = cell_w + GRID_GAP;
    let avail_h = (work_h - 2 * ARRANGE_MARGIN).max(cell_h);
    let rows_per_col = (avail_h / pitch_y).max(1);
    let n = count as i64;
    // V86：列数 = ceil(n / rows_per_col) 自然算出，被「最多占工作区一半宽」夹住
    //（不再夹固定 4 列 —— 那会把多出的条目全藏进内部滚动区，用户看到「下面空了」）。
    let max_cols = (((work_w * LOOSE_MAX_WIDTH_NUM) / LOOSE_MAX_WIDTH_DEN - ARRANGE_MARGIN)
        / pitch_x)
        .max(1);
    let columns = ((n + rows_per_col - 1) / rows_per_col).clamp(1, max_cols);
    let rows = (n + columns - 1) / columns;
    let w = (columns * cell_w + (columns - 1) * GRID_GAP)
        .min((work_w - 2 * ARRANGE_MARGIN).max(cell_w));
    let h = (rows * pitch_y - GRID_GAP).min(avail_h).max(cell_h);
    Some(LooseStrip {
        rect: SlotRect {
            x: ARRANGE_MARGIN,
            y: ARRANGE_MARGIN,
            w,
            h,
        },
        columns,
    })
}

/// 已经被任何格子登记过的路径集合（判断「落单」用）。
fn registered_paths(conn: &Connection) -> Result<std::collections::HashSet<String>, String> {
    let mut stmt = conn
        .prepare("SELECT DISTINCT file_path FROM grid_items")
        .map_err(|err| format!("读取登记失败：{err}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("读取登记失败：{err}"))?;
    let mut set = std::collections::HashSet::new();
    for row in rows {
        set.insert(row.map_err(|err| format!("读取登记失败：{err}"))?);
    }
    Ok(set)
}

/// 「不整理」区里的一个条目（V41）。**不是** `GridItem`：它没有登记 id，因为它压根没进过
/// 任何格子 —— 身份就是它在磁盘上的路径。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LooseEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub is_lnk: bool,
    /// 系统入口（此电脑 / 回收站 / 用户的文件）：`path` 是 shell CLSID，
    /// 前端据此画专用图标（`SHGetFileInfo` 对 `::{...}` 不可靠）
    pub is_system: bool,
}

/// 「不整理」区的完整状态（`grid_loose_list` 返回值）：矩形 + 里面的条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LooseArea {
    /// 逻辑像素；`width == 0` = 没有落单条目（前端不渲染）
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    /// 竖条分几列（V42）：前端用「等宽 × columns 列的网格」渲染，
    /// 与后端的占位几何**严格一致** —— 差一列就会盖住旁边的分类格
    pub columns: i64,
    /// 与格子同一档的图标尺寸（前端按它渲染条目图标）
    pub icon_size: i64,
    pub items: Vec<LooseEntry>,
}

impl LooseArea {
    fn empty() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            columns: 0,
            icon_size: 0,
            items: Vec::new(),
        }
    }
}

/// 左侧竖条的内容：**系统入口 + 没被任何格子登记的桌面条目**。
///
/// V42 起快捷方式（`.lnk`）不再进格子（见 [`arrange_group_of`]），所以它们天然
/// 「未登记」→ 自动出现在这里，无需特判。系统入口是虚拟条目（磁盘上没有对应文件），
/// V42 起也不再进「系统」格，改为排在这条竖条的最前面。
///
/// 排序刻意稳定（系统 → 快捷方式 → 文件夹 → 其余按名字）：每次打开看到的顺序一样，
/// 用户不会觉得「这堆东西自己在动」。
fn loose_desktop_items(conn: &Connection) -> Result<Vec<LooseEntry>, String> {
    let registered = registered_paths(conn)?;
    let mut out: Vec<LooseEntry> = Vec::new();
    // ① 系统入口（此电脑 / 回收站 / 用户的文件）
    for (path, name) in SYSTEM_ENTRIES {
        if !registered.contains(path) {
            out.push(LooseEntry {
                path: path.to_string(),
                name: name.to_string(),
                is_dir: false,
                is_lnk: false,
                is_system: true,
            });
        }
    }
    // ② 两个桌面根里没被登记过的条目（含全部快捷方式）
    for root in desktop_roots() {
        let Ok(items) = crate::commands::organizer::scan_items(&root) else {
            continue;
        };
        for item in items {
            if registered.contains(&item.path) {
                continue;
            }
            out.push(LooseEntry {
                path: item.path,
                name: item.name,
                is_dir: item.is_dir,
                is_lnk: item.is_lnk,
                is_system: false,
            });
        }
    }
    out.sort_by(|a, b| {
        loose_rank(a)
            .cmp(&loose_rank(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// 竖条里的展示次序：系统入口 → 快捷方式 → 文件夹 → 其他文件。
///
/// 用户 V42 原话「按照类型顺序排序从左上角依次排开」—— 系统与快捷方式是他点名要
/// 摆在前面的两类（它们是「不需要分类」的那批）。
fn loose_rank(entry: &LooseEntry) -> i64 {
    if entry.is_system {
        0
    } else if entry.is_lnk {
        1
    } else if entry.is_dir {
        2
    } else {
        3
    }
}

/// 「不整理」区的当前状态（V41）：矩形（逻辑像素，相对挂件窗）+ 里面的条目。
///
/// 前端（挂件窗）挂载时拉一次、之后随对账轮询一起刷新；矩形由后端用与
/// [`layout_all_boxes`] 完全相同的度量算出（图标尺寸 + [`grid_height_at`] 那套行高），
/// 保证「不整理」区和分类格看起来是同一套系统画的。
///
/// `width == 0` 表示没有落单条目，前端不渲染这块面板。
#[tauri::command]
pub async fn grid_loose_list(app: AppHandle) -> Result<LooseArea, String> {
    let (work_w, work_h) = layout_work_size(&app);
    let icon = layout_icon_size();
    let conn = connect(&app)?;
    let items = loose_desktop_items(&conn)?;
    if items.is_empty() {
        return Ok(LooseArea::empty());
    }
    let Some(strip) = loose_strip_rect(work_w, work_h, items.len(), icon) else {
        return Ok(LooseArea::empty());
    };
    Ok(LooseArea {
        x: strip.rect.x,
        y: strip.rect.y,
        width: strip.rect.w,
        height: strip.rect.h,
        columns: strip.columns,
        icon_size: icon,
        items,
    })
}

/// 一次「整理桌面」对布局做了什么（数值回报给前端，用户能看出工具干了什么）。
#[derive(Debug, Clone, Copy, Default)]
struct LayoutOutcome {
    /// 真正被挪动的格子数
    moved: usize,
    /// 按内容量调整过尺寸的格子数
    resized: usize,
    /// 被归位到锚点的挂件数
    anchored: usize,
    /// 桌面空间不足、只能压在别人身上的格子数（正常情况恒为 0）
    overflowed: usize,
}

/// **整理桌面布局**：挂件归位到锚点 → 收纳格按内容定尺寸（宽 + 高）→ 左起流式铺行。
///
/// 为什么要「全量重排」而不是「只摆新格子」：用户实测（V38）点完整理后抱怨
/// 「格子是自动创建了但是很乱，没有计算桌面合理的规划格子位置」—— 根因是新建的格子
/// 按「已有格子个数」取槽位、而复用的旧格子**保留着自己当年的坐标**，两拨坐标凑在一起
/// 就是一团乱麻。所以整理这一步直接把所有格子重新排一遍。
///
/// V39 补了三件（用户看着截图说「桌面很乱、格子该按内容量调整大小」）：
///   ① 格子**按条目数**算尺寸（`auto_box_size`，V65 起它成了唯一尺寸来源）—— 装了 21 个
///      快捷方式的格子和装了 2 个文档的格子不该一样大；
///   ② 挂件**归位到锚点**（日历右上角、便签左下角），当禁区给格子绕；
///   ③ 排不下时**先缩到最小尺寸重试**，实在不行 `place_loose` 也要把它放进格子区 ——
///      V38 会「保持原位」，于是没排上的格子散落在桌面各处，正是用户看到的乱象
///      （日志实证：`重排格子：挪动 4 个……4 个没地方放（保持原位）`）。
///
/// V40 再补三件（用户看着新截图说「让格子对齐整齐哇，宽度对齐，整理排列，流布局等，
/// 高度根据图标多少自动撑开」）：
///   ① ~~**宽度一律统一**~~（[`standard_box_width`]，**V65 已废**：宽度改按内容给 ——
///      真机上正是「宽度与内容无关」导致 1 个条目的格子占掉 17 个条目的位置）；
///   ② **改成左起流布** —— 右上角日历（460×638）那块大禁区正好卡住「靠右」的第一列，
///      格子被迫一路往左让、最后堆在屏幕中间（用户截图里两侧空、中间挤）；
///   ③ 系统格（此电脑 / 回收站 / 用户文件夹）**从挂件改成收纳格**：它本质是内容格，
///      以前按挂件走锚点，自成一个 320 宽度，也是「对不齐」的一部分。
/// 排布模式（V48；**V50 改 `Fill` 的保留口径**）。
///
/// 用户原话：「如果用户自己调整了那么记录用户自己的改变，除非后面用户重新重置整理，
/// 我们又按照我们自己的规律整理，普通整理保留用户已有布局，只是将散落的需要整理的其他
/// 内容归纳到格子即可」——所以排布必须分两种口径。
///
/// V50 之前 `Fill` 是「只要不重叠、不越界就一律原地保留」，于是**上一版算法留下的列位
/// 会被永久钉住**（真机 `x=386/397`，与算出来的 463/707 差 40px，格子之间一眼就看歪）；
/// 现在 `Fill` 只把 `manual`（用户自己拖过 / 拉过）当作「顺序依据」—— 这才是用户说的
/// 「记录用户自己的改变」；V65 连「位置」也不再照搬（尺寸与坐标一律重算），只留**先后**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LayoutMode {
    /// **全量重排**：所有格子按分区规则重新算一遍（= 用户按「重新重置整理」），
    /// 连 `manual` 标记一并清掉。
    Full,
    /// **增量补齐**：按格子**当前的位置**排出先后（先上后下、先左后右），再按内容重算尺寸、
    /// 流式铺行；`manual` 的格子只是「顺序贴着用户原来的摆法」，不再独占某个坑。
    /// 新建挂件也会立刻走这个口径（见 `grid_box_upsert`）。一键整理与挂件窗挂载时的
    /// 自愈都走它 —— 它是**幂等**的：排完之后每格的位置与顺序都稳定，再排一次一个都不动。
    Fill,
}

/// **整理桌面布局**（V48 分区 + V50 定型 + **V64 按内容协调空间**）。
///
/// 桌面分成三条带，自左向右：
///   1. **未归类竖条**（系统入口 / 快捷方式 / 落单文件）——纯图标，不造格子（V42 既定）；
///   2. **收纳区**：**按内容定尺寸 + 流式行**（[`content_plan`]）—— 每个格子的宽高都由它
///      **自己的条目数**算出（条目越多越大），按顺序自左向右铺、铺不下换行，行内**顶部
///      对齐**；装不下就在格子内部滚，整个收纳区放不下时越过下边界、由前端的收纳区滚动
///      容器接管；
///   3. **挂件带**：日历 / 工作台日志一大列（最右），便签**恒定一条列**在它左侧，
///      其余挂件继续往左开列。
///
/// **V50 的两条硬不变量仍然有效**（用户 09-19：「便签一个独立的列…不要跟格子挤在一起影响
/// 整理美观」+「程序需要先计算，务必保证所有的内容不能重叠」）：
///   · **挂件带宽度只由「有哪些挂件、挂件多宽」决定**，不看它们现在摆在哪 ——
///     于是加便签只会改变便签列内部，收纳区的网格一个像素都不动；
///   · **收纳格一律不得跨进挂件带**（`x + w ≤ band_left - ARRANGE_GAP_X`，见
///     [`needs_placement`] 判据 ⑤）。
///
/// ⚠️ V63 推翻了第三条（「谁原地不动由 `manual` 决定」）：`manual` 不再决定「谁不动」。
/// ⚠️ **V64 推翻 V63 的「尺寸一律统一」**（用户：「我图片只有一个，你搞那么大的空间做什么」），
/// 但 V64 的行带分摊又出了新问题：**坑的尺寸按 plan 顺序算，格子却按「离我最近」抢坑** ⇒
/// 真机上 17 个条目的格子拿到 1 个条目的窄坑、1 个条目的格子拿到大坑；再加上**同行同高**，
/// 1 个条目的格子就被撑成 376 高的空盒子。
/// ⚠️ **V65 收敛为**：尺寸**只**看自己的条目数（[`box_own_size`]），位置按顺序**流式铺行**
/// （[`content_plan`]），`manual` 只在增量整理时决定「先后」—— 详见 [`content_plan`]。
///
/// 历史上的几种做法都已被淘汰，别按它们推理：
///   · V38「保持原位」→ 没排上的格子散落各处；
///   · V39–V40「左起/镜像首次适配 + 挂件矩形当禁区」→ 见缝插针，格子钻进日历底下；
///   · V41–V47「挂件同角落竖排 + 整列保留」→ 列满之后 `clamp_y` 把挂件全叠到同一个 y
///     （三个便签重叠的根因），且收纳区高度不均衡、中间留大片空洞；
///   · V48–V49「便签放不下就往左再开一条列」→ 便签越多挂件带越宽，收纳区被挤到只剩
///     一条列还装不下（真机 6 个便签时两个格子被顶到屏幕外），且旧算法的死坐标会被
///     「保留用户摆法」一直留着，与算出来的列位差 40px；
///   · V50–V62「两条等宽列 + LPT 按高度分列 + 高度随内容」→ 宽度对齐了，但**高度各行
///     不同**，同一行两个格子的下沿差几十像素；`manual` 的格子还会整块保留历史宽高，
///     真机上就出现了 180 / 165 两种宽度挨在一起（用户 09-21：「没有对齐」）；
///   · V63「统一网格」→ 对齐做到了，可格子大小与内容彻底脱钩，装 1 个的和装 20 个的
///     一样大（用户 09-21 的第二轮反馈：「我图片只有一个，你搞那么大的空间做什么」）；
///   · V64「行带 + 份额分摊 + 同行同高」→ 尺寸与内容错配（见上），用户第三轮反馈
///     「图标少的格子占那么大空间而且都是空的，图标多的反而沾一点点空间」。
fn layout_all_boxes(
    conn: &Connection,
    work_w: i64,
    work_h: i64,
    icon: i64,
    mode: LayoutMode,
) -> Result<LayoutOutcome, String> {
    // 落单条目数在这里统一取（V41）。测试走 [`layout_all_boxes_with`] 注入固定值，
    // 不依赖跑测试那台机器的桌面长什么样（机器相关的测试就是不可复现的测试）。
    let loose_count = match loose_desktop_items(conn) {
        Ok(items) => items.len(),
        Err(err) => {
            grid_log(&format!("统计落单条目失败（本次不占位）：{err}"));
            0
        }
    };
    layout_all_boxes_with(conn, work_w, work_h, icon, loose_count, mode)
}

/// [`layout_all_boxes`] 的可注入版本：`loose_count`（落单条目数）由调用方给定。
fn layout_all_boxes_with(
    conn: &Connection,
    work_w: i64,
    work_h: i64,
    icon: i64,
    loose_count: usize,
    mode: LayoutMode,
) -> Result<LayoutOutcome, String> {
    // —— V50：全量重置 = 用户明确要求「按 Handy 自己的规律整理」——
    // 连「用户手工摆过」的标记也一并放开，否则重置之后手工格子仍钉在原地。
    if mode == LayoutMode::Full {
        if let Err(err) = conn.execute("UPDATE grid_boxes SET manual = 0 WHERE manual <> 0", []) {
            grid_log(&format!("清除手工摆放标记失败（忽略）：{err}"));
        }
    }
    let rows = load_box_rects(conn)?;
    let mut outcome = LayoutOutcome::default();
    let avail_h = (work_h - 2 * ARRANGE_MARGIN).max(MIN_BOX_H);

    // —— ⓪ 左侧「未归类」竖条：收纳区与挂件区都不得越过它的右沿 ——
    let strip = loose_strip_rect(work_w, work_h, loose_count, icon);
    let min_x = match strip {
        Some(s) => s.rect.x + s.rect.w + ARRANGE_GAP_X,
        None => ARRANGE_MARGIN,
    };

    // —— ① 挂件按列自右向左落位（日历列 → 便签列 → 其他）——
    //
    // `MIN_BOX_W` 是给收纳区留的**保底宽度**：挂件再多也不许把收纳区挤没。
    // V48 没有这条约束，真机上「便签加到第三个」时挂件列一路往左开，收纳区宽度被算成
    // 0（甚至负数），收纳格被算到 x=283 / x=-292 —— 用户看到的就是「一堆格子跑到桌面
    // 最左边看不见的区域，只露出一条边」。
    //
    // **V50：挂件一律由列规则安置，不看 `manual`、也不看它现在在哪。** 依据是用户那句
    // 「便签一个独立的列」—— 便签必须永远待在便签列里，它当前坐标可能只是历史算法留下的
    // （真机 `(1031, 30)` 正好落在收纳格那一列上、与「安装包 / 图片」同列，就是用户截图里
    // 「便签跟格子挤在一起」的样子）。位置不保留，但**高度保留**：便签的高度是用户拉过的，
    // 列内叠放用它自己的 h（放不下才压）。
    //
    // 于是挂件带宽度**完全由「有没有挂件、挂件多宽」决定**，与「现在摆在哪」无关：
    // 加一个便签只会改变便签列内部，收纳区的列网格一个像素都不动。
    let widgets: Vec<&GridBoxRect> = rows.iter().filter(|r| r.is_widget()).collect();
    // V60：常驻的「工作台」浮窗是**禁区**（它不在 `grid_boxes` 里，但实实在在占着工作区
    // 右侧一整列 —— 不认它，挂件带与收纳区都会铺上来）。
    let wst = workstation_rect(work_w, work_h);
    let reserved: [SlotRect; 1] = [wst];
    // 挂件带 / 收纳区的**右界**：让开工作台那一列（再留一道 [`ARRANGE_GAP_X`] 的缝）。
    // 这一条是 V60 的关键 —— 少了它，第一个便签列会正好排到工作台底下。
    let right_edge = (wst.x - ARRANGE_GAP_X).max(min_x);
    let widget_plans =
        place_widget_columns(&widgets, work_h, min_x, MIN_BOX_W, &reserved, right_edge);

    let mut widget_rects: Vec<SlotRect> = Vec::new();
    for (id, want) in widget_plans {
        let Some(current) = rows.iter().find(|r| r.id == id) else {
            continue;
        };
        // 挂件的**宽度**永远按自然宽度收（V49：日历在真机库里是 460，而日历本体只要 320，
        // 多出来的 140px 全是两侧留白 —— 09-19「日历这里总宽度没有收回来」）。
        let mut rect = want;
        rect.h = rect.h.clamp(MIN_BOX_H, avail_h);
        rect.w = widget_natural_width(&current.kind)
            .unwrap_or(rect.w)
            .clamp(MIN_BOX_W, AUTO_MAX_W);
        if current.x != rect.x
            || current.y != rect.y
            || current.w != rect.w
            || current.h != rect.h
        {
            conn.execute(
                "UPDATE grid_boxes SET pos_x = ?1, pos_y = ?2, width = ?3, height = ?4, \
                 updated_at = ?5 WHERE id = ?6",
                params![rect.x, rect.y, rect.w, rect.h, now_iso(), id],
            )
            .map_err(|err| format!("摆放挂件失败：{err}"))?;
            outcome.anchored += 1;
            if current.w != rect.w || current.h != rect.h {
                outcome.resized += 1;
            }
        }
        widget_rects.push(rect);
    }

    // —— ② 收纳区：**按内容定尺寸 + 流式行**（V65，见上面的模块注释）——
    let content: Vec<&GridBoxRect> = rows.iter().filter(|r| !r.is_widget()).collect();
    // 挂件带的左沿 = 收纳区不许越过的硬右界（V50 的核心不变量）。
    // 它是**算出来的**（挂件列规则），不是从「谁被保留在原位」里取最小值 —— 后者会让一个
    // 坐标跑偏的便签把整条收纳区挤到负数宽度（V49 真机事故）。
    // ⚠️ **没有挂件时右界不要再减一道缝**：`band_left` 这时取的是兜底值 `right_edge`，
    // 再减 [`ARRANGE_GAP_X`] 就等于凭空扔掉 32px（用户 09-22「没有便签的时候便签列可以
    // 作为格子列使用」—— 那一列要**整条**归收纳区，不是「归到离工作台两道缝那么近」）。
    let band_left = widget_rects
        .iter()
        .map(|r| r.x)
        .min()
        .unwrap_or(right_edge);
    let zone_right = content_zone_right(&widget_rects, right_edge);
    let zone_w = (zone_right - min_x).max(0);
    let zone_h = (work_h - 2 * ARRANGE_MARGIN).max(MIN_BOX_H);

    // —— V68：挂件带**下方**那条带 ——
    //
    // 用户 09-22（附真机截图）：「如果便签页没有满的时候比如只有1个，下面还有大量的空间
    // 我们也可以把格子跑过去的，不然页面还有空位置，结果搞出滚动条了，这是桌面哇，哪里来的
    // 滚动条哇」。真机上便签列只有 303 高，下方 335..880 一整条 236 宽的空白就白扔着，
    // 而收纳区只剩 3 列的宽度、格子一路摞到 y=1160 出滚动条。
    //
    // 于是把收纳区拆成两条带交给 [`content_plan_with_lower_band`]：
    //   · `band_a`：挂件带左侧那条（`x ∈ [min_x, band_left - ARRANGE_GAP_X)`，整幅可用高）；
    //   · `band_b`：挂件带**下方**那条（`x ∈ [band_left, right_edge - ARRANGE_GAP_X)`，
    //     从挂件下沿 + 一道缝起算）。
    //
    // ⚠️ `band_b` 的 `x` 必须**接在 band_a 右边**（不许回到 `min_x`）—— 这是「读序 = 落位序」
    // 这条不变量在 V68 仍然成立的前提，理由写在 [`content_plan_with_lower_band`] 的 ① 里。
    let band_a = SlotRect {
        x: min_x,
        y: ARRANGE_MARGIN,
        w: zone_w,
        h: zone_h,
    };
    let lower_x = band_left;
    // ⚠️ `right_edge` 本身已经让开工作台一道缝了，这里**不要再减一次** ——
    // 否则带下那一列离工作台会空出两道缝（48px），又是一块白白扔掉的地方。
    let lower_w = (right_edge - band_left).max(0);
    // 这一条带的起点 = **与它横向相交的挂件**里最低的那个下沿 + 一道缝。
    // 不相交的挂件（更靠左的列）不参与 —— 它们本来就不会被压到。
    let lower_top = widget_rects
        .iter()
        .filter(|r| r.x < lower_x + lower_w && lower_x < r.x + r.w)
        .map(|r| r.y + r.h + ARRANGE_GAP_Y)
        .max()
        .unwrap_or(ARRANGE_MARGIN);
    let lower_h = (work_h - ARRANGE_MARGIN - lower_top).max(0);
    // 太窄 / 太矮就当没有这条带（放一个 `MIN_BOX_H` 都放不下时它只会碍事）。
    let band_b = (lower_w >= MIN_BOX_W && lower_h >= MIN_BOX_H)
        .then_some(SlotRect {
            x: lower_x,
            y: lower_top,
            w: lower_w,
            h: lower_h,
        });

    // **顺序**（V69）：**不再由 `LayoutMode` 或「格子现在停在哪」决定** —— 摆放序完全由
    // 内容决定（[`placement_order`]：面积大的先占位，同尺寸时按登记顺序）。
    //
    // 这一条把 V42–V68 一路攒下来的三个坑一起送走了：
    //   · V64「manual 格子吸附到离它最近的坑」：真机上把尺寸与内容彻底搅乱
    //     （17 个条目的「文档」抢到 1 个条目的窄坑、5 个条目的「文件夹」抢到 17 个条目的大坑）；
    //   · V66.1「还没落位的格子当哨兵甩队尾」：列式填满的第一个格子正好落在
    //     `(ARRANGE_MARGIN, ARRANGE_MARGIN)`，于是每次增量整理都把**它**当新格子甩到队尾，
    //     顺序整体轮转（真机上「每排一次挪 7 个」）；
    //   · V66「读序必须等于落位序」：为了让「按位置读回来的顺序」与「落位顺序」同构，
    //     连列式布局的读法（`(x, y)` 而不是 `(y, x)`）都成了不变量的一部分。
    //
    // 现在这些统统不需要了：**摆放序是内容的纯函数**（`LayoutMode` 只影响 `manual` 清不清零），
    // 排完再排，尺寸没变 ⇒ 顺序没变 ⇒ 落位一字不差 —— 幂等是**算出来的**，不是靠几何去兜的。
    //
    // ⚠️ 位置仍然一个像素都决定不了：坐标一律由列式落位重算，尺寸一律由内容算。
    // 用户手工把格子拖到哪，只是「拖到那儿的这一下」的表现；下一次整理仍按大小归位。
    let plan_of = |seq: &[&GridBoxRect]| -> ContentPlan {
        let items: Vec<usize> = seq.iter().map(|r| r.items).collect();
        content_plan_with_lower_band(&items, band_a, band_b, icon)
    };
    // `content` 的顺序就是 `sort, id`（登记顺序）—— 它只用来决定**同尺寸格子**的先后。
    let ordered: Vec<&GridBoxRect> = content.clone();
    let plan = plan_of(&ordered);

    let plans: Vec<(i64, SlotRect)> = ordered
        .iter()
        .zip(plan.slots.iter())
        .map(|(r, slot)| (r.id, *slot))
        .collect();
    // 「用户动过」的格子数（V69 起只是信息性指标：摆放序已由内容决定，与它无关）
    let manual_cells = ordered.iter().filter(|r| r.manual).count();

    // 被顶出屏幕的格子**点名**（V50）：V49 的日志只写「空间不足 2 个」，
    // 排查时还得去反推是哪两个 —— 这里直接把名字带上。
    let mut overflowed_names: Vec<String> = Vec::new();

    for (id, rect) in &plans {
        let current = rows.iter().find(|r| r.id == *id);
        // ⚠️ V68 修：越界统计**必须放在 `continue` 之前**。
        // V66 把它写在「落库」那一段里，于是「上一轮就已经越界、这一轮坐标没变所以被
        // `continue` 跳过」的格子全都漏统计 —— 真机 23:32 那行日志赫然写着「超出一屏 0 个」，
        // 而实际最高列 984 早已越过 848、前端整层正在滚。**日志会骗人，这里不能再省。**
        if rect.y + rect.h > work_h - ARRANGE_MARGIN {
            outcome.overflowed += 1;
            if let Some(r) = current {
                overflowed_names.push(r.name.clone());
            }
        }
        let moved = current
            .map(|r| r.x != rect.x || r.y != rect.y)
            .unwrap_or(true);
        let resized = current
            .map(|r| r.w != rect.w || r.h != rect.h)
            .unwrap_or(true);
        if !moved && !resized {
            continue;
        }
        conn.execute(
            "UPDATE grid_boxes SET pos_x = ?1, pos_y = ?2, width = ?3, height = ?4, \
             updated_at = ?5 WHERE id = ?6",
            params![rect.x, rect.y, rect.w, rect.h, now_iso(), id],
        )
        .map_err(|err| format!("摆放格子失败：{err}"))?;
        if moved {
            outcome.moved += 1;
        }
        if resized {
            outcome.resized += 1;
        }
    }
    if !overflowed_names.is_empty() {
            // V66：正常路径**不该再出现**这一行 —— 列式填满会先压列高（到 `MIN_BOX_H` 为止）
            // 把内容收进一屏。只有「格子多到连最小高度都摞不下」才会真越界，那时交给前端
            // 收纳区那层 `overflow-y-auto`。记日志是为了在真机上能一眼看出「确实超载了」。
        grid_log(&format!(
            "收纳区超出一屏（格子数超过一屏容量，前端可滚动），越过下边界的格子：{}",
            overflowed_names.join("、")
        ));
    }

    // —— V56：**绝不把挂件留在屏幕外 / 压在工作台上** ——
    //
    // 真机 09-20 日志：「收纳区空间不足，被顶出屏幕的格子：新格子 14」—— 它被排到
    // `y > work_h` 的位置，用户既看不见也够不着；格子又没被删除，于是变成一个幽灵
    // （而用户此时正抱怨「格子拖不动」，等于连救回来的手段都没有）。
    //
    // ⚠️ V63：这一步**只对挂件（便签）生效**了。收纳格不再走它 —— 统一网格越过下边界是
    // 「放不下就滚动」的正常态（前端那层 `overflow-y-auto` 会滚），把它们夹回可见区反而会
    // 让最后一行几个格子**叠在同一个 y 上**（那才是真的坏了）。
    //
    // V60：工作台占的是**右侧整列**，所以「抬到它上面」已经不可能（它顶到天花板了）——
    // 改成**横向让开**：夹到工作台左沿之左。
    let wst = workstation_rect(work_w, work_h);
    let mut clamped: Vec<String> = Vec::new();
    for r in load_box_rects(conn)?.iter().filter(|r| r.is_widget()) {
        let max_x = (right_edge - r.w).max(min_x);
        let max_y = (work_h - ARRANGE_MARGIN - r.h).max(ARRANGE_MARGIN);
        let nx = r.x.clamp(min_x, max_x);
        let ny = r.y.clamp(ARRANGE_MARGIN, max_y);
        let nx = if ny < wst.y + wst.h && wst.y < ny + r.h && nx < wst.x + wst.w && wst.x < nx + r.w
        {
            (wst.x - ARRANGE_GAP_X - r.w).max(min_x)
        } else {
            nx
        };
        if nx == r.x && ny == r.y {
            continue;
        }
        conn.execute(
            "UPDATE grid_boxes SET pos_x = ?1, pos_y = ?2, updated_at = ?3 WHERE id = ?4",
            params![nx, ny, now_iso(), r.id],
        )
        .map_err(|err| format!("拉回越界格子失败：{err}"))?;
        clamped.push(format!("{} ({},{})→({},{})", r.name, r.x, r.y, nx, ny));
    }
    if !clamped.is_empty() {
        grid_log(&format!("已把越界格子拉回可见区：{}", clamped.join("；")));
    }

    grid_log(&format!(
        "整理布局（{}）：工作区 {work_w}×{work_h}，挂件带左界 {band_left}（挂件 {} 个），\
         收纳区 {} 个格子按内容定尺寸 + 列式填满（可用 {}×{}，排成 {} 列，占高 {}）/ \
         带下空间 {} / 挪动 {} 个 / 改尺寸 {} 个 / 挂件归位 {} 个 / 用户位置序 {} 个 / \
         超出一屏 {} 个 / 未归类 {loose_count} 个",
        if mode == LayoutMode::Full {
            "全量重置"
        } else {
            "增量补齐"
        },
        widget_rects.len(),
        plan.slots.len(),
        zone_w,
        zone_h,
        plan.column_count(),
        plan.total_height(),
        match band_b {
            // 「有多少个格子落在挂件带下方」比「有没有这条带」有用得多：它是「空间真的用上了」
            // 的直接证据（用户 09-22 要的就是这一条）。
            Some(b) => format!(
                "{}×{}@({},{})，落位 {} 个",
                b.w,
                b.h,
                b.x,
                b.y,
                plan.slots.iter().filter(|s| s.x >= b.x && s.y >= b.y).count()
            ),
            None => "无".to_string(),
        },
        outcome.moved,
        outcome.resized,
        outcome.anchored,
        manual_cells,
        outcome.overflowed,
    ));
    Ok(outcome)
}


fn existing_standard_width(conn: &Connection, work_w: i64) -> i64 {
    let Ok(rows) = load_box_rects(conn) else {
        return ARRANGE_BOX_W;
    };
    let icon = desktop_icon_size_cached();
    standard_box_width(
        rows.iter()
            .filter(|r| !r.is_widget())
            .map(|r| desired_box_width(r.items, icon)),
        work_w,
    )
}


/// 一键整理结果摘要（前端据此提示「登记了几个条目、建了几个格子、挪了几个格子」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoArrangeReport {
    /// **两个桌面根**（用户桌面 + 公共桌面）扫描到的可见条目数（含快捷方式 / 文件夹）
    pub scanned: usize,
    /// 本次登记进格子的条目数（V37 起**只登记，不移动文件**）
    pub items_added: usize,
    /// 其中文件夹占的数量
    pub folders_moved: usize,
    /// 本次登记里快捷方式（`.lnk`）占的数量 —— V42 起**恒为 0**
    /// （快捷方式不再进格子，改由左侧「未归类」竖条展示）
    pub lnk_added: usize,
    /// V42：本次扫描里**没进格子**、留在左侧竖条的条目数（快捷方式 + 系统入口 + 落单）
    pub left_over: usize,
    /// V43：本次**放开**了多少个此前被「移出」拦下的路径
    ///
    /// 非 0 说明用户之前手动挪出去过一些东西，这次点整理把它们重新收回来了 ——
    /// 前端要如实提示，否则用户会以为「怎么又自己跑回来了」（真机库里实测 13 条）。
    pub released: usize,
    /// V42：本次解散掉的历史「系统」/「快捷方式」格数量
    pub dissolved_boxes: usize,
    /// V42：本次从各格子里摘掉的快捷方式 / 系统入口登记条数（只删登记，文件不动）
    pub dissolved_items: usize,
    /// 本次新建的格子数
    pub boxes_created: usize,
    /// 复用了同名已有格子的次数
    pub boxes_reused: usize,
    /// 按规则跳过的条目数
    ///
    /// V40 起恒为 0：历史收纳容器 `Handy整理*` 不再跳过（V37 起整理不移动任何文件，
    /// 当年「容器不进格子」的前提已消失，而跳过它们会让桌面永远留着几个不进格子的文件夹）。
    /// 字段保留是为了前后端契约稳定，前端文案已不再依赖它。
    pub skipped: usize,
    /// 本次被重新排布的格子数（V38：整理会**全量重排**，不只摆新格子）
    pub boxes_laid_out: usize,
    /// 按内容量调整过尺寸的格子数（V39）
    pub boxes_resized: usize,
    /// 被归位到锚点的挂件数（V39：日历 → 右上角，便签 → 左下角）
    pub widgets_anchored: usize,
    /// 桌面空间不足、只能压在别人身上的格子数（正常恒为 0；非 0 时前端要如实提示）
    pub boxes_overflowed: usize,
    /// 整理后系统桌面图标是否已由格子层接管（true = 原生图标已隐藏）
    pub icons_hidden: bool,
    /// 单条目失败原因（不中断整批，前端原样展示给用户）
    pub failures: Vec<String>,
}

/// 把扫描结果归入「格子名」；`None` = **这一项不进格子**，留在左侧竖条里。
///
/// V42 起 `.lnk` 一律不进格子（用户原话：「不整理的和快捷方式别整理到格子了，他们就是
/// 自动在桌面左上角从上往下排开即可，不需要放到格子里面，没有必要」）。
///
/// 这里要和 V38 的决定对照着看，才知道为什么现在能这么改：
/// V38 之所以反过来把 `.lnk` 塞进格子，是因为**整理会隐藏系统桌面图标，而当时没有任何
/// 地方能显示它们** —— 不登记就等于快捷方式当场消失。V42 补上了左侧「未归类」竖条
/// （[`loose_strip_rect`]，前端按纯图标渲染），快捷方式有了自己的展示位，前提再次成立：
/// 不登记 → 出现在竖条里 → 看得见、点得开、还能随时拖进格子。
fn arrange_group_of(item: &crate::commands::organizer::OrganizerItem) -> Option<String> {
    if item.is_lnk {
        return None;
    }
    if item.is_dir {
        return Some("文件夹".to_string());
    }
    if item.category.is_empty() {
        return Some("其他".to_string());
    }
    Some(item.category.clone())
}

/// 分组展示顺序：文件夹最前，「其他」最后，其余按扩展名类别居中。
fn arrange_group_rank(name: &str) -> i64 {
    match name {
        "文件夹" => 0,
        "其他" => 3,
        _ => 2,
    }
}

/// 清掉「不该进格子」的登记与格子（V42）—— 每次整理都跑一遍，幂等。
///
/// 两件事：
///   ① **把快捷方式 / 系统入口的登记从所有格子里摘掉**（含用户手工拖进去的）——
///      用户要的是「快捷方式别整理到格子」，留一两个在格子里就不算做到；
///   ② **解散「系统」「快捷方式」这两个专用格**（V41 建的）—— 它们空了还占着位置，
///      而且名字本身就在暗示「快捷方式该在格子里」，与 V42 的规则冲突。
///
/// 只删 `grid_items` 登记行与空的格子行 —— **文件本体一个字节都不动**（V37 呈现层模型）。
/// 返回 `(解散的格子数, 摘掉的登记数)`，进日志。
fn dissolve_auto_boxes(conn: &Connection) -> Result<(usize, usize), String> {
    let removed_items = conn
        .execute(
            // `::` 开头 = shell 命名空间（此电脑 / 回收站 / 用户的文件）；`.lnk` 不区分大小写
            "DELETE FROM grid_items \
             WHERE file_path LIKE '::%' OR lower(file_path) LIKE '%.lnk'",
            [],
        )
        .map_err(|err| format!("摘除快捷方式 / 系统登记失败：{err}"))?;
    let removed_boxes = conn
        .execute(
            "DELETE FROM grid_boxes \
             WHERE kind = 'system' OR name = '快捷方式' OR category = '快捷方式'",
            [],
        )
        .map_err(|err| format!("解散「系统」/「快捷方式」格失败：{err}"))?;
    Ok((removed_boxes, removed_items))
}

/// 系统入口：Explorer **恒定显示**、磁盘上没有对应文件的桌面入口。
///
/// 路径是 shell 命名空间 CLSID，`grid_open_path` 用 `ShellExecuteW` 直接打开；
/// `list_live_items` 对 `::` 开头显式豁免存在性校验（否则会被当成失效登记清掉）。
///
/// V42 起它们**不再进「系统」格**（用户原话：「我们系统图标如我的电脑等不主动整理」），
/// 而是排在左侧「未归类」竖条的最前面（见 [`loose_desktop_items`]）。于是
/// `grid_boxes` 里不再有 `kind = 'system'` 的格子，[`dissolve_auto_boxes`] 负责清掉
/// 历史遗留的那些。
const SYSTEM_ENTRIES: [(&str, &str); 3] = [
    ("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}", "此电脑"),
    ("::{645FF040-5081-101B-9F08-00AA002F954E}", "回收站"),
    ("::{59031A47-3F72-44A7-89C5-5595FE6B30EE}", "用户的文件"),
];

/// 一键归类核心（连接与桌面根目录由调用方给定）。
///
/// V37 起重写为**只登记、不移动**：
///   - 用户否掉了 V33–V36 的「真实收纳」——「是桌面整理不是让你把桌面上的东西都给我
///     移动到一个目录下面去」。现在扫到的条目只是在格子里**登记一条引用**，
///     文件本体一个字节都不动；
///   - **文件夹照样归类**（只跳过自己的历史收纳容器）：用户实测「文件夹的整理根本都不生效」，
///     根因是早期这里把 `is_dir` 整个跳过 —— 「文件夹」格因此永远是空的；
///   - **快捷方式也归类**（V38）：整理后原生图标会被格子层接管，跳过 `.lnk` 会让
///     用户桌面上的程序快捷方式当场消失；
///   - **历史收纳容器也归类**（V40）：V37 起不会再有移动，`Handy整理*` 只是普通文件夹；
///   - **两个桌面根都扫**（V40）：用户桌面 + 公共桌面（`%PUBLIC%\Desktop`），
///     后者那批「所有用户」快捷方式以前从来没进过格子；
///   - **全量重排**（V38）：所有收纳格重新按左起流布局摆放，见 [`layout_all_boxes`]。
///
/// `work_width` / `work_height` 是工作区（挂件窗）的逻辑尺寸；<= 0 时各自退回
/// 1280 / 720。
fn auto_arrange_inner(
    conn: &Connection,
    roots: &[PathBuf],
    work_width: i64,
    work_height: i64,
) -> Result<AutoArrangeReport, String> {
    use std::collections::HashMap;

    // 两个桌面根合并成一份待归类清单（每个条目自带绝对路径，后续登记用的是它们的真实位置）
    let mut scanned: Vec<crate::commands::organizer::OrganizerItem> = Vec::new();
    let mut root_failures: Vec<String> = Vec::new();
    for root in roots {
        match crate::commands::organizer::scan_items(root) {
            Ok(mut items) => scanned.append(&mut items),
            Err(err) => {
                grid_log(&format!("扫描桌面根失败（{}）：{err}", root.display()));
                root_failures.push(format!("{}：{err}", root.display()));
            }
        }
    }
    let total_scanned = scanned.len();

    // 已有格子：名称 → id（新格子按类别名复用同名格子）
    let mut existing: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name FROM grid_boxes ORDER BY sort ASC, id ASC")
            .map_err(|err| format!("读取格子失败：{err}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| format!("读取格子失败：{err}"))?;
        for row in rows {
            let (id, name) = row.map_err(|err| format!("读取格子失败：{err}"))?;
            existing.insert(name, id);
        }
    }

    // 按类别分组（文件夹 / 快捷方式各自一组，其余按扩展名类别）
    //
    // V40：**不再跳过桌面上遗留的 `Handy整理*` 目录**。V38–V39 跳过它们，理由是
    // 「自己的收纳容器永不参与（V36 事故根源）」—— 但那次事故的成因是 `fs::rename` +
    // 递归复制兜底，而 V37 起整理**一个字节都不移动**（只登记引用），前提已经不成立。
    // 一直跳过，桌面上就永远有这么几个文件夹不在任何格子里 ——
    // 用户原话：「你看桌面上面那么多文件文件夹都没有整理好呢」。
    // 它们现在按普通文件夹进「文件夹」格；要收回/清理走「诊断与修复」（按前缀识别）。
    //
    // —— V43：**先释放「不要它」名单，再分组登记** ——
    //
    // 用户原话：「我重新整理了为什么还是没有重新把桌面上零散的目录和文件重新整理呢？」
    // 根因就在这张名单上：`grid_item_delete`（拖出格子 / 移出）为了「别让下一次整理
    // 又把它拉回来」，会把路径写进 `sync_dismissed`；而它是**只增不减**的 ——
    // 用户手动挪出去过的 `_Work` / `software` / `测试` / `dify` / `1.log` /
    // `skills.tar.gz` / `集合竞价.pdf` 等，此后无论点多少次「整理桌面」都不会再进格子，
    // 只能永远堆在左侧竖条里（真机库里实测攒了 13 条）。
    //
    // 语义上「一键整理桌面」= 用户**显式要求把当前桌面重新算一遍**。此时该尊重的是
    // *桌面现状*，而不是*历史的手动移出*。所以这里把名单整个清掉；名单本身保留给
    // 后台对账用（刚拖出去的东西在下次「整理」之前不会被自动塞回来）。
    let released = release_dismissed(conn)?;

    let mut grouped: Vec<(String, Vec<usize>)> = Vec::new();
    // V42：`arrange_group_of` 返回 `None` 的条目**不进格子**（快捷方式），它们会在
    // 左侧「未归类」竖条里按类型顺序排开 —— 数一下进回报，前端好如实告诉用户。
    let mut left_over = 0usize;
    for (index, item) in scanned.iter().enumerate() {
        let Some(key) = arrange_group_of(item) else {
            left_over += 1;
            continue;
        };
        match grouped.iter_mut().find(|(name, _)| *name == key) {
            Some((_, bucket)) => bucket.push(index),
            None => grouped.push((key, vec![index])),
        }
    }
    grouped.sort_by_key(|(name, _)| arrange_group_rank(name));

    // V55：少于 2 个条目的非核心类别合并进「其他」，节省格子空间
    // 核心类别（文件夹、图片、文档、压缩包、安装包、媒体）即使只有 1 项也保留
    const CORE_CATEGORIES: &[&str] = &["文件夹", "图片", "文档", "压缩包", "安装包", "媒体"];
    let mut final_grouped: Vec<(String, Vec<usize>)> = Vec::new();
    let mut other_extra: Vec<usize> = Vec::new();
    for (name, indices) in grouped {
        if indices.len() < 2 && name != "其他" && !CORE_CATEGORIES.contains(&name.as_str()) {
            other_extra.extend(indices);
        } else {
            final_grouped.push((name, indices));
        }
    }
    if !other_extra.is_empty() {
        match final_grouped.iter_mut().find(|(n, _)| n == "其他") {
            Some((_, list)) => list.extend(other_extra),
            None => final_grouped.push(("其他".to_string(), other_extra)),
        }
    }
    final_grouped.sort_by_key(|(name, _)| arrange_group_rank(name));
    let grouped = final_grouped;

    let mut report = AutoArrangeReport {
        scanned: total_scanned,
        items_added: 0,
        folders_moved: 0,
        lnk_added: 0,
        left_over: 0,
        released: 0,
        dissolved_boxes: 0,
        dissolved_items: 0,
        boxes_created: 0,
        boxes_reused: 0,
        skipped: 0,
        boxes_laid_out: 0,
        boxes_resized: 0,
        widgets_anchored: 0,
        boxes_overflowed: 0,
        icons_hidden: false,
        failures: root_failures,
    };

    for (label, indices) in grouped {
        if indices.is_empty() {
            continue;
        }
        let box_id: i64 = match existing.get(&label) {
            Some(id) => {
                report.boxes_reused += 1;
                *id
            }
            None => {
                let now = now_iso();
                // 落点先给个临时值 —— 循环结束后统一全量重排（layout_all_boxes），
                // 这样「新建的」和「复用的」格子会被同一套流布局摆整齐，
                // 而不是新格子按槽位、旧格子留在当年的老坐标上各说各话。
                let sort = next_sort(
                    conn,
                    "SELECT COALESCE(MAX(sort) + 1, 0) FROM grid_boxes",
                    None,
                )?;
                conn.execute(
                    "INSERT INTO grid_boxes \
                     (name, kind, category, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                     VALUES (?1, 'folder', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        label,
                        label,
                        ARRANGE_MARGIN,
                        ARRANGE_MARGIN,
                        ARRANGE_BOX_W,
                        ARRANGE_BOX_H,
                        sort,
                        now,
                        now,
                    ],
                )
                .map_err(|err| format!("创建格子「{label}」失败：{err}"))?;
                let id = conn.last_insert_rowid();
                existing.insert(label.clone(), id);
                report.boxes_created += 1;
                id
            }
        };

        for index in indices {
            let Some(item) = scanned.get(index) else {
                continue;
            };
            // 只登记引用 —— 文件留在桌面原处，一个字节都不动
            match register_item(conn, box_id, Path::new(&item.path), &item.name) {
                Ok(true) => {
                    report.items_added += 1;
                    if item.is_dir {
                        report.folders_moved += 1;
                    }
                    if item.is_lnk {
                        report.lnk_added += 1;
                    }
                }
                Ok(false) => {}
                Err(err) => report.failures.push(format!("{}：{err}", item.name)),
            }
        }
    }

    // 先摘掉「不该进格子」的登记并解散「系统」/「快捷方式」两个专用格（V42，幂等）。
    // 放在登记之前：否则这一步会把本次刚登记进去的快捷方式又摘一遍（结果虽一样，
    // 但 `items_added` 的语义会变成「登记了多少又摘了多少」，用户看着莫名其妙）。
    let (dissolved_boxes, dissolved_items) = dissolve_auto_boxes(conn)?;
    report.dissolved_boxes = dissolved_boxes;
    report.dissolved_items = dissolved_items;
    report.left_over = left_over;
    report.released = released;

    // **增量补齐**（V48，用户口径：「普通整理保留用户已有布局，只是将散落的需要整理的
    // 其他内容归纳到格子即可」）——已经摆好的格子一个都不动，只安置本次新建的
    // 以及「重叠 / 越界」的格子；想按我们的规则重排得走「重新重置整理」。
    let outcome = layout_all_boxes(conn, work_width, work_height, layout_icon_size(), LayoutMode::Fill)?;
    report.boxes_laid_out = outcome.moved;
    report.boxes_resized = outcome.resized;
    report.widgets_anchored = outcome.anchored;
    report.boxes_overflowed = outcome.overflowed;

    grid_log(&format!(
        "一键整理：扫到 {} 项（{} 个桌面根），登记 {} 项（文件全部原地未动，含文件夹 {}），\
         未归类留在左侧竖条 {} 项；放开此前移出的 {} 项 / 解散旧格 {} 个 / 摘除快捷方式与系统登记 {} 条；\
         格子新建 {} / 复用 {} / 重排 {} / 按内容调尺寸 {} / 挂件归位 {} / 空间不足 {}，失败 {}",
        report.scanned,
        roots.len(),
        report.items_added,
        report.folders_moved,
        report.left_over,
        report.released,
        report.dissolved_boxes,
        report.dissolved_items,
        report.boxes_created,
        report.boxes_reused,
        report.boxes_laid_out,
        report.boxes_resized,
        report.widgets_anchored,
        report.boxes_overflowed,
        report.failures.len()
    ));
    Ok(report)
}

/// 排布用的桌面图标尺寸（逻辑像素）。
///
/// 单独包一层是为了**让纯逻辑的单测可以在任何平台跑**：`desktop_icon_size_cached()`
/// 只在 Windows 上有实现（要读注册表），非 Windows 给一个默认值即可 ——
/// 尺寸算法本身与平台无关，不该因为平台门锁而没法测。
#[cfg(target_os = "windows")]
fn layout_icon_size() -> i64 {
    desktop_icon_size_cached()
}

#[cfg(not(target_os = "windows"))]
fn layout_icon_size() -> i64 {
    32
}

/// 布局可用的逻辑尺寸 `(宽, 高)`。
///
/// 优先用挂件窗自身的尺寸 —— 格子的 `pos_x/pos_y` 本来就是**相对挂件窗客户区**的，
/// 拿显示器尺寸去算会在「窗口没铺满屏幕」时把格子推到窗口外面。
/// **优先**取主显示器工作区（实时真源）；只有问不到显示器时才退回归宿到窗口尺寸。
///
/// V83 把顺序倒了过来。以前是「窗口尺寸优先、显示器兜底」，理由是「窗口就是桌面」——
/// 但**接/拔显示器那一刻**窗口尺寸可能还是旧的（`sync_overlay_bounds` 晚一拍），
/// 于是会先按错尺寸排一次、再重排一次，用户看到格子抖一下。布局本来就该以**主屏**
/// 为准（窗口只是它的呈现载体，两者最终必然相等），所以问不到主屏时才退回窗口。
///
/// V38 补上高度：排布改成「一列自上而下摆满再往左推一列」之后，**没有高度就算不出
/// 一列能放几个**，格子在纵向会越排越出去（用户实测截图里就是一路排到桌面底部之外）。
fn layout_work_size(app: &AppHandle) -> (i64, i64) {
    // V83：**先问主显示器工作区**（真源），再退回窗口尺寸 —— 理由见函数头。
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        if scale > 0.0 {
            let area = monitor.work_area();
            if area.size.width > 0 && area.size.height > 0 {
                return (
                    (f64::from(area.size.width) / scale).round() as i64,
                    (f64::from(area.size.height) / scale).round() as i64,
                );
            }
        }
    }
    if let Some(win) = app.get_webview_window(GRID_LABEL) {
        if let (Ok(size), Ok(scale)) = (win.inner_size(), win.scale_factor()) {
            if scale > 0.0 && size.width > 0 && size.height > 0 {
                return (
                    (f64::from(size.width) / scale).round() as i64,
                    (f64::from(size.height) / scale).round() as i64,
                );
            }
        }
    }
    (1280, 720)
}

/// 一键整理桌面 —— 「桌面整理」模块的主入口（工具栏的整理按钮也走这里）。
///
/// 一次点击做完五件事（用户原话：「每次点击整理桌面，应该重新计算桌面所有的内容，
/// 按照分类排开」）：
///   ① **重新扫一遍桌面**（用户桌面 + 公共桌面，全量重算，不受上次结果影响）；
///   ② 按类型分组的**只登记引用**：文件夹 / 图片 / 文档 / 压缩包 / 安装包 / 其他 ——
///      文件一个字节都不动（V37 呈现层模型）；
///   ③ **快捷方式与系统入口不进格子**（V42）：它们排在左侧「未归类」竖条里，
///      按 系统 → 快捷方式 → 文件夹 → 其他 的顺序自上而下；同时**摘掉**历史遗留在
///      各格子里的快捷方式 / 系统登记，并解散 V41 建的「系统」「快捷方式」两个专用格；
///   ④ **全量重排**所有格子：统一列宽 + 高度按内容撑开（默认不出滚动条）+
///      **镜像流布**（自最右一列向左，挂件先占右上角，分类格从它下面接着排）；
///   ⑤ **隐藏系统桌面图标**（接管）—— 桌面呈现此后完全由格子层 + 左侧竖条负责，
///      同一份内容不会再显示两遍。这一步的偏好记在 `grid_meta.desktop_takeover`，
///      收起挂件 / 退出应用都会立刻把图标还给系统；工具栏的「接管图标」开关可随时切回共存。
///
/// `dir` 仅供测试 / 自定义目录，缺省为用户桌面。
#[tauri::command]
pub async fn grid_auto_arrange(
    app: AppHandle,
    dir: Option<String>,
) -> Result<AutoArrangeReport, String> {
    // 显式传目录时只扫它（指定目录用）；否则扫「用户桌面 + 公共桌面」两个根（V40）
    let roots: Vec<PathBuf> = match dir {
        Some(value) if !value.trim().is_empty() => vec![PathBuf::from(value.trim())],
        _ => desktop_roots(),
    };
    let conn = connect(&app)?;
    let (work_w, work_h) = layout_work_size(&app);
    let mut report = auto_arrange_inner(&conn, &roots, work_w, work_h)?;

    // 「整理桌面」= 用户明确要求桌面由格子呈现 ⇒ **一律按接管偏好执行**。
    //
    // ⚠️ V38–V39 这里写的是「只有真的往里登记了东西才接管」，本意是「空跑一次不该顺手把
    // 用户的图标藏了」。但用户的桌面早就全部登记过了（每次整理都是「登记 0 项」），
    // 于是**点整理根本不接管** —— 这正是他反馈「桌面原图标还存在呢？」的代码路径。
    //
    // 但有一道闸必须留着：**挂件层没在显示时不许藏图标**。否则（用户在管理页点整理、
    // 而格子层是收起状态）会把桌面图标藏掉却没有任何格子顶上来，桌面直接变空白 ——
    // 那是 V30.1 踩过的坑，比「两份内容」严重得多。
    if read_overlay_visible(&app) {
        if let Err(err) = write_takeover(&app, true) {
            grid_log(&format!("保存桌面接管偏好失败：{err}"));
        }
        report.icons_hidden = takeover_icons(&app, true);
        if !report.icons_hidden {
            grid_log("接管桌面失败（未找到系统桌面图标视图），格子与原生图标将同时显示");
        }
    } else {
        grid_log("挂件层未显示，本次整理不改动系统桌面图标（先显示格子再整理才会接管）");
    }
    Ok(report)
}

/// **只重排、不扫描**（V47；V48 改成「增量补齐」口径）。
///
/// 「一键整理」会扫桌面并登记文件，语义太重，不适合「刚加了个便签」这种场合；
/// 但加完挂件又**必须**让布局跑一次，否则新挂件就停在 `grid_box_upsert` 的默认坐标上。
///
/// 真实事故（V47 用户截图）：16:17 连加两个便签，它们落在 (32,32) 与 (32,276) ——
/// 正好压在左侧「不整理」竖条那条**禁区**上，用户看到的是「便签糊在快捷方式上面，
/// 位置很不合适」。
///
/// V48 起本命令按 [`LayoutMode::Fill`] 走：**只安置还没落位的格子**（新建的、重叠的、
/// 越界的），用户自己摆好的格子原地不动 —— 用户原话「普通整理保留用户已有布局」。
#[tauri::command]
pub async fn grid_relayout(app: AppHandle) -> Result<(), String> {
    let conn = connect(&app)?;
    let (work_w, work_h) = layout_work_size(&app);
    let outcome = layout_all_boxes(&conn, work_w, work_h, layout_icon_size(), LayoutMode::Fill)?;
    grid_log(&format!(
        "重排（不扫描·增量）：挪动 {} 个 / 按内容调整 {} 个尺寸 / 挂件归位 {} 个 / 空间不足 {} 个",
        outcome.moved, outcome.resized, outcome.anchored, outcome.overflowed
    ));
    Ok(())
}

/// **重新重置整理**（V48 新增）：按 Handy 自己的分区规则把整张桌面重排一遍。
///
/// 与 [`grid_relayout`] 的唯一区别就是口径 —— 用户原话：
/// 「如果用户自己调整了那么记录用户自己的改变，**除非后面用户重新重置整理**，
/// 我们又按照我们自己的规律整理」。所以只有这条路径会覆盖用户的手工摆放。
#[tauri::command]
pub async fn grid_layout_reset(app: AppHandle) -> Result<(), String> {
    let conn = connect(&app)?;
    let (work_w, work_h) = layout_work_size(&app);
    let outcome = layout_all_boxes(&conn, work_w, work_h, layout_icon_size(), LayoutMode::Full)?;
    grid_log(&format!(
        "重置整理（全量）：挪动 {} 个 / 按内容调整 {} 个尺寸 / 挂件归位 {} 个 / 空间不足 {} 个",
        outcome.moved, outcome.resized, outcome.anchored, outcome.overflowed
    ));
    Ok(())
}

/// 对账全部收纳格：按磁盘目录补齐新出现的文件、清掉已消失的登记。
///
/// 返回 `(参与对账的收纳格数, 补登记数, 清理数)`。
fn reconcile_all_boxes(conn: &Connection) -> Result<(usize, usize, usize), String> {
    let boxes: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM grid_boxes ORDER BY sort ASC, id ASC")
            .map_err(|err| format!("读取格子失败：{err}"))?;
        let mapped = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|err| format!("读取格子失败：{err}"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("读取格子失败：{err}"))?
    };

    let mut counted = 0usize;
    let mut pruned = 0usize;
    for box_id in boxes {
        counted += 1;
        let before: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM grid_items WHERE box_id = ?1",
                params![box_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let live = list_live_items(conn, box_id)?.len();
        pruned += (before.max(0) as usize).saturating_sub(live);
    }
    Ok((counted, 0, pruned))
}

/// 桌面同步报告（V33 起 sync = **只对账，不收录**）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSyncReport {
    /// 参与对账的收纳格数
    pub boxes: usize,
    /// 收纳目录里新发现并登记的条目数（含用户在资源管理器里手工放进格子的文件）
    pub items_added: usize,
    /// 清理掉的失效登记数（文件已被移出 / 删除）
    pub pruned: usize,
}

/// Shell 图标数据（RGBA 像素，base64；前端转 dataURL 渲染）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIconData {
    pub width: u32,
    pub height: u32,
    /// RGBA 像素（逐行、每像素 4 字节）的 base64
    pub rgba_base64: String,
}

/// 手写 base64（避免为一个编码器引入依赖；输入 ≤ 32×32×4 字节，性能无感）。
fn b64_encode(data: &[u8]) -> String {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).map_or(0, |v| u32::from(*v));
        let b2 = chunk.get(2).map_or(0, |v| u32::from(*v));
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TBL[(n >> 18) as usize & 63] as char);
        out.push(TBL[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TBL[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TBL[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// 提取文件 / 文件夹的 Shell 真实图标（32×32），转 RGBA 后 base64 返回。
///
/// 「接管桌面」的观感关键：格子里渲染**系统真实图标**（与资源管理器一致，
/// .lnk 自动解析为目标图标），而不是通用线条图标 —— 用户一眼认出「这是我的文件」。
/// 失败返回 None，前端回退通用图标；先查桌面再查其他路径，绝不做任何写操作。
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn grid_file_icon(path: String) -> Result<Option<FileIconData>, String> {
    // SHGetFileInfo 会触达磁盘与图标缓存，放阻塞线程池避免占用 async 运行时
    tauri::async_runtime::spawn_blocking(move || extract_icon_rgba(&path))
        .await
        .map_err(|err| format!("图标提取任务失败：{err}"))
}

/// 非 Windows 平台暂不支持 Shell 图标提取，前端回退通用图标。
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn grid_file_icon(_path: String) -> Result<Option<FileIconData>, String> {
    Ok(None)
}

/// SHGetFileInfo → GetIconInfo → GetDIBits 的完整提取链（Windows）。
///
/// 外壳负责 COM 生命周期：`.lnk` 快捷方式的图标解析走 shell 命名空间，
/// 阻塞线程池的线程默认没有 COM —— 不初始化的话文件夹图标能出、快捷方式全失败
/// （V30.1 实测：格子里的 .lnk 全是回退图标）。
#[cfg(target_os = "windows")]
fn extract_icon_rgba(path: &str) -> Option<FileIconData> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    unsafe {
        // 已初始化（模式不同）也不报错，沿用现态即可
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    let result = extract_icon_rgba_impl(path);
    unsafe {
        CoUninitialize();
    }
    result
}

/// 提取链本体（调用方需保证本线程已初始化 COM）。
///
/// 取图标做成三级，越靠前越像桌面：
///   ① 系统图像列表 `SHIL_EXTRALARGE` = **48×48** —— 与桌面 / 资源管理器的
///      「中等图标」同尺寸；
///   ② 退到 `SHGetFileInfoW` 的 `SHGFI_LARGEICON` = 32×32；
///   ③ 全失败返回 `None`，由前端回退通用线条图标。
///
/// 三级都带 `SHGFI_LINKOVERLAY | SHGFI_ADDOVERLAYS` —— 这是用户那句「整理到格子里
/// 面的图标样式都变了」的正解：不带叠层标志时拿到的是**基础图标**，`.lnk` 会丢掉
/// 左下角那个小箭头，于是同一个快捷方式在桌面上和格子里长得不一样。
#[cfg(target_os = "windows")]
fn extract_icon_rgba_impl(path: &str) -> Option<FileIconData> {
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    let icon = shell_icon_handle(path)?;
    let result = icon_to_rgba(icon);
    // SAFETY: icon 是本函数刚取得的 HICON 所有权，用完即销毁
    unsafe {
        let _ = DestroyIcon(icon);
    }
    result
}

/// 取一个「跟资源管理器一样」的图标句柄（优先 48×48）。
#[cfg(target_os = "windows")]
fn shell_icon_handle(path: &str) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ADDOVERLAYS, SHGFI_ICON, SHGFI_LARGEICON,
        SHGFI_LINKOVERLAY, SHGFI_SYSICONINDEX,
    };

    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // ⓪ shell 命名空间（`::{CLSID}`，如「此电脑 / 回收站 / 用户的文件」）：
    //    `SHGetFileInfoW` 把它当**文件路径**解析，必然失败 —— 必须先
    //    `SHParseDisplayName` 拿到 PIDL，再带 `SHGFI_PIDL` 求图标。
    //    V38 新增「系统」格时才发现这条分支缺失（此前格子只装真实文件路径）。
    if path.starts_with("::") {
        return virtual_shell_icon(&wide);
    }

    // ① 系统大图标列表（48×48）
    let mut sfi = SHFILEINFOW::default();
    let info_ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut sfi as *mut SHFILEINFOW as *mut _),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX | SHGFI_LINKOVERLAY | SHGFI_ADDOVERLAYS,
        )
    };
    if info_ok != 0 {
        // 用户把桌面图标调大过（Ctrl+滚轮）时 48 那档会被拉糊 —— 那就先取 256 那档。
        // 只在确有必要时才要 JUMBO：256×256 RGBA 转 base64 约 350 KB，一个格子
        // 二十个图标就是 7 MB，白白拖慢首屏（用户 V37 反馈「图标应该跟桌面一样大」）。
        if desktop_icon_size_cached() > 64 {
            if let Some(icon) = image_list_icon(sfi.iIcon, SHIL_JUMBO) {
                return Some(icon);
            }
        }
        if let Some(icon) = image_list_icon(sfi.iIcon, SHIL_EXTRALARGE) {
            return Some(icon);
        }
    }

    // ② 退到 32×32 大图标（叠层照旧要）
    let mut fallback = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut fallback as *mut SHFILEINFOW as *mut _),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON | SHGFI_LINKOVERLAY | SHGFI_ADDOVERLAYS,
        )
    };
    if ok == 0 || fallback.hIcon.is_invalid() {
        return None;
    }
    Some(fallback.hIcon)
}

/// shell 命名空间条目（`::{CLSID}`）的图标：字符串 → PIDL → 系统图像列表。
///
/// 失败一律 `None`（前端回退线条图标）—— 取不到图标不该阻断格子显示。
#[cfg(target_os = "windows")]
fn virtual_shell_icon(wide: &[u16]) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHParseDisplayName, SHFILEINFOW, SHGFI_PIDL, SHGFI_SYSICONINDEX,
    };

    // SAFETY: 入参是 NUL 结尾的宽字符串；SHParseDisplayName 分配的 PIDL 归调用方，
    // 用完 `CoTaskMemFree` 释放（Windows 规定的配对方式）。
    unsafe {
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        if SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None).is_err()
            || pidl.is_null()
        {
            return None;
        }
        let mut sfi = SHFILEINFOW::default();
        let ok = SHGetFileInfoW(
            PCWSTR(pidl as *const u16),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut sfi as *mut SHFILEINFOW as *mut _),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX | SHGFI_PIDL,
        );
        CoTaskMemFree(Some(pidl as *const std::ffi::c_void));
        if ok == 0 {
            return None;
        }
        if desktop_icon_size_cached() > 64 {
            if let Some(icon) = image_list_icon(sfi.iIcon, SHIL_JUMBO) {
                return Some(icon);
            }
        }
        image_list_icon(sfi.iIcon, SHIL_EXTRALARGE)
    }
}

/// `SHIL_EXTRALARGE`：系统图像列表里 48×48 的那一档（`SHGetImageList` 的索引值）。
#[cfg(target_os = "windows")]
const SHIL_EXTRALARGE: i32 = 2;

/// `SHIL_JUMBO`：系统图像列表里 256×256 的那一档（Vista 起可用）。
///
/// 只有当系统桌面图标尺寸被调大到 > 64px 时才值得取它 —— 否则纯属浪费带宽
/// （见 [`shell_icon_handle`] 的说明）。
#[cfg(target_os = "windows")]
const SHIL_JUMBO: i32 = 4;

/// 从系统图像列表取出第 `index` 个图标。
///
/// 为什么要绕这一道：`SHGetFileInfoW` 只给 32×32（`SHGFI_LARGEICON`）；要拿到桌面
/// 「中等图标」那种 48×48，只能进系统图像列表取。
///
/// windows-rs 0.58 把 `SHGetImageList` 包成了泛型返回（`Result<T>`），不再需要手写
/// IID —— 这里显式标注 `IImageList` 让类型推导落地。系统图像列表是进程内共享对象，
/// `SHGetImageList` 已加过引用计数，由 `IImageList` 自身负责释放，不泄漏。
///
/// 另注：0.58 的 `IImageList::GetIcon(i, flags) -> Result<HICON>` 是**返回值**式签名
/// （老版本是 `&mut HICON` 出参），`flags` 要裸 `u32`，所以 `ILD_TRANSPARENT` 取 `.0`。
#[cfg(target_os = "windows")]
fn image_list_icon(index: i32, size: i32) -> Option<windows::Win32::UI::WindowsAndMessaging::HICON> {
    use windows::Win32::UI::Controls::{IImageList, ILD_TRANSPARENT};
    use windows::Win32::UI::Shell::SHGetImageList;

    // SAFETY: 系统图像列表由 shell 维护、进程内共享；取出的 HICON 归调用方所有。
    unsafe {
        let list: IImageList = match SHGetImageList(size) {
            Ok(value) => value,
            Err(_) => return None,
        };
        match list.GetIcon(index, ILD_TRANSPARENT.0) {
            Ok(icon) if !icon.is_invalid() => Some(icon),
            _ => None,
        }
    }
}

/// `HICON` → RGBA 像素（统一处理 alpha 通道与 BGRA→RGBA 换序）。
#[cfg(target_os = "windows")]
fn icon_to_rgba(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<FileIconData> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    unsafe {
        let mut info = ICONINFO::default();
        if GetIconInfo(hicon, &mut info).is_err() {
            return None;
        }
        let hdc = CreateCompatibleDC(None);
        if hdc.is_invalid() {
            let _ = DeleteObject(info.hbmMask).ok();
            let _ = DeleteObject(info.hbmColor).ok();
            return None;
        }

        let read_bitmap = |hbm: HBITMAP, bit_count: u16| -> Option<Vec<u8>> {
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            // 第一次调用不取像素，只回填尺寸信息
            GetDIBits(hdc, hbm, 0, 0, None, &mut bmi, DIB_RGB_COLORS);
            let w = bmi.bmiHeader.biWidth;
            if w <= 0 {
                return None;
            }
            let h = bmi.bmiHeader.biHeight.unsigned_abs();
            bmi.bmiHeader.biHeight = -bmi.bmiHeader.biHeight; // top-down
            bmi.bmiHeader.biBitCount = bit_count;
            bmi.bmiHeader.biCompression = 0u32; // BI_RGB
            let stride = ((w as usize * bit_count as usize + 31) / 32) * 4;
            let mut buf = vec![0u8; stride * h as usize];
            let lines = GetDIBits(
                hdc,
                hbm,
                0,
                h,
                Some(buf.as_mut_ptr() as *mut _),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            if lines == 0 {
                return None;
            }
            Some(buf)
        };

        let color = read_bitmap(info.hbmColor, 32);
        let mask = if color.is_some() {
            read_bitmap(info.hbmMask, 1)
        } else {
            None
        };
        let _ = DeleteDC(hdc).ok();
        let _ = DeleteObject(info.hbmMask).ok();
        let _ = DeleteObject(info.hbmColor).ok();
        let mut color = color?;

        let w = (color.len() / 4).max(1);
        // GetDIBits 给的是 BGRA 且多为自下而上（biHeight 已取负转 top-down 后即按行序），
        // 交换 R/B 到 RGBA；全零 alpha（老式无 alpha 通道图标）用掩码位补齐。
        let all_transparent = color.chunks_exact(4).all(|px| px[3] == 0);
        for (index, px) in color.chunks_exact_mut(4).enumerate() {
            px.swap(0, 2);
            if all_transparent {
                let x = index % w;
                let byte = mask.as_ref().and_then(|m| m.get(x / 8)).copied().unwrap_or(0);
                let opaque = (byte >> (7 - (x % 8))) & 1 == 0; // 0 = 不透明
                px[3] = if opaque { 255 } else { 0 };
            }
        }

        let side = (w as f64).sqrt().round() as u32;
        let (width, height) = if w > 0 && side * side == w as u32 {
            (side, side)
        } else {
            (w as u32, 1)
        };
        Some(FileIconData {
            width,
            height,
            rgba_base64: b64_encode(&color),
        })
    }
}

/// 桌面同步 —— 格子层的数据引擎（前端周期调用）：**只对账，不收录**。
///
/// V33 起这里不再「自动把桌面文件收进格子」—— 那正是用户抱怨「和桌面原图标
/// 完全重复、像复制了一份」的来源。现在只做一件事：按磁盘目录对账每个收纳格 ——
/// 用户在资源管理器里手工放进格子的文件会补登记，被移走 / 删除的会清掉登记。
///
/// V34 去掉了「兜底建系统格子」。此电脑 / 回收站是 Explorer **恒定显示**的桌面
/// 入口，不受任何桌面工具控制，格子里那份纯属重复（用户截图里两个「我的电脑」
/// 并排）；用户明确说「系统这个不需要」。已存在的系统格由迁移 v7 清掉。
///
/// 想批量收纳桌面文件，走显式的「一键收纳」（`grid_auto_arrange`），它**真移动**文件。
#[tauri::command]
pub async fn grid_desktop_sync(app: AppHandle) -> Result<DesktopSyncReport, String> {
    let conn = connect(&app)?;
    let (boxes, added, pruned) = reconcile_all_boxes(&conn)?;
    Ok(DesktopSyncReport {
        boxes,
        items_added: added,
        pruned,
    })
}

/// 布局文件里的单条引用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutItem {
    pub file_path: String,
    pub display_name: String,
    pub sort: i64,
}

/// 布局文件里的单个格子。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutBox {
    pub name: String,
    pub pos_x: i64,
    pub pos_y: i64,
    pub width: i64,
    pub height: i64,
    pub sort: i64,
    pub items: Vec<LayoutItem>,
}

/// 桌面布局快照（备份文件的内容；`version` 供将来结构升级时判断兼容性）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayout {
    pub version: i64,
    pub exported_at: String,
    pub boxes: Vec<LayoutBox>,
}

/// 布局还原结果摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutImportReport {
    pub boxes: usize,
    pub items: usize,
    /// 快照里指向的文件当前已不存在（引用仍会恢复，打开时才提示 —— 不静默丢弃）
    pub missing_files: usize,
}

/// 组装当前布局快照（内部原语：导出到文件与「备份到本机」共用）。
fn build_layout(conn: &Connection) -> Result<GridLayout, String> {
    let box_rows: Vec<GridBox> = {
        let sql = format!(
            "SELECT {BOX_COLUMNS}, \
             (SELECT COUNT(*) FROM grid_items i WHERE i.box_id = b.id) AS item_count \
             FROM grid_boxes b ORDER BY b.sort ASC, b.id ASC"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| format!("导出布局失败：{err}"))?;
        // 分两步绑定：`mapped` 必须比 `stmt` 后声明（drop 顺序倒过来），
        // 否则借用中的迭代器会先于语句被释放 —— E0597。
        let mapped = stmt
            .query_map([], row_to_box_with_count)
            .map_err(|err| format!("导出布局失败：{err}"))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("导出布局失败：{err}"))?
    };

    let mut boxes: Vec<LayoutBox> = Vec::with_capacity(box_rows.len());
    for row in box_rows {
        let mut stmt = conn
            .prepare(
                "SELECT file_path, display_name, sort FROM grid_items \
                 WHERE box_id = ?1 ORDER BY sort ASC, id ASC",
            )
            .map_err(|err| format!("导出布局失败：{err}"))?;
        let items = stmt
            .query_map(params![row.id], |item| {
                Ok(LayoutItem {
                    file_path: item.get(0)?,
                    display_name: item.get(1)?,
                    sort: item.get(2)?,
                })
            })
            .map_err(|err| format!("导出布局失败：{err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("导出布局失败：{err}"))?;
        boxes.push(LayoutBox {
            name: row.name,
            pos_x: row.pos_x,
            pos_y: row.pos_y,
            width: row.width,
            height: row.height,
            sort: row.sort,
            items,
        });
    }

    Ok(GridLayout {
        version: 1,
        exported_at: now_iso(),
        boxes,
    })
}

/// 把一份布局快照落到库里（**替换式**：先清空现有格子，再按快照重建）。
///
/// 调用方 `grid_layout_restore` 会先把当前布局另存为「还原前自动备份」，
/// 因此这一步虽是破坏性的，但始终有回退路径。
fn apply_layout(conn: &mut Connection, layout: &GridLayout) -> Result<LayoutImportReport, String> {
    if layout.version != 1 {
        return Err(format!(
            "布局快照版本不受支持（{0}，当前支持 1）",
            layout.version
        ));
    }

    let tx = conn
        .transaction()
        .map_err(|err| format!("还原布局失败：{err}"))?;

    // 清空（grid_items 由外键 ON DELETE CASCADE 级联，这里显式删两遍更直观）
    tx.execute("DELETE FROM grid_items", [])
        .map_err(|err| format!("清空旧条目失败：{err}"))?;
    tx.execute("DELETE FROM grid_boxes", [])
        .map_err(|err| format!("清空旧格子失败：{err}"))?;

    let created = now_iso();
    let mut item_total = 0usize;
    let mut missing = 0usize;

    for (index, entry) in layout.boxes.iter().enumerate() {
        tx.execute(
            "INSERT INTO grid_boxes \
             (name, pos_x, pos_y, width, height, sort, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                clean_name(Some(entry.name.clone())),
                entry.pos_x,
                entry.pos_y,
                entry.width.max(160),
                entry.height.max(120),
                if entry.sort != 0 { entry.sort } else { index as i64 },
                created,
                created,
            ],
        )
        .map_err(|err| format!("还原格子「{}」失败：{err}", entry.name))?;
        let box_id = tx.last_insert_rowid();

        for (item_index, item) in entry.items.iter().enumerate() {
            if !std::path::Path::new(&item.file_path).exists() {
                missing += 1;
            }
            tx.execute(
                "INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    box_id,
                    item.file_path,
                    item.display_name,
                    if item.sort != 0 { item.sort } else { item_index as i64 },
                    created,
                ],
            )
            .map_err(|err| format!("还原条目「{}」失败：{err}", item.display_name))?;
            item_total += 1;
        }
    }

    tx.commit()
        .map_err(|err| format!("提交布局还原失败：{err}"))?;

    Ok(LayoutImportReport {
        boxes: layout.boxes.len(),
        items: item_total,
        missing_files: missing,
    })
}

/// 导出当前桌面布局快照（供「导出到文件 / 分享给别人」等外部通道使用）。
#[tauri::command]
pub async fn grid_layout_export(app: AppHandle) -> Result<GridLayout, String> {
    let conn = connect(&app)?;
    build_layout(&conn)
}

/// 用一份外部布局快照覆盖当前布局（替换式；调用方需自行确认）。
#[tauri::command]
pub async fn grid_layout_import(
    app: AppHandle,
    layout: GridLayout,
) -> Result<LayoutImportReport, String> {
    let mut conn = connect(&app)?;
    apply_layout(&mut conn, &layout)
}

// ————————————————————————————————————————————————————————————————
// 布局快照（备份 / 还原布局）
//
// 存 `grid_meta`：`key = "layout:<uuid>"`，`value = 快照 JSON`。
// 之所以不落成文件：备份/还原本就是「同一台机器上两种桌面摆放方式来回切」，
// 放库里既省一次文件对话框，也天然跟着数据库备份走（见 commands/backup.rs）。
// ————————————————————————————————————————————————————————————————

/// `grid_meta` 中布局快照的键前缀。
const META_KEY_LAYOUT_PREFIX: &str = "layout:";

/// 还原前自动备份使用的固定 id（幂等覆盖，不随还原次数堆积）。
const LAYOUT_AUTO_BACKUP_ID: &str = "auto-before-restore";

/// 布局快照摘要（列表用；不带完整 layout，省往返体积）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSnapshotMeta {
    pub id: String,
    pub name: String,
    pub saved_at: String,
    pub box_count: usize,
    pub item_count: usize,
}

/// 落库的快照完整内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutSnapshot {
    id: String,
    name: String,
    saved_at: String,
    layout: GridLayout,
}

/// 快照 → 摘要。
fn snapshot_meta(snapshot: &LayoutSnapshot) -> LayoutSnapshotMeta {
    LayoutSnapshotMeta {
        id: snapshot.id.clone(),
        name: snapshot.name.clone(),
        saved_at: snapshot.saved_at.clone(),
        box_count: snapshot.layout.boxes.len(),
        item_count: snapshot
            .layout
            .boxes
            .iter()
            .map(|box_item| box_item.items.len())
            .sum(),
    }
}

/// 写入一份快照（同 id 覆盖）。
fn save_snapshot(conn: &Connection, snapshot: &LayoutSnapshot) -> Result<(), String> {
    let value = serde_json::to_string(snapshot)
        .map_err(|err| format!("序列化布局快照失败：{err}"))?;
    conn.execute(
        "INSERT INTO grid_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![format!("{META_KEY_LAYOUT_PREFIX}{}", snapshot.id), value],
    )
    .map_err(|err| format!("保存布局快照失败：{err}"))?;
    Ok(())
}

/// 读一份快照（不存在返回中文错误）。
fn load_snapshot(conn: &Connection, snapshot_id: &str) -> Result<LayoutSnapshot, String> {
    let key = format!("{META_KEY_LAYOUT_PREFIX}{snapshot_id}");
    let raw: String = conn
        .query_row(
            "SELECT value FROM grid_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .map_err(|_| format!("找不到布局快照（{snapshot_id}）"))?;
    serde_json::from_str(&raw).map_err(|err| format!("解析布局快照失败：{err}"))
}

/// 把当前桌面布局备份成一份本机快照。
#[tauri::command]
pub async fn grid_layout_save(
    app: AppHandle,
    name: Option<String>,
) -> Result<LayoutSnapshotMeta, String> {
    let conn = connect(&app)?;
    let layout = build_layout(&conn)?;
    let saved_at = now_iso();
    let label = match name {
        Some(raw) if !raw.trim().is_empty() => raw.trim().to_string(),
        _ => format!("布局 {saved_at}"),
    };
    let snapshot = LayoutSnapshot {
        id: uuid::Uuid::new_v4().to_string(),
        name: label,
        saved_at,
        layout,
    };
    save_snapshot(&conn, &snapshot)?;
    Ok(snapshot_meta(&snapshot))
}

/// 列出全部布局快照（按保存时间倒序；含「还原前自动备份」）。
#[tauri::command]
pub async fn grid_layout_list(app: AppHandle) -> Result<Vec<LayoutSnapshotMeta>, String> {
    let conn = connect(&app)?;
    let mut stmt = conn
        .prepare("SELECT value FROM grid_meta WHERE key LIKE ?1")
        .map_err(|err| format!("读取布局快照失败：{err}"))?;
    let rows = stmt
        .query_map(params![format!("{META_KEY_LAYOUT_PREFIX}%")], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| format!("读取布局快照失败：{err}"))?;

    let mut metas: Vec<LayoutSnapshotMeta> = Vec::new();
    for row in rows {
        let raw = row.map_err(|err| format!("读取布局快照失败：{err}"))?;
        // 单条解析失败只跳过这一条，不让一份坏数据废掉整个列表
        if let Ok(snapshot) = serde_json::from_str::<LayoutSnapshot>(&raw) {
            metas.push(snapshot_meta(&snapshot));
        }
    }
    metas.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(metas)
}

/// 从某份快照还原布局（替换式）。
///
/// **还原前自动备份**：先把当前布局另存为「还原前自动备份」（固定 id，覆盖式），
/// 于是「还原错了」也能再还原回来 —— 破坏性操作必须有回退路径。
#[tauri::command]
pub async fn grid_layout_restore(
    app: AppHandle,
    snapshot_id: String,
) -> Result<LayoutImportReport, String> {
    let mut conn = connect(&app)?;
    let snapshot = load_snapshot(&conn, &snapshot_id)?;

    // 自动备份当前布局（失败不阻断还原：这是「额外保险」，不是前置条件）
    if let Ok(current) = build_layout(&conn) {
        let auto = LayoutSnapshot {
            id: LAYOUT_AUTO_BACKUP_ID.to_string(),
            name: "还原前自动备份".to_string(),
            saved_at: now_iso(),
            layout: current,
        };
        let _ = save_snapshot(&conn, &auto);
    }

    apply_layout(&mut conn, &snapshot.layout)
}

/// 删除一份布局快照。
#[tauri::command]
pub async fn grid_layout_delete(app: AppHandle, snapshot_id: String) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute(
            "DELETE FROM grid_meta WHERE key = ?1",
            params![format!("{META_KEY_LAYOUT_PREFIX}{snapshot_id}")],
        )
        .map_err(|err| format!("删除布局快照失败：{err}"))?;
    if affected == 0 {
        return Err("布局快照不存在或已被删除".to_string());
    }
    Ok(())
}

/// Z 序纵深判据的回归。
///
/// 这条判据是本项目历史上**错过两次**的地方（V33 放宽周期、V34 收紧周期都是围绕它打转），
/// 而且它的失效方式特别隐蔽：判据错了不会报错，只会「每秒重排一次」——
/// 用户看到的是「格子一直闪、有时又出来」，代码里看不出任何异常。
/// 所以这里把判据的**语义**钉住，改的时候必须让这些断言仍然成立。
// —— V37：遗留收纳目录的还原与清理 ——
//
// V33–V36 的「真实收纳」把用户的桌面文件搬进了 `桌面/Handy整理/<容器>/`；V36 那次
// 事故还在桌面上留下 4 个副本（合计约 195 GB、最深 704 层 / 4961 字符路径）。
// 收纳模型既然已经改回「引用」，这些残留就必须能安全地撤回桌面 —— 而且**先给用户看清
// 将要发生什么**（`dry_run`），再动手。

/// 一个遗留收纳根目录的概况（还原前的预览用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRootInfo {
    /// 目录名（`Handy整理` / `Handy整理 (2)` …）
    pub name: String,
    /// 绝对路径
    pub path: String,
    /// 将被上提回桌面的条目数（第一层容器的直接子项）
    pub entries: usize,
    /// 目录内条目总数（含嵌套垃圾，用于展示规模）
    pub total_entries: usize,
    /// 其中「自己套自己」的嵌套垃圾条目数
    pub nested_entries: usize,
    /// 占用字节数
    pub bytes: u64,
    /// 是否因条目上限被截断（真 ⇒ `total_entries` / `nested_entries` / `bytes` 都是**下界**）
    pub truncated: bool,
}

/// 还原报告。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimReport {
    /// 上提回桌面的条目数
    pub moved: usize,
    /// 因桌面已有同名而跳过的条目数
    pub skipped: usize,
    /// 失败的条目（名称 + 原因）
    pub failures: Vec<String>,
    /// 处理过的遗留目录数
    pub roots: usize,
    /// 是否只是预演（true = 没动任何文件）
    pub dry_run: bool,
}

/// 清理报告。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    /// 已删除（或预演将删除）的遗留目录数
    pub removed: usize,
    /// 释放（或预计释放）的字节数
    pub freed_bytes: u64,
    /// 因「还有条目没撤回桌面」而放弃删除的目录
    pub skipped: Vec<String>,
    /// 删除失败的目录
    pub failures: Vec<String>,
    /// 是否只是预演
    pub dry_run: bool,
}

/// 列出桌面上的遗留收纳目录（**只读**，不碰任何文件）。
#[tauri::command]
pub async fn grid_legacy_scan() -> Result<Vec<LegacyRootInfo>, String> {
    let desktop = desktop_root()?;
    Ok(scan_legacy_roots(&desktop))
}

/// 扫描桌面上的 `Handy整理*` / `Handy收纳*` 目录并统计。
fn scan_legacy_roots(desktop: &Path) -> Vec<LegacyRootInfo> {
    let Ok(entries) = std::fs::read_dir(desktop) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_storage_entry(&name) {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let (total_entries, nested_entries, bytes, truncated) = walk_stats(&path);
        out.push(LegacyRootInfo {
            name,
            path: path.to_string_lossy().to_string(),
            entries: collect_reclaimable(&path).len(),
            total_entries,
            nested_entries,
            bytes,
            truncated,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 收集某个遗留根里「该上提回桌面」的条目：`<容器>/<条目>` → 条目。
///
/// 容器本身是 Handy 建的（「文档」「图片」「新格子 3」…），用户的原始条目在它下面一层。
/// 容器内若出现同名收纳容器，那是 V36 递归复制炸出来的垃圾，**不算条目**（交给清理）。
fn collect_reclaimable(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let Ok(containers) = std::fs::read_dir(root) else {
        return out;
    };
    let mut sorted: Vec<std::fs::DirEntry> = containers.flatten().collect();
    sorted.sort_by_key(|entry| entry.file_name());
    for container in sorted {
        let Ok(file_type) = container.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(kids) = std::fs::read_dir(container.path()) else {
            continue;
        };
        for kid in kids.flatten() {
            let name = kid.file_name().to_string_lossy().to_string();
            if is_storage_entry(&name) {
                continue; // 嵌套垃圾，不参与上提
            }
            out.push((name, kid.path()));
        }
    }
    out
}

/// 单棵树最多统计多少条目 —— 事故现场实测 **129,714 条 / 296 GB**，全量走一遍要一到两分钟。
///
/// 而 `grid_legacy_scan` 是**打开格子管理页就自动跑**的（用户不会先点按钮再等），
/// 一旦全量遍历，页面看起来就是「卡死」。所以必须封顶：超了就把 `truncated` 置真，
/// 界面显示「≥ N」——用户要的结论是「确实还有巨量残留、该清理了」，不是精确到个位。
const MAX_WALK_ENTRIES: usize = 10_000;

/// 统计一棵树的 `(条目总数, 嵌套垃圾数, 字节数, 是否被上限截断)`。
///
/// 显式栈遍历，1001 层也不会爆栈（实测最深 1001 层 / 路径 7082 字符 —— 递归写法在这里必炸）。
fn walk_stats(root: &Path) -> (usize, usize, u64, bool) {
    let mut total = 0usize;
    let mut nested = 0usize;
    let mut bytes = 0u64;
    let mut truncated = false;
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    'outer: while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if total >= MAX_WALK_ENTRIES {
                truncated = true;
                break 'outer;
            }
            total += 1;
            let name = entry.file_name().to_string_lossy().to_string();
            if is_storage_entry(&name) {
                nested += 1;
            }
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => stack.push(entry.path()),
                Ok(_) => bytes += entry.metadata().map(|meta| meta.len()).unwrap_or(0),
                Err(_) => {}
            }
        }
    }
    (total, nested, bytes, truncated)
}

/// 把遗留收纳目录里的条目**上提回桌面根**（文件只移动，**绝不删除**）。
///
/// 规则：`Handy整理/<容器>/<条目>` → `桌面/<条目>`。
///
/// - **桌面已有同名就跳过**：4 个副本的内容已验证是主目录的子集，跳过可避免把同一个
///   文件搬回来两遍（也就不必让用户去清理一堆 `xxx (2)`）；
/// - `dry_run = true`（默认）只统计不落盘，UI 先给用户看数字再执行；
/// - 嵌套垃圾不参与上提，留给 [`grid_legacy_cleanup`] 整体删除。
#[tauri::command]
pub async fn grid_legacy_reclaim(dry_run: Option<bool>) -> Result<ReclaimReport, String> {
    let dry = dry_run.unwrap_or(true);
    let desktop = desktop_root()?;
    let roots = scan_legacy_roots(&desktop);
    let mut report = ReclaimReport {
        moved: 0,
        skipped: 0,
        failures: Vec::new(),
        roots: roots.len(),
        dry_run: dry,
    };
    for info in &roots {
        let root = PathBuf::from(&info.path);
        for (name, path) in collect_reclaimable(&root) {
            if desktop.join(&name).exists() {
                report.skipped += 1;
                continue;
            }
            if dry {
                report.moved += 1;
                continue;
            }
            match move_with_conflict_rename(&path, &desktop) {
                Ok(_) => report.moved += 1,
                Err(err) => report.failures.push(format!("{name}：{err}")),
            }
        }
    }
    if !dry {
        grid_log(&format!(
            "还原遗留收纳：上提 {} 项回桌面，跳过 {} 项（桌面已有同名），失败 {} 项",
            report.moved,
            report.skipped,
            report.failures.len()
        ));
    }
    Ok(report)
}

/// 删除遗留收纳目录（含最深 704 层的嵌套垃圾）。
///
/// ⚠️ 这是**真的删目录**，所以有两道闸：
///   ① `dry_run` 默认 true，UI 必须先给用户看「删几个、释放多少」；
///   ② 每个目录删除前检查：只要里面还有「桌面上找不到同名」的条目，就**跳过不删**并
///      报出来 —— 宁可少删，也绝不允许把用户还没撤回的文件清掉。
#[tauri::command]
pub async fn grid_legacy_cleanup(dry_run: Option<bool>) -> Result<CleanupReport, String> {
    let dry = dry_run.unwrap_or(true);
    let desktop = desktop_root()?;
    let roots = scan_legacy_roots(&desktop);
    let mut report = CleanupReport {
        removed: 0,
        freed_bytes: 0,
        skipped: Vec::new(),
        failures: Vec::new(),
        dry_run: dry,
    };
    for info in &roots {
        let root = PathBuf::from(&info.path);
        let leftovers: Vec<String> = collect_reclaimable(&root)
            .into_iter()
            .filter(|(name, _)| !desktop.join(name).exists())
            .map(|(name, _)| name)
            .collect();
        if !leftovers.is_empty() {
            report.skipped.push(format!(
                "{}：还有 {} 个条目没撤回桌面（{}），已跳过",
                info.name,
                leftovers.len(),
                leftovers.join("、")
            ));
            continue;
        }
        if dry {
            report.removed += 1;
            report.freed_bytes += info.bytes;
            continue;
        }
        match remove_tree_deep(&root) {
            Ok(()) => {
                report.removed += 1;
                report.freed_bytes += info.bytes;
            }
            Err(err) => report.failures.push(format!("{}：{err}", info.name)),
        }
    }
    if !dry {
        grid_log(&format!(
            "清理遗留收纳目录：删除 {} 个，释放约 {} 字节，跳过 {} 个，失败 {} 个",
            report.removed,
            report.freed_bytes,
            report.skipped.len(),
            report.failures.len()
        ));
    }
    Ok(report)
}

/// 删除一棵可能极深的目录树（事故造出过 **1001 层 / 7082 字符**的路径）。
///
/// 显式栈 + 后序删除：不递归（不会爆栈），每层都交给 `std::fs` 处理 —— Rust 在 Windows
/// 上会为路径补 `\\?\` 前缀，因此超过 `MAX_PATH` 也能删。
fn remove_tree_deep(root: &Path) -> Result<(), String> {
    let mut pending: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut dirs: Vec<PathBuf> = Vec::new();
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            // 读不动就交给后面的 remove_dir 报准确错误
            dirs.push(dir);
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(file_type) if file_type.is_dir() => pending.push(path),
                _ => std::fs::remove_file(&path)
                    .map_err(|err| format!("删除文件失败（{}）：{err}", path.display()))?,
            }
        }
        dirs.push(dir);
    }
    // 后序：`dirs` 里父在子之前，倒着删才是「先子后父」
    for dir in dirs.into_iter().rev() {
        std::fs::remove_dir(&dir)
            .map_err(|err| format!("删除目录失败（{}）：{err}", dir.display()))?;
    }
    Ok(())
}

// —— V37：桌面图标度量（让格子内图标与系统桌面同样大小） ——

/// 桌面图标的度量。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconMetrics {
    /// 图标边长（逻辑像素）
    pub icon_size: i64,
    /// 图标横向间距（逻辑像素；0 = 没读到，前端按比例推）
    pub spacing: i64,
    /// 值从哪来：`registry` / `control-panel` / `default`（排查用）
    pub source: String,
}

/// 读系统桌面的图标尺寸，让格子内图标与原生桌面视觉一致。
///
/// 用户 V37 反馈「格子里面的图标大小应该跟正常桌面大小保持一致」。桌面图标尺寸存在
/// `HKCU\Software\Microsoft\Windows\Shell\Bags\1\Desktop` 的 `IconSize`（用户按
/// `Ctrl + 滚轮` 调桌面图标大小时 Windows 就改写它）。取不到再退到控制面板的
/// `Shell Icon Size`（默认 32），仍然取不到用 48。
///
/// 用 `reg query` 而不是注册表 API：只读一次，不必为此新增 windows crate feature。
#[tauri::command]
pub async fn desktop_icon_metrics() -> Result<IconMetrics, String> {
    use std::sync::atomic::Ordering;

    // 冷启动时记一次：这个数字决定格子图标渲染多大，是「图标怎么跟我桌面不一样大」
    // 这类反馈的**第一现场**。用户回传 handy.log 时能直接看到探测结果与来源。
    let cold = DESKTOP_ICON_SIZE.load(Ordering::Relaxed) == 0;
    let metrics = detect_icon_metrics();
    if cold {
        grid_log(&format!(
            "桌面图标尺寸探测：{}px（间距 {}，来源 {}）—— 格子图标与提取分辨率按此对齐",
            metrics.icon_size, metrics.spacing, metrics.source
        ));
    }
    Ok(metrics)
}

/// 探测实现（与命令分开，方便日志复用与将来加单测）。
fn detect_icon_metrics() -> IconMetrics {
    #[cfg(target_os = "windows")]
    {
        if let Some(size) = read_desktop_icon_size() {
            let spacing = reg_query_value(
                r"HKCU\Software\Microsoft\Windows\Shell\Bags\1\Desktop",
                "IconSpacing",
            )
            .and_then(|raw| parse_reg_int(&raw))
            .filter(|value| (16..=1024).contains(value))
            .unwrap_or(0);
            return IconMetrics {
                icon_size: size,
                spacing,
                source: "registry".to_string(),
            };
        }
    }
    IconMetrics {
        icon_size: 48,
        spacing: 0,
        source: "default".to_string(),
    }
}

/// 读桌面图标边长（同步读注册表；可能拉起一次 `reg` 子进程，调用方自行缓存）。
///
/// 只看两个位置：① 桌面 Bags 的 `IconSize`（用户按 `Ctrl + 滚轮` 改的就是它）；
/// ② 控制面板的 `Shell Icon Size`（老式通用设置）。都取不到返回 `None`。
#[cfg(target_os = "windows")]
fn read_desktop_icon_size() -> Option<i64> {
    if let Some(size) = reg_query_value(
        r"HKCU\Software\Microsoft\Windows\Shell\Bags\1\Desktop",
        "IconSize",
    )
    .and_then(|raw| parse_reg_int(&raw))
    {
        if (16..=512).contains(&size) {
            return Some(size);
        }
    }
    let fallback = reg_query_value(
        r"HKCU\Control Panel\Desktop\WindowMetrics",
        "Shell Icon Size",
    )
    .and_then(|raw| parse_reg_int(&raw))?;
    (16..=512).contains(&fallback).then_some(fallback)
}

/// 图标尺寸缓存（0 = 还没读过）。图标提取是逐条热路径，不能每次都拉起 `reg` 子进程。
#[cfg(target_os = "windows")]
static DESKTOP_ICON_SIZE: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// 带缓存的桌面图标尺寸（读不到按 48）。
#[cfg(target_os = "windows")]
fn desktop_icon_size_cached() -> i64 {
    use std::sync::atomic::Ordering;
    let cached = DESKTOP_ICON_SIZE.load(Ordering::Relaxed);
    if cached != 0 {
        return cached;
    }
    let size = read_desktop_icon_size().unwrap_or(48);
    DESKTOP_ICON_SIZE.store(size, Ordering::Relaxed);
    size
}

/// 读一个注册表值的原始文本（`reg query <key> /v <name>` 输出的最后一列）。
#[cfg(target_os = "windows")]
fn reg_query_value(key: &str, name: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("reg")
        .args(["query", key, "/v", name])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with(name) {
            continue;
        }
        // `    IconSize    REG_DWORD    0x30` → 取最后一段（值名本身可能含空格）
        return trimmed.split_whitespace().last().map(str::to_string);
    }
    None
}

/// `0x30` / `48` 都能解析。
#[cfg(target_os = "windows")]
fn parse_reg_int(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    match trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        Some(hex) => i64::from_str_radix(hex, 16).ok(),
        None => trimmed.parse::<i64>().ok(),
    }
}

#[cfg(all(test, target_os = "windows"))]
mod z_verdict_tests {
    use super::*;
    use std::ffi::c_void;

    /// 造一个假句柄（只用于比较，不会交给系统 API）
    fn h(value: usize) -> HWND {
        HWND(value as *mut c_void)
    }

    #[test]
    fn desktop_directly_below_is_the_ideal_case() {
        let host = h(1);
        assert_eq!(
            classify_chain(&[host], host, false),
            ZVerdict::InDesktopBand
        );
    }

    #[test]
    fn interlopers_between_us_and_desktop_are_not_a_mismatch() {
        // ★ 这条就是 V35 修的核心缺陷。
        // 桌面正上方那一格是公共地段：搜狗输入法的 6 个隐藏助手窗、本应用主窗
        // 都会停在这儿。旧判据要求「正下方必须**正好**是桌面」，于是一出现邻居
        // 就判错位 ⇒ 每秒纠一次、永远纠不完 ⇒ 用户看到「一直闪」。
        // 现在只要往下走一段能碰到桌面就算对。
        let host = h(1);
        let chain = [h(0x708d4), h(0x2f0b72), h(0x1035a), host];
        assert_eq!(classify_chain(&chain, host, false), ZVerdict::InDesktopBand);
    }

    #[test]
    fn walking_to_the_bottom_without_finding_desktop_means_we_are_below_it() {
        // 被压在桌面下面 = 用户看到的「格子不见了」，必须纠正
        let host = h(1);
        let chain = [h(9), h(8)];
        assert_eq!(classify_chain(&chain, host, true), ZVerdict::BelowDesktop);
    }

    #[test]
    fn many_windows_above_us_means_we_are_too_high() {
        // 走满扫描预算还没碰到桌面 ⇒ 被顶得很高（会盖住别的窗口），也要纠正
        let host = h(1);
        let chain: Vec<HWND> = (100..100 + REASSERT_SCAN_STEPS).map(h).collect();
        assert_eq!(chain.len(), REASSERT_SCAN_STEPS);
        assert_eq!(classify_chain(&chain, host, false), ZVerdict::TooHigh);
    }

    #[test]
    fn empty_chain_at_bottom_is_below_desktop() {
        let host = h(1);
        assert_eq!(classify_chain(&[], host, true), ZVerdict::BelowDesktop);
    }

    #[test]
    fn scan_budget_is_big_enough_for_a_busy_desktop_edge() {
        // 保险丝不能因为「邻居多了几个」就误判成 TooHigh —— 给足余量。
        assert!(
            REASSERT_SCAN_STEPS >= 12,
            "桌面正上方是公共地段，扫描预算太小会把正常邻居算成「被顶得很高」"
        );
        // 纠正必须有上限，否则一旦判据与现实不符就是无限重排（= 一直闪）
        assert!(REASSERT_MAX_FIXES >= 1 && REASSERT_MAX_FIXES <= 10);
        // 自检节奏必须是时间量（毫秒），不能跟着轮询周期走（V35 的教训）
        assert!(REASSERT_INTERVAL_MS >= 1);
    }

    #[test]
    fn band_insurance_recovers_fast() {
        // V46：用户诉求「不管什么情况，只要是桌面都无条件显示整理」——
        // **恢复延迟就等于用户看到的故障时长**，所以这三个数字是产品指标，
        // 不是随手调的参数。改动它们之前先回看 DESKTOP-LAYER §2.4。
        //
        // 检测间隔（V48 起是毫秒量）：用户 09-19 的验收标准是「Win+D 之后
        // 跟正常桌面一样，直接就能看到内容」——超过半秒就会被看出来。
        assert!(
            REASSERT_INTERVAL_MS <= 500,
            "Z 序 / 接管检测间隔过长，Win+D 之后用户会看到「桌面空着」或「两份图标」持续存在"
        );
        // 而且不能退化成「每拍都查」（那会把 25ms 的轮询变成窗口 API 风暴）
        assert!(
            REASSERT_INTERVAL_MS >= 100,
            "自检太密会变成窗口 API 风暴，与轮询周期解耦才有意义"
        );
        // 退避：旧值 300 秒是本轮修掉的核心缺陷（一次故障 = 5 分钟无自愈）。
        // 上界给 15 秒：既要避免疯狂重排，又不允许长时间放弃自愈。
        assert!(
            (1..=15).contains(&REASSERT_GIVEUP_BACKOFF_SECS),
            "退避时间必须短到用户察觉不到：太长等于长时间放弃自愈"
        );
        // 「显示态却不可见」的捞回宽限：1 秒上下。
        assert!(
            (10..=200).contains(&VISIBLE_RECOVER_TICKS),
            "捞回宽限应约 1 秒（POLL_INTERVAL_MS=25 时 = 40 tick）"
        );
        // 日志限流不能把「第一次故障」也吃掉：否则事后无从定位夹层。
        assert!(Z_LOG_INTERVAL_SECS >= 10);
    }
}

/// 排布规则（`FlowPlacer` / 列宽统一 / 内容驱动尺寸 / 挂件锚点）。
///
/// 用户 V38 原话：「点击整理桌面后格子是自动创建了 但是很乱，没有计算桌面合理的
/// 规划格子位置 流布局结构」；V39：「应该根据每个格子里面内容多少自动调整大小，
/// 格子自动流式布局，防止位置，日历默认放在右上角」；V40：「你要合理计算，让格子对齐
/// 整齐哇，宽度对齐，整理排列，流布局等，高度根据图标多少自动撑开」。
///
/// 这些断言把「整齐」钉成**可复算**的东西 —— 否则下次改任何一个排布参数，
/// 「很乱」都会悄悄回来。
///
/// 刻意**不依赖 Windows API**（只用到纯几何与尺寸函数），所以在任何平台上都能跑。
#[cfg(test)]
mod flow_placer_tests {
    use super::{
        auto_box_size, box_height_at, box_own_size, box_width_for_columns, column_bottom,
        column_capacity, content_plan, content_zone_right, desired_box_width, fit_column_heights,
        bounds_need_fix,
        content_plan_with_lower_band, is_content_kind, own_sizes, pack_columns, placement_order,
        ContentPlan,
        item_columns_at, loose_cell_size,
        loose_strip_rect, needs_placement, place_widget_columns, standard_box_width,
        widget_zone, workstation_rect, zone_single_column, FlowPlacer, GridBoxRect, SlotRect,
        WidgetZone,         ARRANGE_BOX_W, ARRANGE_GAP_X, ARRANGE_GAP_Y, ARRANGE_MARGIN, AUTO_MAX_COLS,
        AUTO_MAX_W,
        BOX_BORDER_H, CALENDAR_BOX_W, WST_BOX_W,
        BOX_CELL_EXTRA_H, BOX_FIT_SLACK, BOX_HEADER_H, CELL_EXTRA_W, GRID_GAP, GRID_PAD_X,
        GRID_PAD_Y, GRID_SCROLLBAR_W,
        MIN_BOX_H, MIN_BOX_W,
    };

    /// 没有挂件时的挂件带左界（= 工作区右沿）—— `needs_placement` 的硬右界参数。
    const NO_WIDGET_BAND: i64 = WORK_W - ARRANGE_MARGIN;

    /// V83：**「差 1–2px 算已对齐」这条容差必须成立** —— 它是「显示器几何对齐」不死循环的开关。
    ///
    /// 非整数缩放（125% / 150% / 175%）下，`SetWindowPos` 写进去的物理像素与
    /// `GetWindowRect` 读回来的会差 1–2px。若按严格相等判，每 1 秒的复核都会认为
    /// 「还没对齐」⇒ 再 `set` 一次 ⇒ 永远不一致：用户看到窗口每秒闪一下、
    /// 前端每秒重排一次（`grid:bounds-changed` 每秒广播一次）。
    ///
    /// 变异对照：把 [`bounds_need_fix`] 里的 `> BOUNDS_TOLERANCE` 改成 `!= 0`，
    /// 第二组断言立刻变红。
    #[test]
    fn window_bounds_tolerance_swallows_rounding_noise() {
        let target = (0, 0, 1920u32, 1032u32);

        // 完全一致 ⇒ 位置和尺寸都不动
        assert_eq!(bounds_need_fix((0, 0), (1920, 1032), target), (false, false));
        // ±2px 的取整噪声 ⇒ 仍然当作「已对齐」
        assert_eq!(bounds_need_fix((1, 2), (1919, 1031), target), (false, false));
        assert_eq!(bounds_need_fix((-2, -1), (1922, 1034), target), (false, false));
        // 3px 起才认作真的错位（那是缩放 / 显示器变了，不是取整）
        assert_eq!(bounds_need_fix((3, 0), (1920, 1032), target), (true, false));
        assert_eq!(bounds_need_fix((0, 0), (1917, 1032), target), (false, true));

        // 位置与尺寸**分开**判：只错一样就只动一样（`set_size` 会触发 webview 重排）
        assert_eq!(bounds_need_fix((500, 0), (1920, 1032), target), (true, false));
        assert_eq!(bounds_need_fix((0, 0), (1280, 1032), target), (false, true));

        // 主屏换到另一台显示器（副屏在左 ⇒ 主屏原点 x = 1920）：位置跟过去、尺寸不变
        assert_eq!(
            bounds_need_fix((0, 0), (1920, 1032), (1920, 0, 1920, 1032)),
            (true, false)
        );
    }

    /// 真机那一组（V71）：收纳区 637×848、条目数 18 / 8 / 8 —— 见 [`pick_columns`] 里那张表。
    const REAL_ITEMS: [usize; 3] = [18, 8, 8];
    const REAL_ZONE_W: i64 = 637;
    const REAL_ZONE_H: i64 = 848;
    const REAL_MIN_X: i64 = 330;
    const REAL_ICON: i64 = 32;

    /// V71：**大格子并排铺在最上面**，不许挤在一列里让另一列空半截。
    ///
    /// 判据取「顶行有没有占满可用列数」而不是笼统的「列数是多少」—— 后者在宽度不紧张时
    /// 两三种答案都能通过，而前者正是用户 09-23 那句
    /// 「三个图表最多的不应该 2 3 列上面开始平均放置」的可测版本。
    ///
    /// 变异对照：把 [`pick_columns`] 里「先自然、后夹宽」改回 V69 的「只有全败才夹宽」，
    /// 这里立刻变成 2 列（18 项独占第一列、另外两个摞在第二列）⇒ 红。
    #[test]
    fn the_biggest_boxes_share_the_top_row_instead_of_piling_up() {
        let plan = content_plan(&REAL_ITEMS, REAL_ZONE_W, REAL_ZONE_H, REAL_ICON, REAL_MIN_X);
        assert_eq!(
            plan.column_count(),
            REAL_ITEMS.len(),
            "3 个格子在 637 宽的收纳区里应当各占一列（并排铺开），实际只开了 {} 列",
            plan.column_count()
        );
        assert!(
            plan.slots.iter().all(|s| s.y == ARRANGE_MARGIN),
            "3 个格子 3 列 ⇒ 全都该落在顶行，实际 y = {:?}",
            plan.slots.iter().map(|s| s.y).collect::<Vec<_>>()
        );
        assert!(!plan.overflowed, "并排铺开之后不该再越过可用区的下沿");
    }

    /// V71 → V85：**放得下就不许夹窄**（`pick_columns` 里「同一个 k 里自然尺寸在前」那一条）。
    ///
    /// 「多铺一列」是好事，但**不能拿格子宽度去换** —— 空间明明够，却把格子挤窄去凑列数，
    /// 用户看到的是「图标少了一个 / 排数变多」。
    ///
    /// ⚠️ V85 起判据从「宽度必须等于自然宽」放宽为「**不许比自然宽更窄**」：同一列里比列宽
    /// 窄的格子会被**撑到列宽**（用户 09-29 晚：「上面是宽的 下面放在一个小的小格子 宽度没有
    /// 占满……合理利用空间才好看吧」）。撑宽是设计内行为，夹窄才是回归。
    ///
    /// ⚠️ 场景必须选成「**同一个 k 里两套尺寸都可行、但只有自然尺寸不夹**」，否则这条用例
    /// 抓不住「夹宽优先」这个破坏（第一版拿 2 个 8 项试就栽在这儿：`capacity` 被
    /// `order.len()` 夹到 2，而 `k = 2` 的 cap 是 306 —— 232 宽的格子根本夹不到，两种顺序
    /// 给出同一个答案，用例恒绿）。
    ///
    /// `[18, 8]` 正好卡住：`k = 2` 的自然宽度 372 + 24 + 232 = **628 ≤ 637**（刚好放得下），
    /// 而同一个 `k` 的夹宽方案会把 18 项那个夹到 306 —— 差别一眼可见。
    #[test]
    fn a_roomy_zone_keeps_natural_box_widths() {
        let items = [18usize, 8];
        let plan = content_plan(&items, REAL_ZONE_W, REAL_ZONE_H, REAL_ICON, REAL_MIN_X);
        let natural: Vec<i64> = items
            .iter()
            .map(|n| box_own_size(*n, REAL_ZONE_W, REAL_ZONE_H, REAL_ICON).0)
            .collect();
        assert!(
            natural[0] + ARRANGE_GAP_X + natural[1] <= REAL_ZONE_W,
            "这条用例的前提是「自然宽度刚好放得下」，前提不成立就换场景：{natural:?}"
        );
        for (i, s) in plan.slots.iter().enumerate() {
            assert!(
                s.w >= natural[i],
                "第 {i} 个格子被夹窄到 {}（自然宽度 {}）—— 空间够时不许为「多开一列 / 凑整齐」把格子挤窄",
                s.w, natural[i]
            );
        }
    }

    /// V71 → V84：用户原话「**然后把零散的少量的格子补在下面即可**」—— 这半句一直有效；
    /// 变的是列数（见 [`pick_columns`] 的注释）。
    ///
    /// V71 时期这条用例钉的是「3 列、顶行 = 最大的三个」；09-29 用户明确反对
    /// 「搞成那么多列，格子宽度反而压缩到文件名都看不清了」，判据改为两轴填充率取
    /// `min` 之后，这批数据的最优解是 **2 列自然宽度**（填充率 0.88，高于 3 列夹宽的
    /// 0.85，且一个格子都不用夹窄）。「大格子在上、零散的补在下面」的落位精神不变：
    /// 顶行 = 18 项 + 一个 8 项，剩下的 8 / 8 / 4 全部补在下面。
    #[test]
    fn small_boxes_fill_in_below_the_big_ones() {
        let items = [18usize, 8, 8, 8, 4];
        let plan = content_plan(&items, REAL_ZONE_W, REAL_ZONE_H, REAL_ICON, REAL_MIN_X);
        assert_eq!(
            plan.column_count(),
            2,
            "5 个格子在 637 宽里应当收成 2 列自然宽度（V84），实际开了 {} 列",
            plan.column_count()
        );
        // 不许为了凑列数把任何格子夹窄（V71 的精神；V85 起撑宽到列宽是设计内行为）
        for (i, s) in plan.slots.iter().enumerate() {
            let natural = box_own_size(items[i], REAL_ZONE_W, REAL_ZONE_H, REAL_ICON).0;
            assert!(
                s.w >= natural,
                "第 {i} 个格子被夹窄到 {}（自然宽度 {}）",
                s.w, natural
            );
        }
        let mut top: Vec<usize> = items
            .iter()
            .zip(plan.slots.iter())
            .filter(|(_, s)| s.y == ARRANGE_MARGIN)
            .map(|(n, _)| *n)
            .collect();
        top.sort_unstable();
        top.reverse();
        assert_eq!(top, vec![18, 8], "顶行应当是最大的两个（每列一个）");
        let mut below: Vec<usize> = items
            .iter()
            .zip(plan.slots.iter())
            .filter(|(_, s)| s.y > ARRANGE_MARGIN)
            .map(|(n, _)| *n)
            .collect();
        below.sort_unstable();
        below.reverse();
        assert_eq!(below, vec![8, 8, 4], "零散的少量格子应当补在下面");
        assert!(!plan.overflowed, "补在下面之后也不该越界");
    }

    /// V84：用户 09-29 的真机场景 —— 6 个格子（13 / 12 / 8 / 2 / 1 / 1 项）在 920×968 的
    /// 收纳区里曾被「k 从大到小」排成 **5 列**、每列 ~176px（用户原话「格子宽度反而压缩到
    /// 文件名都看不清了」「空了大量的空白」）。判据改为两轴填充率取 `min` 之后必须收成
    /// **少量宽列**：2 列、全部自然宽度、纵向填过半。
    #[test]
    fn six_boxes_pack_into_wide_natural_columns_not_five_cramped_ones() {
        let items = [13usize, 12, 8, 2, 1, 1];
        let (zone_w, zone_h) = (920i64, 968i64);
        let plan = content_plan(&items, zone_w, zone_h, 32, ARRANGE_MARGIN);
        assert!(
            plan.column_count() <= 3,
            "不许再开 5 列（用户：「搞成那么多列」）：实际 {} 列",
            plan.column_count()
        );
        for (i, s) in plan.slots.iter().enumerate() {
            let natural = box_own_size(items[i], zone_w, zone_h, 32).0;
            assert!(
                s.w >= natural,
                "第 {i} 个格子被夹窄到 {}（自然宽度 {}）—— 宁可少一列也不夹窄",
                s.w, natural
            );
        }
        let bottom = plan.slots.iter().map(|s| s.y + s.h).max().unwrap() - ARRANGE_MARGIN;
        assert!(
            bottom * 2 > zone_h,
            "纵向填充必须过半（{bottom}/{zone_h}）—— 列多到竖向空一半就是又回到 5 列的老路"
        );
        assert!(!plan.overflowed, "不许越出可用区下沿");
    }

    /// V85：**列从右往左排（右锚定）+ 列内撑满列宽**。
    ///
    /// 用户 09-29 晚（附截图）：「格子应该从右往左开始排，而不是从左到右排，不是说了排完
    /// 后剩余空间给快捷方式等不整理的图标部分吗」「上面是宽的 下面放在一个小的小格子 宽度
    /// 没有占满……合理利用空间才好看吧」。
    ///
    /// 场景故意把可用宽压到 500：`k = 2` 的自然宽度 628 放不下 ⇒ 只能收成一列，
    /// 8 项那格必须撑到 18 项的列宽（旧行为是保持 232、右边空一截）。
    #[test]
    fn columns_anchor_right_and_narrow_boxes_fill_the_column_width() {
        let items = [18usize, 8];
        let (zone_w, zone_h) = (500i64, 848i64);
        let plan = content_plan(&items, zone_w, zone_h, REAL_ICON, REAL_MIN_X);

        // ① 右锚定：最右一格的右沿 == 可用区右沿（便签一侧），剩余空间留在左边
        let zone_right = REAL_MIN_X + zone_w;
        let used_right = plan.slots.iter().map(|s| s.x + s.w).max().unwrap();
        assert_eq!(
            used_right, zone_right,
            "格子必须贴着可用区右沿（便签一侧）排，剩余空间留给左边"
        );
        let used_left = plan.slots.iter().map(|s| s.x).min().unwrap();
        assert!(used_left > REAL_MIN_X, "剩余空间应该留在左边（未归类竖条一侧）");

        // ② 列内撑满：一列的宽度 = 该列最宽那格，其余格子同宽（不许「上宽下窄」）
        let col_w_expected = items
            .iter()
            .map(|n| box_own_size(*n, zone_w, zone_h, REAL_ICON).0)
            .max()
            .unwrap();
        for s in &plan.slots {
            assert_eq!(
                s.w, col_w_expected,
                "列内格子宽度必须撑满列宽（用户：「宽度没有占满」）：{s:?}"
            );
        }
        // ③ 撑宽之后高度按新宽度重算（几何自洽：宽了行数就少）—— 两格都不能越界
        assert!(!plan.overflowed, "撑满列宽之后不许越界");
        // ④ 幂等仍是算出来的：同样的内容排两遍一字不差
        let again = content_plan(&items, zone_w, zone_h, REAL_ICON, REAL_MIN_X);
        let snap = |p: &ContentPlan| -> Vec<(i64, i64, i64, i64)> {
            p.slots.iter().map(|s| (s.x, s.y, s.w, s.h)).collect()
        };
        assert_eq!(snap(&plan), snap(&again), "同一个输入排两次结果不同");
    }

    fn overlap(a: &SlotRect, b: &SlotRect) -> bool {
        a.intersects(b)
    }

    /// 排布测试统一用「1920×1080 工作区 + 320 列宽 + 图标 32px」这套现实参数。
    const WORK_W: i64 = 1920;
    const WORK_H: i64 = 1080;
    const COL_W: i64 = 320;
    /// 单格高度上限 —— 与 [`layout_all_boxes`] 传给 `box_height_at` 的完全是同一个量，
    /// 测试若自己另写一个数，就会出现「函数按调用方给的上限夹、测试按另一个数断言」的假失败。
    const MAX_H: i64 = WORK_H - 2 * ARRANGE_MARGIN;

    fn placer(blocked: Vec<SlotRect>) -> FlowPlacer {
        FlowPlacer::new(WORK_W, WORK_H, COL_W, blocked)
    }

    // —————————————— 左起流布局 · 列对齐 ——————————————

    #[test]
    fn first_box_lands_in_the_top_left_corner() {
        let mut p = placer(Vec::new());
        let (x, y) = p.next(COL_W, 244).expect("首块必有位置");
        assert_eq!(y, ARRANGE_MARGIN, "首扎根在顶部");
        assert_eq!(
            x, ARRANGE_MARGIN,
            "首扎根在左上角（桌面图标的传统起点；右上角留给日历）"
        );
    }

    #[test]
    fn stacks_down_before_flowing_right() {
        let mut p = placer(Vec::new());
        let first = p.next(COL_W, 244).unwrap();
        let second = p.next(COL_W, 244).unwrap();
        // 同一列：x 不动，y 往下退一格
        assert_eq!(second.0, first.0);
        assert_eq!(second.1, first.1 + 244 + ARRANGE_GAP_Y);

        // 一路摆到列尾，下一个必须换到右边一列，且回到顶部
        let mut saw_right_column = false;
        for _ in 0..16 {
            match p.next(COL_W, 244) {
                Some((x, y)) => {
                    if x > second.0 {
                        assert_eq!(y, ARRANGE_MARGIN, "换列后要回到顶部，而不是接着往下排");
                        saw_right_column = true;
                        break;
                    }
                }
                None => break,
            }
        }
        assert!(saw_right_column, "本列排满后必须往右推一列");
    }

    #[test]
    fn every_column_sits_on_the_same_pitch() {
        // 「让格子对齐整齐、宽度对齐」的**可复算**版本：所有落点的 x 必须是
        // `margin + k ×（列宽 + 间隙）`，一个像素都不许漂。
        // 这正是 V39 的缺陷所在：那时 x = 列右边界 − 各自的宽度，宽度一不同左边缘就参差。
        let pitch = COL_W + ARRANGE_GAP_X;
        let mut narrow = FlowPlacer::new(900, 400, COL_W, Vec::new());
        let mut xs = std::collections::BTreeSet::new();
        while let Some((x, _)) = narrow.next(COL_W, MIN_BOX_H) {
            assert_eq!(
                (x - ARRANGE_MARGIN) % pitch,
                0,
                "列位置必须落在等距列网格上（{x}）"
            );
            xs.insert(x);
            if xs.len() > 6 {
                break;
            }
        }
        assert!(xs.len() >= 2, "900 宽的桌面至少要排得下两列");
    }

    #[test]
    fn respects_widget_no_go_zones() {
        // 便签 / 日历是用户自己摆的，新排的格子不许压上去。
        // 禁区刻意挡住「左上角」这个首选位置 —— 否则排布一开始就落在那儿，
        // 根本不会经过「让开」那条分支，这条测试就成了摆设。
        let widget = SlotRect {
            x: ARRANGE_MARGIN,
            y: ARRANGE_MARGIN,
            w: 300,
            h: 200,
        };
        let mut p = placer(vec![widget]);
        let (x, y) = p.next(COL_W, 244).expect("禁区之外还有地方");
        let placed = SlotRect {
            x,
            y,
            w: COL_W,
            h: 244,
        };
        assert!(!overlap(&placed, &widget), "挂件位置必须让开");
        assert!(
            y >= widget.y + widget.h,
            "撞上禁区应该是往下让开，而不是横向漂移或叠上去"
        );
    }

    #[test]
    fn reuses_holes_instead_of_only_moving_down() {
        // V38 排布器的游标**只增不减**：一列里被大格子 / 挂件切出来的空隙再也用不上。
        // 格子高度一按内容量变得参差，这个缺陷立刻变成大片浪费 + 后面的格子排不下。
        let widget = SlotRect {
            x: ARRANGE_MARGIN,
            y: 500,
            w: COL_W,
            h: 200,
        };
        let mut p = placer(vec![widget]);
        let a = p.next(COL_W, 244).expect("第一个格子");
        assert_eq!(a.1, ARRANGE_MARGIN);
        // 第二个（同样高）撞上挂件 → 让到挂件下面
        let b = p.next(COL_W, 244).expect("第二个格子");
        assert!(b.1 >= widget.y + widget.h, "撞上挂件要往下让开");

        // 第三个是矮格子：它应该回头塞进 a 与挂件之间那道空隙，而不是跟着 b 继续往下
        let c = p.next(COL_W, MIN_BOX_H).expect("矮格子");
        assert_eq!(
            c.1,
            a.1 + 244 + ARRANGE_GAP_Y,
            "留出来的空洞必须能被后面的小格子复用"
        );
        assert!(c.1 < b.1, "复用空洞的位置必然在 b 之上");
    }

    #[test]
    fn never_runs_off_the_bottom_nor_off_either_side() {
        let mut p = FlowPlacer::new(900, 500, COL_W, Vec::new());
        let mut placed = Vec::new();
        while let Some((x, y)) = p.next(COL_W, 244) {
            assert!(y + 244 <= 500 - ARRANGE_MARGIN, "不许排到桌面之外");
            assert!(x >= ARRANGE_MARGIN, "不许排到左边界之外");
            assert!(
                x + COL_W <= 900 - ARRANGE_MARGIN,
                "不许排到右边界之外"
            );
            placed.push(SlotRect {
                x,
                y,
                w: COL_W,
                h: 244,
            });
        }
        assert!(!placed.is_empty(), "900×500 至少要摆得下一个格子");
    }

    #[test]
    fn reports_exhaustion_instead_of_piling_up() {
        // 极窄桌面：连一列都放不下 → 明确放弃，而不是返回负坐标或互相叠压
        let mut p = FlowPlacer::new(200, 400, COL_W, Vec::new());
        assert_eq!(p.next(COL_W, 244), None);
    }

    #[test]
    fn a_full_pass_never_overlaps() {
        // 尺寸参差（内容驱动的真实形态）也要保证两两不重叠
        let sizes = [244i64, 120, 442, 178, 300, 120, 244, 442, 178, 244, 120, 300];
        let mut p = placer(Vec::new());
        let mut placed = Vec::new();
        for h in sizes {
            match p.next(COL_W, h) {
                Some((x, y)) => placed.push(SlotRect {
                    x,
                    y,
                    w: COL_W,
                    h,
                }),
                None => break,
            }
        }
        assert!(placed.len() >= 8, "1920×1080 至少要摆得下 8 个格子");
        for i in 0..placed.len() {
            for j in (i + 1)..placed.len() {
                assert!(
                    !overlap(&placed[i], &placed[j]),
                    "第 {i} 与第 {j} 个格子重叠了：{:?} vs {:?}",
                    placed[i],
                    placed[j]
                );
            }
        }
    }

    #[test]
    fn honours_each_boxs_own_height_and_a_minimum() {
        // 高度不统一才是常态（按内容量撑开 / 用户拖过），不能按固定步进假定
        let mut p = placer(Vec::new());
        let (x, y) = p.next(COL_W, 8).expect("极小高度也要有位置");
        // 高度被夹到 MIN_BOX_H；宽度由调用方保证（整理时会先统一列宽）
        assert_eq!(x, ARRANGE_MARGIN);
        assert_eq!(y, ARRANGE_MARGIN);
        let second = p.next(COL_W, 244).unwrap();
        assert_eq!(second.1, ARRANGE_MARGIN + MIN_BOX_H + ARRANGE_GAP_Y);
    }

    #[test]
    fn place_loose_never_leaves_a_box_outside_the_layout_band() {
        // 最后的兜底（桌面真的排不下）：宁可压在别人身上，也不能留在旧坐标散落桌面
        let mut p = FlowPlacer::new(900, 500, COL_W, Vec::new());
        while p.next(COL_W, 244).is_some() {}
        let (x, y) = p.place_loose(COL_W, 244);
        assert!(x >= ARRANGE_MARGIN, "兜底也不能排到左边界之外");
        assert!(x + COL_W <= 900 - ARRANGE_MARGIN, "兜底也不能排到右边界之外");
        assert!(y >= ARRANGE_MARGIN);
    }

    // —————————————— 统一列宽 + 内容驱动高度（V40） ——————————————

    /// 收纳格单元格度量：`(iconSize + CELL_EXTRA_W) × (iconSize + BOX_CELL_EXTRA_H)`，
    /// 与前端 `minmax(icon + 32, 1fr)` + `gridAutoRows: icon + 36` 完全一致（V65 修：之前错用了
    /// 竖条那份 `CELL_EXTRA_H=30`，导致每个条目行矮 6px、多行累积裁切）。
    fn cell(icon: i64) -> (i64, i64) {
        (icon + CELL_EXTRA_W, icon + BOX_CELL_EXTRA_H)
    }

    #[test]
    fn one_standard_width_for_the_whole_batch() {
        // V65：**宽度按内容给**，不再「整批统一列宽」（V65 起那一层废掉了）。
        // 这里只守两条硬不变量：
        //   ① `desired_box_width` 给出的宽度**随条目数单调不减**，且夹在合法区间；
        //   ② `standard_box_width` 在「取本批最宽需求」时仍收敛（用于新建空格子的兜底宽度）。
        let icon = 32;
        let counts = [2usize, 8, 16, 21, 36];
        let desired: Vec<i64> = counts
            .iter()
            .map(|n| desired_box_width(*n, icon))
            .collect();
        for d in &desired {
            assert!(
                *d >= MIN_BOX_W && *d <= AUTO_MAX_W,
                "宽度必须落在 [{MIN_BOX_W}, {AUTO_MAX_W}] 内：{d}"
            );
        }
        // 条目越多越宽，直到触到 5 列上限（之后只加行不加列，宽度不再变）
        assert!(desired[1] > desired[0], "8 个条目应比 2 个宽");
        assert!(desired[2] > desired[1], "16 个条目应比 8 个宽");
        assert_eq!(desired[2], desired[4], "16 与 36 都顶到 5 列上限：同等宽度");
        // 单元格度量（与前端 `icon+32` × `icon+36` 一致）—— 改前端度量这里要跟着改
        let (cell_w, cell_h) = cell(icon);
        assert_eq!((cell_w, cell_h), (64, 68), "前端度量一改，本用例的期望值就要跟着改");
        // standard_box_width 取本批最宽的需求、夹进工作区
        let std_w = standard_box_width(desired.iter().copied(), WORK_W);
        assert_eq!(std_w, *desired.iter().max().unwrap());
    }
    #[test]
    fn height_grows_with_item_count_at_a_fixed_width() {
        // 用户 V40：「高度根据图标多少自动撑开」—— 宽度固定，高度必须跟着条目数走（V65 同样成立）。
        let icon = 32;
        // V70：用「4 列的标准宽度」——**往返必须闭环**：按 4 列算出来的宽度，
        // 前端（含滚动槽与余量）必须真能排出 4 列。这条闭环以前是断的（见 BOX_HEADER_H 注释）。
        let w = box_width_for_columns(4, icon);
        assert_eq!(item_columns_at(w, icon), 4, "4 列算出来的宽度，前端必须真能排 4 列");
        let (_, ch) = cell(icon); // 单元格高 = icon + BOX_CELL_EXTRA_H = 68

        // 1 行（2 个条目，4 列）的实际高度：标题栏 + 边框 + 1 行 + 内边距
        assert_eq!(
            box_height_at(2, w, icon, MAX_H),
            BOX_HEADER_H + BOX_BORDER_H + 1 * ch + 2 * GRID_PAD_Y + BOX_FIT_SLACK
        );
        // 2 行（8 个条目，4 列）
        assert_eq!(
            box_height_at(8, w, icon, MAX_H),
            BOX_HEADER_H + BOX_BORDER_H + 2 * ch + GRID_GAP + 2 * GRID_PAD_Y + BOX_FIT_SLACK
        );
        // 6 行（21 个条目）—— 真实库里那个「文档」格就是 21 项
        let h21 = box_height_at(21, w, icon, MAX_H);
        assert_eq!(
            h21,
            BOX_HEADER_H + BOX_BORDER_H + 6 * ch + 5 * GRID_GAP + 2 * GRID_PAD_Y + BOX_FIT_SLACK
        );
        assert!(h21 > box_height_at(8, w, icon, MAX_H), "条目多的格子必须更高");
    }
    #[test]
    fn standard_width_never_exceeds_the_work_area() {
        // 内容再多也不能把列宽算到工作区之外（否则格子会被排到屏幕外）
        let icon = 32;
        let wide = [desired_box_width(200, icon)];
        let narrow = standard_box_width(wide.iter().copied(), 500);
        assert!(
            narrow <= 500 - 2 * ARRANGE_MARGIN,
            "窄桌面不得算出超出工作区的列宽：{narrow}"
        );
        // 还没有格子时退回默认列宽
        assert_eq!(standard_box_width(std::iter::empty(), WORK_W), ARRANGE_BOX_W);
    }

    #[test]
    fn box_size_follows_item_count() {
        let icon = 32;
        let (_cell_w, cell_h) = cell(icon);

        // 空格子：1 列 1 行（没有条目时按 1 算），给最小高度
        let empty = auto_box_size(0, icon, MAX_H);
        assert_eq!(empty.0, MIN_BOX_W);
        assert_eq!(
            empty.1,
            BOX_HEADER_H + BOX_BORDER_H + 1 * cell_h + 2 * GRID_PAD_Y + BOX_FIT_SLACK
        );

        // 4 个条目：3 列 × 2 行（宽度高于最小尺寸时不夹到 MIN_BOX_W）
        let (w4, h4) = auto_box_size(4, icon, MAX_H);
        assert_eq!(w4, box_width_for_columns(3, icon));
        assert_eq!(
            h4,
            BOX_HEADER_H + BOX_BORDER_H + 2 * cell_h + GRID_GAP + 2 * GRID_PAD_Y + BOX_FIT_SLACK
        );

        // 条目越多，格子越高（单调）—— 这正是用户那句「按内容多少自动调整大小」
        let (w21, h21) = auto_box_size(21, icon, MAX_H);
        assert!(h21 > h4, "21 个条目的格子必须比 4 个的高");
        assert!(w21 >= w4, "列数不会更少");

        // 列数有上限，不会排成一条长带
        let (w100, h100) = auto_box_size(100, icon, MAX_H);
        assert!(w100 <= AUTO_MAX_W, "宽度必须有上限");
        assert!(h100 <= MAX_H, "高度不得超过可用高度（超出交给格子内滚动）");
    }
    #[test]
    fn bigger_desktop_icons_make_bigger_boxes() {
        // V37 起格子图标跟着系统桌面图标尺寸走；尺寸算法必须同步跟着变，
        // 否则用户把桌面图标调大之后，格子里就会挤成一团。
        let (w32, h32) = auto_box_size(6, 32, MAX_H);
        let (w48, h48) = auto_box_size(6, 48, MAX_H);
        assert!(w48 >= w32 && h48 > h32);
    }

    #[test]
    fn size_is_clamped_into_the_legal_range() {
        for items in [0usize, 1, 7, 40, 500] {
            for icon in [16i64, 32, 48, 96, 256] {
                let (w, h) = auto_box_size(items, icon, MAX_H);
                assert!(w >= MIN_BOX_W && w <= AUTO_MAX_W, "{items}/{icon} 宽度越界：{w}");
                assert!(
                    h >= MIN_BOX_H && h <= MAX_H,
                    "{items}/{icon} 高度越界：{h}"
                );
            }
        }
        // 可用高度很小时也不能算出小于最小高度的格子
        let (_, h) = auto_box_size(30, 32, 100);
        assert_eq!(h, MIN_BOX_H);
    }

    #[test]
    fn system_box_counts_as_a_content_box_not_a_widget() {
        // 「系统」格（此电脑 / 回收站 / 用户文件夹）本质是内容格：参与流布、宽度统一。
        // V39 把它当挂件走锚点，自成一个 320 宽度 —— 那是「对不齐」的一部分。
        assert!(is_content_kind("folder"));
        assert!(is_content_kind("system"));
        // 便签 / 日历才是挂件，位置由锚点表决定
        assert!(!is_content_kind("note"));
        assert!(!is_content_kind("calendar"));
    }

    // —————————————— 挂件锚点 ——————————————

    #[test]
    fn loose_strip_sits_at_the_top_left_and_only_when_needed() {
        // 左侧「未归类」竖条（V42）：没有未归类条目就什么都不占；有则贴在**左上角**，
        // 按「一列放得下几行」决定分几列 —— 用户原话「他们就是自动在桌面左上角
        // 从上往下排开即可」。
        assert!(
            loose_strip_rect(WORK_W, WORK_H, 0, 32).is_none(),
            "没有未归类条目不得占位"
        );
        let strip = loose_strip_rect(WORK_W, WORK_H, 5, 32).expect("有未归类条目必须有区域");
        assert_eq!(strip.rect.x, ARRANGE_MARGIN, "贴左边界");
        assert_eq!(strip.rect.y, ARRANGE_MARGIN, "贴上边界（V41 是贴下边界）");
        assert_eq!(strip.columns, 1, "5 条在 1080 高的工作区里一列就放得下");

        // 窄格位、单列：宽度 = 单元格宽（图标 + CELL_EXTRA_W），不是「整批统一列宽」——
        // 竖条是纯图标条，不该跟收纳格一样宽，否则左半边白白被吃掉
        let (cell_w, cell_h) = loose_cell_size(32);
        assert_eq!(strip.rect.w, cell_w);
        assert_eq!(strip.rect.h, 5 * cell_h + 4 * GRID_GAP);

        // 条目多到一列放不下 → 往右铺成多列，列数被「最多占工作区一半宽」夹住（V86）
        let pitch_x = cell_w + GRID_GAP;
        let pitch_y = cell_h + GRID_GAP;
        let rows_per_col = ((WORK_H - 2 * ARRANGE_MARGIN) / pitch_y).max(1);
        let max_cols = ((WORK_W / 2 - ARRANGE_MARGIN) / pitch_x).max(1);
        let expected_cols = max_cols.min((400 + rows_per_col - 1) / rows_per_col);
        let many = loose_strip_rect(WORK_W, WORK_H, 400, 32).expect("必须有区域");
        assert_eq!(
            many.columns, expected_cols,
            "列数 = min(自然列数, 宽度上限)；本机参数下应由宽度上限夹住"
        );
        assert_eq!(many.rect.w, expected_cols * cell_w + (expected_cols - 1) * GRID_GAP);
        assert!(
            many.rect.y + many.rect.h <= WORK_H - ARRANGE_MARGIN,
            "竖条不得越出下边界"
        );

        // V59 / V86：列数被宽度上限夹住 ⇒ 前端渲染的行数（ceil(n/columns)）**必然高于**
        // 这里给的 `rect.h`（rows 超过 rows_per_col）。这是有意为之的契约：多出来的行由
        // 竖条自己 `overflow-y-auto` 内部滚（前端 `GridOverlay` 的竖条容器），**不许**靠
        // 放开 `h` 的封顶来「解决」—— 那会让竖条压到任务栏上，或者把溢出交给桌面根画布、
        // 让整个桌面变成可滚的（V59 就是这么回归的）。这条断言把契约钉住：将来若有人把
        // `h` 改成不封顶，这里会立刻变红。
        let natural_rows = (400 + expected_cols - 1) / expected_cols;
        let natural_h = natural_rows * (cell_h + GRID_GAP) - GRID_GAP;
        assert!(
            natural_h > many.rect.h,
            "列数撞宽度上限时，前端需要的自然高度（{natural_h}）应当高于给定区域（{}）——\
             说明 h 的封顶被放开了，竖条会压到任务栏或把桌面层变成可滚的",
            many.rect.h
        );
    }

    /// V86：真机场景 —— 42 个条目、1920×1032。
    ///
    /// 用户 09-30 原话：「快捷方式这里应该从左到右依次往下排列，满了就换第二列，
    /// 现在怎么成了**下面空了**，正常应该是**右边空**」。旧逻辑夹死 4 列 ⇒ 11 行，
    /// 下面空出一段；新逻辑列数自然算出（42 / 14 行 = 3 列），每列都满高，
    /// 剩余的空白在**右边**。
    #[test]
    fn loose_strip_fills_columns_full_height_and_leaves_room_on_the_right() {
        let strip = loose_strip_rect(1920, 1032, 42, 32).expect("必须有区域");
        let cell_h = loose_cell_size(32).1;
        let pitch_y = cell_h + GRID_GAP;
        let rows_per_col = ((1032 - 2 * ARRANGE_MARGIN) / pitch_y).max(1);
        // 本场景自然列数（3 列）远小于宽度上限，直接按自然列数断言：
        let cols = (42 + rows_per_col - 1) / rows_per_col;
        assert_eq!(
            strip.columns, cols,
            "42 个条目应当按每列 {rows_per_col} 行自然分 {cols} 列（不许夹回 4 列）"
        );
        // 每列都满高：高度正好 = 行数 × 行距（行数 = ceil(42 / 列数)），没有「下面空一段」
        let rows = (42 + cols - 1) / cols;
        assert_eq!(strip.rect.h, rows * pitch_y - GRID_GAP);
        // 也不越界（不出滚动条的前提）
        assert!(strip.rect.y + strip.rect.h <= 1032 - ARRANGE_MARGIN);
    }

    #[test]
    fn mirrored_flow_starts_at_the_right_edge() {
        // V42：分类格从**最右一列**起、自右向左流布（用户原话「右边是从挂件到其他整理，
        // 从右上角依次顺序排开」）。
        let col_w = 300;
        let mut placer = FlowPlacer::with_bounds(WORK_W, WORK_H, col_w, Vec::new(), true, 240);
        assert_eq!(
            placer.col_left(0),
            WORK_W - ARRANGE_MARGIN - col_w,
            "第 0 列必须贴右边界"
        );
        assert_eq!(placer.col_left(1), WORK_W - ARRANGE_MARGIN - col_w - (col_w + ARRANGE_GAP_X));

        // 第一个格子贴右上；第二个接在它下面（同列首次适配）
        let first = placer.next_from(0, col_w, 200).expect("第一个格子放得下");
        assert_eq!(first, (WORK_W - ARRANGE_MARGIN - col_w, ARRANGE_MARGIN));
        let second = placer.next_from(0, col_w, 200).expect("第二个格子放得下");
        assert_eq!(second.1, ARRANGE_MARGIN + 200 + ARRANGE_GAP_Y, "同列往下接");

        // 左边界（留给左侧竖条）：列号够到 min_x 就必须停 —— 再往左就压到快捷方式上了
        let wide = FlowPlacer::with_bounds(WORK_W, WORK_H, col_w, Vec::new(), true, WORK_W - 380);
        assert_eq!(wide.max_columns, 1, "只容得下一列");
        assert!(
            wide.col_left(0) >= WORK_W - 380,
            "唯一一列也必须落在左边界右侧"
        );
    }

    /// 造一个用于几何测试的格子（位置给 0，由被测函数负责摆放）。
    fn sample_rect(id: i64, kind: &str, w: i64, h: i64) -> GridBoxRect {
        GridBoxRect {
            id,
            name: format!("box{id}"),
            kind: kind.to_string(),
            x: 0,
            y: 0,
            w,
            h,
            // 单测里的样本默认是「引擎摆过的」——`manual` 的用例自己置 true
            manual: false,
            items: 1,
        }
    }

    fn find_rect(out: &[(i64, SlotRect)], id: i64) -> SlotRect {
        out.iter()
            .find(|(i, _)| *i == id)
            .map(|(_, r)| *r)
            .unwrap_or_else(|| panic!("格子 {id} 应当被摆下"))
    }

    #[test]
    fn widgets_each_get_their_own_column() {
        // V48 用户原话：「便签自己占一列，工作台日志占一大列，剩下的占两列」——
        // 挂件不再「贴某个角落往下摞」，而是各自拥有一条**从顶到底的竖列**：
        // 日历（工作台日志）在最右，便签紧挨它左边。
        assert_eq!(widget_zone("calendar"), WidgetZone::Calendar);
        assert_eq!(widget_zone("note"), WidgetZone::Note);
        assert_eq!(widget_zone("weather"), WidgetZone::Other, "没登记的挂件也要有列");

        // 样本刻意给日历一个**过宽**的旧尺寸（真机库里就是 460）：布局必须把它收回
        // 自然宽度 —— 用户 09-19：「日历这里总宽度没有收回来」。
        let cal = sample_rect(1, "calendar", 460, 638);
        let note = sample_rect(2, "note", 260, 220);
        let out = place_widget_columns(&[&cal, &note], WORK_H, 240, MIN_BOX_W, &[], WORK_W - ARRANGE_MARGIN);
        let cal_rect = find_rect(&out, 1);
        let note_rect = find_rect(&out, 2);
        assert_eq!(
            cal_rect.x + cal_rect.w,
            WORK_W - ARRANGE_MARGIN,
            "日历列贴右边界"
        );
        assert_eq!(cal_rect.y, ARRANGE_MARGIN, "挂件从顶部开始摆");
        assert_eq!(
            cal_rect.w, CALENDAR_BOX_W,
            "日历列宽取**自然宽度**（460 那种两侧全是留白）：实际 {}",
            cal_rect.w
        );
        assert_eq!(
            note_rect.x + note_rect.w,
            cal_rect.x - ARRANGE_GAP_X,
            "便签列紧挨日历左侧，间距就是列间距"
        );
        assert!(!cal_rect.intersects(&note_rect), "两条列不得重叠");
    }

    #[test]
    fn many_notes_stay_in_one_column_instead_of_piling_up_or_spilling_left() {
        // **真机事故（V47 用户截图）**：三个便签全在同一个坐标 (1415, 692)，完全重叠。
        // 根因是旧实现「列满之后把 y 夹回可用区间」，后来的便签全被夹到同一个 y 上。
        //
        // V48 的修法是「放不下就再开一条列」，但那在便签上是错的方向：真机 6 个便签时
        // 便签带从 1071 一路铺到 787（吃掉 888px），收纳区被压到只剩 1 列还装不下，
        // 两个格子被顶到屏幕外。用户 09-19 点名：「便签一个独立的列…不要跟格子挤在一起」。
        //
        // V50 的约定：**便签永远只有一条列**，放不下就在列内压高度（便签正文本来就能滚）。
        let notes: Vec<GridBoxRect> = (0..6)
            .map(|i| sample_rect(i + 1, "note", 260, 220))
            .collect();
        let refs: Vec<&GridBoxRect> = notes.iter().collect();
        let out = place_widget_columns(&refs, WORK_H, 240, MIN_BOX_W, &[], WORK_W - ARRANGE_MARGIN);
        assert_eq!(out.len(), 6, "六个便签都要有位置");

        let xs: std::collections::BTreeSet<i64> = out.iter().map(|(_, r)| r.x).collect();
        assert_eq!(xs.len(), 1, "六个便签必须挤在**同一条**列里：{xs:?}");
        for (i, (_, a)) in out.iter().enumerate() {
            for (_, b) in out.iter().skip(i + 1) {
                assert!(!a.intersects(b), "便签重叠了：{a:?} / {b:?}");
            }
            assert!(a.x >= ARRANGE_MARGIN && a.y >= ARRANGE_MARGIN, "跑出左上角：{a:?}");
            assert!(a.x + a.w <= WORK_W && a.y + a.h <= WORK_H, "跑出工作区：{a:?}");
            assert!(a.h >= MIN_BOX_H, "压高度不能突破最小高度：{a:?}");
        }
        // 整列必须装得下（这才是「不加滚动条不许越界」的硬保证）
        let last = out.iter().map(|(_, r)| r.y + r.h).max().unwrap_or(0);
        assert!(last <= WORK_H - ARRANGE_MARGIN, "便签列越出下边界：{last}");
    }

    /// 挂件带的**结构稳定性**（V50）：便签再多也不许改变挂件带宽度。
    ///
    /// 这是「不要跟格子挤在一起」的机器可验证形式 —— 挂件带宽度不变 ⇒ 收纳区的列网格
    /// 不变 ⇒ 加便签不会动到任何收纳格。
    #[test]
    fn the_widget_band_width_does_not_grow_with_more_notes() {
        let cal = sample_rect(1, "calendar", 320, 638);
        let band_left_of = |note_count: i64| -> i64 {
            let mut widgets: Vec<GridBoxRect> = vec![cal.clone()];
            for i in 0..note_count {
                widgets.push(sample_rect(10 + i, "note", 260, 220));
            }
            let refs: Vec<&GridBoxRect> = widgets.iter().collect();
            place_widget_columns(&refs, WORK_H, 240, MIN_BOX_W, &[], WORK_W - ARRANGE_MARGIN)
                .iter()
                .map(|(_, r)| r.x)
                .min()
                .expect("挂件带必须有左界")
        };
        let one = band_left_of(1);
        for n in 2..=8 {
            assert_eq!(
                band_left_of(n),
                one,
                "{n} 个便签时挂件带宽度变了 —— 收纳区会被挤动（用户投诉的正是这个）"
            );
        }
    }

    /// **V60**：常驻「工作台」浮窗占着**工作区右侧一整列**，它是禁区。
    ///
    /// V56 时禁区只是右下角 `320×320` 的一块（那是「快捷入口格子」）；工作台上线后
    /// （用户 09-21：「日历可以修改为工作台，把快捷入口这些都可以整合到工作台里面」）
    /// 它变成**整列**，本用例守三条：
    ///   ① 几何：右沿贴住工作区右沿、顶到底、宽度 = `WST_BOX_W`（前端 `WORKSTATION_W` 跟着走）；
    ///   ② 禁区语义：与它横向相交的列**可用高度为 0 以下**（于是根本排不进去），
    ///      不相交的列一个像素都不受影响；
    ///   ③ 挂件带：右界让开禁区之后，便签列仍能正常排下 —— 这正是 `right_edge` 存在的理由
    ///      （少了它，第一个便签列会正好排到工作台底下）。
    #[test]
    fn the_workstation_column_is_a_no_go_zone() {
        let wst = workstation_rect(WORK_W, WORK_H);
        assert_eq!(
            wst.x + wst.w,
            WORK_W - ARRANGE_MARGIN,
            "工作台的右沿必须贴住工作区右沿（前端 right-8 与 ARRANGE_MARGIN 是同一个 32）"
        );
        assert_eq!(wst.w, WST_BOX_W, "宽度就是 WST_BOX_W（前端 WORKSTATION_W 跟着这个走）");
        assert!(
            WST_BOX_W > CALENDAR_BOX_W,
            "V62：工作台要装下「日历 + 快捷入口 + 操作按钮」，只能比当年日历那一列更宽"
        );
        assert_eq!(wst.y, ARRANGE_MARGIN, "顶到工作区上沿");
        assert_eq!(
            wst.y + wst.h,
            WORK_H - ARRANGE_MARGIN,
            "底边贴住工作区下沿 —— 是**整列**，不再是右下角一块"
        );

        // 与禁区横向相交的列：可用高度被压到「上沿之上」，于是根本排不进去
        assert!(
            column_bottom(wst.x, wst.w, WORK_H, std::slice::from_ref(&wst)) < ARRANGE_MARGIN,
            "相交的列必须没有可用高度（否则格子会把工作台盖住）"
        );
        // 不相交的列：一个像素都不受影响
        assert_eq!(
            column_bottom(0, 320, WORK_H, std::slice::from_ref(&wst)),
            WORK_H - ARRANGE_MARGIN,
            "不相交的列：下沿不受影响"
        );

        // 挂件带让开工作台后必须仍能排下：`right_edge` = 禁区左沿 − 一道缝
        let right_edge = wst.x - ARRANGE_GAP_X;
        let note = sample_rect(2, "note", 260, 220);
        let out = place_widget_columns(
            &[&note],
            WORK_H,
            240,
            MIN_BOX_W,
            std::slice::from_ref(&wst),
            right_edge,
        );
        let note_rect = find_rect(&out, 2);
        assert!(
            !note_rect.intersects(&wst),
            "便签列压在常驻工作台上：{note_rect:?} vs {wst:?}"
        );
        assert_eq!(
            note_rect.x + note_rect.w,
            right_edge,
            "挂件带第一列的右沿 = 工作台禁区左沿 − 一道缝"
        );
        assert_eq!(note_rect.h, 220, "便签高度不该被禁区削（它本来就排在禁区左侧）");
    }

    /// **V68**：一个挂件都没有时，收纳区要**吃满**到工作台左沿前一道缝。
    ///
    /// 用户 09-22 第二条：「没有便签的时候便签列可以作为格子列使用」。差这 24px 看起来
    /// 是小事，但它可能正好让 [`column_capacity`] 少算出一列 ⇒ 格子往下摞出滚动条。
    #[test]
    fn with_no_widget_the_content_zone_reaches_the_workstation_edge() {
        let right_edge = 1251i64; // 真机：1707 工作区 − 400 工作台 − 32 边距 − 24 缝
        assert_eq!(
            content_zone_right(&[], right_edge),
            right_edge,
            "没有挂件时右沿就是硬右界本身 —— 不许再减一道缝（那是 V68 之前白白扔掉的 24px）"
        );

        // 有挂件时照旧在挂件带左沿前留一道缝
        let note = SlotRect { x: 991, y: 32, w: 260, h: 303 };
        assert_eq!(
            content_zone_right(std::slice::from_ref(&note), right_edge),
            note.x - ARRANGE_GAP_X,
            "有挂件时右沿 = 挂件带左沿 − 一道缝（V50 不变量，不能碰）"
        );

        // 多个挂件取最左那个（Column of widgets must be treated as a band）
        let calendar = SlotRect { x: 672, y: 32, w: 320, h: 460 };
        assert_eq!(
            content_zone_right(&[calendar, note], right_edge),
            calendar.x - ARRANGE_GAP_X,
            "挂件带左界取的是最靠左的那条列"
        );

        // 而少这一道缝真的会少一列：能开两列的宽度，减掉它就只剩一列了。
        // （正因为掉一列 = 格子往下摞 = 用户截图里那条滚动条，这条才必须钉住。）
        assert_eq!(
            column_capacity(2 * MIN_BOX_W + ARRANGE_GAP_X),
            2,
            "两条 MIN_BOX_W 宽的列 + 一道缝 = 两列"
        );
        assert_eq!(
            column_capacity(2 * MIN_BOX_W),
            1,
            "少一道缝就只装得下一列 —— V68 之前没有挂件时白扔的就是这一列"
        );
    }

    /// **V66 的核心**：列式填满 —— 放得下就一个像素都不越界（那正是「整层出滚动条」的根因）。
    #[test]
    fn content_plan_packs_into_columns_within_the_available_height() {
        // 真机那批形状：17 / 8 / 2 / 1 / 1 / 5 / 0 个条目，收纳区 935×848（1707×912 的工作区）。
        // V65 的「流式行」在这批数据上会排到 y≈946（越界 ⇒ 收纳区整层出滚动条）；
        // V66 必须把它们收进一屏之内，而且**不留行式空洞**。
        let items = [17usize, 8, 2, 1, 1, 5, 0];
        let zone_w = 935;
        let zone_h = 848;
        let plan = content_plan(&items, zone_w, zone_h, 32, ARRANGE_MARGIN);
        assert_eq!(plan.slots.len(), items.len(), "一个格子一个坑");
        let bottom = plan.slots.iter().map(|s| s.y + s.h).max().unwrap();
        assert!(
            bottom <= ARRANGE_MARGIN + zone_h,
            "放得下就不许越界（越界 = 收纳区整层出滚动条）：底沿 {bottom}"
        );
        assert!(plan.column_count() >= 2, "这批内容一列摞不下，至少要排两列");
        for s in &plan.slots {
            assert!(
                s.x >= ARRANGE_MARGIN && s.x + s.w <= ARRANGE_MARGIN + zone_w,
                "坑越出收纳区：{s:?}"
            );
        }
        for i in 0..plan.slots.len() {
            for j in (i + 1)..plan.slots.len() {
                assert!(
                    !plan.slots[i].intersects(&plan.slots[j]),
                    "坑 {i} 与 {j} 重叠：{:?} / {:?}",
                    plan.slots[i],
                    plan.slots[j]
                );
            }
        }
    }

    /// 格子多到「连最小高度都摞不下」时的兜底：压列高，**不把溢出甩给整层画布**。
    #[test]
    fn content_plan_only_overflows_when_even_minimum_heights_do_not_fit() {
        // 40 个「20 条目」的格子：宽度只容得下 capacity 列，每列要塞十几个 ——
        // 连 `MIN_BOX_H` 都摞不下，这时才允许越过下边界（前端收纳区滚动容器兜住）。
        let items = vec![20usize; 40];
        let plan = content_plan(&items, 850, 800, 48, 32);
        assert_eq!(plan.slots.len(), 40, "一个格子一个坑");
        assert!(
            plan.column_count() <= column_capacity(850),
            "列数不许超过宽度容量（否则会压到挂件带上）：{}",
            plan.column_count()
        );
        let thinnest = plan.slots.iter().map(|s| s.h).min().unwrap();
        assert!(thinnest >= MIN_BOX_H, "单个格子的高度不许被压到下限之下：{thinnest}");
        // V70：上限 = **本带可用高**（不再是固定 460）—— 超了才允许内部滚
        assert!(thinnest <= 800, "单个格子的高度不许越本带可用高（多的内容内部滚）：{thinnest}");
        for i in 0..plan.slots.len() {
            for j in (i + 1)..plan.slots.len() {
                assert!(!plan.slots[i].intersects(&plan.slots[j]), "坑 {i} 与 {j} 重叠");
            }
        }
    }

    /// V65 的成果**不许回滚**：面积与条目数成正比。
    #[test]
    fn content_plan_gives_more_items_a_larger_box() {
        // 彻底推翻 V64「1 条目占大空盒、17 条目挤小坑」的错配。
        let icon = 32;
        let zone_w = 1200;
        let zone_h = 848;
        let min_x = ARRANGE_MARGIN;
        let small = content_plan(&[1usize], zone_w, zone_h, icon, min_x);
        let big = content_plan(&[17usize], zone_w, zone_h, icon, min_x);
        assert_eq!(small.slots.len(), 1);
        assert_eq!(big.slots.len(), 1);
        let area_small = small.slots[0].w * small.slots[0].h;
        let area_big = big.slots[0].w * big.slots[0].h;
        assert!(
            area_big > area_small * 2,
            "17 个条目的格子面积必须明显大于 1 个条目的（{area_big} vs {area_small}）"
        );
    }

    /// 列内自上而下紧挨着摞、列与列横向错开，且两两不重叠（V66）。
    #[test]
    fn content_plan_stacks_boxes_down_columns_without_overlap() {
        let icon = 32;
        let zone_w = 1000;
        let min_x = ARRANGE_MARGIN;
        let items = [1usize, 17, 8, 2, 30, 5, 21];
        let plan = content_plan(&items, zone_w, 848, icon, min_x);
        assert_eq!(plan.slots.len(), items.len(), "一个格子一个坑");
        for i in 0..plan.slots.len() {
            for j in (i + 1)..plan.slots.len() {
                assert!(
                    !plan.slots[i].intersects(&plan.slots[j]),
                    "坑 {i} 与 {j} 重叠：{:?} / {:?}",
                    plan.slots[i],
                    plan.slots[j]
                );
            }
        }
        // 同一列：`x` 相同、`y` 严格递增（自上而下紧挨着 —— 不再是 V65 的「同一行顶部对齐」）
        let mut xs: Vec<i64> = plan.slots.iter().map(|s| s.x).collect();
        xs.sort_unstable();
        xs.dedup();
        assert!(xs.len() >= 2, "这批内容一列摞不下，应当排成多列");
        for x in xs {
            let mut ys: Vec<i64> = plan.slots.iter().filter(|s| s.x == x).map(|s| s.y).collect();
            ys.sort_unstable();
            let n = ys.len();
            ys.dedup();
            assert_eq!(ys.len(), n, "同一列里有两个格子落在同一个 y 上：x={x}");
        }
    }

    /// **V69 的核心**：摆放序 = 大的先占位；同尺寸时按登记顺序（稳定排序）。
    ///
    /// 钉的是用户 09-23 那张截图：**两个空的「新格子」先登记，11 个条目的「文档」后登记** ——
    /// 旧的保序切段把空格子放在第一列顶端、把「文档」顶到它们下面。
    #[test]
    fn the_biggest_box_is_placed_first() {
        let items = [0usize, 0, 11, 1];
        let sizes = own_sizes(&items, 935, 848, 32);
        let order = placement_order(&items, &sizes);
        assert_eq!(
            order[0], 2,
            "条目最多的「文档」必须排第一 —— 与它第几个登记无关：{order:?}"
        );
        assert_eq!(
            order[1], 3,
            "1 个条目的盒子必须排在空格子前面（内容更多、更该先占位）：{order:?}"
        );
        assert_eq!(&order[2..4], &[0, 1], "两个空格子并列时保持登记顺序：{order:?}");

        // 判据里不许掺「格子现在停在哪」：同尺寸的两个格子换个输入顺序，落位集合不变
        let swapped = [0usize, 0, 11, 1];
        let mut flipped = swapped;
        flipped.swap(0, 1);
        assert_eq!(
            placement_order(&flipped, &own_sizes(&flipped, 935, 848, 32))
                .iter()
                .map(|&i| own_sizes(&flipped, 935, 848, 32)[i])
                .collect::<Vec<_>>(),
            placement_order(&items, &sizes).iter().map(|&i| sizes[i]).collect::<Vec<_>>(),
            "两个空格子谁先登记都不改变尺寸序列（⇒ 落位一模一样）"
        );
    }

    /// **把「前端几何」显式建模**（V70）：引擎给的尺寸落进前端的网格之后，到底排得下几列几行。
    ///
    /// ⚠️ 这里**刻意不引用** [`BOX_HEADER_H`] / [`BOX_FIT_SLACK`] 之外的引擎常量 ——
    /// 尤其是标题栏那 1px：它必须写成**前端真实结构**（`h-9` 的 36 ＋ `border-b` 的 1）。
    /// 若两边共用一个常量，把 `BOX_HEADER_H` 改回旧值这条校验照样通过，那就成了自证。
    fn frontend_capacity(w: i64, h: i64, icon: i64) -> (i64, i64) {
        /// 前端标题栏：`className="flex h-9 … border-b border-white/[0.06]"` ⇒ 36 + 1。
        const FRONTEND_HEADER_H: i64 = 36 + 1;
        let cell_w = icon + CELL_EXTRA_W;
        let cell_h = icon + BOX_CELL_EXTRA_H;
        // 内容区 = 外框 − 上下边框 − 标题栏 − 内边距；宽度还要再减**滚动槽**（恒占位）
        let inner_w = w - BOX_BORDER_H - 2 * GRID_PAD_X - GRID_SCROLLBAR_W;
        let inner_h = h - BOX_BORDER_H - FRONTEND_HEADER_H - 2 * GRID_PAD_Y;
        let cols = ((inner_w + GRID_GAP) / (cell_w + GRID_GAP)).max(1);
        let rows = ((inner_h + GRID_GAP) / (cell_h + GRID_GAP)).max(0);
        (cols, rows)
    }

    /// **V70 的核心**：引擎算出来的自然尺寸，必须让前端把**全部条目**都排出来。
    ///
    /// 用户 09-23：「我删除了很多格子后空间多了，应该重新计算大小，**尽可能让所有图标都直接
    /// 展示出来，没有滚动条**，除非是格子太多图标太多放不下了」。
    ///
    /// 这条断言把这句话变成可执行的：只要这条带装得下，引擎给的自然尺寸就得让前端
    /// 「列 × 行 ≥ 条目数」。V69 及以前它**恒不成立**（引擎按 5 列 × 4 行算，前端因为
    /// 少了 1px 只排得出 4 列 × 4 行 = 16 格，18 个图标藏了 2 个）—— 见 [`BOX_HEADER_H`]。
    #[test]
    fn every_natural_box_size_really_shows_all_of_its_items() {
        let icon = 32;
        // 真机收纳区：可用宽 637、可用高 848（handy.log：1707×912、挂件带左界 991）
        let (zone_w, zone_h) = (637, 848);
        for &items in [1usize, 4, 8, 11, 16, 17, 18, 21, 30, 43].iter() {
            let (w, h) = box_own_size(items, zone_w, zone_h, icon);
            let (cols, rows) = frontend_capacity(w, h, icon);
            assert!(
                cols * rows >= items as i64,
                "{items} 个条目在 {w}×{h} 里排不下：前端只排得出 {cols} 列 × {rows} 行 = {} 格 —— \
                 用户会看到图标被藏起来 + 滚动条",
                cols * rows
            );
            // 高度也不许超过这条带：超了就是「一个格子吃掉整屏」
            assert!(h <= zone_h, "{items} 个条目的高度 {h} 越过本带可用高 {zone_h}");
        }
    }

    /// 「按 N 列算出来的宽度」必须真能让前端排出 N 列（**往返闭环**）。
    ///
    /// V70 之前这条闭环是断的：`box_width_for_columns` 没算滚动槽，前端一旦滚起来就少一列。
    #[test]
    fn the_width_for_n_columns_really_yields_n_columns() {
        for icon in [16i64, 24, 32, 48, 96] {
            for cols in 1..=AUTO_MAX_COLS {
                let w = box_width_for_columns(cols, icon);
                assert_eq!(
                    item_columns_at(w, icon),
                    cols,
                    "icon={icon}：按 {cols} 列算出来的宽度 {w} 前端却排不出 {cols} 列"
                );
                // 也得让**前端的几何**同意（含滚动槽后的真实可用宽）
                assert_eq!(frontend_capacity(w, 9999, icon).0, cols);
            }
        }
    }

    /// 空间富余 ⇒ 长到全见；空间紧张 ⇒ 才允许内部滚（用户 09-23 那句「除非…放不下了」）。
    #[test]
    fn a_box_grows_to_show_everything_before_it_is_allowed_to_scroll() {
        let icon = 32;
        let items = 43usize;
        // 宽裕：43 个图标全部排出来（不再是 V69 那个固定 460 的上限把它切成 6 行）
        let (w, h) = box_own_size(items, 637, 848, icon);
        let (cols, rows) = frontend_capacity(w, h, icon);
        assert!(cols * rows >= items as i64, "空间够时必须全见：{cols}×{rows}");
        // 紧张：这条带只给 300 高 ⇒ 才轮到「压高 + 内部滚」
        let (_, tight) = box_own_size(items, 637, 300, icon);
        assert!(tight <= 300, "高度不许越过这条带的可用高：{tight}");
        assert!(
            frontend_capacity(w, tight, icon).1 < rows,
            "被压矮之后能显示的行数必须真的变少（否则这条用例什么也没测）"
        );
    }

    /// `pack_columns`：每个格子放进「**当前最矮的那一列**」—— 这就是「小格子找空隙插入」。
    #[test]
    fn small_boxes_fill_the_shortest_column() {
        // 三个大格子（400 高）各占一列，三个小格子（40 高）分别补进这三条列
        let heights = [400i64, 400, 400, 40, 40, 40];
        let cols = pack_columns(&heights, 3);
        assert_eq!(
            cols,
            vec![vec![0usize, 3], vec![1, 4], vec![2, 5]],
            "大格子先各占一列，小格子按「最矮的那一列」依次补进去：{cols:?}"
        );
        // 补完之后三条列等高（LPT 的平衡性）—— 不再是「第一列塞满、最后一列孤零零」
        let col_h = |c: &Vec<usize>| {
            c.iter().map(|&i| heights[i]).sum::<i64>() + (c.len() as i64 - 1).max(0) * ARRANGE_GAP_Y
        };
        let hs: Vec<i64> = cols.iter().map(col_h).collect();
        assert_eq!(hs, vec![464, 464, 464], "三条列必须一样高：{hs:?}");
        assert!(hs.iter().all(|h| *h < 400 + 40 + ARRANGE_GAP_Y + 1), "没有哪一列被塞爆");

        // 空集 / k 超过格子数都不许 panic（空列不占宽度由 `packed_total_width` 负责）
        assert!(pack_columns(&[], 3).iter().all(|c| c.is_empty()));
        assert_eq!(pack_columns(&[100, 200], 5).iter().filter(|c| !c.is_empty()).count(), 2);
    }

    /// **带下空间仍然活着**（V68 的能力，V69 换摆放序之后必须还在）。
    ///
    /// V69 的分列更紧凑，真机那批 17 个格子正好 3 列装下 ⇒ 不再需要带下那条；所以那条路
    /// 改由这条用例直接钉：上带装不下时，多出来的格子必须住进**挂件下方**那块地方。
    #[test]
    fn the_lower_band_hosts_boxes_when_the_upper_band_cannot_hold_them_all() {
        // 上带 = 便签左侧（600 宽，整幅高）；带下那条 = 便签下方（236 × 521，真机量级）
        let items = vec![20usize; 12];
        let band_a = SlotRect {
            x: ARRANGE_MARGIN,
            y: ARRANGE_MARGIN,
            w: 600,
            h: 848,
        };
        let band_b = SlotRect {
            x: 991,
            y: 359,
            w: 236,
            h: 521,
        };
        let plan = content_plan_with_lower_band(&items, band_a, Some(band_b), 32);
        assert_eq!(plan.slots.len(), items.len(), "一个格子一个坑");

        // ① 带下那条真的住进去了（判据用「x 越出上带右沿」而不是「y 够低」——
        //    上带里的格子也可能排到很下面，只看 y 会误判成「用上了带下空间」）
        let in_lower: Vec<&SlotRect> = plan
            .slots
            .iter()
            .filter(|s| s.x + s.w > band_a.x + band_a.w && s.y >= band_b.y)
            .collect();
        assert!(
            !in_lower.is_empty(),
            "上带（600×848）明知装不下，却一个格子都没挪到便签下方那条带：{:?}",
            plan.slots
        );
        // 落在带下的必须真的在那块矩形里
        for s in &in_lower {
            assert!(
                s.x >= band_a.x && s.x + s.w <= band_b.x + band_b.w,
                "带下的格子越出了那块地方：{s:?}"
            );
            assert!(s.y + s.h <= band_b.y + band_b.h, "带下的格子越出下沿：{s:?}");
        }
        assert!(!plan.overflowed, "两条带合起来仍然放不下 ⇒ 整层又要出滚动条");

        // ② 两次调用逐像素一致（摆放序是内容的纯函数 ⇒ 幂等不靠几何去兜）
        let again = content_plan_with_lower_band(&items, band_a, Some(band_b), 32);
        let snap = |p: &ContentPlan| -> Vec<(i64, i64, i64, i64)> {
            p.slots.iter().map(|s| (s.x, s.y, s.w, s.h)).collect()
        };
        assert_eq!(snap(&plan), snap(&again), "同一个输入排两次结果不同");

        // ③ 没有带下空间时（`band_b = None`）就是纯粹的单带排布 —— 不许越界
        let solo = content_plan_with_lower_band(&items, band_a, None, 32);
        assert_eq!(solo.slots.len(), items.len());
        assert!(
            solo.slots.iter().all(|s| s.x + s.w <= band_a.x + band_a.w),
            "单带排布不许越出上带右沿"
        );
    }

    /// 单列/多列的归属表（V50）：日历与便签恒定单列，只有 `Other` 允许多列。
    #[test]
    fn only_unknown_widgets_may_open_more_than_one_column() {
        assert!(zone_single_column(widget_zone("calendar")));
        assert!(zone_single_column(widget_zone("note")));
        assert!(!zone_single_column(widget_zone("weather")), "没登记的挂件允许多列");
    }

    #[test]
    fn a_overflowing_column_shrinks_instead_of_pushing_boxes_off_screen() {
        // 用户 09-19 第 4 条：「务必保证所有的内容不能重叠，可以有滚动条，但是不能图标重叠」——
        // 一列装不下时**压高度**（格子内部滚动），而不是把最后一个格子摆到屏幕外。
        let natural = [400i64, 400, 400];
        let heights = fit_column_heights(&natural, 500);
        assert_eq!(heights.len(), 3);
        let total: i64 = heights.iter().sum::<i64>() + 2 * ARRANGE_GAP_Y;
        assert!(total <= 500, "压缩后必须整列装得下：{heights:?}");
        assert!(heights.iter().all(|h| *h >= MIN_BOX_H), "不得压到最小高度以下");
        // 装得下时一动不动（幂等的前提）
        assert_eq!(fit_column_heights(&natural, 2000), natural.to_vec());
    }

    #[test]
    fn default_position_means_the_box_was_never_placed() {
        // 新建挂件落在 `grid_box_upsert` 的默认位 (32,32) —— 正好压在左侧竖条上，
        // 用户看不到自己的新便签（V47 实测）。它必须被判为「还没落位」。
        let mut fresh = sample_rect(1, "note", 260, 220);
        fresh.x = ARRANGE_MARGIN;
        fresh.y = ARRANGE_MARGIN;
        assert!(needs_placement(
            &fresh,
            std::slice::from_ref(&fresh),
            NO_WIDGET_BAND,
            i64::MAX,
            ARRANGE_MARGIN,
            WORK_W,
            WORK_H
        ));
    }

    #[test]
    fn overlapping_or_out_of_area_boxes_need_placement_but_tidy_ones_do_not() {
        // 真机数据：三个便签全在 (1415,692) ⇒ 互相重叠 ⇒ 都算「还没落位」，
        // 下一次普通整理会把它们安置到便签列里（这就是「三便签重叠」的修复入口）。
        let mut a = sample_rect(1, "note", 260, 220);
        let mut b = sample_rect(2, "note", 260, 220);
        a.x = 1415;
        a.y = 692;
        b.x = 1415;
        b.y = 692;
        assert!(needs_placement(
            &a,
            &[a.clone(), b.clone()],
            NO_WIDGET_BAND,
            i64::MAX,
            ARRANGE_MARGIN,
            WORK_W,
            WORK_H
        ));

        // 两个收纳格（不重叠、在区内、不跨挂件带）**不算**未落位 —— 但它们是否被保留
        // 还要看 `manual`（V50：引擎摆过的一律重新对齐到列网格，见 layout_pipeline_tests）。
        let mut c = sample_rect(3, "folder", 300, 200);
        let mut d = sample_rect(4, "folder", 300, 200);
        c.x = 400;
        c.y = 100;
        d.x = 750;
        d.y = 100;
        assert!(!needs_placement(
            &c,
            &[c.clone(), d.clone()],
            NO_WIDGET_BAND,
            i64::MAX,
            ARRANGE_MARGIN,
            WORK_W,
            WORK_H
        ));

        // 改过分辨率之后跑到区外的格子同样要重新安置
        let mut far = sample_rect(5, "folder", 300, 200);
        far.x = WORK_W + 10;
        far.y = 100;
        assert!(needs_placement(
            &far,
            std::slice::from_ref(&far),
            NO_WIDGET_BAND,
            i64::MAX,
            ARRANGE_MARGIN,
            WORK_W,
            WORK_H
        ));

        // —— V49 新增判据：**侵占了左侧「未归类」竖条**的格子必须重新安置 ——
        // 真机事故：新建便签落在 (32, 40)，只差一点就绕过上面几条判据（它不重叠、
        // 也不越界），于是被判成「用户摆好的」保留下来，把挂件带左界拉到 32，
        // 收纳区宽度当场算成负数 —— 用户看到「一堆格子跑到屏幕最左边」。
        let mut intruder = sample_rect(6, "note", 260, 220);
        intruder.x = ARRANGE_MARGIN;
        intruder.y = ARRANGE_MARGIN + 8;
        assert!(
            needs_placement(
                &intruder,
                std::slice::from_ref(&intruder),
                NO_WIDGET_BAND,
                i64::MAX,
                ARRANGE_MARGIN + 300,
                WORK_W,
                WORK_H
            ),
            "压在左侧竖条上的格子必须被判为「还没落位」"
        );
    }

    /// **V50 核心判据**：收纳格**跨进挂件带**就算「还没落位」。
    ///
    /// 真机事故（用户 09-19 截图）：便签列摆在 `x=1071`，而「安装包 / 图片」停在
    /// `x=1031`（宽 300 ⇒ 右沿 1331）—— 横向区间与便签列重叠，纵向却错开
    /// （便签 30..250 / 安装包 366..486），于是便签悬在两个格子正上方，用户看到的就是
    /// 「便签跟格子挤在同一列里」。V49 只查「与挂件矩形重叠」，整条漏了过去。
    #[test]
    fn a_content_box_crossing_into_the_widget_band_needs_placement() {
        // 挂件带左沿 1071（真机日志里的值），收纳格右沿最多到 1071 - 24 = 1047
        let band_left = 1071i64;
        let mut intruder = sample_rect(1, "folder", 300, 120);
        intruder.x = 1031;
        intruder.y = 366;
        assert!(
            needs_placement(
                &intruder,
                std::slice::from_ref(&intruder),
                band_left,
                i64::MAX,
                ARRANGE_MARGIN,
                WORK_W,
                WORK_H
            ),
            "跨进挂件带的收纳格必须重新安置（用户「便签不要跟格子挤在一起」）"
        );

        // 贴着挂件带左沿右侧留出列间距的格子是合法位置（右沿正好 1047）
        let mut hugging = sample_rect(2, "folder", 300, 120);
        hugging.x = band_left - ARRANGE_GAP_X - 300;
        hugging.y = 366;
        assert!(
            !needs_placement(
                &hugging,
                std::slice::from_ref(&hugging),
                band_left,
                i64::MAX,
                ARRANGE_MARGIN,
                WORK_W,
                WORK_H
            ),
            "紧贴挂件带左界的格子是合法的"
        );
    }
}
/// **端到端预演**：用「用户机器上真实库的形状」跑一遍完整排布，检查「整齐」的硬条件。
///
/// 为什么还要这一层：`flow_placer_tests` 断的都是单个函数的性质，而用户看到的「乱」
/// 是**整批布局的结果** —— 列宽各算各的（160/228/300 混着）+ 靠右流布 + 系统格被当挂件，
/// 三者叠加才是那团乱麻。这里建一份临时库，把用户库当前的 11 个格子（名称 / kind /
/// 条目数 / V39 遗留的参差宽度与散落坐标）原样灌进去，跑一遍 [`layout_all_boxes`]，
/// 直接断言「整理之后长什么样」。
///
/// 刻意**不依赖 Windows API**，也**不碰用户的真实库**（临时文件，跑完即删）。
#[cfg(test)]
mod layout_pipeline_tests {
    use super::{
        probe_room_for_another_box, workstation_rect, layout_all_boxes_with, LayoutMode, SlotRect,
        item_columns_at, ARRANGE_GAP_X, ARRANGE_GAP_Y, ARRANGE_MARGIN, AUTO_MAX_W,
        BOX_BORDER_H, BOX_CELL_EXTRA_H, BOX_FIT_SLACK, BOX_HEADER_H, GRID_GAP, GRID_PAD_Y,
        INSERT_BOX_SQL, MIN_BOX_H, MIN_BOX_W,
    };
    use rusqlite::{params, Connection};
    use std::path::PathBuf;

    /// 用户机器上的工作区（逻辑像素）—— 取自 handy.log：`整理布局：工作区 1707×912`。
    const WORK_W: i64 = 1707;
    const WORK_H: i64 = 912;
    const ICON: i64 = 32;

    /// 用户库里当时的格子：(名称, kind, 条目数, 遗留宽度, 遗留高度) —— 顺序即 `sort`。
    ///
    /// 坐标不写死（第一遍会被排布覆盖），但宽度**照抄 V39 的真实值**：正是这堆
    /// 160 / 228 / 300 让桌面看着没对齐。
    /// **V42 起库里不再有「系统」「快捷方式」两格**：它们被 [`dissolve_auto_boxes`]
    /// 解散了（那两类现在排在左侧竖条里，不进格子）。所以这份样本也照 V42 之后的
    /// 真实形状来 —— 9 格：2 个挂件 + 7 个分类格。
    ///
    /// ⚠️ V56 把日历那格的高度从历史值 638 换成**这台机器当前的真值 503**
    /// （`grid-boxes-dump.py`：`日历 x=1355 y=32 w=320 h=503`）。原因见下面那条断言：
    /// 右下角多了快捷入口那颗格子的保留区（上沿在 y=560）之后，638 会被压到 504 ——
    /// 那是**对的**行为，但把它留在这个「列位/宽度对齐」的用例里只会掩盖断言的真实意图。
    /// 保留区本身由 `no_box_ever_covers_the_bottom_right_launcher` 专门守。
    /// ⚠️ **V60 起样本里不再有 `calendar` 盒子** —— 日历被并进常驻「工作台」浮窗
    /// （用户 09-21：「日历可以修改为工作台，把快捷入口这些都可以整合到工作台里面」），
    /// 产品路径不再创建它，端到端样本因此同步去掉。引擎对 `calendar` kind 的几何支持仍保留，
    /// 由 `flow_placer_tests` 那组纯几何单测覆盖（它们不依赖产品是否还有这个入口）。
    const REAL_BOXES: [(&str, &str, usize, i64, i64); 8] = [
        ("便签", "note", 0, 260, 220),
        ("文档", "folder", 16, 300, 310),
        ("其他", "folder", 8, 228, 244),
        ("压缩包", "folder", 2, 160, 120),
        ("安装包", "folder", 1, 160, 120),
        ("图片", "folder", 1, 160, 120),
        ("文件夹", "folder", 3, 160, 178),
        ("新格子 3", "folder", 0, 160, 120),
    ];

    /// 一份跑完整迁移的临时库（文件名带进程号，跑完即删）。
    fn temp_conn(tag: &str) -> (PathBuf, Connection) {
        let mut path = std::env::temp_dir();
        path.push(format!("handy-layout-test-{tag}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).expect("打开临时库失败");
        crate::db::migrations::run(&conn).expect("应用迁移失败");
        (path, conn)
    }

    /// 灌入用户库的真实形状（坐标散落成 V39 那次的现场）。
    fn seed_real_boxes(conn: &Connection) {
        // 散落的旧坐标：正是「点了整理还是一团乱」时库里的样子
        let stale = [
            (32i64, 660i64),
            (403, 32),
            (799, 176),
            (867, 32),
            (867, 444),
            (1191, 694),
            (1515, 694),
            (867, 588),
        ];
        for (sort, (name, kind, items, w, h)) in REAL_BOXES.iter().enumerate() {
            let (x, y) = stale[sort];
            conn.execute(
                "INSERT INTO grid_boxes \
                 (name, kind, category, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                 VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![name, kind, x, y, w, h, sort as i64, "2026-09-17T21:29:03"],
            )
            .expect("插入格子失败");
            let box_id = conn.last_insert_rowid();
            for i in 0..*items {
                conn.execute(
                    "INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        box_id,
                        format!("C:\\Users\\Administrator\\Desktop\\item-{box_id}-{i}"),
                        format!("条目 {i}"),
                        i as i64,
                        "2026-09-17T21:29:03"
                    ],
                )
                .expect("插入条目失败");
            }
        }
    }

    /// 读回的一行格子。
    ///
    /// **刻意用具名字段而不是元组**：本测试第一版就是元组列序写错（`read_boxes` 第一列
    /// 返回的是 `kind`，断言却当成 `name` 用 —— `"快捷方式"` 与 `"folder"` 都是 `String`，
    /// 编译器一声不吭，只在运行期炸出「找不到格子」），改成结构体后这类错误不可能再发生。
    #[derive(Debug)]
    struct BoxRow {
        name: String,
        kind: String,
        x: i64,
        y: i64,
        w: i64,
        h: i64,
        /// 条目数 —— V69 的「列内按大小递减」判据用它（内容是用户的原话，像素还会被列宽夹一层）。
        items: i64,
    }

    /// 读回所有格子（按 `sort, id` 排序 —— 与 [`layout_all_boxes`] 的遍历顺序一致）。
    fn read_boxes(conn: &Connection) -> Vec<BoxRow> {
        let mut stmt = conn
            .prepare(
                "SELECT b.name, b.kind, b.pos_x, b.pos_y, b.width, b.height, \
                        (SELECT COUNT(*) FROM grid_items i WHERE i.box_id = b.id) \
                 FROM grid_boxes b ORDER BY b.sort ASC, b.id ASC",
            )
            .expect("读取格子失败");
        let rows = stmt
            .query_map([], |row| {
                Ok(BoxRow {
                    name: row.get(0)?,
                    kind: row.get(1)?,
                    x: row.get(2)?,
                    y: row.get(3)?,
                    w: row.get(4)?,
                    h: row.get(5)?,
                    items: row.get(6)?,
                })
            })
            .expect("读取格子失败");
        rows.map(|r| r.expect("格子行读取失败")).collect()
    }

    fn is_content(kind: &str) -> bool {
        super::is_content_kind(kind)
    }

    /// **V69 的核心不变量**：同一条列里，格子**自上而下按内容量递减**。
    ///
    /// 这就是用户 09-23 那句「先把大格子算了布局好，然后把小格子找空隙插入」的可检验形式 ——
    /// 大格子先占位，小格子只能补在它下面。旧算法（按登记顺序保序切段）在真机上恰恰相反：
    /// 两个**空的**「新格子」坐在第一列顶端，11 个条目的「文档」被顶到它们下面。
    ///
    /// 判据用**条目数**而不是像素：条目数是内容的原话，像素还会被列宽夹一层。
    fn assert_columns_are_size_ordered(content: &[&BoxRow]) {
        let mut xs: Vec<i64> = content.iter().map(|b| b.x).collect();
        xs.sort_unstable();
        xs.dedup();
        for x in xs {
            let mut col: Vec<&BoxRow> = content.iter().filter(|b| b.x == x).copied().collect();
            col.sort_by_key(|b| b.y);
            for pair in col.windows(2) {
                assert!(
                    pair[0].items >= pair[1].items,
                    "同一列（x={x}）里「{}（{} 项）」压在「{}（{} 项）」上面 —— \
                     大格子必须先占位，小格子补在下面（V69）",
                    pair[0].name,
                    pair[0].items,
                    pair[1].name,
                    pair[1].items
                );
            }
        }
    }

    /// 一批格子的**落位指纹**（名字 + 坐标 + 尺寸）—— 判「排两遍一模一样」用。
    fn snap(conn: &Connection) -> Vec<(String, i64, i64, i64, i64)> {
        read_boxes(conn)
            .into_iter()
            .map(|b| (b.name, b.x, b.y, b.w, b.h))
            .collect()
    }

    /// **V66 关键回归：增量重排必须幂等** —— 否则每次挂载 / 拖动结束 / 放进一个文件，
    /// 格子都会在两套排法之间来回翻。
    ///
    /// 真机数据上确实会翻：列式布局的落位顺序是「列优先」，而 V65 留下的读序是「先行后列」
    /// `(y, x)`、两者不同构 ⇒ 第二遍算出来的序列与第一遍不同 ⇒ A→B→A→B 循环。
    /// 这条用例就是钉住「读序与落位同构」这个不变量（`layout_all_boxes_with` 里有对应的注释）。
    #[test]
    fn incremental_relayout_is_idempotent_with_columns() {
        let (path, conn) = temp_conn("col-idem");
        seed_real_boxes(&conn);

        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Full).expect("首排失败");
        let first = layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Fill)
            .expect("增量排布失败");
        assert_eq!(first.moved, 0, "首排之后做一次增量整理不该再挪动任何格子");
        assert_eq!(first.resized, 0, "首排之后做一次增量整理不该再改尺寸");

        let baseline = snap(&conn);
        for round in 1..=3 {
            let again = layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Fill)
                .expect("增量排布失败");
            assert_eq!(
                again.moved, 0,
                "第 {round} 次增量整理挪动了格子 —— 读序与落位不同构时就会 A→B→A→B 来回翻"
            );
            assert_eq!(again.resized, 0, "第 {round} 次增量整理改了尺寸");
            assert_eq!(
                snap(&conn),
                baseline,
                "第 {round} 次增量整理的落位与上一次不一致（幂等性被破坏）"
            );
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn real_desktop_data_lays_out_in_aligned_columns() {
        let (path, conn) = temp_conn("align");
        seed_real_boxes(&conn);
        // 落单条目注入 0：端到端预演不依赖跑测试那台机器的桌面长什么样
        let outcome = layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Full).expect("排布失败");
        let boxes = read_boxes(&conn);
        let _ = std::fs::remove_file(&path);

        assert!(outcome.moved > 0, "散落的旧坐标必须被重排");
        assert_eq!(outcome.overflowed, 0, "1707×912 排得下这 11 个格子");
        assert!(
            outcome.anchored >= 1,
            "挂件必须被安置进各自的竖列（V48）；实际挪动 {} 个 —— \
             本样本里日历本来就落在它的列位上，便签必须从散落坐标挪走",
            outcome.anchored
        );

        let content: Vec<&BoxRow> = boxes.iter().filter(|b| is_content(&b.kind)).collect();
        assert_eq!(content.len(), 7, "7 个分类格（V42：系统 / 快捷方式不再建格）");
        assert!(
            boxes.iter().all(|b| b.kind != "system"),
            "V42 起库里不该再有「系统」格"
        );

        // 硬条件 ①（V66）：**列式排布** —— 同一列的格子左沿（x）相同、列内自上而下紧挨着摞，
        // 列与列之间横向错开。V65 的「行带」模型已被用户否掉（行内 / 行尾留白，
        // 且总高很容易越过一屏 ⇒ 收纳区整层出滚动条）。
        let mut xs: Vec<i64> = content.iter().map(|b| b.x).collect();
        xs.sort_unstable();
        xs.dedup();
        assert!(
            xs.len() >= 2,
            "本样本（16 / 8 / 2 / 1 …）至少要排出两列，实际 x = {xs:?}"
        );
        // V68：挂件带左沿 / 下沿 —— 用来区分「挂件左侧那条带」（从收纳区上沿起排）
        // 与「挂件**下方**那条带」（从挂件下沿起排）。
        let widgets_all: Vec<&BoxRow> = boxes.iter().filter(|b| !is_content(&b.kind)).collect();
        let widget_left = widgets_all.iter().map(|b| b.x).min().expect("本批至少有一个挂件");
        // V85 右锚定：最右一列贴着收纳区右沿（= 挂件带左沿 − 一道缝），
        // 排完后剩余的空间留在左边给「未归类」竖条 / 快捷方式。
        let zone_right = widget_left - ARRANGE_GAP_X;
        let used_right = content.iter().map(|b| b.x + b.w).max().unwrap();
        assert_eq!(
            used_right, zone_right,
            "最右一列必须贴着收纳区右沿（V85 右锚定），实际只到 {used_right} / 右沿 {zone_right}"
        );
        let band_bottom = widgets_all.iter().map(|b| b.y + b.h).max().unwrap() + ARRANGE_GAP_Y;
        for x in &xs {
            let mut ys: Vec<i64> = content.iter().filter(|b| b.x == *x).map(|b| b.y).collect();
            ys.sort_unstable();
            let n = ys.len();
            ys.dedup();
            assert_eq!(ys.len(), n, "同一列（x={x}）里有两个格子落在同一个 y 上：{ys:?}");
            if ys[0] == ARRANGE_MARGIN {
                // 挂件左侧那条带：从收纳区上沿起排
            } else {
                // V68 的「带下空间」：这条列住在挂件带**下方**，起点是挂件下沿 + 一道缝。
                // 注意它的 `x` **可能小于挂件带左沿**（带下那条的左沿跟着上带实际用到的
                // 右沿走，见 [`content_plan_with_lower_band`]），所以判据只能看 `y`。
                assert!(
                    ys[0] >= band_bottom,
                    "列的起点既不是收纳区上沿也没落在挂件带下沿（{band_bottom}）之下：x={x} y={}",
                    ys[0]
                );
            }
        }
        // 列内相邻两格之间只有一道 `ARRANGE_GAP_Y` 的缝 —— 不许有 V65 那种「行式空洞」
        for x in &xs {
            let mut col: Vec<&BoxRow> = content.iter().filter(|b| b.x == *x).copied().collect();
            col.sort_by_key(|b| b.y);
            for pair in col.windows(2) {
                assert_eq!(
                    pair[1].y,
                    pair[0].y + pair[0].h + ARRANGE_GAP_Y,
                    "同一列里「{}」与「{}」之间不是紧挨着的（列内不许留空）",
                    pair[0].name,
                    pair[1].name
                );
            }
        }
        // 列与列之间横向让开一道 `ARRANGE_GAP_X`
        for pair in xs.windows(2) {
            let left_right = content
                .iter()
                .filter(|b| b.x == pair[0])
                .map(|b| b.x + b.w)
                .max()
                .unwrap();
            assert_eq!(
                left_right + ARRANGE_GAP_X,
                pair[1],
                "列与列之间的横向间隔不对：{pair:?}"
            );
        }

        for b in &content {
            assert!(
                (MIN_BOX_W..=AUTO_MAX_W).contains(&b.w),
                "宽度必须落在 [{MIN_BOX_W}, {AUTO_MAX_W}] 内：「{}」是 {}",
                b.name,
                b.w
            );
            // V70：高度上限不再是固定常数 —— 就是**这条带的可用高**（桌面高减上下边距）
            assert!(
                (MIN_BOX_H..=WORK_H - 2 * ARRANGE_MARGIN).contains(&b.h),
                "高度必须落在 [{MIN_BOX_H}, {}] 内：「{}」是 {}",
                WORK_H - 2 * ARRANGE_MARGIN,
                b.name,
                b.h
            );
        }

        // 硬条件 ②：**尺寸跟着内容走**（V65 的成果，不许回滚）—— 用户第二轮反馈原话：
        // 「我图片只有一个，你搞那么大的空间做什么，有些格子图标更多，还占着同样的大小的格子」。
        let busy = content.iter().find(|b| b.name == "文档").expect("文档格");
        let tiny = content.iter().find(|b| b.name == "图片").expect("图片格");
        assert!(
            tiny.w * tiny.h < busy.w * busy.h * 3 / 4,
            "「图片」只有 1 个条目，面积必须远小于 16 个条目的「文档」：\
             {tiny_name} {}×{}={} vs {busy_name} {}×{}={}",
            tiny.w,
            tiny.h,
            tiny.w * tiny.h,
            busy.w,
            busy.h,
            busy.w * busy.h,
            tiny_name = tiny.name,
            busy_name = busy.name
        );
        let tallest_h = content.iter().map(|b| b.h).max().unwrap();
        let shortest_h = content.iter().map(|b| b.h).min().unwrap();
        assert!(
            tallest_h > shortest_h,
            "内容多的格子必须比内容少的高（否则又退回「格子一样大」）：{tallest_h} vs {shortest_h}"
        );

        // V68：`widget_left` / `band_bottom` 已在硬条件① 那里算过（带下空间要按「左侧那条带」
        // 与「下方那条带」分开判），这里直接用。
        for b in &content {
            assert!(
                b.x + b.w <= widget_left || b.y >= band_bottom,
                "「{}」横向侵入了挂件区（右沿 {} > 挂件带左沿 {widget_left}）——就是「跑到日历下面」那个错位；\
                 除非它整个落在挂件带下沿（{band_bottom}）之下（V68 带下空间），但它 y={}",
                b.name,
                b.x + b.w,
                b.y
            );
        }

        // 硬条件 ②b（**V66 新增，这条正是用户 09-22 的原话**）：
        // 「整个桌面整体怎么还变成有滚动条的了」—— 根因就是这里的底沿越过了工作区下沿。
        // 放得下的时候**一个像素都不许越**（真越界只可能发生在「格子多到连 MIN_BOX_H 都摞不下」）。
        let content_bottom = content.iter().map(|b| b.y + b.h).max().unwrap();
        assert!(
            content_bottom <= WORK_H - ARRANGE_MARGIN,
            "收纳区底沿 {content_bottom} 越过工作区下沿 {} —— 那会让整个收纳区出滚动条",
            WORK_H - ARRANGE_MARGIN
        );

        // 硬条件 ③：全部落在工作区内，且两两不重叠（挂件也算进来）
        let rects: Vec<(&str, SlotRect)> = boxes
            .iter()
            .map(|b| {
                (
                    b.name.as_str(),
                    SlotRect {
                        x: b.x,
                        y: b.y,
                        w: b.w,
                        h: b.h,
                    },
                )
            })
            .collect();
        for b in &boxes {
            let r = SlotRect { x: b.x, y: b.y, w: b.w, h: b.h };
            assert!(r.x >= ARRANGE_MARGIN, "「{}」越出左边界", b.name);
            assert!(r.y >= ARRANGE_MARGIN, "「{}」越出上边界", b.name);
            assert!(
                r.x + r.w <= WORK_W - ARRANGE_MARGIN,
                "「{}」越出右边界",
                b.name
            );
            // 下边界：收纳格必须留足边距；**挂件放宽到屏幕底沿** —— V41 竖排放不下时
            // 优先用掉底部边距（而不是挂件互相重叠），这里是同一规则的镜像
            let bottom_limit =
                if is_content(&b.kind) { WORK_H - ARRANGE_MARGIN } else { WORK_H };
            assert!(r.y + r.h <= bottom_limit, "「{}」越出下边界", b.name);
        }
        for i in 0..rects.len() {
            for j in (i + 1)..rects.len() {
                assert!(
                    !rects[i].1.intersects(&rects[j].1),
                    "「{}」与「{}」重叠：{:?} / {:?}",
                    rects[i].0,
                    rects[j].0,
                    rects[i].1,
                    rects[j].1
                );
            }
        }

        // 硬条件 ④（V66 改写）：**高度随内容变，不再统一**（V63 的「所有格子同一尺寸」已被用户推翻）。
        //
        // 用户原话：「我图片只有一个，你搞那么大的空间做什么，有些格子图标更多，还占着同样的大小的格子」。
        // 上面已断言「最高的那一格 > 最低的那一格」；这里补一条反向守卫 —— 装得极少（1 个条目）的
        // 格子必须比内容最多的那一格矮，否则又退回「格子一样大」：
        let tiny_height = content
            .iter()
            .find(|b| b.name == "图片")
            .expect("图片格")
            .h;
        assert!(
            tiny_height < tallest_h,
            "「图片」只有 1 个条目，其高度({tiny_height})必须低于最高格({tallest_h}) —— 否则又退回「格子一样大」"
        );

        // 挂件只占一条竖列（V48/V50）—— 便签自己一列，且这一列必须**整体落在工作台左侧**
        // （V60：常驻工作台占着工作区右侧一整列，浮窗右沿 = 工作区右沿）。
        //
        // 按 **kind** 找而不是按名字：库里的名字是用户改过的中文（「便签」），
        // 而列位是由 kind 决定的 —— 拿 kind 的值去比 name 必然找不到。
        let find_widget = |kind: &str| {
            boxes
                .iter()
                .find(|b| b.kind == kind)
                .map(|b| (b.x, b.y, b.w, b.h))
                .unwrap_or_else(|| panic!("挂件「{kind}」必须在"))
        };
        let wst = workstation_rect(WORK_W, WORK_H);
        assert_eq!(
            find_widget("note"),
            (wst.x - ARRANGE_GAP_X - 260, ARRANGE_MARGIN, 260, 220),
            "便签必须自己占最右一列（右沿 = 工作台禁区左沿 − 一个列距），而不是叠在别的挂件下面"
        );

        // 幂等：同样的输入再排一次不该再挪任何东西（否则每次整理都会“抖”一下）
        let again = layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Full).expect("二次排布失败");
        assert_eq!(again.moved, 0, "排布必须幂等：第二次整理不该再挪动任何格子");
        assert_eq!(again.resized, 0, "排布必须幂等：第二次整理不该再改尺寸");
    }

    #[test]
    fn columns_fill_from_the_left_and_stay_clear_of_the_workstation() {
        // V60：常驻「工作台」占着工作区右侧一整列（从顶到底），任何格子一个像素都不许压上去。
        // V41 时这条是拿「日历盒子」当障碍物验的；日历并进工作台之后（用户 09-21：
        // 「日历可以修改为工作台」），障碍物就是工作台本身 —— 判据反而更直接。
        let (path, conn) = temp_conn("columns");
        seed_real_boxes(&conn);
        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Full).expect("排布失败");
        let boxes = read_boxes(&conn);
        let _ = std::fs::remove_file(&path);

        let wst = workstation_rect(WORK_W, WORK_H);
        for b in &boxes {
            let r = SlotRect { x: b.x, y: b.y, w: b.w, h: b.h };
            assert!(
                !r.intersects(&wst),
                "「{}」压到了常驻工作台上：{r:?} vs {wst:?}",
                b.name
            );
        }
        // 挂件（便签）仍钉在最右侧**可用**的一列：右沿 = 工作台禁区左沿 − 一个列距。
        // 注意 V41 这里还断过「格子必须在日历左边或正下方」。V42 改镜像流布之后
        // 不再成立、也不该成立：分类格自右向左首次适配时，挂件**上方那道横向空隙**
        // 里塞得下一个矮格子 —— 那是流布局的正常结果，只要不重叠就对。
        let note = boxes.iter().find(|b| b.kind == "note").expect("便签必须在");
        assert_eq!(
            note.x + note.w,
            wst.x - ARRANGE_GAP_X,
            "便签列的右沿必须紧贴工作台禁区（留一个列距）"
        );
    }

    #[test]
    fn content_boxes_stay_clear_of_the_left_loose_strip() {
        // V42：左侧那条「未归类」竖条（系统 + 快捷方式 + 落单）占住左上角之后，
        // 分类格**一个像素都不许压过去** —— 用户点名要那些快捷方式「依次展示」，
        // 被格子盖住就白搭了。
        let (path, conn) = temp_conn("strip");
        seed_real_boxes(&conn);
        // 注入 30 条未归类条目：19 行/列 → 3 列，宽 284、高 656 的一块
        let loose_count = 30usize;
        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, loose_count, LayoutMode::Full).expect("排布失败");
        let boxes = read_boxes(&conn);
        let _ = std::fs::remove_file(&path);

        let strip = super::loose_strip_rect(WORK_W, WORK_H, loose_count, ICON)
            .expect("有未归类条目必须有竖条");
        assert_eq!(strip.rect.x, ARRANGE_MARGIN);
        assert_eq!(strip.rect.y, ARRANGE_MARGIN);
        let strip_rect = strip.rect;
        for b in boxes.iter().filter(|b| is_content(&b.kind)) {
            let r = SlotRect {
                x: b.x,
                y: b.y,
                w: b.w,
                h: b.h,
            };
            assert!(
                !r.intersects(&strip_rect),
                "格子「{}」压到了左侧「未归类」竖条上",
                b.name
            );
            assert!(
                b.x >= strip_rect.x + strip_rect.w,
                "格子「{}」挤进了竖条的横向区间（竖条右沿 = {}）",
                b.name,
                strip_rect.x + strip_rect.w
            );
        }
    }

    // V60：删除了 `an_overwide_calendar_gets_its_width_reclaimed`。
    //
    // 它专测「日历盒子的多余宽度被收回自然宽度」（09-19「日历这里总宽度没有收回来」），
    // 而日历已并进常驻「工作台」浮窗（用户 09-21：「日历可以修改为工作台」）——
    // **不再是一个可缩放的盒子**，这条路径不复存在。宽度收回的能力本身
    // （`widget_natural_width`）保留：引擎对 `calendar` kind 的几何支持仍在，
    // 由上面 `flow_placer_tests` 那组纯几何单测覆盖。

    /// **真机事故回归（09-19 18:10:50 日志）**：
    ///
    /// ```
    /// 整理布局（增量补齐）：工作区 1707×912，挂件带左界 32，收纳区 1 列 × 300（左界 340）
    /// ```
    ///
    /// 用户描述：「我添加便签到第三个后突然桌面上的很多格子直接跑到桌面最左边看不见的
    /// 区域了，你看还有一点点漏出来的格子边缘」。
    ///
    /// 链条：新建便签落在 `(32, 40)` → 它不重叠也不越界，被判成「用户摆好的」→ 挂件带
    /// 左界掉到 32 → 收纳区宽度 `8 - 340 = -332` → 收纳格被算到 `x = -292`（在 300 宽的
    /// 格子里只露出最右边 8px，正是用户看到的那「一点点边缘」）。
    ///
    /// 这条用例把整条链钉住：**任何一格都不许跑到左侧竖条里面**，且两两不重叠。
    #[test]
    fn a_third_note_never_pushes_boxes_off_the_left_edge() {
        let (path, conn) = temp_conn("third-note");
        seed_real_boxes(&conn);
        let loose_count = 42usize;
        // 先照常整理一遍（模拟「用户已经整理好、桌面是正常的」）
        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, loose_count, LayoutMode::Full)
            .expect("首次排布失败");
        // 再连点两次「+ 便签」：`grid_box_upsert` 先落哨兵 (0,0)，由布局安置 ——
        // 这里刻意写成真机上那次的落点，确认它照样被救回来
        for (i, (x, y)) in [(32i64, 32i64), (32, 40)].iter().enumerate() {
            conn.execute(
                "INSERT INTO grid_boxes \
                 (name, kind, category, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                 VALUES (?1, 'note', '', ?2, ?3, 260, 220, ?4, ?5, ?5)",
                params![
                    format!("便签 {}", i + 2),
                    x,
                    y,
                    100 + i as i64,
                    "2026-09-19T18:10:50"
                ],
            )
            .expect("插入便签失败");
        }
        let outcome =
            layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, loose_count, LayoutMode::Fill)
                .expect("增量排布失败");
        let boxes = read_boxes(&conn);
        let _ = std::fs::remove_file(&path);

        let strip =
            super::loose_strip_rect(WORK_W, WORK_H, loose_count, ICON).expect("有未归类条目必须有竖条");
        let min_x = strip.rect.x + strip.rect.w + ARRANGE_GAP_X;

        assert_eq!(outcome.overflowed, 0, "三个便签也放得下，不该有格子被顶出屏幕");
        for b in &boxes {
            let r = SlotRect {
                x: b.x,
                y: b.y,
                w: b.w,
                h: b.h,
            };
            assert!(
                r.x >= min_x,
                "「{}」跑到左侧竖条里 / 屏幕外：{r:?}（竖条右沿 {min_x}）",
                b.name
            );
            assert!(r.y >= ARRANGE_MARGIN, "「{}」越出上边界：{r:?}", b.name);
            assert!(
                r.x + r.w <= WORK_W - ARRANGE_MARGIN,
                "「{}」越出右边界：{r:?}",
                b.name
            );
            assert!(r.y + r.h <= WORK_H, "「{}」越出下边界：{r:?}", b.name);
        }
        // 用户第 4 条：内容绝不能重叠
        for i in 0..boxes.len() {
            for j in (i + 1)..boxes.len() {
                let a = SlotRect {
                    x: boxes[i].x,
                    y: boxes[i].y,
                    w: boxes[i].w,
                    h: boxes[i].h,
                };
                let b = SlotRect {
                    x: boxes[j].x,
                    y: boxes[j].y,
                    w: boxes[j].w,
                    h: boxes[j].h,
                };
                assert!(
                    !a.intersects(&b),
                    "「{}」与「{}」重叠：{a:?} / {b:?}",
                    boxes[i].name,
                    boxes[j].name
                );
            }
        }
        // 三个便签必须落在**同一条列**里（便签自己一列），且都在日历左侧
        let note_xs: std::collections::BTreeSet<i64> = boxes
            .iter()
            .filter(|b| b.kind == "note")
            .map(|b| b.x)
            .collect();
        assert_eq!(note_xs.len(), 1, "三个便签应当同列：{note_xs:?}");
        // V60：唯一的挂件列必须整条落在常驻工作台左侧（工作台占着右侧一整列）。
        let wst = workstation_rect(WORK_W, WORK_H);
        let note_x = *note_xs.iter().next().unwrap();
        assert!(
            note_x + 260 <= wst.x,
            "便签列（x={note_x}，宽 260）必须落在工作台禁区（x={}）左侧",
            wst.x
        );
    }

    /// 插一个格子（连带 `items` 条登记，让高度按内容算得起来）。
    #[allow(clippy::too_many_arguments)]
    fn insert_box(
        conn: &Connection,
        name: &str,
        kind: &str,
        items: usize,
        w: i64,
        h: i64,
        sort: i64,
        x: i64,
        y: i64,
        manual: bool,
    ) -> i64 {
        conn.execute(
            "INSERT INTO grid_boxes \
             (name, kind, category, pos_x, pos_y, width, height, sort, manual, created_at, updated_at) \
             VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![name, kind, x, y, w, h, sort, if manual { 1_i64 } else { 0_i64 }, "2026-09-19T18:52:00"],
        )
        .expect("插入格子失败");
        let box_id = conn.last_insert_rowid();
        for i in 0..items {
            conn.execute(
                "INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    box_id,
                    format!("C:\\Users\\Administrator\\Desktop\\n{box_id}-{i}"),
                    format!("条目 {i}"),
                    i as i64,
                    "2026-09-19T18:52:00"
                ],
            )
            .expect("插入条目失败");
        }
        box_id
    }

    /// **V50 核心回归**：收纳格与挂件**不许出现在同一条横向区间里**。
    ///
    /// 用户 09-19：「便签一个独立的列，因为他的宽度不一样，不要跟格子挤在一起影响整理美观」。
    /// 真机现场（截屏同款）：便签列在 `x=1071`，而「安装包 / 图片」停在 `x=1031`
    /// （右沿 1331 越过便签列左沿），纵向却错开 —— 于是便签悬在那两个格子正上方，看着就是
    /// 「便签跟格子挤在同一列里」。
    #[test]
    fn no_content_box_shares_a_column_with_a_widget() {
        let (path, conn) = temp_conn("band-sep");
        seed_real_boxes(&conn);
        // 复刻真机坐标：安装包 / 图片 停在 1031，便签摆到 1031 上方
        for (name, y) in [("安装包", 366i64), ("图片", 510)] {
            conn.execute(
                "UPDATE grid_boxes SET pos_x = 1031, pos_y = ?1 WHERE name = ?2",
                params![y, name],
            )
            .expect("挪收纳格失败");
        }
        conn.execute(
            "UPDATE grid_boxes SET pos_x = 1031, pos_y = 30 WHERE kind = 'note'",
            [],
        )
        .expect("挪便签失败");
        let outcome = layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Fill)
            .expect("增量排布失败");
        let boxes = read_boxes(&conn);
        let _ = std::fs::remove_file(&path);

        assert!(outcome.moved > 0, "越界的收纳格必须被挪回收纳区");
        let widgets: Vec<&BoxRow> = boxes.iter().filter(|b| !is_content(&b.kind)).collect();
        assert!(!widgets.is_empty(), "样本里必须有挂件");
        // V68 的例外：格子可以住在挂件带**下方**那条带里（用户 09-22：「便签下面还有大量的
        // 空间，我们也可以把格子跑过去的」）。所以横向区间重叠**不再一律算错**，
        // 只有「纵向也咬在一起」才是当年那个「便签悬在格子正上方」的病。
        let band_bottom = widgets.iter().map(|w| w.y + w.h).max().unwrap() + ARRANGE_GAP_Y;
        for w in &widgets {
            for b in boxes.iter().filter(|b| is_content(&b.kind)) {
                let shares = b.x < w.x + w.w && w.x < b.x + b.w;
                let below = b.y >= band_bottom;
                assert!(
                    !shares || below,
                    "「{}」(x={}..{} y={}) 与挂件「{}」(x={}..{} y={}..{}) 挤在同一列",
                    b.name,
                    b.x,
                    b.x + b.w,
                    b.y,
                    w.name,
                    w.x,
                    w.x + w.w,
                    w.y,
                    w.y + w.h
                );
            }
        }
        // 便签仍然自己一列（多个便签同 x）
        let note_xs: std::collections::BTreeSet<i64> = widgets
            .iter()
            .filter(|b| b.kind == "note")
            .map(|b| b.x)
            .collect();
        assert_eq!(note_xs.len(), 1, "便签必须同列：{note_xs:?}");
    }

    /// **V50**：普通整理只保留「用户手工摆过」（`manual`）的格子；
    /// 引擎摆过的一律重新对齐到当前列网格。
    ///
    /// 真机痛点：库里残留着上一版算法算出来的 `x=386/397` —— 既不在当前列网格上
    /// （与 707 那条列差 40px，一眼看歪），又被当成障碍物把后来要摆的格子一路往下顶
    /// （09-19 18:52 日志「空间不足 2 个」，两个格子被顶到 y>912 的屏幕外）。
    #[test]
    fn an_engine_placed_box_is_realigned_while_a_manual_one_stays_put() {
        let (path, conn) = temp_conn("manual");
        insert_box(&conn, "文档", "folder", 16, 300, 310, 0, 0, 0, false);
        insert_box(&conn, "其他", "folder", 8, 300, 178, 1, 0, 0, false);
        insert_box(&conn, "安装包", "folder", 1, 160, 120, 2, 0, 0, false);
        insert_box(&conn, "日历 · 今日计划", "calendar", 0, 320, 470, 3, 0, 0, false);
        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Full).expect("首排失败");
        let first = read_boxes(&conn);
        let column_xs: std::collections::BTreeSet<i64> = first
            .iter()
            .filter(|b| is_content(&b.kind))
            .map(|b| b.x)
            .collect();
        // V66.1：列数是**动态算**的 —— 先把高度收进一屏（这三格总高 784 ≤ 848，一列也够），
        // 再把宽度尽量占满。本样本三个格子宽 366 / 226 / 160：排到第三列用掉 800 / 935，
        // 再开一列（+184）就顶出可用宽度，所以落在三列上。
        // 这里留两个锚点（V85 右锚定）：最右一列贴收纳区右沿（本样本没有未归类竖条）、
        // 列 x 自左向右严格递增（列式落位的定义）。
        assert!(
            column_xs.len() >= 2,
            "宽度装得下就不该只排一列（要占满空间）：{column_xs:?}"
        );
        let zone_right = first
            .iter()
            .filter(|b| !is_content(&b.kind))
            .map(|b| b.x)
            .min()
            .expect("本样本有一个日历挂件")
            - ARRANGE_GAP_X;
        let used_right = first
            .iter()
            .filter(|b| is_content(&b.kind))
            .map(|b| b.x + b.w)
            .max()
            .unwrap();
        assert_eq!(
            used_right, zone_right,
            "最右一列必须贴着收纳区右沿（V85 右锚定），实际只到 {used_right} / 右沿 {zone_right}"
        );
        let xs: Vec<i64> = column_xs.iter().copied().collect();
        assert!(
            xs.windows(2).all(|w| w[1] > w[0]),
            "列必须自左向右依次排开：{xs:?}"
        );

        // ① 用户手工把「文档」拖到一条**不在列网格上、但合法**的位置
        //
        // ⚠️ V56 修：这个 y 必须由**这一格实际的高度**推出来，不能写死 600。
        // 写死的时候它是「越界的」（600 + 320 = 920 > work_h 912），于是判据③
        // 「越出工作区」把这一格判成需要重排 —— 用例红着，产品行为却是对的
        // （挂在屏幕外沿的格子本来就该被拉回来）。现在按「底部留 40px 余量」算，
        // 不管度量怎么变，它都一定落在工作区内。
        let doc_h = first
            .iter()
            .find(|b| b.name == "文档")
            .expect("首排后文档必须在")
            .h;
        let manual_x = 120;
        let manual_y = WORK_H - ARRANGE_MARGIN - doc_h - 40;
        conn.execute(
            &format!(
                "UPDATE grid_boxes SET pos_x = {manual_x}, pos_y = {manual_y}, manual = 1 \
                 WHERE name = '文档'"
            ),
            [],
        )
        .expect("手工摆位失败");
        // ② 再写入一个「上一版算法留下的死坐标」（引擎摆的，manual 仍为 0）
        conn.execute(
            "UPDATE grid_boxes SET pos_x = 397, pos_y = 320 WHERE name = '安装包'",
            [],
        )
        .expect("写入死坐标失败");

        let outcome = layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Fill)
            .expect("增量排布失败");
        let boxes = read_boxes(&conn);
        let _ = std::fs::remove_file(&path);

        let doc = boxes.iter().find(|b| b.name == "文档").expect("文档必须在");
        let install = boxes
            .iter()
            .find(|b| b.name == "安装包")
            .expect("安装包必须在");
        // V66：顺序的读法是列优先 `(x, y)`；V85 起落位**右锚定** —— 摆放序第一（内容最大）
        // 的列贴着收纳区**右沿**。用户这次把「文档」拖到 `x=120`，它在读序里排在
        // 「安装包」前面 —— 重排后应落在「安装包」的**上方或右侧**（第一列 = 最右列）。
        // ⚠️ 位置**只决定先后**（尺寸与坐标一律重算）：所以这里同时钉住「它没有被留在手工坐标上」。
        assert_ne!(
            (doc.x, doc.y),
            (manual_x, manual_y),
            "手工坐标也必须被重排覆盖（V66：位置只决定先后，不决定坐标）"
        );
        assert!(
            doc.y < install.y || (doc.y == install.y && doc.x > install.x),
            "手工格「文档」应排在引擎格「安装包」之前（上方或右侧，V85 第一列贴右）：doc=({},{}), install=({},{})",
            doc.x,
            doc.y,
            install.x,
            install.y
        );
        // V64：手工格与引擎格的尺寸都是「内容驱动」的合理值，但**不必相同**
        for (label, b) in [("文档(手工)", doc), ("安装包(引擎)", install)] {
            assert!(
                (MIN_BOX_W..=AUTO_MAX_W).contains(&b.w),
                "{label} 宽度越界：{}",
                b.w
            );
            assert!(
                (MIN_BOX_H..=WORK_H - 2 * ARRANGE_MARGIN).contains(&b.h),
                "{label} 高度越界：{}",
                b.h
            );
        }
        assert_ne!((install.x, install.y), (397, 320), "引擎摆过的死坐标必须被重新对齐");
        // V66：引擎摆过的格子不再「吸附回列网格」（那个概念本身已被「列式填满」取代），
        // 它只要**不再是那个死坐标**、落在合法区、且不与他人重叠即可 —— 上面 `assert_ne!` 已守住
        // 「死坐标必须被重新对齐」这一条核心回归（V56「别把格子留在看不见/乱放的地方」）。
        assert!(outcome.moved >= 1, "引擎摆过的死坐标必须被重新对齐");
    }

    /// **V60**：常驻「工作台」占着工作区右侧一整列，任何一份布局下都不许有格子压上去。
    ///
    /// 它不在 `grid_boxes` 里（前端直接画在固定位置上），所以对布局引擎来说是「不存在的东西」
    /// —— 真机上有两条叠上去的路径，本用例把两条都钉住：
    ///   · **一个挂件都没有** → 收纳区铺满整幅工作区，最右那一列正好落在工作台那一列；
    ///   · **便签很多** → 挂件带若仍从工作区右沿起排，第一条便签列就落在工作台底下
    ///     （这正是 `right_edge` 要修的那条）。
    ///
    /// 判据用**矩形相交**（与用户看到的「重叠」一致），不是看坐标差不多。
    #[test]
    fn no_box_ever_covers_the_workstation_column() {
        let wst = workstation_rect(WORK_W, WORK_H);

        // —— 情形①：没有挂件，收纳区铺满 ——
        let (path, conn) = temp_conn("wst-clear");
        for (i, (name, items)) in [("文档", 16usize), ("其他", 8), ("压缩包", 2), ("图片", 21)]
            .into_iter()
            .enumerate()
        {
            insert_box(&conn, name, "folder", items, 300, 244, i as i64, 0, 0, false);
        }
        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Full).expect("排布失败");
        for b in read_boxes(&conn) {
            let rect = SlotRect { x: b.x, y: b.y, w: b.w, h: b.h };
            assert!(
                !rect.intersects(&wst),
                "「{}」压在了常驻工作台上：{rect:?} vs {wst:?}",
                b.name
            );
        }
        let _ = std::fs::remove_file(&path);

        // —— 情形②：六个便签（挂件带最宽的样子）—— 便签列必须整体落在工作台左侧 ——
        let (path, conn) = temp_conn("wst-notes");
        insert_box(&conn, "文档", "folder", 16, 300, 310, 0, 0, 0, false);
        for i in 0..6 {
            insert_box(&conn, &format!("便签 {i}"), "note", 0, 260, 220, 10 + i, 0, 0, false);
        }
        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Full).expect("排布失败");
        for b in read_boxes(&conn) {
            let rect = SlotRect { x: b.x, y: b.y, w: b.w, h: b.h };
            assert!(
                !rect.intersects(&wst),
                "「{}」压在了常驻工作台上：{rect:?} vs {wst:?}",
                b.name
            );
        }
        let _ = std::fs::remove_file(&path);
    }

    /// **V56**：手工摆过的挂件（便签 / 日历）保留自己的**纵向**位置。
    ///
    /// 用户 09-20：「现在桌面上的是不能自己拖动调整的，只能通过整理自动整理」。
    /// V50 写的是「挂件一律由列规则安置，**不看 `manual`**」，于是拖便签永远被弹回列里
    /// 那个固定位置 —— 一列多张便签的用户完全无法调顺序 / 留白。
    ///
    /// 现在的口径：**纵向听用户的，横向仍归列规则**（后者是用户自己 V50 要的
    /// 「便签一个独立的列」，见 [`adding_more_notes_never_moves_a_content_box`]）。
    #[test]
    fn a_manually_moved_note_keeps_its_vertical_position() {
        let (path, conn) = temp_conn("manual-note");
        insert_box(&conn, "文档", "folder", 16, 341, 310, 0, 0, 0, false);
        insert_box(&conn, "日历 · 今日计划", "calendar", 0, 320, 470, 1, 0, 0, false);
        insert_box(&conn, "便签", "note", 0, 260, 120, 2, 0, 0, false);
        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Full).expect("首排失败");

        let before = read_boxes(&conn);
        let note = before.iter().find(|b| b.kind == "note").expect("便签必须在");
        let column_x = note.x;
        // 用户把便签往下拖了一段（仍在工作区内，且这一列只有它一个 ⇒ 落点一定合法）
        let wanted_y = ARRANGE_MARGIN + 300;
        conn.execute(
            &format!("UPDATE grid_boxes SET pos_y = {wanted_y}, manual = 1 WHERE kind = 'note'"),
            [],
        )
        .expect("手工摆位失败");

        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Fill)
            .expect("增量排布失败");
        let after = read_boxes(&conn);
        let note = after.iter().find(|b| b.kind == "note").expect("便签必须在");
        let _ = std::fs::remove_file(&path);

        assert_eq!(note.y, wanted_y, "手工拖过的便签，纵向位置必须保留");
        assert_eq!(note.x, column_x, "横向仍归列规则（便签列不许被拖走）");
    }

    /// **V56**（V60 基线更新）：任何情况下都不许把格子留在屏幕外，也不许压在常驻工作台上。
    ///
    /// 真机 09-20 日志：「收纳区空间不足，被顶出屏幕的格子：新格子 14」—— 它被排到
    /// `y > work_h` 的地方，用户既看不见也够不着；而当时用户正抱怨「格子拖不动」，
    /// 连手动救回来的手段都没有，于是它就变成了一个幽灵格子。
    ///
    /// **真正会触发溢出的形状**（不是随手一堆格子就能复现）：一条列里有一个**手工摆过、
    /// 停在下方**的障碍物，于是引擎要摆的格子只剩它下面那一点点空间，first-fit 找不到位置
    /// 就退回「接在已占位之下」—— 那已经出了下沿。所以下面**先排一遍拿到真实列位**，
    /// 再把一格按那个列位手工停到下部，才真正走到那条分支。
    #[test]
    fn no_box_is_ever_left_out_of_view_or_on_the_launcher() {
        let (path, conn) = temp_conn("no-offscreen");
        insert_box(&conn, "日历 · 今日计划", "calendar", 0, 320, 470, 0, 0, 0, false);
        for (i, (name, items)) in [
            ("文档", 24usize),
            ("图片", 24),
            ("压缩包", 16),
            ("其他", 16),
            ("安装包", 8),
            ("文件夹", 8),
        ]
        .into_iter()
        .enumerate()
        {
            insert_box(&conn, name, "folder", items, 341, 100, i as i64 + 1, 0, 0, false);
        }
        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 48, LayoutMode::Fill).expect("首排失败");

        // 把「文件夹」按**它自己的列位**手工停到下半屏（合法：在界内、不与人重叠），
        // 于是同列的引擎格子只剩它下面那点空间 —— 这正是真机「新格子 14 被顶出屏幕」的形状。
        let seeded = read_boxes(&conn);
        let target = seeded
            .iter()
            .find(|b| b.name == "文件夹")
            .expect("文件夹必须在");
        let (cx, ch) = (target.x, target.h);
        let stop_y = WORK_H - ARRANGE_MARGIN - ch - 24;
        conn.execute(
            &format!(
                "UPDATE grid_boxes SET pos_x = {cx}, pos_y = {stop_y}, manual = 1 \
                 WHERE name = '文件夹'"
            ),
            [],
        )
        .expect("手工摆位失败");

        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 48, LayoutMode::Fill).expect("排布失败");
        let wst = workstation_rect(WORK_W, WORK_H);
        let boxes = read_boxes(&conn);
        let _ = std::fs::remove_file(&path);

        // V65 改写：内容按条目数定尺寸后，几个大内容格会**合法地**纵向堆到可见区之外（这是用户要的
        // 「内容多=格子大」），溢出交给前端收纳区滚动容器（设计允许，不再是 V56 的「bug」）。
        // 所以这里不再要求「每一格都收在可见区」，而是守三条更硬的线：
        // ① 不越界横向（x ≥ 0 且 x+w ≤ WORK_W）；② 任何格都不压在常驻工作台（启动器）上；
        // ③ 越界的格子也必须被「收住」—— 不能离谱到「天边」（> 3 个工作区高），否则就是 placement 真 bug
        //    （V56「别把格子留在看不见的地方」的核心精神：能滚到，但不许被甩飞）。
        let fold = WORK_H * 3;
        for b in &boxes {
            assert!(
                b.y >= 0,
                "格子「{}」纵坐标是负的（被推到屏幕上方外了）：y={}（工作区高 {WORK_H}）",
                b.name, b.y
            );
            assert!(
                b.y + b.h <= fold,
                "格子「{}」越过太多（连滚动都救不回）：y={} h={}（工作区高 {WORK_H}）",
                b.name, b.y, b.h
            );
            assert!(
                b.x >= 0 && b.x + b.w <= WORK_W,
                "格子「{}」横向跑到可见区外了：x={} w={}（工作区宽 {WORK_W}）",
                b.name, b.x, b.w
            );
            let rect = SlotRect { x: b.x, y: b.y, w: b.w, h: b.h };
            assert!(
                !rect.intersects(&wst),
                "格子「{}」压在了常驻工作台上：{rect:?} vs {wst:?}",
                b.name
            );
        }
        // 手工格「文件夹」的位置仍被尊重：它吸附到离用户放下点最近的那个坑，
        // 但不应被推到屏幕外或压到启动器上（核心回归：V56「别把格子留在看不见的地方」）
        let folder = boxes.iter().find(|b| b.name == "文件夹").expect("文件夹必须在");
        assert!(folder.y + folder.h <= fold, "手工格被推得太远：{:?}", folder);
    }

    /// **V50 / V65**：加便签不许再「越加越乱」。
    ///
    /// 第一个便签会让挂件带从「只有日历」变成「日历 + 便签列」，收纳区宽度随之变化
    /// （这是物理必然）；V65 起收纳格尺寸只随自己的条目数走、位置由流式铺行重算，
    /// 因此加便签可能让收纳格**整体重排**（实测 moved>0、resized=0）—— 这不再是 bug。
    /// 真正要守的是：加便签**绝不**把收纳格挤到屏幕外 / 压进挂件带 / 弄出重叠，
    /// 且便签永远只占一条列（V48/V49「便签列放不下就往左多开一条」才是「越加越乱」的根因）。
    #[test]
    fn adding_more_notes_never_moves_a_content_box() {
        let (path, conn) = temp_conn("note-stable");
        insert_box(&conn, "文档", "folder", 16, 300, 310, 0, 0, 0, false);
        insert_box(&conn, "其他", "folder", 8, 300, 178, 1, 0, 0, false);
        insert_box(&conn, "压缩包", "folder", 2, 300, 120, 2, 0, 0, false);
        insert_box(&conn, "日历 · 今日计划", "calendar", 0, 320, 470, 3, 0, 0, false);
        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Full).expect("首排失败");

        // 第一个便签：挂件带变宽，收纳区重新分列（允许动）
        insert_box(&conn, "便签", "note", 0, 260, 220, 10, 0, 0, false);
        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Fill).expect("排布失败");

        // 第二、三个便签：**一个都不许动**
        for (i, sort) in [11_i64, 12].iter().enumerate() {
            insert_box(&conn, &format!("便签 {}", i + 2), "note", 0, 260, 220, *sort, 0, 0, false);
        }
        layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Fill)
            .expect("排布失败");
        let boxes = read_boxes(&conn);
        let _ = std::fs::remove_file(&path);

        // V65 改写（原 V48/V49 的「加便签一个像素都不许动」已不成立）：
        // V65 的收纳格尺寸只看自己的条目数；Fill 增量整理按「当前位置」定先后，
        // 加便签会改挂件带列位 → 收纳区可用宽微调 → 流式铺行落点随之重排（实测 moved>0、resized=0）。
        // 所以「位置一字不差」不再是正确不变量。V65 真正要守的是：
        //   ① 加便签绝不把收纳格挤到屏幕外、绝不压进挂件带、绝不相互重叠；
        //   ② 便签永远只占一条列（V50「便签一个独立的列」）。
        let widget_left = boxes
            .iter()
            .filter(|b| b.kind != "folder")
            .map(|b| b.x)
            .min()
            .expect("本批至少有一个挂件");
        for b in &boxes {
            if b.kind != "folder" {
                continue;
            }
            assert!(b.x >= ARRANGE_MARGIN, "「{}」被推到左边界外：x={}", b.name, b.x);
            assert!(b.y >= ARRANGE_MARGIN, "「{}」被推到上边界外：y={}", b.name, b.y);
            assert!(
                b.x + b.w <= widget_left - ARRANGE_GAP_X,
                "加便签后「{}」仍跨进了挂件带（右沿 {} > 挂件带左沿 {}）",
                b.name,
                b.x + b.w,
                widget_left
            );
        }
        // 收纳格两两不重叠（V50：加便签不许搞出重叠）
        let content: Vec<&BoxRow> = boxes.iter().filter(|b| b.kind == "folder").collect();
        for i in 0..content.len() {
            for j in (i + 1)..content.len() {
                let ri = SlotRect {
                    x: content[i].x,
                    y: content[i].y,
                    w: content[i].w,
                    h: content[i].h,
                };
                let rj = SlotRect {
                    x: content[j].x,
                    y: content[j].y,
                    w: content[j].w,
                    h: content[j].h,
                };
                assert!(
                    !ri.intersects(&rj),
                    "加便签后「{}」与「{}」重叠：{:?} / {:?}",
                    content[i].name, content[j].name, ri, rj
                );
            }
        }

        // 三个便签仍然同列、不重叠
        let note_xs: std::collections::BTreeSet<i64> = read_boxes(&conn)
            .iter()
            .filter(|b| b.kind == "note")
            .map(|b| b.x)
            .collect();
        assert_eq!(note_xs.len(), 1, "便签必须始终同列：{note_xs:?}");
    }

    /// **09-19 19:00 的真实现场**：6 个便签 + 6 个收纳格 + 日历 + 42 条未归类。
    ///
    /// 真机库里当时的样子（`grid-boxes-dump.py`）：
    /// ```text
    /// note 便签   x=787  y=32   / note 便签 2  x=787  y=276 / note 便签 4  x=787  y=520
    /// note 便签 6  x=1071 y=32  / note 便签 3  x=1071 y=276 / note 便签 5  x=1071 y=520
    /// folder 安装包 x=397 y=320  / folder 图片 x=386 y=462   ← 上一版算法留下的死坐标
    /// folder 文件夹 x=463 y=32 / 文档 x=463 y=606 / 其他 x=463 y=813 / 压缩包 x=463 y=980
    /// ```
    /// 病：① 便签被摊成**两条列**（787 / 1071），挂件带吃掉 888px；② 收纳区只剩 1 列还装不下，
    /// 「其他」与「压缩包」被顶到 `y > 912` 的屏幕外（日志「空间不足 2 个」）；
    /// ③ 安装包 / 图片停在 386/397，与 463 那条列差 40px，一眼就看歪。
    ///
    /// V50 之后的期望：便签**一条列**、收纳格**两条列**、全部在区内、两两不重叠、
    /// 没有任何一格踩进挂件带。
    #[test]
    fn the_real_v50_mess_comes_out_tidy() {
        let (path, conn) = temp_conn("v50-real");
        let loose_count = 42usize; // 真机日志：未归类 42 个 ⇒ 左侧竖条右沿 340
        // V60：样本里不再有 `calendar` 盒子（日历并进了常驻「工作台」浮窗）。工作台占着
        // 工作区右侧一整列，收纳区可用宽度因此比 V50 那次小一列 —— 本用例验的正是
        // 「这么挤也仍要排得下、且一格都不越界」。
        insert_box(&conn, "文件夹", "folder", 5, 300, 178, 1, 463, 32, false);
        insert_box(&conn, "文档", "folder", 16, 300, 183, 2, 463, 606, false);
        insert_box(&conn, "其他", "folder", 8, 300, 143, 3, 463, 813, false);
        insert_box(&conn, "压缩包", "folder", 2, 300, 120, 4, 463, 980, false);
        insert_box(&conn, "安装包", "folder", 1, 300, 120, 5, 397, 320, false);
        insert_box(&conn, "图片", "folder", 1, 300, 120, 6, 386, 462, false);
        for (i, (x, y)) in [(787i64, 32i64), (787, 276), (787, 520), (1071, 32), (1071, 276), (1071, 520)]
            .iter()
            .enumerate()
        {
            let name = if i == 0 { "便签".to_string() } else { format!("便签 {}", i + 1) };
            insert_box(&conn, &name, "note", 0, 260, 220, 10 + i as i64, *x, *y, false);
        }

        // 真机这次是**增量补齐**（用户点「一键归类桌面」，或挂件窗挂载时的自愈）
        let outcome = layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, loose_count, LayoutMode::Fill)
            .expect("排布失败");
        let boxes = read_boxes(&conn);
        let _ = std::fs::remove_file(&path);

        println!("—— V50 真机现场重排结果 ——");
        for b in &boxes {
            println!(
                "  {:<10} {:<14} x={:<5} y={:<5} w={:<4} h={:<4}",
                b.kind, b.name, b.x, b.y, b.w, b.h
            );
        }

        let strip = super::loose_strip_rect(WORK_W, WORK_H, loose_count, ICON).expect("必须有竖条");
        let min_x = strip.rect.x + strip.rect.w + ARRANGE_GAP_X;
        let band_left = boxes
            .iter()
            .filter(|b| !is_content(&b.kind))
            .map(|b| b.x)
            .min()
            .expect("必须有挂件");

        assert_eq!(outcome.overflowed, 0, "一个格子都不许被顶出屏幕");
        for b in &boxes {
            let r = SlotRect { x: b.x, y: b.y, w: b.w, h: b.h };
            assert!(r.x >= min_x, "「{}」压进左侧竖条：{r:?}", b.name);
            assert!(r.y >= ARRANGE_MARGIN, "「{}」越出上边界：{r:?}", b.name);
            assert!(r.y + r.h <= WORK_H, "「{}」越出下边界：{r:?}", b.name);
            if is_content(&b.kind) {
                assert!(
                    r.x + r.w <= band_left - ARRANGE_GAP_X,
                    "「{}」跨进了挂件带（左沿 {band_left}）：{r:?}",
                    b.name
                );
            }
        }
        for i in 0..boxes.len() {
            for j in (i + 1)..boxes.len() {
                let a = SlotRect { x: boxes[i].x, y: boxes[i].y, w: boxes[i].w, h: boxes[i].h };
                let b = SlotRect { x: boxes[j].x, y: boxes[j].y, w: boxes[j].w, h: boxes[j].h };
                assert!(
                    !a.intersects(&b),
                    "「{}」与「{}」重叠：{a:?} / {b:?}",
                    boxes[i].name,
                    boxes[j].name
                );
            }
        }
        // 便签**一条列**（用户 09-19 第 1 条）
        let note_xs: std::collections::BTreeSet<i64> = boxes
            .iter()
            .filter(|b| b.kind == "note")
            .map(|b| b.x)
            .collect();
        assert_eq!(note_xs.len(), 1, "六个便签必须同一条列：{note_xs:?}");
        // 收纳区（V64 改写）：**不再强制两条等列** —— 列数与宽度由内容驱动的行带决定
        // （用户 V64 反馈：装 1 个条目的格子不该占和装 16 个一样大）。但硬不变量不能丢：
        let content: Vec<&BoxRow> = boxes.iter().filter(|b| is_content(&b.kind)).collect();
        // ① 每条行带内部严格同高（上下沿对齐），且尺寸都落在内容带允许范围内
        let mut by_row: std::collections::BTreeMap<i64, Vec<&BoxRow>> = Default::default();
        for b in &content {
            by_row.entry(b.y).or_default().push(b);
        }
        for (y, row) in &by_row {
            // V65：同一行**顶部对齐**（y 相同），但每个盒子保留自己的高度（不再「同行同高」）
            assert!(row.iter().all(|b| b.y == *y), "第 y={y} 行带没有顶部对齐：{row:?}");
            for b in row {
                assert!(
                    (MIN_BOX_W..=AUTO_MAX_W).contains(&b.w),
                    "「{}」宽度越界：{}",
                    b.name,
                    b.w
                );
                assert!(
                    (MIN_BOX_H..=WORK_H - 2 * ARRANGE_MARGIN).contains(&b.h),
                    "「{}」高度越界：{}",
                    b.name,
                    b.h
                );
            }
        }
        // ② 尺寸随内容：装 16 个的「文档」面积必须明显大于装 1 个的「图片」
        let doc = content.iter().find(|b| b.name == "文档").expect("文档格");
        let img = content.iter().find(|b| b.name == "图片").expect("图片格");
        assert!(
            doc.w * doc.h > img.w * img.h * 4 / 3,
            "V64：内容多的格子面积必须明显大于内容少的：文档 {}×{} vs 图片 {}×{}",
            doc.w,
            doc.h,
            img.w,
            img.h
        );
    }

    /// **V68 的核心回归**（用户 09-22 附真机截图）。
    ///
    /// 原话：「如果便签页没有满的时候比如只有1个，下面还有大量的空间 我们也可以把格子跑过去的，
    /// 不然页面还有空位置，结果搞出滚动条了，这是桌面哇，哪里来的滚动条哇，如果放不下那么久
    /// 应该滚动条」。
    ///
    /// 真机现场（`handy.log` 22:45 / 23:32）：工作区 1707×912、未归类 43 个（左侧竖条 274 宽
    /// ⇒ 收纳区左沿 330）、便签列 260 宽摆在最上面只有 303 高、收纳区可用宽 **637（只够 3 列）**。
    /// V66/V67 会把 17–18 个格子摞成三大列（日志「占高 984 / 1128」）—— 越过 848 的下沿 ⇒
    /// 前端那层 `overflow-y-auto` 出滚动条，而便签下方 335..880 那一整条 236 宽的空间**全空着**。
    ///
    /// V68 的验收三条：**不出滚动条**、**便签下面真的住了格子**、**排两遍一模一样**。
    #[test]
    fn v68_the_space_below_a_short_note_hosts_boxes_instead_of_a_scrollbar() {
        let (path, conn) = temp_conn("v68-lower-band");
        // 真机库里那 9 个格子的条目数（`grid-boxes-dump.py` 原样）
        let seed: [(&str, usize); 9] = [
            ("文档", 18),
            ("压缩包", 2),
            ("其他", 8),
            ("图片", 1),
            ("新格子 12", 0),
            ("文件夹", 8),
            ("安装包", 1),
            ("新格子 13", 0),
            ("新格子 21", 0),
        ];
        for (i, (name, items)) in seed.iter().enumerate() {
            insert_box(&conn, name, "folder", *items, 196, 460, i as i64, 0, 0, false);
        }
        // 用户截图里还有一串空格子（「新格子 11 / 14 / 15 / 16 / 17 / 18 / 19」）
        for (i, name) in [
            "新格子 11",
            "新格子 14",
            "新格子 15",
            "新格子 16",
            "新格子 17",
            "新格子 18",
            "新格子 19",
        ]
        .iter()
        .enumerate()
        {
            insert_box(&conn, name, "folder", 0, 160, 122, 100 + i as i64, 0, 0, false);
        }
        // 便签：真机就是 260×303 摆在最上面
        insert_box(&conn, "便签", "note", 0, 260, 303, 999, 0, 0, false);

        let outcome =
            layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 43, LayoutMode::Full).expect("排布失败");
        let boxes = read_boxes(&conn);
        let baseline = snap(&conn);

        println!("—— V68 真机现场（16 个收纳格 + 1 个便签）——");
        for b in &boxes {
            println!(
                "  {:<10} {:<14} x={:<5} y={:<5} w={:<4} h={:<4}",
                b.kind, b.name, b.x, b.y, b.w, b.h
            );
        }

        // ① 不出滚动条：一个格子都不许越出工作区下沿
        assert_eq!(
            outcome.overflowed, 0,
            "便签下面就有空位，还有 {} 个格子越过下沿 ⇒ 前端整层又出滚动条",
            outcome.overflowed
        );

        // ② 便签下方那块地方**要么用上、要么证明根本不必用**。
        //
        // ⚠️ V69 改写：原来这里是「至少有一个格子在便签下沿之下」，而那个判据**是坏的** ——
        // 排在上带里的格子照样可能 `y` 很低（三列摞到 y=760），于是它在「带下空间完全没生效」
        // 时也会通过。现在改成：**只认落在便签那一列下方的格子**（`x` 也越出上带右沿），
        // 并且允许「3 列本来就装得下」这一种合理结果 —— 两种情形都算通过，但必须二选一并
        // 说得出理由。带下空间本身由 `the_lower_band_hosts_boxes_when_the_upper_band_cannot_hold_them_all`
        // 直接钉。
        let note = boxes.iter().find(|b| b.kind == "note").expect("便签必须在");
        let band_bottom = note.y + note.h + ARRANGE_GAP_Y;
        let band_left = note.x;
        let content_zone_right = boxes
            .iter()
            .filter(|b| is_content(&b.kind) && b.y < band_bottom)
            .map(|b| b.x + b.w)
            .max()
            .unwrap_or(0);
        let in_lower: Vec<&BoxRow> = boxes
            .iter()
            .filter(|b| is_content(&b.kind) && b.y >= band_bottom && b.x + b.w > content_zone_right)
            .collect();
        let upper_fits = content_zone_right <= band_left - ARRANGE_GAP_X + 1;
        assert!(
            !in_lower.is_empty() || upper_fits,
            "既没有格子住进便签下方那条带、上带又已经越过了挂件带左沿（{content_zone_right} > {}）\
             —— 两头都不成立 ⇒ 带下空间没生效",
            band_left - ARRANGE_GAP_X
        );

        // ②′ 列内自上而下按大小递减（V69）：真机的空格子必须落在各列**底部**，
        //     而不是像 09-23 截图里那样坐在第一列顶端、把大格子挤下去。
        let content_only: Vec<&BoxRow> = boxes.iter().filter(|b| is_content(&b.kind)).collect();
        assert_columns_are_size_ordered(&content_only);

        // ③ 幂等：再排一遍（增量）一个格子都不许动
        let again =
            layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 43, LayoutMode::Fill).expect("排布失败");
        assert_eq!(again.moved, 0, "第二遍增量整理挪动了格子（读序与落位不同构）");
        assert_eq!(again.resized, 0, "第二遍增量整理改了尺寸");
        assert_eq!(snap(&conn), baseline, "第二遍增量整理的落位与第一遍不一致");

        // ④ 两两不重叠，且没有一格压到工作台上
        let wst = workstation_rect(WORK_W, WORK_H);
        for i in 0..boxes.len() {
            for j in (i + 1)..boxes.len() {
                let a = SlotRect { x: boxes[i].x, y: boxes[i].y, w: boxes[i].w, h: boxes[i].h };
                let b = SlotRect { x: boxes[j].x, y: boxes[j].y, w: boxes[j].w, h: boxes[j].h };
                assert!(
                    !a.intersects(&b),
                    "「{}」与「{}」重叠：{a:?} / {b:?}",
                    boxes[i].name,
                    boxes[j].name
                );
            }
            let r = SlotRect { x: boxes[i].x, y: boxes[i].y, w: boxes[i].w, h: boxes[i].h };
            assert!(!r.intersects(&wst), "「{}」压在工作台上：{r:?}", boxes[i].name);
        }
        // ⑤ 便签仍然只有一条列
        let note_xs: std::collections::BTreeSet<i64> = boxes
            .iter()
            .filter(|b| b.kind == "note")
            .map(|b| b.x)
            .collect();
        assert_eq!(note_xs.len(), 1, "便签必须同列：{note_xs:?}");

        let _ = std::fs::remove_file(&path);
    }

    /// **V68**：一个挂件都没有时，**原来便签那一整列都归收纳区**（用户 09-22 第二条：
    /// 「没有便签的时候便签列可以作为格子列使用」）。
    ///
    /// 舞台 lockdown 的是「看到了空间就应该用」这条：`content_zone_right` 不能因为没有挂件
    /// 就再白减一道缝 —— 少了那一缝可能就是少一整列。
    #[test]
    fn with_no_widget_the_former_widget_column_is_open_for_content_boxes() {
        let (path, conn) = temp_conn("v68-no-widget");
        // 与真机同量级的收纳格，且**足够挤**（条目多 ⇒ 自然宽度大）：这样才会走到
        // 「这几列的宽度一起被夹到刚好塞满 zone」那条分支，右沿的差异才看得出来。
        let seed: [(&str, usize); 20] = [
            ("文档", 18),
            ("压缩包", 16),
            ("其他", 14),
            ("图片", 12),
            ("安装包", 10),
            ("文件夹", 18),
            ("视频", 16),
            ("音乐", 14),
            ("下载", 12),
            ("桌面备份", 10),
            ("新格子 11", 18),
            ("新格子 12", 16),
            ("新格子 13", 14),
            ("新格子 14", 12),
            ("新格子 15", 10),
            ("新格子 16", 18),
            ("新格子 17", 16),
            ("新格子 18", 14),
            ("新格子 19", 12),
            ("新格子 20", 10),
        ];
        for (i, (name, items)) in seed.iter().enumerate() {
            insert_box(&conn, name, "folder", *items, 196, 460, i as i64, 0, 0, false);
        }

        let outcome =
            layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 43, LayoutMode::Full).expect("排布失败");
        let boxes = read_boxes(&conn);
        let baseline = snap(&conn);
        let wst = workstation_rect(WORK_W, WORK_H);
        let right_edge = wst.x - ARRANGE_GAP_X;

        println!("—— V68 无挂件现场（20 个收纳格，收纳区右沿应为 {right_edge}）——");
        for b in &boxes {
            println!(
                "  {:<10} {:<14} x={:<5} y={:<5} w={:<4} h={:<4} 右沿={}",
                b.kind,
                b.name,
                b.x,
                b.y,
                b.w,
                b.h,
                b.x + b.w
            );
        }

        // ① 没有挂件 ⇒ 一个都不许越出收纳区（V68 之前这里是少了 24px 的列宽）
        for b in &boxes {
            let r = SlotRect { x: b.x, y: b.y, w: b.w, h: b.h };
            assert!(
                !r.intersects(&wst),
                "「{}」压在工作台上：{r:?} vs {wst:?}",
                b.name
            );
            assert!(
                b.x + b.w <= right_edge,
                "「{}」右沿 {} 越过了收纳区右沿 {right_edge}",
                b.name,
                b.x + b.w
            );
        }

        // ①′ **列内自上而下按大小递减**（V69 的核心不变量）：大格子先占位、小格子补空
        let content_only: Vec<&BoxRow> = boxes.iter().filter(|b| is_content(&b.kind)).collect();
        assert_columns_are_size_ordered(&content_only);

        // ② 最右那一列必须**顶到收纳区右沿** —— 这才叫「那一列归收纳区了」。
        //    少了那一道缝（= 修复前的写法），这里会整整短 24px。
        let rightmost = boxes.iter().map(|b| b.x + b.w).max().unwrap_or(0);
        assert!(
            rightmost >= right_edge - 2,
            "最右一列只到 {rightmost}，离收纳区右沿 {right_edge} 还有一段 —— \
             没有挂件时右沿被多减了一道缝（整列白白浪费）"
        );

        // ③ 也不许出滚动条 —— 这一批是放得下的（没有挂件占列）
        assert_eq!(
            outcome.overflowed, 0,
            "没有挂件时收纳区最宽，反而有 {} 个格子越界 ⇒ 无挂件分支的右界算错了",
            outcome.overflowed
        );

        // ④ 幂等
        let again =
            layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 43, LayoutMode::Fill).expect("排布失败");
        assert_eq!(again.moved, 0, "第二遍增量整理挪动了格子");
        assert_eq!(again.resized, 0, "第二遍增量整理改了尺寸");
        assert_eq!(snap(&conn), baseline, "第二遍增量整理的落位与第一遍不一致");

        let _ = std::fs::remove_file(&path);
    }

    /// **V70：桌面满了就不许再建格子**（用户 09-23 第 1 条）。
    ///
    /// 原话：「格子太多后还是出现了滚动条，我建议**如果放不下了就提醒用户不能因为空间有限
    /// 不能创建更多格子**，不然逻辑没法实现了」。
    ///
    /// 判据必须是「引擎自己说放不下」而不是「数够多少个格子」，所以这条用例**自己找临界点**：
    /// 一个一个加空格子，直到布局真的报越界（`overflowed > 0`，也就是用户看到滚动条的那一刻）。
    /// 循环**停在越界的那一档**（库里是 `critical` 个），所以要测「还放得下」必须**往回删**：
    ///   · 退到 `critical - 1`（这一档排得下）⇒ 再建一个就是 `critical` ⇒ 试探**必须拒绝**，
    ///     而且**一个字节都没落库**（格数不变、所有坐标一字不差）；
    ///   · 退到 `critical - 2` ⇒ 建出来是 `critical - 1`，排得下 ⇒ 试探**必须放行**
    ///     （不能提前把人挡在门外）。
    ///
    /// `loose_count` 注入固定值 —— 与所有端到端用例同口径，不依赖跑测试这台机器的桌面。
    #[test]
    fn a_new_box_is_refused_exactly_when_the_desk_is_full() {
        let (path, conn) = temp_conn("v70-full");
        let loose_count = 0usize;
        const EMPTY_W: i64 = 160;
        const EMPTY_H: i64 = 120;

        /// 往回删一个格子（按 sort 最大的那个 —— 就是刚加进去的那个）。
        fn drop_last(conn: &Connection) {
            conn.execute(
                "DELETE FROM grid_boxes WHERE id = \
                 (SELECT b.id FROM grid_boxes b ORDER BY b.sort DESC, b.id DESC LIMIT 1)",
                [],
            )
            .expect("删除格子失败");
        }

        /// 试探「再来一个格子」—— 与 `grid_box_upsert` 走的是同一条 `INSERT_BOX_SQL`。
        fn probe_another(conn: &Connection, w: i64, h: i64) -> Option<String> {
            probe_room_for_another_box(conn, WORK_W, WORK_H, ICON, 0, |probe| {
                probe
                    .execute(
                        INSERT_BOX_SQL,
                        params!["试探", "folder", "", "", 0, 0, w, h, 9999i64, "t", "t"],
                    )
                    .map(|_| ())
            })
        }

        // ① 找临界格数：加到「布局报越界」为止（循环结束时库里已经是越界的那一档）
        let mut critical: Option<usize> = None;
        for n in 1..=40 {
            insert_box(&conn, &format!("格{n}"), "folder", 0, EMPTY_W, EMPTY_H, n as i64, 0, 0, false);
            let out = layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, loose_count, LayoutMode::Fill)
                .expect("排布失败");
            if out.overflowed > 0 {
                critical = Some(n);
                break;
            }
        }
        let critical = critical.expect("40 个空格子都没把桌面塞满？临界点找不到了");
        assert!(critical > 2, "临界点太小，边界两侧都测不到：{critical}");

        // ② 退到「刚好排得下」的那一档，再建一个就越界 ⇒ 必须拒绝，且零副作用
        drop_last(&conn);
        let fits = layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, loose_count, LayoutMode::Fill)
            .expect("排布失败");
        assert_eq!(fits.overflowed, 0, "退一格之后应当排得下（临界点找错了）");
        assert_eq!(read_boxes(&conn).len(), critical - 1, "退一格之后的格数不对");

        let before = snap(&conn);
        let reason = probe_another(&conn, EMPTY_W, EMPTY_H)
            .expect("再建一个就越界了，却没有拒绝 ⇒ 用户会拿到一屏滚动条");
        assert!(
            reason.contains("没有新建"),
            "拒绝的理由必须写明「没建」并给出路，实际：{reason}"
        );
        assert_eq!(snap(&conn), before, "试探把用户库改了（应当零副作用）");
        assert_eq!(read_boxes(&conn).len(), critical - 1, "试探插进去的那条没被回滚");

        // ③ 再退一格 ⇒ 建出来仍然排得下 ⇒ 必须放行（同样零副作用）
        drop_last(&conn);
        assert_eq!(read_boxes(&conn).len(), critical - 2, "再退一格之后的格数不对");
        let before = snap(&conn);
        let refused_early = probe_another(&conn, EMPTY_W, EMPTY_H);
        assert!(refused_early.is_none(), "还没满就拒绝新建：{refused_early:?}");
        assert_eq!(snap(&conn), before, "试探把用户库改了（应当零副作用）");
        assert_eq!(read_boxes(&conn).len(), critical - 2, "试探插进去的那条没被回滚");

        // ④ 回滚得干净到 `last_insert_rowid` 也退回去（紧接着的真插入拿到的是它自己的 id）
        let id = insert_box(&conn, "真插入", "folder", 0, EMPTY_W, EMPTY_H, 10000, 0, 0, false);
        assert!(id > 0, "试探之后真插入拿不到 rowid");

        let _ = std::fs::remove_file(&path);
    }

    /// 一个 `w × h` 的格子**实际摆得下几个条目**（按引擎给的几何，用前端那份量法）。
    ///
    /// 与 [`flow_placer_tests::frontend_capacity`] 同一个口径：引擎算的格子必须**真的**装得下
    /// 它自己的条目，否则前端就会在盒子内部长出滚动条 —— V70 那条「1px 几何账」的真身。
    fn shown_items(w: i64, h: i64, icon: i64) -> i64 {
        let cols = item_columns_at(w, icon);
        let cell_h = icon.clamp(16, 256) + BOX_CELL_EXTRA_H;
        let avail_h = h - BOX_HEADER_H - BOX_BORDER_H - 2 * GRID_PAD_Y - BOX_FIT_SLACK;
        let rows = (avail_h + GRID_GAP) / (cell_h + GRID_GAP);
        cols * rows.max(1)
    }

    /// **V70 真机回归**：用户 09-23 上午「删掉很多格子」之后库里剩下的那一套
    /// （文档 18 项 / 其他 8 项 / 文件夹 8 项 + 两条便签）必须**一个图标都不藏**。
    ///
    /// 用户第 2 条原话：「我删除了很多格子后空间多了，应该重新计算大小，尽可能让所有图标都
    /// 直接展示出来，没有滚动条」。空间多了却不重算尺寸，就是 V69 那版的行为 ——
    /// 这条用例把「空间够 ⇒ 全摆出来」钉在**真机的那一组数据**上，而不是抽象的 N 项。
    #[test]
    fn the_users_current_desktop_shows_every_icon_without_a_scrollbar() {
        let (path, conn) = temp_conn("v70-real");
        let real = [
            ("文档", "folder", 18usize),
            ("其他", "folder", 8),
            ("文件夹", "folder", 8),
            ("便签", "note", 0),
            ("便签 2", "note", 0),
        ];
        for (sort, (name, kind, items)) in real.iter().enumerate() {
            insert_box(&conn, name, kind, *items, MIN_BOX_W, MIN_BOX_H, sort as i64, 0, 0, false);
        }

        let out = layout_all_boxes_with(&conn, WORK_W, WORK_H, ICON, 0, LayoutMode::Full)
            .expect("排布失败");
        assert_eq!(
            out.overflowed, 0,
            "真机这一套（3 个收纳格 + 2 条便签）都放不下 ⇒ 用户又能看到整层滚动条"
        );

        for b in read_boxes(&conn).iter().filter(|b| is_content(&b.kind)) {
            let shown = shown_items(b.w, b.h, ICON);
            assert!(
                shown >= b.items,
                "「{}」有 {} 项，可引擎给的 {}×{} 只摆得下 {} 个 ⇒ 盒内会出滚动条（V70 的 1px 几何账）",
                b.name,
                b.items,
                b.w,
                b.h,
                shown,
            );
            assert!(
                b.y + b.h <= WORK_H - ARRANGE_MARGIN,
                "「{}」底边 {} 越过工作区下沿 {}",
                b.name,
                b.y + b.h,
                WORK_H - ARRANGE_MARGIN,
            );
        }

        let _ = std::fs::remove_file(&path);
    }
}
