import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { ArrowLeftRight, Binary, Download, Upload } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';
import { formatBytes } from '@/lib/utils';
import {
  BASE64_MAX_FILE_SIZE,
  TEXT_ENCODINGS,
  decodeBase64,
  encodeBase64,
  normalizeBase64Input,
  readFileAsBase64,
  readFileAsText,
  textToBytes,
  type Base64Options,
  type TextEncoding,
} from '@/modules/toolbox/lib/base64Utils';
import { downloadTextFile, timestampSuffix } from '@/modules/toolbox/lib/download';

const COMMAND_ID = 'base64-codec';

/** 操作方向。 */
type Mode = 'encode' | 'decode';

/** 转换结果。 */
interface CodecResult {
  text: string;
  /** 错误信息（成功为 null） */
  error: string | null;
  /** 是否转换成功（有输出且无错误） */
  ok: boolean;
}

/**
 * 执行一次转换。
 *
 * 手动模式（`auto` 关闭）下调用方会传入快照输入，此处按快照计算，
 * 因此「关闭自动处理」后输入框变化不会立刻影响结果。
 */
function run(input: string, mode: Mode, options: Base64Options): CodecResult {
  const value = input;
  if (value.trim().length === 0) {
    return { text: '', error: null, ok: false };
  }
  try {
    const text = mode === 'encode' ? encodeBase64(value, options) : decodeBase64(value, options);
    return { text, error: null, ok: true };
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      text: '',
      error:
        mode === 'decode'
          ? `解码失败：${message}（请检查是否为合法 Base64，或字符编码 / URL 安全开关是否正确）`
          : `编码失败：${message}`,
      ok: false,
    };
  }
}

/** 统计条：输入 / 输出字符数、原始字节、Base64 字符、膨胀比率。 */
interface CodecStats {
  inputChars: number;
  outputChars: number;
  rawBytes: number;
  base64Chars: number;
  /** 膨胀比率（%），Base64 理论约 133% */
  ratio: number;
}

/** 统计指标小格。 */
function StatCell({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-md bg-muted px-2 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-xs font-semibold text-foreground">{value}</div>
    </div>
  );
}

/**
 * Base64 编解码（对齐 ops-tools 的 Base64Converter）：
 * 字符编码（UTF-8 / UTF-16 / ASCII）、URL 安全变体、MIME 每 76 字符换行、
 * 自动 / 手动处理、文件上传下载、统计条与成功失败徽章。
 */
