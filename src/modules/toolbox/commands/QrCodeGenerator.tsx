import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { ImageDown, QrCode, ScanLine, Upload } from 'lucide-react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'qrcode-generator';

/** 内容模板 */
type Template = 'text' | 'url' | 'wifi' | 'email' | 'phone';
/** 容错级别 */
type Level = 'L' | 'M' | 'Q' | 'H';
/** WiFi 加密方式 */
type WifiEncryption = 'WPA' | 'WEP' | 'nopass';

const LEVELS: ReadonlyArray<{ value: Level; label: string }> = [
  { value: 'L', label: 'L · 7%' },
  { value: 'M', label: 'M · 15%' },
  { value: 'Q', label: 'Q · 25%' },
  { value: 'H', label: 'H · 30%' },
];

const TEMPLATES: ReadonlyArray<{ value: Template; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'url', label: 'URL' },
  { value: 'wifi', label: 'WiFi' },
  { value: 'email', label: '邮箱' },
  { value: 'phone', label: '电话' },
];

/** 可选尺寸（像素） */
const SIZES: ReadonlyArray<number> = [128, 256, 512, 1024];

/** 前景色预设 */
const DARK_PRESETS: ReadonlyArray<string> = [
  '#111827',
  '#000000',
  '#1d4ed8',
  '#b91c1c',
  '#047857',
  '#7c3aed',
];

/** 背景色预设 */
const LIGHT_PRESETS: ReadonlyArray<string> = [
  '#ffffff',
  '#f8fafc',
  '#fef3c7',
  '#e0f2fe',
  '#dcfce7',
  '#fae8ff',
];

/** 解析图片时的最大边长（超过则等比缩放，避免大图卡死） */
const DECODE_MAX_SIDE = 1600;

/** 小标签按钮（模板 / 尺寸 / 容错切换） */
function ChipButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-2 py-1 text-xs transition-colors',
        active
          ? 'bg-brand-muted text-brand'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** WiFi 字段中的特殊字符转义（`\` `;` `,` `:` `"` `'` 前加反斜杠） */
function escapeWifiValue(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1').replace(/'/g, "\\'");
}

/** 组装最终写入二维码的内容 */
function buildContent(state: {
  template: Template;
  text: string;
  url: string;
  ssid: string;
  password: string;
  encryption: WifiEncryption;
  hidden: boolean;
  email: string;
  subject: string;
  body: string;
  phone: string;
}): string {
  switch (state.template) {
    case 'url': {
      const raw = state.url.trim();
      if (raw.length === 0) {
        return '';
      }
      return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
    }
    case 'wifi': {
      const ssid = state.ssid.trim();
      if (ssid.length === 0) {
        return '';
      }
      const type = state.encryption === 'nopass' ? 'nopass' : state.encryption;
      const password = state.encryption === 'nopass' ? '' : state.password;
      return `WIFI:T:${type};S:${escapeWifiValue(ssid)};P:${escapeWifiValue(password)};H:${
        state.hidden ? 'true' : 'false'
      };;`;
    }
    case 'email': {
      const address = state.email.trim();
      if (address.length === 0) {
        return '';
      }
      const params = new URLSearchParams();
      if (state.subject.trim().length > 0) {
        params.set('subject', state.subject.trim());
      }
      if (state.body.trim().length > 0) {
        params.set('body', state.body.trim());
      }
      const query = params.toString();
      return query.length > 0 ? `mailto:${address}?${query}` : `mailto:${address}`;
    }
    case 'phone': {
      const number = state.phone.trim();
      return number.length === 0 ? '' : number.startsWith('tel:') ? number : `tel:${number}`;
    }
    case 'text':
    default:
      return state.text;
  }
}

/** 读取 File 为 data URL */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(String(reader.result ?? ''));
    };
    reader.onerror = () => {
      reject(new Error('读取文件失败'));
    };
    reader.readAsDataURL(file);
  });
}

/** 加载图片（data URL → HTMLImageElement） */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error('图片解析失败，请更换图片重试'));
    };
    image.src = src;
  });
}

/**
 * 二维码生成 / 解析（对齐 ops-tools 参考实现）：
 * 5 种内容模板（文本 / URL / WiFi / 邮箱 / 电话）、4 档尺寸与容错级别、
 * 前景色 / 背景色自定义（含预设色块）、PNG 下载，
 * 以及**图片解析二维码**（选择图片 / 拖拽图片，基于 `jsqr`）。
 *
 * 全部在本地完成，不依赖 Tauri API，浏览器环境同样可用。
 */
