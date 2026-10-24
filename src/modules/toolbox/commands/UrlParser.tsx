import * as React from 'react';
import { Copy, Link as LinkIcon } from 'lucide-react';
import { CommandShell, type SampleEntry } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'url-parser';

/**
 * URL 解析器（命令 id: url-parser）。
 *
 * 定位：把一个完整 URL 拆成协议 / 凭证 / 主机 / 端口 / 路径分段 / hash / 查询参数，
 * 排查「参数到底传了什么」的第一现场。核心取舍：
 * - **实时解析**：不设提交按钮，边输入边看结构变化（与 NumberBase / IpCidr 的
 *   Enter 确认制刻意区分——URL 长且分节多，实时反馈更符合直觉）；非法输入行走行内红条；
 * - **原始值与解码值并存**：`URLSearchParams` 遍历拿到的 key / value 已经是解码结果，
 *   取不到原始串，因此按与它相同的分段规则（`&` 分段、首个 `=` 切键、跳过空段）
 *   手动切出原始值，两列并排对照；解码用 `decodeURIComponent` 包 try/catch，
 *   含孤立 `%` 等非法序列时原样展示并标注「解码失败」，不吞错；
 * - **密码打码**：界面只显示 ●●●，复制按钮出的才是原值，防止投屏 / 截图泄露。
 */

/** 持久化的工具状态：输入草稿 */
interface UrlParserState {
  input: string;
}

/** 查询参数表的一行：原始 key / 原始 value / 解码后 value */
interface QueryRow {
  key: string;
  rawValue: string;
  value: string;
  decodeFailed: boolean;
}

/** 解析 URL；失败返回 null（由调用方展示行内错误） */
function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** 剥掉协议末尾的冒号（'https:' → 'https'），与常见展示习惯一致 */
function protocolName(url: URL): string {
  return url.protocol.replace(/:$/, '');
}

interface FieldRowProps {
  label: string;
  display: string;
  /** 可复制值；undefined 表示该字段为空占位「—」，不渲染复制按钮 */
  copyValue?: string;
}

