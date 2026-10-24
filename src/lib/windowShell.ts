import { isTauri } from '@/platform/detect';
import { ipc } from '@/lib/ipc';
import type { Window as TauriWindow } from '@tauri-apps/api/window';

/**
 * 主窗口尺寸骨架（V15 布局改造）。
 *
 * 背景：主窗口 `decorations: false`（无边框），没有原生标题栏 / 最大化 / 缩放手柄，
 * 且此前 `resizable: false` 把窗口锁死在 680×460，工具页全部被框住。本模块负责：
 *
 * - **按视图类型套用预设尺寸**（命令面板 / 工具页 / 模块内页 / 设置中心）；
 * - **贴合屏幕**：预设尺寸先 clamp 到当前显示器工作区的 92%，小屏笔记本不溢出；
 * - **用户覆盖优先**：用户手动拖拽缩放过之后，切换视图不再强行套用预设；
 * - **持久化**：`{ w, h, userResized }` 写 localStorage（`toolbox.window.v1`），下次启动恢复。
 *
 * **非 Tauri 环境（浏览器冒烟）**：所有导出函数静默 no-op，不抛错、不写存储。
 */

/** 主窗口视图类型（与 `useAppStore.MainView['kind']` 对齐） */
export type ViewKind = 'palette' | 'command' | 'module' | 'settings';

/** 持久化状态 */
export interface WindowShellState {
  /** 宽度（逻辑像素） */
  w: number;
  /** 高度（逻辑像素） */
  h: number;
  /** 用户是否手动调整过尺寸（为真时切换视图不再套用预设） */
  userResized: boolean;
}

/** 窗口状态快照（供标题栏刷新按钮图标） */
export interface WindowShellStatus {
  maximized: boolean;
}

const STORAGE_KEY = 'toolbox.window.v1';
/** 预设尺寸最多占屏幕工作区的比例（留边，避免贴边 / 溢出） */
const SCREEN_RATIO = 0.92;
/** 尺寸变化持久化防抖（毫秒） */
const PERSIST_DEBOUNCE_MS = 400;
/** 视为「尺寸相同」的容差（像素），避免 1px 抖动触发无谓 setSize */
const SIZE_EPSILON = 6;
/** 程序化 setSize 之后忽略 onResized 回弹的时间窗（毫秒） */
const PROGRAMMATIC_GUARD_MS = 600;
/** 最大化状态轮询兜底间隔（无边框窗口下最大化事件不可靠） */
const STATUS_POLL_MS = 1500;
/**
 * 持久化尺寸下限（与 `tauri.conf.json` 的 `minWidth` / `minHeight` 对齐）。
 * 低于此值视为脏数据 / 折叠值（例如最小化残留的异常尺寸），丢弃且不记为用户自定义。
 */
const MIN_W = 640;
const MIN_H = 440;

/**
 * 各视图的设计基准尺寸（逻辑像素）。
 * 工具页最大（1180×820）—— 用户核心痛点就是工具被小框限制。
 */
export const VIEW_PRESETS: Record<ViewKind, { w: number; h: number }> = {
  palette: { w: 780, h: 560 },
  command: { w: 1180, h: 820 },
  module: { w: 1080, h: 760 },
  settings: { w: 960, h: 700 },
};

/** 屏幕工作区（逻辑像素） */
interface ScreenArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

// —— 模块级状态（单窗口应用，无需 store）——

let cachedState: WindowShellState | null = null;
let persistTimer = 0;
let programmaticUntil = 0;
let initialized = false;
/**
 * 最近一次程序化设定的尺寸。用于区分「用户拖拽」与「最大化→还原」等系统回弹：
 * 后者尺寸回到上次程序化值，不应被记为用户自定义（否则预设会失效）。
 */
let lastApplied: { w: number; h: number } | null = null;

/** 是否为有限正数（持久化数据校验用） */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 读取持久化状态（带缓存；数据非法时返回 null） */
function loadState(): WindowShellState | null {
  if (cachedState !== null) {
    return cachedState;
  }
  if (typeof localStorage === 'undefined') {
    return null;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    // 下限校验（V16）：拒绝小于 minWidth / minHeight 的脏数据 / 折叠值，
    // 返回 null 即视为「未手动调整过」，后续按视图预设尺寸套用。
    if (
      !isPositiveNumber(record.w) ||
      !isPositiveNumber(record.h) ||
      record.w < MIN_W ||
      record.h < MIN_H
    ) {
      return null;
    }
    cachedState = {
      w: record.w,
      h: record.h,
      userResized: record.userResized === true,
    };
    return cachedState;
  } catch {
    return null;
  }
}

