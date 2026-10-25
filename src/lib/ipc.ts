import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/platform/detect';
import { diagLog } from '@/lib/diag';
import type { PlatformInfo } from '@/types/platform';
import type { BackupReport, ImportOutcome } from '@/types/backup';
import type { LogInfo } from '@/types/log';
import type {
  VaultItem,
  VaultItemInput,
  VaultItemPatch,
  VaultStatus,
} from '@/types/vault';
import type { SysAction } from '@/types/sys';
import type { WinOptItem, WinOptTarget } from '@/types/winopt';
import type { AppPackage } from '@/types/apps';
// 仅类型引用（`import type` 编译期擦除，不引入运行期循环依赖）
import type { Todo } from '@/core/data/todosService';

/**
 * 统一的 invoke 封装。
 *
 * 约定（TASKS §2.4）：
 * - 组件中**禁止**直接调用 `invoke`，一律经本模块；
 * - Rust 命令返回 `Result<T, String>`，此处统一归一为 `Error`，`message` 为中文可读信息。
 */
/** 端口占用条目（与 `commands/misc.rs` 的 `PortEntry` 对应，camelCase） */
export interface PortEntry {
  protocol: string;
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  state: string;
  pid: number;
  processName: string;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // 浏览器预览模式：没有 Tauri 宿主，任何系统能力都不可用。
  // 统一抛出可读的降级文案，避免每个页面各自冒「Cannot read properties of undefined (reading 'invoke')」
  if (!isTauri()) {
    throw new Error('浏览器预览模式：该功能需要 Toolbox 桌面版');
  }
  const started = performance.now();
  // 看门狗：超过 5s 未返回则记入日志（不 reject，仅诊断「永久挂起」类问题）
  let pendingLogged = false;
  const watchdog = window.setTimeout(() => {
    pendingLogged = true;
    diagLog(`ipc PENDING>5s ${cmd}`);
  }, 5000);
  try {
    const result = await invoke<T>(cmd, args);
    const ms = Math.round(performance.now() - started);
    if (ms > 1500) {
      diagLog(`ipc SLOW ${cmd} ${ms}ms`);
    }
    return result;
  } catch (error: unknown) {
    const message =
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : String(error);
    diagLog(`ipc FAIL ${cmd} ${Math.round(performance.now() - started)}ms: ${message}`);
    throw new Error(message);
  } finally {
    if (!pendingLogged) {
      window.clearTimeout(watchdog);
    }
  }
}

