import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  FolderOpen,
  Info,
  LayoutGrid,
  Loader2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { AutoArrangeReport } from '@/types/grid';
import { scanDesktop } from '@/core/data/organizerService';
import { reportOperation } from '@/lib/errorSink';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import { toast } from '@/components/ui/toast';

/**
 * 桌面整理视图（V12 起；V25 成为模块首屏；**V48 只剩一条路**）。
 *
 * # V48：把「移动文件」这条路整个删掉
 *
 * 用户 09-19 原话：
 * > 「现在桌面整理模块有个垃圾就是什么归纳收拢，我们就是桌面整理，不负责直接 mv
 * >  文件到新的目录下，桌面整理就是单纯的桌面整理美化收纳，**打开桌面的目录文件夹后
 * >  布局没有任何变化的那种**」。
 *
 * 所以本视图从 V48 起**只有一个动作**：「开始归拢」—— 扫描桌面 → 按类型把条目
 * **登记**进桌面格子 → 格子接管图标呈现。**一个文件都不会被移动、改名或删除**，
 * 关掉 Handy 之后用资源管理器打开桌面目录，看到的还是原来那一堆文件，位置分毫未变。
 *
 * ## 删掉的具体是什么（别再把它加回来）
 *
 * V37–V47 期间这里有过一个「处理方式」二选一开关，其中一档「移动到整理目录」会真的
 * `fs::rename` 把文件搬进 `桌面/Handy整理/<组名>/`（Rust `organizer_apply` /
 * `organizer_undo`，配套还有预览清单、勾选排除、二次确认弹层、历史计划与一键撤销）。
 * 那一整套的语义是**归档工具**，不是桌面整理 —— 与用户对这个模块的预期根本冲突，
 * 而且它是「桌面整理会动我文件」这个误解的唯一来源。V48 连同 Rust 侧的命令一起删除，
 * 确保**应用里不存在任何把用户文件搬出桌面的路径**。
 *
 * ## 安全边界（V48 之后更简单了）
 *
 *   - 「开始归拢」走 Rust `grid_auto_arrange`：**只写数据库里的引用登记**，
 *     不碰文件系统（不 rename、不 delete、不 copy）；
 *   - 快捷方式（`.lnk`）与系统图标不参与归类，留在左侧「未归类」竖条原位；
 *   - 本视图只读扫描桌面目录，用于把「作用对象」摆在界面上（`scanDesktop`）。
 */

export interface OrganizerViewProps {
  /** 兼容 CommandProps / ModuleProps（未使用） */
  initialInput?: string;
  source?: string;
  windowKind?: string;
}

