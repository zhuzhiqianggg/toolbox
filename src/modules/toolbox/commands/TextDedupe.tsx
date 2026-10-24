import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Filter } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'text-dedup';

/** 示例：同一异常刷屏的日志片段（真实场景里最常见的去重对象） */
const SAMPLE_LOG = [
  '2026-09-15 10:12:03 ERROR upstream timeout host=cache-01 retry=1',
  '2026-09-15 10:12:03 ERROR upstream timeout host=cache-01 retry=1',
  '2026-09-15 10:12:08 WARN slow query 2.31s db=orders',
  ' 2026-09-15 10:12:08 WARN slow query 2.31s db=orders ',
  '2026-09-15 10:13:41 ERROR upstream timeout host=cache-02 retry=1',
  '2026-09-15 10:13:41 ERROR upstream timeout host=cache-02 retry=1',
].join('\n');

/** 示例：同一批主机名，大小写与空格不一致 */
const SAMPLE_HOSTS = ['Node-A.Example.com', 'node-a.example.com', ' Node-B.example.com', 'NODE-B.EXAMPLE.COM', 'node-c.example.com'].join('\n');

/**
 * 文本去重：按行去重，支持「去首尾空格」「忽略大小写」「结果排序」选项。
 * 标题栏「一键复制」复制去重后全部行。
 */
export function TextDedupe({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput);
  const [trim, setTrim] = usePersistedState<boolean>(COMMAND_ID, 'trim', true);
  const [ignoreCase, setIgnoreCase] = usePersistedState<boolean>(COMMAND_ID, 'ignoreCase', false);
  const [sort, setSort] = usePersistedState<boolean>(COMMAND_ID, 'sort', false);

  const { output, removed } = React.useMemo(() => {
    const raw = input.split(/\r?\n/);
    const processed = raw.map((line) => (trim ? line.trim() : line));
    const seen = new Set<string>();
    const out: string[] = [];
    let dup = 0;
    for (const line of processed) {
      const key = ignoreCase ? line.toLowerCase() : line;
      if (seen.has(key)) {
        dup += 1;
        continue;
      }
      seen.add(key);
      out.push(line);
    }
    if (sort) {
      out.sort((a, b) => a.localeCompare(b));
    }
    return { output: out.join('\n'), removed: dup };
  }, [input, trim, ignoreCase, sort]);

  const lineCount = output.length > 0 ? output.split('\n').length : 0;

  return (
    <CommandShell
      title="文本去重"
      onPaste={(t) => setInput(t)}
      description="按行去除重复，支持去空格 / 忽略大小写 / 排序"
      icon={<Filter className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={output}
      shortcutHint={`已去除 ${removed} 行重复`}
      samples={[
        {
          label: '日志刷屏去重',
          description: '同一错误重复打印，保留首次出现（真实日志场景）',
          apply: () => {
            setInput(SAMPLE_LOG);
            setTrim(true);
            setIgnoreCase(false);
          },
        },
        {
          label: '大小写混合主机名',
          description: 'Node-A 与 node-a 默认算两条；打开「忽略大小写」即合并',
          apply: () => {
            setInput(SAMPLE_HOSTS);
            setTrim(true);
            setIgnoreCase(true);
          },
        },
        {
          label: '带空格的脏数据',
          description: '行首尾有多余空格，靠「去空格」先归一化再去重',
          apply: () => {
            setInput(SAMPLE_LOG);
            setTrim(true);
          },
        },
        {
          label: '排序输出',
          description: '在去重基础上按字典序排列，便于比对两份清单',
          apply: () => {
            setInput(SAMPLE_HOSTS);
            setTrim(true);
            setIgnoreCase(true);
            setSort(true);
          },
        },
      ]}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <label className="text-sm font-medium text-foreground" htmlFor="dedup-input">
            输入（每行一条）
          </label>
          <textarea
            id="dedup-input"
            rows={12}
            className="w-full min-h-0 flex-1 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={input}
            placeholder={'apple\nApple\n banana\napple'}
            onChange={(event) => setInput(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={trim} onCheckedChange={setTrim} />
              去空格
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={ignoreCase} onCheckedChange={setIgnoreCase} />
              忽略大小写
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={sort} onCheckedChange={setSort} />
              排序
            </label>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-sm text-muted-foreground">
            结果（共 {lineCount} 行，去除 {removed} 行重复）
          </div>
          <ResultBox title="去重后" value={output} emptyHint="输入文本后自动去重" mono />
        </div>
      </div>
    </CommandShell>
  );
}

export default TextDedupe;
