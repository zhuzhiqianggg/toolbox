import { readSettings } from '@/lib/store';
import { useAppStore } from '@/stores/useAppStore';
import type { Tier } from './types';

/**
 * 授权 / 功能分级接口（ARCHITECTURE ADR-10）。
 *
 * ⚠️ 本期（Phase 1）**仅实现接口**，不联网、不接支付、不校验签名：
 *   - `getTier()` 恒返回本地缓存的分级（默认 `'free'`，读 `settings.json`）；
 *   - `activate()` 恒返回 `{ ok:false, reason:'not_implemented' }`；
 *   - L2 官方扩展包 / L3 第三方插件加载器不在本期范围。
 *
 * 模块 / 命令通过 `meta.tier` 参与判定：Pro 且未解锁时，UI 显示「升级」占位（不弹诱导付费）。
 */
export interface FeatureGate {
  featureId: string;
  minTier: Tier;
}

/** 激活结果（本期恒失败，占位契约） */
export interface ActivationResult {
  ok: boolean;
  reason?: string;
}

export interface LicenseProvider {
  /** 当前分级（读本地缓存，缺省 `'free'`） */
  getTier(): Promise<Tier>;
  /** 某功能是否已解锁 */
  isUnlocked(featureId: string): Promise<boolean>;
  /** 激活授权码（本期未实现） */
  activate(key: string): Promise<ActivationResult>;
  /** 全部功能门（供设置中心展示） */
  listGates(): FeatureGate[];
}

/** 本期功能门清单（示例占位；Pro 功能落地时在此登记）。 */
const GATES: readonly FeatureGate[] = [];

class StubLicenseProvider implements LicenseProvider {
  async getTier(): Promise<Tier> {
    try {
      const settings = await readSettings();
      return settings.tier;
    } catch {
      return 'free';
    }
  }

  async isUnlocked(featureId: string): Promise<boolean> {
    const gate = GATES.find((item) => item.featureId === featureId);
    if (!gate) {
      // 未登记门禁 = 免费功能
      return true;
    }
    if (gate.minTier === 'free') {
      return true;
    }
    return (await this.getTier()) === 'pro';
  }

  async activate(_key: string): Promise<ActivationResult> {
    void _key;
    return { ok: false, reason: 'not_implemented' };
  }

  listGates(): FeatureGate[] {
    return [...GATES];
  }
}

/** 授权单例（本期 stub） */
export const license: LicenseProvider = new StubLicenseProvider();

// —— V13 授权预留（常量态 + UI 门控）——

/**
 * 当前是否为 Pro（**常量态**，本期无任何真实校验；V14 接入授权校验后替换）。
 */
export const IS_PRO = false;

/**
 * Pro 专属模块白名单（本期占位为空；填充后免费态自动灰化对应模块入口）。
 */
export const PRO_MODULES: readonly string[] = [];

/** 某模块在当前授权态下是否被 Pro 门控锁定（灰化，不弹窗）。 */
export function isModuleLocked(moduleId: string): boolean {
  return !IS_PRO && PRO_MODULES.includes(moduleId);
}

/**
 * 授权态 hook（设置中心 / 模块开关区消费）。
 *
 * UI 门控口径：被锁模块入口**灰化 + 「Pro 版解锁」提示条**；
 * **不得弹窗诱导付费**——升级引导只做静态提示。
 */
export function useLicense(): {
  isPro: boolean;
  /** 某模块是否被门控锁定 */
  isModuleLocked: (moduleId: string) => boolean;
  /** 授权档位（free / pro，来自 settings.tier） */
  tier: Tier;
} {
  const tier = useAppStore((state) => state.settings.tier);
  return { isPro: IS_PRO, isModuleLocked, tier };
}
