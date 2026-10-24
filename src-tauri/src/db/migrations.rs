//! SQLite 版本化迁移（ARCHITECTURE ADR-7）。
//!
//! 约定：迁移是**只追加**的有序列表，历史项一经发布不得修改；
//! 应用进度记录在 `schema_migrations` 表（`version` / `applied_at`），重复执行幂等。

use rusqlite::Connection;

/// v1 初始表结构（内嵌 `schema.sql`，编译期纳入二进制）。
pub const V1_SCHEMA: &str = include_str!("schema.sql");

/// v2：移除剪贴板历史（M4，用户决定直接移除，避免与系统剪贴板重复）。
/// 幂等 `DROP TABLE IF EXISTS`，对全新安装（v1 已不含 clip_* 表）无副作用。
pub const V2_DROP_CLIP: &str = "
DROP TABLE IF EXISTS clip_fts;
DROP TABLE IF EXISTS clip_items;
";

/// v3：密码存储器（M5）——主密码加密保险库。
///
/// - `vault_meta`：库元数据（`salt` 16 字节 / `verifier` 校验密文），value 一律 BLOB；
/// - `vault_items`：机密条目，明文字段**永不落库**，全部以
///   `*_enc` BLOB 存储（格式：`12 字节随机 nonce || AES-256-GCM 密文含 tag`，
///   每次写入生成新 nonce）。
pub const V3_VAULT: &str = "
CREATE TABLE IF NOT EXISTS vault_meta (
  key   TEXT PRIMARY KEY,
  value BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT NOT NULL CHECK(category IN ('login','secret','note')),
  title        TEXT NOT NULL,
  username_enc BLOB,
  secret_enc   BLOB NOT NULL,
  url_enc      BLOB,
  notes_enc    BLOB,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_items_updated ON vault_items(updated_at DESC);
";

/// v4：桌面网格挂件（M2 改版）——**文件引用型**桌面整理。
///
/// 设计原则：文件**绝不**被移动 / 复制 / 重命名；`grid_items.file_path` 存原文件
/// 路径的引用，打开经 shell 唤起系统默认程序（零磁盘副作用）。
///
/// - `grid_meta`：挂件窗几何等键值配置（value 存 JSON 字符串）；
/// - `grid_boxes`：挂件盒子（名称 + 逻辑像素几何 + 排序）；
/// - `grid_items`：盒子内条目（原路径引用），`box_id` 级联删除；
///   `(box_id, file_path)` 唯一索引防止同一盒子内重复引用。
pub const V4_GRID: &str = "
CREATE TABLE IF NOT EXISTS grid_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grid_boxes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  pos_x      INTEGER NOT NULL DEFAULT 0,
  pos_y      INTEGER NOT NULL DEFAULT 0,
  width      INTEGER NOT NULL DEFAULT 320,
  height     INTEGER NOT NULL DEFAULT 220,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS grid_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id       INTEGER NOT NULL REFERENCES grid_boxes(id) ON DELETE CASCADE,
  file_path    TEXT    NOT NULL,
  display_name TEXT    NOT NULL,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_grid_items_box_path ON grid_items(box_id, file_path);
CREATE INDEX IF NOT EXISTS idx_grid_items_box_sort ON grid_items(box_id, sort);
";

/// v5：待办「说明」字段（`todos.detail`）。
///
/// `title` 只够放一句短语（列表里要一行显示、系统提醒要念出来），但真实事项往往需要
/// 补充上下文：链接、操作步骤、子清单。于是新增 `detail` 存 **Markdown** 说明，
/// 由工作台以所见即所得方式编辑（见 `src/components/RichMarkdown.tsx`）。
///
/// `ADD COLUMN` 带**常量默认值**，SQLite 允许且无需回填；迁移只执行一次
/// （`schema_migrations` 记录版本），因此不会出现「列已存在」的重复执行问题。
pub const V5_TODO_DETAIL: &str = "
ALTER TABLE todos ADD COLUMN detail TEXT NOT NULL DEFAULT '';
";

/// v6：桌面格子升级为「真实收纳 + 挂件」。
///
/// V33 的产品转向（用户实测反馈驱动）：
///   - 旧模型是**文件引用型** —— 格子登记桌面文件的路径引用，文件一动不动。
///     问题是它和桌面原图标**完全重复**（同一批文件在桌面和格子里各显示一份），
///     用户的原话是「并不是整理收纳，而是复制了一份而已」；
///   - 新模型是**真实收纳型** —— 每个格子绑定一个真实目录
///     （`桌面/Toolbox整理/<格子名>/`），拖进去 = 真把文件移进该目录。
///     文件离开桌面根目录 → 桌面图标自然消失 → **不再重复**。
///
/// 同时把格子扩成**挂件容器**：`kind` 区分收纳格 / 便签 / 日历，
/// `content` 存挂件自身的数据（便签正文、日历配置 JSON）。
///
/// `ADD COLUMN` 带常量默认值，SQLite 允许且无需回填；迁移只执行一次
/// （`schema_migrations` 记录版本），因此不会出现「列已存在」的重复执行问题。
/// `grid_items` 表保留但降级为**登记缓存**：内容真相在磁盘目录，表只缓存 id
/// 供前端做删除 / 跨格移动的定位（每次列举时按目录对账）。
pub const V6_GRID_WIDGETS: &str = "
ALTER TABLE grid_boxes ADD COLUMN kind TEXT NOT NULL DEFAULT 'folder';
ALTER TABLE grid_boxes ADD COLUMN content TEXT NOT NULL DEFAULT '';

-- 迁移前的「系统」格子是由 ensure_system_box 建的，里面装的是此电脑 / 回收站
-- 这类 CLSID 虚拟条目（磁盘上并没有对应文件）。升级后必须把它标成 system 类型，
-- 否则按「收纳格 = 真实目录」的新模型对账时，会把这两个入口当成失效条目清掉。
--
-- 这一步的产物只活一个版本：紧接着的 v7 会把这个格子连同它的条目一起删掉
-- （V34 用户要求）。保留 v6 的标记不是冗余 —— 迁移只追加不改写，老库升上来必须能
-- 一步一步重放，中间态也得自洽。
UPDATE grid_boxes SET kind = 'system' WHERE name = '系统';
";

/// v7：移除「系统」收纳格（V34，用户实测反馈驱动）。
///
/// 用户原话：「系统这个不需要吧，我们原生的快捷方式不需要动态整理，也没有合理的
/// 分类规则」。此电脑 / 回收站是 Explorer **恒定显示**的桌面入口（不受任何桌面
/// 工具控制），格子里的那一份与桌面上的那一份**完全重复** —— 用户截图里就是左右
/// 两个「我的电脑」并排；而它们既不是文件、也没有可收纳的归属。
///
/// 因此：① 删掉所有 `kind = 'system'` 的格子；② 连带清掉它们的 `grid_items` 行
/// （外键 `ON DELETE CASCADE` 本会处理，这里显式删一遍，保证即使外键未启用也不留
/// 孤儿行）。本迁移**只动 `grid_*` 两张表，不触碰磁盘上任何文件**。
pub const V7_DROP_SYSTEM_BOX: &str = "
DELETE FROM grid_items WHERE box_id IN (SELECT id FROM grid_boxes WHERE kind = 'system');
DELETE FROM grid_boxes WHERE kind = 'system';
";

/// v8：格子配色（`accent`）。
///
/// 用户 V35 反馈「便签应该可以添加多个」—— 多个便签如果长得一模一样，桌面上分不清
/// 哪个是哪个。给每个格子一个可选的配色键（`''` = 用默认色），便签尤其需要。
/// 顺便预留给收纳格用（分类着色）。
pub const V8_GRID_ACCENT: &str = "
ALTER TABLE grid_boxes ADD COLUMN accent TEXT NOT NULL DEFAULT '';
";

/// v9：格子改「引用模型」—— 新增 `category`，并清掉历史登记（V37）。
///
/// **为什么要清 `grid_items`**：V33–V36 的 `file_path` 全部指向
/// `桌面/Toolbox整理/<格子名>/` 下的**真实文件**（因为那几版真的把文件搬进去了）。
/// 换成引用模型后这些路径已不该存在文件，留着只会变成一堆点不动的幽灵图标。
/// 用户用「一键归类」重扫一遍即可 —— 桌面上的文件一个都没少，只是登记要重来一次。
///
/// **`category` 干嘛用**：自动归类要认出「哪个格子收文档、哪个收图片」。之前靠格子名
/// 隐式匹配（名字叫「文档」就当它收文档），用户一改名就失联；显式记字段后改名也不影响。
pub const V9_GRID_CATEGORY: &str = "
ALTER TABLE grid_boxes ADD COLUMN category TEXT NOT NULL DEFAULT '';
DELETE FROM grid_items;
";

/// v10：格子「手工摆放」标记（`manual`）—— 收纳列对齐的前提（V50）。
///
/// 用户 09-19 原话：「便签一个独立的列，因为他的宽度不一样，不要跟格子挤在一起影响整理
/// 美观」+「你自己看图片继续重构结构并优化吧」。
///
/// V49 及以前，普通整理（Fill）会原样保留一切「不重叠、不越界」的格子 —— 于是真机库里
/// 残留着**上一版算法算出来的死坐标**：`安装包 (397,320)` / `图片 (386,462)` 既不在当前
/// 列网格上（与 707 那条列差 40px，肉眼一眼就看歪了），又被当成障碍物，把后来要摆的格子
/// 一路往下顶（真机 18:52 日志：「空间不足 2 个」，两个格子被顶到 y>912 的屏幕外）。
///
/// V50 起区分归属：
///   · `manual = 0`（引擎摆的）→ 每次整理都按当前列网格**重新对齐**（列网格 = 由挂件带
///     左沿与可用宽度算出的等宽列，见 `content_columns`）；
///   · `manual = 1`（用户自己拖过 / 拉过）→ 原地不动，只要不重叠、不越界、不进挂件带。
///
/// 前端在 `persistBoxGeometry`（拖拽 / 缩放落库）里显式带 `manual: true`；
/// 「重新重置整理」会把全表 `manual` 清回 0 —— 对应的正是用户那句
/// 「除非后面用户重新重置整理，我们又按照我们自己的规律整理」。
pub const V10_GRID_MANUAL: &str = "
ALTER TABLE grid_boxes ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
";

/// v11：**日历盒子退场** —— 日历并进常驻「工作台」浮窗（V60）。
///
/// 用户 09-21：「日历可以修改为工作台，把快捷入口这些都可以整合到工作台里面，整合成一个
/// 整体的模块」「工作台这个可以常驻，不跟桌面整理一起退出」。
///
/// 于是 `kind = 'calendar'` 的盒子不再由任何产品路径创建，前端也不再渲染它 —— 留着的话
/// 它会继续占着布局引擎里一条**固定 320 宽的竖列**（`widget_natural_width` 的返回值），
/// 白白把收纳区挤窄一块；而用户既看不见也点不动它（没有渲染就没有命中区）。
///
/// **不丢任何用户数据**：日历盒子不参与条目登记（`is_content_kind("calendar") == false`），
/// 它承载的「今日计划」在 `todos` 表里、与盒子无关；主题（`accent`）在 V60 随工作台一起
/// 走前端本地配置。这里的 `DELETE grid_items` 只是防御 —— 正常库里日历盒子本来就没有条目
/// （`grid_items.box_id` 虽声明了 `ON DELETE CASCADE`，但 SQLite 的外键约束默认不生效，
/// 所以显式删一遍，绝不留下悬挂行）。
///
/// 引擎对 `calendar` kind 的几何支持**刻意保留**（`flow_placer_tests` 仍覆盖它）：
/// 万一用户从旧备份恢复出一个含日历盒子的库，布局不会因为遇到未知 kind 而错乱。
pub const V11_GRID_DROP_CALENDAR: &str = "
DELETE FROM grid_items WHERE box_id IN (SELECT id FROM grid_boxes WHERE kind = 'calendar');
DELETE FROM grid_boxes WHERE kind = 'calendar';
";

/// 全部迁移：(版本号, SQL)。新增结构在**末尾追加**；移除历史结构可追加 DROP 迁移。
pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, V1_SCHEMA),
    (2, V2_DROP_CLIP),
    (3, V3_VAULT),
    (4, V4_GRID),
    (5, V5_TODO_DETAIL),
    (6, V6_GRID_WIDGETS),
    (7, V7_DROP_SYSTEM_BOX),
    (8, V8_GRID_ACCENT),
    (9, V9_GRID_CATEGORY),
    (10, V10_GRID_MANUAL),
    (11, V11_GRID_DROP_CALENDAR),
];

