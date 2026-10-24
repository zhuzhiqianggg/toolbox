import { registry } from '@/core/moduleRegistry';
import type { CommandMeta } from '@/core/types';

/**
 * 敏感命令管控（**唯一事实源**：`CommandMeta.sensitive`）。
 *
 * 语义：标记 `sensitive: true` 的命令（密码生成 / JWT 解码等）承载用户私密内容，
 * 一律**不自动留痕、不上命令面板首屏榜单**：
 *   1. 打开命令时**不**写入「最近使用」（`CommandView` 写入守卫 + `useRecentStore.push` 双保险）；
 *   2. 「最近使用」「收藏」渲染时二次过滤（防历史遗留数据 / 未来新增写入路径绕过）；
 *   3. 加载时清洗已持久化的敏感 id 并回写（幂等，重复执行无害）。
 *
 * 注意：搜索**不**过滤——敏感命令仍需可被检索到才能使用（如「密码生成器」）。
 *
 * 本模块只读判定，**不引入第二套配置**：历史上的 `AppSettings.sensitiveToolIds`
 * 因全项目无任何消费点已删除（它的语义就是本模块）。若将来需要「用户自定义敏感工具」
 * 开关，请在 V13 设置中心接入，并仍以本模块作为唯一判定入口。
 */

/** 命令 id 是否为敏感命令（注册表中查不到时按「非敏感」处理）。 */
export function isSensitiveCommandId(commandId: string): boolean {
  return registry.findCommand(commandId)?.sensitive === true;
}

/** 过滤掉敏感命令 id（用于清洗持久化的 favorites / recent 列表）。 */
export function excludeSensitiveIds(ids: string[]): string[] {
  return ids.filter((id) => !isSensitiveCommandId(id));
}

/** 命令是否允许出现在命令面板首屏榜单（最近使用 / 收藏）。 */
export function isListableCommand(command: CommandMeta): boolean {
  return command.sensitive !== true;
}