/** 写入持久化状态（存储不可用时静默降级为仅内存） */
function updateState(patch: Partial<WindowShellState>): void {
  const base: WindowShellState = cachedState ?? { w: 0, h: 0, userResized: false };
  cachedState = { ...base, ...patch };
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedState));
  } catch {
    // 隐私模式 / 配额不足：忽略，内存态仍有效
  }
}

/** 取得当前窗口；非 Tauri 或加载失败返回 null（浏览器静默 no-op） */
async function getWindow(): Promise<TauriWindow | null> {
  if (!isTauri()) {
    return null;
  }
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow();
  } catch {
    return null;
  }
}

/** 当前显示器工作区（逻辑像素）；拿不到返回 null，此时不做 clamp */
async function screenArea(): Promise<ScreenArea | null> {
  try {
    // `currentMonitor` 是模块级函数（非 Window 方法，Tauri v2 API）
    const { currentMonitor } = await import('@tauri-apps/api/window');
    const monitor = await currentMonitor();
    if (!monitor) {
      return null;
    }
    const scale = monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
    const size = monitor.workArea.size.toLogical(scale);
    const position = monitor.workArea.position.toLogical(scale);
    return { left: position.x, top: position.y, width: size.width, height: size.height };
  } catch {
    return null;
  }
}

/** 把目标尺寸 clamp 到屏幕工作区（92%）以内 */
function clampSize(w: number, h: number, area: ScreenArea | null): { w: number; h: number } {
  const width = Math.round(w);
  const height = Math.round(h);
  if (area === null) {
    return { w: width, h: height };
  }
  const maxW = Math.max(320, Math.floor(area.width * SCREEN_RATIO));
  const maxH = Math.max(240, Math.floor(area.height * SCREEN_RATIO));
  return { w: Math.min(width, maxW), h: Math.min(height, maxH) };
}

/**
 * 设置窗口尺寸（逻辑像素）：clamp 到屏幕 + 越界时居中兜底。
 * 尺寸基本相同（<6px）时跳过，避免无谓 IPC。
 */
async function resizeTo(w: number, h: number): Promise<void> {
  const win = await getWindow();
  if (win === null) {
    return;
  }
  try {
    const area = await screenArea();
    const target = clampSize(w, h, area);
    lastApplied = target;
    const scale = await win.scaleFactor();
    const current = (await win.innerSize()).toLogical(scale);
    if (
      Math.abs(current.width - target.w) < SIZE_EPSILON &&
      Math.abs(current.height - target.h) < SIZE_EPSILON
    ) {
      return;
    }

    // 程序化窗口期：随后的 onResized 回弹不计为「用户调整」
    programmaticUntil = Date.now() + PROGRAMMATIC_GUARD_MS;
    const { LogicalSize } = await import('@tauri-apps/api/dpi');
    await win.setSize(new LogicalSize(target.w, target.h));

    // 放大后可能越出工作区（例如窗口原本靠右）→ 居中兜底
    if (area !== null) {
      const position = (await win.outerPosition()).toLogical(scale);
      const overflow =
        position.x < area.left - 1 ||
        position.y < area.top - 1 ||
        position.x + target.w > area.left + area.width + 1 ||
        position.y + target.h > area.top + area.height + 1;
      if (overflow) {
        await win.center();
      }
    }
  } catch {
    // 尺寸设置失败不影响功能（窗口仍可手动拖拽）
  }
}

/**
 * 切换到某视图时套用预设尺寸。
 * - 非 Tauri：静默 no-op；
 * - 用户手动调整过尺寸（`userResized`）：保持现状，不强行套用。
 */
export async function applyViewSize(kind: ViewKind): Promise<void> {
  if (!isTauri()) {
    return;
  }
  const state = loadState();
  if (state?.userResized === true) {
    return;
  }
  const preset = VIEW_PRESETS[kind];
  await resizeTo(preset.w, preset.h);
}

/**
 * 启动装配：恢复上次尺寸 + 挂 resized 监听做持久化。
 * 返回清理函数（卸载时解绑监听）。非 Tauri 返回空实现。
 */
