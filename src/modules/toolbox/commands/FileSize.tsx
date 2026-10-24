import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { HardDrive } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import { formatAllUnits, toBytesText, toMatchingBase, unitsFor } from '@/lib/byteUnits';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'file-size';

/**
 * 文件大小格式化：字节 ⇄ 人类可读（KB/MB/GB…），base-2 / base-10 可切换。
 */
export function FileSize({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [tab, setTab] = usePersistedState<string>(COMMAND_ID, 'tab', 'b2h');
  const [base2, setBase2] = usePersistedState<boolean>(COMMAND_ID, 'base2', true);
  const [bytesInput, setBytesInput] = usePersistedState<string>(COMMAND_ID, 'bytesInput', initialInput);
  const [valueInput, setValueInput] = usePersistedState<string>(COMMAND_ID, 'valueInput', '');
  const [unit, setUnit] = usePersistedState<string>(COMMAND_ID, 'unit', 'MB');

  // 进制切换（含持久化状态在冷启动时的回落）后，把单位带到对应的一套上去。
  // 不做这一步，`unitFactor` 会静默按 1 倍算 —— 见 byteUnits.toMatchingBase 的说明。
  React.useEffect(() => {
    setUnit((prev) => toMatchingBase(prev, base2));
  }, [base2]);

  const bytesNum = Number.parseFloat(bytesInput);
  const b2hList = React.useMemo(() => formatAllUnits(bytesNum, base2), [bytesNum, base2]);

  const h2bResult = React.useMemo<string>(
    () => toBytesText(Number.parseFloat(valueInput), unit, base2),
    [valueInput, unit, base2],
  );

  const copyText = tab === 'b2h' ? b2hList : h2bResult;

  const onTabChange = React.useCallback((value: string): void => {
    setTab(value);
  }, []);

  const units = unitsFor(base2);

  return (
    <CommandShell
      title="文件大小格式化"
      onPaste={(t) => setBytesInput(t)}
      description="字节 ⇄ 人类可读（base-2 / base-10 切换）"
      icon={<HardDrive className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={copyText}
      shortcutHint="切换上方标签；右下开关切换 base-2 / base-10"
      samples={[
        {
          label: '1 MiB 是多少',
          description: '1048576 字节 —— base-2 下正好 1 MiB，一次看到全部单位',
          apply: () => {
            setTab('b2h');
            setBase2(true);
            setBytesInput('1048576');
          },
        },
        {
          label: 'base-2 vs base-10',
          description: '同为 1000000000：base-2 显示 953.67 MiB，base-10 显示 1 GB，这就是「硬盘容量缩水」的来源',
          apply: () => {
            setTab('b2h');
            setBase2(true);
            setBytesInput('1000000000');
          },
        },
        {
          label: '磁盘容量 512 GB',
          description: '厂商标称容量按 base-10 算 —— 切到 base-10 才是你要的那一行',
          apply: () => {
            setTab('b2h');
            setBase2(false);
            setBytesInput('512000000000');
          },
        },
        {
          label: '反查 1.5 TiB',
          description: '易读 → 字节：1.5 TiB 到底是多少字节（备份脚本算容量常用）',
          apply: () => {
            setTab('h2b');
            setBase2(true);
            setValueInput('1.5');
            setUnit('TiB');
          },
        },
        {
          label: '反查 20 MB',
          description: '易读 → 字节：接口限流写「20MB」时对应的字节上限',
          apply: () => {
            setTab('h2b');
            setBase2(false);
            setValueInput('20');
            setUnit('MB');
          },
        },
      ]}
    >
      <div className="flex flex-col gap-4">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Switch checked={base2} onCheckedChange={setBase2} />
          {base2 ? 'base-2（KiB/MiB…）' : 'base-10（KB/MB…）'}
        </label>
        <Tabs value={tab} onValueChange={onTabChange}>
          <TabsList>
            <TabsTrigger value="b2h">字节 → 易读</TabsTrigger>
            <TabsTrigger value="h2b">易读 → 字节</TabsTrigger>
          </TabsList>

          <TabsContent value="b2h">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="fs-bytes">
                  字节数
                </label>
                <Input
                  id="fs-bytes"
                  type="number"
                  min={0}
                  value={bytesInput}
                  onChange={(event) => setBytesInput(event.target.value)}
                  placeholder="1048576"
                />
              </div>
              <ResultBox title="易读结果" value={b2hList} emptyHint="输入字节数后自动换算" mono />
            </div>
          </TabsContent>

          <TabsContent value="h2b">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="flex flex-col gap-3">
                <label className="text-sm font-medium text-foreground" htmlFor="fs-value">
                  数值
                </label>
                <Input
                  id="fs-value"
                  type="number"
                  value={valueInput}
                  onChange={(event) => setValueInput(event.target.value)}
                  placeholder="1"
                />
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  单位
                  <select
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                    value={unit}
                    onChange={(event) => setUnit(event.target.value)}
                  >
                    {units.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <ResultBox title="字节结果" value={h2bResult} emptyHint="输入数值与单位后换算" mono />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </CommandShell>
  );
}

export default FileSize;
