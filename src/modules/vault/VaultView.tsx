import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { copyText } from '@/lib/clipboard';
import { toast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { generateStrongPassword } from '@/lib/passwordGen';
import {
  VAULT_CATEGORIES,
  categoryLabel,
  passwordScore,
  passwordStrength,
} from './vaultService';
import * as vaultService from './vaultService';
import { isTauri } from '@/platform/detect';
import type { VaultCategory, VaultItem } from '@/types/vault';

/**
 * 密码存储器视图。
 *
 * V45：**不再是独立模块，改为工具箱里的一个工具**（用户：「密码存储建议也作为工具箱的
 * 其中一个工具吧 不要一个独立的工具箱模块」）。本文件的路径与实现保持不变，唯一变化是
 * 注册方式：`modules/vault/index.ts`（模块注册）已删除，改由工具箱命令表里的 `vault`
 * 条目经 `toolbox/commands/Vault.tsx` 引用本视图，分类「安全存储」。
 *
 * 状态机：loading → setup（未初始化）/ locked（已初始化未解锁）→ unlocked。
 * unlocked 态提供：搜索、按类别分组展示、显示/隐藏机密（15s 自动隐藏）、
 * 复制（20s 后自动清空剪贴板）、新增/编辑（对话框）、两步确认删除、
 * 手动锁定与 5 分钟无操作自动锁定。
 *
 * 安全约定：机密只在内存中短暂展示；禁止把明文机密写入日志 / 历史 / 存储。
 */

/** 无操作自动锁定时长（5 分钟） */
const VAULT_IDLE_LOCK_MS = 5 * 60 * 1000;
/** 机密显示后自动隐藏时长（15 秒） */
const SECRET_AUTO_HIDE_MS = 15_000;
/** 复制后自动清空剪贴板时长（20 秒） */
const CLIPBOARD_AUTO_CLEAR_MS = 20_000;
/** 删除二次确认的复位时长（3 秒） */
const DELETE_CONFIRM_RESET_MS = 3_000;

type Phase = 'loading' | 'setup' | 'locked' | 'unlocked';

/** 时间展示（如 `3/2 14:05`） */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 新建 / 编辑对话框状态 */
interface DialogState {
  open: boolean;
  /** 非空 = 编辑该条目；null = 新建 */
  editing: VaultItem | null;
  category: VaultCategory;
  title: string;
  username: string;
  secret: string;
  url: string;
  notes: string;
}

/** 空白对话框状态 */
function emptyDialog(category: VaultCategory = 'login'): DialogState {
  return {
    open: false,
    editing: null,
    category,
    title: '',
    username: '',
    secret: '',
    url: '',
    notes: '',
  };
}

export default function VaultView(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading');
  const [items, setItems] = useState<VaultItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<DialogState>(emptyDialog);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  /** 机密自动隐藏定时器（itemId → timer） */
  const revealTimersRef = useRef(new Map<number, number>());
  /** 剪贴板自动清空定时器（单个，重复复制时重置） */
  const clipboardTimerRef = useRef<number | null>(null);
  /** 删除确认复位定时器 */
  const deleteTimerRef = useRef<number | null>(null);

  /** 拉取状态并刷新列表（解锁后调用） */
  const loadItems = useCallback(async (): Promise<void> => {
    try {
      const list = await vaultService.list();
      setItems(list);
      setLoadError(null);
      setPhase('unlocked');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // 锁定态 / 会话失效 → 回到锁定页（机密一并清空）
      setLoadError(message.includes('已锁定') ? null : message);
      setItems([]);
      setPhase('locked');
    }
  }, []);

  /** 启动时探测库状态 */
  useEffect(() => {
    let alive = true;
    void vaultService
      .status()
      .then((st) => {
        if (!alive) {
          return;
        }
        if (st.unlocked) {
          void loadItems();
        } else {
          setPhase(st.initialized ? 'locked' : 'setup');
        }
      })
      .catch((err: unknown) => {
        if (alive) {
          setPhase('locked');
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      alive = false;
    };
  }, [loadItems]);

  /** 清理全部展示态（锁定 / 卸载时调用，机密不残留内存） */
  const clearSecretState = useCallback((): void => {
    for (const timer of revealTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    revealTimersRef.current.clear();
    if (clipboardTimerRef.current !== null) {
      window.clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = null;
    }
    if (deleteTimerRef.current !== null) {
      window.clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
    setRevealed(new Set());
    setConfirmDeleteId(null);
  }, []);

  /** 锁定：清后端密钥 + 清前端展示态 */
  const handleLock = useCallback((): void => {
    clearSecretState();
    setDialog(emptyDialog());
    setItems([]);
    setQuery('');
    setLoadError(null);
    void vaultService
      .lock()
      .then(() => setPhase('locked'))
      .catch((err: unknown) => toast.error(`锁定失败：${err instanceof Error ? err.message : String(err)}`));
  }, [clearSecretState]);

  /** 空闲自动锁定：unlocked 态监听交互事件，5 分钟无操作即锁定 */
  useEffect(() => {
    if (phase !== 'unlocked') {
      return;
    }
    let timer = window.setTimeout(handleLock, VAULT_IDLE_LOCK_MS);
    const reset = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(handleLock, VAULT_IDLE_LOCK_MS);
    };
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'mousemove', 'wheel'];
    for (const event of events) {
      window.addEventListener(event, reset, { passive: true });
    }
    return () => {
      window.clearTimeout(timer);
      for (const event of events) {
        window.removeEventListener(event, reset);
      }
    };
  }, [phase, handleLock]);

  /** 卸载时清理定时器 */
  useEffect(() => clearSecretState, [clearSecretState]);

  /** 复制机密：复制成功后 20 秒自动清空剪贴板 */
  const handleCopy = useCallback((item: VaultItem): void => {
    void copyText(item.secret).then((ok) => {
      if (!ok) {
        toast.error('复制失败，请手动复制');
        return;
      }
      toast.success('已复制到剪贴板，20 秒后自动清空');
      if (clipboardTimerRef.current !== null) {
        window.clearTimeout(clipboardTimerRef.current);
      }
      clipboardTimerRef.current = window.setTimeout(() => {
        clipboardTimerRef.current = null;
        void copyText('').catch(() => undefined);
      }, CLIPBOARD_AUTO_CLEAR_MS);
    });
  }, []);

  /** 显示 / 隐藏机密；显示后 15 秒自动隐藏 */
  const toggleReveal = useCallback((itemId: number): void => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        const timer = revealTimersRef.current.get(itemId);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          revealTimersRef.current.delete(itemId);
        }
        next.delete(itemId);
      } else {
        next.add(itemId);
        const timer = window.setTimeout(() => {
          revealTimersRef.current.delete(itemId);
          setRevealed((cur) => {
            const without = new Set(cur);
            without.delete(itemId);
            return without;
          });
        }, SECRET_AUTO_HIDE_MS);
        revealTimersRef.current.set(itemId, timer);
      }
      return next;
    });
  }, []);

  /** 两步确认删除 */
  const handleDelete = useCallback(
    (itemId: number): void => {
      if (confirmDeleteId !== itemId) {
        setConfirmDeleteId(itemId);
        if (deleteTimerRef.current !== null) {
          window.clearTimeout(deleteTimerRef.current);
        }
        deleteTimerRef.current = window.setTimeout(() => setConfirmDeleteId(null), DELETE_CONFIRM_RESET_MS);
        return;
      }
      if (deleteTimerRef.current !== null) {
        window.clearTimeout(deleteTimerRef.current);
        deleteTimerRef.current = null;
      }
      setConfirmDeleteId(null);
      void vaultService
        .remove(itemId)
        .then(() => {
          setItems((prev) => prev.filter((it) => it.id !== itemId));
          toast.success('已删除');
        })
        .catch((err: unknown) => toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`));
    },
    [confirmDeleteId],
  );

  /** 搜索过滤（标题 / 用户名 / 备注 / 密钥内容） */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
      return items;
    }
    return items.filter((it) =>
      [it.title, it.username ?? '', it.notes ?? '', it.secret]
        .join('\n')
        .toLowerCase()
        .includes(q),
    );
  }, [items, query]);

  /** 按类别分组 */
  const groups = useMemo(
    () =>
      VAULT_CATEGORIES.map((meta) => ({
        meta,
        list: filtered.filter((it) => it.category === meta.id),
      })),
    [filtered],
  );

  if (phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">正在读取密码库状态…</p>
      </div>
    );
  }

  if (phase === 'setup') {
    return <SetupForm onDone={loadItems} />;
  }

  if (phase === 'locked') {
    return <UnlockForm onUnlock={loadItems} error={loadError} />;
  }

  return (
    <div className="flex h-full flex-col">
      {/* 工具条：搜索 / 新增 / 锁定 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、用户名、备注或内容"
            className="h-8 w-full rounded-md border bg-transparent pl-7 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-brand"
          />
        </div>
        <button
          type="button"
          onClick={() => setDialog({ ...emptyDialog('login'), open: true })}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-brand px-3 text-xs font-medium text-white transition hover:bg-brand/90"
        >
          <Plus className="h-3.5 w-3.5" />
          新增
        </button>
        <button
          type="button"
          onClick={handleLock}
          title="锁定密码库"
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-3 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <Lock className="h-3.5 w-3.5" />
          锁定
        </button>
      </div>

      {loadError && (
        <div className="mx-4 mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {loadError}
        </div>
      )}

      {/* 安全说明：把「到底安全在哪」直接写清楚，而不是让用户猜 */}
      <SecurityNotice />

      {/* 分组列表 */}
      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-4 py-3">
        {items.length === 0 && !loadError && (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 pt-16 text-center">
            <KeyRound className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">密码库是空的</p>
            <p className="text-xs text-muted-foreground/70">点击右上角「新增」保存第一条账号或密钥</p>
          </div>
        )}
        {items.length > 0 && filtered.length === 0 && (
          <p className="pt-8 text-center text-sm text-muted-foreground">没有匹配「{query}」的条目</p>
        )}
        <div className="flex flex-col gap-4">
          {groups.map(({ meta, list }) =>
            list.length === 0 ? null : (
              <section key={meta.id}>
                <h3 className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">
                  {meta.label} · {list.length}
                </h3>
                <div className="flex flex-col gap-1.5">
                  {list.map((item) => (
                    <VaultItemRow
                      key={item.id}
                      item={item}
                      revealed={revealed.has(item.id)}
                      confirmingDelete={confirmDeleteId === item.id}
                      onToggleReveal={() => toggleReveal(item.id)}
                      onCopy={() => handleCopy(item)}
                      onEdit={() =>
                        setDialog({
                          open: true,
                          editing: item,
                          category: item.category,
                          title: item.title,
                          username: item.username ?? '',
                          secret: item.secret,
                          url: item.url ?? '',
                          notes: item.notes ?? '',
                        })
                      }
                      onDelete={() => handleDelete(item.id)}
                    />
                  ))}
                </div>
              </section>
            ),
          )}
        </div>
      </div>

      {/* 新增 / 编辑对话框 */}
      <VaultItemDialog
        state={dialog}
        onChange={setDialog}
        onSaved={(): void => {
          setDialog(emptyDialog());
          void loadItems();
        }}
      />
    </div>
  );
}

// —— 条目行 ——

interface VaultItemRowProps {
  item: VaultItem;
  revealed: boolean;
  confirmingDelete: boolean;
  onToggleReveal: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function VaultItemRow(props: VaultItemRowProps): React.JSX.Element {
  const { item, revealed, confirmingDelete } = props;
  return (
    <div className="group flex items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 transition hover:border-border hover:bg-accent/50">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{item.title}</div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
          {item.category === 'login' && item.username && (
            <span className="truncate">{item.username}</span>
          )}
          {item.category === 'login' && item.url && (
            <span className="truncate opacity-80">{item.url}</span>
          )}
          <span className="shrink-0">更新于 {formatDateTime(item.updatedAt)}</span>
        </div>
        {/* 机密行：默认打码，点眼睛显示（15s 自动隐藏） */}
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <code
            className={cn(
              'block min-w-0 flex-1 truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/90',
              !revealed && 'select-none tracking-widest',
            )}
          >
            {revealed ? item.secret : '••••••••••'}
          </code>
          <button
            type="button"
            title={revealed ? '隐藏' : '显示'}
            onClick={props.onToggleReveal}
            className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          title="复制到剪贴板（20 秒后自动清空）"
          onClick={props.onCopy}
          className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="编辑"
          onClick={props.onEdit}
          className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={confirmingDelete ? '再次点击确认删除' : '删除'}
          onClick={props.onDelete}
          className={cn(
            'rounded p-1 transition',
            confirmingDelete
              ? 'bg-destructive/10 text-destructive'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// —— 安全说明（解锁后常驻的一行提示 + 可展开明细） ——

/**
 * 密码存储器安全说明。
 *
 * 产品判断：一个存密码的工具，**必须把安全模型摊开讲清楚**——用户有权知道
 * 「密钥怎么来的、存在哪、有没有联网、什么情况下会被人看到」。
 * 含糊其辞的「已加密」既不能建立信任，也不能帮助用户规避风险。
 */
function SecurityNotice(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mx-4 mt-2 rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-left"
      >
        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-700" />
        <span className="min-w-0 flex-1 text-xs text-emerald-900">
          本地加密：主密码经 Argon2id 派生密钥 → AES-256-GCM 逐字段加密；主密码与明文均不落盘、不联网。
        </span>
        <span className="shrink-0 text-[11px] text-emerald-700">{open ? '收起' : '详情'}</span>
      </button>
      {open ? (
        <ul className="mt-2 flex flex-col gap-1 pl-5 text-[11px] leading-relaxed text-emerald-900/90">
          <li>· 主密码经 Argon2id（内存 19 MiB / 迭代 2 轮）派生 32 字节密钥，密钥只存在于应用进程内存。</li>
          <li>· 每个字段独立 AES-256-GCM 加密；每次写入生成新的 12 字节随机 nonce，绝不复用。</li>
          <li>· 数据库里只有「盐 + 校验密文 + 各字段密文」，没有主密码、没有密钥、没有明文。</li>
          <li>· 全程不访问网络：不存在云端同步，也就不存在服务端泄露路径。</li>
          <li>· 遗忘主密码 = 数据永久不可解密（无后门、无找回），请自行妥善记忆。</li>
          <li>· 已解锁状态下，能操作这台已登录电脑的人可直接查看条目 —— 离开时点「锁定」，闲置 5 分钟也会自动锁定。</li>
          <li>· 复制机密 20 秒后自动清空剪贴板，避免留在系统剪贴板历史里。</li>
        </ul>
      ) : null}
    </div>
  );
}

// —— 设置主密码 / 解锁 ——

interface AuthFormProps {
  onDone: () => void;
}

/** 首次使用：设置主密码（含强度提示与「无法找回」警示） */
function SetupForm({ onDone }: AuthFormProps): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const score = passwordScore(password);
  const strength = passwordStrength(score);

  const submit = (): void => {
    if (busy) {
      return;
    }
    if (password.length < 6) {
      setError('主密码至少需要 6 位');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的主密码不一致');
      return;
    }
    setBusy(true);
    setError(null);
    void vaultService
      .setup(password)
      .then(() => {
        toast.success('密码库已创建');
        onDone();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <form
        className="w-full max-w-xs rounded-xl border border-border bg-card p-5 shadow-popover"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="mb-4 flex flex-col items-center gap-1.5 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-muted text-brand">
            <KeyRound className="h-5 w-5" />
          </span>
          <h2 className="text-sm font-semibold text-foreground">设置主密码</h2>
          <p className="text-xs text-muted-foreground">主密码用于加密你的全部机密内容</p>
        </div>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="主密码（至少 6 位）"
          autoFocus
          className="mb-2 h-9 w-full rounded-md border bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-brand"
        />
        {password.length > 0 && (
          <p className={cn('mb-1 text-[11px]', strength.className)}>
            强度：{strength.label}
          </p>
        )}
        <input
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          placeholder="确认主密码"
          className="mb-3 h-9 w-full rounded-md border bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-brand"
        />
        <p className="mb-3 rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700">
          ⚠ 主密码无法找回：遗忘后密码库内所有数据将无法解密，请务必牢记。
        </p>
        {error && (
          <p className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="h-9 w-full rounded-md bg-brand text-xs font-medium text-white transition hover:bg-brand/90 disabled:opacity-60"
        >
          {busy ? '创建中…' : '创建密码库'}
        </button>
      </form>
    </div>
  );
}

/** 已初始化：解锁表单 */
function UnlockForm({
  onUnlock,
  error,
}: {
  onUnlock: () => void;
  error: string | null;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const shownError = localError ?? error;

  const submit = (): void => {
    if (busy || password.length === 0) {
      return;
    }
    setBusy(true);
    setLocalError(null);
    void vaultService
      .unlock(password)
      .then(() => onUnlock())
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setBusy(false);
        setPassword('');
      });
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <form
        className="w-full max-w-xs rounded-xl border border-border bg-card p-5 shadow-popover"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="mb-4 flex flex-col items-center gap-1.5 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-muted text-brand">
            <Lock className="h-5 w-5" />
          </span>
          <h2 className="text-sm font-semibold text-foreground">密码库已锁定</h2>
          <p className="text-xs text-muted-foreground">输入主密码解锁</p>
        </div>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="主密码"
          autoFocus
          className="mb-3 h-9 w-full rounded-md border bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-brand"
        />
        {shownError && (
          <p className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
            {shownError}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="h-9 w-full rounded-md bg-brand text-xs font-medium text-white transition hover:bg-brand/90 disabled:opacity-60"
        >
          {busy ? '解锁中…' : '解锁'}
        </button>
      </form>
    </div>
  );
}

// —— 新增 / 编辑对话框 ——

interface VaultItemDialogProps {
  state: DialogState;
  onChange: (next: DialogState) => void;
  onSaved: () => void;
}

function VaultItemDialog(props: VaultItemDialogProps): React.JSX.Element {
  const { state, onChange, onSaved } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLogin = state.category === 'login';

  /** 依据类别决定「机密」字段的标签 */
  const secretLabel = isLogin ? '密码' : state.category === 'secret' ? '密钥内容' : '正文';

  const close = (): void => {
    if (!busy) {
      onChange(emptyDialog(state.category));
    }
  };

  const save = (): void => {
    if (busy) {
      return;
    }
    const title = state.title.trim();
    if (title.length === 0) {
      setError('标题不能为空');
      return;
    }
    if (state.secret.length === 0) {
      setError(`${secretLabel}不能为空`);
      return;
    }
    setBusy(true);
    setError(null);
    const done = (): void => {
      toast.success(state.editing ? '已保存' : '已添加');
      onSaved();
    };
    const fail = (err: unknown): void => {
      setError(err instanceof Error ? err.message : String(err));
    };
    if (state.editing) {
      void vaultService
        .update(state.editing.id, {
          title,
          username: isLogin ? state.username : null,
          secret: state.secret,
          url: isLogin ? state.url : null,
          notes: state.notes,
        })
        .then(done)
        .catch(fail)
        .finally(() => setBusy(false));
    } else {
      void vaultService
        .create({
          category: state.category,
          title,
          username: isLogin ? state.username : null,
          secret: state.secret,
          url: isLogin ? state.url : null,
          notes: state.notes,
        })
        .then(done)
        .catch(fail)
        .finally(() => setBusy(false));
    }
  };

  return (
    <Dialog open={state.open} onOpenChange={(open: boolean) => (open ? undefined : close())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{state.editing ? '编辑条目' : '新增条目'}</DialogTitle>
          <DialogDescription>
            {state.editing ? `类别：${categoryLabel(state.editing.category)}（不可修改）` : '数据经主密码加密后存储'}
          </DialogDescription>
        </DialogHeader>

        {/* 类别选择（仅新增时可选） */}
        {!state.editing && (
          <div className="flex gap-1.5">
            {VAULT_CATEGORIES.map((meta) => (
              <button
                key={meta.id}
                type="button"
                onClick={() => onChange({ ...state, category: meta.id })}
                className={cn(
                  'flex-1 rounded-md border px-2 py-1.5 text-xs transition',
                  state.category === meta.id
                    ? 'border-brand bg-brand-muted/60 font-medium text-brand'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {meta.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          <LabeledInput label="标题" value={state.title} onChange={(v) => onChange({ ...state, title: v })} />
          {isLogin && (
            <LabeledInput
              label="用户名"
              value={state.username}
              onChange={(v) => onChange({ ...state, username: v })}
            />
          )}
          <LabeledInput
            label={secretLabel}
            value={state.secret}
            onChange={(v) => onChange({ ...state, secret: v })}
            type="password"
            multiline={state.category !== 'login'}
            placeholder={state.category === 'note' ? '安全笔记正文' : undefined}
            action={
              state.category === 'login'
                ? {
                    // 与工具箱「密码生成器」同源的安全实现（crypto + 拒绝采样，
                    // 四类字符各至少一次、首尾为字母）
                    label: '生成密码',
                    icon: <Sparkles className="h-3 w-3" />,
                    onClick: () => onChange({ ...state, secret: generateStrongPassword(20) }),
                  }
                : undefined
            }
          />
          {isLogin && (
            <LabeledInput
              label="网址"
              value={state.url}
              onChange={(v) => onChange({ ...state, url: v })}
              placeholder="https://"
            />
          )}
          {state.category !== 'note' && (
            <LabeledInput
              label="备注"
              value={state.notes}
              onChange={(v) => onChange({ ...state, notes: v })}
              multiline
            />
          )}
        </div>

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="h-8 rounded-md border px-3 text-xs text-muted-foreground transition hover:bg-accent disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="h-8 rounded-md bg-brand px-3 text-xs font-medium text-white transition hover:bg-brand/90 disabled:opacity-60"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// —— 表单小组件 ——

interface LabeledInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  multiline?: boolean;
  placeholder?: string;
  /** 标签行右侧的小动作按钮（如「生成密码」） */
  action?: { label: string; icon?: React.ReactNode; onClick: () => void };
}

function LabeledInput(props: LabeledInputProps): React.JSX.Element {
  const { label, value, onChange, type = 'text', multiline = false, placeholder, action } = props;
  const shared =
    'w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-brand';
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {action ? (
          <button
            type="button"
            onClick={(event) => {
              // 阻止 label 默认行为，避免按钮点击把焦点甩回输入框
              event.preventDefault();
              action.onClick();
            }}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-brand transition hover:bg-brand-muted"
          >
            {action.icon}
            {action.label}
          </button>
        ) : null}
      </span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={4}
          className={cn(shared, 'min-h-[72px] resize-y font-mono')}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={cn(shared, 'h-9', type === 'password' && 'font-mono')}
        />
      )}
    </label>
  );
}
