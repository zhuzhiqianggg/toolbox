#!/usr/bin/env node
/**
 * 工具注册项静态自检（V24）。
 *
 * 它回答一个问题：**「新增工具时容易漏掉的东西，有没有被机器看着？」**
 *
 * 人工加一个工具要动 3~4 个地方，历史上有两件事反复出错：
 *   1. 图标忘了在 `src/lib/icons.ts` 登记 → 静默回退成扳手，肉眼看不出是 bug；
 *   2. 组件文件名与 `load` 对不上 → 点开工具白屏（运行时才发现）。
 * V24 又加了第三件：`category` 没填 → 新工具在首页分组里根本没有位置，等于被埋掉。
 *
 * 所以这里做的全部是**静态**检查（不启浏览器、不打包，秒级返回）：
 *   必过项（FAIL 会 exit 1）：category 合法 / 图标已登记 / 组件文件存在 / id 唯一且 kebab-case
 *                            / 名称与描述长度合理 / 关键词不少于 5 个
 *   提示项（WARN 不拦）：未接示例条、未接状态持久化
 *
 * 用法：
 *   node scripts/audit/tool-audit.mjs
 *   node scripts/audit/tool-audit.mjs --strict    # 把 WARN 也当失败（CI 用）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const strict = process.argv.includes('--strict');

const COMMANDS_FILE = join(ROOT, 'src/modules/toolbox/commands/index.ts');
const ICONS_FILE = join(ROOT, 'src/lib/icons.ts');
const TYPES_FILE = join(ROOT, 'src/core/types.ts');
const CATEGORIES_FILE = join(ROOT, 'src/core/toolCategories.ts');
const COMMANDS_DIR = join(ROOT, 'src/modules/toolbox/commands');

let pass = 0;
let fail = 0;
const warns = [];

function ok(message) {
  pass += 1;
  console.log(`  PASS  ${message}`);
}
function bad(message) {
  fail += 1;
  console.log(`  FAIL  ${message}`);
}
function warn(message) {
  warns.push(message);
  console.log(`  WARN  ${message}`);
}
function check(condition, message, detail) {
  if (condition) ok(message);
  else bad(detail ? `${message} —— ${detail}` : message);
}

/** 读取 lucide 图标登记表里已登记的名字。 */
function readRegisteredIcons() {
  const src = readFileSync(ICONS_FILE, 'utf8');
  // `\r?\n`：Windows 检出（core.autocrlf=true）下 working copy 是 CRLF，纯 `\n` 会整表读空
  const block = src.match(/export const ICONS: Record<string, LucideIcon> = \{([\s\S]*?)\r?\n\};/);
  if (!block) return new Set();
  return new Set(
    block[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Za-z0-9_]+),\s*$/))
      .filter(Boolean)
      .map((match) => match[1]),
  );
}

/** 读取 `ToolCategory` 联合类型的成员。 */
function readCategoryUnion() {
  const src = readFileSync(TYPES_FILE, 'utf8');
  // `\s*` 是 V45 补的健壮性：多行写法 `export type ToolCategory =\n  | 'text'` 也要能解析
  // （此前要求等号后必须紧跟空格，一旦被格式化成换行就整表读空，33 条校验集体误报）。
  const match = src.match(/export type ToolCategory\s*=\s*([^;]+);/);
  if (!match) return [];
  return [...match[1].matchAll(/'([a-z]+)'/g)].map((item) => item[1]);
}

/** 读取分类元数据表的 id 与顺序。 */
function readCategoryMetas() {
  const src = readFileSync(CATEGORIES_FILE, 'utf8');
  return [...src.matchAll(/\{\s*\r?\n\s*id: '([a-z]+)',\r?\n\s*name: '([^']*)',/g)].map((match) => ({
    id: match[1],
    name: match[2],
  }));
}

/**
 * 解析工具注册清单。
 * 只做文本解析：清单文件里有 `import type` 与动态 import 的 .tsx，
 * Node 原生类型剥离吃不下 .tsx，也不该为了自检去引入打包步骤（见 PROJECT_STATUS §3 约束 15）。
 */
function readCommands() {
  const src = readFileSync(COMMANDS_FILE, 'utf8');
  const pattern =
    /\{\r?\n\s*id: '([^']+)',([\s\S]*?)load: \(\) => import\('\.\/([^']+)'\),\r?\n\s*\},/g;
  const out = [];
  for (const match of src.matchAll(pattern)) {
    const body = match[2];
    const pick = (key) => {
      const found = body.match(new RegExp(`${key}: '([^']*)'`));
      return found ? found[1] : undefined;
    };
    const listOf = (key) => {
      const found = body.match(new RegExp(`${key}: \\[([\\s\\S]*?)\\]`));
      if (!found) return [];
      return [...found[1].matchAll(/'([^']*)'/g)].map((item) => item[1]);
    };
    out.push({
      id: match[1],
      name: pick('name'),
      description: pick('description'),
      icon: pick('icon'),
      category: pick('category'),
      keywords: listOf('keywords'),
      aliases: listOf('aliases'),
      component: match[3],
    });
  }
  return out;
}

