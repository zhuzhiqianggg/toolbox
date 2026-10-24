import type { AppSettings } from './types';

/**
 * 配置键与默认值集中定义（`settings.json` 内的键名，见 ARCHITECTURE §7.2）。
 *
 * - `settings`：应用级配置（含模块开关 `modules`）
 * - `favorites` / `recent`：命令收藏与最近使用（配置态，沿用 v1 语义）
 */
export type { AppSettings } from './types';

/** 应用设置键 */
export const SETTINGS_KEY = 'settings';
/** 收藏键 */
export const FAVORITES_KEY = 'favorites';
/** 最近使用键 */
export const RECENT_KEY = 'recent';

/** 应用版本（与 package.json / tauri.conf.json 保持一致，供「关于」展示）。 */
export const APP_VERSION = '0.1.0';

/** 最近使用最大条数 */
export const RECENT_LIMIT = 20;

/**
 * 「快捷入口」默认展示的动作 id（桌面右下角那颗常驻格子 + 工作台右侧那一条，同一份数据）。
 *
 * ## 取舍判据（V56 立，用户 09-20 定）
 *
 * 用户原话：
 *
 * > 「例如任务管理器中心没有任何在这里实现的意义，任务栏右键随时都可以打开的没必要放在
 * >  这里，我们这个快捷入口要放一起 window 上操作不方便的入口功能」
 *
 * 于是这里只收**在 Windows 上不好找、甚至根本没有入口**的东西，三条判据：
 *
 *   ① **系统里已有现成快捷入口的，一律不收** —— 任务栏右键（任务管理器）、任务栏图标
 *      单击 / 右键（网络 / WLAN / 音量 / 时钟）、桌面右键（显示设置）、Win+V（剪贴板）、
 *      设置首页（更新 / 蓝牙 / 打印机）都能直达。放进来只是**重复**，还占掉本来就只有
 *      十来个的格子位；
 *   ② **要 Win+R 敲命令、或翻四五级设置才到的，收** —— 服务 / 环境变量 / hosts /
 *      代理 / 网络连接（Win11 已经把它从「网络和共享中心」里摘掉了）；
 *   ③ **系统根本没给图形入口的，优先收** —— 刷新 DNS 缓存（`%TEMP%` 这种
 *      `Win+R` 敲 `%temp%` 就能直达、几乎没人会专门去翻的，不占默认位；用户按需仍可
 *      在「全部系统入口」里勾回 `temp-folder`）。
 *
 * ⚠️ **`temp-folder` 已被移出默认（用户 09-23 反馈「谁没事会去操作这个呢」）**：Rust
 * 白名单里保留该 id，想用的人到「全部系统入口」勾一下即可，默认不再占用本就紧张的格子位。
 *
 * id 契约来自 Rust 白名单表 `src-tauri/src/commands/sys.rs`（那里是唯一事实源；本表删掉
 * 一个 id 只是「默认不展示」，白名单里的入口照样能在工作台勾回来）。服务端动作表若删除了
 * 某个 id，前端会自动忽略不存在的项（不做破坏性清理）。
 */
export const DEFAULT_QUICK_ACTION_IDS: readonly string[] = [
  // —— 管理员终端：只能 Win+X 或右键开始菜单找到，装机 / 排障第一站 ——
  'powershell-admin',
  'cmd-admin',
  // —— 系统没给图形入口 / 入口已被微软藏起来 ——
  'dns-flush',
  'hosts-edit',
  'env-vars',
  'ncpa',
  // —— 只能 Win+R 敲命令的 ——
  'services',
  'proxy-settings',
];

/**
 * 「Windows 里随处可得」的动作 id —— **默认不进桌面快捷入口**（V56）。
 *
 * 依据是用户 09-20 那句「任务栏右键随时都可以打开的没必要放在这里」。它有两个用途：
 *
 *   ① 解释 [`DEFAULT_QUICK_ACTION_IDS`] 为什么少了那几项（老版本的默认值里有 `taskmgr`，
 *      真机 `settings.json` 里也落盘了它，用户升级上来必须看不见它才行）；
 *   ② 给桌面「快捷」面板里的「全部系统入口」分组用 —— 这些项单独归到
 *      「系统里已有入口」一栏并挂一句说明，用户想勾也知道自己在勾什么。
 *
 * ⚠️ 它**不是**白名单的黑名单：Rust 动作表一个都没删，用户照样能勾回来（只是默认不给）。
 */
