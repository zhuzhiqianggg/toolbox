import * as React from 'react';
import { Copy, Server as ServerIcon } from 'lucide-react';
import { CommandShell, type SampleEntry } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'ip-cidr';

/**
 * IPv4 / CIDR 计算器（命令 id: ip-cidr）。
 *
 * 定位：给网络排障与防火墙规则编写用的「子网拆解器」——输入 `a.b.c.d/prefix`
 * 一次算出网络 / 广播 / 掩码 / 通配符 / 可用范围 / 主机数 / 规范形式 / 地址类 / RFC1918 归属。
 * 核心取舍：
 * - **32 位无符号域运算**：JS 位运算是 32 位有符号，`&` / `|` / `~` 之后一律 `>>> 0`
 *   回到无符号域，避免 128.0.0.0 以上网段被解释成负数；prefix = 0 时 `1 << 32` 会因
 *   移位取模得到错误掩码，必须特判为 0；
 * - **前缀 31 与 32 不做 -2 扣减**（RFC 3021）：点对点链路两端地址均可用，/32 单机地址
 *   自身可用——常规前缀才按「网络 + 广播」扣除 2 个；
 * - **Enter 确认制**：与 UrlParser 的实时模式区分，非法输入走行内红条而非 toast。
 */

/** 持久化的工具状态：输入草稿 */
interface IpCidrState {
  input: string;
}

/** 解析成功：IP 与前缀均为数值（IP 为 32 位无符号整数） */
interface CidrParsed {
  ip: number;
  prefix: number;
}

type CidrParseResult = CidrParsed | { error: string };

/** 点分四段 → 32 位无符号整数；非法返回 null（每段 0-255，恰好 4 段） */
function ipToInt(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (n > 255) {
      return null;
    }
    out = ((out << 8) | n) >>> 0;
  }
  return out;
}

