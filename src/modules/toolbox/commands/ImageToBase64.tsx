import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { FileImage, Upload } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import { toast } from '@/components/ui/toast';
import { readFileAsBase64 } from '@/modules/toolbox/lib/base64Utils';
import { formatBytes } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'image-to-base64';
// tool-audit-ignore: samples —— 本工具无文本输入（文件选择 / 拖放），示例条无处可填

/**
 * 图片转 Base64：选择本地图片文件，读取字节为 Base64（复用工具箱 base64Utils 的
 * FileReader 实现，Tauri WebView 与浏览器行为一致），并预览、可一键复制。
 *
 * V20 增强：可切换「复制为 Data URI」—— `data:image/png;base64,…` 才是能直接贴进
 * `<img src>` / CSS `background` 的形态；裸 Base64 只有塞进 JSON 字段时才用得上。
 * 两年前这个工具只给裸串，用户还得自己补前缀。同时给出体积膨胀比，提醒内联的代价。
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
    if (!file.type.startsWith('image/')) {
      toast.warning('请选择图片文件（png/jpg/gif/webp 等）');
      return;
    }
    try {
      const encoded = await readFileAsBase64(file);
      setBase64(encoded);
      setPreview(`data:${file.type};base64,${encoded}`);
      setMeta({ name: file.name, size: file.size, type: file.type });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '读取失败';
      toast.error(`图片读取失败：${message}`);
    }
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
      shortcutHint="点击「选择图片」后即时生成；标题栏复制按钮跟随下方 Data URI 开关"
    >
      <div className="flex flex-col gap-4">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleChange}
        />
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" />
            选择图片
          </Button>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={dataUri} onCheckedChange={setDataUri} />
            复制为 Data URI（含 <code className="font-mono text-xs">data:…;base64,</code> 前缀）
          </label>
        </div>

        {meta ? (
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>文件名：{meta.name}</span>
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
        ) : null}

        {preview ? (
          <div className="flex justify-center rounded-md border border-border bg-card p-3">
            {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
            <img src={preview} alt="预览" className="max-h-48 rounded object-contain" />
          </div>
        ) : null}

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
