import { isTauri } from '@/platform/detect';
import { DEFAULT_SETTINGS, SETTINGS_KEY, resolveQuickActionIds, type AppSettings } from '@/core/settings';

/**
 * 应用级配置持久化（`tauri-plugin-store` → `settings.json`）。
 *
 * 职责边界（ADR-7）：**只存应用级配置**（settings / 模块开关 / Pro 标记），不存业务实体数据
 * （便签/待办/剪贴板等实体走 SQLite，见 `src/lib/db.ts`）。
 *
 * 纯浏览器 dev 环境（无 Tauri）自动降级到 `localStorage`，保证 `npm run dev` 可用。
 */

/** 通用 KV 抽象（屏蔽 Tauri / 浏览器差异） */
interface KvBackend {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

const LS_PREFIX = 'handy:';

/** 浏览器降级后端：localStorage（同步 API 包装为 Promise） */
const localStorageBackend: KvBackend = {
  async get<T>(key: string): Promise<T | undefined> {
    if (typeof localStorage === 'undefined') {
      return undefined;
    }
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw === null) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  },
  async set<T>(key: string, value: T): Promise<void> {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  },
  async remove(key: string): Promise<void> {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.removeItem(LS_PREFIX + key);
  },
};

/** Tauri 后端：`tauri-plugin-store`（settings.json，autoSave） */
function createTauriBackend(): KvBackend {
  // 延迟 import，避免非 Tauri 环境加载插件
  const storePromise = import('@tauri-apps/plugin-store').then(({ load }) =>
    load('settings.json', { autoSave: true }),
  );

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const store = await storePromise;
      return store.get<T>(key);
    },
    async set<T>(key: string, value: T): Promise<void> {
      const store = await storePromise;
      await store.set(key, value);
    },
    async remove(key: string): Promise<void> {
      const store = await storePromise;
      await store.delete(key);
    },
  };
}

let backend: KvBackend | null = null;

/** 取当前后端（首次调用时按环境选择） */
function getBackend(): KvBackend {
  if (backend === null) {
    backend = isTauri() ? createTauriBackend() : localStorageBackend;
  }
  return backend;
}

/** 读取任意配置键 */
export async function readKey<T>(key: string): Promise<T | undefined> {
  try {
    return await getBackend().get<T>(key);
  } catch {
    return undefined;
  }
}

/** 写入任意配置键 */
export async function writeKey<T>(key: string, value: T): Promise<void> {
  try {
    await getBackend().set(key, value);
  } catch {
    // 写入失败静默降级（不阻断 UI）
  }
}

/** 删除配置键 */
export async function deleteKey(key: string): Promise<void> {
  try {
    await getBackend().remove(key);
  } catch {
    // 忽略
  }
}

/** 读取字符串数组（如 favorites / recent），非法值返回空数组 */
export async function readStringArray(key: string): Promise<string[]> {
  const value = await readKey<unknown>(key);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

/** 合并默认值，得到完整 AppSettings */
function withDefaults(stored: Partial<AppSettings> | undefined): AppSettings {
  // V55：旧版默认 theme='light'，已落盘的用户会一直停留在浅色。
  // 这里把 'light' 迁移为 'system'（跟随系统），只有用户显式选过 'dark' 才保留。
  const storedTheme = stored?.theme;
  const theme = storedTheme === 'dark' || storedTheme === 'system' ? storedTheme : 'system';
  return {
    ...DEFAULT_SETTINGS,
    ...(stored ?? {}),
    theme,
    modules: { ...DEFAULT_SETTINGS.modules, ...(stored?.modules ?? {}) },
    // V56：快捷入口的口径变过一次（默认里不再放任务管理器这类随处可得的入口）。
    // 已装机的 `settings.json` 里落盘的是**旧默认**，只改 DEFAULT_QUICK_ACTION_IDS
    // 对老用户毫无作用 —— 所以在这里判一次：用户没亲手改过（无标记）就按当前默认重算，
    // 改过就以他存的为准。细节与「为什么不能就地剔 A 补 B」见
    // `core/settings.ts` 的 `resolveQuickActionIds`。
    quickActionIds: resolveQuickActionIds(
      stored?.quickActionIds,
      stored?.quickActionsCustomized === true,
    ),
  };
}

/** 读取完整应用设置（缺省字段用默认值补齐） */
export async function readSettings(): Promise<AppSettings> {
  const stored = await readKey<Partial<AppSettings>>(SETTINGS_KEY);
  return withDefaults(stored);
}

/**
 * 局部更新设置（read-modify-write，保留 `modules` 等未被本次修改的字段）。
 *
 * 注意：模块启停（`modules`）的正常写路径在桌面端经 Rust 命令，本函数写入时会先读回
 * 最新对象再合并，避免覆盖 Rust 侧刚写入的 `modules`。
 */
export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await readSettings();
  const next: AppSettings = { ...current, ...patch };
  await writeKey(SETTINGS_KEY, next);
  return next;
}

/** 覆盖写入完整设置 */
export async function writeSettings(settings: AppSettings): Promise<void> {
  await writeKey(SETTINGS_KEY, settings);
}
