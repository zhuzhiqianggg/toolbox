#!/usr/bin/env node
/**
 * 新工具脚手架（V24）：一条命令生成「组件 + 注册项」，把加工具的改动面压到最小。
 *
 * 背景：手工加一个工具要动 4 个地方，其中两步最容易漏 ——
 *   ① 图标没在 `src/lib/icons.ts` 登记（**静默变扳手**，肉眼几乎看不出）；
 *   ② `category` 没填（首页分组里没有它的位置，新工具等于被埋掉）。
 * 本脚本不只生成文件，还会把这两步**印成待办清单**逼你完成，
 * 并且 `scripts/audit/tool-audit.mjs` 会在提交前再兜一次底。
 *
 * 用法：
 *   node scripts/new-tool.mjs --id=my-tool --name="我的工具" --category=text \
 *        --icon=Wand2 --desc="一句话说明这个工具做什么"
 *
 * 参数：
 *   --id        必填，kebab-case，全局唯一
 *   --name      必填，中文名（≤18 字）
 *   --category  必填，取值见 core/types.ts 的 ToolCategory
 *   --icon      选填，lucide 图标名（默认 Wand2）
 *   --desc      选填，工具描述（≤60 字）
 *   --keywords  选填，逗号分隔的关键词（默认按 name 生成几条）
 *   --dry       只打印将要写入的内容，不改文件
 *
 * 生成后请按脚本末尾的清单完成「图标登记 + 关键词补全 + 示例条」。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const COMMANDS_DIR = join(ROOT, 'src/modules/toolbox/commands');
const INDEX_FILE = join(COMMANDS_DIR, 'index.ts');
const ICONS_FILE = join(ROOT, 'src/lib/icons.ts');

const VALID_CATEGORIES = ['text', 'data', 'encode', 'convert', 'generate', 'dev'];

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const [key, ...rest] = arg.slice(2).split('=');
    out[key] = rest.join('=');
  }
  return out;
}

function toPascal(id) {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

const args = parseArgs(process.argv);
// parseArgs 会把 `--dry` 存成 args.dry（无值时为空串），故判 key 而不是 '--dry'
const dry = 'dry' in args;

if (!args.id || !args.name || !args.category) {
  console.error('缺少必填参数。示例：');
  console.error('  node scripts/new-tool.mjs --id=my-tool --name="我的工具" --category=text');
  process.exit(2);
}

const id = args.id;
const name = args.name;
const category = args.category;
const icon = args.icon || 'Wand2';
const desc = args.desc || `${name}（待补充描述）`;
const Component = toPascal(id);

if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
  console.error(`id "${id}" 不是 kebab-case（只允许小写字母、数字与连字符）`);
  process.exit(2);
}
if (!VALID_CATEGORIES.includes(category)) {
  console.error(`category "${category}" 非法，可选：${VALID_CATEGORIES.join(' / ')}`);
  process.exit(2);
}
if (name.length > 18) {
  console.error(`名称 "${name}" 超过 18 字（${name.length}），卡片与命令面板会截断`);
  process.exit(2);
}

const componentPath = join(COMMANDS_DIR, `${Component}.tsx`);
if (existsSync(componentPath)) {
  console.error(`组件已存在：${componentPath}`);
  process.exit(2);
}

const indexSrc = readFileSync(INDEX_FILE, 'utf8');
if (indexSrc.includes(`id: '${id}',`)) {
  console.error(`注册清单里已存在 id "${id}"`);
  process.exit(2);
}

// 关键词不足 5 个时用中性词补齐（保证新工具一出生就能过自检），
// 但脚本末尾会提示补全 —— 占位词搜得到工具，却搜不到「用户心里那个词」。
const PADDING = ['工具', 'tool', 'util', 'helper', '在线'];
const keywords = (args.keywords || `${name},${id}`)
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
for (const word of PADDING) {
  if (keywords.length >= 5) break;
  if (!keywords.includes(word)) keywords.push(word);
}

const keywordLines = keywords.map((item) => `      '${item}',`).join('\n');

// 注意：本项目**没有** Textarea 组件（ui/input.tsx 只导出 Input），多行输入一律用原生
// <textarea> + 下面这套 className（与各工具保持一致，改样式请改所有工具而不是只改这里）。
const componentCode = `import * as React from 'react';
import { ${icon} } from 'lucide-react';
import { useCommandShell } from '@/hooks/useCommandShell';
import { CommandShell } from '@/components/CommandShell';
import { usePersistedState } from '@/hooks/usePersistedState';

const COMMAND_ID = '${id}';

/** ${name} —— ${desc} */
export function ${Component}(): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  // 状态持久化：切走再回来输入还在（V24 起新工具默认都要接）
  // 少数几个字段 → usePersistedState（签名与 useState 一致，含函数式更新）；
  // 状态一多、且天然属于同一份对象 → 换成 useToolState(COMMAND_ID, initialObject)
  const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', '');

  return (
    <CommandShell
      title="${name}"
      description="${desc}"
      icon={<${icon} className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={input}
      shortcutHint="Esc 返回"
      // TODO: 补 3-5 条示例条（samples）—— 每条自带 apply 闭包，示例数据要贴近真实用法；
      //       示例里出现的哈希 / Base64 / 时间戳必须真算过再写，别手编
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <textarea
          id="${id}-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="在此输入…"
          spellCheck={false}
          className="min-h-[180px] w-full flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 font-mono text-[13px] shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
    </CommandShell>
  );
}

export default ${Component};
`;

const registration = `  {
    id: '${id}',
    category: '${category}',
    moduleId: 'toolbox',
    name: '${name}',
    description: '${desc}',
    icon: '${icon}',
    aliases: ['${id}'],
    keywords: [
${keywordLines}
    ],
    layout: 'split',
    tier: 'free',
    load: () => import('./${Component}'),
  },
];`;

const nextIndex = indexSrc.replace(/\n\];\s*$/, `\n${registration}\n`);
if (nextIndex === indexSrc) {
  console.error('注册清单结尾不是预期的 `\\n];`，请手工追加（不敢自动改结构不明的文件）');
  process.exit(2);
}

const iconRegistered = readFileSync(ICONS_FILE, 'utf8').includes(`\n  ${icon},`);

if (dry) {
  console.log('--- 将创建组件 ---');
  console.log(componentPath);
  console.log(componentCode);
  console.log('--- 将追加注册项 ---');
  console.log(registration);
  process.exit(0);
}

writeFileSync(componentPath, componentCode, 'utf8');
writeFileSync(INDEX_FILE, nextIndex, 'utf8');

console.log(`已创建组件：src/modules/toolbox/commands/${Component}.tsx`);
console.log(`已追加注册项：id=${id} category=${category}`);
console.log('');
console.log('接下来 **必须** 完成（漏了会被 tool-audit 拦下）：');
console.log(
  iconRegistered
    ? `  1. 图标 ${icon} 已登记 ✅`
    : `  1. 在 src/lib/icons.ts 的 ICONS 里登记 ${icon}（当前未登记，会静默变扳手）`,
);
console.log(`  2. 补全 keywords（当前 ${keywords.length} 个，要求 ≥5，含拼音首字母更好搜）`);
console.log('  3. 给 CommandShell 补 3-5 条 samples 示例条');
console.log('');
console.log('自检：node scripts/audit/tool-audit.mjs');
