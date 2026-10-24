import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { FileImage, Upload } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import { toast } from '@/components/ui/toast';
import { BASE64_MAX_FILE_SIZE, readFileAsBase64 } from '@/modules/toolbox/lib/base64Utils';
import { formatBytes } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'image-to-base64';
// tool-audit-ignore: samples —— 本工具无文本输入（文件选择 / 拖放），示例条无处可填

/** 常见图片扩展名 → MIME（file.type 为空时的兜底，部分系统 / WebView 拿不到类型）。 */
const IMAGE_EXT_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/**
 * 图片转 Base64：选择本地图片文件，读取字节为 Base64（复用工具箱 base64Utils 的
 * FileReader 实现，Tauri WebView 与浏览器行为一致），并预览、可一键复制。
 *
 * - 可切换「复制为 Data URI」—— `data:image/png;base64,…` 才是能直接贴进
 *   `<img src>` / CSS `background` 的形态；裸 Base64 只有塞进 JSON 字段时才用得上。
 * - 文件大小上限与 Base64 编解码一致（10MB），超限给出明确提示而非硬撑出超大字符串。
 * - file.type 为空时按扩展名推断 MIME，保证预览与 Data URI 前缀不失效。
 */
export function ImageToBase64({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [base64, setBase64] = React.useState<string>('');
  const [preview, setPreview] = React.useState<string>('');
  const [meta, setMeta] = React.useState<{ name: string; size: number; type: string } | null>(null);
  const [dataUri, setDataUri] = usePersistedState<boolean>(COMMAND_ID, 'dataUri', false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const handleFile = React.useCallback(async (file: File | undefined): Promise<void> => {
    if (!file) {
      return;
    }
    // file.type 为空时按扩展名兜底推断，仍推不出才判定为非图片
    const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
    const mime = file.type !== '' ? file.type : (IMAGE_EXT_MIME[ext] ?? '');
    if (!mime.startsWith('image/')) {
      toast.warning('请选择图片文件（png/jpg/gif/webp/svg 等）');
      return;
    }
    if (file.size > BASE64_MAX_FILE_SIZE) {
      toast.error(`图片超过 ${formatBytes(BASE64_MAX_FILE_SIZE)} 上限，当前 ${formatBytes(file.size)}`);
      return;
    }
    try {
      const encoded = await readFileAsBase64(file);
      setBase64(encoded);
      setPreview(`data:${mime};base64,${encoded}`);
      setMeta({ name: file.name, size: file.size, type: mime });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '读取失败';
      toast.error(`图片读取失败：${message}`);
    }
  }, []);

  /** 清空当前结果（回到初始引导态）。 */
  const clear = React.useCallback((): void => {
    setBase64('');
    setPreview('');
    setMeta(null);
  }, []);

  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files?.[0];
      event.target.value = '';
      void handleFile(file);
    },
    [handleFile],
  );

  return (
    <CommandShell
      title="图片转 Base64"
      description="选择图片，读取字节为 Base64 并预览"
      icon={<FileImage className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={dataUri && preview !== '' ? preview : base64}
      shortcutHint="点击「选择图片」后即时生成；标题栏复制按钮跟随下方 Data URI 开关（Esc 返回）"
    >
      <div className="flex flex-col gap-4">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleChange}
        />

        {meta === null ? (
          /* 初始引导态：说明能力与限制，主操作唯一且醒目 */
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-10 text-center">
            <FileImage className="h-6 w-6 text-muted-foreground" />
            <div className="text-sm font-medium text-foreground">选择一张图片开始</div>
            <div className="max-w-md text-xs text-muted-foreground">
              支持 png / jpg / gif / webp / svg 等，上限 {formatBytes(BASE64_MAX_FILE_SIZE)}；
              生成后可预览、切换 Data URI 前缀并一键复制
            </div>
            <Button size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              选择图片
            </Button>
          </div>
        ) : (
          <>
            {/* 已载入：文件信息 + 操作行 */}
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="max-w-[280px] truncate font-medium text-foreground">{meta.name}</span>
                <span>类型：{meta.type}</span>
                <span>大小：{formatBytes(meta.size)}</span>
                <span>Base64 长度：{base64.length}</span>
                {meta.size > 0 ? (
                  <span
                    title="Base64 按 3 字节编码为 4 个字符，理论上膨胀约 33%（再加换行与 data: 前缀）"
                    className={base64.length / meta.size > 1.4 ? 'text-amber-600' : undefined}
                  >
                    体积比：{(base64.length / meta.size).toFixed(2)}×
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  <Upload className="h-4 w-4" />
                  重新选择
                </Button>
                <Button variant="ghost" size="sm" onClick={clear}>
                  清除
                </Button>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <Switch checked={dataUri} onCheckedChange={setDataUri} />
                  复制为 Data URI（含 <code className="font-mono text-xs">data:…;base64,</code> 前缀）
                </label>
              </div>
            </div>

            <div className="flex justify-center rounded-md border border-border bg-card p-3">
              {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
              <img src={preview} alt="预览" className="max-h-48 rounded object-contain" />
            </div>
          </>
        )}

        <ResultBox
          title={dataUri ? 'Data URI（可直接贴进 img src / CSS）' : 'Base64（裸串）'}
          value={dataUri && preview !== '' ? preview : base64}
          emptyHint="选择图片后显示其 Base64 编码"
          mono
        />
      </div>
    </CommandShell>
  );
}

export default ImageToBase64;
