import Fuse from 'fuse.js';
import { pinyin } from 'pinyin-pro';
import type { CommandMeta } from '@/core/types';

/**
 * 命令搜索：中文分词（拼音首字母）+ 模糊匹配。
 *
 * - **拼音首字母**：`时间戳` → `sjc`，`剪贴板` → `jtb`（pinyin-pro）；
 * - **模糊兜底**：fuse.js（阈值 0.4），支持 `jsn`→`json`、错拼容忍；
 * - 输入 ≤3 字符即可命中（直接子串 / 首字母前缀优先）。
 *
 * 设计为**纯函数**（不依赖注册表），便于单测与他人复用。
 */

interface IndexedCommand {
  command: CommandMeta;
  /** 归一化后的可搜索文本（id / 名称 / 别名 / 关键词 / 描述） */
  text: string;
  /** 拼音首字母串 */
  initials: string;
}

/** 按命令数组引用缓存索引（registry.commands() 返回稳定引用） */
const indexCache = new WeakMap<readonly CommandMeta[], IndexedCommand[]>();

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** 取文本的拼音首字母（非中文原样保留），如 `时间戳`→`sjc` */
export function toPinyinInitials(text: string): string {
  try {
    return pinyin(text, { pattern: 'first', toneType: 'none', type: 'string' })
      .replace(/\s+/g, '')
      .toLowerCase();
  } catch {
    return '';
  }
}

function buildIndex(commands: readonly CommandMeta[]): IndexedCommand[] {
  const cached = indexCache.get(commands);
  if (cached) {
    return cached;
  }
  const index: IndexedCommand[] = commands.map((command) => {
    const searchSource = [
      command.id,
      command.name,
      ...command.aliases,
      ...command.keywords,
      command.description,
    ].join(' ');
    return {
      command,
      text: normalize(searchSource),
      initials: toPinyinInitials(`${command.name} ${command.keywords.join('')}`),
    };
  });
  indexCache.set(commands, index);
  return index;
}

/** 直接匹配的优先级（越小越靠前） */
function directRank(item: IndexedCommand, query: string): number {
  if (item.command.name.toLowerCase().startsWith(query)) {
    return 0;
  }
  if (item.command.id.startsWith(query)) {
    return 1;
  }
  if (item.initials.startsWith(query)) {
    return 2;
  }
  if (item.text.includes(query)) {
    return 3;
  }
  return 4;
}

/**
 * 在给定命令集合内搜索。
 * @param commands 命令集合（稳定引用以复用索引）
 * @param query 查询串
 * @param limit 返回上限
 */
export function searchCommands(
  commands: readonly CommandMeta[],
  query: string,
  limit = 20,
): CommandMeta[] {
  const q = normalize(query);
  if (q.length === 0) {
    return [];
  }

  const index = buildIndex(commands);

  // 1) 直接命中：名称/首字母前缀、任意子串（≤3 字符也能稳定命中）
  const direct = index
    .filter((item) => directRank(item, q) < 4)
    .sort((a, b) => directRank(a, q) - directRank(b, q));

  // 2) 模糊兜底
  const fuse = new Fuse(index, {
    keys: ['text', 'initials'],
    threshold: 0.4,
    ignoreLocation: true,
  });
  const fuzzy = fuse.search(q).map((result) => result.item);

  const merged: CommandMeta[] = [];
  const seen = new Set<string>();
  for (const item of [...direct, ...fuzzy]) {
    const { id } = item.command;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push(item.command);
    if (merged.length >= limit) {
      break;
    }
  }
  return merged;
}
