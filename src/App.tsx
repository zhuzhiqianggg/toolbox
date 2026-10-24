import { useEffect, type FC } from 'react';
import { AppLayout } from './components/AppLayout';
import { CommandPalette } from './components/CommandPalette';
import { CommandView } from './components/CommandView';
import { ModuleView } from './components/ModuleView';
import { SettingsCenter } from './components/SettingsCenter';
import { useAppStore, type MainView } from '@/stores/useAppStore';
import { NoteWindow } from '@/modules/notes/NoteWindow';
import { ReminderScheduler } from '@/modules/todos/ReminderScheduler';
import { useTheme } from '@/hooks/useTheme';
import { useHotkeyOpen } from '@/hooks/useHotkeyOpen';
import { applyViewSize, initWindowShell } from '@/lib/windowShell';

/** 可挂载的窗口根类型（与 Rust 侧 WindowKind 对应） */
export type WindowRoot = 'main' | 'note' | 'settings';

export interface AppProps {
  /** 由 main.tsx 依据 ?window= 参数注入 */
  windowRoot?: WindowRoot;
  /** 便签 id（windowRoot = 'note' 时由 ?window=note-<id> 解析注入） */
  noteId?: string;
}

/** 主面板视图分发。 */
function renderView(view: MainView) {
  switch (view.kind) {
    case 'settings':
      return <SettingsCenter />;
    case 'module':
      return <ModuleView moduleId={view.moduleId} />;
    case 'command':
      return (
        <CommandView commandId={view.commandId} input={view.input} source={view.source} />
      );
    case 'palette':
    default:
      return <CommandPalette />;
  }
}

/**
 * 主应用组件。
 *
 * - 主窗口（`main`）：命令面板 / 模块内页 / 设置中心 的视图分发；
 * - 其他窗口根（便签 / 设置窗 / 桌面整理）在 V08/V12/V13 接入，本批占位。
 *
 * **Hook 顺序**：所有 Hook 必须在任何 early-return 之前调用（rules-of-hooks）。
 * `windowRoot` 在单个窗口生命周期内恒定，下面两个 early-return 不会实际造成调用次序
 * 漂移。
 */
const App: FC<AppProps> = ({ windowRoot = 'main', noteId }) => {
  // 应用主题（light / dark / system）
  useTheme();

  // 全局快捷键呼出（V61，用户口径）：**有打开的工具/模块页 → 原样保留**（Rust 侧已
  // show + set_focus，工具内输入由 usePersistedState 落盘，收起再唤醒一样都在）；
  // **面板/设置页 → 切回命令面板并聚焦搜索框**（useHotkeyOpen 监听 main-shown 事件），
  // 用户直接输入即可过滤工具。只有用户在工具内按 Esc / 返回（CommandShell）才回到面板。

  useHotkeyOpen();

  const view = useAppStore((state) => state.view);

  // 窗口骨架启动装配（V15）：恢复上次尺寸 + 挂 resized 监听做持久化。仅主窗口。
  useEffect(() => {
    if (windowRoot !== 'main') {
      return;
    }
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void initWindowShell().then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      cleanup = fn;
    });
    return () => {
      disposed = true;
      if (cleanup !== null) {
        cleanup();
      }
    };
  }, [windowRoot]);

  // 视图切换套用预设尺寸（V15）：工具页 1180×820、模块 1080×760、设置 960×700、面板 780×560。
  // 用户手动调整过尺寸后不再强行套用（windowShell 内部判定）。
  const viewKind = view.kind;
  useEffect(() => {
    if (windowRoot !== 'main') {
      return;
    }
    void applyViewSize(viewKind);
  }, [viewKind, windowRoot]);

  // 便签多实例窗（V08）：无边框独立窗口，NoteWindow 自带拖拽/置顶/取色/防抖落库
  if (windowRoot === 'note') {
    if (!noteId) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
          便签窗口缺少 id 参数（应为 ?window=note-&lt;id&gt;）
        </div>
      );
    }
    return <NoteWindow noteId={noteId} />;
  }

  if (windowRoot !== 'main') {
    return (
      <AppLayout showSidebar={false}>
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-lg font-medium text-foreground">Toolbox</p>
          <p className="text-sm text-muted-foreground">
            「{windowRoot}」窗口将在后续版本接入。
          </p>
        </div>
      </AppLayout>
    );
  }

  // 主窗口：提醒调度器无 UI 挂载（60s 扫描，过期 >1h 不补发，见 ReminderScheduler）。
  return (
    <>
      <ReminderScheduler />
      <AppLayout>{renderView(view)}</AppLayout>
    </>
  );
};

export default App;
