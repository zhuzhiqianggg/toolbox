import type {
  CommandMeta,
  Detector,
  ModuleMeta,
  SettingsSection,
  Tier,
  TrayItem,
} from './types';
import type { ExtensionPointId } from './extensionPoints';
import { SYSTEM_COMMANDS } from './systemCommands';
import { searchCommands as searchCommandList } from '@/lib/search';

/**
 * 模块与功能双层注册表（ARCHITECTURE §4.2）。
 *
 * 发现机制：`import.meta.glob(..., { eager: true })` **同步**收集各模块 `index.ts` 的
 * `default`（ModuleMeta），保证搜索/派发所需的轻量元数据立即可用；模块内页通过
 * `loadView()` / 命令 `load()` 惰性加载，未启用模块不加载其代码。
 *
 * 启停状态：本注册表**不持有**启停状态，而是经 `setModuleSource` 注入一个同步读取器
 * （`() => settings.modules`，缺省 = 启用）。这样：
 *   - 唯一事实源为 `useAppStore.settings.modules`（zustand，变更即触发订阅组件重渲染）；
 *   - 启停变更经 `setPersistence` 注入的写入器持久化（桌面端走 Rust，跨窗口一致）。
 */
export interface ModuleRegistry {
  // —— 模块 ——
  register(mod: ModuleMeta): void;
  get(id: string): ModuleMeta | undefined;
  list(opts?: { includeDisabled?: boolean; tier?: Tier }): ModuleMeta[];
  enabled(): ModuleMeta[];
  /** 某模块是否启用（缺省 = 启用） */
  isEnabled(id: string): boolean;
  /** 启用/停用模块（更新惰性读取器的底层状态并持久化） */
  setEnabled(id: string, on: boolean): Promise<void>;

  // —— 功能（命令）——
  registerCommands(moduleId: string, cmds: CommandMeta[]): void;
  commands(): CommandMeta[];
  /** 某模块下的命令（含停用模块，供设置中心展示） */
  commandsOf(moduleId: string): CommandMeta[];
  findCommand(id: string): CommandMeta | undefined;
  searchCommands(query: string, opts?: { limit?: number }): CommandMeta[];

  // —— 扩展点 ——
  contribute<T>(point: ExtensionPointId, item: T): void;
  collect<T>(point: ExtensionPointId): T[];
  settingsSections(): SettingsSection[];
  trayItems(): TrayItem[];
  detectors(): Detector[];

  // —— 装配 ——
  /** 执行 `import.meta.glob` 自动发现（幂等） */
  discover(): void;
  /** 注入模块启停状态的同步读取器（由 bootstrap 装配，避免内核依赖具体存储） */
  setModuleSource(fn: () => Record<string, boolean>): void;
  /** 注入启停变更的持久化实现（由 bootstrap 装配） */
  setPersistence(fn: (id: string, enabled: boolean) => Promise<void>): void;
}

/** 自动发现：所有模块的 `index.ts`（eager，仅元数据；视图/命令仍惰性加载） */
const discoveredModules = import.meta.glob<{ default: ModuleMeta }>('../modules/*/index.ts', {
  eager: true,
});

class Registry implements ModuleRegistry {
  private readonly modules = new Map<string, ModuleMeta>();
  private readonly commandsById = new Map<string, CommandMeta>();
  private readonly commandsByModule = new Map<string, CommandMeta[]>();
  private readonly contributions = new Map<ExtensionPointId, unknown[]>();
  private discovered = false;
  private moduleSource: (() => Record<string, boolean>) | null = null;
  private persist: ((id: string, enabled: boolean) => Promise<void>) | null = null;
  /** 命令集合缓存（以 modules 对象引用为键，引用变更即失效） */
  private commandsCache: { key: Record<string, boolean>; value: CommandMeta[] } | null = null;

  discover(): void {
    if (this.discovered) {
      return;
    }
    this.discovered = true;

    const modules = Object.values(discoveredModules)
      .map((entry) => entry.default)
      .filter((meta): meta is ModuleMeta => Boolean(meta))
      .sort((a, b) => a.order - b.order);

    for (const meta of modules) {
      this.register(meta);
    }
    // 框架级系统命令（唯一显式注册点，见 systemCommands.ts 头部边界说明）
    for (const cmd of SYSTEM_COMMANDS) {
      this.addCommand(cmd);
    }
  }

  setModuleSource(fn: () => Record<string, boolean>): void {
    this.moduleSource = fn;
    this.commandsCache = null;
  }