export function Base64Codec({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput);
  const [mode, setMode] = usePersistedState<Mode>(COMMAND_ID, 'mode', 'encode');
  const [encoding, setEncoding] = usePersistedState<TextEncoding>(COMMAND_ID, 'encoding', 'utf-8');
  const [urlSafe, setUrlSafe] = usePersistedState<boolean>(COMMAND_ID, 'urlSafe', false);
  const [wrap, setWrap] = usePersistedState<boolean>(COMMAND_ID, 'wrap', false);
  const [auto, setAuto] = usePersistedState<boolean>(COMMAND_ID, 'auto', true);
  /** 手动模式下的计算快照（点按钮才更新）。 */
  const [snapshot, setSnapshot] = React.useState<string | null>(null);
  /** 文件来源（编码模式：文件 → Base64）。 */
  const [fileSource, setFileSource] = React.useState<{ name: string; size: number; base64: string } | null>(null);

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const options = React.useMemo<Base64Options>(
    () => ({ encoding, urlSafe, wrap }),
    [encoding, urlSafe, wrap],
  );

  /** 参与计算的输入：编码模式若有文件来源，则直接以文件的 Base64 为源。 */
  const effectiveInput = React.useMemo<string>(() => {
    if (mode === 'encode' && fileSource) {
      return '';
    }
    return auto ? input : (snapshot ?? '');
  }, [auto, input, snapshot, mode, fileSource]);

  const result = React.useMemo<CodecResult>(() => {
    if (mode === 'encode' && fileSource) {
      // 文件 → Base64：再套用 URL 安全 / 换行选项
      let value = fileSource.base64;
      if (urlSafe) {
        value = value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }
      if (wrap) {
        const lines: string[] = [];
        for (let i = 0; i < value.length; i += 76) {
          lines.push(value.slice(i, i + 76));
        }
        value = lines.join('\n');
      }
      return { text: value, error: null, ok: true };
    }
    return run(effectiveInput, mode, options);
  }, [mode, fileSource, effectiveInput, options, urlSafe, wrap]);

  /** 统计。 */
  const stats = React.useMemo<CodecStats>(() => {
    if (mode === 'encode') {
      const rawBytes = fileSource
        ? Math.floor((fileSource.base64.length * 3) / 4)
        : textToBytes(effectiveInput, encoding).length;
      const base64Chars = normalizeBase64Input(result.text).length;
      return {
        inputChars: fileSource ? fileSource.size : effectiveInput.length,
        outputChars: result.text.length,
        rawBytes,
        base64Chars,
        ratio: rawBytes > 0 ? Math.round((base64Chars / rawBytes) * 100) : 0,
      };
    }
    const cleaned = normalizeBase64Input(effectiveInput);
    const rawBytes = Math.floor((cleaned.length * 3) / 4);
    const outputChars = result.text.length;
    return {
      inputChars: effectiveInput.length,
      outputChars,
      rawBytes,
      base64Chars: cleaned.length,
      ratio: rawBytes > 0 ? Math.round((cleaned.length / rawBytes) * 100) : 0,
    };
  }, [mode, fileSource, effectiveInput, encoding, result.text]);

  /** 切换模式：清空文件来源（语义不同，避免结果串味）。 */
  const changeMode = React.useCallback((next: Mode): void => {
    setMode(next);
    setFileSource(null);
    setSnapshot(null);
  }, []);

  /** 交换：把当前结果作为新输入，并翻转操作方向。 */
  const swap = React.useCallback((): void => {
    if (result.text.length === 0) {
      toast.warning('暂无可交换的结果');
      return;
    }
    setInput(result.text);
    setSnapshot(result.text);
    setFileSource(null);
    setMode((current) => (current === 'encode' ? 'decode' : 'encode'));
  }, [result.text]);

  /** 手动执行（auto 关闭时）：把当前输入拍快照。 */
  const execute = React.useCallback((): void => {
    setSnapshot(input);
    if (mode === 'encode' && fileSource) {
      toast.success('已刷新文件编码结果');
      return;
    }
    if (input.trim().length === 0) {
      toast.warning('请先输入内容');
      return;
    }
    toast.success(mode === 'encode' ? '已编码' : '已解码');
  }, [input, mode, fileSource]);

  /** 文件上传：编码模式读为 Base64，解码模式读为文本。 */
  const handleFileChange = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) {
        return;
      }
      if (file.size > BASE64_MAX_FILE_SIZE) {
        toast.error(`文件超过 ${formatBytes(BASE64_MAX_FILE_SIZE)} 上限，当前 ${formatBytes(file.size)}`);
        return;
      }
      try {
        if (mode === 'encode') {
          const base64 = await readFileAsBase64(file);
          setFileSource({ name: file.name, size: file.size, base64 });
          toast.success(`已载入 ${file.name}，结果即该文件的 Base64`);
        } else {
          const text = await readFileAsText(file);
          setInput(text);
          setSnapshot(text);
          toast.success(`已载入 ${file.name} 的文本内容`);
        }
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        toast.error(`文件读取失败：${message}`);
      }
    },
    [mode],
  );

  /** 下载结果。 */
  const handleDownload = React.useCallback((): void => {
    if (result.text.length === 0) {
      toast.error('暂无可下载的结果');
      return;
    }
    const name = mode === 'encode' ? 'base64' : 'decoded';
    const ok = downloadTextFile(`toolbox-${name}-${timestampSuffix()}.txt`, result.text);
    if (ok) {
      toast.success('已导出为 .txt');
    } else {
      toast.error('导出失败，请重试');
    }
  }, [result.text, mode]);

  /** 状态徽章（成功绿 / 失败红 / 等待输入灰）。 */
  let statusNode: React.JSX.Element;
  if (result.error) {
    statusNode = (
      <span className="rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
        失败
      </span>
    );
  } else if (result.ok) {
    statusNode = (
      <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700">
        {mode === 'encode' ? '编码成功' : '解码成功'}
      </span>
    );
  } else {
    statusNode = (
      <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        等待输入
      </span>
    );
  }

  return (
    <CommandShell
      title="Base64 编解码"
      onPaste={(t) => setInput(t)}
      description="文本与 Base64 互转：UTF-8 / UTF-16 / ASCII、URL 安全、MIME 换行、文件读写"
      icon={<Binary className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={result.text}
      primaryAction={{
        label: auto ? (mode === 'encode' ? '编码中（自动）' : '解码中（自动）') : mode === 'encode' ? '编码' : '解码',
        onClick: execute,
        disabled: !auto && input.trim().length === 0 && !fileSource,
      }}
      shortcutHint="粘贴即算 · 交换按钮翻转方向（Esc 返回）"
      samples={[
        {
          label: '编码中文',
          description: 'UTF-8 编码：一个汉字占 3 字节，所以 Base64 比原文长',
          apply: () => {
            setMode('encode');
            setEncoding('utf-8');
            setUrlSafe(false);
            setWrap(false);
            setInput('Toolbox 顺手 · 效率工具');
          },
        },
        {
          label: '解码回文本',
          description: '上面那条的逆运算，用来确认「编解码是对称的」',
          apply: () => {
            setMode('decode');
            setUrlSafe(false);
            setInput('SGFuZHkg6aG65omLIMK3IOaViOeOh+W3peWFtw==');
          },
        },
        {
          label: 'URL 安全变体',
          description: '把 + / 换成 - _，才能安全地放进 URL 或文件名',
          apply: () => {
            setMode('encode');
            setUrlSafe(true);
            setInput('a?b=1&c=2/3+4');
          },
        },
        {
          label: 'MIME 换行',
          description: '每 76 字符折行（RFC 2045），邮件与证书里都是这个习惯',
          apply: () => {
            setMode('encode');
            setUrlSafe(false);
            setWrap(true);
            setInput('Toolbox 顺手 · 效率工具 '.repeat(6));
          },
        },
        {
          label: '解码 JWT 中段',
          description: 'JWT 的 payload 段就是 URL 安全 Base64，解开是一段 JSON',
          apply: () => {
            setMode('decode');
            setUrlSafe(true);
            setInput('eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkhhbmR5In0');
          },
        },
      ]}
    >
      {/* 1180×820 基准：两列并排（左输入 / 右输出），窄屏（<1024px）自动回退单列。
          断点用 lg(1024) 而非 xl(1280)：工具页预设宽度就是 1180，用 xl 会在默认尺寸下退化成单列。 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ===== 左列：输入 ===== */}
        <div className="flex min-w-0 flex-col gap-3">
          {/* 模式切换 */}
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={mode === 'encode' ? 'default' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => changeMode('encode')}
            >
              编码
            </Button>
            <Button
              size="sm"
              variant={mode === 'decode' ? 'default' : 'ghost'}
              className="h-7 px-2.5 text-xs"
              onClick={() => changeMode('decode')}
            >
              解码
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={swap}>
              <ArrowLeftRight className="mr-1 h-3 w-3" />
              交换
            </Button>
            {statusNode}
          </div>

          {/* 输入区 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground" htmlFor="b64-input">
                {mode === 'encode' ? '原文' : 'Base64 文本'}
              </label>
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(event) => {
                    void handleFileChange(event);
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="mr-1 h-3 w-3" />
                  上传文件
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    setInput('');
                    setSnapshot('');
                    setFileSource(null);
                  }}
                >
                  清空
                </Button>
              </div>
            </div>
            <textarea
              id="b64-input"
              autoFocus
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                mode === 'encode' ? '输入要编码的文本（支持中文）' : '粘贴 Base64 字符串（自动忽略换行与空格）'
              }
              className={
                'min-h-[200px] w-full flex-1 resize-y rounded-lg border border-input bg-background p-3 font-mono text-sm ' +
                'text-foreground placeholder:text-muted-foreground ' +
                'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
              }
            />
            {fileSource ? (
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs">
                <span className="truncate text-foreground">
                  文件来源：{fileSource.name}（{formatBytes(fileSource.size)}）
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-xs"
                  onClick={() => setFileSource(null)}
                >
                  移除
                </Button>
              </div>
            ) : null}
          </div>

          {/* 选项 */}
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                字符编码
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                  value={encoding}
                  onChange={(event) => setEncoding(event.target.value as TextEncoding)}
                >
                  {TEXT_ENCODINGS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} — {item.hint}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-2">
                <label className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>URL 安全 Base64</span>
                  <Switch checked={urlSafe} onCheckedChange={(checked) => setUrlSafe(checked === true)} />
                </label>
                <label className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>每 76 字符换行（MIME）</span>
                  <Switch checked={wrap} onCheckedChange={(checked) => setWrap(checked === true)} />
                </label>
                <label className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>自动处理（输入即算）</span>
                  <Switch checked={auto} onCheckedChange={(checked) => setAuto(checked === true)} />
                </label>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              URL 安全：<code className="font-mono">+ → -</code>、<code className="font-mono">/ → _</code>、去掉尾部{' '}
              <code className="font-mono">=</code>；UTF-16 按 UTF-16LE 双字节编码，中文结果会比 UTF-8 短。
            </p>
          </div>
        </div>

        {/* ===== 右列：结果 ===== */}
        <div className="flex min-w-0 flex-col gap-3">
          <ResultBox
            title={mode === 'encode' ? 'Base64 结果' : '解码结果'}
            value={result.text}
            emptyHint={auto ? '输入内容后自动转换' : '点击上方「编码 / 解码」执行转换'}
            fill
            actions={
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={handleDownload}>
                <Download className="mr-1 h-3 w-3" />
                下载
              </Button>
            }
          />

          {result.error ? (
            <Input readOnly value={result.error} className="border-destructive/40 text-destructive" />
          ) : null}

          {/* 统计条 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <StatCell label="输入字符" value={String(stats.inputChars)} />
            <StatCell label="输出字符" value={String(stats.outputChars)} />
            <StatCell label="原始字节" value={String(stats.rawBytes)} />
            <StatCell label="Base64 字符" value={String(stats.base64Chars)} />
            <StatCell label="膨胀比率" value={`${stats.ratio}%`} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Base64 把每 3 字节编码为 4 字符，理论膨胀约 133%（含填充时更高）。
          </p>
        </div>
      </div>
    </CommandShell>
  );
}

export default Base64Codec;
