import * as React from 'react';

/**
 * 工具状态持久化（V20，对应用户反馈 #3）。
 *
 * # 问题
 *
 * 「我打开的文本对比工具，最小化后然后再调出后就没了，又要重新打开工具和输入对比文本，
 * 每次太麻烦了。」—— 工具组件一卸载，React state 就没了。
 *
 * # 方案：把「用户正在编辑的输入」按命令 id 落进 localStorage
 *
 * - **落盘位置**：WebView2 的用户数据目录（同一应用的所有窗口共享），
 *   所以「主窗口最小化 → 恢复」「关掉工具再开」「重启应用」三种情况都能续上；
 * - **不落 settings.json**：那是配置态（跨窗口同步走 Rust），塞几万字正文会把它撑胖；
 *   这里存的是**草稿**，语义上更接近「上次没关掉的编辑器」；
 * - **防抖 400ms**：连续打字不写盘；卸载时同步 flush 一次；
 * - **容量护栏**：单工具单次序列化超过 [`MAX_BYTES`] 就**放弃本次写入**（保留上一次），
 *   避免把 10MB 的对比文本塞进 WebView 存储把应用拖慢。存储配额满 `QuotaExceededError`
 *   也在内部吞掉——丢草稿不该影响工具本身能用。
 *
 * # 用法
 *
 * ```ts
 * const [state, patch, reset] = useToolState('text-diff', { textA: '', textB: '', mode: 'split' });
 * patch({ textA: next });   // 改一个字段（浅合并）
 * reset();                  // 清空（回到 initial）
 * ```
 *
 * 注意：返回的 `state` 与 `initial` **浅合并**读取 —— 旧版本存过的字段缺失时自动补默认值，
 * 因此新增字段不需要迁移（与本项目 `settings.withDefaults` 同一套思路）。
 */

/** 存储键前缀（带应用名，避免与同源其它数据撞键） */
const PREFIX = 'handy.tool.';

/** 单工具单次写入上限（约 256KB 字符） */
const MAX_BYTES = 256 * 1024;

/** 写入防抖（毫秒） */
const WRITE_DEBOUNCE_MS = 400;

/** 读取一份持久化状态（不存在 / JSON 损坏 / 非对象均返回 null） */
function readState<T extends object>(commandId: string): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + commandId);
    if (raw === null || raw.length === 0) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

/** 写入一份持久化状态（超限 / 配额满时静默放弃） */
function writeState(commandId: string, value: unknown): void {
  try {
    const json = JSON.stringify(value);
    if (json.length > MAX_BYTES) {
      return;
    }
    window.localStorage.setItem(PREFIX + commandId, json);
  } catch {
    /* QuotaExceededError / 隐私模式：草稿丢失不影响工具可用 */
  }
}

/** 删除一份持久化状态 */
function clearState(commandId: string): void {
  try {
    window.localStorage.removeItem(PREFIX + commandId);
  } catch {
    /* 忽略 */
  }
}

/**
 * 带持久化的工具状态。
 *
 * @param commandId 命令 id（唯一键，如 `text-diff`）
 * @param initial   默认值（与已存值浅合并，缺失字段自动补全）
 */
export function useToolState<T extends object>(
  commandId: string,
  initial: T,
): [T, (patch: Partial<T>) => void, () => void] {
  // initial 只在首次挂载时参与合并，避免调用方每次渲染都传新对象导致反复重建
  const initialRef = React.useRef<T>(initial);
  const [state, setState] = React.useState<T>(() => {
    const saved = readState<Partial<T>>(commandId);
    return saved === null ? initialRef.current : { ...initialRef.current, ...saved };
  });

  const timerRef = React.useRef<number | undefined>(undefined);
  // 最新值镜像：卸载 flush 时读它，避免把过期闭包写回去
  const latestRef = React.useRef<T>(state);
  latestRef.current = state;

  React.useEffect(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      writeState(commandId, latestRef.current);
    }, WRITE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, [state, commandId]);

  // 卸载 / 切走工具：立刻落盘，绝不丢最后一次输入
  React.useEffect(
    () => () => {
      writeState(commandId, latestRef.current);
    },
    [commandId],
  );

  const patch = React.useCallback((next: Partial<T>): void => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  const reset = React.useCallback((): void => {
    clearState(commandId);
    setState(initialRef.current);
  }, [commandId]);

  return [state, patch, reset];
}

export default useToolState;
