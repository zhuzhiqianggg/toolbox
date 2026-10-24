import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { AtSign } from 'lucide-react';
import { pinyin } from 'pinyin-pro';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'slug-generator';

type Separator = '-' | '_' | '.';

/** 生成 URL slug（纯 TS；中文可走 pinyin-pro 拼音化）。 */
function slugify(
  text: string,
  separator: Separator,
  lowercase: boolean,
  romanize: boolean,
  maxLength: number,
): string {
  let working = text;
  if (romanize) {
    working = pinyin(working, { toneType: 'none', nonZh: 'consecutive' });
  }
  if (lowercase) {
    working = working.toLowerCase();
  }
  const escaped = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = working.replace(/[^a-z0-9]+/gi, separator);
  out = out.replace(new RegExp(`${escaped}+`, 'g'), separator);
  out = out.replace(new RegExp(`^${escaped}+|${escaped}+$`, 'g'), '');
  if (maxLength > 0 && out.length > maxLength) {
    out = out.slice(0, maxLength).replace(new RegExp(`${escaped}+$`), '');
  }
  return out;
}

/**
 * Slug 生成：文本 → URL slug，可选分隔符、小写、拼音化与最大长度。
 * 复用项目既有依赖 pinyin-pro 处理中文。
 */
export function SlugGenerator({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput || 'Toolbox 顺手 · 效率工具');
  const [separator, setSeparator] = usePersistedState<Separator>(COMMAND_ID, 'separator', '-');
  const [lowercase, setLowercase] = usePersistedState<boolean>(COMMAND_ID, 'lowercase', true);
  const [romanize, setRomanize] = usePersistedState<boolean>(COMMAND_ID, 'romanize', true);
  const [maxLength, setMaxLength] = usePersistedState<number>(COMMAND_ID, 'maxLength', 0);

  const output = React.useMemo(
    () => slugify(input, separator, lowercase, romanize, maxLength),
    [input, separator, lowercase, romanize, maxLength],
  );

  const hasInput = input.trim().length > 0;
  /** 输入非空却拿不到 slug：最常见原因是关了拼音化、内容又全是中文 */
  const noOutputHint =
    hasInput && output.length === 0
      ? '没有生成结果：内容里没有拉丁字母或数字；含中文请开启「拼音化」'
      : '输入文本后自动生成';

  return (
    <CommandShell
      title="Slug 生成"
      onPaste={(t) => setInput(t)}
      description="文本 → URL slug（支持拼音化与分隔符选项）"
      icon={<AtSign className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={output}
      shortcutHint="中文可开启「拼音化」转为拼音 slug"
      samples={[
        {
          label: '中文标题',
          description: '「顺手 · 效率工具」→ 开启拼音化后变成 shun-shou-xiao-lv-gong-ju 风格',
          apply: () => {
            setInput('Toolbox 顺手 · 效率工具');
            setRomanize(true);
            setLowercase(true);
            setSeparator('-');
            setMaxLength(0);
          },
        },
        {
          label: '英文标题',
          description: '长英文标题 → 空格、冒号、大小写统一压成单个连字符',
          apply: () => {
            setInput('Deploy Tauri App to Windows: A Complete Guide');
            setRomanize(true);
            setSeparator('-');
            setMaxLength(0);
          },
        },
        {
          label: '含特殊字符',
          description: 'C++ / Rust（2026版）→ 非法字符被清洗，中文转拼音',
          apply: () => {
            setInput('C++ / Rust: 性能对比（2026 版）');
            setRomanize(true);
            setSeparator('-');
            setMaxLength(0);
          },
        },
        {
          label: '限定 60 字符',
          description: '常用于 SEO 标题；超出后按分隔符边界截断，不留尾巴',
          apply: () => {
            setInput('How to Build a Cross Platform Desktop Tool with Tauri and React in 2026');
            setRomanize(true);
            setSeparator('-');
            setMaxLength(60);
          },
        },
        {
          label: '下划线文件名',
          description: '分隔符切到下划线，适合当静态资源文件名',
          apply: () => {
            setInput('用户协议 v2 最终版');
            setRomanize(true);
            setLowercase(true);
            setSeparator('_');
            setMaxLength(0);
          },
        },
      ]}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <label className="text-sm font-medium text-foreground" htmlFor="slug-input">
            输入文本
          </label>
          <textarea
            id="slug-input"
            rows={4}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={input}
            placeholder="输入文章标题 / 文件名，如：Toolbox 顺手 · 效率工具"
            onChange={(event) => setInput(event.target.value)}
          />
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              分隔符
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                value={separator}
                onChange={(event) => setSeparator(event.target.value as Separator)}
              >
                <option value="-">-（连字符）</option>
                <option value="_">_（下划线）</option>
                <option value=".">.（点）</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              最大长度（0=不限）
              <Input
                type="number"
                min={0}
                max={200}
                value={maxLength}
                onChange={(event) =>
                  setMaxLength(Math.max(0, Math.min(200, Number.parseInt(event.target.value, 10) || 0)))
                }
                className="w-28"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={lowercase} onCheckedChange={setLowercase} />
              小写
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={romanize} onCheckedChange={setRomanize} />
              拼音化（中文）
            </label>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <ResultBox
            title={output.length > 0 ? `Slug（${output.length} 字符）` : 'Slug'}
            value={output}
            emptyHint={noOutputHint}
            mono
          />
        </div>
      </div>
    </CommandShell>
  );
}

export default SlugGenerator;
