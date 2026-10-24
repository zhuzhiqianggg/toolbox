import * as React from 'react';
import {
  ArrowLeft,
  Check,
  DatabaseBackup,
  Keyboard,
  Loader2,
  Lock,
  Sparkles,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { registry } from '@/core/moduleRegistry';
import { APP_VERSION } from '@/core/settings';
import { isModuleLocked, useLicense } from '@/core/license';
import { useAppStore } from '@/stores/useAppStore';
import { useTheme } from '@/hooks/useTheme';
import { resolveIcon } from '@/lib/icons';
import { ipc } from '@/lib/ipc';
import { isTauri } from '@/platform/detect';
import { exportBackup, importBackup } from '@/lib/backup';
import type { AppSettings, ThemeMode } from '@/core/types';

interface RowProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

/** 设置行：左标题+说明，右控件。 */
function Row({ title, description, children }: RowProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** 布尔开关行（绑定到 AppSettings 字段）。 */
function BooleanRow({
  title,
  description,
  field,
}: {
  title: string;
  description?: string;
  field: keyof AppSettings;
}): React.JSX.Element {
  const value = useAppStore((state) => state.settings[field]);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const checked = value === true;
  return (
    <Row title={title} description={description}>
      <Switch
        checked={checked}
        onCheckedChange={(next) => {
          void updateSettings({ [field]: next } as Partial<AppSettings>);
        }}
      />
    </Row>
  );
}

/** 数量输入行（绑定到 AppSettings 数字字段）。 */
function NumberRow({
  title,
  description,
  field,
  min,
  max,
}: {
  title: string;
  description?: string;
  field: keyof AppSettings;
  min: number;
  max: number;
}): React.JSX.Element {
  const value = useAppStore((state) => state.settings[field]);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const current = typeof value === 'number' ? value : min;
  const [draft, setDraft] = React.useState(String(current));

  React.useEffect(() => {
    setDraft(String(current));
  }, [current]);

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10);
    const next = Number.isNaN(parsed) ? min : Math.min(max, Math.max(min, parsed));
    setDraft(String(next));
    void updateSettings({ [field]: next } as Partial<AppSettings>);
  };

  return (
    <Row title={title} description={description}>
      <Input
        type="number"
        value={draft}
        min={min}
        max={max}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
          }
        }}
        className="w-24"
      />
    </Row>
  );
}

/**
 * 快捷键行（V13）：点击「修改」进入录制态（window 级 keydown 捕获，忽略纯修饰键），
 * 生成 `Ctrl+Alt+P` 形式组合 →「保存」时经 Rust `hotkey_update` 重注册；
 * **注册失败（与系统/其他应用冲突）toast 提示且不落盘**——hotkey 显示值仍读
 * settings，未写入即自动回滚。
 */