/// 当前毫秒时间戳（用于 `applied_at`）。
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 依次应用所有「未记录」的迁移。任何一步失败即中止并返回中文错误。
pub fn run(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version    INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
         );",
    )
    .map_err(|err| format!("创建迁移记录表失败：{err}"))?;

    // 已应用的最大版本号（空表时为 0）
    let applied: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("读取迁移版本失败：{err}"))?;

    for (version, sql) in MIGRATIONS {
        if *version <= applied {
            continue;
        }
        conn.execute_batch(sql)
            .map_err(|err| format!("应用数据库迁移 v{version} 失败：{err}"))?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            rusqlite::params![version, now_ms()],
        )
        .map_err(|err| format!("记录数据库迁移 v{version} 失败：{err}"))?;
    }

    Ok(())
}

// —— 回归测试 ——
//
// 为什么要在这里测：迁移是**唯一**会改用户现有数据库结构的代码，一旦出错用户拿到的是
// 「表结构对不上 → 各功能报 no such column」。而它此前**一条断言都没有** ——
// V33 的 v6 就是在「沙箱里 GUI 起不来、跑不到 db::init」的情况下被发现的（见 PROJECT_STATUS §1.19）。
// 这组测试不依赖窗口/WebView，任何环境都能跑：`cargo test --lib db::migrations`。
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 建一个空临时库；同名残留先删掉，保证从零开始。
    fn temp_conn(tag: &str) -> (PathBuf, Connection) {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "toolbox-migrate-test-{tag}-{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).expect("打开临时库失败");
        (path, conn)
    }

    /// 表的列名清单。
    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("读取表结构失败");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("读取列名失败");
        rows.map(|row| row.expect("列行读取失败")).collect()
    }

    /// 已记录的迁移版本号（升序）。
    fn versions(conn: &Connection) -> Vec<i64> {
        let mut stmt = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
            .expect("读取迁移版本失败");
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .expect("读取迁移版本失败");
        rows.map(|row| row.expect("版本行读取失败")).collect()
    }

    /// 只应用到第 `last` 个版本（用于构造「老用户库里停在 v5」的现场）。
    fn apply_upto(conn: &Connection, last: i64) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                 version    INTEGER PRIMARY KEY,
                 applied_at INTEGER NOT NULL
             );",
        )
        .expect("建迁移表失败");
        for (version, sql) in MIGRATIONS {
            if *version > last {
                break;
            }
            conn.execute_batch(sql)
                .unwrap_or_else(|err| panic!("预置迁移 v{version} 失败：{err}"));
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
                rusqlite::params![version, now_ms()],
            )
            .expect("记录预置迁移失败");
        }
    }

    /// 全新安装：一条 `run()` 应把所有版本按序落库，且最终结构含 v6 的两列。
    #[test]
    fn fresh_db_applies_every_migration() {
        let (path, conn) = temp_conn("fresh");
        run(&conn).expect("全新库迁移失败");

        let expected: Vec<i64> = MIGRATIONS.iter().map(|(v, _)| *v).collect();
        assert_eq!(
            versions(&conn),
            expected,
            "schema_migrations 必须按序记录全部迁移"
        );

        let cols = columns(&conn, "grid_boxes");
        assert!(cols.iter().any(|c| c == "kind"), "v6 未加 grid_boxes.kind");
        assert!(
            cols.iter().any(|c| c == "content"),
            "v6 未加 grid_boxes.content"
        );
        assert!(
            cols.iter().any(|c| c == "accent"),
            "v8 未加 grid_boxes.accent"
        );
        // 真正要守的是**行为**：老代码 INSERT 时不会带 accent，读回来必须是空串而不是
        // NULL（NULL 会让 Rust 侧 `row.get::<String>` 直接报错，表现成「格子打不开」）。
        conn.execute(
            "INSERT INTO grid_boxes (name, pos_x, pos_y, width, height, sort, created_at, updated_at) \
             VALUES ('默认色测试', 0, 0, 320, 220, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .expect("插入不带 accent 的格子失败");
        let accent: String = conn
            .query_row("SELECT accent FROM grid_boxes LIMIT 1", [], |row| row.get(0))
            .expect("accent 读回失败（很可能是 NULL）");
        assert_eq!(accent, "", "accent 缺省值必须是空串");

        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// **V11**：日历盒子退场 —— 升级后 `kind = 'calendar'` 的行必须整行消失，
    /// 而 `folder` / `note` 的格子与登记一格不动（迁移只该精确命中日历）。
    ///
    /// 用户 09-21：「日历可以修改为工作台」—— 日历并进常驻浮窗后，盒子里那行留着只会
    /// 继续占着布局引擎里一条**固定 320 宽的竖列**，把收纳区白白挤窄一块。
    #[test]
    fn upgrading_drops_calendar_boxes_only() {
        let (path, conn) = temp_conn("drop-calendar");
        apply_upto(&conn, 10);
        // 老库现场：三种 kind 各一个；日历盒子名下**故意**塞一条登记，验防御性清理
        // （正常库里日历盒子没有条目 —— 它不参与登记）。
        conn.execute_batch(
            "INSERT INTO grid_boxes (name, kind, pos_x, pos_y, width, height, sort, created_at, updated_at) \
             VALUES ('日历 · 今日计划', 'calendar', 1355, 32, 320, 503, 0, 'x', 'x'), \
                    ('文档', 'folder', 341, 32, 320, 178, 1, 'x', 'x'), \
                    ('便签', 'note', 1071, 32, 260, 120, 2, 'x', 'x'); \
             INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
             SELECT id, 'C:/t/a.txt', 'a', 0, 'x' FROM grid_boxes WHERE kind = 'calendar'; \
             INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
             SELECT id, 'C:/t/b.txt', 'b', 0, 'x' FROM grid_boxes WHERE kind = 'folder';",
        )
        .expect("构造老库失败");

        run(&conn).expect("升级失败");

        let kinds: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT kind FROM grid_boxes ORDER BY sort ASC")
                .expect("读取 kind 失败");
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .expect("读取 kind 失败");
            rows.map(|r| r.expect("kind 行读取失败")).collect()
        };
        assert_eq!(
            kinds,
            vec!["folder".to_string(), "note".to_string()],
            "日历盒子必须整行消失，其余的 kind 一个都不许少"
        );
        let orphan: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM grid_items WHERE box_id NOT IN (SELECT id FROM grid_boxes)",
                [],
                |row| row.get(0),
            )
            .expect("统计悬挂登记失败");
        assert_eq!(orphan, 0, "日历盒子名下的登记必须一并清掉（SQLite 外键默认不生效）");
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM grid_items", [], |row| row.get(0))
            .expect("统计登记失败");
        assert_eq!(kept, 1, "非日历格子的登记一个都不许动");

        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// 老库升级（线上真实形态）：停在 v5，桌面上已有「文件夹」格与「系统」格。
    ///
    /// 走完整 `run()`，断言 v6 + v7 + v8 串起来的最终形态：
    ///   ① 普通格子回落 `folder`、`content` 为空串（前端按 kind 分支渲染，
    ///      空串是便签的安全初值）；
    ///   ② 「系统」格**整行消失** —— v6 先把它标成 `system`（否则按新模型的目录
    ///      对账会把它当失效条目），v7 再按用户要求连格带条目一起删掉
    ///      （此电脑 / 回收站是 Explorer 恒定显示的入口，格子里那份纯属重复）；
    ///   ③ 「文件夹」格必须原样活着 —— 删系统格不能误伤正常的收纳格。
    #[test]
    fn v5_db_upgrades_then_drops_system_box() {
        let (path, conn) = temp_conn("from-v5");
        apply_upto(&conn, 5);
        assert_eq!(versions(&conn), vec![1, 2, 3, 4, 5], "预置应停在 v5");

        for name in ["文件夹", "系统"] {
            conn.execute(
                "INSERT INTO grid_boxes (name, pos_x, pos_y, width, height, sort, created_at, updated_at) \
                 VALUES (?1, 0, 0, 320, 220, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                rusqlite::params![name],
            )
            .expect("预置格子失败");
        }
        // 系统格里有两个 CLSID 虚拟条目；删格子必须连带清掉，不留孤儿行
        let system_id: i64 = conn
            .query_row("SELECT id FROM grid_boxes WHERE name = '系统'", [], |row| {
                row.get(0)
            })
            .expect("读取系统格 id 失败");
        conn.execute(
            "INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
             VALUES (?1, '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}', '此电脑', 0, '2026-01-01T00:00:00Z')",
            rusqlite::params![system_id],
        )
        .expect("预置系统条目失败");

        run(&conn).expect("v5 → 最新版本 升级失败");

        // 用内层作用域收掉 `stmt` 的借用，后面才能 drop(conn) 关库再删文件
        let rows: Vec<(String, String, String)> = {
            let mut stmt = conn
                .prepare("SELECT name, kind, content FROM grid_boxes ORDER BY name ASC")
                .expect("查询格子失败");
            let mapped = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .expect("查询格子失败");
            mapped
                .map(|row| row.expect("格子行读取失败"))
                .collect::<Vec<_>>()
        };

        assert_eq!(
            rows,
            vec![("文件夹".to_string(), "folder".to_string(), String::new())],
            "普通格子回落 folder 且必须存活；系统格必须被 v7 删掉"
        );

        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM grid_items", [], |row| row.get(0))
            .expect("统计条目失败");
        assert_eq!(orphans, 0, "系统格的虚拟条目必须随格子一起清掉，不留孤儿行");

        // v8：老库升上来后「文件夹」格的 accent 必须能读成空串（不是 NULL）
        let accent: String = conn
            .query_row("SELECT accent FROM grid_boxes LIMIT 1", [], |row| row.get(0))
            .expect("v8 升级后 accent 读回失败");
        assert_eq!(accent, "", "老库升级后 accent 应为空串");

        assert_eq!(
            versions(&conn),
            MIGRATIONS.iter().map(|(v, _)| *v).collect::<Vec<_>>(),
            "全部迁移（含 v7 / v8）都应被记录"
        );

        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// v9：老库（停在 v8）里的「真搬运」登记必须被清干净，`category` 必须可读。
    ///
    /// 现场还原的是**真实的装机形态**：V33–V36 那几版把文件 `fs::rename` 进了
    /// `桌面/Toolbox整理/<格子名>/`，所以 `grid_items.file_path` 存的是那个目录下的真实路径。
    /// 换成引用模型后这些路径指向的文件已经不在那儿了（用户要么撤回过、要么还在
    /// 那 704 层嵌套里），留着就是一堆点不动的幽灵图标 —— 这正是用户截图里看到的景象。
    ///
    /// 两条断言各自守一个失败面：
    ///   ① 不清 `grid_items` → 升级后界面满屏幽灵图标（用户以为「东西还在」）；
    ///   ② 不加 `category` 列 / 缺省值给成 NULL → Rust 侧 `row.get::<String>` 直接报错，
    ///      表现成「桌面格子整个打不开」，比幽灵图标严重得多。
    #[test]
    fn v8_db_clears_legacy_move_registrations() {
        let (path, conn) = temp_conn("from-v8");
        apply_upto(&conn, 8);
        assert_eq!(versions(&conn), vec![1, 2, 3, 4, 5, 6, 7, 8], "预置应停在 v8");

        // 一个「真搬运」时代的格子 + 它下面指向 Toolbox整理 目录的两条登记
        conn.execute(
            "INSERT INTO grid_boxes (name, pos_x, pos_y, width, height, sort, created_at, updated_at) \
             VALUES ('文档', 0, 0, 320, 220, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .expect("预置格子失败");
        let box_id: i64 = conn
            .query_row("SELECT id FROM grid_boxes WHERE name = '文档'", [], |row| {
                row.get(0)
            })
            .expect("读取格子 id 失败");
        for (idx, name) in ["季度汇报.docx", "报销单.xlsx"].iter().enumerate() {
            conn.execute(
                "INSERT INTO grid_items (box_id, file_path, display_name, sort, created_at) \
                 VALUES (?1, ?2, ?3, ?4, '2026-01-01T00:00:00Z')",
                rusqlite::params![
                    box_id,
                    format!("C:\\Users\\me\\Desktop\\Toolbox整理\\文档\\{name}"),
                    name,
                    idx as i64
                ],
            )
            .expect("预置历史条目失败");
        }

        run(&conn).expect("v8 → 最新版本 升级失败");

        let items: i64 = conn
            .query_row("SELECT COUNT(*) FROM grid_items", [], |row| row.get(0))
            .expect("统计条目失败");
        assert_eq!(items, 0, "v9 必须清空指向已搬走文件的历史登记");

        // 格子本身不能跟着被删 —— 用户的布局（位置/大小/名字）得留着
        let boxes: i64 = conn
            .query_row("SELECT COUNT(*) FROM grid_boxes", [], |row| row.get(0))
            .expect("统计格子失败");
        assert_eq!(boxes, 1, "v9 只清登记，不能动用户的格子");

        let category: String = conn
            .query_row("SELECT category FROM grid_boxes LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("v9 升级后 category 读回失败（很可能是 NULL）");
        assert_eq!(category, "", "老库升级后 category 应为空串");

        assert_eq!(
            versions(&conn),
            MIGRATIONS.iter().map(|(v, _)| *v).collect::<Vec<_>>(),
            "全部迁移（含 v9）都应被记录"
        );

        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    /// 重复执行幂等：第二次 `run()` 不应报错、也不应重复插入版本行。
    #[test]
    fn run_is_idempotent() {
        let (path, conn) = temp_conn("repeat");
        run(&conn).expect("第一次迁移失败");
        let first = versions(&conn);
        run(&conn).expect("第二次迁移应直接跳过且不报错");
        assert_eq!(versions(&conn), first, "重复执行不得改变版本记录");

        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}
