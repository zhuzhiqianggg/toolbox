import * as React from 'react';
import { ArrowLeft, Check, Clock, ClipboardPaste, Copy, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SampleBar, type SampleEntry } from '@/components/SampleBar';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { copyText as writeClipboardText, readClipboardText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

/** 示例条目类型再导出，工具页可只从本模块取用（少一条 import 路径） */
export type { SampleEntry } from '@/components/SampleBar';

export interface CommandShellPrimaryAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface CommandShellProps {
  /** 标题（命令名） */
  title: string;
  /** 副标题（命令描述） */
  description?: string;
  /** 标题前的图标节点 */
  icon?: React.ReactNode;
  /** 是否已收藏 */
  favorite?: boolean;
  /** 返回上一级（主面板） */
  onBack?: () => void;
  /** 切换收藏 */
  onToggleFavorite?: () => void;
  /**
   * 收藏不可用（敏感命令 = true）：为真时**不渲染**收藏星标。
   * 由 `useCommandShell().favoriteDisabled` 注入（判定见 `core/sensitive.ts`）。
   */
  favoriteDisabled?: boolean;
  /** 打开历史 */
  onOpenHistory?: () => void;
  /**
   * 内联复制：直接提供的待复制文本（与 `getCopyText` 二选一，本项优先）。
   * 传入后标题栏出现「一键复制」按钮；传空串则按钮置灰不可点。
   */
  copyText?: string;
  /**
   * 内联复制：惰性获取待复制文本，用于内容随交互实时变化的场景
   * （如从结果区当前值取值）。与 `copyText` 二选一。
   */
  getCopyText?: () => string;
  /**
   * 一键读剪贴板：传入后标题栏出现「粘贴」按钮，点击读取系统剪贴板文本并回传，
   * 由工具自行决定填入哪个输入框（典型：主输入）。读取失败或为空时给 toast 提示。
   * 依赖 `lib/clipboard.readClipboardText`（Tauri 优先，浏览器降级）。
   */
  onPaste?: (text: string) => void;
  /** 主操作（如「执行」） */
  primaryAction?: CommandShellPrimaryAction;
  /**
   * 撑满模式（编辑器 / 格式化类工具用）：
   * 内容区**不再整体滚动**，改为 flex 纵向撑满，由内部子元素自行用 `flex-1` 分配高度，
   * 使输入框与结果区随窗口大小同步伸缩，避免「上面挤着拉滚动条、下面留一大片空白」。
   */
  fill?: boolean;
  /** 底部快捷键提示条文案，如 "Enter 执行 · Esc 返回" */
  shortcutHint?: string;
  /**
   * 可点击的示例（V20）：渲染在标题栏下方的一条 chip 行。
   *
   * 每条示例自带 `apply` 闭包 —— 可以只把样例文本填进输入框，也可以「填 + 立即执行」，
   * 还可以一次设置多个字段（如文本对比的左/右两栏）。空数组等同不传。
   */
  samples?: readonly SampleEntry[];
  children: React.ReactNode;
}

/**
 * 工具/命令详情统一外壳。所有工具页共用：标题栏 + 返回 + 收藏 + 历史 + 一键复制 + 快捷键提示条。
 *
 * 一键复制：父级通过 `copyText`（静态文本）或 `getCopyText`（惰性取值）注入待复制内容，
 * 标题栏即出现复制按钮（内容为空时置灰）。内容区仍可自行使用 `ResultBox` / `CopyButton`
 * 做更精细的分区复制，二者互不冲突。
 *
 * 剪贴板能力统一经 `src/lib/clipboard`（Tauri 优先，浏览器自动降级）。
 */
export function CommandShell({
  title,
  description,
  icon,
  favorite = false,
  onBack,
  onToggleFavorite,
  favoriteDisabled = false,
  onOpenHistory,
  copyText,
  getCopyText,
  onPaste,
  primaryAction,
  fill = false,
  shortcutHint = 'Enter 执行 · Esc 返回',
  samples,
  children,
}: CommandShellProps): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  // Esc 返回（V15 修复 bug③）：工具视图内按 Esc 即触发 onBack 返回主面板。
  // CommandPalette 自身的 Esc 监听仅在面板可见时挂载，二者互不冲突；
  // 若事件已被内层组件（如 Radix 弹层 / 对话框）消费（defaultPrevented）则不重复响应。
  React.useEffect(() => {
    if (!onBack) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onBack]);

  // 是否注入了复制能力（静态文本或惰性取值任一即可）
  const hasCopySource = typeof copyText === 'string' || typeof getCopyText === 'function';
  // 静态文本为空串时视为「无内容」，按钮置灰
  const copyDisabled = typeof copyText === 'string' && copyText.length === 0;

  /** 解析当前待复制文本：静态优先，其次惰性取值（取值异常按空处理）。 */
  const resolveCopyText = React.useCallback((): string => {
    if (typeof copyText === 'string') {
      return copyText;
    }
    if (typeof getCopyText === 'function') {
      try {
        return getCopyText();
      } catch {
        return '';
      }
    }
    return '';
  }, [copyText, getCopyText]);

  const handleCopy = React.useCallback(async (): Promise<void> => {
    const text = resolveCopyText();
    if (!text) {
      toast.error('暂无可复制内容');
      return;
    }
    const ok = await writeClipboardText(text);
    if (ok) {
      setCopied(true);
      toast.success('已复制到剪贴板');
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error('复制失败，请手动选择文本复制');
    }
  }, [resolveCopyText]);

  const [pasted, setPasted] = React.useState(false);
  const handlePaste = React.useCallback(async (): Promise<void> => {
    if (typeof onPaste !== 'function') {
      return;
    }
    const text = (await readClipboardText()).replace(/\r\n/g, '\n').trim();
    if (!text) {
      toast.error('剪贴板为空或无法读取');
      return;
    }
    onPaste(text);
    setPasted(true);
    toast.success('已从剪贴板填入');
    window.setTimeout(() => setPasted(false), 1500);
  }, [onPaste]);

  return (
    <div className="flex h-full flex-col">
      {/* 标题栏 */}
      <header className="flex items-center gap-3 px-4 py-3">
        {onBack ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="返回"
                onClick={onBack}
                className="shrink-0"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>返回</TooltipContent>
          </Tooltip>
        ) : null}

        {icon ? <span className="shrink-0 text-brand">{icon}</span> : null}

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
          {description ? (
            <p className="truncate text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {hasCopySource ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={copied ? '已复制' : '复制'}
                  onClick={handleCopy}
                  disabled={copyDisabled}
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-brand" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{copied ? '已复制' : '复制'}</TooltipContent>
            </Tooltip>
          ) : null}

          {typeof onPaste === 'function' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={pasted ? '已粘贴' : '从剪贴板粘贴'}
                  onClick={handlePaste}
                >
                  {pasted ? (
                    <Check className="h-4 w-4 text-brand" />
                  ) : (
                    <ClipboardPaste className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{pasted ? '已粘贴' : '从剪贴板粘贴'}</TooltipContent>
            </Tooltip>
          ) : null}

          {onOpenHistory ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="历史" onClick={onOpenHistory}>
                  <Clock className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>历史记录</TooltipContent>
            </Tooltip>
          ) : null}

          {/* 收藏：敏感命令（favoriteDisabled）不渲染星标——不提供入口，也不留假按钮 */}
          {onToggleFavorite && !favoriteDisabled ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={favorite ? '取消收藏' : '收藏'}
                  onClick={onToggleFavorite}
                >
                  <Star className={cn('h-4 w-4', favorite && 'fill-brand text-brand')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{favorite ? '取消收藏' : '收藏'}</TooltipContent>
            </Tooltip>
          ) : null}

          {primaryAction ? (
            <Button
              size="sm"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
              className="ml-1"
            >
              {primaryAction.label}
            </Button>
          ) : null}
        </div>
      </header>

      <Separator />

      {/* 示例条（V20）：放在内容区**之上**且不随内容滚动 —— fill 模式下内容区是
          flex-1 撑满，示例条作为 shrink-0 兄弟节点才不会把输入框挤出可视区 */}
      {samples !== undefined && samples.length > 0 ? <SampleBar entries={samples} /> : null}

      {/* 内容区：V15 —— 窗口放开到 1180×820 基准，内边距加大并限制最大宽度，
          避免超宽屏（最大化 / 4K）把内容拉散；
          fill 模式改为纵向 flex 撑满，由子元素自行分配高度（编辑器 / 格式化类工具） */}
      <div
        className={cn(
          'min-h-0 flex-1 p-5',
          fill ? 'flex flex-col overflow-hidden' : 'scrollbar-thin overflow-auto',
        )}
      >
        <div
          className={cn('mx-auto w-full max-w-[1400px]', fill && 'flex min-h-0 flex-1 flex-col')}
        >
          {children}
        </div>
      </div>

      {/* 快捷键提示条 */}
      {shortcutHint ? (
        <>
          <Separator />
          <footer className="px-4 py-2 text-xs text-muted-foreground">{shortcutHint}</footer>
        </>
      ) : null}
    </div>
  );
}
