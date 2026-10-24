import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import {
  CheckCircle2,
  Download,
  FileUp,
  Hash,
  Loader2,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolHistory, type ToolHistoryEntry } from '@/hooks/useToolHistory';
import type { CommandProps } from '@/core/types';
import { cn, formatBytes } from '@/lib/utils';
import {
  HASH_ALGOS,
  HASH_MAX_FILE_SIZE,
  algoByHexLength,
  digestAll,
  digestsToText,
  hasSubtleCrypto,
  isHexDigest,
  readFileInChunks,
  type DigestOutcome,
  type FileReadProgress,
  type HashAlgo,
} from '@/modules/toolbox/lib/hashUtils';
import { downloadTextFile, timestampSuffix } from '@/modules/toolbox/lib/download';

const COMMAND_ID = 'hash-generator';

/** 模式：文本 / 文件 / 校验。 */
type HashTab = 'text' | 'file' | 'verify';

/** 空摘要（所有算法为空串，便于受控渲染）。 */
function emptyDigests(): Record<HashAlgo, string> {
  return { MD5: '', 'SHA-1': '', 'SHA-256': '', 'SHA-384': '', 'SHA-512': '' };
}

/** 已载入的文件信息（含字节，供摘要计算）。 */
interface LoadedFile {
  name: string;
  size: number;
  bytes: Uint8Array;
}

/** 历史条目负载。 */
interface HashHistoryPayload {
  kind: 'text' | 'file';
  /** 文本模式为原文；文件模式为文件名（文件字节不入库，避免撑爆 localStorage） */
  input: string;
  sourceLabel: string;
  digests: Record<HashAlgo, string>;
}

/** 历史条目去重签名。 */
function payloadSignature(payload: HashHistoryPayload): string {
  return `${payload.kind}|${payload.input}|${payload.digests['SHA-256'] ?? ''}`;
}

/** 截断长文本作为历史摘要。 */
function truncate(value: string, max = 48): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 单个算法结果卡片：算法名 + 摘要 + 独立复制。 */
function HashCard({ algo, digest }: { algo: HashAlgo; digest: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <span className="w-16 shrink-0 text-xs font-semibold text-muted-foreground">{algo}</span>
      <code className="scrollbar-thin min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground">
        {digest.length > 0 ? digest : <span className="text-muted-foreground">—</span>}
      </code>
      <CopyButton text={digest} disabled={digest.length === 0} />
    </div>
  );
}

/** 一条历史记录行：点击回填，右侧删除。 */
function HistoryRow({
  entry,
  onApply,
  onRemove,
}: {
  entry: ToolHistoryEntry<HashHistoryPayload>;
  onApply: (entry: ToolHistoryEntry<HashHistoryPayload>) => void;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  const payload = entry.payload;
  const time = new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false });
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => onApply(entry)}
        title="点击回填"
      >
        <div className="truncate text-xs font-medium text-foreground">{entry.summary}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {payload?.digests?.['SHA-256'] ?? '—'} · {time}
        </div>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        aria-label="删除该记录"
        onClick={() => onRemove(entry.id)}
      >
        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
      </Button>
    </div>
  );
}

/**
 * 哈希生成器（对齐 ops-tools 的 HashGenerator）：
 * MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512 五种算法，
 * 支持「文本 / 文件 / 校验」三种模式 —— 文件模式分片读取并展示真实进度，
 * 校验模式与预期值比对；另附最近 20 条历史记录（可回填 / 删除 / 清空）。
 */
