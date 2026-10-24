import * as React from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { FileCode } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Button } from '@/components/ui/button';
import { useCommandShell } from '@/hooks/useCommandShell';
import { locateJsonError } from '@/lib/jsonLocate';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'json-to-ts';

/** 字符串 → PascalCase（仅保留字母数字与空格）。 */
function pascalCase(input: string): string {
  const cleaned = input.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!cleaned) {
    return '';
  }
  return cleaned
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** 是否为合法 JS/TS 标识符。 */
function isValidKey(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

interface BuildState {
  interfaces: string[];
  used: Set<string>;
}

/** 取不重复的接口名（重名追加序号）。 */
function uniqueName(base: string, state: BuildState): string {
  const candidate = pascalCase(base) || 'Root';
  if (!state.used.has(candidate)) {
    state.used.add(candidate);
    return candidate;
  }
  let i = 2;
  while (state.used.has(`${candidate}${i}`)) {
    i += 1;
  }
  const name = `${candidate}${i}`;
  state.used.add(name);
  return name;
}

function primitiveType(value: unknown): string {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value === null) return 'null';
  return 'unknown';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOfValue(value: unknown, keyHint: string, state: BuildState): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'unknown[]';
    }
    const first = value[0];
    if (isPlainObject(first)) {
      const name = uniqueName(`${keyHint}Item`, state);
      buildInterface(first, name, state);
      return `${name}[]`;
    }
    return `${primitiveType(first)}[]`;
  }
  if (isPlainObject(value)) {
    const name = uniqueName(keyHint, state);
    buildInterface(value, name, state);
    return name;
  }
  return primitiveType(value);
}

function buildInterface(obj: Record<string, unknown>, name: string, state: BuildState): void {
  const lines: string[] = [`export interface ${name} {`];
  for (const [key, value] of Object.entries(obj)) {
    const fieldType = typeOfValue(value, key, state);
    const finalType = value === null ? `${fieldType} | null` : fieldType;
    const safeKey = isValidKey(key) ? key : `'${key.replace(/'/g, "\\'")}'`;
    lines.push(`  ${safeKey}: ${finalType};`);
  }
  lines.push('}');
  state.interfaces.push(lines.join('\n'));
}

/** 从 `JSON.parse` 失败中定位行列（与 JsonFormatter 同款扫描器） */
function describeError(raw: string, message: string): string {
  const spot = locateJsonError(raw);
  if (spot === null) {
    return message;
  }
  return `第 ${spot.line} 行第 ${spot.column} 列：${spot.reason}\n${spot.snippet}`;
}

/** 解析 JSON 并生成 TypeScript 接口文本。 */
function convert(input: string): { ok: boolean; ts: string; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, ts: '' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'JSON 解析失败';
    return { ok: false, ts: '', error: describeError(trimmed, message) };
  }
  const state: BuildState = { interfaces: [], used: new Set() };
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { ok: true, ts: 'export type Root = unknown[];' };
    }
    const first = parsed[0];
    if (isPlainObject(first)) {
      const name = uniqueName('RootItem', state);
      buildInterface(first, name, state);
      return { ok: true, ts: [...state.interfaces, `export type Root = ${name}[];`].join('\n\n') };
    }
    return { ok: true, ts: `export type Root = ${primitiveType(first)}[];` };
  }
  if (isPlainObject(parsed)) {
    buildInterface(parsed, 'Root', state);
    return { ok: true, ts: state.interfaces.join('\n\n') };
  }
  return { ok: true, ts: `export type Root = ${primitiveType(parsed)};` };
}

/**
 * JSON → TypeScript 接口生成器：根据粘贴的 JSON 样例递归推导接口，
 * 支持嵌套对象、数组与命名捕获，结果可一键复制。
 */
export function JsonToTs({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput);
  const result = React.useMemo(() => convert(input), [input]);

  return (
    <CommandShell
      title="JSON → TypeScript"
      onPaste={(t) => setInput(t)}
      description="粘贴 JSON，生成 TypeScript 接口定义"
      icon={<FileCode className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      fill
      copyText={result.ok ? result.ts : ''}
      shortcutHint="支持嵌套对象与数组；结果可一键复制"
      samples={[
        {
          label: '接口返回体',
          description: '最典型的 API 响应：对象 + 数组 + 嵌套对象，接口名按字段名推导',
          apply: () =>
            setInput(
              JSON.stringify(
                {
                  code: 0,
                  message: 'ok',
                  data: {
                    total: 128,
                    page: 1,
                    list: [
                      { id: 'ops-web-01', ip: '192.168.10.204', role: 'web', online: true },
                      { id: 'ops-db-01', ip: '192.168.10.205', role: 'db', online: false },
                    ],
                  },
                },
                null,
                2,
              ),
            ),
        },
        {
          label: '可空字段',
          description: '值为 null 的字段与其它取值合并成「T | null」联合类型 —— 检验空值推导',
          apply: () =>
            setInput(
              '[{"id":1,"deletedAt":null,"owner":{"name":"a"}},{"id":2,"deletedAt":"2026-09-15","owner":{"name":null}}]',
            ),
        },
        {
          label: '非法标识符键',
          description: '键里带连字符/中文，会被自动加上引号，避免生成出不合法 TS',
          apply: () => setInput('{"user-name":"toolbox","最后登录":"2026-09-15","a b":1}'),
        },
        {
          label: '顶层数组',
          description: 'JSON 本身是数组 —— 元素对象的字段直接提升为 Root 接口',
          apply: () => setInput('[{"id":1,"name":"a"},{"id":2,"name":"b"}]'),
        },
        {
          label: '重名嵌套',
          description: '两处都叫 node 但结构不同 —— 接口名自动追加序号；结构相同的会复用同一个接口',
          apply: () => setInput('{"left":{"node":{"v":1}},"right":{"node":{"v":"s"}}}'),
        },
      ]}
    >
      {/* 撑满模式（与 JsonFormatter 同款布局）：长 JSON / 长接口随窗口伸缩滚动 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-medium text-foreground" htmlFor="json-input">
              JSON
            </label>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setInput('')}
            >
              清空
            </Button>
          </div>
          <textarea
            id="json-input"
            autoFocus
            spellCheck={false}
            className="w-full min-h-[200px] flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={input}
            placeholder={'{\n  "id": 1,\n  "name": "Toolbox",\n  "tags": ["a", "b"]\n}'}
            onChange={(event) => setInput(event.target.value)}
          />
          {input.trim() && !result.ok && result.error ? (
            <div
              role="alert"
              className="scrollbar-thin max-h-[120px] overflow-auto whitespace-pre-wrap rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 font-mono text-xs text-destructive"
            >
              {`语法错误：${result.error}`}
            </div>
          ) : null}
        </div>
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <ResultBox
            title="TypeScript 接口"
            value={result.ok ? result.ts : ''}
            emptyHint={input.trim() ? 'JSON 无效，请修正后重试' : '粘贴 JSON 后自动生成'}
            mono
            fill
          />
        </div>
      </div>
    </CommandShell>
  );
}

export default JsonToTs;
