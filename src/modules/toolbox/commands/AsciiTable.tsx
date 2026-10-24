import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Table2 } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCommandShell } from '@/hooks/useCommandShell';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'ascii-table';

/** 常用控制字符名称（0-31 / 127）。 */
const CONTROL_NAMES: Record<number, string> = {
  0: 'NUL 空字符',
  1: 'SOH 标题开始',
  2: 'STX 正文开始',
  3: 'ETX 正文结束',
  4: 'EOT 传输结束',
  5: 'ENQ 询问',
  6: 'ACK 确认',
  7: 'BEL 响铃',
  8: 'BS 退格',
  9: 'HT 水平制表',
  10: 'LF 换行',
  11: 'VT 垂直制表',
  12: 'FF 换页',
  13: 'CR 回车',
  14: 'SO 移出',
  15: 'SI 移入',
  16: 'DLE 数据链路转义',
  17: 'DC1 设备控制1',
  18: 'DC2 设备控制2',
  19: 'DC3 设备控制3',
  20: 'DC4 设备控制4',
  21: 'NAK 否定确认',
  22: 'SYN 同步空闲',
  23: 'ETB 传输块结束',
  24: 'CAN 取消',
  25: 'EM 媒介结束',
  26: 'SUB 替换',
  27: 'ESC 转义',
  28: 'FS 文件分隔',
  29: 'GS 组分隔',
  30: 'RS 记录分隔',
  31: 'US 单元分隔',
  127: 'DEL 删除',
};

/** 可打印字符显示（控制字符与空格用占位符）。 */
function displayChar(code: number): string {
  if (code === 32) {
    return '␣';
  }
  if (code < 32 || code === 127) {
    return '·';
  }
  return String.fromCharCode(code);
}

/** 单个字符的编码信息行。 */
interface CharInfo {
  /** 原字符（含代理对整体） */
  char: string;
  /** Unicode 码点（十进制） */
  codePoint: number;
  /** 是否 ASCII（0-127） */
  isAscii: boolean;
}

/** 将输入文本按码点拆分（正确处理 emoji 等代理对）。 */
function toCharInfos(text: string): CharInfo[] {
  const chars = Array.from(text);
  return chars.map((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return { char, codePoint, isAscii: codePoint <= 127 };
  });
}

/** 查询结果导出为 TSV（列：字符 / 十进制 / 十六进制 / 二进制 / 说明）。 */
function toTsv(infos: CharInfo[]): string {
  const header = '字符\t十进制\t十六进制\t二进制\t说明';
  const rows = infos.map(({ char, codePoint, isAscii }) => {
    const label = codePoint < 32 || codePoint === 127 ? (CONTROL_NAMES[codePoint] ?? '控制字符') : '';
    const shown = char === '\n' ? '\\n' : char === '\t' ? '\\t' : char === '\r' ? '\\r' : char;
    return [shown, String(codePoint), `0x${codePoint.toString(16).toUpperCase().padStart(2, '0')}`, codePoint.toString(2).padStart(8, '0'), isAscii ? label : '非 ASCII'].join('\t');
  });
  return [header, ...rows].join('\n');
}

/**
 * ASCII 表 / 字符编码查询：粘贴文本逐字符查看十进制 / 十六进制 / 二进制码点，
 * 并内置 0-127 标准 ASCII 速查表（8×16 网格）。
 */
