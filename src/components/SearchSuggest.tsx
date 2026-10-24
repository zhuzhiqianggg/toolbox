import * as React from 'react';
import { Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { registry } from '@/core/moduleRegistry';
import { openCommand } from '@/core/navigation';
import { matchClipContent, SUGGESTED_COMMAND_NAMES, type ClipMatch } from '@/lib/contentMatch';
import { readClipboardText } from '@/lib/clipboard';

/**
 * 智能建议条（V05 骨架 → V11 接入内容识别器）。
 *
 * 打开命令面板时读取一次剪贴板，若命中识别器（JSON / JWT / URL / 时间戳 / 文件路径），
 * 则提示「一键直达」对应命令，并携带内容作为初始输入。识别逻辑复用
 * `@/lib/contentMatch`（纯函数；命令映射已核对 toolbox 实际注册 id）。
 *
 * 隐私：仅在面板打开时按需读取一次，不后台轮询；识别失败静默不显示。
 */
export function SearchSuggest(): React.JSX.Element | null {
  const [match, setMatch] = React.useState<ClipMatch | null>(null);
  const [content, setContent] = React.useState('');
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void readClipboardText()
      .then((text) => {
        if (!alive) {
          return;
        }
        const detected = matchClipContent(text);
        if (detected) {
          setMatch(detected);
          setContent(text);
        }
      })
      .catch(() => {
        // 无权限 / 不可用：静默
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!match || dismissed) {
    return null;
  }

  const commandId = match.suggestedCommandId;

  const handleApply = (): void => {
    if (!commandId || !registry.findCommand(commandId)) {
      toast.error('对应工具不可用', { description: '请先在设置中启用相关模块。' });
      return;
    }
    openCommand(commandId, { input: content, source: 'clipboard' });
  };

  const actionName =
    commandId !== undefined ? (SUGGESTED_COMMAND_NAMES[commandId] ?? '对应工具') : null;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-brand-muted/50 px-4 py-2">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-brand" />
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
        检测到 <span className="font-medium">{match.type === 'file-path' ? '文件路径' : match.type.toUpperCase()}</span>
        ，{match.displayHint}
      </span>
      {actionName && (
        <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={handleApply}>
          用 {actionName} 打开
        </Button>
      )}
      <button
        type="button"
        aria-label="忽略建议"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default SearchSuggest;
