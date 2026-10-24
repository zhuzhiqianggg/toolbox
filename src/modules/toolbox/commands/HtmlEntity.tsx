import * as React from 'react';
import { Code as CodeIcon } from 'lucide-react';
import { CommandShell, type SampleEntry } from '@/components/CommandShell';
import { ResultBox } from '@/components/ResultBox';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'html-entity';

/**
 * HTML 实体编解码。
 *
 * 工具定位：写模板 / 富文本转义 / 排查实体乱码时的双向速查器。
 *
 * - **编码**：`& < > " '` 五个必转字符；可选把非 ASCII（中文、重音符号、emoji）
 *   转成十六进制数字实体 —— 按 Unicode 码点处理（`codePointAt` + 码点迭代），
 *   代理对（如 👍）整体转成一个 `&#x1F44D;`，不会劈成两个无效的半字符；
 * - **解码**：十进制 `&#123;` / 十六进制 `&#x1F600;` 数字实体全支持，
 *   另带约 50 个常用命名实体（排版 / 货币 / 箭头 / 希腊字母），未识别的命名实体原样保留；
 * - 左右两栏各自实时转换互不影响（选左右两栏而非方向切换：编码与解码经常并行使用，
 *   切换方向反而多一步操作）。
 */

/** 工具持久化状态 */
interface HtmlEntityState {
  /** 编码侧输入（原文） */
  encodeInput: string;
  /** 解码侧输入（实体文本） */
  decodeInput: string;
  /** 编码时是否把非 ASCII 字符转成十六进制数字实体 */
  escapeNonAscii: boolean;
}

/** 五个必转字符。`&` 必须最先替换，否则会把后续生成的实体再次转义。 */
function escapeBasic(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 非 ASCII → 十六进制数字实体。
 * `for...of` 按 Unicode 码点迭代（自动合并代理对）+ `codePointAt` 取码点，
 * emoji 等增补平面字符也能正确转成单个实体。
 */
function escapeNonAsciiChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    out += cp !== undefined && cp > 0x7f ? `&#x${cp.toString(16).toUpperCase()};` : ch;
  }
  return out;
}

/** 编码：五个必转字符 + 可选的非 ASCII 数字实体转义 */
function encodeEntities(input: string, nonAscii: boolean): string {
  const basic = escapeBasic(input);
  return nonAscii ? escapeNonAsciiChars(basic) : basic;
}

/** 常用命名实体表：HTML5 数千实体中的高频子集（排版 / 货币 / 箭头 / 希腊字母）。 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  laquo: '\u00ab',
  raquo: '\u00bb',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  times: '\u00d7',
  divide: '\u00f7',
  plusmn: '\u00b1',
  sup2: '\u00b2',
  sup3: '\u00b3',
  frac12: '\u00bd',
  deg: '\u00b0',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  sect: '\u00a7',
  para: '\u00b6',
  middot: '\u00b7',
  bull: '\u2022',
  dagger: '\u2020',
  Dagger: '\u2021',
  permil: '\u2030',
  larr: '\u2190',
  uarr: '\u2191',
  rarr: '\u2192',
  darr: '\u2193',
  harr: '\u2194',
  alpha: '\u03b1',
  beta: '\u03b2',
  gamma: '\u03b3',
  delta: '\u03b4',
  theta: '\u03b8',
  lambda: '\u03bb',
  mu: '\u03bc',
  pi: '\u03c0',
  sigma: '\u03c3',
  omega: '\u03c9',
};

/**
 * 实体整体匹配：十六进制数字 / 十进制数字 / 字母开头的命名实体。
 * 三种形式一次遍历处理，其余 `&` 与未识别实体由回调原样返回。
 */
const ENTITY_PATTERN = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** Unicode 码点上限（超出即无法构成合法字符） */
const MAX_CODE_POINT = 0x10ffff;

/** 解码：数字实体 + 常用命名实体；未识别的一律原样保留，不破坏正文 */
function decodeEntities(input: string): string {
  return input.replace(ENTITY_PATTERN, (raw: string, body: string): string => {
    if (body.startsWith('#')) {
      const isHex = body.length > 1 && (body[1] === 'x' || body[1] === 'X');
      const num = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // 超范围 / 非法数字（如 &#xFFFFFFFF;）无法构成字符，按原文保留
      if (!Number.isInteger(num) || num < 0 || num > MAX_CODE_POINT) {
        return raw;
      }
      return String.fromCodePoint(num);
    }
    const mapped: string | undefined = NAMED_ENTITIES[body];
    return mapped ?? raw;
  });
}