/** 字段行：名称 + 值 + 行内复制（密码的 display 与 copyValue 分离实现打码） */
function FieldRow({ label, display, copyValue }: FieldRowProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-sm text-foreground" title={display}>
          {display}
        </div>
      </div>
      {copyValue !== undefined ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={`复制${label}`}
          title={`复制${label}`}
          onClick={() => {
            void copyText(copyValue);
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

export function UrlParser({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<UrlParserState>(COMMAND_ID, { input: initialInput });

  // 历史 / 剪贴板来源的初始输入优先于本地草稿（仅挂载对齐一次）
  React.useEffect(() => {
    if (initialInput.length > 0) {
      patch({ input: initialInput });
    }
  }, [initialInput, patch]);

  const input = state.input;
  const trimmed = input.trim();
  // 实时解析：输入即算，不设提交按钮
  const url = React.useMemo(() => (trimmed.length === 0 ? null : parseUrl(trimmed)), [trimmed]);
  const hasError = trimmed.length > 0 && url === null;

  const queryRows = React.useMemo<QueryRow[]>(() => {
    if (url === null || url.search.length === 0) {
      return [];
    }
    // URLSearchParams 遍历驱动行序；原始串按相同规则手动切分（两套解析分段结果一致）
    const search = url.search.startsWith('?') ? url.search.slice(1) : url.search;
    const rawPairs = search.split('&').filter((pair) => pair.length > 0);
    const rows: QueryRow[] = [];
    let index = 0;
    for (const [decodedKey] of url.searchParams) {
      const pair = rawPairs[index];
      index += 1;
      const eq = pair === undefined ? -1 : pair.indexOf('=');
      const rawKey = pair === undefined ? decodedKey : eq === -1 ? pair : pair.slice(0, eq);
      const rawValue = pair === undefined || eq === -1 ? '' : pair.slice(eq + 1);
      let decoded = rawValue;
      let decodeFailed = false;
      try {
        // 与 URLSearchParams 语义对齐：query 串中 '+' 按空格解码
        decoded = decodeURIComponent(rawValue.replace(/\+/g, ' '));
      } catch {
        decodeFailed = true;
      }
      rows.push({ key: rawKey, rawValue, value: decoded, decodeFailed });
    }
    return rows;
  }, [url]);

  const segments = React.useMemo(() => {
    if (url === null) {
      return [] as string[];
    }
    return url.pathname.split('/').filter((seg) => seg.length > 0);
  }, [url]);

  const getCopyTextValue = React.useCallback((): string => {
    if (url === null) {
      return '';
    }
    const lines = [
      `URL: ${url.href}`,
      `协议: ${protocolName(url)}`,
      `用户名: ${url.username === '' ? '—' : url.username}`,
      `密码: ${url.password === '' ? '—' : url.password}`,
      `主机名: ${url.hostname === '' ? '—' : url.hostname}`,
      `端口: ${url.port === '' ? '—' : url.port}`,
      `路径: ${url.pathname}`,
      `Hash: ${url.hash === '' ? '—' : url.hash}`,
    ];
    if (queryRows.length > 0) {
      lines.push('查询参数:');
      for (const row of queryRows) {
        lines.push(`  ${row.key}=${row.rawValue}${row.decodeFailed ? '' : `（解码后 ${row.value}）`}`);
      }
    }
    return lines.join('\n');
  }, [url, queryRows]);

  const samples = React.useMemo<readonly SampleEntry[]>(
    () => [
      {
        label: '完整业务 URL',
        description: '带端口 / 多级路径 / 中文查询参数 / hash 的完整结构',
        apply: () => patch({ input: 'https://example.com:8443/api/v2/users?name=张三&tags=a,b#section' }),
      },
      {
        label: 'WebSocket',
        description: 'ws 协议 + IP 主机 + token 查询参数',
        apply: () => patch({ input: 'ws://127.0.0.1:9000/stream?token=abc123' }),
      },
      {
        label: 'file 本地路径',
        description: '无主机名、无查询参数的 file 协议，看路径分段',
        apply: () => patch({ input: 'file:///D:/logs/app.log' }),
      },
    ],
    [patch],
  );

  return (
    <CommandShell
      title="URL 解析器"
      description="协议 / 凭证 / 主机 / 端口 / 路径分段 / hash / 查询参数"
      icon={<LinkIcon className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      getCopyText={getCopyTextValue}
      shortcutHint="输入即实时解析 · 密码打码显示、复制出原值 · Esc 返回"
      samples={samples}
    >
      <div className="flex flex-col gap-3">
        <input
          type="text"
          value={input}
          onChange={(event) => patch({ input: event.target.value })}
          placeholder="粘贴完整 URL，如 https://example.com:8443/api/v2/users?name=张三#section"
          autoFocus
          aria-label="URL 输入"
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
            无法解析的 URL：请检查是否缺少协议前缀（如 https://）或存在非法字符
          </div>
        ) : null}

        {url !== null ? (
          <>
            {/* 基本字段：密码打码（●●●），复制按钮出原值 */}
            <section className="rounded-xl border border-border bg-card p-4 shadow-card">
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                <FieldRow label="协议" display={protocolName(url)} copyValue={protocolName(url)} />
                <FieldRow
                  label="用户名"
                  display={url.username === '' ? '—' : url.username}
                  copyValue={url.username === '' ? undefined : url.username}
                />
                <FieldRow
                  label="密码"
                  display={url.password === '' ? '—' : '●●●'}
                  copyValue={url.password === '' ? undefined : url.password}
                />
                <FieldRow
                  label="主机名"
                  display={url.hostname === '' ? '—' : url.hostname}
                  copyValue={url.hostname === '' ? undefined : url.hostname}
                />
                <FieldRow
                  label="端口"
                  display={url.port === '' ? '—' : url.port}
                  copyValue={url.port === '' ? undefined : url.port}
                />
                <FieldRow
                  label="Hash"
                  display={url.hash === '' ? '—' : url.hash}
                  copyValue={url.hash === '' ? undefined : url.hash}
                />
              </div>
            </section>

            {/* 路径分段 chips */}
            <section className="rounded-xl border border-border bg-card p-4 shadow-card">
              <div className="mb-2 text-xs text-muted-foreground">路径分段</div>
              <div className="flex flex-wrap gap-1.5">
                {segments.length > 0 ? (
                  segments.map((seg, idx) => (
                    <span
                      key={`${idx}-${seg}`}
                      title={seg}
                      className="max-w-[280px] truncate rounded-full border border-border bg-muted/40 px-2.5 py-0.5 font-mono text-xs text-foreground"
                    >
                      {seg}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">（无路径分段）</span>
                )}
              </div>
            </section>

            {/* 查询参数表：key / 原始值 / 解码值 三列对照 */}
            <section className="rounded-xl border border-border bg-card shadow-card">
              <div className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
                查询参数（{queryRows.length}）
              </div>
              {queryRows.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">（无查询参数）</div>
              ) : (
                <div className="scrollbar-thin overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">参数</th>
                        <th className="px-4 py-2 font-medium">原始值</th>
                        <th className="px-4 py-2 font-medium">解码后</th>
                        <th className="w-10 px-2 py-2" aria-label="复制" />
                      </tr>
                    </thead>
                    <tbody>
                      {queryRows.map((row, idx) => (
                        <tr key={`${idx}-${row.key}`} className="border-t border-border">
                          <td className="px-4 py-2 font-mono text-foreground">{row.key}</td>
                          <td
                            className="max-w-[240px] truncate px-4 py-2 font-mono text-muted-foreground"
                            title={row.rawValue}
                          >
                            {row.rawValue}
                          </td>
                          <td className="max-w-[240px] px-4 py-2">
                            <span className="font-mono text-foreground" title={row.value}>
                              {row.value}
                            </span>
                            {row.decodeFailed ? (
                              <span className="ml-1 text-xs text-destructive">解码失败</span>
                            ) : null}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label={`复制参数 ${row.key}`}
                              title={`复制 ${row.key}=${row.rawValue}`}
                              onClick={() => {
                                void copyText(`${row.key}=${row.rawValue}`);
                              }}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : trimmed.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/50 px-4 py-10 text-center text-sm text-muted-foreground">
            输入或粘贴 URL 即实时解析 · 支持 http / https / ws / file 等任意协议
          </div>
        ) : null}
      </div>
    </CommandShell>
  );
}

export default UrlParser;