export const DOCK_EASY_TO_REACH_IDS: readonly string[] = [
  'taskmgr', // 任务栏右键 / Ctrl+Shift+Esc / Win+X —— 用户点名的那一个
  'network-settings', // 任务栏网络图标单击就是它
  'wifi-settings', // 任务栏网络图标 → WLAN
  'display-settings', // 桌面右键 → 显示设置
  'date-time', // 任务栏时钟右键
  'sound', // 任务栏音量图标右键
  'bluetooth-settings', // 快速设置面板
  'printer-settings', // 设置首页
  'windows-update', // 设置首页
  'defender', // 任务栏盾牌图标
  'clipboard-settings', // Win+V 本身就是入口
  'storage-settings', // 设置 → 系统
  'startup-apps', // 任务管理器 → 启动（任务管理器本身随手可得）
  'default-apps', // 设置 → 应用
];

/**
 * 算出**这一份配置现在该显示哪些**快捷入口。
 *
 * 规则只有一条：**用户真正勾过（`customized`）就以用户的为准，否则用当前默认**。
 *
 * 为什么不直接改用户存的那份数组：那样得在每个读设置的地方做「剔掉 A、补上 B」，
 * 而 `readSettings` 是**每次读都会跑**的 —— 用户手动取消一项，下一次读又被补回来，
 * 于是「取消不掉」。这里用与 `settings.modules` 同一套约定（`modules: {}` = 全默认，
 * map 只记录显式覆盖）：
 *
 *   · 没有标记 → 说明这份配置是**旧版默认**（真机里就是默认 8 项 + 后来手加的
 *     `proxy-settings`，没有任何「自定义」痕迹）→ 按新口径整个重算，`taskmgr` 自然消失；
 *   · 有标记 → 用户改过，一个字都不动（`DOCK_EASY_TO_REACH_IDS` 也不再插手）。
 */
export function resolveQuickActionIds(
  stored: readonly string[] | undefined,
  customized: boolean,
): string[] {
  if (customized && stored !== undefined && stored.length > 0) {
    return [...stored];
  }
  return [...DEFAULT_QUICK_ACTION_IDS];
}

/** 默认应用设置（首次运行时以此为基线） */
export const DEFAULT_SETTINGS: AppSettings = {
  hotkey: 'Alt+Space',
  theme: 'system',
  autoLaunch: false,
  autoUpdate: true,
  closeToTray: true,
  recordHistory: true,
  maxHistory: 50,
  // 已移除 `sensitiveToolIds`（全项目无消费点）。敏感管控唯一事实源 = `CommandMeta.sensitive`
  // （判定与清洗见 core/sensitive.ts）；如需用户自定义开关，V13 设置中心再接。
  // 空对象 = 全部模块默认启用（map 仅记录显式覆盖的开关）
  modules: {},
  tier: 'free',
  onboarded: false,
  // 默认不常驻：贴条属于「需要了才贴」的可选增强，由工作台里的「贴到桌面顶部」开启
  barPinned: false,
  // 默认不置顶：主窗口压在最上层会挡住系统弹框与其他软件，按需再开
  mainPinned: false,
  // 快捷入口默认只显示「Windows 上不好找」的那几项，不把 40+ 个系统面板一股脑铺满界面
  quickActionIds: [...DEFAULT_QUICK_ACTION_IDS],
  // 没被用户改过 → 跟随当前默认口径（V56 起因：默认口径变过，得让老用户跟着升级）
  quickActionsCustomized: false,
  // 贴条默认始终置顶；不想被它一直压着时可从贴条上的图钉按钮关掉
  barOnTop: true,
  // 纪念日默认空：属于用户私有数据，不预置任何条目
  anniversaries: [],
};
