import * as React from 'react';
import { isTauri } from '@/platform/detect';

/**
 * 无边框窗口缩放手柄（8 方向）。
 *
 * `decorations: false` 时系统不提供原生缩放热区，这里在窗口四边 / 四角铺透明热区，
 * 鼠标按下即调用 `startResizeDragging(direction)` 交给系统完成拖拽缩放。
 *
 * - 外层 `pointer-events-none`，仅手柄本身 `pointer-events-auto`，不遮挡内容交互；
 * - 悬停给轻微视觉反馈（品牌色半透明），避免「看不见但能拖」的困惑；
 * - **仅在 Tauri 宿主内渲染**。
 */
type Direction = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

interface HandleSpec {
  direction: Direction;
  /** 热区定位样式 */
  className: string;
  /** 鼠标指针（与方向一致的斜向 / 双向箭头） */
  cursor: string;
  /** 悬停反馈的圆角（四角给斜角感） */
  rounded?: string;
}

const HANDLES: ReadonlyArray<HandleSpec> = [
  { direction: 'North', className: 'left-2 right-2 top-0 h-1', cursor: 'ns-resize' },
  { direction: 'South', className: 'bottom-0 left-2 right-2 h-1', cursor: 'ns-resize' },
  { direction: 'West', className: 'bottom-2 left-0 top-2 w-1', cursor: 'ew-resize' },
  { direction: 'East', className: 'bottom-2 right-0 top-2 w-1', cursor: 'ew-resize' },
  {
    direction: 'NorthWest',
    className: 'left-0 top-0 h-3 w-3',
    cursor: 'nwse-resize',
    rounded: 'rounded-tl-lg',
  },
  {
    direction: 'NorthEast',
    className: 'right-0 top-0 h-3 w-3',
    cursor: 'nesw-resize',
    rounded: 'rounded-tr-lg',
  },
  {
    direction: 'SouthWest',
    className: 'bottom-0 left-0 h-3 w-3',
    cursor: 'nesw-resize',
    rounded: 'rounded-bl-lg',
  },
  {
    direction: 'SouthEast',
    className: 'bottom-0 right-0 h-3 w-3',
    cursor: 'nwse-resize',
    rounded: 'rounded-br-lg',
  },
];

/** 发起系统级拖拽缩放；仅 Tauri 生效。 */
async function startResize(direction: Direction): Promise<void> {
  if (!isTauri()) {
    return;
  }
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startResizeDragging(direction);
  } catch {
    // 宿主不支持时静默忽略（不打断交互）
  }
}

/** 窗口边框缩放热区（8 方向）。 */
export function ResizeHandles(): React.JSX.Element | null {
  if (!isTauri()) {
    return null;
  }
  return (
    // top-8：避开 32px 自绘标题栏，防止北边热区盖住最小化/最大化/关闭按钮顶部
    <div className="pointer-events-none absolute inset-x-0 bottom-0 top-8 z-40" aria-hidden="true">
      {HANDLES.map((handle) => (
        <div
          key={handle.direction}
          onMouseDown={(event) => {
            event.preventDefault();
            void startResize(handle.direction);
          }}
          style={{ cursor: handle.cursor }}
          className={`pointer-events-auto absolute transition-colors hover:bg-brand/20 ${handle.className} ${
            handle.rounded ?? ''
          }`}
        />
      ))}
    </div>
  );
}

export default ResizeHandles;