  setPersistence(fn: (id: string, enabled: boolean) => Promise<void>): void {
    this.persist = fn;
  }

  // —— 模块 ——

  register(mod: ModuleMeta): void {
    if (this.modules.has(mod.id)) {
      return;
    }
    this.modules.set(mod.id, mod);

    const contributes = mod.contributes;
    if (contributes?.commands && contributes.commands.length > 0) {
      this.registerCommands(mod.id, contributes.commands);
    }
    if (contributes?.settingsSection) {
      this.contribute('settings.section', contributes.settingsSection);
    }
    for (const item of contributes?.trayItems ?? []) {
      this.contribute('tray.item', item);
    }
    for (const item of contributes?.detectors ?? []) {
      this.contribute('detect.matcher', item);
    }
  }

  get(id: string): ModuleMeta | undefined {
    return this.modules.get(id);
  }

  /** 当前启停映射（缺省 = 全部启用） */
  private modulesState(): Record<string, boolean> {
    return this.moduleSource?.() ?? {};
  }

  /** 某模块是否启用（缺省 = 启用） */
  isEnabled(id: string): boolean {
    return this.modulesState()[id] ?? true;
  }

  list(opts?: { includeDisabled?: boolean; tier?: Tier }): ModuleMeta[] {
    const includeDisabled = opts?.includeDisabled ?? false;
    return [...this.modules.values()]
      .filter((mod) => includeDisabled || this.isEnabled(mod.id))
      .filter((mod) => (opts?.tier ? mod.tier === opts.tier : true))
      .sort((a, b) => a.order - b.order);
  }

  enabled(): ModuleMeta[] {
    return this.list({ includeDisabled: false });
  }

  async setEnabled(id: string, on: boolean): Promise<void> {
    if (this.persist) {
      await this.persist(id, on);
    }
    // 底层 modules 对象已被替换 → 缓存键失效，下次 commands() 自动重算
    this.commandsCache = null;
  }

  // —— 功能（命令）——

  registerCommands(moduleId: string, cmds: CommandMeta[]): void {
    for (const cmd of cmds) {
      this.addCommand(cmd.moduleId === moduleId ? cmd : { ...cmd, moduleId });
    }
  }

  private addCommand(cmd: CommandMeta): void {
    this.commandsById.set(cmd.id, cmd);
    this.commandsCache = null;
    const list = this.commandsByModule.get(cmd.moduleId);
    if (list) {
      if (!list.some((item) => item.id === cmd.id)) {
        list.push(cmd);
      }
    } else {
      this.commandsByModule.set(cmd.moduleId, [cmd]);
    }
  }

  commands(): CommandMeta[] {
    const state = this.modulesState();
    if (this.commandsCache && this.commandsCache.key === state) {
      return this.commandsCache.value;
    }
    const out: CommandMeta[] = [];
    for (const [moduleId, cmds] of this.commandsByModule) {
      // 系统命令不受模块开关管辖
      if (moduleId === 'system' || (state[moduleId] ?? true)) {
        out.push(...cmds);
      }
    }
    this.commandsCache = { key: state, value: out };
    return out;
  }

  commandsOf(moduleId: string): CommandMeta[] {
    return this.commandsByModule.get(moduleId) ?? [];
  }

  findCommand(id: string): CommandMeta | undefined {
    return this.commandsById.get(id);
  }

  searchCommands(query: string, opts?: { limit?: number }): CommandMeta[] {
    return searchCommandList(this.commands(), query, opts?.limit ?? 20);
  }

  // —— 扩展点 ——

  contribute<T>(point: ExtensionPointId, item: T): void {
    const list = this.contributions.get(point);
    if (list) {
      list.push(item);
    } else {
      this.contributions.set(point, [item]);
    }
  }

  collect<T>(point: ExtensionPointId): T[] {
    return (this.contributions.get(point) as T[] | undefined) ?? [];
  }

  /** 设置分区（按 order 排序） */
  settingsSections(): SettingsSection[] {
    return this.collect<SettingsSection>('settings.section').sort((a, b) => a.order - b.order);
  }

  /** 托盘子项 */
  trayItems(): TrayItem[] {
    return this.collect<TrayItem>('tray.item');
  }

  /** 内容识别器 */
  detectors(): Detector[] {
    return this.collect<Detector>('detect.matcher');
  }
}

/** 全局单例 */
export const registry: ModuleRegistry = new Registry();
