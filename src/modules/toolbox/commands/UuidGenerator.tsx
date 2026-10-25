import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Fingerprint } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { CopyButton } from '@/components/CopyButton';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'uuid-generator';

/** 生成单个 v4 UUID（优先 crypto.randomUUID，降级到 Math.random 实现）。 */
function generateV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // 降级实现（RFC 4122 v4 变体）
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i += 1) {
    hex.push((bytes[i] ?? 0).toString(16).padStart(2, '0'));
  }
  return (
    `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}` +
    `-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`
  );
}

/** 应用大小写 / 连字符选项。 */
function formatUuid(id: string, uppercase: boolean, dashes: boolean): string {
  let out = uppercase ? id.toUpperCase() : id;
  if (!dashes) {
    out = out.replace(/-/g, '');
  }
  return out;
}

/**
 * UUID 生成器：批量产出 RFC 4122 v4 UUID，支持大小写与连字符开关。
 *
 * 列表里只存**原始形态**（小写带连字符），大小写 / 连字符在渲染时套用 ——
 * 这样切换开关立即生效，不必重新生成（重新生成会换掉整批值，违背用户预期）。
 * 每行可单独复制，标题栏「一键复制」复制全部。
 */
export function UuidGenerator({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  /** 初始数量：命令行传参优先，非法则 5 */
  const initialCount = React.useMemo(() => {
    const parsed = Number.parseInt(initialInput, 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1000) : 5;
  }, [initialInput]);

  const [count, setCount] = usePersistedState<number>(COMMAND_ID, 'count', initialCount);
  const [uppercase, setUppercase] = usePersistedState<boolean>(COMMAND_ID, 'uppercase', false);
  const [dashes, setDashes] = usePersistedState<boolean>(COMMAND_ID, 'dashes', true);
  /**
   * 冷启动即出结果（V20）：打开工具先摆上一批 UUID。
   * 数量对齐持久化的 count（而非命令行参数），避免「输入框写着 10、列表只有 5 条」的错位；
   * 持久化值可能被手动改坏，夹到 1-1000 防止首帧生成超大数组。
   */
  const [uuids, setUuids] = React.useState<string[]>(() =>
    Array.from({ length: Math.min(1000, Math.max(1, count)) }, () => generateV4()),
  );

  /** 用**显式参数**生成，避免「先 setState 再调 generate」读到旧值的经典竞态（示例按钮依赖它） */
  const generateWith = React.useCallback((n: number, upper: boolean, dash: boolean): void => {
    const safe = Math.max(1, Math.min(n || 1, 1000));
    setCount(safe);
    setUppercase(upper);
    setDashes(dash);
    setUuids(Array.from({ length: safe }, () => generateV4()));
  }, []);

  const generate = React.useCallback((): void => {
    generateWith(count, uppercase, dashes);
  }, [count, uppercase, dashes, generateWith]);

  /** 渲染时统一应用大小写 / 连字符选项 */
  const formatted = React.useMemo(
    () => uuids.map((id) => formatUuid(id, uppercase, dashes)),
    [uuids, uppercase, dashes],
  );

  const copyTextValue = formatted.join('\n');

  return (
    <CommandShell
      title="UUID 生成器"
      description="批量生成 RFC 4122 v4 UUID，支持大小写与连字符选项"
      icon={<Fingerprint className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={copyTextValue}
      primaryAction={{ label: '生成', onClick: generate }}
      shortcutHint="点「生成」或在数量框按 Enter 重新生成 · 大小写 / 连字符切换即时生效（Esc 返回）"
      samples={[
        {
          label: '5 条标准 v4',
          description: '小写 + 连字符，最常见的 RFC 4122 形态',
          apply: () => generateWith(5, false, true),
        },
        {
          label: '32 位无连字符',
          description: '去掉连字符的 32 位十六进制串 —— 塞进 char(32) 主键或日志追踪号',
          apply: () => generateWith(5, false, false),
        },
        {
          label: '大写形式',
          description: '部分老系统的校验规则要求大写，顺带看一眼大小写开关',
          apply: () => generateWith(5, true, true),
        },
        {
          label: '批量 100 条',
          description: '导入测试数据用；上限 1000 条，一次性铺满',
          apply: () => generateWith(100, false, true),
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            数量（1-1000）
            <Input
              autoFocus
              type="number"
              min={1}
              max={1000}
              value={count}
              onChange={(event) => setCount(Number.parseInt(event.target.value, 10) || 1)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  generate();
                }
              }}
              className="w-32"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={uppercase} onCheckedChange={setUppercase} />
            大写
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={dashes} onCheckedChange={setDashes} />
            包含连字符
          </label>
          <Button onClick={generate} className="ml-auto">
            生成
          </Button>
        </div>

        {uuids.length > 0 ? (
          <>
            <div className="text-xs text-muted-foreground">
              共 {uuids.length} 条 · 标题栏复制按钮可一次复制全部
            </div>
            <div className="overflow-auto rounded-md border scrollbar-thin">
              <table className="w-full text-left text-xs">
                <tbody>
                  {formatted.map((id, index) => (
                    <tr key={`${id}-${index}`} className="border-b border-border last:border-0">
                      <td className="px-2 py-1.5 font-mono text-foreground">{id}</td>
                      <td className="px-2 py-1.5 text-right">
                        <CopyButton text={id} label="复制" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            点击「生成」批量产出 UUID
          </div>
        )}
      </div>
    </CommandShell>
  );
}

export default UuidGenerator;