function HotkeyRow(): React.JSX.Element {
  const hotkey = useAppStore((state) => state.settings.hotkey);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const [recording, setRecording] = React.useState(false);
  const [draft, setDraft] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // 录制：捕获组合键（至少一个修饰键；主键名用 KeyboardEvent.code，与 Rust 端解析对齐）
  React.useEffect(() => {
    if (!recording) {
      return;
    }
    const handler = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
        return; // 纯修饰键：等待主键
      }
      const parts: string[] = [];
      if (event.ctrlKey) {
        parts.push('Ctrl');
      }
      if (event.altKey) {
        parts.push('Alt');
      }
      if (event.shiftKey) {
        parts.push('Shift');
      }
      if (event.metaKey) {
        parts.push('Super');
      }
      if (parts.length === 0) {
        toast.error('请至少按住一个修饰键（Ctrl / Alt / Shift）', {
          description: '避免与日常输入冲突。',
        });
        return;
      }
      setDraft([...parts, event.code].join('+'));
      setRecording(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording]);

  const save = async (): Promise<void> => {
    if (draft === null) {
      return;
    }
    setSaving(true);
    try {
      await ipc.hotkeyUpdate(draft);
      // 注册成功才落盘；失败时 hotkey 未变（显示值自动"回滚"）
      await updateSettings({ hotkey: draft });
      toast.success('快捷键已更新', { description: draft });
      setDraft(null);
    } catch (err: unknown) {
      toast.error('快捷键保存失败', {
        description: `${err instanceof Error ? err.message : String(err)}（可能与系统或其他应用冲突）`,
      });
    } finally {
      setSaving(false);
    }
  };

  const display = recording ? '请按下新的组合键…' : (draft ?? hotkey);

  return (
    <Row title="呼出快捷键" description="全局呼出/隐藏主面板；保存失败不生效">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            if (!recording) {
              setDraft(null);
            }
            setRecording((v) => !v);
          }}
          className={recording ? 'hidden' : 'inline-flex'}
        >
          <span className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 font-mono text-xs text-foreground transition hover:bg-accent">
            <Keyboard className="h-3 w-3 text-muted-foreground" />
            {display}
          </span>
        </button>
        {recording && (
          <>
            <span className="inline-flex animate-pulse items-center rounded-md border border-brand px-2 py-1 font-mono text-xs text-brand">
              录制中…
            </span>
            <button
              type="button"
              aria-label="取消录制"
              onClick={() => {
                setRecording(false);
                setDraft(null);
              }}
              className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        {!recording && draft !== null && (
          <>
            <Button size="sm" variant="outline" className="h-7" onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              保存
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => setDraft(null)}
              disabled={saving}
            >
              取消
            </Button>
          </>
        )}
      </div>
    </Row>
  );
}

/**
 * 自启动行（V13）：走 autostart 插件 enable/disable，**状态以 isEnabled 回读为准**；
 * 插件失败 toast 并回滚显示。settings.autoLaunch 仅作镜像展示。
 */
function AutoLaunchRow(): React.JSX.Element {
  const autoLaunch = useAppStore((state) => state.settings.autoLaunch);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const [checked, setChecked] = React.useState(autoLaunch);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setChecked(autoLaunch);
  }, [autoLaunch]);

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (isTauri()) {
        const plugin = await import('@tauri-apps/plugin-autostart');
        if (next) {
          await plugin.enable();
        } else {
          await plugin.disable();
        }
        const real = await plugin.isEnabled();
        setChecked(real);
        await updateSettings({ autoLaunch: real });
        toast.success(real ? '已开启开机自启动' : '已关闭开机自启动');
        return;
      }
      // 浏览器 dev：仅本地状态
      await updateSettings({ autoLaunch: next });
    } catch (err: unknown) {
      toast.error('自启动设置失败', {
        description: err instanceof Error ? err.message : String(err),
      });
      setChecked(autoLaunch); // 回滚显示
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row title="开机自启动" description="登录后自动在后台运行">
      <Switch checked={checked} disabled={busy} onCheckedChange={(next) => void toggle(next)} />
    </Row>
  );
}


/**
 * 备份区（V13）：导出（dialog 选目录 → VACUUM INTO 快照 + settings 镜像）/
 * 导入（dialog 选目录 → 校验 + pending 标记，**重启应用生效**；导入前两步确认
 * 「将覆盖现有数据」）。结果均 toast。
 */
