import VaultView from '@/modules/vault/VaultView';

/**
 * 密码存储器 · 工具箱工具壳（V45）。
 *
 * 用户原话：「密码存储建议也作为工具箱的其中一个工具吧 不要一个独立的工具箱模块，
 * 这样应该更好」。于是 `modules/vault` **不再注册为模块**（其 `index.ts` 已删除），
 * 只把视图搬进工具箱：命令 id `vault`、分类「安全存储」，桌面搜索 / 工具箱面板
 * 都能直接搜到并就地打开，主窗口侧栏不再单占一格。
 *
 * 视图组件原样复用（`modules/vault/VaultView`）：加解密实现（Argon2id 派生密钥 +
 * Rust 侧 AES-256-GCM）、5 分钟无操作自动锁定、复制后 20 秒清空剪贴板等安全策略
 * 一个字都没动，也不存在第二份实现。
 *
 * 这里**不套 `CommandShell` 外壳**：该视图自带标题栏、锁定页与返回语义，再包一层会
 * 出现两条标题栏；工具箱面板本身已经提供「返回列表」入口（见 `DesktopSidePanel`）。
 *
 * tool-audit-ignore: samples —— 密码库没有「一条示例文本填进去」这回事
 * tool-audit-ignore: persist   —— 机密列表的状态由 Rust 侧保管，不走前端持久化
 */
export default function Vault(): React.JSX.Element {
  return <VaultView />;
}