export function AsciiTable({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [tab, setTab] = usePersistedState<string>(COMMAND_ID, 'tab', 'lookup');
  const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput);

  const infos = React.useMemo(() => toCharInfos(input), [input]);
  const tsv = React.useMemo(() => toTsv(infos), [infos]);
  const asciiCount = React.useMemo(() => infos.filter((info) => info.isAscii).length, [infos]);

  return (
    <CommandShell
      title="ASCII 表"
      onPaste={(t) => setInput(t)}
      description="字符编码查询与 0-127 ASCII 速查表"
      icon={<Table2 className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={tab === 'lookup' ? tsv : ''}
      shortcutHint="查询结果可一键复制为 TSV（可粘贴到 Excel）"
      samples={[
        {
          label: '中英混排',
          description: 'ASCII 与多字节字符同框 —— 一眼看清「中文占 2 字节以上」到底长什么样',
          apply: () => setInput('Handy 顺手 2026'),
        },
        {
          label: 'Emoji（代理对）',
          description: '按码点拆分而不是按 UTF-16 单元 —— emoji 不会被劈成两半乱码',
          apply: () => setInput('🚀🛠️✅'),
        },
        {
          label: '控制字符',
          description: '制表符与换行逐字符展示为 \\t / \\n，排查「看不见的字符」',
          apply: () => setInput('a\tb\nc'),
        },
        {
          label: '全角 / 空格',
          description: '普通空格显示为 ␣、全角空格（U+3000）显示为 Unicode 码点 —— 定位排版怪问题的利器',
          apply: () => setInput('a b\u3000c'),
        },
        {
          label: 'HTTP 报文头',
          description: '真实报文片段（含 CRLF）—— 从字节层面看为什么「多了一个空行就解析失败」',
          apply: () => setInput('GET / HTTP/1.1\r\nHost: handy.local\r\n\r\n'),
        },
      ]}
    >
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="lookup">字符查询</TabsTrigger>
          <TabsTrigger value="table">ASCII 速查表</TabsTrigger>
        </TabsList>

        <TabsContent value="lookup" className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm font-medium text-foreground" htmlFor="ascii-input">
            输入文本
            <textarea
              id="ascii-input"
              rows={3}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={input}
              placeholder="粘贴任意文本，逐字符查看编码"
              onChange={(event) => setInput(event.target.value)}
            />
          </label>

          {infos.length > 0 ? (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>共 {infos.length} 个字符</span>
                <span>ASCII {asciiCount} 个</span>
                <span>非 ASCII {infos.length - asciiCount} 个</span>
                <Button variant="outline" size="sm" className="ml-auto" onClick={() => setInput('')}>
                  清空
                </Button>
              </div>
              <div className="overflow-auto rounded-md border scrollbar-thin">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                      <th className="px-2 py-1.5 font-medium">字符</th>
                      <th className="px-2 py-1.5 font-medium">十进制</th>
                      <th className="px-2 py-1.5 font-medium">十六进制</th>
                      <th className="px-2 py-1.5 font-medium">二进制</th>
                      <th className="px-2 py-1.5 font-medium">说明</th>
                      <th className="px-2 py-1.5" aria-label="操作" />
                    </tr>
                  </thead>
                  <tbody>
                    {infos.map((info, index) => {
                      const label =
                        info.codePoint < 32 || info.codePoint === 127
                          ? (CONTROL_NAMES[info.codePoint] ?? '控制字符')
                          : info.isAscii
                            ? 'ASCII 可打印'
                            : `Unicode U+${info.codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
                      const shown =
                        info.char === '\n'
                          ? '\\n'
                          : info.char === '\t'
                            ? '\\t'
                            : info.char === '\r'
                              ? '\\r'
                              : info.char;
                      return (
                        <tr key={`${info.codePoint}-${index}`} className="border-b border-border last:border-0">
                          <td className="px-2 py-1.5 font-mono text-foreground">{shown}</td>
                          <td className="px-2 py-1.5 font-mono text-foreground">{info.codePoint}</td>
                          <td className="px-2 py-1.5 font-mono text-foreground">
                            0x{info.codePoint.toString(16).toUpperCase().padStart(2, '0')}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-foreground">
                            {info.codePoint.toString(2).padStart(8, '0')}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">{label}</td>
                          <td className="px-2 py-1.5 text-right">
                            <CopyButton text={shown} label="复制" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              输入文本后逐字符显示编码信息
            </div>
          )}
        </TabsContent>

        <TabsContent value="table">
          <div className="overflow-auto rounded-md border scrollbar-thin">
            <table className="w-full border-collapse text-center text-xs font-mono">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                  <th className="px-1 py-1.5 font-medium">Hex</th>
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((col) => (
                    <th key={col} className="px-1 py-1.5 font-medium">
                      _{col.toString(16)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
                  <tr key={row} className="border-b border-border last:border-0">
                    <td className="bg-muted/50 px-1 py-1 font-medium text-muted-foreground">
                      {row.toString(16)}_
                    </td>
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((col) => {
                      const code = row * 16 + col;
                      return (
                        <td key={col} className="px-1 py-1 text-foreground" title={CONTROL_NAMES[code] ?? undefined}>
                          <span className="font-medium">{displayChar(code)}</span>
                          <span className="ml-0.5 text-[10px] text-muted-foreground">{code}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            控制字符以「·」显示，空格显示为「␣」；悬停可查看控制字符名称。
          </p>
        </TabsContent>
      </Tabs>
    </CommandShell>
  );
}

export default AsciiTable;
