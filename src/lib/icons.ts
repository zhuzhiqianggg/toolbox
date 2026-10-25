import {
  ArrowLeftRight,
  AtSign,
  Binary,
  BookOpen,
  Braces,
  Calculator,
  CalendarClock,
  CaseSensitive,
  ClipboardList,
  Clock,
  Code,
  Code2,
  Database,
  FileCode,
  FileDiff,
  FileImage,
  Filter,
  Fingerprint,
  FolderOpen,
  HardDrive,
  Hash,
  History,
  Hourglass,
  Info,
  Keyboard,
  KeyRound,
  LayoutGrid,
  LayoutDashboard,
  Link,
  Link2,
  ListFilter,
  Network,
  NotebookPen,
  Package,
  Palette,
  QrCode,
  Regex,
  Ruler,
  Scale,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sigma,
  Sparkles,
  Star,
  StickyNote,
  Table,
  Table2,
  TextCursorInput,
  TextQuote,
  Trash2,
  Type,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';


/**
 * 图标解析（模块 `icon` / 命令 `icon` 为 lucide 具名导出字符串）。
 *
 * 集中登记以避免各组件重复维护映射表；未登记名称回退到 `fallback`（默认 `Wrench`）。
 *
 * 约定（务必遵守）：**新增工具 / 模块若使用新图标，必须在此 `ICONS` 中登记**，
 * 否则 `resolveIcon` 会静默回退到 `Wrench`——不报错，但图标与预期不符。
 */
export const ICONS: Record<string, LucideIcon> = {
  ArrowLeftRight,
  AtSign,
  Binary,
  BookOpen,
  Braces,
  Calculator,
  CalendarClock,
  CaseSensitive,
  ClipboardList,
  Clock,
  Code,
  Code2,
  Database,
  FileCode,
  FileDiff,
  FileImage,
  Filter,
  Fingerprint,
  FolderOpen,
  HardDrive,
  Hash,
  Hourglass,
  Info,
  Keyboard,
  KeyRound,
  LayoutGrid,
  LayoutDashboard,
  Link,
  Link2,
  ListFilter,
  Network,
  NotebookPen,
  Package,
  Palette,
  History,
  QrCode,
  Regex,
  Ruler,
  Scale,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sigma,
  Sparkles,
  Star,
  StickyNote,
  Table,
  Table2,
  TextCursorInput,
  TextQuote,
  Trash2,
  Type,
  Wrench,
  X,
};

/**
 * 未登记图标的告警集合（V24）：同一个名字只告警一次，避免渲染期刷屏。
 * 仅用于开发期提示；生产构建里 `import.meta.env.DEV` 为 false，不会执行。
 */
const warned = new Set<string>();

/** 取得图标组件（未登记则回退）。 */
export function resolveIcon(name: string | undefined, fallback: LucideIcon = Wrench): LucideIcon {
  if (name && name in ICONS) {
    return ICONS[name] as LucideIcon;
  }
  // V24：不再静默回退。以前忘了登记只会「图标变成扳手」，没人看得出是 bug；
  // 现在开发期直接点名，配合 `tool-audit` 可以在提交前就拦住。
  if (name && import.meta.env.DEV && !warned.has(name)) {
    warned.add(name);
    // eslint-disable-next-line no-console
    console.warn(
      `[icons] 图标 "${name}" 未在 src/lib/icons.ts 的 ICONS 中登记，已回退为默认图标。` +
        '请在 ICONS 里补上对应 lucide 导出。',
    );
  }
  return fallback;
}