export async function initWindowShell(): Promise<() => void> {
  const noop = (): void => {
    /* 浏览器环境：无窗口可管 */
  };
  if (!isTauri() || initialized) {
    return noop;
  }
  initialized = true;

  const win = await getWindow();
  if (win === null) {
    return noop;
  }

  // 1) 恢复上次尺寸（最大化状态下不动，避免打断最大化）
  try {
    const state = loadState();
    const maximized = await win.isMaximized();
    if (state !== null && !maximized) {
      await resizeTo(state.w, state.h);
    }
  } catch {
    // 恢复失败沿用窗口默认尺寸
  }

  // 2) 监听尺寸变化：防抖持久化 + 标记「用户已自定义」
  let unlisten: (() => void) | null = null;
  try {
    unlisten = await win.onResized(() => {
      if (Date.now() < programmaticUntil) {
        return;
      }
      void (async () => {
        try {
          if (await win.isMaximized()) {
            return;
          }
          // V16 修复：最小化 / 隐藏态的尺寸回弹（如最小化时的异常尺寸）不得写回持久化，
          // 否则会把正常尺寸覆盖成"折叠小窗"，并被误标 userResized（锁定预设尺寸）。
          if (await win.isMinimized()) {
            return;
          }
          if (!(await win.isVisible())) {
            return;
          }
          window.clearTimeout(persistTimer);
          persistTimer = window.setTimeout(() => {
            void (async () => {
              try {
                const scale = await win.scaleFactor();
                const size = (await win.innerSize()).toLogical(scale);
                const w = Math.round(size.width);
                const h = Math.round(size.height);
                // 低于下限的异常尺寸（折叠 / 最小化残留）直接丢弃，不写回。
                if (w < MIN_W || h < MIN_H) {
                  return;
                }
                // 与上次程序化尺寸一致 → 视为系统回弹（如最大化还原），不记为用户自定义
                if (
                  lastApplied !== null &&
                  Math.abs(lastApplied.w - w) < SIZE_EPSILON &&
                  Math.abs(lastApplied.h - h) < SIZE_EPSILON
                ) {
                  return;
                }
                updateState({ w, h, userResized: true });
              } catch {
                // 读取失败：保留上次状态
              }
            })();
          }, PERSIST_DEBOUNCE_MS);
        } catch {
          // 忽略
        }
      })();
    });
  } catch {
    // 监听失败不影响使用（仅失去持久化）
  }

  return () => {
    window.clearTimeout(persistTimer);
    if (unlisten !== null) {
      unlisten();
    }
    initialized = false;
  };
}

/**
 * 订阅窗口状态（当前仅 maximized）。
 * 无边框窗口下最大化事件不可靠，故采用「事件 + 轮询兜底」双通道。
 */
export async function subscribeStatus(
  listener: (status: WindowShellStatus) => void,
): Promise<() => void> {
  const noop = (): void => {
    /* 浏览器环境：无状态可订阅 */
  };
  const win = await getWindow();
  if (win === null) {
    return noop;
  }
  const emit = (): void => {
    void win
      .isMaximized()
      .then((maximized) => {
        listener({ maximized });
      })
      .catch(() => {
        // 读取失败：保持上次状态
      });
  };
  emit();
  let unlisten: (() => void) | null = null;
  try {
    unlisten = await win.onResized(() => {
      emit();
    });
  } catch {
    // 忽略
  }
  const poll = window.setInterval(emit, STATUS_POLL_MS);
  return () => {
    window.clearInterval(poll);
    if (unlisten !== null) {
      unlisten();
    }
  };
}

/**
 * 原生最小化窗口。
 *
 * ⚠️ **仅供便签等独立小窗使用**。主窗口为托盘优先形态（`skipTaskbar: true`），
 * 一旦进入原生最小化会"丢失"（无任务栏入口可恢复，且 `show()` 无法还原最小化态）；
 * 主窗口的「收起」请改用 [`hideToTray`]。
 */
export async function minimize(): Promise<void> {
  const win = await getWindow();
  if (win === null) {
    return;
  }
  try {
    await win.minimize();
  } catch {
    // 忽略
  }
}

/** 切换最大化 / 还原，返回切换后的最大化状态 */
export async function toggleMaximize(): Promise<boolean> {
  const win = await getWindow();
  if (win === null) {
    return false;
  }
  try {
    await win.toggleMaximize();
    return await win.isMaximized();
  } catch {
    return false;
  }
}

/** 读取当前最大化状态（失败按 false 处理） */
export async function isMaximized(): Promise<boolean> {
  const win = await getWindow();
  if (win === null) {
    return false;
  }
  try {
    return await win.isMaximized();
  } catch {
    return false;
  }
}

/** 关闭（隐藏到托盘）：复用既有 Rust 命令 `app_hide_main`，不新造命令 */
export async function hideToTray(): Promise<void> {
  if (!isTauri()) {
    return;
  }
  try {
    await ipc.appHideMain();
  } catch {
    // 命令不可用时降级为直接隐藏窗口
    const win = await getWindow();
    if (win !== null) {
      try {
        await win.hide();
      } catch {
        // 忽略
      }
    }
  }
}

/** 放弃「用户自定义尺寸」标记，恢复按视图预设自动调整（预留给设置项） */
export function clearUserResizePreference(): void {
  updateState({ userResized: false });
}

/** 当前持久化的尺寸（无记录返回 null；调试 / 测试用） */
export function getWindowShellState(): WindowShellState | null {
  return loadState();
}
