import { invoke } from '@tauri-apps/api/core';

/**
 * 诊断上报：双通道。
 * 1. 自定义命令 `debug_log`（走 Rust log 门面 → Toolbox.log）；
 * 2. HTTP beacon 到本地收集器（9321，不依赖 Tauri IPC —— 当 invoke 通道整体
 *    失效时仍可拿到诊断；收集器未启动时静默失败）。
 * 诊断逻辑绝不反噬主流程：全部 catch 忽略。
 */
export function diagLog(message: string): void {
  try {
    invoke('debug_log', { message: `[diag] ${message}` }).catch(() => {
      /* ignore */
    });
  } catch {
    /* 非桌面环境 invoke 同步抛错，忽略 */
  }
  try {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const t = typeof internals !== 'undefined' ? 'yes' : 'no';
    navigator.sendBeacon(
      'http://127.0.0.1:9321/d',
      `${message} | internals=${t}`,
    );
  } catch {
    /* ignore */
  }
}

const LOAD_TIMEOUT_MS = 10_000;

/**
 * 惰性加载守卫：给 `import()` 动态加载加 START/OK/FAIL 诊断与超时兜底。
 * - 全程写 Toolbox.log（`[diag]` 前缀），桌面端加载卡死可直接看日志定位；
 * - 超时（默认 10s）自动 reject，避免「正在加载…」永久转圈。
 */
export function guardLoad<T extends { default: unknown }>(
  id: string,
  load: () => Promise<T>,
): Promise<T> {
  diagLog(`load START ${id}`);
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      // 打印最近的资源加载记录，辅助定位是哪个请求挂了
      const recent = performance
        .getEntriesByType('resource')
        .slice(-12)
        .map((entry) => {
          const res = entry as PerformanceResourceTiming;
          return `${Math.round(entry.duration)}ms/${res.transferSize}B ${entry.name.split('/').pop() ?? entry.name}`;
        })
        .join(' | ');
      diagLog(`load TIMEOUT ${id}; recent=[${recent}]`);
      reject(new Error(`界面加载超时（${LOAD_TIMEOUT_MS / 1000}s），详见日志文件`));
    }, LOAD_TIMEOUT_MS);
    load().then(
      (mod) => {
        window.clearTimeout(timer);
        diagLog(`load OK ${id}`);
        resolve(mod);
      },
      (err: unknown) => {
        window.clearTimeout(timer);
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        diagLog(`load FAIL ${id}: ${message}`);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
