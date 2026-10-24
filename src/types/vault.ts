/**
 * 密码存储器（M5）类型定义（与 Rust `commands/vault.rs` serde camelCase 一一对应）。
 */

/** 条目类别：账号密码 / 密钥与机密 / 安全笔记 */
export type VaultCategory = 'login' | 'secret' | 'note';

/** 密码库状态（vault_status / vault_setup / vault_unlock 返回） */
export interface VaultStatus {
  /** 是否已初始化（已设置主密码） */
  initialized: boolean;
  /** 密钥是否已在后端内存中（已解锁） */
  unlocked: boolean;
}

/** 机密条目（明文视图；仅存在于 IPC 传输与前端内存） */
export interface VaultItem {
  id: number;
  category: VaultCategory;
  title: string;
  /** login：用户名 */
  username: string | null;
  /** login：密码 / secret：密钥内容 / note：正文 */
  secret: string;
  /** login：网址 */
  url: string | null;
  /** 备注 */
  notes: string | null;
  /** ISO-8601 文本时间戳 */
  createdAt: string;
  updatedAt: string;
}

/** 新建条目入参 */
export interface VaultItemInput {
  category: VaultCategory;
  title: string;
  username?: string | null;
  secret: string;
  url?: string | null;
  notes?: string | null;
}

/** 编辑条目入参（仅传入需要修改的字段；类别不可修改） */
export interface VaultItemPatch {
  title?: string;
  username?: string | null;
  secret?: string;
  url?: string | null;
  notes?: string | null;
}
