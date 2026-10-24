import { isTauri } from '@/platform/detect';

/**
 * 跨窗口事件总线（轻量封装，V08 便签同步首发）。
 *
 * 双通道：
 *   - **本窗口内**：`busEmit` 同步派发给已注册的本地处理器（`busOn`）；
 *   - **跨窗口**：Tauri `emit` 广播（送达所有 WebView），各窗口经 `listen` 接收后
 *     同样派发到本地处理器。
 *
 * 回声抑制：`busEmit` 给 payload 注入 `source`（本窗口会话 id）并**先本地派发**；
 * Tauri 监听回调收到自身广播时按 `source` 识别并跳过，避免同一事件处理两次。
 *
 * 失败语义：广播失败仅记录日志、不阻断本地流程（写库已先完成，重开窗口可再同步）。
 */

/** 便签集合变更事件（载荷见 notesService.NoteChangedPayload） */
export const BUS_EVENT_NOTES_CHANGED = 'notes:changed';

/** 待办集合变更事件（载荷见 todosService.TodoChangedPayload） */
export const BUS_EVENT_TODOS_CHANGED = 'todos:changed';

/** 事件处理器 */
export type BusHandler<T> = (payload: T) => void;

/** 本窗口会话 id（非 Tauri 环境同样可用，用于回声抑制） */
const SESSION_ID: string =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** 本窗口会话 id（一般无需直接使用：`busEmit` 会自动注入 payload.source） */
export function busSource(): string {
  return SESSION_ID;
}

const handlers = new Map<string, Set<BusHandler<unknown>>>();
const listenedEvents = new Set<string>();
let tauriReady = false;

/** 派发事件给本窗口所有处理器（单个处理器异常不影响其他处理器）。 */
function dispatch(event: string, payload: unknown): void {
  const set = handlers.get(event);
  if (!set) {
    return;
  }
  for (const handler of set) {
    try {
      handler(payload);
    } catch (error: unknown) {
      console.error(`[Toolbox] 事件处理器异常（${event}）：`, error);
    }
  }
}

/**
 * 为某事件注册 Tauri 监听（惰性 + 幂等，仅 Tauri 宿主内生效）。
 * 首个本地处理器注册时建立，失败则允许后续重试。
 */
async function ensureTauriListener(event: string): Promise<void> {
  if (!isTauri() || listenedEvents.has(event)) {
    return;
  }
  listenedEvents.add(event);
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<Record<string, unknown>>(event, (evt) => {
      const payload = evt.payload as { source?: string } | null;
      // 回声抑制：跳过本窗口自己发出的广播
      if (payload && payload.source === SESSION_ID) {
        return;
      }
      dispatch(event, evt.payload);
    });
    tauriReady = true;
  } catch (error: unknown) {
    listenedEvents.delete(event);
    console.error(`[Toolbox] 注册事件监听失败（${event}）：`, error);
  }
}

/**
 * 订阅事件。返回取消订阅函数（幂等可重复调用）。
 * 订阅同时会（在 Tauri 宿主内）建立跨窗口监听。
 */
export function busOn<T>(event: string, handler: BusHandler<T>): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(handler as BusHandler<unknown>);
  void ensureTauriListener(event);
  return () => {
    const current = handlers.get(event);
    if (!current) {
      return;
    }
    current.delete(handler as BusHandler<unknown>);
    if (current.size === 0) {
      handlers.delete(event);
    }
  };
}

/**
 * 发送事件：本地立即派发 + （Tauri 宿主内）广播到所有窗口。
 * @param payload 会被浅拷贝并注入 `source`（会话 id，回声抑制用）
 */
export async function busEmit<T extends object>(event: string, payload: T): Promise<void> {
  const enriched = { ...payload, source: SESSION_ID };
  dispatch(event, enriched);

  if (!isTauri()) {
    return;
  }
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(event, enriched);
  } catch (error: unknown) {
    if (!tauriReady) {
      // 首次广播时事件插件可能未就绪，静默降级（本地派发已生效）
      return;
    }
    console.error(`[Toolbox] 广播事件失败（${event}）：`, error);
  }
}
