import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Table2 } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useCommandShell } from '@/hooks/useCommandShell';
import { toast } from '@/components/ui/toast';
import { locateJsonError } from '@/lib/jsonLocate';
import { downloadTextFile, timestampSuffix } from '@/modules/toolbox/lib/download';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'csv-json';

/** 示例：真实导出的 CSV —— 含引号包裹的字段、字段内逗号、字段内换行 */
const SAMPLE_CSV = [
  'host,ip,role,status,remark',
  'ops-web-01,192.168.10.204,web,running,"对外主入口, 含 Nginx"',
  'ops-db-01,192.168.10.205,db,running,"主库',
  '备库同机部署"',
  'ops-dev-01,192.168.10.206,dev,stopped,',
].join('\n');

/** 示例：字段不齐 / 含嵌套对象的 JSON 数组 —— 检验表头取并集与嵌套序列化 */
const SAMPLE_JSON = JSON.stringify(
  [
    { id: 1, name: 'ops-web-01', role: 'web', tags: ['nginx', 'keepalived'] },
    { id: 2, name: 'ops-db-01', role: 'db' },
    { id: 3, name: 'ops-dev-01', role: 'dev', owner: { name: '朱治强', team: 'ops' } },
  ],
  null,
  2,
);

/** 解析 CSV 文本为二维数组（支持引号包裹、双写转义、字段内逗号/换行）。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV → JSON 文本（首行为表头，自动识别数字）。 */
function csvToJson(text: string): string {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) {
    return '[]';
  }
  const header = rows[0];
  if (!header) {
    return '[]';
  }
  const numRe = /^-?\d+(\.\d+)?$/;
  const objs = rows.slice(1).map((r) => {
    const obj: Record<string, unknown> = {};
    header.forEach((h, idx) => {
      const cell = r[idx] ?? '';
      obj[h] = cell !== '' && numRe.test(cell) ? Number(cell) : cell;
    });
    return obj;
  });
  return JSON.stringify(objs, null, 2);
}

/** 从 `JSON.parse` 失败中定位行列（与 JsonFormatter 同款扫描器） */
function describeJsonError(raw: string, message: string): string {
  const spot = locateJsonError(raw);
  if (spot === null) {
    return message;
  }
  return `第 ${spot.line} 行第 ${spot.column} 列：${spot.reason}\n${spot.snippet}`;
}

/** JSON（对象数组）→ CSV 文本（表头为所有键的并集）。 */
function jsonToCsv(text: string): string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'JSON 解析失败';
    throw new Error(describeJsonError(text, message));
  }
  if (!Array.isArray(data)) {
    throw new Error('JSON 需为对象数组');
  }
  const headers = new Set<string>();
  data.forEach((item) => {
    if (item && typeof item === 'object') {
      Object.keys(item as Record<string, unknown>).forEach((k) => headers.add(k));
    }
  });
  const headerArr = [...headers];
  const escape = (value: unknown): string => {
    const s =
      value === null || value === undefined
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headerArr.join(',')];
  data.forEach((item) => {
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      lines.push(headerArr.map((h) => escape(record[h])).join(','));
    }
  });
  return lines.join('\n');
}

/**
 * CSV ⇄ JSON 互转：两个方向均实时转换，解析错误以提示文案展示（不刷屏 Toast）。
 */
