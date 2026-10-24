import React from 'react';
import ReactDOM from 'react-dom/client';
import App, { type WindowRoot } from './App';
import { bootstrap, bootstrapSync } from './core/bootstrap';
import { useAppStore } from './stores/useAppStore';
import { diagLog } from '@/lib/diag';
import { ipc } from '@/lib/ipc';
import { installErrorSink } from '@/lib/errorSink';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import './index.css';

/**
 * 窗口分派入口。
 * 每个 Tauri 窗口会以 `index.html?window=xxx` 形式加载，不同窗口挂载不同的根视图，
 * 从而让各 WebView 拥有独立的 JS 运行环境（状态天然隔离，见 ARCHITECTURE ADR-8）。
 *
 * 启动顺序（防挂死版）：
 *   1. `bootstrapSync()` 同步装配模块注册表（纯内存、幂等，不可能挂起）；
 *   2. **立即渲染**（首帧不依赖任何 IPC）；
 *   3. 配置态装配（settings / 收藏 / 最近 / 平台探测）转后台进行，
 *      加 3.5s 兜底：即使 invoke 通道异常也绝不阻塞 UI。
 */
/** 窗口解析结果：根类型 + 便签窗口上下文 */
interface WindowTarget {
  windowRoot: WindowRoot;
  /** 便签 id（仅 windowRoot = 'note' 时存在） */
  noteId?: string;
}

/**
 * 解析窗口参数。
 * 便签多实例窗由 Rust 拼接为 `?window=note-<id>`；兼容 `?window=note&id=<id>` 形式。
 */
function resolveWindow(search: string): WindowTarget {
  const params = new URLSearchParams(search);
  const raw = params.get('window') ?? '';

  if (raw.startsWith('note-')) {
    return { windowRoot: 'note', noteId: raw.slice('note-'.length) };
  }
  if (raw === 'note') {
    return { windowRoot: 'note', noteId: params.get('id') ?? undefined };
  }

  switch (raw) {
    case 'settings':
      return { windowRoot: 'settings' };
    case 'organizer':
      return { windowRoot: 'organizer' };
    case 'grid-overlay':
      // 桌面网格挂件透明窗（Rust `grid_overlay_show` 以 ?window=grid-overlay 创建）
      return { windowRoot: 'grid-overlay' };
    case 'workstation-bar':
      // 常驻桌面顶部的工作台贴条（Rust `bar_show` 以 ?window=workstation-bar 创建）
      return { windowRoot: 'workstation-bar' };
    default:
      return { windowRoot: 'main' };
  }
}

/** 取得挂载点（缺失即抛出，避免静默白屏）。 */
function resolveRootElement(): HTMLElement {
  const element = document.getElementById('root');
  if (!element) {
    throw new Error('未找到挂载点 #root，页面初始化失败');
  }
  return element;
}

const rootElement = resolveRootElement();

/** 配置态装配兜底时限：超时后 UI 照常可用（配置沿用默认值） */
const BOOTSTRAP_GUARD_MS = 3500;

