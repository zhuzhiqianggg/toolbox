import React, { useState } from 'react';
import { CalendarWidget, CALENDAR_THEMES } from '@/modules/desktop-grid/DesktopWidgets';
import type { GridAccent } from '@/types/grid';

/**
 * 开发调试页：直接渲染桌面挂件日历（`?demo=calendar`）。
 *
 * # 为什么需要它
 *
 * `CalendarWidget` 挂在桌面常驻列里，依赖 Tauri 窗口与 SQLite（计划 / 纪念日）。
 * 浏览器里这些都没有，但组件内所有 IPC 调用都包了 `try/catch`、读不到就回落空数据，
 * 所以能直接在浏览器里把「这一个月长什么样」渲染出来做回归 / 截图 —— 不必打包安装。
 *
 * 用法：`index.html?demo=calendar`（可加 `&accent=amber` 直接指定主题）。
 */
export default function CalendarDemo(): React.JSX.Element {
  const accents = Object.keys(CALENDAR_THEMES) as GridAccent[];
  const [accent, setAccent] = useState<GridAccent>(
    () => (new URLSearchParams(window.location.search).get('accent') as GridAccent | null) ?? '',
  );

  return (
    <div className="flex h-screen flex-col gap-3 bg-[#0f172a] p-6">
      <header className="shrink-0">
        <h1 className="text-base font-semibold text-neutral-100">CalendarWidget 冒烟页（?demo=calendar）</h1>
        <p className="mt-1 text-xs text-neutral-400">
          直接渲染桌面挂件日历，无需 SQLite / Tauri。下方切换主题；网格自适应行数（月底不留空行）。
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {accents.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setAccent(key)}
              className={`rounded-full border px-2 py-0.5 text-[11px] transition ${
                accent === key
                  ? 'border-sky-400 bg-sky-500/20 text-sky-100'
                  : 'border-white/15 text-neutral-300 hover:border-white/30'
              }`}
            >
              {CALENDAR_THEMES[key].label}
            </button>
          ))}
        </div>
      </header>
      <div className="mx-auto w-full max-w-[400px] flex-1 rounded-xl bg-neutral-950/70 p-2 ring-1 ring-white/10">
        <CalendarWidget accent={accent} />
      </div>
    </div>
  );
}