export const ipc = {
  /** 平台信息与能力位（注入 `src/platform`） */
  platformInfo: (): Promise<PlatformInfo> => call<PlatformInfo>('platform_info'),

  /** 应用级：显示主面板 */
  appShowMain: (): Promise<void> => call<void>('app_show_main'),
  /** 应用级：隐藏主面板（常驻托盘） */
  appHideMain: (): Promise<void> => call<void>('app_hide_main'),
  /** 应用级：切换主面板显隐 */
  appToggleMain: (): Promise<void> => call<void>('app_toggle_main'),
  /** 应用级：退出应用 */
  appQuit: (): Promise<void> => call<void>('app_quit'),

  // —— 模块启停 ——

  /** 读取模块启停状态（`settings.modules`，仅显式覆盖项） */
  moduleListState: (): Promise<Record<string, boolean>> =>
    call<Record<string, boolean>>('module_list_state'),
  /** 写入单个模块启停状态（跨窗口一致） */
  moduleSetEnabled: (moduleId: string, enabled: boolean): Promise<void> =>
    call<void>('module_set_enabled', { moduleId, enabled }),

  // —— 便签 ——

  /**
   * 打开（或聚焦）便签独立窗口，返回窗口 label（`note-<id>`）。
   * CRUD 不经 IPC：便签是单表简单实体，前端经 `lib/db` 直连 SQLite（见 notesService）；
   * 开窗必须在 Rust 侧完成（无边框 / 几何 / 置顶），故仅此处走命令。
   */
  openNoteWindow: (noteId: string): Promise<string> =>
    call<string>('open_note_window', { noteId }),

  // —— 设置中心 / 备份 ——

  /** 重注册全局快捷键（注册失败返回错误，前端不落盘并回滚显示） */
  hotkeyUpdate: (hotkey: string): Promise<void> =>
    call<void>('hotkey_update', { hotkey }),

  /** Windows 优化：清单（元数据 + 实时状态） */
  winoptList: (): Promise<WinOptItem[]> => call<WinOptItem[]>('winopt_list'),

  /** Windows 优化：切换条目状态（`to`：applied = 优化值 / default = Windows 默认） */
  winoptApply: (id: string, to: WinOptTarget): Promise<void> =>
    call<void>('winopt_apply', { id, to }),

  /** Windows 优化：单向动作（如卸载 OneDrive） */
  winoptAction: (id: string): Promise<void> => call<void>('winopt_action', { id }),
  /** 软件安装：目录 + 每项当前安装状态（注册表直读，毫秒级） */
  appsList: (): Promise<AppPackage[]> => call<AppPackage[]>('apps_list'),
  /** 软件安装：安装白名单项（winget 静默执行，返回尾部日志） */
  appsInstall: (id: string): Promise<string> => call<string>('apps_install', { id }),
  /** 软件安装：卸载白名单项 */
  appsUninstall: (id: string): Promise<string> => call<string>('apps_uninstall', { id }),
  /** 软件安装：按 winget 包 id 安装任意包（高级入口） */
  appsInstallCustom: (wingetId: string): Promise<string> =>
    call<string>('apps_install_custom', { wingetId }),
  /** 导出备份（targetDir 由用户经 dialog 选择后传入） */
  backupExport: (targetDir: string): Promise<BackupReport> =>
    call<BackupReport>('backup_export', { targetDir }),
  /** 导入备份（校验 + 写 pending 标记；重启应用生效） */
  backupImport: (sourceDir: string): Promise<ImportOutcome> =>
    call<ImportOutcome>('backup_import', { sourceDir }),

  // —— 密码存储器（vault）——

  /** 查询密码库状态（是否已初始化 / 是否已解锁） */
  vaultStatus: (): Promise<VaultStatus> => call<VaultStatus>('vault_status'),
  /** 首次设置主密码（已初始化时报错；成功后进入解锁态） */
  vaultSetup: (masterPassword: string): Promise<VaultStatus> =>
    call<VaultStatus>('vault_setup', { masterPassword }),
  /** 解锁（主密码错误返回中文错误） */
  vaultUnlock: (masterPassword: string): Promise<VaultStatus> =>
    call<VaultStatus>('vault_unlock', { masterPassword }),
  /** 锁定（清除后端内存中的密钥） */
  vaultLock: (): Promise<void> => call<void>('vault_lock'),
  /** 列出全部条目（逐字段解密；锁定态报错「密码库已锁定」） */
  vaultList: (): Promise<VaultItem[]> => call<VaultItem[]>('vault_list'),
  /** 新建条目（明文仅在传输中，落库前由 Rust 侧逐字段加密） */
  vaultCreate: (input: VaultItemInput): Promise<VaultItem> =>
    call<VaultItem>('vault_create', { input }),
  /** 更新条目（仅传入需修改的字段） */
  vaultUpdate: (itemId: number, patch: VaultItemPatch): Promise<VaultItem> =>
    call<VaultItem>('vault_update', { itemId, patch }),
  /** 删除条目 */
  vaultDelete: (itemId: number): Promise<void> => call<void>('vault_delete', { itemId }),

  // —— 待办（同一张 todos 表，与工作台共用） ——

  /** 待办列表（未完成优先、优先级高优先、到期近者优先） */
  todosList: (): Promise<Todo[]> => call<Todo[]>('todos_list'),
  /** 切换待办完成态 */
  todosToggleDone: (todoId: string, done: boolean): Promise<Todo> =>
    call<Todo>('todos_toggle_done', { todoId, done }),
  /** 新建待办 */
  todosCreate: (title: string, dueAt?: number | null): Promise<Todo> =>
    call<Todo>('todos_create', { input: { title, dueAt: dueAt ?? null } }),

  /** 端口占用清单（协议 / 本地地址:端口 / 状态 / PID / 进程名） */
  portOccupants: (): Promise<PortEntry[]> => call<PortEntry[]>('port_occupants'),

  // —— 统一日志（前端错误上报 + 用户自助查看 / 导出）——

  /** 上报前端错误 / 警告（写进应用日志文件） */
  logFrontend: (
    level: 'error' | 'warn' | 'info',
    message: string,
    detail?: string,
  ): Promise<void> => call<void>('log_frontend', { level, message, detail: detail ?? null }),
  /** 在文件管理器里打开日志目录（返回目录路径） */
  logOpenDir: (): Promise<string> => call<string>('log_open_dir'),
  /** 读日志尾部文本（默认最后 64 KB） */
  logReadTail: (maxBytes?: number): Promise<string> =>
    call<string>('log_read_tail', { maxBytes: maxBytes ?? null }),
  /** 清空日志 */
  logClear: (): Promise<void> => call<void>('log_clear'),
  /** 日志文件概况（路径 / 大小 / 轮转份数） */
  logInfo: (): Promise<LogInfo> => call<LogInfo>('log_info'),

  // —— 主窗口置顶（默认关；置顶会盖住其它程序，收敛为设置项由用户自选）——

  /** 设置主窗口是否始终置顶 */
  appSetPinned: (pinned: boolean): Promise<void> => call<void>('app_set_pinned', { pinned }),

  // —— 工作台桌面停靠（V64）——

  /** 显示（或首次创建）工作台停靠窗：贴屏右缘、置顶、不抢焦点的独立常驻窗 */
  workstationDockShow: (): Promise<void> => call<void>('workstation_dock_show'),
  /** 隐藏工作台停靠窗（窗口保留，本就不存在时幂等） */
  workstationDockHide: (): Promise<void> => call<void>('workstation_dock_hide'),

  // —— 工作台「快捷入口」：系统级动作（Rust 侧白名单制）——

  /**
   * 系统快捷动作清单。
   * 可执行目标与参数全部硬编码在 Rust 侧（`commands/sys.rs`），前端只负责渲染。
   */
  sysActionList: (): Promise<SysAction[]> => call<SysAction[]>('sys_action_list'),
  /** 执行一个系统快捷动作（只传动作 id；未知 id 与非法动作由 Rust 侧拒绝） */
  sysActionRun: (actionId: string): Promise<void> =>
    call<void>('sys_action_run', { actionId }),

  // —— 外链打开 ——

  /**
   * 打开网址 / 本地路径（tauri-plugin-shell 的 `open` 命令；Rust 侧已注册该插件，
   * capabilities 已授予 `shell:allow-open`）。
   * 注意：`shell:allow-open` 默认作用域仅放行 http(s) / mailto / tel 链接；
   * 本地路径被默认作用域拒绝时由调用方捕获并向用户提示。
   */
  shellOpen: (path: string): Promise<void> =>
    call<void>('plugin:shell|open', { path, with: null }),
} as const;

export type Ipc = typeof ipc;
