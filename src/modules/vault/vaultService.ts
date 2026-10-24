import { ipc } from '@/lib/ipc';
import type {
  VaultCategory,
  VaultItem,
  VaultItemInput,
  VaultItemPatch,
  VaultStatus,
} from '@/types/vault';

/**
 * 密码存储器数据服务（M5）。
 *
 * 与桌面整理一致：没有前端直连 SQL——全部加解密收敛在 Rust 侧（密钥永不
 * 离开 Rust 进程内存），本服务只做 IPC 封装与类别元数据。
 *
 * 安全边界：
 *   - 明文机密仅存在于 IPC 参数 / 返回值与前端内存；组件**禁止**把机密写入
 *     日志 / 历史 / localStorage；
 *   - `vaultList` 在锁定态会被 Rust 侧拒绝（返回「密码库已锁定」）。
 */

/** 查询密码库状态 */
export function status(): Promise<VaultStatus> {
  return ipc.vaultStatus();
}

/** 首次设置主密码（成功后进入解锁态） */
export function setup(masterPassword: string): Promise<VaultStatus> {
  return ipc.vaultSetup(masterPassword);
}

/** 解锁 */
export function unlock(masterPassword: string): Promise<VaultStatus> {
  return ipc.vaultUnlock(masterPassword);
}

/** 锁定 */
export function lock(): Promise<void> {
  return ipc.vaultLock();
}

/** 列出全部条目（明文视图） */
export function list(): Promise<VaultItem[]> {
  return ipc.vaultList();
}

/** 新建条目 */
export function create(input: VaultItemInput): Promise<VaultItem> {
  return ipc.vaultCreate(input);
}

/** 更新条目 */
export function update(itemId: number, patch: VaultItemPatch): Promise<VaultItem> {
  return ipc.vaultUpdate(itemId, patch);
}

/** 删除条目 */
export function remove(itemId: number): Promise<void> {
  return ipc.vaultDelete(itemId);
}

// —— 类别元数据（分组展示用） ——

export interface CategoryMeta {
  id: VaultCategory;
  /** 分组中文名 */
  label: string;
  /** 类别说明（空态提示） */
  hint: string;
}

export const VAULT_CATEGORIES: readonly CategoryMeta[] = [
  { id: 'login', label: '账号密码', hint: '网站 / 应用的用户名与密码' },
  { id: 'secret', label: '密钥与机密', hint: 'API Key、Token、私钥等机密内容' },
  { id: 'note', label: '安全笔记', hint: '恢复码、助记词等安全文字记录' },
] as const;

/** 类别 id → 中文名 */
export function categoryLabel(id: VaultCategory): string {
  return VAULT_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

/**
 * 主密码强度评估（0–4 分）：
 * 长度 ≥8 / ≥12、含数字、含大写、含非字母数字，各计 1 分。
 */
export function passwordScore(password: string): number {
  let score = 0;
  if (password.length >= 8) {
    score += 1;
  }
  if (password.length >= 12) {
    score += 1;
  }
  if (/[0-9]/.test(password)) {
    score += 1;
  }
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) {
    score += 1;
  }
  if (/[^0-9A-Za-z]/.test(password)) {
    score += 1;
  }
  return Math.min(score, 4);
}

/** 强度分档展示文案 */
export function passwordStrength(score: number): { label: string; className: string } {
  if (score <= 1) {
    return { label: '弱', className: 'text-red-600' };
  }
  if (score <= 2) {
    return { label: '中', className: 'text-amber-600' };
  }
  return { label: '强', className: 'text-emerald-600' };
}