function main() {
  console.log('===== 工具注册项自检 =====\n');

  const icons = readRegisteredIcons();
  const unionIds = readCategoryUnion();
  const metas = readCategoryMetas();
  const commands = readCommands();

  console.log(`-- 分类定义一致性（类型 ${unionIds.length} / 元数据 ${metas.length}）`);
  check(metas.length > 0, '分类元数据表非空');
  for (const id of unionIds) {
    check(
      metas.some((meta) => meta.id === id),
      `类型成员 "${id}" 有对应元数据`,
      'core/toolCategories.ts 缺这条',
    );
  }
  for (const meta of metas) {
    check(
      unionIds.includes(meta.id),
      `元数据 "${meta.id}" 已登记进 ToolCategory 联合类型`,
      'core/types.ts 缺这个成员',
    );
  }

  console.log(`\n-- 工具清单（解析到 ${commands.length} 个）`);
  check(commands.length > 0, '解析到工具条目', '解析失败：清单结构可能与本脚本的正则不匹配');

  const seen = new Set();
  const usedCategories = new Set();

  for (const command of commands) {
    const tag = `[${command.id}]`;

    if (seen.has(command.id)) bad(`${tag} id 重复`);
    else {
      seen.add(command.id);
      ok(`${tag} id 唯一`);
    }
    check(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(command.id), `${tag} id 是 kebab-case`, command.id);

    // 18 字是「卡片两行放得下 + 命令面板一行不截断」的实测上限
    check(
      !!command.name && command.name.length > 0 && command.name.length <= 18,
      `${tag} 名称非空且不超过 18 字`,
      `当前 "${command.name ?? ''}"（${command.name?.length ?? 0} 字）`,
    );
    check(
      !!command.description && command.description.length > 0 && command.description.length <= 60,
      `${tag} 描述非空且不超过 60 字`,
      `当前 ${command.description?.length ?? 0} 字`,
    );

    // 图标漏登记是历史上最常犯又最难发现的错（静默变扳手）
    check(
      !!command.icon && icons.has(command.icon),
      `${tag} 图标 "${command.icon ?? '未填'}" 已在 icons.ts 登记`,
      '在 ICONS 里补上对应 lucide 导出',
    );

    // V24：没分类 = 首页分组里没有它的位置 = 新工具被埋掉
    check(
      !!command.category && unionIds.includes(command.category),
      `${tag} 已填合法分类`,
      `当前 "${command.category ?? '未填'}"，可选：${unionIds.join(' / ')}`,
    );
    if (command.category) usedCategories.add(command.category);

    check(
      command.keywords.length >= 5,
      `${tag} 关键词不少于 5 个（保证搜得到）`,
      `当前 ${command.keywords.length} 个`,
    );
    check(command.aliases.length >= 1, `${tag} 至少有 1 个别名`, 'aliases 为空');

    // 组件文件不存在 = 点开白屏，运行时才发现就晚了
    const componentPath = join(COMMANDS_DIR, `${command.component}.tsx`);
    check(existsSync(componentPath), `${tag} 组件文件存在：${command.component}.tsx`, '路径对不上');

    if (existsSync(componentPath)) {
      const code = readFileSync(componentPath, 'utf8');
      const usesShell = /from '@\/components\/CommandShell'|CommandShell/.test(code);
      check(usesShell, `${tag} 使用了统一外壳 CommandShell`, '标题栏/复制/收藏会缺');

      // 豁免标记：示例 / 持久化另有原生实现（如正则库、示例 token 生成），
      // 或本工具压根没有可填的输入（图片工具）。标记写法见 TOOL-AUTHORING.md。
      const exempt = (kind) => new RegExp(`tool-audit-ignore:\\s*${kind}`).test(code);

      if (/samples\s*[:=]/.test(code) || exempt('samples')) {
        ok(`${tag} 已接示例条`);
      } else {
        warn(`${tag} 未接示例条（samples）—— 新工具默认应配 3-5 条`);
      }

      if (/useToolState|usePersistedState/.test(code) || exempt('persist')) {
        ok(`${tag} 已接状态持久化`);
      } else {
        warn(`${tag} 未接状态持久化 —— 切走再回来输入会丢`);
      }
    }
  }

  console.log('\n-- 分类覆盖');
  for (const meta of metas) {
    check(usedCategories.has(meta.id), `分类 "${meta.name}" 至少有一个工具`, '空分类会从首页页签消失');
  }

  // 模块图标同样走 resolveIcon，漏登记一样会静默变扳手（侧栏上一个扳手非常显眼）
  console.log('\n-- 模块图标登记');
  const moduleDir = join(ROOT, 'src/modules');
  const moduleFiles = readdirSync(moduleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(moduleDir, entry.name, 'index.ts'))
    .filter((path) => existsSync(path));

  let moduleChecked = 0;
  for (const file of moduleFiles) {
    const src = readFileSync(file, 'utf8');
    const idMatch = src.match(/^\s*id: '([^']+)',$/m);
    const iconMatch = src.match(/icon: '([^']+)'/);
    if (!idMatch || !iconMatch) continue;
    moduleChecked += 1;
    check(
      icons.has(iconMatch[1]),
      `[模块 ${idMatch[1]}] 图标 "${iconMatch[1]}" 已登记`,
      '在 ICONS 里补上对应 lucide 导出',
    );
  }
  check(moduleChecked > 0, `扫描到 ${moduleChecked} 个模块的图标`);

  console.log('');
  console.log(`PASS ${pass}`);
  console.log(`FAIL ${fail}`);
  console.log(`WARN ${warns.length}`);

  if (warns.length > 0) {
    console.log('\n提示项（不阻塞）：');
    for (const item of warns) console.log(`  - ${item}`);
  }

  const failed = fail > 0 || (strict && warns.length > 0);
  console.log(`\n===== ${failed ? '自检未通过' : '自检通过'} =====`);
  process.exit(failed ? 1 : 0);
}

main();
