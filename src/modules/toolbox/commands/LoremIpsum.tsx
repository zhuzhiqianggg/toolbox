import * as React from 'react';
import { Minus, Plus, RefreshCw, TextQuote as TextQuoteIcon } from 'lucide-react';
import { CommandShell, type SampleEntry } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'lorem-ipsum';

/** 数量范围（键盘可直接键入，步进按钮到边界自动禁用） */
const MIN_COUNT = 1;
const MAX_COUNT = 50;

/**
 * Lorem 假文生成器。
 *
 * 工具定位：做排版 / 占位 / 截断测试时随手来一段无意义文本，不依赖外部 API。
 *
 * - **类型**：段落（每段 4-7 句）/ 句子 / 单词三种粒度；
 * - **拉丁假文**：经典 lorem 词库（约 60 词）循环组句，首词大写、句号结尾；
 * - **中文假文**：自建科技 / 日常风格词库连写成句（词组直连符合中文排版，
 *   宽度特性接近真实文本，比英文假文更适合测中文界面）；
 * - 「以 Lorem ipsum 开头」仅对拉丁假文生效（中文假文以它开头没有意义，开关随之禁用）；
 * - **结果不持久化**：假文本没有草稿价值，重开工具按当前设置随机来一份即可，
 *   持久化只存参数（类型 / 数量 / 开关）。
 */

/** 假文类型：段落 / 句子 / 单词 */
type LoremKind = 'paragraph' | 'sentence' | 'word';

/** 工具持久化状态（仅参数，不含结果） */
interface LoremState {
  kind: LoremKind;
  count: number;
  /** 首句固定「Lorem ipsum dolor sit amet」（仅拉丁假文生效） */
  startWithLorem: boolean;
  /** 中文假文 */
  chinese: boolean;
}

/** 类型切换选项 */
const KIND_OPTIONS: ReadonlyArray<{ value: LoremKind; label: string }> = [
  { value: 'paragraph', label: '段落' },
  { value: 'sentence', label: '句子' },
  { value: 'word', label: '单词' },
];

/** 经典 lorem 词库（Ciceno 段落截取，顺序打乱也无妨 —— 本就随机取词） */
const LOREM_WORDS: readonly string[] = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
  'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
  'velit', 'esse', 'cillum', 'eu', 'fugiat', 'nulla', 'pariatur', 'excepteur',
  'sint', 'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui',
  'officia', 'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum',
];

/** 中文假文词库：科技 / 日常风格词组（2-4 字，连写后接近真实中文的词宽节奏） */
const CHINESE_WORDS: readonly string[] = [
  '快速迭代', '产品体验', '界面设计', '交互细节', '性能优化', '代码质量', '团队协作', '需求评审',
  '数据驱动', '效率工具', '稳定性', '自动化测试', '持续集成', '文档沉淀', '复盘总结', '用户反馈',
  '增长策略', '闭环管理', '优先级', '排期规划', '技术方案', '风险评估', '灰度发布', '线上巡检',
  '日志监控', '告警治理', '容量规划', '成本控制', '跨端适配', '暗色模式', '无障碍', '国际化',
  '组件复用', '状态管理', '依赖升级', '构建提速', '包体积', '埋点统计', '转化率', '留存率',
];

/** 随机取一个词（`noUncheckedIndexedAccess` 下索引访问需兜底） */
function pick(list: readonly string[]): string {
  return list[Math.floor(Math.random() * list.length)] ?? list[0] ?? '';
}

/** 拉丁句：6-12 词，首词大写句号结尾；`fixedStart` 时以经典五词开头 */
function buildLatinSentence(fixedStart: boolean): string {
  const parts: string[] = fixedStart ? ['Lorem', 'ipsum', 'dolor', 'sit', 'amet'] : [];
  const extra = 6 + Math.floor(Math.random() * 7);
  for (let i = 0; i < extra; i += 1) {
    parts.push(pick(LOREM_WORDS));
  }
  const sentence = parts.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}

/** 中文句：8-16 个词组连写，句号结尾 */
function buildChineseSentence(): string {
  const count = 8 + Math.floor(Math.random() * 9);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    parts.push(pick(CHINESE_WORDS));
  }
  return `${parts.join('')}。`;
}

/** 按当前参数生成整段假文 */
function buildLorem(state: LoremState): string {
  const { kind, count, startWithLorem, chinese } = state;

  if (kind === 'word') {
    const words: string[] = [];
    for (let i = 0; i < count; i += 1) {
      words.push(chinese ? pick(CHINESE_WORDS) : pick(LOREM_WORDS));
    }
    // 中文词组直连（加空格反而不像中文）；英文以空格分隔
    return words.join(chinese ? '' : ' ');
  }

  if (kind === 'sentence') {
    const sentences: string[] = [];
    for (let i = 0; i < count; i += 1) {
      sentences.push(chinese ? buildChineseSentence() : buildLatinSentence(startWithLorem && i === 0));
    }
    return sentences.join(chinese ? '' : ' ');
  }

  // 段落：每段 4-7 句，段间空一行（Markdown / 富文本可直接粘贴）
  const paragraphs: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const sentenceCount = 4 + Math.floor(Math.random() * 4);
    const sentences: string[] = [];
    for (let j = 0; j < sentenceCount; j += 1) {
      const fixedStart = startWithLorem && !chinese && i === 0 && j === 0;
      sentences.push(chinese ? buildChineseSentence() : buildLatinSentence(fixedStart));
    }
    paragraphs.push(sentences.join(chinese ? '' : ' '));
  }
  return paragraphs.join('\n\n');
}