/** HtmlEntity 工具组件 */
export function HtmlEntity(_props: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<HtmlEntityState>(COMMAND_ID, {
    encodeInput: '',
    decodeInput: '',
    escapeNonAscii: false,
  });

  const encodeResult = React.useMemo(
    () => encodeEntities(state.encodeInput, state.escapeNonAscii),
    [state.encodeInput, state.escapeNonAscii],
  );
  const decodeResult = React.useMemo(() => decodeEntities(state.decodeInput), [state.decodeInput]);

  // 标题栏一键复制：编码结果优先（编码是更常用的出口），为空时退回复制解码结果
  const copyText = encodeResult.length > 0 ? encodeResult : decodeResult;

  const samples: readonly SampleEntry[] = [
    {
      label: '编码标签',
      description: '五个必转字符 + 中文原样保留',
      apply: () => {
        patch({ encodeInput: '<div class="a">中文 & more</div>' });
      },
    },
    {
      label: '解码实体',
      description: '命名实体与正文混排，未识别的会原样保留',
      apply: () => {
        patch({ decodeInput: 'Tom &amp; Jerry &lt;tag&gt; &copy; 2026' });
      },
    },
    {
      label: '非 ASCII 转数字',
      description: '开启开关后 café / «» / ¥ 转成 &#x...; 形式',
      apply: () => {
        patch({ escapeNonAscii: true, encodeInput: 'café — «引用» — ¥100' });
      },
    },
    {
      label: 'Emoji 代理对',
      description: '按码点处理，👍 整体转成一个 &#x1F44D; 而非两个半字符',
      apply: () => {
        patch({ escapeNonAscii: true, encodeInput: '👍 star' });
      },
    },
  ];

  return (
    <CommandShell
      title="HTML 实体编解码"
      onPaste={(t) => patch({ encodeInput: t })}
      description="命名 / 数字实体双向转换，非 ASCII 可转数字实体"
      icon={<CodeIcon className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={copyText}
      shortcutHint="输入即实时转换 · 标题栏「粘贴」填入编码栏（Esc 返回）"
      samples={samples}
    >
      {/* 左右两栏并排（窄屏回退单列），与 Base64 编解码同一套布局节奏 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ===== 左栏：编码 ===== */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm font-medium text-foreground" htmlFor="html-entity-encode">
              原文 → 实体
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>非 ASCII 转数字实体</span>
              <Switch
                checked={state.escapeNonAscii}
                onCheckedChange={(checked) => patch({ escapeNonAscii: checked === true })}
              />
            </label>
          </div>
          <textarea
            id="html-entity-encode"
            autoFocus
            value={state.encodeInput}
            onChange={(event) => patch({ encodeInput: event.target.value })}
            placeholder={'输入要转义的文本，如 <div class="a">中文</div>'}
            className={
              'min-h-[160px] w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-sm ' +
              'text-foreground placeholder:text-muted-foreground ' +
              'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
            }
          />
          <ResultBox title="编码结果" value={encodeResult} emptyHint="在上方输入内容后自动编码" />
          <p className="text-[11px] text-muted-foreground">
            {`必转 & < > " ' 五个字符；开启开关后，中文 / 重音符号 / emoji 按 Unicode 码点转成 &#x4E2D; 形式。`}
          </p>
        </div>

        {/* ===== 右栏：解码 ===== */}
        <div className="flex min-w-0 flex-col gap-3">
          <label className="text-sm font-medium text-foreground" htmlFor="html-entity-decode">
            实体 → 原文
          </label>
          <textarea
            id="html-entity-decode"
            value={state.decodeInput}
            onChange={(event) => patch({ decodeInput: event.target.value })}
            placeholder={'粘贴实体文本，如 Tom &amp; Jerry &lt;tag&gt; &copy; 2026'}
            className={
              'min-h-[160px] w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-sm ' +
              'text-foreground placeholder:text-muted-foreground ' +
              'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
            }
          />
          <ResultBox title="解码结果" value={decodeResult} emptyHint="在上方粘贴实体后自动解码" />
          <p className="text-[11px] text-muted-foreground">
            {`支持 &#123;、&#x1F600; 等十进制 / 十六进制数字实体，以及 amp、nbsp、copy、mdash 等常用命名实体；未识别的命名实体原样保留。`}
          </p>
        </div>
      </div>
    </CommandShell>
  );
}

export default HtmlEntity;