function start(): void {
  // 0) 全局错误捕获：必须赶在任何渲染之前装上 —— 最值钱的错误恰恰发生在挂载之前
  installErrorSink();

  // 1) 同步装配（幂等）：注册表就绪后才有可渲染的视图树
  bootstrapSync();

  // 2) 立即渲染（不 await 任何异步装配）
  const target = resolveWindow(window.location.search);

  // 2.1) 诊断深链：`?tool=<commandId>` 直接进入指定工具，`?module=<moduleId>` 进入模块内页。
  // 与 Rust 侧 `HANDY_AUTOTOOL` 通道互补——后者依赖 Tauri 事件，浏览器冒烟测试用不了 URL 通道。
  // 必须在首帧渲染前同步设置，避免先闪一帧命令面板。
  if (target.windowRoot === 'main') {
    const deepLink = new URLSearchParams(window.location.search);
    const deepTool = deepLink.get('tool');
    const deepModule = deepLink.get('module');
    if (deepTool !== null && deepTool !== '') {
      useAppStore.getState().setView({ kind: 'command', commandId: deepTool });
    } else if (deepModule !== null && deepModule !== '') {
      useAppStore.getState().setView({ kind: 'module', moduleId: deepModule });
    }

    // 2.2) 开发调试入口 `?demo=richmarkdown`：直接挂载所见即所得输入框做浏览器回归。
    // 工作台里的笔记 / 计划依赖 SQLite，浏览器预览下是空的 —— 没有这个入口就测不到该组件。
    if (deepLink.get('demo') === 'richmarkdown') {
      void import('./dev/RichMarkdownDemo').then(({ default: Demo }) => {
        ReactDOM.createRoot(rootElement).render(
          <React.StrictMode>
            <Demo />
          </React.StrictMode>,
        );
      });
      return;
    }

    // 2.3) 开发调试入口 `?demo=calendar`：直接挂载桌面挂件日历做浏览器回归。
    // 日历依赖 SQLite / Tauri 的地方都有 try/catch 兜底，浏览器下为空数据也不白屏。
    if (deepLink.get('demo') === 'calendar') {
      void import('./dev/CalendarDemo').then(({ default: Demo }) => {
        ReactDOM.createRoot(rootElement).render(
          <React.StrictMode>
            <Demo />
          </React.StrictMode>,
        );
      });
      return;
    }
  }

  // TooltipProvider 必须**包住所有窗口根**（V45 修）：工具组件（如密码生成器的
  // `ResultBox`）内部用 `Tooltip`，而它既可能在主窗口（AppLayout 已有 Provider）渲染，
  // 也可能在桌面挂件窗的抽屉里渲染 —— 后者此前没有 Provider，一点开就抛
  // 「`Tooltip` must be used within `TooltipProvider`」白屏。放在根上两层都覆盖。
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <TooltipProvider delayDuration={300}>
        <ErrorBoundary label={target.windowRoot === 'main' ? '主界面' : '这个窗口'}>
          <App windowRoot={target.windowRoot} noteId={target.noteId} />
        </ErrorBoundary>
      </TooltipProvider>
    </React.StrictMode>,
  );

  // 3) 后台装配配置态（含兜底超时，失败不阻断 UI）
  void Promise.race([
    bootstrap(),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, BOOTSTRAP_GUARD_MS);
    }),
  ])
    .then(() => {
      // 贴条常驻：设置里开着就自动贴回桌面顶部（重启后依然可见，无需每次手点）
      if (target.windowRoot === 'main' && useAppStore.getState().settings.barPinned) {
        // bar_show 默认置顶；用户关过置顶就按设置纠正回来（贴条显隐 / 置顶两个开关互不干扰）
        const onTop = useAppStore.getState().settings.barOnTop;
        void ipc
          .barShow()
          .then(() => ipc.barSetPinned(onTop))
          .catch(() => undefined);
      }
      // 主窗口置顶：默认关，设置里开着才应用（否则会盖住系统弹框与其它软件）
      if (target.windowRoot === 'main' && useAppStore.getState().settings.mainPinned) {
        void ipc.appSetPinned(true).catch(() => undefined);
      }
    })
    .catch((error: unknown) => {
      console.error('[Handy] 启动装配失败：', error);
    });

  // 3.1) 窗口形态设置（贴条显隐 / 主窗口置顶）的唯一驱动点：**只由主窗口**订阅。
  // 贴条窗自己也跑本文件，若不判断窗口就会「自己叫自己」再创建一次窗口，故限定 main。
  // 这样「工作台按钮 / 设置中心开关」都会经由同一路径生效，行为一致。
  if (target.windowRoot === 'main') {
    useAppStore.subscribe((state, prev) => {
      if (state.settings.barPinned !== prev.settings.barPinned) {
        const task = state.settings.barPinned
          ? ipc.barShow().then(() => ipc.barSetPinned(state.settings.barOnTop))
          : ipc.barHide();
        void task.catch(() => undefined);
      }
      // 贴条置顶（与「贴条开着没有」独立的第二个开关）：设置中心改了就立刻作用到窗口
      if (state.settings.barOnTop !== prev.settings.barOnTop) {
        void ipc.barSetPinned(state.settings.barOnTop).catch(() => undefined);
      }
      // 置顶默认关：开着才让主窗口浮在最上层（否则会盖住系统弹框 / 其它软件）
      if (state.settings.mainPinned !== prev.settings.mainPinned) {
        void ipc.appSetPinned(state.settings.mainPinned).catch(() => undefined);
      }
    });
  }

  // 无头测试通道：Rust 侧 HANDY_AUTOTOOL 环境变量 → `autotool` 事件 → 自动打开
  // 指定命令（`cmd-id`）或模块视图（`module:module-id`）。用于自动化诊断/回归。
  diagLog(`frontend boot root=${target.windowRoot}`);
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<string>('autotool', (event) => {
        const payload = event.payload;
        diagLog(`autotool received: ${payload}`);
        if (payload.startsWith('module:')) {
          useAppStore.getState().setView({ kind: 'module', moduleId: payload.slice(7) });
        } else {
          useAppStore.getState().setView({ kind: 'command', commandId: payload });
        }
      }),
    )
    .then(() => {
      diagLog('autotool listener ready');
    })
    .catch(() => {
      /* 浏览器环境无 Tauri IPC，忽略 */
    });

  // 外部窗口 → 主窗口导航（如顶部贴条的「打开工作台」）：
  // 视图状态是每窗口独立的，贴条改不了主窗口的 store，只能由 Rust 发事件、主窗口响应。
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<string>('handy:navigate', (event) => {
        const payload = event.payload;
        diagLog(`navigate received: ${payload}`);
        if (payload.startsWith('module:')) {
          useAppStore.getState().setView({ kind: 'module', moduleId: payload.slice(7) });
        } else if (payload === 'settings') {
          useAppStore.getState().setView({ kind: 'settings' });
        } else if (payload !== '') {
          useAppStore.getState().setView({ kind: 'command', commandId: payload });
        }
      }),
    )
    .catch(() => {
      /* 浏览器环境无 Tauri IPC，忽略 */
    });
}

start();
