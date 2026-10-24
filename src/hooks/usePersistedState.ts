import * as React from 'react';

/**
 * 单字段持久化状态（V24）。
 *
 * # 为什么不是直接用 `useToolState`
 *
 * [`useToolState`](./useToolState.ts) 一次接管**一整份对象**，适合「状态本来就集中在一个对象里」
 * 的工具（`text-diff` / `regex-tester` / `cron-descriptor`）。但工具箱里绝大多数工具的状态是
 * 散在十几个 `React.useState` 里的，要改用 `useToolState` 就得把每个 `setX(v)` 改成
 * `patch({ x: v })`、把 `setX(prev => …)` 全部拆掉 —— 改一两个文件还能忍，改十九个文件
 * 属于「为了持久化重写整个工具」，收益和风险完全不成比例。
 *
 * 所以这里提供一个**同为 `[value, setValue]` 签名**的替代品：
 *
 * ```diff
 * - const [input, setInput] = React.useState<string>(initialInput);
 * + const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput);
 * ```
 *
 * 一行替换，调用点一行都不用动 —— **含函数式更新**（`setInput(prev => prev + 'x')`）。
 *
 * # 存储布局
 *
 * 与 `useToolState` 共用一套键：`handy.tool.<commandId>` 下存**一个对象**，
 * 每个字段对应一个持久化状态。于是两类 hook 在同一个工具里也读写同一份数据。
 * （唯一约束：同一 `commandId` 不要既用 `useToolState` 又用 `usePersistedState`
 * —— `useToolState` 会把整份对象重写，覆盖掉另一边的字段。现状没有这样的工具。）
 *
 * 相同 `commandId` 的多个字段共享一份内存缓存 + 一次防抖写盘，
 * 所以十几个状态在一秒里连环变，只落盘一次。
 *
 * # 该持久化什么、不该持久化什么
 *
 * **只持久化「用户敲进去的输入」与「用户选的选项」**，不要持久化：
 *   - 派生结果（格式化输出、摘要、二维码 dataURL）—— 重算成本低，落盘纯属浪费；
 *   - 大块二进制/Base64 正文（图片工具）—— 直接把 WebView 存储撑胖；
 *   - **密钥类输入**（WiFi 密码、JWT secret）—— 落盘等于明文写进用户目录，
 *     与「保险箱加密存储」的约定自相矛盾。这类字段保持 `React.useState` 即可。
 */

/** 存储键前缀（与 `useToolState` 一致） */
const PREFIX = 'handy.tool.';

/** 单工具单次写入上限（约 256KB 字符），与 `useToolState` 对齐 */
const MAX_BYTES = 256 * 1024;

/** 写盘防抖（毫秒） */
const WRITE_DEBOUNCE_MS = 400;

/** 每个 commandId 的全部持久化字段（内存镜像，避免反复读 localStorage） */
const cache = new Map<string, Record<string, unknown>>();

/** 每个 commandId 的写盘定时器 */
const timers = new Map<string, number>();

/** 读过盘没有（区分「没读过」与「读出来是空」） */
const loaded = new Set<string>();

/** 首次读取：把该 commandId 的整份对象搬进内存 */
function load(commandId: string): Record<string, unknown> {
  if (loaded.has(commandId)) {
    return cache.get(commandId) ?? {};
  }
  loaded.add(commandId);
  let value: Record<string, unknown> = {};
  try {
    const raw = window.localStorage.getItem(PREFIX + commandId);
    if (raw !== null && raw.length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        value = parsed as Record<string, unknown>;
      }
    }
  } catch {
    /* 数据损坏 / 无 localStorage：当空处理，不影响工具可用 */
  }
  cache.set(commandId, value);
  return value;
}

/** 落盘（超限 / 配额满静默放弃） */
function persist(commandId: string): void {
  const value = cache.get(commandId);
  if (value === undefined) {
    return;
  }
  try {
    const json = JSON.stringify(value);
    if (json.length > MAX_BYTES) {
      return;
    }
    window.localStorage.setItem(PREFIX + commandId, json);
  } catch {
    /* QuotaExceededError / 隐私模式：丢草稿不该影响工具本身 */
  }
}

/** 防抖落盘（多个字段共享一次写入） */
function scheduleWrite(commandId: string): void {
  const existing = timers.get(commandId);
  if (existing !== undefined) {
    window.clearTimeout(existing);
  }
  const timer = window.setTimeout(() => {
    timers.delete(commandId);
    persist(commandId);
  }, WRITE_DEBOUNCE_MS);
  timers.set(commandId, timer);
}

/** 读取一个字段（缺失 / 类型不符时回退默认值） */
function readField<T>(commandId: string, key: string, fallback: T): T {
  const value = load(commandId)[key];
  if (value === undefined) {
    return fallback;
  }
  // 运行时类型漂移（旧版本存过别的类型）不信任，直接回退默认值
  if (typeof value !== typeof fallback) {
    return fallback;
  }
  return value as T;
}

/** 写入一个字段（立即进内存，防抖落盘） */
function writeField(commandId: string, key: string, value: unknown): void {
  const current = load(commandId);
  cache.set(commandId, { ...current, [key]: value });
  scheduleWrite(commandId);
}

/**
 * 单字段持久化状态。
 *
 * @param commandId 命令 id（唯一键，与 `useToolState` 同一套）
 * @param key       字段名（同一工具内唯一，如 `input` / `mode`）
 * @param initial   默认值（盘上没这个字段时用它）
 */
export function usePersistedState<T>(
  commandId: string,
  key: string,
  initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = React.useState<T>(() => readField(commandId, key, initial));

  // 卸载 / 切走工具：立刻落盘，绝不丢最后一次输入
  React.useEffect(
    () => () => {
      const existing = timers.get(commandId);
      if (existing !== undefined) {
        window.clearTimeout(existing);
        timers.delete(commandId);
      }
      persist(commandId);
    },
    [commandId],
  );

  const set = React.useCallback<React.Dispatch<React.SetStateAction<T>>>(
    (action) => {
      setState((prev) => {
        const next = typeof action === 'function' ? (action as (p: T) => T)(prev) : action;
        writeField(commandId, key, next);
        return next;
      });
    },
    [commandId, key],
  );

  return [state, set];
}

/** 清空某个工具的全部持久化草稿（供「重置」入口使用） */
export function clearPersisted(commandId: string): void {
  const existing = timers.get(commandId);
  if (existing !== undefined) {
    window.clearTimeout(existing);
    timers.delete(commandId);
  }
  cache.delete(commandId);
  loaded.delete(commandId);
  try {
    window.localStorage.removeItem(PREFIX + commandId);
  } catch {
    /* 忽略 */
  }
}

export default usePersistedState;