export function CsvJson({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [tab, setTab] = usePersistedState<string>(COMMAND_ID, 'tab', 'csv2json');
  const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput);

  const { output, error } = React.useMemo(() => {
    if (!input.trim()) {
      return { output: '', error: null as string | null };
    }
    try {
      const text = tab === 'csv2json' ? csvToJson(input) : jsonToCsv(input);
      return { output: text, error: null as string | null };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '转换失败';
      return { output: '', error: message };
    }
  }, [input, tab]);

  const onTabChange = React.useCallback((value: string): void => {
    setTab(value);
  }, []);

  /**
   * 下载结果文件。
   *
   * 旧实现这个按钮只弹一句「已复制结果」——既没下载也没复制，纯误导。
   * 现在真的落一个文件：CSV 方向导出 `.json`，JSON 方向导出 `.csv`，
   * 方便直接拖进编辑器或喂给下一个工具。
   */
  const handleDownload = React.useCallback((): void => {
    if (!output) {
      toast.error('暂无可导出的结果');
      return;
    }
    const ext = tab === 'csv2json' ? 'json' : 'csv';
    const mime = ext === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8';
    const ok = downloadTextFile(`toolbox-csvjson-${timestampSuffix()}.${ext}`, output, mime);
    if (ok) {
      toast.success(`已导出 .${ext} 文件`);
    } else {
      toast.error('导出失败，可改用标题栏的复制按钮');
    }
  }, [output, tab]);

  return (
    <CommandShell
      title="CSV ⇄ JSON"
      onPaste={(t) => setInput(t)}
      description="CSV 与 JSON 双向转换"
      icon={<Table2 className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      fill
      copyText={output}
      shortcutHint="切换上方标签选择转换方向；结果可复制或导出为文件"
      samples={
        tab === 'csv2json'
          ? [
              {
                label: '运维主机清单',
                description: '含引号包裹字段、字段内逗号与换行的 CSV —— 最容易把简易解析器搞崩的场景',
                apply: () => setInput(SAMPLE_CSV),
              },
              {
                label: '最小示例',
                description: '两行 CSV，看数字如何被自动识别为 number',
                apply: () => setInput('name,age,score\nToolbox,3,99.5\n顺手,1,88'),
              },
              {
                label: '带空行与空单元格',
                description: '空行被跳过、空单元格保留为空串，检验容错',
                apply: () => setInput('a,b,c\n1,,3\n\n4,5,'),
              },
            ]
          : [
              {
                label: '字段不齐的 JSON',
                description: '对象字段不一致 + 嵌套数组/对象 —— 表头取并集，嵌套字段整体序列化',
                apply: () => setInput(SAMPLE_JSON),
              },
              {
                label: '最小示例',
                description: '两个同构对象，最标准的 JSON → CSV',
                apply: () => setInput('[{"name":"Toolbox","age":3},{"name":"顺手","age":1}]'),
              },
              {
                label: '含特殊字符',
                description: '值里带逗号与引号，检验 CSV 转义（双写引号 + 整体包裹）',
                apply: () => setInput('[{"remark":"主入口, 含 \"Nginx\"","ok":true}]'),
              },
            ]
      }
    >
      <Tabs
        value={tab}
        onValueChange={onTabChange}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="shrink-0">
          <TabsTrigger value="csv2json">CSV → JSON</TabsTrigger>
          <TabsTrigger value="json2csv">JSON → CSV</TabsTrigger>
        </TabsList>
        {/* 撑满模式（与 JsonFormatter 同款布局）：长 CSV / 长 JSON 随窗口伸缩滚动 */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="flex min-h-0 min-w-0 flex-col gap-2">
            <label className="text-sm font-medium text-foreground" htmlFor="csvjson-input">
              {tab === 'csv2json' ? 'CSV 输入' : 'JSON 输入（对象数组）'}
            </label>
            <textarea
              id="csvjson-input"
              rows={12}
              spellCheck={false}
              className="w-full min-h-[200px] flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={input}
              placeholder={tab === 'csv2json' ? 'name,age\nToolbox,3' : '[{"name":"Toolbox","age":3}]'}
              onChange={(event) => setInput(event.target.value)}
            />
            {error ? (
              <div
                role="alert"
                className="scrollbar-thin max-h-[120px] overflow-auto whitespace-pre-wrap rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 font-mono text-xs text-destructive"
              >
                {error}
              </div>
            ) : null}
          </div>
          <div className="flex min-h-0 min-w-0 flex-col gap-2">
            <ResultBox
              title="转换结果"
              value={output}
              emptyHint={error ? '转换失败' : '输入后自动转换'}
              mono
              fill
            />
            {output ? (
              <Button variant="ghost" size="sm" className="self-start" onClick={handleDownload}>
                导出为 .{tab === 'csv2json' ? 'json' : 'csv'} 文件
              </Button>
            ) : null}
          </div>
        </div>
      </Tabs>
    </CommandShell>
  );
}

export default CsvJson;