/** 32 位无符号整数 → 点分四段 */
function intToIp(value: number): string {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

/** 解析 "a.b.c.d[/prefix]"；裸 IP 视为 /32。失败返回错误消息。 */
function parseCidr(raw: string): CidrParseResult {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf('/');
  const ipText = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const prefixText = slash === -1 ? '' : trimmed.slice(slash + 1);

  const ip = ipToInt(ipText);
  if (ip === null) {
    return { error: `无效的 IPv4 地址：「${ipText === '' ? '（空）' : ipText}」，应为点分四段 a.b.c.d` };
  }
  if (slash === -1) {
    return { ip, prefix: 32 };
  }
  if (!/^\d{1,2}$/.test(prefixText) || Number(prefixText) > 32) {
    return { error: `无效的前缀长度：「${prefixText === '' ? '（空）' : prefixText}」，应为 0-32 的整数` };
  }
  return { ip, prefix: Number(prefixText) };
}

/** 汇总一次计算的全部派生值（纯函数，便于结果区与复制文本共用） */
interface CidrReport {
  network: number;
  broadcast: number;
  mask: number;
  wildcard: number;
  firstUsable: number;
  lastUsable: number;
  /** 可用主机数（已按 RFC 3021 处理 /31、/32） */
  usableHosts: number;
  /** 主机数单元格的展示文本（/31 附规范依据） */
  hostsText: string;
  /** 总地址数提示（2^(32-prefix)） */
  totalText: string;
  canonical: string;
  addressClass: string;
  /** 命中的 RFC1918 私有段（如 "10.0.0.0/8"），公网为 null */
  privateRange: string | null;
  /** 输入 IP 是否落在网络地址之外（需要归零提示） */
  needsNormalization: boolean;
}

function buildReport(ip: number, prefix: number): CidrReport {
  // prefix = 0 特判：0xffffffff << 32 会因移位数取模（32 % 32 = 0）得到全 1 的错误掩码
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  // RFC 3021：/31 两端可用、/32 单机可用，其余扣掉网络地址与广播地址
  const usableHosts = prefix === 32 ? 1 : prefix === 31 ? 2 : 2 ** (32 - prefix) - 2;
  const firstUsable = prefix >= 31 ? network : network + 1;
  const lastUsable = prefix >= 31 ? broadcast : broadcast - 1;

  const first = (ip >>> 24) & 255;
  const second = (ip >>> 16) & 255;
  const addressClass =
    first < 128 ? 'A 类' : first < 192 ? 'B 类' : first < 224 ? 'C 类' : first < 240 ? 'D 类（组播）' : 'E 类（保留）';

  // RFC1918 私有段：按输入 IP 判定（比按归零后的网络地址更符合直觉）
  let privateRange: string | null = null;
  if (first === 10) {
    privateRange = '10.0.0.0/8';
  } else if (first === 172 && second >= 16 && second <= 31) {
    privateRange = '172.16.0.0/12';
  } else if (first === 192 && second === 168) {
    privateRange = '192.168.0.0/16';
  }

  return {
    network,
    broadcast,
    mask,
    wildcard: ~mask >>> 0,
    firstUsable,
    lastUsable,
    usableHosts,
    hostsText: prefix === 31 ? '2（RFC 3021）' : usableHosts.toLocaleString('en-US'),
    totalText: (2 ** (32 - prefix)).toLocaleString('en-US'),
    canonical: `${intToIp(network)}/${prefix}`,
    addressClass,
    privateRange,
    needsNormalization: ip !== network,
  };
}

interface InfoCellProps {
  label: string;
  value: string;
  hint?: string;
}

/** 结果网格单元格：名称 + 等宽值 + 行内复制，hint 补充口径说明 */
function InfoCell({ label, value, hint }: InfoCellProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-sm text-foreground" title={value}>
          {value}
        </div>
        {hint !== undefined ? (
          <div className="mt-0.5 text-[10px] text-muted-foreground/80">{hint}</div>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        aria-label={`复制${label}`}
        title={`复制${label}`}
        onClick={() => {
          void copyText(value);
        }}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function IpCidr({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<IpCidrState>(COMMAND_ID, { input: initialInput });
  // Enter 提交的快照：输入草稿实时持久化，解析只认提交值
  const [submitted, setSubmitted] = React.useState<string>(() => initialInput || state.input);

  const commit = React.useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      setSubmitted(trimmed);
      patch({ input: trimmed });
    },
    [patch],
  );

  // 历史 / 剪贴板来源的初始输入优先于本地草稿（仅挂载对齐一次）
  React.useEffect(() => {
    if (initialInput.length > 0) {
      commit(initialInput);
    }
  }, [initialInput, commit]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(state.input);
    }
  };

  const parsed = React.useMemo(() => parseCidr(submitted), [submitted]);
  const report = React.useMemo(
    () => ('error' in parsed ? null : buildReport(parsed.ip, parsed.prefix)),
    [parsed],
  );
  const hasError = 'error' in parsed;

  const getCopyTextValue = React.useCallback((): string => {
    if (report === null) {
      return '';
    }
    return [
      `CIDR: ${report.canonical}`,
      `网络地址: ${intToIp(report.network)}`,
      `广播地址: ${intToIp(report.broadcast)}`,
      `子网掩码: ${intToIp(report.mask)}`,
      `通配符掩码: ${intToIp(report.wildcard)}`,
      `首个可用 IP: ${intToIp(report.firstUsable)}`,
      `最后可用 IP: ${intToIp(report.lastUsable)}`,
      `可用主机数: ${report.hostsText}`,
      `地址类: ${report.addressClass}`,
      `私有地址: ${report.privateRange === null ? '否' : `是（${report.privateRange}）`}`,
    ].join('\n');
  }, [report]);

  const samples = React.useMemo<readonly SampleEntry[]>(
    () => [
      {
        label: '192.168.1.130/26',
        description: '典型家用子网：主机位 6 位，可用 62 台，输入 IP 需归零',
        apply: () => commit('192.168.1.130/26'),
      },
      {
        label: '10.0.0.0/8',
        description: 'RFC 1918 A 类私有段，约 1677 万可用地址',
        apply: () => commit('10.0.0.0/8'),
      },
      {
        label: '172.16.5.4/20',
        description: '掩码落在第三八位组中间的非对齐切分',
        apply: () => commit('172.16.5.4/20'),
      },
    ],
    [commit],
  );

  return (
    <CommandShell
      title="IP / CIDR 计算器"
      description="网络 / 广播 / 掩码 / 可用范围 / 主机数 / RFC1918"
      icon={<ServerIcon className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      getCopyText={getCopyTextValue}
      shortcutHint="Enter 计算 · 裸 IP 按 /32 处理 · /31 /32 按 RFC 3021 不扣减 · Esc 返回"
      samples={samples}
    >
      <div className="flex flex-col gap-3">
        <input
          type="text"
          value={state.input}
          onChange={(event) => patch({ input: event.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="如 192.168.1.130/26、10.0.0.0/8、172.16.5.4"
          autoFocus
          aria-label="IPv4 或 CIDR 输入"
          className={cn(
            'h-9 flex-1 rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            hasError && 'border-destructive/60 focus-visible:ring-destructive',
          )}
        />

        {hasError ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {parsed.error}
          </div>
        ) : null}

        {report !== null ? (
          <section className="rounded-xl border border-border bg-card p-4 shadow-card">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              <InfoCell label="网络地址" value={intToIp(report.network)} />
              <InfoCell label="广播地址" value={intToIp(report.broadcast)} />
              <InfoCell label="子网掩码" value={intToIp(report.mask)} />
              <InfoCell label="通配符掩码" value={intToIp(report.wildcard)} />
              <InfoCell label="首个可用 IP" value={intToIp(report.firstUsable)} />
              <InfoCell label="最后可用 IP" value={intToIp(report.lastUsable)} />
              <InfoCell
                label="可用主机数"
                value={report.hostsText}
                hint={`总地址 ${report.totalText}`}
              />
              <InfoCell
                label="CIDR 规范形式"
                value={report.canonical}
                hint={report.needsNormalization ? '输入 IP 已按掩码归零到网络地址' : undefined}
              />
              <InfoCell label="地址类" value={report.addressClass} />
              <InfoCell
                label="是否私有（RFC1918）"
                value={report.privateRange === null ? '否' : `是（${report.privateRange}）`}
              />
            </div>
          </section>
        ) : submitted.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/50 px-4 py-10 text-center text-sm text-muted-foreground">
            输入 IPv4 或 CIDR 后按 Enter 计算 · 裸 IP（不带 /prefix）按 /32 处理
          </div>
        ) : null}
      </div>
    </CommandShell>
  );
}

export default IpCidr;