/** LoremIpsum 工具组件 */
export function LoremIpsum(_props: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<LoremState>(COMMAND_ID, {
    kind: 'paragraph',
    count: 3,
    startWithLorem: false,
    chinese: false,
  });
  // 结果不持久化：假文本无草稿价值，每次打开按当前参数随机生成
  const [output, setOutput] = React.useState('');

  // samples 的 apply 闭包会带 override 调 generate，用 ref 镜像保证读到最新参数
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const generate = React.useCallback((override?: Partial<LoremState>): void => {
    setOutput(buildLorem({ ...stateRef.current, ...override }));
  }, []);

  // 挂载即按当前设置生成一份，避免打开工具一片空白
  React.useEffect(() => {
    generate();
  }, [generate]);

  /** 数量修正：夹到 1-50；清空输入框等非数字场景回退到 1 */
  const changeCount = React.useCallback(
    (next: number): void => {
      const safe = Number.isFinite(next) ? Math.floor(next) : MIN_COUNT;
      patch({ count: Math.min(MAX_COUNT, Math.max(MIN_COUNT, safe)) });
    },
    [patch],
  );

  // Enter 全局触发生成；结果框是只读 textarea，排除掉避免在结果里回车误触
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        generate();
      }
    },
    [generate],
  );

  const samples: readonly SampleEntry[] = [
    {
      label: '3 段落（拉丁）',
      description: '默认场景：经典 lorem 词库循环组句',
      apply: () => {
        patch({ kind: 'paragraph', count: 3, chinese: false });
        generate({ kind: 'paragraph', count: 3, chinese: false });
      },
    },
    {
      label: '1 段落',
      description: '占位排版常用量：一段约 4-7 句',
      apply: () => {
        patch({ kind: 'paragraph', count: 1, chinese: false });
        generate({ kind: 'paragraph', count: 1, chinese: false });
      },
    },
    {
      label: '10 单词',
      description: '测标签 / 标题的截断与换行',
      apply: () => {
        patch({ kind: 'word', count: 10, chinese: false });
        generate({ kind: 'word', count: 10, chinese: false });
      },
    },
    {
      label: '2 段落（中文）',
      description: '科技风格中文假文，词宽接近真实中文排版',
      apply: () => {
        patch({ kind: 'paragraph', count: 2, chinese: true });
        generate({ kind: 'paragraph', count: 2, chinese: true });
      },
    },
  ];

  return (
    <CommandShell
      title="Lorem 假文生成"
      description="段落 / 句子 / 单词占位文本，拉丁与中文假文"
      icon={<TextQuoteIcon className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={output}
      fill
      shortcutHint="Enter 重新生成 · 数量可直接键入 1-50（Esc 返回）"
      samples={samples}
    >
      {/* fill 模式：控件行 shrink-0，结果区 flex-1 撑满随窗口伸缩 */}
      <div className="flex min-h-0 flex-1 flex-col gap-3" onKeyDown={handleKeyDown}>
        {/* 控件行：类型 chips + 数量 stepper + 两个开关 + 生成按钮 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card p-3 shadow-card">
          <div className="flex items-center gap-1.5">
            {KIND_OPTIONS.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={state.kind === option.value ? 'default' : 'ghost'}
                className="h-7 px-2.5 text-xs"
                onClick={() => patch({ kind: option.value })}
              >
                {option.label}
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">数量</span>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              aria-label="减少数量"
              disabled={state.count <= MIN_COUNT}
              onClick={() => changeCount(state.count - 1)}
            >
              <Minus className="h-3.5 w-3.5" />
            </Button>
            <input
              type="number"
              min={MIN_COUNT}
              max={MAX_COUNT}
              value={state.count}
              aria-label="生成数量"
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                if (!Number.isNaN(parsed)) {
                  changeCount(parsed);
                }
              }}
              className="h-7 w-14 rounded-md border border-input bg-background text-center text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              aria-label="增加数量"
              disabled={state.count >= MAX_COUNT}
              onClick={() => changeCount(state.count + 1)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span title={state.chinese ? '仅拉丁假文支持以 Lorem ipsum 开头' : undefined}>
              以 Lorem ipsum 开头
            </span>
            <Switch
              checked={state.startWithLorem}
              disabled={state.chinese}
              onCheckedChange={(checked) => patch({ startWithLorem: checked === true })}
            />
          </label>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>中文假文</span>
            <Switch
              checked={state.chinese}
              onCheckedChange={(checked) => patch({ chinese: checked === true })}
            />
          </label>

          <Button size="sm" className="ml-auto" onClick={() => generate()}>
            <RefreshCw className="h-3.5 w-3.5" />
            生成
          </Button>
        </div>

        {/* 结果区：只读 textarea，flex-1 撑满；复制走标题栏 copyText */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between pb-2">
            <span className="text-sm font-medium text-foreground">生成结果</span>
            <span className="text-xs text-muted-foreground">
              {state.chinese ? `${output.length} 字` : `${output.length} 字符`}
            </span>
          </div>
          <textarea
            readOnly
            value={output}
            placeholder="点击「生成」或按 Enter 生成假文本"
            className={
              'scrollbar-thin min-h-0 w-full flex-1 resize-none rounded-lg border border-input bg-background p-3 text-sm leading-relaxed ' +
              'text-foreground placeholder:text-muted-foreground ' +
              'focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/20'
            }
          />
        </div>
      </div>
    </CommandShell>
  );
}

export default LoremIpsum;
