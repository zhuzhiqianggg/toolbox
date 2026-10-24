import { isTauri } from '@/platform/detect';

/**
 * SQLite 前端封装（`tauri-plugin-sql`，ARCHITECTURE ADR-7 / ARCHITECTURE §3 `lib/db.ts`）。
 *
 * 职责边界：
 *   - **实体数据**（便签/待办/剪贴板/使用历史…）经本模块读写 SQLite；
 *   - **应用级配置**（settings / 收藏 / 最近）请走 `src/lib/store.ts`（tauri-plugin-store）。
 *
 * 约定：业务代码**不直接** `import Database`，一律经 `db.select` / `db.execute`；
 * DB 连接惰性建立（首次调用才打开），冷启动不被 DB 阻塞（ARCHITECTURE §9）。
 */

/** 数据库 URL（须与 `tauri.conf.json` → `plugins.sql.preload` 一致）。 */
export const DB_URL = 'sqlite:handy.db';

/** 插件返回的行类型（宽松，由调用方以泛型收窄）。 */
export type DbRow = Record<string, unknown>;

/** 插件 Database 实例的最小接口（避免直接暴露第三方类型）。 */
interface SqlDatabase {
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
  close(): Promise<boolean>;
}

let handle: Promise<SqlDatabase> | null = null;

/** 惰性加载并缓存数据库连接（并发调用共享同一 Promise）。 */
function loadDatabase(): Promise<SqlDatabase> {
  if (handle === null) {
    handle = import('@tauri-apps/plugin-sql')
      .then(async ({ default: Database }) => {
        const db = (await Database.load(DB_URL)) as unknown as SqlDatabase;
        // 显式开启外键约束：**不赌** sqlx/驱动的连接默认值（延续 transaction 单连接
        // 事务的教训，QA P2）。PRAGMA 失败仅告警不阻断（行为回退数据库默认，不比现状差）。
        try {
          await db.execute('PRAGMA foreign_keys = ON;');
        } catch (pragmaError: unknown) {
          console.warn('[Handy] PRAGMA foreign_keys 设置失败（外键行为回退数据库默认）：', pragmaError);
        }
        return db;
      })
      .catch((error: unknown) => {
        handle = null; // 失败后允许重试
        throw new Error(`打开数据库失败：${String(error)}`);
      });
  }
  return handle;
}

/** 是否具备 SQLite 能力（仅 Tauri 宿主内可用）。 */
export function isDbAvailable(): boolean {
  return isTauri();
}

/**
 * 查询多行。
 * @param query SQL（使用 `?` / `$1` 占位符）
 * @param params 绑定参数
 */
export async function select<T extends DbRow = DbRow>(
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  const db = await loadDatabase();
  return db.select<T[]>(query, params);
}

/** 查询单行（无结果返回 null）。 */
export async function selectOne<T extends DbRow = DbRow>(
  query: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await select<T>(query, params);
  return rows[0] ?? null;
}

/**
 * 执行写语句（INSERT / UPDATE / DELETE）。
 * @returns 受影响行数与最近插入 id（若适用）
 */
export async function execute(
  query: string,
  params: unknown[] = [],
): Promise<{ rowsAffected: number; lastInsertId?: number }> {
  const db = await loadDatabase();
  return db.execute(query, params);
}

/** 关闭连接（应用退出或测试清理时调用）。 */
export async function close(): Promise<void> {
  if (handle === null) {
    return;
  }
  const db = await handle.catch(() => null);
  handle = null;
  if (db) {
    await db.close();
  }
}

/** 单条语句：完整 SQL 字符串，或带绑定参数的对象。 */
export type SqlStatement = string | { sql: string; params?: unknown[] };

/**
 * 事务执行：在同一连接内原子执行多条语句。
 *
 * **实现选择（方案 A）与理由：**
 * `tauri-plugin-sql` 的 `execute` 每次都从 **连接池** 取连接，因此旧实现里分多次发
 * `BEGIN` / `COMMIT` **可能拿到不同连接**，事务边界不成立（并发下会静默出错）。
 *
 * 本实现把 `BEGIN; <语句…>; COMMIT;` **拼成一次 `execute` 调用**：经查 sqlx-sqlite 源码，
 * 其 `prepare` 走的是 `VirtualStatement`（按 `;` 拆分多条语句、在**同一连接**上顺序执行），
 * 且参数按语句出现顺序**跨语句位置绑定**——故一次 `execute` 即构成真正的单连接事务。
 *
 * 使用约束：
 *   - 每条 `sql` 为**单条语句**，勿带结尾 `;`（内部会去除）；
 *   - `params` 按语句顺序展平绑定，占位符（`?`）顺序须与之对应；纯字符串语句不应含占位符。
 *
 * 注意（失败路径）：若中途语句报错，SQLite 可能在该池化连接上遗留未结束的事务；本方法会
 * 原样向上抛出错误。若 V08 起需要「失败即自动回滚」的强保证，建议改为 Rust 侧单连接事务命令。
 */
export async function transaction(statements: SqlStatement[]): Promise<void> {
  const parts: string[] = [];
  const params: unknown[] = [];

  for (const statement of statements) {
    const text = (typeof statement === 'string' ? statement : statement.sql)
      .trim()
      .replace(/;\s*$/, '');
    if (text.length === 0) {
      continue;
    }
    parts.push(text);
    if (typeof statement !== 'string' && statement.params) {
      params.push(...statement.params);
    }
  }

  if (parts.length === 0) {
    return;
  }

  const db = await loadDatabase();
  await db.execute(['BEGIN', ...parts, 'COMMIT'].join(';'), params);
}