export function QrCodeGenerator({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);

  // —— 内容模板状态 ——
  const [template, setTemplate] = usePersistedState<Template>(COMMAND_ID, 'template', 'text');
  const [text, setText] = usePersistedState<string>(COMMAND_ID, 'text', initialInput);
  const [url, setUrl] = usePersistedState<string>(COMMAND_ID, 'url', '');
  const [ssid, setSsid] = usePersistedState<string>(COMMAND_ID, 'ssid', '');
  const [password, setPassword] = React.useState<string>('');
  const [encryption, setEncryption] = usePersistedState<WifiEncryption>(COMMAND_ID, 'encryption', 'WPA');
  const [hidden, setHidden] = usePersistedState<boolean>(COMMAND_ID, 'hidden', false);
  const [email, setEmail] = usePersistedState<string>(COMMAND_ID, 'email', '');
  const [subject, setSubject] = usePersistedState<string>(COMMAND_ID, 'subject', '');
  const [body, setBody] = usePersistedState<string>(COMMAND_ID, 'body', '');
  const [phone, setPhone] = usePersistedState<string>(COMMAND_ID, 'phone', '');

  // —— 样式状态 ——
  const [level, setLevel] = usePersistedState<Level>(COMMAND_ID, 'level', 'M');
  const [size, setSize] = usePersistedState<number>(COMMAND_ID, 'size', 256);
  const [dark, setDark] = usePersistedState<string>(COMMAND_ID, 'dark', '#111827');
  const [light, setLight] = usePersistedState<string>(COMMAND_ID, 'light', '#ffffff');

  // —— 渲染状态 ——
  const [error, setError] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState<boolean>(false);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  // —— 解析状态 ——
  const [decoded, setDecoded] = React.useState<string>('');
  const [decodeError, setDecodeError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<string>('');
  const [decoding, setDecoding] = React.useState<boolean>(false);
  const [dragOver, setDragOver] = React.useState<boolean>(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const value = React.useMemo<string>(
    () =>
      buildContent({
        template,
        text,
        url,
        ssid,
        password,
        encryption,
        hidden,
        email,
        subject,
        body,
        phone,
      }),
    [template, text, url, ssid, password, encryption, hidden, email, subject, body, phone],
  );

  const trimmed = value.trim();

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const context = canvas.getContext('2d');
    if (trimmed.length === 0) {
      context?.clearRect(0, 0, canvas.width, canvas.height);
      setError(null);
      setReady(false);
      return;
    }
    let cancelled = false;
    setError(null);
    QRCode.toCanvas(canvas, trimmed, {
      errorCorrectionLevel: level,
      margin: 2,
      width: size,
      color: { dark, light },
    })
      .then(() => {
        if (!cancelled) {
          setError(null);
          setReady(true);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setReady(false);
        setError(
          cause instanceof Error ? `生成失败：${cause.message}` : `生成失败：${String(cause)}`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [trimmed, level, size, dark, light]);

  const savePng = React.useCallback((): void => {
    const canvas = canvasRef.current;
    if (canvas === null || !ready) {
      toast.warning('暂无可保存的二维码');
      return;
    }
    try {
      const anchor = document.createElement('a');
      anchor.href = canvas.toDataURL('image/png');
      anchor.download = `handy-qrcode-${size}-${Date.now()}.png`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      toast.success(`已保存 ${size}×${size} PNG`);
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      toast.error(`保存失败：${message}`);
    }
  }, [ready, size]);

  /** 执行二维码解析：data URL → 画布 → jsQR */
  const decodeFromDataUrl = React.useCallback(async (dataUrl: string): Promise<void> => {
    setDecoding(true);
    setDecodeError(null);
    setDecoded('');
    try {
      const image = await loadImage(dataUrl);
      const scale = Math.min(1, DECODE_MAX_SIDE / Math.max(image.width, image.height, 1));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context === null) {
        setDecodeError('无法创建画布上下文，解析失败');
        return;
      }
      context.drawImage(image, 0, 0, width, height);
      const imageData = context.getImageData(0, 0, width, height);
      const result = jsQR(imageData.data, width, height, {
        inversionAttempts: 'attemptBoth',
      });
      if (result === null) {
        setDecodeError('未能识别到二维码 —— 请确认图片清晰、二维码完整且未被严重遮挡');
        return;
      }
      setDecoded(result.data);
      toast.success('识别成功');
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setDecodeError(`解析失败：${message}`);
    } finally {
      setDecoding(false);
    }
  }, []);

  const handleFile = React.useCallback(
    async (file: File | null | undefined): Promise<void> => {
      if (!file) {
        return;
      }
      if (file.type.length > 0 && !file.type.startsWith('image/')) {
        toast.error('请选择图片文件（PNG / JPG / WEBP 等）');
        return;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        setPreview(dataUrl);
        await decodeFromDataUrl(dataUrl);
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setDecodeError(`读取失败：${message}`);
        setDecoding(false);
      }
    },
    [decodeFromDataUrl],
  );

  const applyDecodedToInput = React.useCallback((): void => {
    if (decoded.length === 0) {
      return;
    }
    setTemplate('text');
    setText(decoded);
    toast.success('已填入识别结果');
  }, [decoded]);

  return (
    <CommandShell
      title="二维码工具"
      onPaste={(t) => setText(t)}
      description="文本 / URL / WiFi / 邮箱 / 电话生成二维码，支持图片解析"
      icon={<QrCode className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={trimmed}
      primaryAction={{ label: '保存 PNG', onClick: savePng, disabled: !ready }}
      shortcutHint="选模板填内容自动生成；拖入图片可解析二维码（Esc 返回）"
      samples={[
        {
          label: '一段文本',
          description: '最基础的文本码：默认 256px、容错 M',
          apply: () => {
            setTemplate('text');
            setText('Handy 顺手 · 方便，而非全面');
          },
        },
        {
          label: '网址',
          description: '扫码即跳转；内容越长码点越密，长链接建议先用短链',
          apply: () => {
            setTemplate('url');
            setUrl('https://github.com/');
          },
        },
        {
          label: 'WiFi 卡',
          description: '扫码直接连网 —— 注意密码栏不进草稿存储，只活在当前会话',
          apply: () => {
            setTemplate('wifi');
            setSsid('Handy-Guest');
            setEncryption('WPA');
            setHidden(false);
          },
        },
        {
          label: '邮件草稿',
          description: '扫码打开邮件客户端并带上主题与正文',
          apply: () => {
            setTemplate('email');
            setEmail('ops@example.com');
            setSubject('顺手 · 使用反馈');
            setBody('你好，我想反馈一个问题：');
          },
        },
        {
          label: '电话',
          description: '扫码直接拨号（vCard / tel 场景）',
          apply: () => {
            setTemplate('phone');
            setPhone('+8613800000000');
          },
        },
      ]}
    >
      {/* 1180×820 基准：两列并排，窄屏（<1024px）自动回退单列 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ——— 左列：内容配置 ——— */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1">
            {TEMPLATES.map((item) => (
              <ChipButton
                key={item.value}
                active={template === item.value}
                onClick={() => setTemplate(item.value)}
              >
                {item.label}
              </ChipButton>
            ))}
          </div>

          {/* 文本 / URL */}
          {template === 'text' ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">文本内容</span>
              <textarea
                autoFocus
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="输入任意文本，如 Hello Handy"
                className={
                  'h-[120px] w-full resize-none rounded-lg border border-input bg-background p-3 text-sm ' +
                  'text-foreground placeholder:text-muted-foreground ' +
                  'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
                }
              />
            </label>
          ) : null}
          {template === 'url' ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">链接地址</span>
              <Input
                autoFocus
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="example.com 或 https://example.com"
              />
              <span className="text-xs text-muted-foreground">未带协议时自动补 https://</span>
            </label>
          ) : null}

          {/* WiFi */}
          {template === 'wifi' ? (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">网络名称 SSID</span>
                <Input
                  autoFocus
                  value={ssid}
                  onChange={(event) => setSsid(event.target.value)}
                  placeholder="MyHomeWiFi"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">密码</span>
                <Input
                  type="text"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={encryption === 'nopass' ? '开放网络无需密码' : 'WiFi 密码'}
                  disabled={encryption === 'nopass'}
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">加密方式</span>
                <div className="flex items-center gap-1">
                  {(
                    [
                      { value: 'WPA', label: 'WPA/WPA2' },
                      { value: 'WEP', label: 'WEP' },
                      { value: 'nopass', label: '无密码' },
                    ] as const
                  ).map((item) => (
                    <ChipButton
                      key={item.value}
                      active={encryption === item.value}
                      onClick={() => setEncryption(item.value)}
                    >
                      {item.label}
                    </ChipButton>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={hidden}
                  onChange={(event) => setHidden(event.target.checked)}
                  className="h-4 w-4 rounded border-input accent-brand"
                />
                隐藏网络（不广播 SSID）
              </label>
            </div>
          ) : null}

          {/* 邮箱 */}
          {template === 'email' ? (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">邮箱地址</span>
                <Input
                  autoFocus
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="someone@example.com"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">主题（可选）</span>
                <Input
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="邮件主题"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-foreground">正文（可选）</span>
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="邮件正文"
                  className={
                    'h-[90px] w-full resize-none rounded-lg border border-input bg-background p-3 text-sm ' +
                    'text-foreground placeholder:text-muted-foreground ' +
                    'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
                  }
                />
              </label>
            </div>
          ) : null}

          {/* 电话 */}
          {template === 'phone' ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">电话号码</span>
              <Input
                autoFocus
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+8613800138000"
              />
              <span className="text-xs text-muted-foreground">生成 tel: 链接，扫码可直接拨号</span>
            </label>
          ) : null}

          {/* 样式配置 */}
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">容错</span>
              {LEVELS.map((item) => (
                <ChipButton
                  key={item.value}
                  active={level === item.value}
                  onClick={() => setLevel(item.value)}
                >
                  {item.label}
                </ChipButton>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">尺寸</span>
              {SIZES.map((item) => (
                <ChipButton
                  key={item}
                  active={size === item}
                  onClick={() => setSize(item)}
                >
                  {item}px
                </ChipButton>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">前景色</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={dark}
                    onChange={(event) => setDark(event.target.value)}
                    aria-label="前景色"
                    className="h-8 w-10 cursor-pointer rounded border border-input bg-background p-0.5"
                  />
                  {DARK_PRESETS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      title={color}
                      onClick={() => setDark(color)}
                      style={{ backgroundColor: color }}
                      className={cn(
                        'h-5 w-5 rounded border',
                        dark.toLowerCase() === color.toLowerCase()
                          ? 'border-brand ring-2 ring-brand/30'
                          : 'border-border',
                      )}
                    />
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">背景色</span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={light}
                    onChange={(event) => setLight(event.target.value)}
                    aria-label="背景色"
                    className="h-8 w-10 cursor-pointer rounded border border-input bg-background p-0.5"
                  />
                  {LIGHT_PRESETS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      title={color}
                      onClick={() => setLight(color)}
                      style={{ backgroundColor: color }}
                      className={cn(
                        'h-5 w-5 rounded border',
                        light.toLowerCase() === color.toLowerCase()
                          ? 'border-brand ring-2 ring-brand/30'
                          : 'border-border',
                      )}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 内容预览 */}
          <div className="rounded-lg border border-border bg-muted/40 p-2.5">
            <div className="mb-1 text-xs text-muted-foreground">将写入二维码的内容</div>
            <div className="scrollbar-thin max-h-[70px] overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">
              {trimmed.length > 0 ? trimmed : '（空）'}
            </div>
          </div>
        </div>

        {/* ——— 右列：预览 + 解析 ——— */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-h-[420px] flex-col items-center justify-center rounded-xl border border-border bg-card p-6">
            <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                预览 · {size}×{size}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{level}</span>
            </div>
            {trimmed.length === 0 ? (
              <p className="text-sm text-muted-foreground">填写内容后自动生成二维码</p>
            ) : error !== null ? (
              <p className="max-w-[320px] text-center text-sm text-destructive">{error}</p>
            ) : (
              <canvas
                ref={canvasRef}
                className="max-h-[360px] max-w-full rounded-lg"
                aria-label="二维码预览"
              />
            )}
            {ready ? (
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={savePng}>
                  <ImageDown className="h-3.5 w-3.5" />
                  下载 PNG
                </Button>
                <CopyButton text={trimmed} variant="ghost" size="sm" label="复制内容" />
              </div>
            ) : null}
          </div>

          {/* 二维码解析 */}
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              const file = event.dataTransfer.files[0];
              void handleFile(file);
            }}
            className={cn(
              'flex flex-col gap-2 rounded-xl border border-dashed p-3 transition-colors',
              dragOver ? 'border-brand bg-brand-muted/40' : 'border-border bg-card',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <ScanLine className="h-4 w-4" />
                二维码解析
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => fileRef.current?.click()}
                  disabled={decoding}
                >
                  <Upload className="h-3.5 w-3.5" />
                  {decoding ? '识别中…' : '选择图片'}
                </Button>
                {decoded.length > 0 ? (
                  <CopyButton text={decoded} variant="ghost" size="sm" className="h-7 px-2 text-xs" />
                ) : null}
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                void handleFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <p className="text-xs text-muted-foreground">
              把含二维码的图片拖拽到此处，或点击「选择图片」。识别在本地完成，图片不会上传。
            </p>

            {preview.length > 0 ? (
              <div className="flex items-start gap-2">
                <img
                  src={preview}
                  alt="待解析图片预览"
                  className="h-16 w-16 shrink-0 rounded border border-border object-cover"
                />
                <div className="min-w-0 flex-1">
                  {decoded.length > 0 ? (
                    <>
                      <div className="mb-1 text-xs text-muted-foreground">识别结果</div>
                      <div className="scrollbar-thin max-h-[96px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs text-foreground">
                        {decoded}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mt-1 h-6 px-2 text-xs"
                        onClick={applyDecodedToInput}
                      >
                        填入输入框
                      </Button>
                    </>
                  ) : decodeError !== null ? (
                    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                      {decodeError}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">处理中…</div>
                  )}
                </div>
              </div>
            ) : decodeError !== null ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {decodeError}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </CommandShell>
  );
}

export default QrCodeGenerator;
