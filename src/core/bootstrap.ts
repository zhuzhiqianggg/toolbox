import { registry } from './moduleRegistry';
import { initPlatform } from '@/platform';
import { useAppStore } from '@/stores/useAppStore';
import { useFavoritesStore } from '@/stores/useFavoritesStore';
import { useRecentStore } from '@/stores/useRecentStore';

/**
 * 启动装配（ARCHITECTURE §3 `core/bootstrap.ts`）。
 *
 * 分两段（防挂死：首帧渲染只依赖同步段）：
 *   - `bootstrapSync()`：模块自动发现 + 注册表依赖注入（纯内存、幂等、不可能挂起）；
 *   - `bootstrap()`：在同步段之上追加配置态装配（settings / 收藏 / 最近 / 平台探测，
 *     涉及 IPC，理论上可能挂起——调用方（main.tsx）已加超时兜底）。
 */
let booted = false;

/** 同步装配：注册表就绪（渲染前必须完成；幂等，重复调用无副作用）。 */
export function bootstrapSync(): void {
  // 1) 自动发现：模块（glob）+ 系统命令（显式注册点）
  registry.discover();

  // 2) 注入注册表依赖（唯一事实源为 useAppStore.settings.modules）
  registry.setModuleSource(() => useAppStore.getState().settings.modules);
  registry.setPersistence((id, enabled) =>
    useAppStore.getState().setModuleEnabled(id, enabled),
  );
}

/** 完整装配：同步段 + 并行读取配置态与平台信息（平台探测失败自动降级，不阻塞）。 */
export async function bootstrap(): Promise<void> {
  if (booted) {
    return;
  }
  booted = true;

  bootstrapSync();

  await Promise.all([
    useAppStore.getState().hydrate(),
    useFavoritesStore.getState().hydrate(),
    useRecentStore.getState().hydrate(),
    initPlatform(),
  ]);
}
