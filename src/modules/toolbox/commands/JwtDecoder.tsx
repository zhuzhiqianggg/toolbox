import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Check, ChevronDown, ChevronRight, KeyRound, ShieldCheck, ShieldX } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { cn } from '@/lib/utils';
import {
  buildSampleToken,
  buildStandardClaims,
  buildTimeClaims,
  decodeJwtToken,
  getExpiryInfo,
  HMAC_ALGORITHMS,
  SAMPLE_SECRET,
  verifyJwtSignature,
  type ClaimRow,
  type DecodedJwt,
  type TimeClaim,
  type VerifyState,
} from '@/modules/toolbox/lib/jwtUtils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'jwt-decoder';
// tool-audit-ignore: samples —— 内置「示例 token」生成（含过期 token），比静态示例更完整

/** 算法下拉：自动（跟随 header.alg）+ 三种 HMAC */
const ALG_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '自动（跟随 header.alg）' },
  ...HMAC_ALGORITHMS.map((alg) => ({ value: alg, label: alg })),
];

/** 验签状态 → 徽章样式与图标 */
const VERIFY_BADGE: Record<
  VerifyState['status'],
  { className: string; label: string }
> = {
  idle: { className: 'border-border bg-muted text-muted-foreground', label: '未验证' },
  verifying: { className: 'border-blue-200 bg-blue-50 text-blue-700', label: '验证中…' },
  valid: { className: 'border-emerald-200 bg-emerald-50 text-emerald-700', label: '验证通过' },
  invalid: { className: 'border-red-200 bg-red-50 text-red-700', label: '验证失败' },
  unsupported: { className: 'border-amber-200 bg-amber-50 text-amber-700', label: '无法验证' },
  error: { className: 'border-red-200 bg-red-50 text-red-700', label: '验证出错' },
};

