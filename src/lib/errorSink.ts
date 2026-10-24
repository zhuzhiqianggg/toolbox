/**
 * 全局错误捕获 → 统一日志（V37）。
 *
 * 用户要求：「客户端操作报错要方便排查 —— 我这边测试出错后你能看日志解决」。
 * 以前的窘境是：界面里点了没反应、弹了个看不懂的错，**只有按 F12 开控制台才看得到**，
 * 而用户不会去开控制台。现在三个来源全部落到 `%LOCALAPPDATA%\Toolbox\toolbox.log`：
 *
 *   ① `window.onerror` —— 同步运行时错误与资源加载失败；
 *   ② `unhandledrejection` —— 没人 catch 的 Promise；
 *   ③ React 渲染错误 —— 由 ErrorBoundary 调 [`reportReactError`]。
 *
 * 一切都「尽力而为」：上报失败绝不抛出，绝不反过来把界面搞崩。
 */
import { ipc } from '@/lib/ipc';

/** 已上报过的错误指纹（渲染循环里的同一个错误会瞬间刷屏，只记第一次） */
const reported = new Set<string>();

/** 指纹上限：超过就整体清空 —— 最坏也就是重复记一次，不会让内存无界增长 */
const MAX_FINGERPRINTS = 200;

function report(level: 'error' | 'warn', message: string, detail?: string): void {
  const key = `${level}:${message}`;
  if (reported.has(key)) {
    return;
  }
  if (reported.size >= MAX_FINGERPRINTS) {
    reported.clear();
  }
  reported.add(key);
  // `logFrontend` 自己已经把失败吞掉了，这里再兜一层，保证「打日志」绝不会成为新的崩溃源
  void ipc.logFrontend(level, message, detail).catch(() => {
    /* ignore */
  });
}

/**
 * 安装全局捕获（幂等；`main.tsx` 启动时调一次）。
 *
 * 刻意不进 React 生命周期 —— 这些错误恰恰最可能发生在 React 挂载之前。
 */
export function installErrorSink(): void {
  window.addEventListener('error', (event) => {
    if (event.error instanceof Error) {
      report('error', `未捕获错误：${event.error.message}`, event.error.stack);
      return;
    }
    // 资源加载失败（img / script / link）不会带 event.error，但同样值得留痕：
    // 桌面端「白屏但没报错」十有八九就是某个资源没加载上
    const target = event.target as HTMLElement | null;
    const where =
      target && target !== (window as unknown as EventTarget)
        ? `${target.tagName} ${target.getAttribute('src') ?? target.getAttribute('href') ?? ''}`
        : 'window';
    report('error', `资源加载失败：${where}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    if (reason instanceof Error) {
      report('error', `未处理的 Promise 拒绝：${reason.message}`, reason.stack);
      return;
    }
    report('error', `未处理的 Promise 拒绝：${String(reason)}`);
  });
}

/** React 渲染期错误（ErrorBoundary 捕获后调它）。 */
export function reportReactError(error: Error, info: string): void {
  report(
    'error',
    `界面渲染出错：${error.message}`,
    `${error.stack ?? ''}\n组件栈：${info}`,
  );
}

/**
 * 手动记一条操作失败。
 *
 * 用于「有 catch、但只 toast 了一句」的地方 —— 用户看得到提示，我们却拿不到证据。
 * 关键操作（拖动、打开文件、归类、还原…）统一走这个。
 */
export function reportOperation(context: string, error: unknown): void {
  const detail =
    error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  report('error', `操作失败：${context}`, detail);
}

/** 记一条提示性信息（如「一键归类完成」），便于事后重建用户的操作序列。 */
export function reportAction(message: string): void {
  report('warn', message);
}
