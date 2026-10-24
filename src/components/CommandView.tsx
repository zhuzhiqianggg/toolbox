import * as React from 'react';
import { CommandShell } from '@/components/CommandShell';
import { registry } from '@/core/moduleRegistry';
import { useAppStore } from '@/stores/useAppStore';
import { useRecentStore } from '@/stores/useRecentStore';
import { resolveIcon } from '@/lib/icons';
import type { ComponentType } from 'react';
import type { CommandProps } from '@/core/types';

export interface CommandViewProps {
  commandId: string;
  /** 初始输入（来自剪贴板建议 / 历史） */
  input?: string;
  /** 输入来源 */
  source?: CommandProps['source'];
}

/**
 * 命令宿主（V05）：惰性加载 `CommandMeta.load()` 返回的组件并渲染。
 *
 * - 打开即记录「最近使用」（挂载时写入，覆盖面板 / 建议条 / 历史等所有入口）；
 * - 命令组件各自使用 `CommandShell` 提供返回 / 收藏 / 复制外壳。
 */
export function CommandView({ commandId, input, source }: CommandViewProps): React.JSX.Element {
  const command = registry.findCommand(commandId);
  const [Loaded, setLoaded] = React.useState<ComponentType<CommandProps> | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // 打开命令即记录最近使用；**敏感命令不记录**（隐私管控，唯一事实源 CommandMeta.sensitive，
  // 见 core/sensitive.ts —— 密码 / JWT 等私密工具不得在「最近使用」留痕）
  React.useEffect(() => {
    if (command?.sensitive === true) {
      return;
    }
    useRecentStore.getState().push(commandId);
  }, [commandId, command]);

  React.useEffect(() => {
    let alive = true;
    setLoaded(null);
    setError(null);
    if (!command?.load) {
      setError('该命令暂无可打开的界面');
      return () => {
        alive = false;
      };
    }
    import('@/lib/diag')
      // guardLoad：START/OK/FAIL 写 Toolbox.log + 10s 超时兜底（避免永久「正在加载…」）
      .then(({ guardLoad }) => guardLoad(commandId, () => command.load!()))
      .then((loaded) => {
        if (alive) {
          setLoaded(() => loaded.default);
        }
      })
      .catch((err: unknown) => {
        if (alive) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      alive = false;
    };
  }, [command]);

  if (!command) {
    return <CommandUnavailable title="未找到该命令" detail={commandId} />;
  }
  if (error) {
    return <CommandUnavailable title={command.name} detail={error} />;
  }
  if (!Loaded) {
    return <CommandUnavailable title={command.name} detail="正在加载…" loading />;
  }

  return <Loaded initialInput={input} source={source ?? 'command'} />;
}

/** 命令不可用（未找到 / 加载失败 / 加载中）时的兜底外壳。 */
function CommandUnavailable({
  title,
  detail,
  loading = false,
}: {
  title: string;
  detail: string;
  loading?: boolean;
}): React.JSX.Element {
  const showPalette = useAppStore((state) => state.showPalette);
  return (
    <CommandShell
      title={title}
      description={loading ? undefined : detail}
      icon={<IconPlaceholder />}
      onBack={showPalette}
      shortcutHint="Esc 返回"
    >
      <p className="text-sm text-muted-foreground">{loading ? detail : `无法打开：${detail}`}</p>
    </CommandShell>
  );
}

/** 占位图标（避免在此引入多余依赖）。 */
function IconPlaceholder(): React.JSX.Element {
  const Icon = resolveIcon('Wrench');
  return <Icon className="h-4 w-4" />;
}

export default CommandView;