/** 可折叠的代码卡片：标题 + 复制按钮 + 折叠开关 */
function SegmentCard({
  title,
  value,
  hint,
  defaultOpen = true,
  badge,
}: {
  title: string;
  value: string;
  hint?: string;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = React.useState<boolean>(defaultOpen);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium text-foreground"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{title}</span>
        </button>
        {badge}
        <CopyButton text={value} variant="ghost" size="sm" className="h-6 px-1.5 text-xs" />
      </div>
      {open ? (
        <div className="scrollbar-thin max-h-[260px] overflow-auto p-3">
          {value.length === 0 ? (
            <p className="text-xs text-muted-foreground">{hint ?? '（空）'}</p>
          ) : (
            <pre className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">
              {value}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 键值小卡片（时间声明 / 标准声明） */
function InfoCell({
  label,
  value,
  extra,
  mono = false,
}: {
  label: string;
  value: string;
  extra?: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-md bg-muted p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 break-all text-sm font-semibold', mono && 'font-mono')}>
        {value}
      </div>
      {extra ? <div className="mt-0.5 text-xs text-muted-foreground">{extra}</div> : null}
    </div>
  );
}

/**
 * JWT 解码器（对齐 ops-tools 参考实现）：
 * 三段独立卡片（Header / Payload / Signature，各自复制 + 折叠）、
 * **HMAC 验签**（HS256 / HS384 / HS512，基于 Web Crypto）、
 * 过期四态徽章、时间声明本地化 + 相对时间、标准声明展示、示例 Token。
 */
export function JwtDecoder({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput);
  const [secret, setSecret] = React.useState<string>('');
  const [algOverride, setAlgOverride] = usePersistedState<string>(COMMAND_ID, 'algOverride', '');
  const [verify, setVerify] = React.useState<VerifyState>({
    status: 'idle',
    message: '未验证签名',
  });

  // 相对时间每 30 秒刷新一次，保持「3 小时后过期」新鲜
  const [tick, setTick] = React.useState<number>(0);
  React.useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const decoded = React.useMemo<DecodedJwt | null>(() => {
    const result = decodeJwtToken(input);
    return result.ok ? result.decoded : null;
  }, [input]);

  const decodeError = React.useMemo<string | null>(() => {
    const value = input.trim();
    if (value.length === 0) {
      return null;
    }
    const result = decodeJwtToken(value);
    return result.ok ? null : result.error;
  }, [input]);

  // Token 变化后重置验签结果，避免沿用旧结论
  React.useEffect(() => {
    setVerify({ status: 'idle', message: '未验证签名' });
  }, [input, secret, algOverride]);

  const expiry = React.useMemo(
    () => (decoded === null ? null : getExpiryInfo(decoded.payload)),
    // tick 参与依赖：相对描述随定时刷新更新
    [decoded, tick],
  );

  const timeClaims = React.useMemo<TimeClaim[]>(
    () => (decoded === null ? [] : buildTimeClaims(decoded.payload)),
    [decoded, tick],
  );

  const standardClaims = React.useMemo<ClaimRow[]>(
    () => (decoded === null ? [] : buildStandardClaims(decoded.payload)),
    [decoded],
  );

  const runVerify = React.useCallback(async (): Promise<void> => {
    const result = decodeJwtToken(input);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setVerify({ status: 'verifying', message: '验证中…' });
    const next = await verifyJwtSignature(result.decoded, secret, algOverride);
    setVerify(next);
    if (next.status === 'valid') {
      toast.success(next.message);
    } else if (next.status === 'invalid') {
      toast.error(next.message);
    } else {
      toast.warning(next.message);
    }
  }, [input, secret, algOverride]);

  const fillSample = React.useCallback(async (expired: boolean): Promise<void> => {
    try {
      const token = await buildSampleToken(expired);
      setInput(token);
      setSecret(SAMPLE_SECRET);
      setAlgOverride('');
      toast.success(
        expired
          ? `已填入「已过期」示例，密钥为 ${SAMPLE_SECRET}`
          : `已填入「正常」示例，密钥为 ${SAMPLE_SECRET}`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`生成示例失败：${message}`);
    }
  }, []);

  const verifyBadge = VERIFY_BADGE[verify.status];
  const aud = decoded?.payload.aud;

  return (
    <CommandShell
      title="JWT 解码"
      onPaste={(t) => setInput(t)}
      description="解析 Header / Payload / Signature，支持 HMAC 验签与过期判定"
      icon={<KeyRound className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      favoriteDisabled={shell.favoriteDisabled}
      copyText={decoded?.payloadText ?? ''}
      primaryAction={{
        label: '验证签名',
        onClick: () => {
          void runVerify();
        },
        disabled: decoded === null,
      }}
      shortcutHint="粘贴 JWT 自动解码；填密钥点「验证签名」校验（Esc 返回）"
    >
      {/* 1180×820 基准：两列并排（左输入+验签 / 右解析结果），窄屏（<1024px）自动回退单列。
          断点用 lg(1024) 而非 xl(1280)：工具页预设宽度就是 1180，用 xl 会在默认尺寸下退化成单列。 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ——— 左列：输入 + 验签 ——— */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-medium text-foreground" htmlFor="jwt-input">
              Token
            </label>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  void fillSample(false);
                }}
              >
                正常示例
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  void fillSample(true);
                }}
              >
                已过期示例
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => {
                  setInput('');
                  setSecret('');
                }}
              >
                清空
              </Button>
            </div>
          </div>
          <textarea
            id="jwt-input"
            autoFocus
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="eyJhbGciOi... .eyJzdWIiOi... .signature"
            className={
              'h-[150px] w-full resize-none rounded-lg border border-input bg-background p-3 font-mono text-xs ' +
              'text-foreground placeholder:text-muted-foreground ' +
              'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
            }
          />
          {decodeError !== null ? (
            <div
              role="alert"
              className="whitespace-pre-wrap rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive"
            >
              {decodeError}
            </div>
          ) : null}

          {/* 验签区 */}
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">HMAC 签名验证</span>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
                  verifyBadge.className,
                )}
              >
                {verify.status === 'valid' ? (
                  <ShieldCheck className="h-3 w-3" />
                ) : verify.status === 'invalid' ? (
                  <ShieldX className="h-3 w-3" />
                ) : null}
                {verifyBadge.label}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <Input
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder="输入密钥（secret）"
                aria-label="验签密钥"
                className="font-mono text-xs"
              />
              <select
                className="h-9 rounded-lg border border-input bg-background px-2 text-xs text-foreground"
                value={algOverride}
                onChange={(event) => setAlgOverride(event.target.value)}
                aria-label="验签算法"
              >
                {ALG_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  void runVerify();
                }}
                disabled={decoded === null || verify.status === 'verifying'}
              >
                {verify.status === 'verifying' ? '验证中…' : '验证'}
              </Button>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {verify.message}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              仅支持 HS256 / HS384 / HS512（Web Crypto 本地计算，密钥不上传）；
              RS/ES 等非对称算法需服务端公钥，本工具不验证。
              {decoded !== null && decoded.algorithm.length > 0 ? (
                <>
                  {' '}
                  当前 header.alg =
                  <span className="font-mono text-foreground">{decoded.algorithm}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>

        {/* ——— 右列：解析结果 ——— */}
        <div className="flex min-w-0 flex-col gap-3">
          {decoded === null ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              粘贴 JWT 后自动解析；填密钥可验证签名
            </div>
          ) : (
            <>
              {/* 状态徽章行 */}
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
                    expiry?.className ?? 'border-border bg-muted text-muted-foreground',
                  )}
                >
                  {expiry?.state === 'active' ? <Check className="h-3 w-3" /> : null}
                  {expiry?.label ?? '—'}
                </span>
                <span className="text-xs text-muted-foreground">{expiry?.detail ?? ''}</span>
                {aud !== undefined ? (
                  <span className="ml-auto rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                    aud: {Array.isArray(aud) ? aud.join('、') : String(aud)}
                  </span>
                ) : null}
              </div>

              {/* 时间声明 */}
              {timeClaims.length > 0 ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {timeClaims.map((claim) => (
                    <InfoCell
                      key={claim.key}
                      label={claim.label}
                      value={claim.absolute}
                      extra={claim.relative}
                      mono
                    />
                  ))}
                </div>
              ) : null}

              {/* 标准声明 */}
              {standardClaims.length > 0 ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {standardClaims.map((row) => (
                    <InfoCell key={row.key} label={row.label} value={row.value} />
                  ))}
                </div>
              ) : null}

              {/* 三段卡片 */}
              <SegmentCard
                title="Header"
                value={decoded.headerText}
                badge={
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {decoded.algorithm || 'no-alg'}
                  </span>
                }
              />
              <SegmentCard title="Payload" value={decoded.payloadText} />
              <SegmentCard
                title="Signature"
                value={decoded.signatureSegment}
                hint="该 Token 没有签名段"
                defaultOpen={false}
              />
            </>
          )}
        </div>
      </div>
    </CommandShell>
  );
}

export default JwtDecoder;