function BackupSection(): React.JSX.Element {
  const [busy, setBusy] = React.useState<'export' | 'import' | null>(null);
  const [confirmImport, setConfirmImport] = React.useState(false);

  const handleExport = async (): Promise<void> => {
    setBusy('export');
    try {
      const report = await exportBackup();
      if (report) {
        toast.success('备份完成', { description: report.backupDir });
      }
    } catch (err: unknown) {
      toast.error('备份失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async (): Promise<void> => {
    setConfirmImport(false);
    setBusy('import');
    try {
      const outcome = await importBackup();
      if (outcome) {
        toast.success('备份校验通过', { description: '数据将在重启应用后生效' });
      }
    } catch (err: unknown) {
      toast.error('导入失败', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col py-3">
      <div className="mb-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
        备份内容：数据库（便签 / 待办 / 整理计划）与应用配置。导出位置与导入来源
        均由你在弹出的目录选择框中指定；导入会
        <span className="font-medium text-foreground">覆盖现有数据</span>
        ，并在重启应用后生效。
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleExport()}
          disabled={busy !== null}
        >
          {busy === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DatabaseBackup className="h-3.5 w-3.5" />}
          导出备份
        </Button>
        {confirmImport ? (
          <>
            <Button size="sm" variant="destructive" onClick={() => void handleImport()} disabled={busy !== null}>
              {busy === 'import' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              确认导入（将覆盖现有数据）
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmImport(false)} disabled={busy !== null}>
              取消
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setConfirmImport(true)} disabled={busy !== null}>
            导入备份
          </Button>
        )}
      </div>
    </div>
  );
}

/** 模块开关列表（读写经注册表 → 持久化，桌面端双写 module_state 表 + settings 镜像）。 */
function ModuleToggles(): React.JSX.Element {
  // 订阅启停映射以驱动重渲染
  const modulesState = useAppStore((state) => state.settings.modules);
  const modules = React.useMemo(() => registry.list({ includeDisabled: true }), [modulesState]);

  return (
    <div className="flex flex-col">
      {modules.map((mod) => {
        const Icon = resolveIcon(mod.icon);
        const enabled = modulesState[mod.id] ?? true;
        const locked = isModuleLocked(mod.id);
        return (
          <Row
            key={mod.id}
            title={mod.name}
            description={locked ? `${mod.description}（Pro 版可用）` : mod.description}
          >
            <div className="flex items-center gap-3">
              <Icon className="h-4 w-4 text-muted-foreground" />
              {locked && (
                <span className="inline-flex items-center gap-0.5 rounded bg-brand-muted px-1.5 py-0.5 text-[10px] text-brand">
                  <Lock className="h-3 w-3" />
                  Pro
                </span>
              )}
              <Switch
                checked={enabled}
                disabled={locked}
                onCheckedChange={(next) => {
                  void registry.setEnabled(mod.id, next);
                }}
              />
            </div>
          </Row>
        );
      })}
    </div>
  );
}

/**
 * 设置中心（V13 完整版）。
 *
 * 分区：通用（快捷键录制 / 自启动 / 主题 / 托盘 / 更新）、Pro 提示条、模块开关
 * （Pro 门控灰化）、历史记录、备份（导出 / 导入）、
 * 以及各模块经扩展点 `settings.section` 贡献的分区与「关于」。
 */
export interface SettingsCenterProps {
  /**
   * 内嵌模式（V63）：作为**桌面右侧面板的一个页签**渲染，而不是主窗口的一整页。
   *
   * `true` 时不画自己的 header（返回箭头 + 「设置」标题）—— 面板顶栏已经有页签和
   * 关闭按钮，再来一个「返回到命令面板」会把用户带去一个不该再出现的界面。
   */
  embedded?: boolean;
  /**
   * 打开后**直接定位到某一项**（V63，用户：「快捷键设置直接弹出工具箱弹窗」）。
   *
   * 只有 `'hotkey'` 一种取值：把快捷键那一行提到最上面并高亮，省得在一长串设置里翻。
   */
  focus?: 'hotkey' | null;
}

export function SettingsCenter({
  embedded = false,
  focus = null,
}: SettingsCenterProps = {}): React.JSX.Element {
  const showPalette = useAppStore((state) => state.showPalette);
  const theme = useAppStore((state) => state.settings.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const sections = React.useMemo(() => registry.settingsSections(), []);
  const { isPro } = useLicense();
  const hotkeyRef = React.useRef<HTMLElement | null>(null);

  // 设置面板内也应用主题（首帧一致）
  useTheme();

  // 「快捷键」直达：滚到那一行并让高亮先亮一下（高亮本身由下方 ring 表达）
  React.useEffect(() => {
    if (focus === 'hotkey') {
      hotkeyRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [focus]);

  return (
    <div className="flex h-full flex-col">
      {embedded ? null : (
        <>
          <header className="flex items-center gap-3 px-4 py-3">
            <Button variant="ghost" size="icon" aria-label="返回" onClick={showPalette}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h2 className="text-sm font-semibold text-foreground">设置</h2>
          </header>
          <Separator />
        </>
      )}

      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-4 py-2">
        {/* 快捷键（仅 `focus='hotkey'` 时提前到最前并高亮 —— 用户从「快捷键」入口进来
            要的就是这一行，不该让他自己在「通用」里找） */}
        {focus === 'hotkey' ? (
          <section
            ref={hotkeyRef}
            className="my-2 rounded-lg bg-sky-400/10 px-3 py-1 ring-2 ring-sky-400/60"
          >
            <h3 className="py-1 text-xs font-medium text-muted-foreground">快捷键</h3>
            <HotkeyRow />
          </section>
        ) : null}

        {/* 通用 */}
        <section className="py-2">
          <h3 className="py-1 text-xs font-medium text-muted-foreground">通用</h3>
          <Row title="主题" description="深色主题即将支持">
            <Select value={theme} onValueChange={(value) => void setTheme(value as ThemeMode)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">浅色</SelectItem>
                <SelectItem value="dark" disabled>
                  深色（即将支持）
                </SelectItem>
                <SelectItem value="system">跟随系统</SelectItem>
              </SelectContent>
            </Select>
          </Row>
          {focus === 'hotkey' ? null : <HotkeyRow />}
          <AutoLaunchRow />
          <BooleanRow
            title="关闭窗口时最小化到托盘"
            description="点击关闭按钮不退出应用"
            field="closeToTray"
          />
          <BooleanRow title="自动检查更新" description="有新版本时提示" field="autoUpdate" />
          <BooleanRow
            title="主窗口始终置顶"
            description="开启后 Toolbox 会浮在所有窗口之上；默认关闭，避免挡住系统弹框与其它软件"
            field="mainPinned"
          />
        </section>

        <Separator />

        {/* Pro 提示条（静态提示，不弹窗诱导） */}
        {!isPro && (
          <div className="my-3 flex items-center gap-2 rounded-md border border-brand/30 bg-brand-muted/40 px-3 py-2">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-brand" />
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              当前为免费版。Pro 版将解锁更多进阶能力（敬请期待）。
            </p>
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-brand px-1.5 py-0.5 text-[10px] font-medium text-white">
              <Lock className="h-3 w-3" />
              Pro 版解锁
            </span>
          </div>
        )}

        {/* 模块 */}
        <section className="py-2">
          <h3 className="py-1 text-xs font-medium text-muted-foreground">模块</h3>
          <ModuleToggles />
        </section>

        <Separator />

        {/* 历史记录 */}
        <section className="py-2">
          <h3 className="py-1 text-xs font-medium text-muted-foreground">历史记录</h3>
          <BooleanRow title="记录工具使用历史" description="便于快速回访" field="recordHistory" />
          <NumberRow
            title="工具历史上限"
            description="超出后自动裁剪"
            field="maxHistory"
            min={10}
            max={500}
          />
        </section>

        {/* 备份 */}
        <section className="py-2">
          <h3 className="py-1 text-xs font-medium text-muted-foreground">备份与恢复</h3>
          <BackupSection />
        </section>

        {/* 模块贡献的设置分区（扩展点 settings.section） */}
        {sections.map((section) => (
          <React.Fragment key={section.id}>
            <Separator />
            <section className="py-2">
              <h3 className="py-1 text-xs font-medium text-muted-foreground">{section.title}</h3>
              {section.render()}
            </section>
          </React.Fragment>
        ))}

        <Separator />

        {/* 关于 */}
        <section className="py-2">
          <h3 className="py-1 text-xs font-medium text-muted-foreground">关于</h3>
          <Row title="Toolbox" description="跨平台桌面效率套件">
            <span className="text-xs text-muted-foreground">v{APP_VERSION}</span>
          </Row>
        </section>
      </div>
    </div>
  );
}

export default SettingsCenter;
