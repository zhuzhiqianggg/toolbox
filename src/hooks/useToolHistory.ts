import * as React from 'react';

/**
 * 工具历史条目。
 *
 * `payload` 为回填所需的完整数据，由各工具自行定义具体形状
 * （如哈希工具存 `{ kind, input, digests }`，URL 工具存 `{ input, output, type, method }`）。
 */
export interface ToolHistoryEntry<TPayload = unknown> {
  id: string;
  /** 摘要文本（列表展示用，长文本请截断） */
  summary: string;
  /** 回填用的完整数据 */
  payload: TPayload;
  createdAt: number;
}

export interface UseToolHistoryOptions {
  /** 工具唯一 id，用于隔离存储 key */
  toolId: string;
  /** 上限，默认 20 */
  limit?: number;
  /** 是否持久化到 localStorage，默认 true */
  persist?: boolean;
}

export interface UseToolHistoryResult<T> {
  entries: Array<ToolHistoryEntry<T>>;
  push: (item: { summary: string; payload: T }) => void;
  remove: (id: string) => void;
  clear: () => void;
}

/** localStorage key 前缀（后缀 `.v1` 预留结构升级空间）。 */
const STORAGE_KEY_PREFIX = 'handy.tool.history.';
const STORAGE_KEY_SUFFIX = '.v1';
/** 默认历史上限。 */
const DEFAULT_LIMIT = 20;
/** 可用性探测结果缓存（undefined = 尚未探测）。 */
let cachedStorage: Storage | null | undefined;

/**
 * 解析可用的 localStorage。
 *
 * 非浏览器环境（无 `window`）或隐私模式 / 配额受限导致 `setItem` 抛错时返回 null，
 * hook 静默降级为「纯内存历史」，不会让工具页崩掉。
 */
function resolveStorage(): Storage | null {
  if (cachedStorage !== undefined) {
    return cachedStorage;
  }
  try {
    if (typeof window === 'undefined') {
      cachedStorage = null;
      return cachedStorage;
    }
    const candidate = window.localStorage;
    if (!candidate) {
      cachedStorage = null;
      return cachedStorage;
    }
    const probeKey = '__handy_history_probe__';
    candidate.setItem(probeKey, '1');
    candidate.removeItem(probeKey);
    cachedStorage = candidate;
  } catch {
    cachedStorage = null;
  }
  return cachedStorage;
}

/** 生成条目 id：`crypto.randomUUID` 优先，缺失时降级为时间戳 + 随机串。 */
function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // 某些环境下 randomUUID 存在但被策略禁用，走下面的降级分支
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 解析并校验历史数据。
 *
 * 任何一条结构不合法 / JSON 损坏 / 不是数组，都会被丢弃（而不是抛错），
 * 保证坏数据不会让工具页白屏。
 */
function parseEntries(raw: string | null): Array<ToolHistoryEntry<unknown>> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const entries: Array<ToolHistoryEntry<unknown>> = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const { id, summary, createdAt } = record;
    if (typeof id !== 'string' || typeof summary !== 'string') {
      continue;
    }
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
      continue;
    }
    entries.push({ id, summary, payload: record.payload, createdAt });
  }
  return entries;
}

/**
 * 通用工具历史 hook（哈希 / URL 等工具共用）。
 *
 * - 存储 key：`handy.tool.history.<toolId>.v1`；
 * - 超出 `limit` 自动裁剪最旧条目；
 * - localStorage 不可用时静默降级为纯内存（功能不受影响，仅不持久化）。
 *
 * @param options 工具 id / 上限 / 是否持久化
 */
export function useToolHistory<T = unknown>(
  options: UseToolHistoryOptions,
): UseToolHistoryResult<T> {
  const { toolId, limit = DEFAULT_LIMIT, persist = true } = options;
  const safeLimit = Math.max(1, Math.trunc(limit));
  const storageKey = `${STORAGE_KEY_PREFIX}${toolId}${STORAGE_KEY_SUFFIX}`;
  const storage = React.useMemo<Storage | null>(() => (persist ? resolveStorage() : null), [persist]);

  const [entries, setEntries] = React.useState<Array<ToolHistoryEntry<T>>>(() => {
    if (!storage) {
      return [];
    }
    try {
      // 存储层无类型信息，校验后按调用方的泛型断言（parseEntries 已做结构校验）
      return parseEntries(storage.getItem(storageKey)) as Array<ToolHistoryEntry<T>>;
    } catch {
      return [];
    }
  });

  // 持久化：写入失败（配额超限等）静默忽略，不影响工具使用
  React.useEffect(() => {
    if (!storage) {
      return;
    }
    try {
      storage.setItem(storageKey, JSON.stringify(entries));
    } catch {
      // 忽略：历史记录不是核心功能，不能因为它打断工具使用
    }
  }, [storage, storageKey, entries]);

  // 上限收窄（如设置项变更）后裁剪最旧条目
  React.useEffect(() => {
    setEntries((current) => (current.length > safeLimit ? current.slice(0, safeLimit) : current));
  }, [safeLimit]);

  const push = React.useCallback(
    (item: { summary: string; payload: T }): void => {
      setEntries((current) => {
        const entry: ToolHistoryEntry<T> = {
          id: createId(),
          summary: item.summary,
          payload: item.payload,
          createdAt: Date.now(),
        };
        return [entry, ...current].slice(0, safeLimit);
      });
    },
    [safeLimit],
  );

  const remove = React.useCallback((id: string): void => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const clear = React.useCallback((): void => {
    setEntries([]);
  }, []);

  return { entries, push, remove, clear };
}

export default useToolHistory;