/** 桌面整理视图（主面板模块内页 / 命令视图复用）。 */
export default function OrganizerView(_props: OrganizerViewProps = {}): React.JSX.Element {
  /** 归拢结果摘要 */
  const [groupReport, setGroupReport] = useState<AutoArrangeReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 真实桌面目录（Rust `dirs::desktop_dir()` 解析结果，含 OneDrive 重定向） */
  const [rootDir, setRootDir] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  /** 桌面上当前可整理的条目数（证明「读的是真实桌面」） */
  const [desktopCount, setDesktopCount] = useState<number | null>(null);

  // 定位真实桌面目录：只读扫描，用于把「作用对象」摆在界面上（不触发任何移动）
  useEffect(() => {
    let alive = true;
    void scanDesktop()
      .then((result) => {
        if (!alive) {
          return;
        }
        setRootDir(result.dir);
        setDesktopCount(result.items.length);
        setRootError(null);
      })
      .catch((err: unknown) => {
        if (alive) {
          setRootError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 用系统默认程序打开目录（走 Rust `grid_open_path`，不受 shell 作用域限制） */
  const openDir = useCallback((dir: string): void => {
    void ipc.gridOpenPath(dir).catch((err: unknown) => {
      toast.error('打开目录失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    });
  }, []);

  /**
   * 归拢到桌面格子：按类型把桌面条目登记进格子，**不动任何文件**。
   *
   * 与「桌面格子」管理页的「一键归类桌面」共用同一个 Rust 命令，所以两处行为天然一致；
   * 分类名（文件夹 / 图片 / 文档 / 压缩包 / 安装包 / 其他）也来自同一套映射。
   */
  const handleGroup = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setGroupReport(null);
    try {
      const rep = await ipc.gridAutoArrange();
      setGroupReport(rep);
      if (rep.scanned === 0) {
        toast.warning('桌面已经很干净了', { description: '没有扫描到可归拢的条目' });
      } else if (rep.itemsAdded === 0) {
        toast.info('没有需要归拢的条目', {
          description: `扫描到 ${rep.scanned} 项（含公共桌面），格子布局已按内容重排`,
        });
      } else {
        toast.success(`已归拢 ${rep.itemsAdded} 个条目到桌面格子`, {
          description: '文件全部留在桌面原位，没有移动',
        });
      }
      if (rep.boxesOverflowed > 0) {
        toast.warning(`桌面空间不够，${rep.boxesOverflowed} 个格子没能排开`, {
          description: '建议减少格子数量，或在系统设置里把桌面图标调小一些',
        });
      }
      if (rep.failures.length > 0) {
        toast.warning(`${rep.failures.length} 个条目没能归拢`, {
          description: rep.failures.slice(0, 3).join('；'),
        });
      }
    } catch (err: unknown) {
      reportOperation('归拢到桌面格子', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* 作用目录（V25）：把「动的是真实操作系统桌面」摆在最上面，不用猜 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-4 py-2">
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-brand" />
        <span className="shrink-0 text-[11px] text-muted-foreground">作用目录</span>
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground"
          title={rootDir ?? undefined}
        >
          {rootDir ??
            (rootError !== null
              ? isTauri()
                ? `读取失败：${rootError}`
                : '浏览器预览模式：请在 Handy 桌面版中查看桌面整理功能'
              : '正在定位桌面目录…')}
        </code>
        {desktopCount !== null ? (
          <span className="shrink-0 rounded-full bg-brand-muted px-2 py-0.5 text-[10px] font-medium text-brand">
            扫描到 {desktopCount} 个条目
          </span>
        ) : null}
        {rootDir !== null ? (
          <button
            type="button"
            onClick={() => openDir(rootDir)}
            title="用资源管理器打开真实桌面目录 —— 这里看到的内容本模块一个字节都不会改动"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            打开桌面
          </button>
        ) : null}
      </div>

      {/* 主操作区（V48）：只有一件事可做。原来这里并排两张卡（归拢 / 移动），
          现在移动那一整条路被删掉了，所以只留一张说明卡 + 一个按钮。 */}
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-start gap-3 rounded-xl border border-brand/60 bg-brand-muted/60 p-3 ring-1 ring-brand/30">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-white">
            <LayoutGrid className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
              归拢到桌面格子
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-normal text-emerald-600 dark:text-emerald-400">
                <ShieldCheck className="h-3 w-3" />
                不动文件
              </span>
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
              按类型把桌面条目登记进桌面格子（文件夹 / 图片 / 文档 / 压缩包 / 安装包 / 其他），
              由格子负责呈现与美化。
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                文件本体一个字节都不动
              </span>
              ：不进新目录、不改名、不删除，快捷方式与系统图标留在左侧「未归类」竖条原位。
            </span>
          </span>
        </div>
      </div>

      {/* 动作条 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-[11px] text-muted-foreground">
          扫描桌面后按类型登记进格子；整理完格子接管桌面呈现。想核对有没有动过文件，
          点右上角「打开桌面」看真实目录即可 —— 布局不会有任何变化。
        </span>
        <button
          type="button"
          onClick={() => void handleGroup()}
          disabled={busy}
          className="ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-brand px-3.5 text-xs font-medium text-white shadow-sm transition hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {busy ? '正在归拢…' : '开始归拢'}
        </button>
      </div>

      {/* 错误态 */}
      {error &&
        (isTauri() ? (
          <div className="mx-4 mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
          </div>
        ) : (
          <div className="mx-4 mt-2 flex items-start gap-2 rounded-md border border-brand/15 bg-brand-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
            <span className="min-w-0 flex-1">浏览器预览模式：请在 Handy 桌面版中使用桌面整理功能。</span>
          </div>
        ))}

      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-4 pb-4">
        {/* 归拢结果摘要 */}
        {groupReport && (
          <div className="mb-3 mt-3 overflow-hidden rounded-xl border border-border bg-muted/30">
            <div className="flex items-center gap-2 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <CheckCircle className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  已归拢 {groupReport.itemsAdded} 个条目到桌面格子
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  扫描 {groupReport.scanned} 项 · 文件全部原地未动 · 快捷方式留在桌面不参与
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 border-t border-border/60 bg-background/60 px-4 py-2.5">
              <span className="rounded-full bg-brand-muted px-2 py-0.5 text-[10px] font-medium text-brand">
                新建格子 {groupReport.boxesCreated}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                复用 {groupReport.boxesReused}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                重排 {groupReport.boxesLaidOut} 格
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                调尺寸 {groupReport.boxesResized} 格
              </span>
              {groupReport.foldersMoved > 0 && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  含文件夹 {groupReport.foldersMoved} 个
                </span>
              )}
            </div>
            {groupReport.failures.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-border/60 px-4 py-2">
                {groupReport.failures.map((f) => (
                  <p key={f} className="flex items-start gap-1.5 text-[11px] text-destructive">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{f}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 空态：把「点一下会发生什么」拆成三步，别让用户不敢点 */}
        {groupReport === null && (
          <div className="mt-3 rounded-xl border border-dashed border-border px-6 py-8 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-muted text-brand">
              <LayoutGrid className="h-6 w-6" />
            </span>
            <p className="mt-3 text-sm font-medium text-foreground">点「开始归拢」整理一次桌面</p>
            <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground">
              只需三步：<span className="text-foreground">扫描桌面</span> →
              <span className="text-foreground">按类型登记进格子</span> →
              <span className="text-foreground">格子接管图标展示</span>。
              <span className="mt-1 block font-medium text-emerald-600 dark:text-emerald-400">
                文件本身留在桌面原位，一个都不会被移动或删除。
              </span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
