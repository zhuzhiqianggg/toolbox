import * as React from 'react';
import { Eraser, Plus, Send, Trash2, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import { usePersistedState } from '@/hooks/usePersistedState';
import { isTauri } from '@/platform';
import type { CommandProps } from '@/core/types';
import {
  HTTP_METHODS,
  formatDuration,
  formatSize,
  isSensitiveHeader,
  parseCurl,
  prettyBody,
  rowsForPersist,
  rowsToRecord,
  statusTone,
  validateTarget,
  type HeaderRow,
  type HttpMethod,
} from '../lib/apiUtils';

const COMMAND_ID = 'api-tester';

/** 发送方发出的响应（Tauri 与 fetch 两条路归一成这个形状） */
interface ResponseView {
  status: number;
  statusText: string;
  ok: boolean;
  durationMs: number;
  sizeBytes: number;
  headers: { name: string; value: string }[];
  body: string;
  finalUrl: string;
}

/** 历史条目（持久化；只存方法 + URL + 状态，不存任何头部与请求体） */
interface HistoryEntry {
  method: string;
  url: string;
  status: number;
  at: number;
}

/** Tauri `http_request` 的返回（camelCase，见 src-tauri/src/commands/http.rs） */
interface TauriHttpResponse {
  status: number;
  statusText: string;
  ok: boolean;
  durationMs: number;
  sizeBytes: number;
  headers: { name: string; value: string }[];
  body: string;
  finalUrl: string;
}

const STATUS_TONE_CLASS: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  info: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  warn: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  error: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/** 常用头部一键行（key / value / 说明） */
const QUICK_HEADERS: readonly HeaderRow[] = [
  { key: 'Content-Type', value: 'application/json' },
  { key: 'Accept', value: 'application/json' },
  { key: 'Authorization', value: 'Bearer ' },
];

export function ApiTester({ initialInput }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [method, setMethod] = usePersistedState<HttpMethod>(COMMAND_ID, 'method', 'GET');
  const [url, setUrl] = usePersistedState<string>(COMMAND_ID, 'url', initialInput ?? '');
  // 头部值可能含 token：内存里保留原文，落盘前把敏感头的值清空（见 apiUtils.rowsForPersist）
  const [storedHeaders, setStoredHeaders] = usePersistedState<HeaderRow[]>(COMMAND_ID, 'headers', []);
  const [headers, setHeaders] = React.useState<HeaderRow[]>(storedHeaders);
  const [body, setBody] = usePersistedState<string>(COMMAND_ID, 'body', '');
  const [history, setHistory] = usePersistedState<HistoryEntry[]>(COMMAND_ID, 'history', []);

  const [resp, setResp] = React.useState<ResponseView | null>(null);
  const [errorText, setErrorText] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [showRaw, setShowRaw] = React.useState(false);
  const [curlOpen, setCurlOpen] = React.useState(false);
  const [curlText, setCurlText] = React.useState('');

  // 请求序号：慢请求晚到时丢弃（Tauri 路径没有真正的取消）
  const seqRef = React.useRef(0);
  const abortRef = React.useRef<AbortController | null>(null);

  const hasBody = method !== 'GET' && method !== 'HEAD';
  const bodyViewed = React.useMemo(() => (showRaw ? resp?.body ?? '' : prettyBody(resp?.body ?? '')), [resp, showRaw]);
  const isJsonBody = React.useMemo(() => {
    const text = (resp?.body ?? '').trim();
    return text.startsWith('{') || text.startsWith('[');
  }, [resp]);

  const updateHeaders = (next: HeaderRow[]): void => {
    setHeaders(next);
    setStoredHeaders(rowsForPersist(next));
  };

  const setHeaderRow = (index: number, patch: Partial<HeaderRow>): void => {
    updateHeaders(headers.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const applyCurl = (): void => {
    const parsed = parseCurl(curlText);
    if (parsed === null) {
      setErrorText('没有从 cURL 里认出 URL —— 确认命令里带了 http(s) 链接');
      return;
    }
    setMethod(parsed.method);
    setUrl(parsed.url);
    updateHeaders(parsed.headers.length > 0 ? parsed.headers : headers);
    setBody(parsed.body);
    setErrorText('');
  };

  const send = async (): Promise<void> => {
    const invalid = validateTarget(url);
    if (invalid !== null) {
      setErrorText(invalid);
      return;
    }
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setSending(true);
    setErrorText('');
    const started = performance.now();
    try {
      let view: ResponseView;
      if (isTauri()) {
        const out = await invoke<TauriHttpResponse>('http_request', {
          input: {
            method,
            url: url.trim(),
            headers: headers
              .filter((row) => row.key.trim().length > 0)
              .map((row) => ({ key: row.key.trim(), value: row.value })),
            body: hasBody ? body : '',
          },
        });
        view = {
          status: out.status,
          statusText: out.statusText,
          ok: out.ok,
          durationMs: out.durationMs,
          sizeBytes: out.sizeBytes,
          headers: out.headers,
          body: out.body,
          finalUrl: out.finalUrl,
        };
      } else {
        const controller = new AbortController();
        abortRef.current = controller;
        const init: RequestInit = {
          method,
          headers: rowsToRecord(headers),
          signal: controller.signal,
        };
        if (hasBody && body.length > 0) {
          init.body = body;
        }
        const res = await fetch(url.trim(), init);
        const text = await res.text();
        view = {
          status: res.status,
          statusText: res.statusText,
          ok: res.ok,
          durationMs: performance.now() - started,
          sizeBytes: new Blob([text]).size,
          headers: [...res.headers.entries()].map(([name, value]) => ({ name, value })),
          body: text,
          finalUrl: res.url,
        };
      }
      if (seqRef.current !== seq) {
        return; // 已被更新的请求覆盖 / 已取消
      }
      setResp(view);
      const entry: HistoryEntry = { method, url: url.trim(), status: view.status, at: Date.now() };
      setHistory((prev) => [entry, ...prev.filter((h) => !(h.method === entry.method && h.url === entry.url))].slice(0, 15));
    } catch (e) {
      if (seqRef.current !== seq) {
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      setResp(null);
      if (message.includes('abort')) {
        setErrorText('已取消本次请求');
      } else if (!isTauri()) {
        setErrorText(`请求失败：${message}（浏览器预览受 CORS 限制，应用内走 Rust 直连无此限制）`);
      } else {
        setErrorText(`请求失败：${message}`);
      }
    } finally {
      if (seqRef.current === seq) {
        setSending(false);
        abortRef.current = null;
      }
    }
  };

  const cancel = (): void => {
    seqRef.current += 1;
    setSending(false);
    abortRef.current?.abort();
  };

  const samples = [
    {
      label: 'GET 文章列表',
      description: 'JSONPlaceholder 免费假接口 —— 最小可用请求，看状态/耗时/JSON 美化',
      apply: () => {
        setMethod('GET');
        setUrl('https://jsonplaceholder.typicode.com/posts?_limit=3');
      },
    },
    {
      label: 'POST 新建（201）',
      description: '带 Content-Type 与 JSON 体 —— 服务端返回 201，看错误分档之外的正常建单',
      apply: () => {
        setMethod('POST');
        setUrl('https://jsonplaceholder.typicode.com/posts');
        updateHeaders([
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Accept', value: 'application/json' },
        ]);
        setBody('{\n  "title": "来自 Toolbox 接口测试",\n  "body": "请求体示例",\n  "userId": 1\n}');
      },
    },
    {
      label: '回显请求头',
      description: 'httpbin 把你发的头原样返回 —— 调 Authorization / 自定义头是否真发出去',
      apply: () => {
        setMethod('GET');
        setUrl('https://httpbin.org/get?tool=toolbox');
        updateHeaders([
          { key: 'Accept', value: 'application/json' },
          { key: 'X-From', value: 'Toolbox 接口测试' },
        ]);
      },
    },
    {
      label: '404 分档着色',
      description: '故意请求 404 —— 看 4xx 橙色徽标与「不报错、给状态」的设计',
      apply: () => {
        setMethod('GET');
        setUrl('https://httpbin.org/status/404');
      },
    },
    {
      label: '延迟 3 秒',
      description: '慢接口 —— 看耗时统计与发送中的取消',
      apply: () => {
        setMethod('GET');
        setUrl('https://httpbin.org/delay/3');
      },
    },
    {
      label: '北京实时天气',
      description: 'Open-Meteo 免费天气接口（无需 key）—— 真实业务数据的 JSON 检查',
      apply: () => {
        setMethod('GET');
        setUrl('https://api.open-meteo.com/v1/forecast?latitude=39.9042&longitude=116.4074&current_weather=true');
      },
    },
    {
      label: 'GitHub 仓库信息',
      description: '公开 API —— 看大 JSON 的折叠浏览与体积/耗时',
      apply: () => {
        setMethod('GET');
        setUrl('https://api.github.com/repos/microsoft/vscode');
        updateHeaders([{ key: 'Accept', value: 'application/vnd.github+json' }]);
      },
    },
    {
      label: 'cURL 导入',
      description: '先填一条 cURL，再点上方「导入 cURL」—— DevTools 里 Copy as cURL 直接还原',
      apply: () => {
        setCurlOpen(true);
        setCurlText(
          "curl -X POST 'https://httpbin.org/post' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Authorization: Bearer demo-token' \\\n  -d '{\"name\":\"toolbox\",\"tags\":[\"api\",\"test\"]}'",
        );
      },
    },
  ];

  const tone = resp === null ? null : statusTone(resp.status);

  return (
    <CommandShell
      title="接口测试"
      onPaste={(t) => setUrl(t)}
      description="HTTP 接口调试：cURL 导入 / 请求编辑 / 响应检查"
      icon={<Send className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      getCopyText={() => resp?.body ?? ''}
      shortcutHint="应用内由 Rust 直发请求（无 CORS 限制）· 浏览器预览走 fetch（受 CORS 限制）"
      samples={samples}
    >
      {/* 滚动与内边距由 CommandShell 内容区统一提供，这里只负责纵向间距 */}
      <div className="flex flex-col gap-3">
        {/* —— 请求行 —— */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="HTTP 方法"
            value={method}
            onChange={(e) => setMethod(e.target.value as HttpMethod)}
            className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <Input
            id="api-url"
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.example.com/v1/resource?limit=10"
            className="min-w-[240px] flex-1 font-mono text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && !sending) {
                void send();
              }
            }}
          />
          {sending && !isTauri() ? (
            <Button variant="outline" onClick={cancel}>
              <X className="h-4 w-4" /> 取消
            </Button>
          ) : (
            <Button onClick={() => void send()} disabled={sending}>
              <Send className="h-4 w-4" />
              {sending ? '发送中…' : '发送'}
            </Button>
          )}
        </div>
        {sending && isTauri() ? (
          <p className="text-xs text-muted-foreground">请求进行中（超时 30 秒）……慢请求返回后自动忽略过期结果。</p>
        ) : null}

        {/* —— cURL 导入 —— */}
        <div className="rounded-md border border-border/70 bg-muted/30 p-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCurlOpen((v) => !v)}>
              {curlOpen ? '收起 cURL 导入' : '导入 cURL'}
            </Button>
            <span className="text-xs text-muted-foreground">
              把 DevTools「Copy as cURL」或终端命令粘进来，一键还原成可编辑请求
            </span>
          </div>
          {curlOpen ? (
            <div className="mt-2 space-y-2">
              <textarea
                id="api-curl"
                rows={4}
                className={TEXTAREA_CLASS}
                value={curlText}
                onChange={(e) => setCurlText(e.target.value)}
                placeholder={"curl -X POST 'https://httpbin.org/post' -H 'Content-Type: application/json' -d '{\"a\":1}'"}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={applyCurl}>
                  解析并填充
                </Button>
                <span className="text-xs text-muted-foreground">
                  支持 -X / -H / -d(及别名) / --json / -u / 续行与三种引号；敏感头（Authorization 等）不落盘
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {/* —— 请求头 —— */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">请求头（{headers.length}）</span>
            <div className="flex items-center gap-1">
              {QUICK_HEADERS.map((q) => (
                <button
                  key={q.key}
                  type="button"
                  title={`添加 ${q.key}: ${q.value}`}
                  onClick={() => {
                    if (headers.some((row) => row.key.toLowerCase() === q.key.toLowerCase())) {
                      return;
                    }
                    updateHeaders([...headers, { ...q }]);
                  }}
                  className="rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition hover:border-brand/50 hover:text-brand"
                >
                  + {q.key}
                </button>
              ))}
              <button
                type="button"
                onClick={() => updateHeaders([...headers, { key: '', value: '' }])}
                title="添加一行空头部"
                className="flex items-center rounded-full border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground transition hover:border-brand/50 hover:text-brand"
              >
                <Plus className="h-3 w-3" /> 空行
              </button>
            </div>
          </div>
          {headers.length === 0 ? (
            <p className="rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
              无自定义头部。GET 请求通常一个都不需要 —— 点右上角快捷键或「空行」加一个。
            </p>
          ) : (
            <div className="space-y-1.5">
              {headers.map((row, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <Input
                    value={row.key}
                    onChange={(e) => setHeaderRow(index, { key: e.target.value })}
                    placeholder="头部名（如 Content-Type）"
                    className="h-8 w-2/5 font-mono text-xs"
                  />
                  <Input
                    value={row.value}
                    onChange={(e) => setHeaderRow(index, { value: e.target.value })}
                    placeholder={isSensitiveHeader(row.key) ? '敏感值仅保存在内存，不落盘' : '值'}
                    className="h-8 flex-1 font-mono text-xs"
                    type={isSensitiveHeader(row.key) ? 'password' : 'text'}
                  />
                  <button
                    type="button"
                    title="删除这一行"
                    onClick={() => updateHeaders(headers.filter((_, i) => i !== index))}
                    className="rounded p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* —— 请求体 —— */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              请求体{hasBody ? '' : '（GET / HEAD 不发送）'}
            </span>
            <button
              type="button"
              title="清空请求体"
              onClick={() => setBody('')}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:text-foreground"
            >
              <Eraser className="h-3 w-3" /> 清空
            </button>
          </div>
          <textarea
            id="api-body"
            rows={5}
            disabled={!hasBody}
            className={TEXTAREA_CLASS}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={'{\n  "name": "toolbox",\n  "count": 1\n}'}
          />
        </div>

        {/* —— 错误 / 响应 —— */}
        {errorText ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {errorText}
          </div>
        ) : null}

        {resp !== null && tone !== null ? (
          <div className="space-y-2 rounded-lg border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 font-mono text-xs font-semibold ${STATUS_TONE_CLASS[tone]}`}>
                {resp.status === 0 ? '网络失败' : `${resp.status} ${resp.statusText}`}
              </span>
              <span className="text-xs text-muted-foreground">耗时 {formatDuration(resp.durationMs)}</span>
              <span className="text-xs text-muted-foreground">体积 {formatSize(resp.sizeBytes)}</span>
              {resp.finalUrl !== url.trim() && resp.finalUrl.length > 0 ? (
                <span className="truncate text-xs text-muted-foreground" title={`重定向到 ${resp.finalUrl}`}>
                  → {resp.finalUrl}
                </span>
              ) : null}
              {isJsonBody ? (
                <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                  原文
                  <Switch checked={showRaw} onCheckedChange={setShowRaw} />
                </label>
              ) : null}
              <CopyButton text={resp.body} size="sm" variant="outline" />
            </div>
            <details className="group">
              <summary className="cursor-pointer text-xs text-muted-foreground transition group-open:text-foreground">
                响应头（{resp.headers.length}）
              </summary>
              <div className="mt-1 max-h-40 overflow-y-auto rounded border border-border/70 font-mono text-[11px]">
                {resp.headers.length === 0 ? (
                  <p className="px-2 py-1.5 text-muted-foreground">
                    无可读响应头（浏览器预览下 CORS 只暴露部分头部；应用内可见全部）
                  </p>
                ) : (
                  resp.headers.map((h) => (
                    <div key={`${h.name}: ${h.value}`} className="flex gap-2 border-b border-border/50 px-2 py-1 last:border-b-0">
                      <span className="shrink-0 font-semibold">{h.name}</span>
                      <span className="break-all text-muted-foreground">{h.value}</span>
                    </div>
                  ))
                )}
              </div>
            </details>
            <pre className="max-h-72 overflow-auto rounded-md border border-border/70 bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
              {bodyViewed.length > 0 ? bodyViewed : '（空响应体）'}
            </pre>
          </div>
        ) : null}

        {/* —— 历史 —— */}
        {history.length > 0 ? (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">历史（{history.length}）</span>
              <button
                type="button"
                onClick={() => setHistory([])}
                className="text-[11px] text-muted-foreground transition hover:text-foreground"
              >
                清空
              </button>
            </div>
            <div className="space-y-1">
              {history.map((h) => (
                <button
                  key={`${h.at}-${h.url}`}
                  type="button"
                  onClick={() => {
                    setMethod(h.method as HttpMethod);
                    setUrl(h.url);
                  }}
                  className="flex w-full items-center gap-2 rounded-md border border-border/70 bg-card px-2.5 py-1.5 text-left transition hover:border-brand/50"
                >
                  <span className="w-14 shrink-0 font-mono text-[11px] font-semibold text-muted-foreground">{h.method}</span>
                  <span className="flex-1 truncate font-mono text-xs">{h.url}</span>
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px] ${STATUS_TONE_CLASS[statusTone(h.status)]}`}
                  >
                    {h.status === 0 ? '失败' : h.status}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </CommandShell>
  );
}

export default ApiTester;
