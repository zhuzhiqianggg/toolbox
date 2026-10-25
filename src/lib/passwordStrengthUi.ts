/**
 * 密码强度的界面配色（0–4 档 → 进度条 / 文字 class）。
 *
 * 评分逻辑在 `@/lib/passwordGen`（纯逻辑不掺样式）；这里集中管理配色，
 * 密码生成器与密码库共用同一套档位色，保证两处观感一致。
 */

/** 强度分档 → 进度条背景色 class */
export const STRENGTH_COLORS: readonly string[] = [
  'bg-red-500',
  'bg-orange-500',
  'bg-amber-500',
  'bg-brand',
  'bg-emerald-600',
];

/** 强度分档 → 文字色 class */
export const STRENGTH_TEXT: readonly string[] = [
  'text-red-600',
  'text-orange-600',
  'text-amber-600',
  'text-brand',
  'text-emerald-600',
];

/** 强度评分 → 进度条配色（越界回落到最弱档） */
export function strengthColor(score: number): string {
  return STRENGTH_COLORS[score] ?? 'bg-red-500';
}

/** 强度评分 → 文字配色（越界回落到最弱档） */
export function strengthText(score: number): string {
  return STRENGTH_TEXT[score] ?? 'text-red-600';
}