export function HashGenerator({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const history = useToolHistory<HashHistoryPayload>({ toolId: COMMAND_ID, limit: 20 });

  const [tab, setTab] = usePersistedState<HashTab>(COMMAND_ID, 'tab', 'text');
  const [text, setText] = usePersistedState<string>(COMMAND_ID, 'text', initialInput);
  const [digests, setDigests] = React.useState<Record<HashAlgo, string>>(emptyDigests);
  const [busy, setBusy] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = React.useState<string>('文本');

  // 文件模式
  const [loadedFile, setLoadedFile] = React.useState<LoadedFile | null>(null);
  const [progress, setProgress] = React.useState<FileReadProgress | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // 校验模式
  const [expected, setExpected] = usePersistedState<string>(COMMAND_ID, 'expected', '');
  const [verifyAlgo, setVerifyAlgo] = usePersistedState<HashAlgo | 'auto'>(COMMAND_ID, 'verifyAlgo', 'auto');

  const subtleOk = React.useMemo<boolean>(hasSubtleCrypto, []);
  /** 计算竞态序号：快速输入时只认最后一次计算的结果。 */
  const runIdRef = React.useRef<number>(0);
  /** 最近一次成功结果，供历史写入使用（防抖后在 effect 里落库）。 */
  const [resultSig, setResultSig] = React.useState<string>('');
  const latestPayloadRef = React.useRef<HashHistoryPayload | null>(null);

  /** 执行一次摘要计算（串行化，避免过期结果覆盖新结果）。 */
  const runDigest = React.useCallback(
    async (data: Uint8Array, label: string, kind: 'text' | 'file', input: string): Promise<void> => {
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      setBusy(true);
      setError(null);
      setDigests(emptyDigests());

      let outcome: DigestOutcome;
      try {
        outcome = await digestAll(data, (algo, digest) => {
          if (runIdRef.current !== runId) {
            return;
          }
          setDigests((current) => ({ ...current, [algo]: digest }));
        });
      } catch (cause: unknown) {
        outcome = { digests: {}, error: `哈希计算失败：${cause instanceof Error ? cause.message : String(cause)}` };
      }

      if (runIdRef.current !== runId) {
        return;
      }
      setBusy(false);
      setError(outcome.error);
      setSourceLabel(label);

      const filled: Record<HashAlgo, string> = emptyDigests();
      for (const algo of HASH_ALGOS) {
        filled[algo] = outcome.digests[algo] ?? '';
      }
      const payload: HashHistoryPayload = { kind, input, sourceLabel: label, digests: filled };
      latestPayloadRef.current = payload;
      // 有任意算法算出结果才写入历史（用 SHA-256 作为成功标志）
      setResultSig(filled['SHA-256'].length > 0 ? `${runId}|${label}|${filled['SHA-256']}` : '');
    },
    [],
  );

  // 文本 / 文件输入变化 → 重新计算
  React.useEffect(() => {
    if (tab === 'file') {
      if (!loadedFile) {
        runIdRef.current += 1;
        setDigests(emptyDigests());
        setError(null);
        setResultSig('');
        return;
      }
      void runDigest(loadedFile.bytes, `文件：${loadedFile.name}`, 'file', loadedFile.name);
      return;
    }
    if (text.length === 0) {
      runIdRef.current += 1;
      setDigests(emptyDigests());
      setError(null);
      setResultSig('');
      return;
    }
    void runDigest(new TextEncoder().encode(text), '文本', 'text', text);
  }, [tab, text, loadedFile, runDigest]);

  // 历史：防抖写入 + 与最新一条去重，避免每次击键都记一条
  React.useEffect(() => {
    if (resultSig.length === 0) {
      return;
    }
    const payload = latestPayloadRef.current;
    if (!payload) {
      return;
    }
    const timer = window.setTimeout(() => {
      const latest = history.entries[0];
      if (latest?.payload && payloadSignature(latest.payload) === payloadSignature(payload)) {
        return;
      }
      const prefix = payload.kind === 'file' ? '文件' : truncate(payload.input);
      history.push({
        summary: `${prefix} → ${truncate(payload.digests['SHA-256'] ?? '', 24)}`,
        payload,
      });
    }, 900);
    return () => {
      window.clearTimeout(timer);
    };
    // history.push 引用稳定，此处只依赖结果签名
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultSig]);

  /** 选择文件：校验大小 → 分片读取（真实进度）→ 载入。 */
  const handleFileChange = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) {
        return;
      }
      if (file.size > HASH_MAX_FILE_SIZE) {
        toast.error(`文件超过 ${formatBytes(HASH_MAX_FILE_SIZE)} 上限，当前 ${formatBytes(file.size)}`);
        return;
      }
      setProgress({ loaded: 0, total: file.size });
      try {
        const bytes = await readFileInChunks(file, (value) => setProgress(value));
        setLoadedFile({ name: file.name, size: file.size, bytes });
        setProgress({ loaded: file.size, total: file.size });
        toast.success(`已读取 ${file.name}（${formatBytes(file.size)}）`);
      } catch (cause: unknown) {
        setProgress(null);
        const message = cause instanceof Error ? cause.message : String(cause);
        toast.error(`文件读取失败：${message}`);
      }
    },
    [],
  );

  const clearFile = React.useCallback((): void => {
    setLoadedFile(null);
    setProgress(null);
  }, []);

  /** 校验：自动按长度匹配算法，或按用户指定算法比对。 */
  const verify = React.useMemo<{ state: 'idle' | 'pass' | 'fail' | 'invalid'; algo: HashAlgo | null; message: string }>(() => {
    const value = expected.trim().replace(/\s+/g, '').toLowerCase();
    if (value.length === 0) {
      return { state: 'idle', algo: null, message: '输入预期哈希值后自动比对' };
    }
    if (!isHexDigest(value)) {
      return { state: 'invalid', algo: null, message: '预期值不是合法的十六进制摘要（含非 0-9a-f 字符或长度为奇数）' };
    }
    const algo = verifyAlgo === 'auto' ? algoByHexLength(value) : verifyAlgo;
    if (algo === null) {
      return { state: 'invalid', algo: null, message: `长度 ${value.length} 不匹配任何已知算法（32/40/64/96/128）` };
    }
    const actual = digests[algo];
    if (!actual) {
      return { state: 'idle', algo, message: `等待 ${algo} 计算完成…` };
    }
    return actual === value
      ? { state: 'pass', algo, message: `与 ${algo} 结果一致，校验通过` }
      : { state: 'fail', algo, message: `与 ${algo} 结果不一致，校验失败` };
  }, [expected, verifyAlgo, digests]);

  /** 一键复制：默认取 SHA-256（最常用）。 */
  const copyText = React.useMemo<string>(() => digests['SHA-256'] ?? '', [digests]);

  /** 下载全部摘要为 .txt。 */
  const handleDownload = React.useCallback((): void => {
    const anyDigest = HASH_ALGOS.some((algo) => digests[algo].length > 0);
    if (!anyDigest) {
      toast.error('暂无可下载的摘要结果');
      return;
    }
    const ok = downloadTextFile(
      `handy-hash-${timestampSuffix()}.txt`,
      digestsToText(digests, sourceLabel),
    );
    if (ok) {
      toast.success('摘要已导出为 .txt');
    } else {
      toast.error('导出失败，请重试');
    }
  }, [digests, sourceLabel]);

  /** 历史回填：文本记录可直接恢复原文；文件记录只能提示（字节不入库）。 */
  const handleApplyHistory = React.useCallback(
    (entry: ToolHistoryEntry<HashHistoryPayload>): void => {
      const payload = entry.payload;
      if (!payload) {
        return;
      }
      if (payload.kind === 'file') {
        toast.warning('文件记录只保存摘要，无法回填文件内容');
        return;
      }
      setText(payload.input);
      setTab('text');
      toast.success('已回填历史输入');
    },
    [],
  );

  const progressPercent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : 0;

  return (
    <CommandShell
      title="哈希计算"
      onPaste={(t) => setText(t)}
      description="MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512，支持文本、文件与哈希校验"
      icon={<Hash className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={copyText}
      shortcutHint="文本实时计算 · 文件分片读取 · 校验模式自动匹配算法（Esc 返回）"
      samples={[
        {
          label: '空串基准值',
          description: 'SHA-256 的公开基准：e3b0c442… —— 拿它验证算法实现是否正确',
          apply: () => {
            setTab('text');
            setText('');
          },
        },
        {
          label: '一句话五算法',
          description: '同一段文本并排比较五种算法，注意长度差异',
          apply: () => {
            setTab('text');
            setText('The quick brown fox jumps over the lazy dog');
          },
        },
        {
          label: '中文内容',
          description: '摘要算的是 UTF-8 字节，不是字符 —— 换编码值就变',
          apply: () => {
            setTab('text');
            setText('Handy 顺手 · 效率工具');
          },
        },
        {
          label: '校验比对',
          description: '粘贴官方公布的摘要，自动识别算法并给出是否一致',
          apply: () => {
            setTab('verify');
            setText('The quick brown fox jumps over the lazy dog');
            setExpected('d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
          },
        },
      ]}
    >
      {/* 1180×820 基准：两列并排（左输入 / 右输出），窄屏（<1024px）自动回退单列。
          断点用 lg(1024) 而非 xl(1280)：工具页预设宽度就是 1180，用 xl 会在默认尺寸下退化成单列。 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ===== 左列：输入 ===== */}
        <div className="flex min-w-0 flex-col gap-3">
          <Tabs value={tab} onValueChange={(value) => setTab(value as HashTab)}>
            <TabsList>
              <TabsTrigger value="text">文本</TabsTrigger>
              <TabsTrigger value="file">文件</TabsTrigger>
              <TabsTrigger value="verify">校验</TabsTrigger>
            </TabsList>

            {/* 文本模式 */}
            <TabsContent value="text" className="mt-3">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="hash-input">
                  输入文本
                </label>
                <textarea
                  id="hash-input"
                  autoFocus
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="输入要计算哈希的文本（支持中文等多字节字符）"
                  className={
                    'min-h-[260px] w-full flex-1 resize-y rounded-lg border border-input bg-background p-3 font-mono text-sm ' +
                    'text-foreground placeholder:text-muted-foreground ' +
                    'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
                  }
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{text.length} 字符 · {new TextEncoder().encode(text).length} 字节（UTF-8）</span>
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setText('')}>
                    清空
                  </Button>
                </div>
              </div>
            </TabsContent>

            {/* 文件模式 */}
            <TabsContent value="file" className="mt-3">
              <div className="flex flex-col gap-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(event) => {
                    void handleFileChange(event);
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy}
                  >
                    <FileUp className="mr-1.5 h-3.5 w-3.5" />
                    选择文件
                  </Button>
                  {loadedFile ? (
                    <Button size="sm" variant="ghost" onClick={clearFile} disabled={busy}>
                      移除文件
                    </Button>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    上限 {formatBytes(HASH_MAX_FILE_SIZE)}，2MB 分片读取
                  </span>
                </div>

                {loadedFile ? (
                  <div className="rounded-lg border border-border bg-card p-3 text-sm">
                    <div className="truncate font-medium text-foreground">{loadedFile.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {formatBytes(loadedFile.size)}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    尚未选择文件
                  </div>
                )}

                {progress ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        读取进度
                      </span>
                      <span className="font-mono">
                        {formatBytes(progress.loaded)} / {formatBytes(progress.total)}（{progressPercent}%）
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-brand transition-all"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </TabsContent>

            {/* 校验模式 */}
            <TabsContent value="verify" className="mt-3">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-foreground" htmlFor="hash-expected">
                    预期哈希值
                  </label>
                  <Input
                    id="hash-expected"
                    value={expected}
                    onChange={(event) => setExpected(event.target.value)}
                    placeholder="粘贴预期摘要，如 d41d8cd98f00b204e9800998ecf8427e"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>比对算法</span>
                    <select
                      className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                      value={verifyAlgo}
                      onChange={(event) => setVerifyAlgo(event.target.value as HashAlgo | 'auto')}
                    >
                      <option value="auto">自动匹配（按长度）</option>
                      {HASH_ALGOS.map((algo) => (
                        <option key={algo} value={algo}>
                          {algo}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div
                  className={cn(
                    'flex items-start gap-2 rounded-lg border p-3 text-sm',
                    verify.state === 'pass' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700',
                    verify.state === 'fail' && 'border-destructive/40 bg-destructive/10 text-destructive',
                    (verify.state === 'idle' || verify.state === 'invalid') &&
                      'border-border bg-muted/40 text-muted-foreground',
                  )}
                >
                  {verify.state === 'pass' ? (
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : verify.state === 'fail' ? (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 opacity-50" />
                  )}
                  <div className="min-w-0">
                    <div className="font-medium">
                      {verify.state === 'pass'
                        ? '校验通过'
                        : verify.state === 'fail'
                          ? '校验失败'
                          : verify.state === 'invalid'
                            ? '预期值无效'
                            : '等待输入'}
                    </div>
                    <div className="mt-0.5 break-all text-xs">{verify.message}</div>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  校验对象为当前输入（{sourceLabel}）的计算结果：切到「文本」改内容，或切到「文件」选文件，再回到本页比对。
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        {/* ===== 右列：结果 ===== */}
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-foreground">
              计算结果
              <span className="ml-2 text-xs font-normal text-muted-foreground">{sourceLabel}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={handleDownload}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              下载 .txt
            </Button>
          </div>

          {busy ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              计算中…
            </div>
          ) : null}

          {HASH_ALGOS.map((algo) => (
            <HashCard key={algo} algo={algo} digest={digests[algo]} />
          ))}

          {!subtleOk ? (
            <p className="text-xs text-amber-600">
              当前环境不支持 Web Crypto（需安全上下文），SHA 系列不可用；MD5 仍可计算。
            </p>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        {/* ===== 历史记录（通栏） ===== */}
        <div className="flex min-w-0 flex-col gap-2 lg:col-span-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">
              历史记录
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                最近 {history.entries.length} / 20 条
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-destructive"
              onClick={() => {
                history.clear();
                toast.success('历史记录已清空');
              }}
              disabled={history.entries.length === 0}
            >
              清空
            </Button>
          </div>
          {history.entries.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              暂无历史记录；文本计算完成或文件哈希算完后会自动记录
            </div>
          ) : (
            <div className="scrollbar-thin grid max-h-[220px] grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
              {history.entries.map((entry) => (
                <HistoryRow
                  key={entry.id}
                  entry={entry}
                  onApply={handleApplyHistory}
                  onRemove={history.remove}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </CommandShell>
  );
}

export default HashGenerator;
